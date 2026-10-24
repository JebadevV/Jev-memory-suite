import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { assertWithin, readConfig, root, workspaceDir, type Config } from './config.js';
import { events, hostEvents } from './hook.js';

const clientSchema = z.enum(['claude', 'codex', 'desktop', 'antigravity']);
const hostOf: Record<z.infer<typeof clientSchema>, Host> = { claude: 'claude', codex: 'codex', desktop: 'codex', antigravity: 'antigravity' };
const object = z.record(z.string(), z.unknown());
export const serverId = 'jev_memory_suite';
const begin = '# jev-memory-suite:start', end = '# jev-memory-suite:end';
const groupName = 'jev-memory-suite', upstreamGroup = 'ai-memory'; // Named groups in the Antigravity workspace hooks file.
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const manifestNames: Record<Host, string> = { claude: '.jev-memory-claude.json', codex: '.jev-memory-codex.json', antigravity: '.jev-memory-antigravity.json' };
const nativeTrust: Record<Host, string> = {
  claude: 'requires project MCP approval in actual Claude host',
  codex: 'requires /hooks review in actual Codex host',
  antigravity: 'Antigravity CLI loads workspace .agents/hooks.json without a trust prompt; Antigravity IDE/App read the same file, and the suite hook ignores their non-CLI payloads'
};
const manifestSchema = z.strictObject({ profile: z.string(), host: z.enum(['claude', 'codex', 'antigravity']), bridge: object, hooks: object,
  preexistingEvents: z.array(z.string()), block: z.string(), marker: z.string(), hooksFileExisted: z.boolean().optional() });
type Host = 'claude' | 'codex' | 'antigravity';
type Manifest = z.infer<typeof manifestSchema>;
type Key = 'config' | 'hooks' | 'marker' | 'manifest';
type Paths = Partial<Record<Key, string>>;
type Bytes = Partial<Record<Key, Buffer | undefined>>;
type Bridge = { command: string; args: string[] };
export type McpState = 'registered' | 'missing' | 'conflict' | 'bom' | 'unreadable';
export type AgyRunner = (args: string[]) => Promise<void>;
export interface ClientOptions { home?: string; runAgy?: AgyRunner }
interface Op { key: Key; path: string; before: Buffer | undefined; after: string | undefined }
interface Current { previous: Manifest | undefined; config: string; hooksText: string; hooks: Record<string, unknown>; doc: Record<string, unknown>; servers: Record<string, unknown>; marker: string }
interface Ctx { surface: string; host: Host; name: string; target: string; paths: Paths; bytes: Bytes; cur: Current }

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const decode = (bytes: Buffer | undefined): string => bytes?.toString('utf8') ?? '';
const relPath = (target: string, path: string): string => relative(target, path).split(sep).join('/');
const isOp = (op: Op | undefined): op is Op => op !== undefined;
const quote = (s: string): string => {
  if (/["%!\r\n`$]/.test(s)) throw new Error('Executable path cannot be safely quoted for native hook host');
  return `"${s}"`;
};
const pathOf = (paths: Paths, key: Key): string => {
  const path = paths[key];
  if (path === undefined) throw new Error(`Managed file ${key} is not used by this client`);
  return path;
};
// Antigravity has no workspace MCP file, so its transaction covers only hooks, marker and manifest.
const hostKeys = (host: Host): Key[] => (host === 'antigravity' ? ['hooks', 'marker', 'manifest'] : ['config', 'hooks', 'marker', 'manifest']); // Manifest is always written last.

// Only Claude Code passes an agent: its bridge runs session-aware. Codex keeps the stateless two-argument form.
export function bridgeEntry(name: string, agent?: 'claude-code'): Bridge {
  return { command: process.execPath, args: [resolve(root, 'dist/src/bridge.js'), name, ...(agent ? [agent] : [])] };
}
// Codex runs hook commands through PowerShell on Windows, where a leading quoted path is a parse error; `& ` is the call operator.
export function hookEntries(name: string, agent: 'claude-code' | 'codex', platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  const prefix = agent === 'codex' && platform === 'win32' ? '& ' : '';
  return Object.fromEntries(Object.entries(events).filter(([, native]) => hostEvents[agent].includes(native)).map(([event, native]) => {
    const argv = [process.execPath, resolve(root, 'dist/src/hook.js'), name, agent, native];
    return [event, { matcher: '', hooks: [{ type: 'command', command: prefix + argv.map(quote).join(' '), timeout: 25 }] }];
  }));
}
// Antigravity runs hook commands without a shell and splits them on whitespace, so every token must be a bare word.
const bareToken = /^[^\s"'`%!^&|<>$;]+$/;
export function shortPath(path: string): string {
  if (/["%\r\n]/.test(path)) throw new Error('Executable path cannot be safely converted to a short path');
  // Verbatim arguments keep cmd.exe's quoting intact; spawnSync is used because its typings accept that option.
  const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${path}") do @echo %~sI`], { windowsVerbatimArguments: true, encoding: 'utf8', windowsHide: true });
  if (run.status !== 0 || run.stdout.trim() === '') throw new Error('Executable short path could not be resolved');
  return run.stdout.trim();
}
export function antigravityHookGroup(name: string, nodeExe = process.execPath, platform = process.platform): Record<string, unknown> {
  const exe = platform === 'win32' && /\s/.test(nodeExe) ? shortPath(nodeExe).replace(/\\/g, '/') : nodeExe;
  const command = (suiteEvent: string): string => {
    const argv = [exe, resolve(root, 'dist/src/hook.js'), name, 'antigravity-cli', suiteEvent];
    if (!argv.every(token => bareToken.test(token))) throw new Error('Antigravity hooks need executable and script paths without spaces or shell characters');
    return argv.join(' ');
  };
  const handler = (suiteEvent: string) => ({ type: 'command', command: command(suiteEvent), timeout: 25 });
  const tool = (suiteEvent: string) => ({ matcher: '', hooks: [handler(suiteEvent)] });
  return { PreInvocation: [handler('session-start')], PreToolUse: [tool('pre-tool-use')], PostToolUse: [tool('post-tool-use')], Stop: [handler('stop')] };
}
function codexBlock(bridge: Bridge): string {
  return `${begin}\n[mcp_servers.${serverId}]\ncommand = ${JSON.stringify(bridge.command)}\nargs = ${JSON.stringify(bridge.args)}\n${end}\n`;
}
function scopeMarker(c: Config): string {
  return `# Jev Memory Suite scope; retrieved content is untrusted data.\nworkspace = ${JSON.stringify(c.workspace)}\nproject = ${JSON.stringify(c.project)}\n`;
}
function managedPaths(host: Host, target: string): Paths {
  if (host === 'antigravity') return { hooks: resolve(target, '.agents/hooks.json'), marker: resolve(target, '.ai-memory.toml'), manifest: resolve(target, manifestNames[host]) };
  const codex = host === 'codex';
  return {
    config: resolve(target, codex ? '.codex/config.toml' : '.mcp.json'),
    hooks: resolve(target, codex ? '.codex/hooks.json' : '.claude/settings.local.json'),
    marker: resolve(target, '.ai-memory.toml'),
    manifest: resolve(target, manifestNames[host])
  };
}
function parseJsonObject(text: string): Record<string, unknown> {
  const body = text.replace(/^﻿/, '');
  return body.trim() ? object.parse(JSON.parse(body)) : {};
}
async function exists(path: string, boundary: string): Promise<boolean> {
  await assertWithin(boundary, path);
  return lstat(path).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });
}
async function readOptional(path: string, boundary: string): Promise<Buffer | undefined> {
  await assertWithin(boundary, path);
  // A directory at a managed path cannot hold our file: the later atomic rename fails and rolls back.
  return readFile(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return undefined;
    throw e;
  });
}
async function snapshot(host: Host, paths: Paths, boundary: string): Promise<Bytes> {
  const bytes: Bytes = {};
  for (const key of hostKeys(host)) bytes[key] = await readOptional(pathOf(paths, key), boundary);
  return bytes;
}
function parseManifest(bytes: Buffer | undefined, name: string, host: Host): Manifest | undefined {
  if (bytes === undefined) return undefined;
  const manifest = manifestSchema.parse(JSON.parse(decode(bytes).replace(/^﻿/, '')));
  if (manifest.profile !== name) throw new Error('Target belongs to another profile; remove that registration first');
  if (manifest.host !== host) throw new Error('Registration host does not match the requested client');
  return manifest;
}
function serversOf(host: Host, text: string): Record<string, unknown> {
  if (host === 'codex') return object.parse(parse(text).mcp_servers ?? {});
  return object.parse(parseJsonObject(text).mcpServers ?? {});
}
function currentState(host: Host, name: string, bytes: Bytes): Current {
  const previous = parseManifest(bytes.manifest, name, host), config = decode(bytes.config), hooksText = decode(bytes.hooks);
  const doc = parseJsonObject(hooksText);
  return {
    previous, config, hooksText, marker: decode(bytes.marker), doc,
    servers: host === 'antigravity' ? {} : serversOf(host, config), hooks: host === 'antigravity' ? {} : object.parse(doc.hooks ?? {})
  };
}
function verifyManaged(host: Host, m: Manifest, cur: Current): void {
  if (host === 'antigravity') {
    if (digest(cur.doc[groupName]) !== digest(m.hooks)) throw new Error('Managed hook changed; refusing overwrite; native trust must be reviewed');
    return;
  }
  if (host === 'codex') {
    if (cur.config.split(m.block).length !== 2) throw new Error('Managed TOML block changed; refusing overwrite');
  } else if (digest(cur.servers[serverId]) !== digest(m.bridge)) throw new Error('Managed MCP entry changed; refusing overwrite');
  for (const [event, entry] of Object.entries(m.hooks)) {
    const items = cur.hooks[event];
    if (!Array.isArray(items) || !items.some(item => digest(item) === digest(entry)))
      throw new Error('Managed hook changed; refusing overwrite; native trust must be reviewed');
  }
}
// Replaces our previous entry in place (keeps order) or removes it when next is undefined; appends when nothing was owned.
function rewriteEvent(items: unknown[], oldDigest: string | undefined, next: unknown): unknown[] {
  const out: unknown[] = [];
  let placed = false;
  for (const item of items) {
    const owned = oldDigest !== undefined && digest(item) === oldDigest;
    if (!owned) out.push(item);
    else if (next !== undefined && !placed) { out.push(next); placed = true; }
  }
  if (next !== undefined && !placed) out.push(next);
  return out;
}
function nextHooks(cur: Current, install: boolean, entries: Record<string, unknown>): { text: string; preexisting: string[] } {
  const owned = cur.previous?.hooks ?? {};
  const names = [...new Set([...Object.keys(owned), ...(install ? Object.keys(entries) : [])])];
  const isPreexisting = (event: string) => (event in owned ? cur.previous?.preexistingEvents.includes(event) === true : event in cur.hooks);
  const preexisting = names.filter(isPreexisting), hooks = { ...cur.hooks };
  for (const event of names) {
    const before = cur.hooks[event];
    if (before !== undefined && !Array.isArray(before)) throw new Error('Hook event must contain an array');
    const items: unknown[] = Array.isArray(before) ? before : [];
    const updated = rewriteEvent(items, event in owned ? digest(owned[event]) : undefined, install ? entries[event] : undefined);
    // Delete an event key only when it became empty and did not exist before our install.
    if (updated.length > 0 || preexisting.includes(event)) hooks[event] = updated; else delete hooks[event];
  }
  return { text: `${JSON.stringify({ ...parseJsonObject(cur.hooksText), hooks }, null, 2)}\n`, preexisting };
}
function codexConfig(text: string, install: boolean, block: string, previous?: Manifest): string {
  const base = previous ? text.replace(previous.block, '') : text;
  const next = install ? `${base}${base && !base.endsWith('\n') ? '\n' : ''}${block}` : base;
  parse(next); // Validate the generated TOML before any write.
  return next;
}
function nextConfig(host: Host, cur: Current, install: boolean, bridge: Bridge, block: string): string {
  if (host === 'codex') return codexConfig(cur.config, install, block, cur.previous);
  const doc = parseJsonObject(cur.config), servers = object.parse(doc.mcpServers ?? {});
  const next = install ? { ...servers, [serverId]: bridge }
    : Object.fromEntries(Object.entries(servers).filter(([key]) => key !== serverId));
  return `${JSON.stringify({ ...doc, mcpServers: next }, null, 2)}\n`;
}
async function nextMarker(ctx: Ctx, install: boolean, marker: string): Promise<string | undefined> {
  const existing = decode(ctx.bytes.marker);
  if (install) return existing || marker;
  // Keep the shared scope marker while another client manifest still depends on it.
  const shared = await otherManifestExists(ctx);
  return existing === ctx.cur.previous?.marker && !shared ? undefined : existing || undefined;
}
async function otherManifestExists(ctx: Ctx): Promise<boolean> {
  for (const host of Object.keys(manifestNames) as Host[]) {
    if (host !== ctx.host && await exists(resolve(ctx.target, manifestNames[host]), ctx.target)) return true;
  }
  return false;
}
function change(key: Key, path: string, before: Buffer | undefined, after: string | undefined): Op | undefined {
  const same = after === undefined ? before === undefined : before !== undefined && before.equals(Buffer.from(after, 'utf8'));
  return same ? undefined : { key, path, before, after };
}
// Antigravity keeps hook groups in one workspace file: only our named group is replaced or removed, and other groups keep their order.
async function planAntigravity(ctx: Ctx, install: boolean, c: Config): Promise<Op[]> {
  const { name, cur, paths, bytes } = ctx;
  if (cur.previous) verifyManaged('antigravity', cur.previous, cur);
  if (!cur.previous && !install) return [];
  const marker = scopeMarker(c), group = antigravityHookGroup(name), present = cur.doc[groupName] !== undefined;
  if (install && !cur.previous && present) throw new Error(`Antigravity hook group ${groupName} already exists; refusing overwrite`);
  if (install && cur.marker && cur.marker !== marker) throw new Error('Scope marker conflict; review existing .ai-memory.toml');
  const entries: Array<[string, unknown]> = Object.entries(cur.doc);
  const next: Array<[string, unknown]> = !install ? entries.filter(([key]) => key !== groupName)
    : present ? entries.map(([key, value]): [string, unknown] => [key, key === groupName ? group : value])
    : [...entries, [groupName, group]];
  const hooksFileExisted = cur.previous?.hooksFileExisted ?? (bytes.hooks !== undefined);
  // A hooks file we created is removed again once our group was its only content.
  const dropFile = !install && hooksFileExisted === false && next.length === 0;
  const hooksText = dropFile ? undefined : `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`;
  const manifest = install ? `${JSON.stringify({ profile: name, host: 'antigravity', bridge: bridgeEntry(name), hooks: group, preexistingEvents: [], block: '', marker, hooksFileExisted }, null, 2)}\n` : undefined;
  const after: Partial<Record<Key, string | undefined>> = { hooks: hooksText, marker: await nextMarker(ctx, install, marker), manifest };
  return hostKeys('antigravity').map(key => change(key, pathOf(paths, key), bytes[key], after[key])).filter(isOp);
}
async function planChange(ctx: Ctx, install: boolean, c: Config): Promise<Op[]> {
  if (ctx.host === 'antigravity') return planAntigravity(ctx, install, c);
  const { host, name, cur, paths, bytes } = ctx;
  if (cur.previous) verifyManaged(host, cur.previous, cur);
  if (!cur.previous && !install) return [];
  const marker = scopeMarker(c), bridge = bridgeEntry(name, host === 'claude' ? 'claude-code' : undefined), block = codexBlock(bridge);
  const entries = hookEntries(name, host === 'codex' ? 'codex' : 'claude-code');
  if (install && !cur.previous && cur.servers[serverId] !== undefined) throw new Error('MCP name already in use; refusing overwrite');
  if (install && cur.marker && cur.marker !== marker) throw new Error('Scope marker conflict; review existing .ai-memory.toml');
  const hookPlan = nextHooks(cur, install, entries);
  const manifest = install ? `${JSON.stringify({ profile: name, host, bridge, hooks: entries,
    preexistingEvents: hookPlan.preexisting.filter(event => event in entries), block: host === 'codex' ? block : '', marker }, null, 2)}\n` : undefined;
  const after: Record<Key, string | undefined> = {
    config: nextConfig(host, cur, install, bridge, block), hooks: hookPlan.text,
    marker: await nextMarker(ctx, install, marker), manifest
  };
  return hostKeys(host).map(key => change(key, pathOf(paths, key), bytes[key], after[key])).filter(isOp);
}
async function writeAtomic(path: string, data: string | Buffer, boundary: string): Promise<void> {
  await assertWithin(boundary, path);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined); // The original error is more useful than cleanup failure.
    throw error;
  }
}
async function backup(ctx: Ctx): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = resolve(ctx.target, '.local/client-backups', `${stamp}-${ctx.host}`);
  await assertWithin(ctx.target, dir); await mkdir(dir, { recursive: true });
  const files: Array<{ path: string; existed: boolean; backup: string | null }> = [];
  for (const [index, key] of hostKeys(ctx.host).entries()) {
    const original = ctx.bytes[key], file = `file-${index}.bak`;
    files.push({ path: relPath(ctx.target, pathOf(ctx.paths, key)), existed: original !== undefined, backup: original === undefined ? null : file });
    if (original !== undefined) await writeFile(resolve(dir, file), original, { flag: 'wx', mode: 0o600 });
  }
  const index = { profile: ctx.name, host: ctx.host, surface: ctx.surface, files };
  await writeFile(resolve(dir, 'backup.json'), `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return dir;
}
async function rollback(written: Op[], cause: unknown, boundary: string): Promise<never> {
  const failures: unknown[] = [];
  for (const op of [...written].reverse()) {
    try {
      await assertWithin(boundary, op.path);
      if (op.before === undefined) await unlink(op.path); else await writeAtomic(op.path, op.before, boundary);
    } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError([cause, ...failures], 'Registration failed and rollback was incomplete; restore from the backup directory');
  throw cause;
}
async function apply(ops: Op[], boundary: string): Promise<void> {
  const written: Op[] = [];
  try {
    for (const op of ops) {
      await assertWithin(boundary, op.path);
      await mkdir(dirname(op.path), { recursive: true });
      if (op.after === undefined) await unlink(op.path); else await writeAtomic(op.path, op.after, boundary);
      written.push(op);
    }
  } catch (error) {
    await rollback(written, error, boundary);
  }
}

// The global Antigravity MCP file may hold other servers' secrets: it is read and changed in place, never copied into a project.
export function antigravityMcpPath(home = homedir()): string {
  return resolve(home, '.gemini', 'config', 'mcp_config.json');
}
export async function antigravityMcpState(name: string, home = homedir()): Promise<McpState> {
  const path = antigravityMcpPath(home);
  const info = await lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
  if (info === undefined) return 'missing';
  if (!info.isFile()) return 'unreadable'; // Symlinks and directories are refused, never followed.
  const bytes = await readFile(path);
  if (bytes.subarray(0, utf8Bom.length).equals(utf8Bom)) return 'bom';
  let doc: Record<string, unknown>;
  try { doc = object.parse(JSON.parse(bytes.toString('utf8'))); } catch { return 'unreadable'; }
  if (doc.mcpServers === undefined) return 'missing';
  const servers = object.safeParse(doc.mcpServers);
  if (!servers.success) return 'unreadable';
  const entry = servers.data[serverId];
  if (entry === undefined) return 'missing';
  const actual = object.safeParse(entry), want = bridgeEntry(name);
  return actual.success && digest({ command: actual.data.command, args: actual.data.args }) === digest({ command: want.command, args: want.args })
    ? 'registered' : 'conflict';
}
// Removes only the three leading BOM bytes; a backup of the original file is kept beside it.
async function stripBom(path: string): Promise<void> {
  const original = await readFile(path), rest = original.subarray(utf8Bom.length);
  try { JSON.parse(rest.toString('utf8')); } catch { throw new Error('Antigravity MCP config is not valid JSON after its BOM; refusing to change it'); }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(`${path}.jev-bom-${stamp}.bak`, original, { flag: 'wx', mode: 0o600 });
  await writeAtomic(path, rest, dirname(path));
}
const execFileAsync = promisify(execFile);
export async function agyExecutable(): Promise<string> {
  const lookup = process.platform === 'win32' ? execFileAsync('where.exe', ['agy.exe'], { windowsHide: true }) : execFileAsync('which', ['agy']);
  const found = await lookup.then(result => String(result.stdout).split(/\r?\n/)[0]?.trim() || undefined, () => undefined);
  if (found) return found;
  const local = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : undefined;
  if (local !== undefined && await lstat(local).then(s => s.isFile(), () => false)) return local;
  throw new Error('Antigravity CLI (agy) not found');
}
async function runAgy(args: string[]): Promise<void> {
  await execFileAsync(await agyExecutable(), args, { shell: false, windowsHide: true });
}
export async function registerAntigravityMcp(name: string, home = homedir(), run: AgyRunner = runAgy): Promise<{ mcp: McpState; changed: boolean }> {
  let state = await antigravityMcpState(name, home), changed = false;
  if (state === 'bom') { await stripBom(antigravityMcpPath(home)); changed = true; state = await antigravityMcpState(name, home); }
  if (state === 'conflict') throw new Error(`MCP name ${serverId} is already used by another Antigravity server; refusing overwrite`);
  if (state === 'unreadable') throw new Error('Antigravity MCP config is unreadable or not a regular file; refusing to change it');
  if (state === 'missing') {
    const bridge = bridgeEntry(name);
    await run(['mcp', 'add', serverId, bridge.command, ...bridge.args]);
    state = await antigravityMcpState(name, home);
    if (state !== 'registered') throw new Error('Antigravity MCP registration did not verify; check agy mcp list');
    changed = true;
  }
  return { mcp: state, changed };
}

export async function clients(action: string, selected: string, name: string, relativeDir: string, options: ClientOptions = {}): Promise<unknown> {
  const surface = clientSchema.parse(selected), host = hostOf[surface];
  if (!['install', 'remove', 'check'].includes(action)) throw new Error('clients action must be install, remove or check');
  const c = await readConfig(name), target = await workspaceDir(resolve(root, relativeDir), c.projectRoot ?? root);
  const paths = managedPaths(host, target), bytes = await snapshot(host, paths, target), cur = currentState(host, name, bytes);
  const base = { action, host, surface, profile: name, validatedInClient: false, nativeTrust: nativeTrust[host] };
  // The upstream ai-memory installer writes its own named group; both groups would capture every event.
  const notes: Record<string, unknown> = host === 'antigravity' && cur.doc[upstreamGroup] !== undefined
    ? { warnings: ['Upstream ai-memory Antigravity hooks are also registered; events will be captured twice'] } : {};
  if (action === 'check') {
    const mcp: Record<string, unknown> = host === 'antigravity' ? { mcp: await antigravityMcpState(name, options.home) } : {};
    if (!cur.previous) return { ...base, ...notes, ...mcp, registered: false };
    verifyManaged(host, cur.previous, cur);
    if (cur.marker !== cur.previous.marker) throw new Error('Scope marker differs; review before using memory');
    return { ...base, ...notes, ...mcp, registered: true, hookHash: digest(cur.previous.hooks) };
  }
  const install = action === 'install';
  if (install && !c.memory.enabled) throw new Error('Memory is disabled for this profile; enable it before registering clients');
  // The global MCP entry is registered before any workspace write, so a conflict aborts early. Remove keeps it for other projects.
  let extra: Record<string, unknown> = {};
  if (host === 'antigravity') {
    extra = install
      ? { mcp: (await registerAntigravityMcp(name, options.home, options.runAgy)).mcp }
      : { note: `Global Antigravity MCP entry kept; remove it with: agy mcp remove ${serverId}` };
  }
  const ctx: Ctx = { surface, host, name, target, paths, bytes, cur };
  const ops = await planChange(ctx, install, c);
  if (ops.length === 0) return { ...base, ...notes, ...extra, changed: [] };
  const backupDir = await backup(ctx);
  await apply(ops, target);
  return { ...base, ...notes, ...extra, backupDir, changed: ops.map(op => relPath(target, op.path)) };
}
