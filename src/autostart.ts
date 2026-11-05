import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { root } from './config.js';

const exec = promisify(execFile);
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'jev-memory-suite';
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
// Windows silently skips Run entries longer than this.
const MAX_RUN_COMMAND = 260;

export interface AutostartStatus {
  installed: boolean;
  command?: string;
  length?: number;
  matchesExpected: boolean;
  disabledInStartupApps: boolean;
  lastLog?: string;
}

function requireWindows(): void {
  if (process.platform !== 'win32') throw new Error('autostart is only supported on Windows');
}
function scriptPath(): string { return resolve(root, 'scripts/autostart.ps1'); }
function logPath(): string { return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'jev-autostart.log'); }

export function autostartCommand(path: string): string {
  const command = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path}"`;
  if (command.length > MAX_RUN_COMMAND) {
    throw new Error(`autostart command is ${command.length} characters; Windows skips Run entries over ${MAX_RUN_COMMAND}. Move the repository to a shorter path.`);
  }
  return command;
}

// Finds one value in `reg query <key> /v <name>` output. Lines look like "    name    REG_SZ    data".
export function parseRegValue(output: string, name: string): { type: string; data: string } | undefined {
  const wanted = name.toLowerCase();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S.*?)\s+(REG_[A-Z_0-9]+)(?:\s+(.*?))?\s*$/.exec(line);
    const [, found = '', type = '', data = ''] = match ?? [];
    if (match && found.toLowerCase() === wanted) return { type, data };
  }
  return undefined;
}

// StartupApproved stores the state in the first byte: odd (0x03) means disabled in Startup Apps.
export function startupApprovedDisabled(hex: string | undefined): boolean {
  if (!hex) return false;
  const first = parseInt(hex.trim().split(/\s+/)[0] ?? '', 16);
  return Number.isInteger(first) && first % 2 === 1;
}

async function reg(args: string[]): Promise<string> {
  const { stdout } = await exec('reg.exe', args, { windowsHide: true, encoding: 'utf8' });
  return stdout;
}

// reg query exits with 1 when the key or value is missing; that is an answer, not a failure.
async function queryValue(key: string, name: string): Promise<string | undefined> {
  try {
    return parseRegValue(await reg(['query', key, '/v', name]), name)?.data;
  } catch (e) {
    if ((e as { code?: unknown }).code === 1) return undefined;
    throw e;
  }
}

export async function installAutostart(): Promise<{ command: string; length: number }> {
  requireWindows();
  const script = scriptPath();
  await stat(script).catch(() => { throw new Error(`autostart script not found: ${script}`); });
  const command = autostartCommand(script);
  await reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f']);
  return { command, length: command.length };
}

export async function uninstallAutostart(): Promise<{ removed: boolean }> {
  requireWindows();
  if (await queryValue(RUN_KEY, RUN_VALUE) === undefined) return { removed: false };
  await reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  return { removed: true };
}

export async function autostartStatus(): Promise<AutostartStatus> {
  requireWindows();
  const command = await queryValue(RUN_KEY, RUN_VALUE);
  const approved = await queryValue(APPROVED_KEY, RUN_VALUE);
  let expected: string | undefined;
  try { expected = autostartCommand(scriptPath()); } catch { expected = undefined; }
  return {
    installed: command !== undefined,
    command,
    length: command?.length,
    matchesExpected: command !== undefined && command === expected,
    disabledInStartupApps: startupApprovedDisabled(approved),
    lastLog: await lastLogLine(),
  };
}

async function lastLogLine(): Promise<string | undefined> {
  try {
    const lines = (await readFile(logPath(), 'utf8')).split(/\r?\n/).filter(line => line.trim());
    return lines.at(-1);
  } catch { return undefined; }
}
