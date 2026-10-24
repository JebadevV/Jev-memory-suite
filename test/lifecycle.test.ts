import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { init, configure, doctor, start, stop, control, supervisorState } from '../src/lifecycle.js';
import { configSchema, inside, json, profileDir, root } from '../src/config.js';
import { atomicJson } from '../src/local.js';
import type { GatewayProbe } from '../src/gateways.js';

// Each test removes the profile it created, so nothing outlives the run under .local/profiles.
async function removeProfile(name: string): Promise<void> {
  inside(resolve(root, '.local/profiles'), profileDir(name));
  await rm(profileDir(name), { recursive: true, force: true });
}

test('a port answering 401 is reported as foreign, not as a failure, and configure can move the profile off it', async t => {
  const name = `port-conflict-${Date.now()}`; await init(name);
  t.after(() => removeProfile(name));
  const path = resolve(profileDir(name), 'suite.json');
  const c = configSchema.parse(await json(path));
  c.memory.enabled = c.gateway.enabled = false;
  c.controlPort = 19451; c.memory.port = 19452; c.gateway.port = 19453;
  await atomicJson(path, c);
  const foreign = createHttpServer((_req, res) => { res.writeHead(401).end('{}'); });
  await new Promise<void>(r => foreign.listen(c.controlPort, '127.0.0.1', r));
  const dir = resolve(root, '.local/tmp'), source = resolve(dir, `${name}.json`);
  try {
    assert.equal(await supervisorState(name), 'foreign');
    await assert.rejects(start(name), /another supervisor/);
    await mkdir(dir, { recursive: true });
    const next = configSchema.parse(await json(resolve(root, 'config/default.json')));
    next.memory.enabled = next.gateway.enabled = false;
    next.controlPort = 19454; next.memory.port = 19452; next.gateway.port = 19453;
    await writeFile(source, `${JSON.stringify(next, null, 2)}\n`);
    await configure(name, source.slice(root.length + 1).replaceAll('\\', '/'));
    assert.equal((await json(path) as { controlPort: number }).controlPort, 19454);
    assert.equal(await supervisorState(name), 'stopped');
  } finally {
    await new Promise<void>(r => foreign.close(() => r()));
    await rm(source, { force: true });
  }
});

test('real supervisor authenticates, preserves foreign listeners, and stops only owned processes', async t => {
  const name = `unit-${Date.now()}`; await init(name);
  t.after(() => removeProfile(name));
  const path = resolve(profileDir(name), 'suite.json');
  const c = configSchema.parse(await json(path));
  c.memory.enabled = c.gateway.enabled = false;
  c.controlPort = 19401; c.memory.port = 19402; c.gateway.port = 19403;
  await atomicJson(path, c);
  try {
    const state = await start(name); assert.equal(state.phase, 'ready');
    assert.deepEqual(state.services, {});
    assert.equal((await fetch(`http://127.0.0.1:${c.controlPort}/status`)).status, 401);
    await assert.rejects(start(name), /already running/);
    await assert.rejects(configure(name, '.local/no-file.json'), /Stop profile/);
    assert.equal((await control(name, 'status')).phase, 'ready');
  } finally { await stop(name); }
  const foreign = createServer(socket => socket.destroy());
  await new Promise<void>(r => foreign.listen(c.controlPort, '127.0.0.1', r));
  try {
    await assert.rejects(start(name)); // Non-HTTP listener causes bounded timeout, never a PID kill.
    assert.equal(foreign.listening, true);
  } finally { await new Promise<void>(r => foreign.close(() => r())); }
});

test('doctor names profile ports that collide with an upstream gateway and reports both gateways', async t => {
  const name = `doctor-${Date.now()}`; await init(name);
  t.after(() => removeProfile(name));
  const path = resolve(profileDir(name), 'suite.json');
  const c = configSchema.parse(await json(path));
  c.controlPort = 19471; c.memory.port = 19460; c.gateway.port = 19472; c.dashboard.port = 19473;
  await atomicJson(path, c);
  // Stubbed probe: no network. Claude's gateway is pinned to the memory port on purpose.
  const probe = async (origin: string): Promise<GatewayProbe> => origin === 'http://127.0.0.1:19460' ? { state: 'running', pid: 77 } : { state: 'stopped' };
  const report = await doctor(name, { JEV_CLAUDE_PORT: '19460' }, probe) as {
    gateways: Record<'claude' | 'codex', { port: number; state: string; pid?: number; portValid: boolean }>; conflicts: string[];
  };
  assert.equal(report.gateways.claude.port, 19460);
  assert.equal(report.gateways.claude.portValid, true);
  assert.equal(report.gateways.claude.state, 'running');
  assert.equal(report.gateways.claude.pid, 77);
  assert.equal(report.gateways.codex.state, 'stopped');
  assert.equal(report.gateways.codex.port, 8790);
  assert.deepEqual(report.conflicts, ['memory.port']);
});

test('doctor reports headroom without detecting it while disabled, and names a headroom port collision', async t => {
  const name = `doctor-headroom-${Date.now()}`; await init(name);
  t.after(() => removeProfile(name));
  const path = resolve(profileDir(name), 'suite.json');
  const c = configSchema.parse(await json(path));
  c.controlPort = 19474; c.memory.port = 19475; c.gateway.port = 19476; c.dashboard.port = 19477; c.headroom.port = 19478;
  await atomicJson(path, c);
  // Stubbed probe and disabled Headroom: no detection runs and nothing is contacted.
  const probe = async (origin: string): Promise<GatewayProbe> => origin === 'http://127.0.0.1:19478' ? { state: 'running' } : { state: 'stopped' };
  const report = await doctor(name, { JEV_CLAUDE_PORT: '19478' }, probe) as {
    headroom: { enabled: boolean; port: number; detected: unknown; state: string }; conflicts: string[];
  };
  assert.equal(report.headroom.enabled, false);
  assert.equal(report.headroom.port, 19478);
  assert.equal(report.headroom.detected, null);
  assert.equal(report.headroom.state, 'stopped');
  assert.deepEqual(report.conflicts, ['headroom.port']);
});

test('doctor reports codex headroom as disabled with no python detection for a default profile', async t => {
  const name = `doctor-headroom-codex-${Date.now()}`; await init(name);
  t.after(() => removeProfile(name));
  const path = resolve(profileDir(name), 'suite.json');
  const c = configSchema.parse(await json(path));
  c.controlPort = 19485; c.memory.port = 19486; c.gateway.port = 19487; c.dashboard.port = 19488; c.headroom.port = 19489;
  await atomicJson(path, c);
  // Stubbed probe: no network, so the live gateways on 8789/8790 are never contacted.
  const probe = async (): Promise<GatewayProbe> => ({ state: 'stopped' });
  const report = await doctor(name, {}, probe) as {
    headroom: { codex: { enabled: boolean; python: unknown; active: boolean; reason?: string } };
  };
  assert.equal(report.headroom.codex.enabled, false);
  assert.equal(report.headroom.codex.python, null);
  assert.equal(report.headroom.codex.active, false);
  assert.equal(report.headroom.codex.reason, undefined);
});
