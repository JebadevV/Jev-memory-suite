import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import { configSchema, json, prepare, profileDir, readConfig, root } from './config.js';
import { atomicJson, baseEnv, sleep, token } from './local.js';
import { memoryBinary, gatewayDir, readPointerSync } from './install.js';

// Trees come from the pointer only; a corrupt pointer reports null instead of hiding the other fields.
function engineTrees(): { memory: string | null; gateway: string | null } {
  try {
    const pointer = readPointerSync();
    return { memory: pointer.memory?.tree ?? null, gateway: pointer.gateway?.tree ?? null };
  } catch { return { memory: null, gateway: null }; }
}

export async function init(name: string): Promise<void> {
  const dir = profileDir(name); await prepare(dir);
  const value = configSchema.parse(await json(resolve(root, 'config/default.json')));
  // Exclusive creation: never overwrite a user's profile.
  await writeFile(resolve(dir, 'suite.json'), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await token(dir);
  await token(dir, 'router-token');
}
export async function control(name: string, action: 'status' | 'stop'): Promise<Record<string, unknown>> {
  const config = await readConfig(name);
  const key = await token(profileDir(name));
  const res = await fetch(`http://127.0.0.1:${config.controlPort}/${action}`, {
    method: action === 'stop' ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(2000), redirect: 'error'
  });
  if (!res.ok) throw new Error(`Supervisor ${action}: HTTP ${res.status}`);
  return await res.json() as Record<string, unknown>;
}
export type SupervisorState = 'running' | 'stopped' | 'foreign';
// 401/403 means the port answers, but not with our token: another profile or process owns it.
const FOREIGN_STATUSES = new Set([401, 403]);
function isConnectionRefused(e: unknown): boolean {
  return e instanceof TypeError && !!e.cause && (e.cause as NodeJS.ErrnoException).code === 'ECONNREFUSED';
}
async function foreignPortError(name: string): Promise<Error> {
  const { controlPort } = await readConfig(name);
  return new Error(`Control port ${controlPort} is used by another supervisor or process; change controlPort with: jev-memory --profile ${name} config <file>`);
}
export async function supervisorState(name: string): Promise<SupervisorState> {
  const config = await readConfig(name);
  const key = await token(profileDir(name));
  try {
    const res = await fetch(`http://127.0.0.1:${config.controlPort}/status`, {
      method: 'GET', headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000), redirect: 'error'
    });
    await res.body?.cancel();
    if (res.ok) return 'running';
    if (FOREIGN_STATUSES.has(res.status)) return 'foreign';
    throw new Error(`Supervisor status: HTTP ${res.status}`);
  } catch (e) {
    if (isConnectionRefused(e)) return 'stopped';
    throw e;
  }
}
export async function running(name: string): Promise<boolean> {
  const state = await supervisorState(name);
  if (state === 'foreign') throw await foreignPortError(name);
  return state === 'running';
}
export async function start(name: string): Promise<Record<string, unknown>> {
  const state = await supervisorState(name);
  if (state === 'running') throw new Error('Profile is already running');
  if (state === 'foreign') throw await foreignPortError(name);
  const c = await readConfig(name);
  if (c.gateway.enabled && (!process.env[c.gateway.upstreamKeyEnv] || !process.env[c.gateway.jevKeyEnv]))
    throw new Error('Gateway requires the two configured JMS_* key environment variables');
  const dir = profileDir(name);
  await prepare(resolve(dir, 'logs')); await prepare(resolve(root, '.local/tmp'));
  const env = baseEnv();
  for (const k of [c.gateway.upstreamKeyEnv, c.gateway.jevKeyEnv]) if (process.env[k]) env[k] = process.env[k];
  const { open } = await import('node:fs/promises');
  const log = await open(resolve(dir, 'logs/supervisor.log'), 'a');
  const child = spawn(process.execPath, [resolve(root, 'dist/src/supervisor.js'), name], {
    cwd: root, env, detached: true, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd]
  });
  let launchError: Error | undefined;
  child.on('error', e => { launchError = e; });
  child.unref(); await log.close();
  for (let i = 0; i < 180; i++) {
    if (launchError) throw launchError;
    try {
      const state = await control(name, 'status');
      if (state.phase === 'ready') return state;
      if (state.phase === 'failed') throw new Error('Supervisor failed; inspect local logs');
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
    if (child.exitCode !== null) throw new Error('Supervisor exited; inspect local logs');
    await sleep(250);
  }
  // Ask the authenticated supervisor to stop; never kill a stored PID.
  await stop(name).catch(() => undefined);
  throw new Error('Startup timeout; inspect local logs');
}
export async function stop(name: string): Promise<void> {
  if (await supervisorState(name) !== 'running') return;
  await control(name, 'stop');
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    if (await supervisorState(name) !== 'running') return;
  }
  throw new Error('Supervisor did not finish stopping; no unrelated process was terminated');
}
export async function configure(name: string, source: string): Promise<void> {
  const { assertLocal } = await import('./config.js');
  await assertLocal(resolve(root, source));
  // A foreign listener on the port is not our profile running, so configuration may change.
  if (await supervisorState(name) === 'running') throw new Error('Stop profile before changing configuration');
  const c = configSchema.parse(await json(resolve(root, source)));
  await atomicJson(resolve(profileDir(name), 'suite.json'), c);
}
async function supervisorReport(name: string): Promise<Record<string, unknown>> {
  const state = await supervisorState(name);
  if (state === 'running') return await control(name, 'status');
  if (state === 'foreign') return { phase: 'port-conflict', controlPort: (await readConfig(name)).controlPort };
  return { phase: 'stopped' };
}
export async function doctor(name: string): Promise<unknown> {
  const c = await readConfig(name);
  const installedAt = async (resolvePath: () => string) => {
    try { await access(resolvePath()); return true; }
    catch { return false; }
  };
  return {
    profile: name, workspace: root,
    installed: {
      memory: await installedAt(memoryBinary),
      gateway: await installedAt(() => resolve(gatewayDir(), 'dist/index.js'))
    },
    engines: engineTrees(),
    enabled: { memory: c.memory.enabled, gateway: c.gateway.enabled },
    credentials: { upstreamPresent: !!process.env[c.gateway.upstreamKeyEnv], jevPresent: !!process.env[c.gateway.jevKeyEnv] },
    supervisor: await supervisorReport(name),
    trust: 'Codex hooks require native trust review; Desktop verification is separate',
    retainedToken: await readFile(resolve(profileDir(name), 'control-token')).then(() => true, () => false),
    retainedRouterToken: await readFile(resolve(profileDir(name), 'router-token')).then(() => true, () => false)
  };
}
