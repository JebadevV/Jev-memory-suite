import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseEnginePointer, memoryBinaryFrom, gatewayDirFrom, isCompleteGateway, initMemory, syncEmbeddingProvider, gatewayPatches, gatewayVersionId, applyGatewayPatches, listGatewayVersions, rollbackGateway, readPointerSync } from '../src/install.js';
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

const patch = (name: string, text: string) => ({ name, bytes: Buffer.from(text) });
test('gatewayVersionId keeps the plain tree id when there are no patches', () => {
  assert.equal(gatewayVersionId(TREE, []), TREE);
});
test('gatewayVersionId changes the id when patches exist', () => {
  const id = gatewayVersionId(TREE, [patch('a.patch', 'x')]);
  assert.match(id, /^[a-f0-9]{40}$/);
  assert.notEqual(id, TREE);
});
test('gatewayVersionId changes when patch content changes or the patch name changes', () => {
  const id = gatewayVersionId(TREE, [patch('a.patch', 'x')]);
  assert.notEqual(gatewayVersionId(TREE, [patch('a.patch', 'y')]), id);
  assert.notEqual(gatewayVersionId(TREE, [patch('b.patch', 'x')]), id);
  assert.notEqual(gatewayVersionId('0d15e05e48151c3423a50558ede7e101d6c83ae8', [patch('a.patch', 'x')]), id);
});
test('gatewayVersionId ignores the order of patches', () => {
  const a = patch('a.patch', 'one');
  const b = patch('b.patch', 'two');
  assert.equal(gatewayVersionId(TREE, [a, b]), gatewayVersionId(TREE, [b, a]));
});

// A fake gateway root with a package.json at the given version; patch folder is created by the caller.
async function fakeGateway(version: string): Promise<string> {
  const base = await mkdtemp(resolve(tmpdir(), 'jev-patches-test-'));
  await mkdir(resolve(base, 'upstream/jev-gateway'), { recursive: true });
  await writeFile(resolve(base, 'upstream/jev-gateway/package.json'), JSON.stringify({ name: 'jev-gateway', version }));
  return base;
}
test('gatewayPatches returns no patches when the version folder is absent', async t => {
  const base = await fakeGateway('9.9.9');
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.deepEqual(await gatewayPatches(base), []);
});
test('gatewayPatches returns patch files sorted by name with their bytes', async t => {
  const base = await fakeGateway('9.9.9');
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = resolve(base, 'patches/jev-gateway/9.9.9');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'b.patch'), 'second');
  await writeFile(resolve(dir, 'a.patch'), 'first');
  const patches = await gatewayPatches(base);
  assert.deepEqual(patches.map(p => p.name), ['a.patch', 'b.patch']);
  assert.equal(patches[0]?.bytes.toString(), 'first');
  assert.equal(patches[1]?.bytes.toString(), 'second');
});
test('gatewayPatches refuses names outside the patch pattern and non-regular entries', async t => {
  for (const [name, kind] of [['notes.txt', 'file'], ['sub.patch', 'dir'], ['bad name.patch', 'file']] as const) {
    const base = await fakeGateway('9.9.9');
    t.after(() => rm(base, { recursive: true, force: true }));
    const dir = resolve(base, 'patches/jev-gateway/9.9.9');
    await mkdir(dir, { recursive: true });
    if (kind === 'dir') await mkdir(resolve(dir, name));
    else await writeFile(resolve(dir, name), 'x');
    await assert.rejects(gatewayPatches(base), /unexpected name|not a regular file/);
  }
});
test('gatewayPatches rejects a package version that is not a safe directory name', async t => {
  const base = await fakeGateway('../escape');
  t.after(() => rm(base, { recursive: true, force: true }));
  await assert.rejects(gatewayPatches(base), /safe directory name/);
});
// Build-like directories live under .local/, inside this repository, as in a real install.
async function scratchBuildDir(t: TestContext): Promise<string> {
  const work = await mkdtemp(resolve(root, '.local/tmp/install-patch-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const dir = resolve(work, 'gateway');
  await mkdir(dir);
  return dir;
}
const HELLO_PATCH = Buffer.from([
  'diff --git a/hello.txt b/hello.txt', 'new file mode 100644', '--- /dev/null', '+++ b/hello.txt',
  '@@ -0,0 +1 @@', '+hello', ''
].join('\n'));
test('applyGatewayPatches applies a patch inside the suite repository and the created file exists', async t => {
  const dir = await scratchBuildDir(t);
  await applyGatewayPatches(dir, [{ name: 'hello.patch', bytes: HELLO_PATCH }]);
  // Git may write CRLF on Windows, so compare the trimmed content.
  assert.equal((await readFile(resolve(dir, 'hello.txt'), 'utf8')).trim(), 'hello');
});
test('applyGatewayPatches rejects a patch that does not apply', async t => {
  const dir = await scratchBuildDir(t);
  await assert.rejects(applyGatewayPatches(dir, [{ name: 'bad.patch', bytes: Buffer.from('not a patch\n') }]), /Gateway patch does not apply: bad\.patch/);
});
test('current gateway patches apply in order to a clean copy of upstream/jev-gateway', async t => {
  const patches = await gatewayPatches(root);
  if (patches.length === 0) { t.skip('no gateway patches for the current upstream version'); return; }
  const dir = await scratchBuildDir(t);
  await cp(resolve(root, 'upstream/jev-gateway'), dir, { recursive: true,
    filter: p => !['node_modules', 'dist', '.env'].some(n => p.split(/[\/]/).includes(n)) });
  await applyGatewayPatches(dir, patches);
  // Every file a patch creates must exist after the patches are applied.
  for (const p of patches) {
    const lines = p.bytes.toString('utf8').split('\n');
    for (let i = 0; i + 1 < lines.length; i++) {
      if (lines[i] === '--- /dev/null' && lines[i + 1]?.startsWith('+++ b/'))
        await access(resolve(dir, lines[i + 1]!.slice('+++ b/'.length)));
    }
  }
});
// A tree whose files use the given line ending; package.json carries the same ending, as a checkout does.
async function eolTree(t: TestContext, eol: string): Promise<string> {
  const dir = await scratchBuildDir(t);
  await writeFile(resolve(dir, 'package.json'), `{${eol}  "name": "fake"${eol}}${eol}`);
  await writeFile(resolve(dir, 'greet.txt'), ['one', 'two', 'three'].join(eol) + eol);
  return dir;
}
// Patch stored with LF, as in git's index; it modifies an existing line rather than creating a file.
const MODIFY_PATCH = [
  'diff --git a/greet.txt b/greet.txt', '--- a/greet.txt', '+++ b/greet.txt',
  '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', ''
].join('\n');
test('applyGatewayPatches applies an LF patch to a CRLF tree with CRLF content', async t => {
  const dir = await eolTree(t, '\r\n');
  await applyGatewayPatches(dir, [{ name: 'modify.patch', bytes: Buffer.from(MODIFY_PATCH) }]);
  assert.equal(await readFile(resolve(dir, 'greet.txt'), 'utf8'), 'one\r\nTWO\r\nthree\r\n');
});
test('applyGatewayPatches applies an LF patch to an LF tree unchanged', async t => {
  const dir = await eolTree(t, '\n');
  await applyGatewayPatches(dir, [{ name: 'modify.patch', bytes: Buffer.from(MODIFY_PATCH) }]);
  assert.equal(await readFile(resolve(dir, 'greet.txt'), 'utf8'), 'one\nTWO\nthree\n');
});
test('applyGatewayPatches refuses a patch containing CR in an LF tree', async t => {
  const dir = await eolTree(t, '\n');
  const crPatch = MODIFY_PATCH.replace('+TWO', '+TWO\r');
  await assert.rejects(applyGatewayPatches(dir, [{ name: 'cr.patch', bytes: Buffer.from(crPatch) }]),
    /Gateway patch must be stored with LF line endings: cr\.patch/);
});

// Rollback tests use an engines base under .local, because the atomic pointer write only accepts repository-local paths.
const GW_OLD = 'a1'.repeat(20), GW_NEW = 'b2'.repeat(20), GW_PARTIAL = 'c3'.repeat(20), GW_ABSENT = 'd4'.repeat(20), GW_FOREIGN = 'e5'.repeat(20);
async function enginesFixture(t: TestContext): Promise<string> {
  const engines = await mkdtemp(resolve(root, '.local/install-test-'));
  t.after(() => rm(engines, { recursive: true, force: true }));
  return engines;
}
// A gateway version dir as install writes it: a marker naming its own tree, and dist/index.js unless the version is partial.
async function gatewayVersion(engines: string, id: string, at: string, options: { partial?: boolean; markerTree?: string } = {}): Promise<void> {
  const dir = resolve(engines, 'jev-gateway', id);
  await mkdir(resolve(dir, 'dist'), { recursive: true });
  await writeFile(resolve(dir, '.jev-suite-complete'), JSON.stringify({ tree: options.markerTree ?? id, at }));
  if (!options.partial) await writeFile(resolve(dir, 'dist/index.js'), '');
}
async function pointGateway(engines: string, id: string): Promise<void> {
  await writeFile(resolve(engines, 'current.json'), JSON.stringify({ schemaVersion: 1, gateway: { tree: id, dir: resolve(engines, 'jev-gateway', id) } }));
}
test('listGatewayVersions lists only complete versions, newest first, and flags the pointed one', async t => {
  const engines = await enginesFixture(t);
  await gatewayVersion(engines, GW_OLD, '2026-10-20T00:00:00.000Z');
  await gatewayVersion(engines, GW_NEW, '2026-10-22T00:00:00.000Z');
  await gatewayVersion(engines, GW_PARTIAL, '2026-10-23T00:00:00.000Z', { partial: true });
  await gatewayVersion(engines, GW_FOREIGN, '2026-10-23T00:00:00.000Z', { markerTree: GW_OLD });
  await mkdir(resolve(engines, 'jev-gateway', 'not-a-version'), { recursive: true });
  await pointGateway(engines, GW_OLD);
  assert.deepEqual(await listGatewayVersions(engines), [
    { id: GW_NEW, at: '2026-10-22T00:00:00.000Z', current: false },
    { id: GW_OLD, at: '2026-10-20T00:00:00.000Z', current: true }
  ]);
});
test('listGatewayVersions returns nothing when no gateway version was ever installed', async t => {
  assert.deepEqual(await listGatewayVersions(await enginesFixture(t)), []);
});
test('rollbackGateway re-points the gateway to a complete version and deletes nothing', async t => {
  const engines = await enginesFixture(t);
  await gatewayVersion(engines, GW_OLD, '2026-10-20T00:00:00.000Z');
  await gatewayVersion(engines, GW_NEW, '2026-10-22T00:00:00.000Z');
  await pointGateway(engines, GW_NEW);
  assert.deepEqual(await rollbackGateway(GW_OLD, engines), { previous: GW_NEW, current: GW_OLD });
  const pointer = readPointerSync(engines);
  assert.equal(pointer.gateway?.tree, GW_OLD);
  assert.equal(pointer.gateway?.dir, resolve(engines, 'jev-gateway', GW_OLD));
  await access(resolve(engines, 'jev-gateway', GW_NEW, 'dist/index.js'));
});
test('rollbackGateway refuses an incomplete, missing or mismatched version and leaves the pointer alone', async t => {
  const engines = await enginesFixture(t);
  await gatewayVersion(engines, GW_NEW, '2026-10-22T00:00:00.000Z');
  await gatewayVersion(engines, GW_PARTIAL, '2026-10-23T00:00:00.000Z', { partial: true });
  await gatewayVersion(engines, GW_FOREIGN, '2026-10-23T00:00:00.000Z', { markerTree: GW_OLD });
  await pointGateway(engines, GW_NEW);
  for (const id of [GW_PARTIAL, GW_ABSENT, GW_FOREIGN])
    await assert.rejects(rollbackGateway(id, engines), /Gateway version is missing or incomplete/);
  assert.equal(readPointerSync(engines).gateway?.tree, GW_NEW);
});
test('rollbackGateway refuses ids that are not 40 lowercase hex characters, including traversal', async t => {
  const engines = await enginesFixture(t);
  await gatewayVersion(engines, GW_NEW, '2026-10-22T00:00:00.000Z');
  await pointGateway(engines, GW_NEW);
  for (const id of ['../jev-gateway', '..', `${GW_OLD}/..`, GW_OLD.toUpperCase(), GW_OLD.slice(1), `${GW_OLD}0`, ''])
    await assert.rejects(rollbackGateway(id, engines), /40 lowercase hex characters/, id);
  assert.equal(readPointerSync(engines).gateway?.tree, GW_NEW);
});
test('rollbackGateway reports no previous version when the pointer had no gateway', async t => {
  const engines = await enginesFixture(t);
  await gatewayVersion(engines, GW_OLD, '2026-10-20T00:00:00.000Z');
  assert.deepEqual(await rollbackGateway(GW_OLD, engines), { previous: null, current: GW_OLD });
});
