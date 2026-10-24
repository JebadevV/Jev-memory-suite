import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeArgs } from '../src/bridge.js';
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
