import { z } from 'zod';
import { readFile, mkdir, realpath, lstat, stat } from 'node:fs/promises';
import { resolve, relative, sep, dirname, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const root = existsSync(resolve(moduleDir, '../package.json'))
  ? resolve(moduleDir, '..') : resolve(moduleDir, '../..');
export const profileName = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/);
const port = z.number().int().min(1024).max(65535);
const envName = z.string().regex(/^JMS_[A-Z0-9_]{1,60}$/);
export const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspace: profileName, project: profileName, controlPort: port,
  memory: z.strictObject({ enabled: z.boolean(), port }),
  gateway: z.strictObject({
    enabled: z.boolean(), port,
    upstreamUrl: z.string().url(), jevUrl: z.string().url(),
    allowedHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).min(1).max(16),
    upstreamKeyEnv: envName, jevKeyEnv: envName
  })
}).superRefine((c, ctx) => {
  if (new Set([c.controlPort, c.memory.port, c.gateway.port]).size !== 3)
    ctx.addIssue({ code: 'custom', message: 'Ports must be distinct' });
  for (const value of [c.gateway.upstreamUrl, c.gateway.jevUrl]) {
    const u = new URL(value);
    if (!c.gateway.allowedHosts.includes(u.hostname) || u.username || u.password || u.search || u.hash ||
        !(u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1')))
      ctx.addIssue({ code: 'custom', message: 'Endpoint must use HTTPS or numeric loopback, be allowlisted and contain no credentials/query/fragment' });
  }
});
export type Config = z.infer<typeof configSchema>;
export async function json(path: string): Promise<unknown> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as unknown;
}
export function inside(base: string, path: string): string {
  const target = resolve(base, path), rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(base) === target || /^[A-Za-z]:/.test(rel))
    throw new Error('Path escapes its workspace boundary');
  return target;
}
export function profileDir(name: string): string {
  return inside(root, `.local/profiles/${profileName.parse(name)}`);
}
const fold = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
const escapes = (rel: string): boolean => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || /^[A-Za-z]:/.test(rel);
async function assertNoLinks(base: string, target: string): Promise<void> {
  let current = base;
  for (const part of relative(base, target).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return undefined;
    });
    if (info?.isSymbolicLink()) throw new Error('Symlink/junction not allowed in managed paths');
  }
}
export async function assertLocal(path: string): Promise<void> {
  const target = resolve(path), base = await realpath(root);
  inside(base, target);
  await assertNoLinks(base, target);
}
export async function workspaceDir(path: string): Promise<string> {
  const target = resolve(path);
  if (!(await stat(target)).isDirectory()) throw new Error('Workspace path must be a directory');
  const base = await realpath(root), canonical = await realpath(target);
  const rel = relative(fold(base), fold(canonical));
  if (rel === '') return canonical;
  if (escapes(rel)) throw new Error('Path escapes its workspace boundary');
  if (escapes(relative(base, target))) throw new Error('Path escapes its workspace boundary');
  await assertNoLinks(base, target);
  return canonical;
}
export async function readConfig(name: string): Promise<Config> {
  const dir = profileDir(name);
  await assertLocal(dir);
  return configSchema.parse(await json(resolve(dir, 'suite.json')));
}
export async function prepare(path: string): Promise<void> {
  await assertLocal(path);
  await mkdir(path, { recursive: true });
}
