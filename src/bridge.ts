import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readConfig, profileDir } from './config.js';
import { memoryBinary } from './install.js';
import { baseEnv } from './local.js';
async function main() {
  const name = process.argv[2] ?? '', c = await readConfig(name);
  if (!c.memory.enabled) throw new Error('Memory disabled');
  const child = spawn(memoryBinary(), ['--data-dir', resolve(profileDir(name), 'memory'), 'mcp-bridge', '--no-session-id', '--server-url', `http://127.0.0.1:${c.memory.port}`], {
    env: baseEnv(), windowsHide: true, shell: false, stdio: 'inherit'
  });
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.on('SIGTERM', () => child.kill()); process.on('SIGINT', () => child.kill());
}
main().catch(() => { console.error('MCP bridge unavailable; run suite doctor'); process.exitCode = 1; });
