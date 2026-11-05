import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeArgs, ensureMemoryUp, type MemoryUpDeps } from '../src/bridge.js';
import type { SupervisorState } from '../src/lifecycle.js';
const dataDir = '/data/memory', port = 4317, url = 'http://127.0.0.1:4317';
const validId = 'a1B2.c3_d4:e5-f6';
test('claude bridge with a valid session id runs session-aware and forwards only that id', () => {
  const { args, env } = bridgeArgs(dataDir, port, 'claude-code', validId);
  assert.deepEqual(args, ['--data-dir', dataDir, 'mcp-bridge', '--agent', 'claude-code', '--server-url', url]);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, validId);
});
test('claude bridge accepts a 200-character session id at the limit', () => {
  const id = 'x'.repeat(200);
  assert.equal(bridgeArgs(dataDir, port, 'claude-code', id).env.CLAUDE_CODE_SESSION_ID, id);
});
test('claude bridge without a session id falls back to the stateless bridge', () => {
  const { args, env } = bridgeArgs(dataDir, port, 'claude-code', undefined);
  assert.deepEqual(args, ['--data-dir', dataDir, 'mcp-bridge', '--no-session-id', '--server-url', url]);
  assert.equal('CLAUDE_CODE_SESSION_ID' in env, false);
});
test('claude bridge rejects invalid session ids and falls back to the stateless bridge', () => {
  for (const id of ['bad id', 'x'.repeat(201), '', 'a/b', 'sess\nid']) {
    const { args, env } = bridgeArgs(dataDir, port, 'claude-code', id);
    assert.ok(args.includes('--no-session-id'), JSON.stringify(id));
    assert.equal('CLAUDE_CODE_SESSION_ID' in env, false, JSON.stringify(id));
  }
});
test('codex bridge never forwards an inherited Claude session id', () => {
  const { args, env } = bridgeArgs(dataDir, port, undefined, validId);
  assert.deepEqual(args, ['--data-dir', dataDir, 'mcp-bridge', '--no-session-id', '--server-url', url]);
  assert.equal('CLAUDE_CODE_SESSION_ID' in env, false);
});

// Fake clock: sleep advances time, so the deadline is reached without real waiting.
function fakeDeps(state: SupervisorState, readyOn: number | 'never', statusError = false) {
  let t = 0, polls = 0;
  const calls = { state: 0, spawn: 0, sleeps: 0 };
  const deps: MemoryUpDeps = {
    env: {},
    state: async () => { calls.state++; return state; },
    spawnStart: () => { calls.spawn++; },
    status: async () => {
      polls++;
      if (statusError && polls < 3) throw new Error('ECONNREFUSED');
      return { services: { memory: readyOn !== 'never' && polls >= readyOn ? 'ready' : 'starting' } };
    },
    sleep: async ms => { calls.sleeps++; t += ms; },
    now: () => t,
  };
  return { deps, calls, polls: () => polls, elapsed: () => t };
}
test('ensureMemoryUp leaves a running profile alone', async () => {
  const { deps, calls } = fakeDeps('running', 1);
  await ensureMemoryUp('p', deps);
  assert.equal(calls.spawn, 0);
});
test('ensureMemoryUp never starts a foreign port', async () => {
  const { deps, calls } = fakeDeps('foreign', 1);
  await ensureMemoryUp('p', deps);
  assert.equal(calls.spawn, 0);
});
test('ensureMemoryUp with JMS_BRIDGE_AUTOSTART=off checks nothing and spawns nothing', async () => {
  const { deps, calls } = fakeDeps('stopped', 1);
  await ensureMemoryUp('p', { ...deps, env: { JMS_BRIDGE_AUTOSTART: 'off' } });
  assert.equal(calls.state, 0);
  assert.equal(calls.spawn, 0);
});
test('ensureMemoryUp starts a stopped profile once and returns when memory is ready on the third poll', async () => {
  const { deps, calls, polls } = fakeDeps('stopped', 3);
  await ensureMemoryUp('p', deps);
  assert.equal(calls.spawn, 1);
  assert.equal(polls(), 3);
});
test('ensureMemoryUp returns without throwing when memory never becomes ready', async () => {
  const { deps, calls, elapsed } = fakeDeps('stopped', 'never');
  await assert.doesNotReject(ensureMemoryUp('p', deps, 1000));
  assert.equal(calls.spawn, 1);
  assert.ok(elapsed() >= 1000 && elapsed() < 1500, String(elapsed()));
});
test('ensureMemoryUp tolerates status errors while the supervisor starts', async () => {
  const { deps, calls, polls } = fakeDeps('stopped', 3, true);
  await ensureMemoryUp('p', deps);
  assert.equal(calls.spawn, 1);
  assert.equal(polls(), 3);
});
test('ensureMemoryUp swallows a failing state check', async () => {
  const { deps, calls } = fakeDeps('stopped', 1);
  await assert.doesNotReject(ensureMemoryUp('p', { ...deps, state: async () => { throw new Error('boom'); } }));
  assert.equal(calls.spawn, 0);
});
