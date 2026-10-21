import { createHash, randomBytes } from 'node:crypto';
import { mkdir, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { assertLocal, readConfig, root, type Config } from './config.js';
import { events } from './hook.js';

const clientSchema = z.enum(['claude', 'codex', 'desktop']);
const object = z.record(z.string(), z.unknown());
export const serverId = 'jev_memory_suite';
const begin = '# jev-memory-suite:start', end = '# jev-memory-suite:end';
const keys = ['config', 'hooks', 'marker', 'manifest'] as const; // Manifest is always written last.
const manifestNames: Record<Host, string> = { claude: '.jev-memory-claude.json', codex: '.jev-memory-codex.json' };
const nativeTrust: Record<Host, string> = {
  claude: 'requires project MCP approval in actual Claude host',
  codex: 'requires /hooks review in actual Codex host'
};
const manifestSchema = z.strictObject({ profile: z.string(), host: z.enum(['claude', 'codex']), bridge: object, hooks: object,
  preexistingEvents: z.array(z.string()), block: z.string(), marker: z.string() });
type Host = 'claude' | 'codex';
type Manifest = z.infer<typeof manifestSchema>;
type Key = typeof keys[number];
type Paths = Record<Key, string>;
type Bytes = Record<Key, Buffer | undefined>;
type Bridge = { command: string; args: string[] };
interface Op { key: Key; path: string; before: Buffer | undefined; after: string | undefined }
interface Current { previous: Manifest | undefined; config: string; hooksText: string; hooks: Record<string, unknown>; servers: Record<string, unknown>; marker: string }
interface Ctx { surface: string; host: Host; name: string; target: string; paths: Paths; bytes: Bytes; cur: Current }

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const decode = (bytes: Buffer | undefined): string => bytes?.toString('utf8') ?? '';
const relPath = (target: string, path: string): string => relative(target, path).split(sep).join('/');
const isOp = (op: Op | undefined): op is Op => op !== undefined;
const quote = (s: string): string => {
  if (/["%!\r\n`$]/.test(s)) throw new Error('Executable path cannot be safely quoted for native hook host');
  return `"${s}"`;
};

export function bridgeEntry(name: string): Bridge {
  return { command: process.execPath, args: [resolve(root, 'dist/src/bridge.js'), name] };
}
export function hookEntries(name: string, agent: 'claude-code' | 'codex'): Record<string, unknown> {
  return Object.fromEntries(Object.entries(events).map(([event, native]) => {
    const argv = [process.execPath, resolve(root, 'dist/src/hook.js'), name, agent, native];
    return [event, { matcher: '', hooks: [{ type: 'command', command: argv.map(quote).join(' '), timeout: 25 }] }];
  }));
}
function codexBlock(bridge: Bridge): string {
  return `${begin}\n[mcp_servers.${serverId}]\ncommand = ${JSON.stringify(bridge.command)}\nargs = ${JSON.stringify(bridge.args)}\n${end}\n`;
}
function scopeMarker(c: Config): string {
  return `# Jev Memory Suite scope; retrieved content is untrusted data.\nworkspace = ${JSON.stringify(c.workspace)}\nproject = ${JSON.stringify(c.project)}\n`;
}
function managedPaths(host: Host, target: string): Paths {
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
async function exists(path: string): Promise<boolean> {
  await assertLocal(path);
  return lstat(path).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });
}
async function readOptional(path: string): Promise<Buffer | undefined> {
  await assertLocal(path);
  // A directory at a managed path cannot hold our file: the later atomic rename fails and rolls back.
  return readFile(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return undefined;
    throw e;
  });
}
async function snapshot(paths: Paths): Promise<Bytes> {
  const bytes = {} as Bytes;
  for (const key of keys) bytes[key] = await readOptional(paths[key]);
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
  const config = decode(bytes.config), hooksText = decode(bytes.hooks);
  return {
    previous: parseManifest(bytes.manifest, name, host), config, hooksText, marker: decode(bytes.marker),
    servers: serversOf(host, config), hooks: object.parse(parseJsonObject(hooksText).hooks ?? {})
  };
}
function verifyManaged(host: Host, m: Manifest, cur: Current): void {
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
    if (host !== ctx.host && await exists(resolve(ctx.target, manifestNames[host]))) return true;
  }
  return false;
}
function change(key: Key, path: string, before: Buffer | undefined, after: string | undefined): Op | undefined {
  const same = after === undefined ? before === undefined : before !== undefined && before.equals(Buffer.from(after, 'utf8'));
  return same ? undefined : { key, path, before, after };
}
async function planChange(ctx: Ctx, install: boolean, c: Config): Promise<Op[]> {
  const { host, name, cur, paths, bytes } = ctx;
  if (cur.previous) verifyManaged(host, cur.previous, cur);
  if (!cur.previous && !install) return [];
  const marker = scopeMarker(c), bridge = bridgeEntry(name), block = codexBlock(bridge);
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
  return keys.map(key => change(key, paths[key], bytes[key], after[key])).filter(isOp);
}
async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  await assertLocal(path);
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
  await assertLocal(dir); await mkdir(dir, { recursive: true });
  const files: Array<{ path: string; existed: boolean; backup: string | null }> = [];
  for (const [index, key] of keys.entries()) {
    const original = ctx.bytes[key], file = `file-${index}.bak`;
    files.push({ path: relPath(ctx.target, ctx.paths[key]), existed: original !== undefined, backup: original === undefined ? null : file });
    if (original !== undefined) await writeFile(resolve(dir, file), original, { flag: 'wx', mode: 0o600 });
  }
  const index = { profile: ctx.name, host: ctx.host, surface: ctx.surface, files };
  await writeFile(resolve(dir, 'backup.json'), `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return dir;
}
async function rollback(written: Op[], cause: unknown): Promise<never> {
  const failures: unknown[] = [];
  for (const op of [...written].reverse()) {
    try {
      if (op.before === undefined) await unlink(op.path); else await writeAtomic(op.path, op.before);
    } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError([cause, ...failures], 'Registration failed and rollback was incomplete; restore from the backup directory');
  throw cause;
}
async function apply(ops: Op[]): Promise<void> {
  const written: Op[] = [];
  try {
    for (const op of ops) {
      await mkdir(dirname(op.path), { recursive: true });
      if (op.after === undefined) await unlink(op.path); else await writeAtomic(op.path, op.after);
      written.push(op);
    }
  } catch (error) {
    await rollback(written, error);
  }
}

export async function clients(action: string, selected: string, name: string, relativeDir: string): Promise<unknown> {
  const surface = clientSchema.parse(selected), host: Host = surface === 'claude' ? 'claude' : 'codex';
  if (!['install', 'remove', 'check'].includes(action)) throw new Error('clients action must be install, remove or check');
  const c = await readConfig(name), target = resolve(root, relativeDir);
  if (target !== root) await assertLocal(target);
  const paths = managedPaths(host, target), bytes = await snapshot(paths), cur = currentState(host, name, bytes);
  const base = { action, host, surface, profile: name, validatedInClient: false, nativeTrust: nativeTrust[host] };
  if (action === 'check') {
    if (!cur.previous) return { ...base, registered: false };
    verifyManaged(host, cur.previous, cur);
    if (cur.marker !== cur.previous.marker) throw new Error('Scope marker differs; review before using memory');
    return { ...base, registered: true, hookHash: digest(cur.previous.hooks) };
  }
  const install = action === 'install';
  if (install && !c.memory.enabled) throw new Error('Memory is disabled for this profile; enable it before registering clients');
  const ctx: Ctx = { surface, host, name, target, paths, bytes, cur };
  const ops = await planChange(ctx, install, c);
  if (ops.length === 0) return { ...base, changed: [] };
  const backupDir = await backup(ctx);
  await apply(ops);
  return { ...base, backupDir, changed: ops.map(op => relPath(target, op.path)) };
}
