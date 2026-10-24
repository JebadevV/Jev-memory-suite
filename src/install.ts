import { cp, readFile, readdir, lstat, writeFile, access, rename, rm, copyFile, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { z } from 'zod';
import { root, prepare, json, inside } from './config.js';
import { atomicJson, run, baseEnv } from './local.js';

const exec = promisify(execFile);
const exe = process.platform === 'win32' ? '.exe' : '';
const enginesDir = resolve(root, '.local/engines');
const gatewayBase = resolve(enginesDir, 'jev-gateway');
const POINTER_FILE = 'current.json';
const COMPLETE_MARKER = '.jev-suite-complete';
const treeId = z.string().regex(/^[a-f0-9]{40}$/);
const markerSchema = z.strictObject({ tree: treeId, at: z.string().min(1) });
const pointerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  memory: z.strictObject({ tree: treeId, binary: z.string().min(1) }).optional(),
  gateway: z.strictObject({ tree: treeId, dir: z.string().min(1) }).optional()
});
export type EnginePointer = z.infer<typeof pointerSchema>;
const MEMORY_MISSING = 'Memory engine not installed; run: jev-memory install memory';
const GATEWAY_MISSING = 'Gateway engine not installed; run: jev-memory install gateway';

// Pure validation: every stored engine path must stay inside the engines base.
export function parseEnginePointer(value: unknown, base: string): EnginePointer {
  const pointer = pointerSchema.parse(value);
  return {
    schemaVersion: 1,
    ...(pointer.memory && { memory: { tree: pointer.memory.tree, binary: inside(base, pointer.memory.binary) } }),
    ...(pointer.gateway && { gateway: { tree: pointer.gateway.tree, dir: inside(base, pointer.gateway.dir) } })
  };
}
// The engines base is a parameter only so rollback tests can use a temporary directory; the default is the real one.
export function readPointerSync(engines = enginesDir): EnginePointer {
  let text: string;
  try { text = readFileSync(resolve(engines, POINTER_FILE), 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1 };
    throw e;
  }
  return parseEnginePointer(JSON.parse(text.replace(/^﻿/, '')) as unknown, engines);
}
export function memoryBinaryFrom(pointer: EnginePointer): string {
  if (!pointer.memory) throw new Error(MEMORY_MISSING);
  return pointer.memory.binary;
}
export function gatewayDirFrom(pointer: EnginePointer): string {
  if (!pointer.gateway) throw new Error(GATEWAY_MISSING);
  return pointer.gateway.dir;
}
export function memoryBinary(): string { return memoryBinaryFrom(readPointerSync()); }
export function gatewayDir(): string { return gatewayDirFrom(readPointerSync()); }

const PATCH_NAME = /^[A-Za-z0-9._-]+\.patch$/;
const PATCH_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export type GatewayPatch = { name: string; path: string; bytes: Buffer };
// Patches are versioned with the vendored package: patches/jev-gateway/<version>/*.patch.
export async function gatewayPatches(base = root): Promise<GatewayPatch[]> {
  const pkg = z.object({ version: z.string() }).parse(await json(resolve(base, 'upstream/jev-gateway/package.json')));
  if (!PATCH_VERSION.test(pkg.version)) throw new Error('Gateway version is not a safe directory name');
  const dir = resolve(base, 'patches/jev-gateway', pkg.version);
  let names: string[];
  try { names = await readdir(dir); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const patches: GatewayPatch[] = [];
  for (const name of names.sort()) {
    if (!PATCH_NAME.test(name)) throw new Error(`Refusing gateway patch with unexpected name: ${name}`);
    const path = resolve(dir, name);
    if (!(await lstat(path)).isFile()) throw new Error(`Gateway patch is not a regular file: ${name}`);
    patches.push({ name, path, bytes: await readFile(path) });
  }
  return patches;
}
// Pure: the id depends on patch names and contents, not on their order. No patches keeps the plain tree id.
export function gatewayVersionId(upstreamTree: string, patches: { name: string; bytes: Uint8Array | Buffer }[]): string {
  if (patches.length === 0) return upstreamTree;
  const entries = patches.map(p => ({ name: p.name, sha256: createHash('sha256').update(p.bytes).digest('hex') }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(entries.map(e => e.name)).size !== entries.length) throw new Error('Duplicate gateway patch name');
  return createHash('sha1').update(JSON.stringify({ tree: upstreamTree, patches: entries })).digest('hex');
}

// Version id: the Git tree of the vendored prefix. Refuses modified sources so builds match a commit.
async function upstreamTree(prefix: string): Promise<string> {
  const status = await exec('git', ['status', '--porcelain', '--', prefix], { cwd: root, env: baseEnv() });
  if (status.stdout.trim()) throw new Error('Upstream source modified; refusing to build');
  const { stdout } = await exec('git', ['rev-parse', `HEAD:${prefix}`], { cwd: root, env: baseEnv() });
  const tree = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error('Unable to resolve upstream tree id');
  return tree;
}
async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
// A gateway version is usable only when its marker names the same tree and dist/index.js exists.
export function isCompleteGateway(marker: unknown, tree: string): boolean {
  const parsed = markerSchema.safeParse(marker);
  return parsed.success && parsed.data.tree === tree;
}
async function gatewayComplete(dir: string, tree: string): Promise<boolean> {
  const marker = await json(resolve(dir, COMPLETE_MARKER)).catch(() => undefined);
  return isCompleteGateway(marker, tree) && await exists(resolve(dir, 'dist/index.js'));
}
// Removal is limited to gateway version dirs under .local/engines/jev-gateway.
async function removeGatewayDir(dir: string): Promise<void> {
  inside(gatewayBase, relative(gatewayBase, dir));
  await rm(dir, { recursive: true, force: true });
}
// Pointer updates replace one engine key; older versions stay on disk because running processes may still use them.
async function updatePointer(key: 'memory' | 'gateway', entry: object, engines = enginesDir): Promise<void> {
  await prepare(engines);
  const previous = readPointerSync(engines);
  await atomicJson(resolve(engines, POINTER_FILE), { ...previous, [key]: entry });
}
async function installMemory(): Promise<void> {
  const tree = await upstreamTree('upstream/ai-memory');
  await run('cargo', ['+stable', 'build', '--locked', '--bin', 'ai-memory', '--manifest-path', 'upstream/ai-memory/Cargo.toml', '--target-dir', '.local/cargo-target'], 'memory-build.log');
  const built = resolve(root, `.local/cargo-target/debug/ai-memory${exe}`);
  await access(built);
  const dir = inside(enginesDir, `ai-memory/${tree}`);
  await prepare(dir);
  const binary = resolve(dir, `ai-memory${exe}`);
  // Immutable version: an existing binary for this tree is kept untouched.
  if (!await exists(binary)) {
    const tmp = resolve(dir, `.ai-memory-${randomBytes(6).toString('hex')}.tmp`);
    try {
      await copyFile(built, tmp, constants.COPYFILE_EXCL);
      await rename(tmp, binary);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  await updatePointer('memory', { tree, binary });
}
// Patches are applied from a copy of their verified bytes, so the applied content is the content the id hashes.
// The ceiling stops git from finding the suite's own repository, which would resolve patch paths against it and skip them silently.
// Each patch must pass a check before it is applied and a reverse check after, which proves the change is really present.
export async function applyGatewayPatches(dir: string, patches: { name: string; bytes: Buffer }[]): Promise<void> {
  const env = { ...baseEnv(), GIT_CEILING_DIRECTORIES: resolve(dir, '..') };
  const scratch = resolve(root, '.local/tmp');
  await prepare(scratch);
  // Patches are stored with LF (the git index form); a CRLF checkout needs CRLF patch lines to match its files.
  const crlf = (await readFile(resolve(dir, 'package.json'), 'utf8').catch(() => '')).includes('\r\n');
  for (const patch of patches) {
    const hasCr = patch.bytes.includes('\r');
    if (!crlf && hasCr) throw new Error(`Gateway patch must be stored with LF line endings: ${patch.name}`);
    const bytes = crlf && !hasCr ? Buffer.from(patch.bytes.toString('utf8').replace(/\n/g, '\r\n')) : patch.bytes;
    const copy = resolve(scratch, `gateway-${randomBytes(6).toString('hex')}-${patch.name}`);
    await writeFile(copy, bytes, { flag: 'wx' });
    try {
      // autocrlf is forced off: a global core.autocrlf=true would make git rewrite the patched lines and break the tree's endings.
      const git = ['-c', 'core.autocrlf=false', 'apply'];
      await run('git', [...git, '--check', '--whitespace=nowarn', copy], 'gateway-patch.log', dir, env);
      await run('git', [...git, '--whitespace=nowarn', copy], 'gateway-patch.log', dir, env);
      await run('git', [...git, '--reverse', '--check', '--whitespace=nowarn', copy], 'gateway-patch.log', dir, env);
    } catch {
      throw new Error(`Gateway patch does not apply: ${patch.name}; see .local/evidence/gateway-patch.log`);
    } finally {
      await rm(copy, { force: true });
    }
  }
}
// Built in place: pnpm writes absolute links into node_modules, so the final dir must be the build dir.
async function buildGateway(dir: string, id: string, patches: GatewayPatch[]): Promise<void> {
  await prepare(dir);
  await cp(resolve(root, 'upstream/jev-gateway'), dir, { recursive: true,
    filter: p => !['node_modules', 'dist', '.env'].some(n => p.split(/[\\/]/).includes(n)) });
  await applyGatewayPatches(dir, patches);
  const pnpm = resolve(root, 'node_modules/pnpm/bin/pnpm.cjs');
  await run(process.execPath, [pnpm, 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', resolve(root, '.local/pnpm-store')], 'gateway-install.log', dir);
  await run(process.execPath, [resolve(dir, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], 'gateway-build.log', dir);
  await cp(resolve(dir, 'src/dashboard.html'), resolve(dir, 'dist/dashboard.html'));
  await access(resolve(dir, 'dist/index.js'));
  await atomicJson(resolve(dir, COMPLETE_MARKER), { tree: id, at: new Date().toISOString() });
}
// The gateway version the pointer served before, and the one it serves now; the operator needs both to know the rollback target.
export interface GatewayChange { previous: string | null; current: string }
async function installGateway(): Promise<GatewayChange> {
  const patches = await gatewayPatches();
  // The id changes when a patch changes, so each patched build is a new immutable version.
  const id = gatewayVersionId(await upstreamTree('upstream/jev-gateway'), patches);
  const dir = inside(gatewayBase, id);
  if (!await gatewayComplete(dir, id)) {
    // Never remove the version the pointer serves; an incomplete referenced version needs manual repair.
    if (readPointerSync().gateway?.dir === dir && await exists(dir)) throw new Error('Referenced gateway version is incomplete; refusing to remove it');
    if (await exists(dir)) await removeGatewayDir(dir);
    try { await buildGateway(dir, id, patches); }
    catch (e) { await removeGatewayDir(dir); throw e; }
  }
  const previous = readPointerSync().gateway?.tree ?? null;
  await updatePointer('gateway', { tree: id, dir });
  return { previous, current: id };
}
export async function install(engine: string): Promise<GatewayChange | undefined> {
  if (!['all', 'memory', 'gateway'].includes(engine)) throw new Error('Engine must be all, memory or gateway');
  if (engine === 'all' || engine === 'memory') await installMemory();
  const gateway = engine === 'all' || engine === 'gateway' ? await installGateway() : undefined;
  const sources = await json(resolve(root, 'upstream.sources.json'));
  const pointer = readPointerSync();
  await atomicJson(resolve(root, '.local/installed.json'), { sources, lastInstalled: engine, at: new Date().toISOString(),
    engines: { memory: pointer.memory?.tree ?? null, gateway: pointer.gateway?.tree ?? null } });
  return gateway;
}

export interface GatewayVersion { id: string; at: string; current: boolean }
// Returns the marker time when a gateway version dir is complete: a real directory (not a link), a marker naming it, and dist/index.js.
async function gatewayVersionAt(base: string, id: string): Promise<string | undefined> {
  const dir = resolve(base, id);
  const stat = await lstat(dir).catch(() => undefined);
  if (!stat?.isDirectory()) return undefined;
  const marker = markerSchema.safeParse(await json(resolve(dir, COMPLETE_MARKER)).catch(() => undefined));
  if (!marker.success || marker.data.tree !== id) return undefined;
  return await exists(resolve(dir, 'dist/index.js')) ? marker.data.at : undefined;
}
// Lists only complete versions, newest first; the pointer's version is flagged so the operator sees the current one.
export async function listGatewayVersions(engines = enginesDir): Promise<GatewayVersion[]> {
  const base = resolve(engines, 'jev-gateway');
  let names: string[];
  try { names = await readdir(base); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const current = readPointerSync(engines).gateway?.tree;
  const versions: GatewayVersion[] = [];
  for (const id of names) {
    if (!treeId.safeParse(id).success) continue;
    const at = await gatewayVersionAt(base, id);
    if (at !== undefined) versions.push({ id, at, current: id === current });
  }
  return versions.sort((a, b) => b.at.localeCompare(a.at));
}
// Rollback only re-points the gateway engine: nothing is deleted, since a running gateway may still use the previous version.
export async function rollbackGateway(id: string, engines = enginesDir): Promise<GatewayChange> {
  if (!treeId.safeParse(id).success) throw new Error('Gateway version id must be 40 lowercase hex characters');
  const dir = inside(resolve(engines, 'jev-gateway'), id);
  if (await gatewayVersionAt(resolve(engines, 'jev-gateway'), id) === undefined)
    throw new Error(`Gateway version is missing or incomplete: ${id}; run: jev-memory gateway-versions`);
  const previous = readPointerSync(engines).gateway?.tree ?? null;
  await updatePointer('gateway', { tree: id, dir }, engines);
  return { previous, current: id };
}
// The suite-managed first line of config.toml; any other provider is user configuration and is never touched.
const MANAGED_PROVIDER_LINE = /^embedding_provider = "(none|local)"(\r?\n|$)/;
function providerLine(semantic: boolean): string {
  return `embedding_provider = "${semantic ? 'local' : 'none'}"`;
}
// Latin-1 maps every byte to one character, so the rest of the file is rewritten byte for byte.
export async function syncEmbeddingProvider(configPath: string, semantic: boolean): Promise<boolean> {
  const text = (await readFile(configPath)).toString('latin1');
  const match = MANAGED_PROVIDER_LINE.exec(text);
  if (!match || match[1] === (semantic ? 'local' : 'none')) return false;
  const next = providerLine(semantic) + match[2] + text.slice(match[0].length);
  const tmp = `${configPath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, Buffer.from(next, 'latin1'), { mode: 0o600, flag: 'wx' });
    await rename(tmp, configPath);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return true;
}
export async function initMemory(dir: string, semantic = true): Promise<void> {
  const data = resolve(dir, 'memory'); await prepare(data);
  const config = resolve(data, 'config.toml');
  if (await exists(config)) { await syncEmbeddingProvider(config, semantic); return; }
  await run(memoryBinary(), ['--data-dir', data, 'init'], 'memory-init.log');
  // Never change a pre-existing installation or rotate its credentials.
  const contents = await readFile(config, 'utf8');
  const safe = `${providerLine(semantic)}\nbackfill_on_start = false\n\n` + contents
    .replace(/^lambda = .*$/m, 'lambda = 0.0')
    .replace(/^cold_threshold = .*$/m, 'cold_threshold = 0.0')
    .replace(/^hard_delete_after_days = .*$/m, 'hard_delete_after_days = 4294967295')
    .replace(/^require_approval = false$/m, 'require_approval = true')
    .replace(/^enabled = true$/m, 'enabled = false')
    .replace(/^\[auth\]$/m, '[maintenance]\nenabled = false\n\n[auth]');
  // Fresh init contains auth credentials: retain only in ignored local storage.
  await writeFile(config, safe, { mode: 0o600 });
}
