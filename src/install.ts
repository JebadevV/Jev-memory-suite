import { cp, readFile, access, rename, rm, copyFile, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { z } from 'zod';
import { root, prepare, json, inside } from './config.js';
import { atomicJson, run, baseEnv } from './local.js';

const exec = promisify(execFile);
const exe = process.platform === 'win32' ? '.exe' : '';
const enginesDir = resolve(root, '.local/engines');
const gatewayBase = resolve(enginesDir, 'jev-gateway');
const pointerPath = resolve(enginesDir, 'current.json');
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
export function readPointerSync(): EnginePointer {
  let text: string;
  try { text = readFileSync(pointerPath, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1 };
    throw e;
  }
  return parseEnginePointer(JSON.parse(text.replace(/^﻿/, '')) as unknown, enginesDir);
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
async function updatePointer(key: 'memory' | 'gateway', entry: object): Promise<void> {
  await prepare(enginesDir);
  const previous = readPointerSync();
  await atomicJson(pointerPath, { ...previous, [key]: entry });
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
// Built in place: pnpm writes absolute links into node_modules, so the final dir must be the build dir.
async function buildGateway(dir: string, tree: string): Promise<void> {
  await prepare(dir);
  await cp(resolve(root, 'upstream/jev-gateway'), dir, { recursive: true,
    filter: p => !['node_modules', 'dist', '.env'].some(n => p.split(/[\\/]/).includes(n)) });
  const pnpm = resolve(root, 'node_modules/pnpm/bin/pnpm.cjs');
  await run(process.execPath, [pnpm, 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', resolve(root, '.local/pnpm-store')], 'gateway-install.log', dir);
  await run(process.execPath, [resolve(dir, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], 'gateway-build.log', dir);
  await cp(resolve(dir, 'src/dashboard.html'), resolve(dir, 'dist/dashboard.html'));
  await access(resolve(dir, 'dist/index.js'));
  await atomicJson(resolve(dir, COMPLETE_MARKER), { tree, at: new Date().toISOString() });
}
async function installGateway(): Promise<void> {
  const tree = await upstreamTree('upstream/jev-gateway');
  const dir = inside(gatewayBase, tree);
  if (!await gatewayComplete(dir, tree)) {
    // Never remove the version the pointer serves; an incomplete referenced version needs manual repair.
    if (readPointerSync().gateway?.dir === dir && await exists(dir)) throw new Error('Referenced gateway version is incomplete; refusing to remove it');
    if (await exists(dir)) await removeGatewayDir(dir);
    try { await buildGateway(dir, tree); }
    catch (e) { await removeGatewayDir(dir); throw e; }
  }
  await updatePointer('gateway', { tree, dir });
}
export async function install(engine: string): Promise<void> {
  if (!['all', 'memory', 'gateway'].includes(engine)) throw new Error('Engine must be all, memory or gateway');
  if (engine === 'all' || engine === 'memory') await installMemory();
  if (engine === 'all' || engine === 'gateway') await installGateway();
  const sources = await json(resolve(root, 'upstream.sources.json'));
  const pointer = readPointerSync();
  await atomicJson(resolve(root, '.local/installed.json'), { sources, lastInstalled: engine, at: new Date().toISOString(),
    engines: { memory: pointer.memory?.tree ?? null, gateway: pointer.gateway?.tree ?? null } });
}
export async function initMemory(dir: string): Promise<void> {
  const data = resolve(dir, 'memory'); await prepare(data);
  const config = resolve(data, 'config.toml');
  try { await access(config); return; }
  catch { /* Fresh isolated data directory only. */ }
  await run(memoryBinary(), ['--data-dir', data, 'init'], 'memory-init.log');
  // Never change a pre-existing installation or rotate its credentials.
  const contents = await readFile(config, 'utf8');
  const safe = 'embedding_provider = "none"\nbackfill_on_start = false\n\n' + contents
    .replace(/^lambda = .*$/m, 'lambda = 0.0')
    .replace(/^cold_threshold = .*$/m, 'cold_threshold = 0.0')
    .replace(/^hard_delete_after_days = .*$/m, 'hard_delete_after_days = 4294967295')
    .replace(/^require_approval = false$/m, 'require_approval = true')
    .replace(/^enabled = true$/m, 'enabled = false')
    .replace(/^\[auth\]$/m, '[maintenance]\nenabled = false\n\n[auth]');
  // Fresh init contains auth credentials: retain only in ignored local storage.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(config, safe, { mode: 0o600 });
}
