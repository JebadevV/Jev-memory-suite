import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { init, configure, start, stop, control, supervisorState } from '../src/lifecycle.js';
import { configSchema, json, profileDir, root } from '../src/config.js';
import { atomicJson } from '../src/local.js';
test('a port answering 401 is reported as foreign, not as a failure, and configure can move the profile off it', async () => {
  const name = `port-conflict-${Date.now()}`; await init(name);
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
test('real supervisor authenticates, preserves foreign listeners, and stops only owned processes', async () => {
  const name = `unit-${Date.now()}`; await init(name);
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
test('real supervisor authenticates, preserves foreign listeners, and stops only owned processes', async () => {
  const name = `unit-${Date.now()}`; await init(name);
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
