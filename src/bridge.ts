import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readConfig, profileDir } from './config.js';
import { memoryBinary } from './install.js';
import { baseEnv } from './local.js';
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
async function main() {
  const agent = process.argv[3];
  if (agent !== undefined && agent !== 'claude-code') throw new Error('Unknown bridge agent'); // Checked before any spawn.
  const name = process.argv[2] ?? '', c = await readConfig(name);
  if (!c.memory.enabled) throw new Error('Memory disabled');
  const { args, env } = bridgeArgs(resolve(profileDir(name), 'memory'), c.memory.port, agent, process.env.CLAUDE_CODE_SESSION_ID);
  const child = spawn(memoryBinary(), args, { env, windowsHide: true, shell: false, stdio: 'inherit' });
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.on('SIGTERM', () => child.kill()); process.on('SIGINT', () => child.kill());
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/bridge.js')) main().catch(() => { console.error('MCP bridge unavailable; run suite doctor'); process.exitCode = 1; });
