import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseEnginePointer, memoryBinaryFrom, gatewayDirFrom, isCompleteGateway, initMemory, syncEmbeddingProvider } from '../src/install.js';
import { root } from '../src/config.js';

const TREE = 'c1468692e4fdadf6490e395a5ab328a0f1b4c982';
async function tempEngines(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), 'jev-engines-test-'));
}
test('parseEnginePointer accepts a valid pointer whose paths stay under the engines base', async () => {
  const base = await tempEngines();
  const pointer = parseEnginePointer({
    schemaVersion: 1,
    memory: { tree: TREE, binary: `ai-memory/${TREE}/ai-memory.exe` },
    gateway: { tree: TREE, dir: `jev-gateway/${TREE}` }
  }, base);
  assert.equal(pointer.memory?.tree, TREE);
  assert.equal(pointer.memory?.binary, resolve(base, `ai-memory/${TREE}/ai-memory.exe`));
  assert.equal(pointer.gateway?.dir, resolve(base, `jev-gateway/${TREE}`));
});
test('parseEnginePointer accepts a pointer that installs only one engine', async () => {
  const base = await tempEngines();
  const pointer = parseEnginePointer({ schemaVersion: 1 }, base);
  assert.equal(pointer.memory, undefined);
  assert.equal(pointer.gateway, undefined);
});
test('parseEnginePointer rejects a binary path that escapes the engines base', async () => {
  const base = await tempEngines();
  for (const binary of ['../../evil.exe', resolve(base, '..', 'outside.exe'), '.']) {
    assert.throws(() => parseEnginePointer({ schemaVersion: 1, memory: { tree: TREE, binary } }, base), /escapes/);
  }
});
test('parseEnginePointer rejects a gateway directory outside the engines base', async () => {
  const base = await tempEngines();
  assert.throws(() => parseEnginePointer({ schemaVersion: 1, gateway: { tree: TREE, dir: '../../gateway' } }, base), /escapes/);
});
test('parseEnginePointer rejects tree ids that are not 40 lowercase hex characters', async () => {
  const base = await tempEngines();
  for (const tree of ['C1468692E4FDADF6490E395A5AB328A0F1B4C982', TREE.slice(1), `${TREE}0`, 'g'.repeat(40)]) {
    assert.throws(() => parseEnginePointer({ schemaVersion: 1, gateway: { tree, dir: `jev-gateway/${TREE}` } }, base));
  }
});
test('parseEnginePointer rejects unknown keys at the top level and inside engine entries', async () => {
  const base = await tempEngines();
  assert.throws(() => parseEnginePointer({ schemaVersion: 1, extra: true }, base));
  assert.throws(() => parseEnginePointer({ schemaVersion: 1, memory: { tree: TREE, binary: 'a.exe', token: 'x' } }, base));
  assert.throws(() => parseEnginePointer({ schemaVersion: 2 }, base));
});
test('memoryBinaryFrom reports that the memory engine is not installed when the pointer lacks it', async () => {
  const base = await tempEngines();
  assert.throws(() => memoryBinaryFrom({ schemaVersion: 1 }), { message: 'Memory engine not installed; run: jev-memory install memory' });
  const pointer = parseEnginePointer({ schemaVersion: 1, gateway: { tree: TREE, dir: `jev-gateway/${TREE}` } }, base);
  assert.throws(() => memoryBinaryFrom(pointer), /Memory engine not installed/);
});
test('gatewayDirFrom reports that the gateway engine is not installed when the pointer lacks it', async () => {
  const base = await tempEngines();
  assert.throws(() => gatewayDirFrom({ schemaVersion: 1 }), { message: 'Gateway engine not installed; run: jev-memory install gateway' });
  const pointer = parseEnginePointer({ schemaVersion: 1, memory: { tree: TREE, binary: `ai-memory/${TREE}/ai-memory` } }, base);
  assert.throws(() => gatewayDirFrom(pointer), /Gateway engine not installed/);
});
test('memoryBinaryFrom and gatewayDirFrom return the stored absolute paths when installed', async () => {
  const base = await tempEngines();
  const pointer = parseEnginePointer({
    schemaVersion: 1,
    memory: { tree: TREE, binary: `ai-memory/${TREE}/ai-memory` },
    gateway: { tree: TREE, dir: `jev-gateway/${TREE}` }
  }, base);
  assert.equal(memoryBinaryFrom(pointer), resolve(base, `ai-memory/${TREE}/ai-memory`));
  assert.equal(gatewayDirFrom(pointer), resolve(base, `jev-gateway/${TREE}`));
});
test('isCompleteGateway accepts only a marker naming the same tree', async () => {
  const other = '0d15e05e48151c3423a50558ede7e101d6c83ae8';
  assert.equal(isCompleteGateway({ tree: TREE, at: '2026-10-21T00:00:00.000Z' }, TREE), true);
  assert.equal(isCompleteGateway({ tree: other, at: '2026-10-21T00:00:00.000Z' }, TREE), false);
  assert.equal(isCompleteGateway(undefined, TREE), false);
  assert.equal(isCompleteGateway({ tree: TREE }, TREE), false);
  assert.equal(isCompleteGateway({ tree: TREE, at: 'now', extra: 1 }, TREE), false);
});

// Managed profile configs live under the root, so each test uses a directory inside it.
async function profileConfig(t: TestContext, body: string | Buffer): Promise<string> {
  const dir = await mkdtemp(resolve(root, '.local/install-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = resolve(dir, 'config.toml');
  await writeFile(path, body);
  return path;
}
test('syncEmbeddingProvider switches the suite-managed header from none to local and back', async t => {
  const path = await profileConfig(t, 'embedding_provider = "none"\nbackfill_on_start = false\n\n[auth]\n');
  assert.equal(await syncEmbeddingProvider(path, true), true);
  assert.equal(await readFile(path, 'utf8'), 'embedding_provider = "local"\nbackfill_on_start = false\n\n[auth]\n');
  assert.equal(await syncEmbeddingProvider(path, false), true);
  assert.equal(await readFile(path, 'utf8'), 'embedding_provider = "none"\nbackfill_on_start = false\n\n[auth]\n');
});
test('syncEmbeddingProvider is idempotent when the header already matches', async t => {
  const path = await profileConfig(t, 'embedding_provider = "local"\n');
  assert.equal(await syncEmbeddingProvider(path, true), false);
  assert.equal(await readFile(path, 'utf8'), 'embedding_provider = "local"\n');
});
test('syncEmbeddingProvider never touches a provider configured by the user', async t => {
  const original = 'embedding_provider = "openai"\nmodel = "x"\n';
  const path = await profileConfig(t, original);
  assert.equal(await syncEmbeddingProvider(path, true), false);
  assert.equal(await syncEmbeddingProvider(path, false), false);
  assert.equal(await readFile(path, 'utf8'), original);
});
test('syncEmbeddingProvider only considers the first line as the managed header', async t => {
  const original = '[memory]\nembedding_provider = "none"\n';
  const path = await profileConfig(t, original);
  assert.equal(await syncEmbeddingProvider(path, true), false);
  assert.equal(await readFile(path, 'utf8'), original);
});
test('syncEmbeddingProvider preserves every other byte, including CRLF and non-UTF-8 content', async t => {
  const tail = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0d, 0x0a, 0x61, 0x3d, 0x31, 0x0d, 0x0a]);
  const path = await profileConfig(t, Buffer.concat([Buffer.from('embedding_provider = "none"\r\n'), tail]));
  assert.equal(await syncEmbeddingProvider(path, true), true);
  assert.deepEqual(await readFile(path), Buffer.concat([Buffer.from('embedding_provider = "local"\r\n'), tail]));
});
test('initMemory on an existing profile syncs the header and does not run the engine', async t => {
  const dir = await mkdtemp(resolve(root, '.local/install-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(resolve(dir, 'memory'), { recursive: true });
  const config = resolve(dir, 'memory/config.toml');
  await writeFile(config, 'embedding_provider = "none"\nbackfill_on_start = false\n');
  await initMemory(dir, true);
  assert.equal(await readFile(config, 'utf8'), 'embedding_provider = "local"\nbackfill_on_start = false\n');
});
