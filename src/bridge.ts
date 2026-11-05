import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readConfig, profileDir, root } from './config.js';
import { memoryBinary } from './install.js';
import { baseEnv, sleep } from './local.js';
import { control, supervisorState, type SupervisorState } from './lifecycle.js';
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
export interface BridgeSpawn { args: string[]; env: NodeJS.ProcessEnv }
// Pure: session-aware only for Claude Code with a valid session id; anything else gets the stateless bridge and no inherited id.
export function bridgeArgs(dataDir: string, port: number, agent: string | undefined, sessionId: string | undefined): BridgeSpawn {
  const url = `http://127.0.0.1:${port}`;
  if (agent === 'claude-code' && sessionId !== undefined && SESSION_ID_PATTERN.test(sessionId)) {
    return { args: ['--data-dir', dataDir, 'mcp-bridge', '--agent', 'claude-code', '--server-url', url], env: { ...baseEnv(), CLAUDE_CODE_SESSION_ID: sessionId } };
  }
  return { args: ['--data-dir', dataDir, 'mcp-bridge', '--no-session-id', '--server-url', url], env: baseEnv() };
}
export interface MemoryUpDeps {
  env: NodeJS.ProcessEnv;
  state: (name: string) => Promise<SupervisorState>;
  spawnStart: (name: string) => void;
  status: (name: string) => Promise<Record<string, unknown>>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}
// Same detached start as launch.ts: the bridge never waits on the supervisor's own startup, only on memory readiness below.
function spawnDetachedStart(name: string): void {
  const child = spawn(process.execPath, [resolve(root, 'dist/src/cli.js'), '--profile', name, 'start'], { cwd: root, detached: true, windowsHide: true, shell: false, stdio: 'ignore' });
  child.once('error', () => undefined);
  child.unref();
}
// Claude Code gives the stdio server about 30s to connect, so a stopped profile is started and polled for memory readiness within 25s.
// Only a stopped profile is started: a foreign port is never ours to start. Never throws: on any failure the bridge proceeds as before.
export async function ensureMemoryUp(name: string, deps: MemoryUpDeps, timeoutMs = 25000): Promise<void> {
  try {
    if (deps.env.JMS_BRIDGE_AUTOSTART === 'off') return;
    if ((await deps.state(name)) !== 'stopped') return;
    deps.spawnStart(name);
    const deadline = deps.now() + timeoutMs;
    while (deps.now() < deadline) {
      await deps.sleep(250);
      try {
        const services = (await deps.status(name)).services as Record<string, unknown> | undefined;
        if (services?.memory === 'ready') return;
      } catch {
        // The supervisor is not listening yet; keep polling until the deadline.
      }
    }
  } catch {
    // Ignored by design: the bridge must still reach ai-memory's own connection error.
  }
}
const defaultMemoryUpDeps: MemoryUpDeps = { env: process.env, state: supervisorState, spawnStart: spawnDetachedStart, status: name => control(name, 'status'), sleep, now: Date.now };
async function main() {
  const agent = process.argv[3];
  if (agent !== undefined && agent !== 'claude-code') throw new Error('Unknown bridge agent'); // Checked before any spawn.
  const name = process.argv[2] ?? '', c = await readConfig(name);
  if (!c.memory.enabled) throw new Error('Memory disabled');
  await ensureMemoryUp(name, defaultMemoryUpDeps);
  const { args, env } = bridgeArgs(resolve(profileDir(name), 'memory'), c.memory.port, agent, process.env.CLAUDE_CODE_SESSION_ID);
  const child = spawn(memoryBinary(), args, { env, windowsHide: true, shell: false, stdio: 'inherit' });
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.on('SIGTERM', () => child.kill()); process.on('SIGINT', () => child.kill());
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/bridge.js')) main().catch(() => { console.error('MCP bridge unavailable; run suite doctor'); process.exitCode = 1; });
