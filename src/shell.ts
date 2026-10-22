import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, writeFile } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepare, root } from './config.js';

const exec = promisify(execFile);
const key = 'HKCU\\Environment';
const bin = resolve(root, 'bin');
const commands = ['jev-memory', 'jev-memory-codex', 'jev-memory-claude'] as const;
type PathKind = 'REG_SZ' | 'REG_EXPAND_SZ';
export interface UserPath { existed: boolean; kind: PathKind; value: string }

function normalized(entry: string): string {
  const expanded = entry.trim().replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (match: string, name: string) => process.env[name] ?? match);
  return win32.normalize(expanded).replace(/[\\/]+$/, '').toLowerCase();
}
export function addPathEntry(value: string, entry: string): string {
  if (/[;\r\n\0]/.test(entry)) throw new Error('Suite bin path cannot be represented as a PATH entry');
  if (value.split(';').some(item => normalized(item) === normalized(entry))) return value;
  return `${value}${value && !value.endsWith(';') ? ';' : ''}${entry}`;
}
export function parseUserPath(output: string): UserPath {
  const line = output.split(/\r?\n/).find(line => /^\s+Path\s+REG_/i.test(line));
  if (line === undefined) return { existed: false, kind: 'REG_EXPAND_SZ', value: '' };
  const match = /^\s+Path\s+(REG_SZ|REG_EXPAND_SZ)[ \t]*(.*)$/i.exec(line);
  if (!match) throw new Error('User PATH is not a string; refusing to change it');
  return { existed: true, kind: match[1]?.toUpperCase() as PathKind, value: match[2] ?? '' };
}
async function userPath(): Promise<UserPath> {
  // Raw registry values preserve %VARIABLE% entries. Never print the rest of the user's environment.
  const { stdout } = await exec('reg.exe', ['query', key]);
  return parseUserPath(stdout);
}
async function preflight(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Short-command activation currently supports Windows');
  for (const command of commands) {
    const launcher = resolve(bin, `${command}.cmd`); await access(launcher);
    const found = await exec('where.exe', [command]).then(result => result.stdout.trim().split(/\r?\n/), () => []);
    if (found.some(path => normalized(path) !== normalized(launcher))) throw new Error(`Command ${command} already exists elsewhere; refusing to shadow it`);
  }
}
async function notifyEnvironment(): Promise<boolean> {
  // Static notification only: no user strings are evaluated as PowerShell or C# source.
  const source = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class JevPathNotify { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r); }'; $r=[UIntPtr]::Zero; $sent=[JevPathNotify]::SendMessageTimeout([IntPtr]0xffff,0x001a,[UIntPtr]::Zero,'Environment',2,3000,[ref]$r); if ($sent -eq [IntPtr]::Zero) { exit 1 }`;
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], { timeout: 10000 }).then(() => true, () => false);
}
export async function enableShell(persist: boolean): Promise<unknown> {
  await preflight();
  const previous = await userPath(), next = addPathEntry(previous.value, bin);
  if (!persist) return { commands, bin, registeredForUser: previous.value === next, persistsOnlyWith: '--persist' };
  let backup: string | undefined;
  if (next !== previous.value) {
    const backupDir = resolve(root, '.local/shell'); await prepare(backupDir);
    backup = resolve(backupDir, `user-path-before-${randomUUID()}.json`);
    await writeFile(backup, `${JSON.stringify({ purpose: 'Preserve user PATH before adding suite launchers', audience: 'user and maintainers', date: new Date().toISOString(), ...previous, added: bin }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const current = await userPath();
    if (current.value !== previous.value || current.kind !== previous.kind || current.existed !== previous.existed) throw new Error('User PATH changed during activation; retry to preserve the new entries');
    await exec('reg.exe', ['add', key, '/v', 'Path', '/t', previous.kind, '/d', next, '/f']);
    const verified = await userPath();
    if (verified.value !== next || verified.kind !== previous.kind) throw new Error('PATH verification failed; inspect the local backup before retrying');
  }
  const notified = await notifyEnvironment();
  return { commands, bin, registeredForUser: true, changed: next !== previous.value, backup, environmentNotified: notified,
    nextStep: 'Open a new terminal. In an existing PowerShell: $env:Path += \';' + bin + '\'' };
}
