import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, copyFile, link, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertLocal, prepare, root } from './config.js';

// Mirrors upstream/ai-memory/crates/ai-memory-llm/src/local.rs: the engine verifies these exact checksums.
export const MODEL_NAME = 'all-MiniLM-L6-v2';
export interface ModelFile { readonly name: string; readonly sha256: string }
export const MODEL_FILES: readonly ModelFile[] = [
  { name: 'model.safetensors', sha256: '53aa51172d142c89d9012cce15ae4d6cc0ca6895895114379cacb4fab128d9db' },
  { name: 'tokenizer.json', sha256: 'be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037' },
  { name: 'config.json', sha256: '953f9c0d463486b10a6871cc2fd59f223b2c70184f49815e7efbcab5d8908b41' }
];
export type ModelStatus = 'present' | 'provisioned' | 'missing';
export interface ModelOptions { readonly files?: readonly ModelFile[]; readonly cacheDir?: string }

// Shared, suite-owned cache. It is regenerable, so a corrupted copy is replaced.
const SHARED_CACHE = resolve(root, '.local/models', MODEL_NAME);

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function matches(path: string, sha256: string): Promise<boolean> {
  return sha256File(path).then(value => value === sha256, () => false);
}
export async function verifyModelDir(dir: string, files: readonly ModelFile[] = MODEL_FILES): Promise<boolean> {
  const results = await Promise.all(files.map(file => matches(resolve(dir, file.name), file.sha256)));
  return results.every(Boolean);
}
// Read-only source locations; the installed engine's model folder from an earlier setup.
export function defaultModelSources(): string[] {
  const appData = process.env.LOCALAPPDATA;
  return appData ? [resolve(appData, 'ai-memory/models', MODEL_NAME)] : [];
}
// Provisions the model into one profile. Returns 'missing' when no verified source exists, so the engine downloads it with its own checksums.
export async function ensureLocalModel(dataDir: string, sources: string[] = defaultModelSources(), options: ModelOptions = {}): Promise<ModelStatus> {
  const files = options.files ?? MODEL_FILES, cacheDir = options.cacheDir ?? SHARED_CACHE;
  const modelDir = resolve(dataDir, 'models', MODEL_NAME);
  await assertLocal(modelDir);
  if (await verifyModelDir(modelDir, files)) return 'present';
  await refuseCorrupted(modelDir, files);
  if (!await ensureCache(cacheDir, sources, files)) return 'missing';
  await provisionProfile(modelDir, cacheDir, files);
  return 'provisioned';
}
// A profile file that exists but fails its checksum belongs to the user's data: report it, never overwrite it.
async function refuseCorrupted(modelDir: string, files: readonly ModelFile[]): Promise<void> {
  for (const file of files) {
    const path = resolve(modelDir, file.name);
    if (await exists(path) && !await matches(path, file.sha256))
      throw new Error(`Model file ${file.name} fails its checksum; refusing to overwrite it. Move it aside and retry.`);
  }
}
async function ensureCache(cacheDir: string, sources: string[], files: readonly ModelFile[]): Promise<boolean> {
  await assertLocal(cacheDir);
  if (await verifyModelDir(cacheDir, files)) return true;
  const source = await firstValidSource(sources, files);
  if (!source) return false;
  await replaceCache(cacheDir, source, files);
  return true;
}
async function firstValidSource(sources: string[], files: readonly ModelFile[]): Promise<string | undefined> {
  for (const source of sources) if (await verifyModelDir(source, files)) return source;
  return undefined;
}
// Copy into a sibling staging folder, verify it, then rename into place.
async function replaceCache(cacheDir: string, source: string, files: readonly ModelFile[]): Promise<void> {
  const staging = `${cacheDir}.${randomBytes(6).toString('hex')}.tmp`;
  await prepare(staging);
  try {
    for (const file of files) await copyFile(resolve(source, file.name), resolve(staging, file.name));
    if (!await verifyModelDir(staging, files)) throw new Error('Copied model failed checksum verification');
    await rm(cacheDir, { recursive: true, force: true });
    await rename(staging, cacheDir);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
}
async function provisionProfile(modelDir: string, cacheDir: string, files: readonly ModelFile[]): Promise<void> {
  await prepare(modelDir);
  for (const file of files) {
    const target = resolve(modelDir, file.name);
    // Existing files were already checked by refuseCorrupted, so a match means nothing is missing here.
    if (await matches(target, file.sha256)) continue;
    await linkOrCopy(resolve(cacheDir, file.name), target);
  }
  if (!await verifyModelDir(modelDir, files)) throw new Error('Provisioned model failed checksum verification');
}
// Hardlinks keep one copy on disk. A verified copy is the fallback when linking fails, for example across volumes.
async function linkOrCopy(source: string, target: string): Promise<void> {
  try { await link(source, target); return; }
  catch { /* Fall back to copying below. */ }
  const staging = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await copyFile(source, staging, constants.COPYFILE_EXCL);
    await rename(staging, target);
  } catch (e) {
    await rm(staging, { force: true });
    throw e;
  }
}
