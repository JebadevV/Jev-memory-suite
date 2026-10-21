import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, open, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertLocal, prepare, root } from './config.js';

export function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'])
    if (process.env[k]) env[k] = process.env[k];
  env.TEMP = env.TMP = resolve(root, '.local/tmp');
  env.CARGO_HOME = resolve(root, '.local/cargo-home');
  env.npm_config_cache = resolve(root, '.local/npm-cache');
  // Defense in depth: native hooks must never import pre-existing harness history.
  env.AI_MEMORY_BACKFILL_ON_START = 'false';
  env.AI_MEMORY_MAINTENANCE__ENABLED = 'false';
  return env;
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await assertLocal(path);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(tmp, path);
}
// Separate per-profile secrets: the control token authenticates the supervisor, the router token authenticates the gateway.
const tokenFiles = ['control-token', 'router-token'] as const;
export type TokenFile = (typeof tokenFiles)[number];
export async function token(dir: string, file: TokenFile = 'control-token'): Promise<string> {
  if (!tokenFiles.includes(file)) throw new Error('Unknown local token file');
  await prepare(dir);
  const path = resolve(dir, file);
  await assertLocal(path);
  try { await writeFile(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const value = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid local control token; refusing to replace it');
  return value;
}
export async function run(command: string, args: string[], logName: string, cwd = root, env = baseEnv()): Promise<void> {
  const dir = resolve(root, '.local/evidence');
  await prepare(dir); await prepare(resolve(root, '.local/tmp'));
  const out = await open(resolve(dir, logName), 'a');
  try {
    await new Promise<void>((ok, fail) => {
      const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', out.fd, out.fd] });
      child.on('error', fail);
      child.on('exit', code => code === 0 ? ok() : fail(new Error(`${logName}: exit ${code}; see .local/evidence/${logName}`)));
    });
  } finally { await out.close(); }
}
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
