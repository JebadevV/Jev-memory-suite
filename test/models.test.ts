import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { root } from '../src/config.js';
import { ensureLocalModel, verifyModelDir, defaultModelSources, MODEL_FILES, MODEL_NAME, type ModelFile } from '../src/models.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// Fake model files: the checksums are computed from the contents, so no real model is needed.
const CONTENTS: Record<string, string> = { 'model.safetensors': 'weights', 'tokenizer.json': '{"tok":1}', 'config.json': '{"dim":384}' };
const FILES: ModelFile[] = Object.entries(CONTENTS).map(([name, text]) => ({ name, sha256: sha(text) }));

async function fakeModel(dir: string, contents: Record<string, string> = CONTENTS): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(contents)) await writeFile(resolve(dir, name), text);
}
// Test directories live under the managed root, because ensureLocalModel enforces the local boundary.
async function workspace(t: TestContext): Promise<string> {
  const dir = await mkdtemp(resolve(root, '.local/models-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the shipped checksums match the upstream engine (3 files, all sha256)', () => {
  assert.deepEqual(MODEL_FILES.map(f => f.name), ['model.safetensors', 'tokenizer.json', 'config.json']);
  assert.equal(MODEL_NAME, 'all-MiniLM-L6-v2');
  assert.equal(MODEL_FILES[0]?.sha256, '53aa51172d142c89d9012cce15ae4d6cc0ca6895895114379cacb4fab128d9db');
});
test('verifyModelDir accepts a directory whose files match their checksums', async t => {
  const dir = await workspace(t);
  await fakeModel(dir);
  assert.equal(await verifyModelDir(dir, FILES), true);
});
test('verifyModelDir rejects a modified file, a missing file or an absent directory', async t => {
  const dir = await workspace(t);
  await fakeModel(dir, { ...CONTENTS, 'config.json': 'tampered' });
  assert.equal(await verifyModelDir(dir, FILES), false);
  await rm(resolve(dir, 'config.json'));
  assert.equal(await verifyModelDir(dir, FILES), false);
  assert.equal(await verifyModelDir(resolve(dir, 'absent'), FILES), false);
});
test('ensureLocalModel provisions a profile from a verified source with hardlinks and reports present on the second call', async t => {
  const base = await workspace(t);
  const source = resolve(base, 'installed'), dataDir = resolve(base, 'profile/memory'), cacheDir = resolve(base, 'cache');
  await fakeModel(source);
  const options = { files: FILES, cacheDir };
  assert.equal(await ensureLocalModel(dataDir, [source], options), 'provisioned');
  const target = resolve(dataDir, 'models', MODEL_NAME);
  assert.equal(await verifyModelDir(target, FILES), true);
  assert.equal((await stat(resolve(target, 'config.json'))).ino, (await stat(resolve(cacheDir, 'config.json'))).ino);
  assert.equal(await ensureLocalModel(dataDir, [source], options), 'present');
});
test('ensureLocalModel reports missing when no verified source or cache exists', async t => {
  const base = await workspace(t);
  const dataDir = resolve(base, 'profile/memory');
  const invalid = resolve(base, 'bad');
  await fakeModel(invalid, { ...CONTENTS, 'model.safetensors': 'corrupt' });
  const status = await ensureLocalModel(dataDir, [resolve(base, 'nowhere'), invalid], { files: FILES, cacheDir: resolve(base, 'cache') });
  assert.equal(status, 'missing');
  assert.equal(await verifyModelDir(resolve(dataDir, 'models', MODEL_NAME), FILES), false);
});
test('ensureLocalModel uses the first verified source and skips invalid ones', async t => {
  const base = await workspace(t);
  const bad = resolve(base, 'bad'), good = resolve(base, 'good');
  await fakeModel(bad, { ...CONTENTS, 'tokenizer.json': 'x' });
  await fakeModel(good);
  const status = await ensureLocalModel(resolve(base, 'profile/memory'), [bad, good], { files: FILES, cacheDir: resolve(base, 'cache') });
  assert.equal(status, 'provisioned');
});
test('ensureLocalModel refuses to overwrite a corrupted profile file and leaves it untouched', async t => {
  const base = await workspace(t);
  const dataDir = resolve(base, 'profile/memory'), modelDir = resolve(dataDir, 'models', MODEL_NAME);
  const source = resolve(base, 'installed');
  await fakeModel(source);
  await fakeModel(modelDir, { ...CONTENTS, 'config.json': 'user data' });
  await assert.rejects(ensureLocalModel(dataDir, [source], { files: FILES, cacheDir: resolve(base, 'cache') }), /checksum; refusing to overwrite/);
  assert.equal(await readFile(resolve(modelDir, 'config.json'), 'utf8'), 'user data');
});
test('ensureLocalModel replaces a corrupted shared cache from a verified source', async t => {
  const base = await workspace(t);
  const source = resolve(base, 'installed'), cacheDir = resolve(base, 'cache');
  await fakeModel(source);
  await fakeModel(cacheDir, { ...CONTENTS, 'model.safetensors': 'broken' });
  const status = await ensureLocalModel(resolve(base, 'profile/memory'), [source], { files: FILES, cacheDir });
  assert.equal(status, 'provisioned');
  assert.equal(await verifyModelDir(cacheDir, FILES), true);
});
test('defaultModelSources targets the original install only when LOCALAPPDATA is set', async () => {
  const saved = process.env.LOCALAPPDATA;
  try {
    delete process.env.LOCALAPPDATA;
    assert.deepEqual(defaultModelSources(), []);
    process.env.LOCALAPPDATA = resolve('C:/Users/example/AppData/Local');
    assert.deepEqual(defaultModelSources(), [resolve('C:/Users/example/AppData/Local/ai-memory/models', MODEL_NAME)]);
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved;
  }
});
