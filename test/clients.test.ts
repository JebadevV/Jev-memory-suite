import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { profileDir, root } from '../src/config.js';
import { antigravityHookGroup, antigravityMcpPath, antigravityMcpState, bridgeEntry, clients, hookEntries, registerAntigravityMcp, serverId, shortPath, type AgyRunner } from '../src/clients.js';
import { init } from '../src/lifecycle.js';

interface Report { action: string; host: string; surface: string; profile: string; registered?: boolean; backupDir?: string; changed?: string[]; mcp?: string; note?: string; warnings?: string[]; hookHash?: string }

async function profile(t: TestContext): Promise<string> {
  const name = `clients-${Date.now()}-${randomBytes(3).toString('hex')}`;
  await init(name);
  t.after(() => rm(profileDir(name), { recursive: true, force: true }));
  return name;
}
async function workspace(t: TestContext): Promise<{ dir: string; target: string }> {
  await mkdir(resolve(root, '.local'), { recursive: true });
  const dir = await mkdtemp(resolve(root, '.local/client-test-')), target = relative(root, dir);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, target };
}
async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

test('registration preserves unrelated MCP servers/settings/hooks, is idempotent and removes only owned entries', async t => {
  const { dir, target } = await workspace(t), name = await profile(t);
  await mkdir(resolve(dir, '.claude')); await mkdir(resolve(dir, '.codex'));
  const other = { command: 'unrelated-server', args: ['--existing'] };
  const hook = { matcher: '', hooks: [{ type: 'command', command: 'existing-hook' }] };
  await writeFile(resolve(dir, '.mcp.json'), JSON.stringify({ unrelated: true, mcpServers: { other } }));
  await writeFile(resolve(dir, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { SessionStart: [hook] } }));
  await writeFile(resolve(dir, '.codex/config.toml'), '# existing comment\nmodel = "existing"\n[mcp_servers.other]\ncommand = "other"\n');
  for (const client of ['claude', 'codex']) {
    await clients('install', client, name, target);
    await clients('install', client, name, target);
    assert.equal((await clients('check', client, name, target) as Report).registered, true);
    await clients('remove', client, name, target);
  }
  const doc = JSON.parse(await readFile(resolve(dir, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown>; unrelated: boolean };
  assert.deepEqual(doc.mcpServers, { other }); assert.equal(doc.unrelated, true);
  const settings = JSON.parse(await readFile(resolve(dir, '.claude/settings.local.json'), 'utf8')) as { permissions: unknown; hooks: { SessionStart: unknown[] } };
  assert.deepEqual(settings.permissions, { allow: ['Read'] }); assert.deepEqual(settings.hooks.SessionStart, [hook]);
  const toml = await readFile(resolve(dir, '.codex/config.toml'), 'utf8');
  assert.ok(toml.startsWith('# existing comment')); assert.deepEqual(JSON.parse(JSON.stringify(parse(toml).mcp_servers)), { other: { command: 'other' } });
});

test('second install reports no changes and writes no backup', async t => {
  const { target } = await workspace(t), name = await profile(t);
  await clients('install', 'claude', name, target);
  const second = await clients('install', 'claude', name, target) as Report;
  assert.deepEqual(second.changed, []);
  assert.equal(second.backupDir, undefined);
});

test('check on an unregistered target is read-only and reports not registered', async t => {
  const { dir, target } = await workspace(t), name = await profile(t);
  const state = await clients('check', 'codex', name, target) as Report;
  assert.equal(state.registered, false);
  assert.equal(await exists(resolve(dir, '.codex/config.toml')), false);
  assert.equal(await exists(resolve(dir, '.local')), false);
});

test('remove rejects a tampered managed entry instead of overwriting it', async t => {
  const { dir, target } = await workspace(t), name = await profile(t);
  await clients('install', 'codex', name, target);
  const path = resolve(dir, '.codex/config.toml');
  await writeFile(path, (await readFile(path, 'utf8')).replace('bridge.js', 'tampered.js'));
  await assert.rejects(clients('remove', 'codex', name, target), /changed/);
});

test('another profile cannot remove or overwrite an existing registration', async t => {
  const { target } = await workspace(t), name = await profile(t), other = await profile(t);
  await clients('install', 'codex', name, target);
  await assert.rejects(clients('remove', 'codex', other, target), /another profile/);
  await assert.rejects(clients('install', 'codex', other, target), /another profile/);
});

test('desktop surface writes the Codex files and reports the desktop surface', async t => {
  const { dir, target } = await workspace(t), name = await profile(t);
  const result = await clients('install', 'desktop', name, target) as Report;
  assert.equal(result.host, 'codex');
  assert.equal(result.surface, 'desktop');
  const manifest = JSON.parse(await readFile(resolve(dir, '.jev-memory-codex.json'), 'utf8')) as { host: string };
  assert.equal(manifest.host, 'codex');
  assert.match(await readFile(resolve(dir, '.codex/config.toml'), 'utf8'), /jev-memory-suite:start/);
});

test('install refuses non-array hook events before writing any file', async t => {
  const { dir, target } = await workspace(t), name = await profile(t);
  await mkdir(resolve(dir, '.claude'));
  const original = JSON.stringify({ hooks: { PreToolUse: {} } });
  await writeFile(resolve(dir, '.claude/settings.local.json'), original);
  await assert.rejects(clients('install', 'claude', name, target), /must contain an array/);
  assert.equal(await readFile(resolve(dir, '.claude/settings.local.json'), 'utf8'), original);
  assert.equal(await exists(resolve(dir, '.mcp.json')), false);
});

test('rollback restores every written file when the final manifest write fails', async t => {
  const { dir, target } = await workspace(t), name = await profile(t);
  await mkdir(resolve(dir, '.claude'));
  const mcp = JSON.stringify({ mcpServers: { other: { command: 'other' } } }) + '\n';
  const settings = JSON.stringify({ permissions: { allow: ['Read'] } }) + '\n';
  await writeFile(resolve(dir, '.mcp.json'), mcp);
  await writeFile(resolve(dir, '.claude/settings.local.json'), settings);
  await mkdir(resolve(dir, '.jev-memory-claude.json')); // Makes the last manifest rename fail.
  await assert.rejects(clients('install', 'claude', name, target), (error: NodeJS.ErrnoException) => ['EPERM', 'EISDIR', 'EACCES'].includes(error.code ?? ''));
  assert.equal(await readFile(resolve(dir, '.mcp.json'), 'utf8'), mcp);
  assert.equal(await readFile(resolve(dir, '.claude/settings.local.json'), 'utf8'), settings);
  assert.equal(await exists(resolve(dir, '.ai-memory.toml')), false);
});

const newEvents = ['PreCompact', 'Stop', 'SubagentStart', 'SubagentStop'];
type HookGroup = { matcher: string; hooks: Array<{ command: string }> };
test('hookEntries registers nine events for Claude Code and seven for Codex with native command names', () => {
  const claude = hookEntries('p', 'claude-code'), codex = hookEntries('p', 'codex');
  assert.equal(Object.keys(claude).length, 9);
  assert.equal(Object.keys(codex).length, 7);
  for (const event of newEvents) assert.ok(event in claude, event);
  for (const event of newEvents.filter(e => !e.startsWith('Subagent'))) assert.ok(event in codex, event);
  assert.equal('SubagentStart' in codex, false);
  assert.equal('SubagentStop' in codex, false);
  const commandOf = (entries: Record<string, unknown>, event: string) => (entries[event] as HookGroup).hooks[0]!.command;
  assert.match(commandOf(claude, 'PreCompact'), /"p" "claude-code" "pre-compact"$/);
  assert.match(commandOf(claude, 'Stop'), /"p" "claude-code" "stop"$/);
  assert.match(commandOf(claude, 'SubagentStart'), /"p" "claude-code" "subagent-start"$/);
  assert.match(commandOf(claude, 'SubagentStop'), /"p" "claude-code" "subagent-stop"$/);
  assert.match(commandOf(codex, 'Stop'), /"p" "codex" "stop"$/);
});
test('claude registration keeps third-party Stop hooks ahead of ours and removes only ours', async t => {
  const { dir, target } = await workspace(t), name = await profile(t);
  await mkdir(resolve(dir, '.claude'));
  const hook = { matcher: '', hooks: [{ type: 'command', command: 'third-party-stop' }] };
  await writeFile(resolve(dir, '.claude/settings.local.json'), JSON.stringify({ hooks: { Stop: [hook] } }));
  await clients('install', 'claude', name, target);
  const installed = JSON.parse(await readFile(resolve(dir, '.claude/settings.local.json'), 'utf8')) as { hooks: { Stop: unknown[] } };
  assert.equal(installed.hooks.Stop.length, 2);
  assert.deepEqual(installed.hooks.Stop[0], hook);
  await clients('remove', 'claude', name, target);
  const removed = JSON.parse(await readFile(resolve(dir, '.claude/settings.local.json'), 'utf8')) as { hooks: { Stop: unknown[] } };
  assert.deepEqual(removed.hooks.Stop, [hook]);
});
test('codex registration writes only the seven events Codex supports', async t => {
  const { dir, target } = await workspace(t), name = await profile(t);
  await clients('install', 'codex', name, target);
  const hooks = JSON.parse(await readFile(resolve(dir, '.codex/hooks.json'), 'utf8')) as { hooks: Record<string, unknown> };
  assert.equal(Object.keys(hooks.hooks).length, 7);
  assert.equal('SubagentStart' in hooks.hooks, false);
  assert.equal('SubagentStop' in hooks.hooks, false);
});
test('reinstall over a five-event Claude manifest adds the four new events without duplicating entries', async t => {
  const { dir, target } = await workspace(t), name = await profile(t);
  await clients('install', 'claude', name, target);
  // Rewrites the registration as the original five-event install left it.
  const manifestPath = resolve(dir, '.jev-memory-claude.json'), settingsPath = resolve(dir, '.claude/settings.local.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { hooks: Record<string, unknown> };
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { hooks: Record<string, unknown> };
  for (const event of newEvents) { delete manifest.hooks[event]; delete settings.hooks[event]; }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  const reinstall = await clients('install', 'claude', name, target) as Report;
  assert.ok(reinstall.changed?.length);
  const after = JSON.parse(await readFile(settingsPath, 'utf8')) as { hooks: Record<string, unknown[]> };
  const afterManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { hooks: Record<string, unknown> };
  assert.equal(Object.keys(afterManifest.hooks).length, 9);
  assert.equal(Object.keys(after.hooks).length, 9);
  for (const event of Object.keys(after.hooks)) assert.equal(after.hooks[event]!.length, 1, event);
  assert.equal((await clients('check', 'claude', name, target) as Report).registered, true);
  assert.deepEqual((await clients('install', 'claude', name, target) as Report).changed, []);
});

test('bridgeEntry adds the claude-code agent only when asked', () => {
  const claude = bridgeEntry('p', 'claude-code'), codex = bridgeEntry('p');
  assert.equal(claude.args[0], codex.args[0]);
  assert.deepEqual(claude.args.slice(1), ['p', 'claude-code']);
  assert.deepEqual(codex.args.slice(1), ['p']);
});
test('claude registration records the session-aware bridge args in its manifest', async t => {
  const { dir, target } = await workspace(t), name = await profile(t);
  await clients('install', 'claude', name, target);
  const manifest = JSON.parse(await readFile(resolve(dir, '.jev-memory-claude.json'), 'utf8')) as { bridge: { args: string[] } };
  assert.deepEqual(manifest.bridge.args.slice(1), [name, 'claude-code']);
});
test('scope marker is removed with the last registration and kept while another remains', async t => {
  const { dir, target } = await workspace(t), name = await profile(t);
  const marker = resolve(dir, '.ai-memory.toml');
  await clients('install', 'claude', name, target);
  await clients('install', 'codex', name, target);
  await clients('remove', 'claude', name, target);
  assert.equal(await exists(marker), true);
  await clients('remove', 'codex', name, target);
  assert.equal(await exists(marker), false);
});

test('codex hook commands on win32 use the PowerShell call operator with quoted argv', () => {
  const codex = hookEntries('p', 'codex', 'win32');
  const command = (entries: Record<string, unknown>, event: string) => (entries[event] as HookGroup).hooks[0]!.command;
  for (const event of ['Stop', 'SessionStart']) {
    const line = command(codex, event);
    assert.match(line, /^& "[^"]*node[^"]*" "[^"]*hook\.js" "p" "codex" "[^"]+"$/, event);
  }
  assert.match(command(codex, 'Stop'), /"p" "codex" "stop"$/);
});
test('codex hook commands off Windows keep the bare quoted form', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const codex = hookEntries('p', 'codex', platform);
    assert.doesNotMatch(command(codex, 'Stop'), /^& /, platform);
    assert.match(command(codex, 'Stop'), /^"[^"]*" "[^"]*hook\.js" "p" "codex" "stop"$/, platform);
  }
});
// Codex runs hook commands through powershell.exe on Windows: the real generated line must reach hook.js, not fail to parse.
test('codex Stop hook on win32 runs through powershell.exe and reaches hook.js', { skip: process.platform !== 'win32' }, async t => {
  const hookJs = resolve(root, 'dist/src/hook.js');
  assert.ok(existsSync(hookJs), `${hookJs} is missing; run npm run build before this test`);
  const name = await profile(t);
  const line = command(hookEntries(name, 'codex', 'win32'), 'Stop');
  const bogus = line.replace(/"[^"]*"$/, '"bogus-event"'); // Only the final event argument changes.
  assert.notEqual(bogus, line);
  const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', bogus], { input: '{}', encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /Suite hook rejected or unavailable/);
  assert.doesNotMatch(run.stderr, /ParserError|não é reconhecido|is not recognized|Unexpected token/);
});
test('claude hook commands keep the bare quoted form on win32', () => {
  const claude = hookEntries('p', 'claude-code', 'win32');
  assert.doesNotMatch(command(claude, 'Stop'), /^& /);
  assert.match(command(claude, 'Stop'), /^"[^"]*" "[^"]*hook\.js" "p" "claude-code" "stop"$/);
});
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const suiteGroup = 'jev-memory-suite', hooksRel = '.agents/hooks.json';
type Handler = { type: string; command: string; timeout: number };
type ToolGroup = { matcher: string; hooks: Handler[] };
type McpDoc = { mcpServers?: Record<string, unknown> };
async function fakeHome(t: TestContext): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), 'clients-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
// Stands in for `agy mcp add`: records the argv and writes the entry the real CLI would write.
function fakeAgy(home: string, calls: string[][] = []): AgyRunner {
  return async args => {
    calls.push(args);
    const [id = '', cmd = '', ...rest] = args.slice(2);
    await mkdir(resolve(home, '.gemini/config'), { recursive: true });
    const doc = await readFile(antigravityMcpPath(home), 'utf8').then(text => JSON.parse(text) as McpDoc, (): McpDoc => ({}));
    await writeFile(antigravityMcpPath(home), `${JSON.stringify({ ...doc, mcpServers: { ...doc.mcpServers, [id]: { command: cmd, args: rest } } }, null, 2)}\n`);
  };
}
async function writeHooks(dir: string, body: string | Buffer): Promise<void> {
  await mkdir(resolve(dir, '.agents'), { recursive: true });
  await writeFile(resolve(dir, hooksRel), body);
}

test('antigravity install writes one workspace hook group and registers the global MCP entry', async t => {
  const { dir, target } = await workspace(t), name = await profile(t), home = await fakeHome(t), calls: string[][] = [];
  const result = await clients('install', 'antigravity', name, target, { home, runAgy: fakeAgy(home, calls) }) as Report;
  assert.equal(result.host, 'antigravity');
  assert.equal(result.surface, 'antigravity');
  assert.equal(result.mcp, 'registered');
  assert.deepEqual(calls, [['mcp', 'add', serverId, process.execPath, resolve(root, 'dist/src/bridge.js'), name]]);
  const hooks = JSON.parse(await readFile(resolve(dir, hooksRel), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(hooks, { [suiteGroup]: antigravityHookGroup(name) });
  const group = hooks[suiteGroup] as { PreInvocation: Handler[]; PreToolUse: ToolGroup[]; PostToolUse: ToolGroup[]; Stop: Handler[] };
  assert.deepEqual(Object.keys(group), ['PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
  assert.deepEqual(group.PreInvocation.map(h => [h.type, h.timeout]), [['command', 25]]); // Lifecycle events hold flat handlers.
  assert.match(group.PreInvocation[0]!.command, / antigravity-cli session-start$/);
  assert.deepEqual(group.PreToolUse.map(g => g.matcher), ['']); // Tool events nest handlers under matcher groups.
  assert.match(group.PreToolUse[0]!.hooks[0]!.command, / antigravity-cli pre-tool-use$/);
  assert.match(group.PostToolUse[0]!.hooks[0]!.command, / antigravity-cli post-tool-use$/);
  assert.match(group.Stop[0]!.command, / antigravity-cli stop$/);
  assert.equal(await exists(resolve(dir, '.mcp.json')), false);
  assert.equal(await exists(resolve(dir, '.codex')), false);
  assert.equal(await exists(resolve(dir, '.claude')), false);
  const mcp = JSON.parse(await readFile(antigravityMcpPath(home), 'utf8')) as McpDoc;
  assert.deepEqual(mcp.mcpServers?.[serverId], bridgeEntry(name));
});

test('antigravity install keeps unrelated hook groups in order and remove restores the file exactly', async t => {
  const { dir, target } = await workspace(t), name = await profile(t), home = await fakeHome(t), runAgy = fakeAgy(home);
  const original = `${JSON.stringify({ 'zz-team': { Stop: [{ type: 'command', command: 'team-stop', timeout: 5 }] }, 'aa-lint': { enabled: true } }, null, 2)}\n`;
  await writeHooks(dir, original);
  await clients('install', 'antigravity', name, target, { home, runAgy });
  const installed = JSON.parse(await readFile(resolve(dir, hooksRel), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(installed), ['zz-team', 'aa-lint', suiteGroup]);
  assert.deepEqual(installed['zz-team'], { Stop: [{ type: 'command', command: 'team-stop', timeout: 5 }] });
  const removed = await clients('remove', 'antigravity', name, target, { home, runAgy }) as Report;
  assert.equal(await readFile(resolve(dir, hooksRel), 'utf8'), original);
  assert.match(removed.note ?? '', /agy mcp remove jev_memory_suite/);
  assert.equal((await clients('check', 'antigravity', name, target, { home }) as Report).registered, false);
});

test('antigravity hooks file with a UTF-8 BOM is parsed and rewritten without the BOM', async t => {
  const { dir, target } = await workspace(t), name = await profile(t), home = await fakeHome(t);
  await writeHooks(dir, Buffer.concat([bom, Buffer.from(JSON.stringify({ 'zz-team': {} }))]));
  await clients('install', 'antigravity', name, target, { home, runAgy: fakeAgy(home) });
  const raw = await readFile(resolve(dir, hooksRel));
  assert.equal(raw.subarray(0, bom.length).equals(bom), false);
  assert.deepEqual(Object.keys(JSON.parse(raw.toString('utf8')) as object), ['zz-team', suiteGroup]);
});

test('antigravity second install is a no-op and does not spawn agy again', async t => {
  const { target } = await workspace(t), name = await profile(t), home = await fakeHome(t), calls: string[][] = [], runAgy = fakeAgy(home, calls);
  await clients('install', 'antigravity', name, target, { home, runAgy });
  const second = await clients('install', 'antigravity', name, target, { home, runAgy }) as Report;
  assert.deepEqual(second.changed, []);
  assert.equal(second.backupDir, undefined);
  assert.equal(second.mcp, 'registered');
  assert.equal(calls.length, 1);
});

test('antigravity edited group blocks both install and remove', async t => {
  const { dir, target } = await workspace(t), name = await profile(t), home = await fakeHome(t), runAgy = fakeAgy(home);
  await clients('install', 'antigravity', name, target, { home, runAgy });
  const path = resolve(dir, hooksRel), tampered = (await readFile(path, 'utf8')).replace('antigravity-cli stop', 'antigravity-cli stop-tampered');
  await writeFile(path, tampered);
  await assert.rejects(clients('install', 'antigravity', name, target, { home, runAgy }), /Managed hook changed/);
  await assert.rejects(clients('remove', 'antigravity', name, target, { home, runAgy }), /Managed hook changed/);
  assert.equal(await readFile(path, 'utf8'), tampered);
});

test('antigravity refuses a foreign jev-memory-suite group without a manifest', async t => {
  const { dir, target } = await workspace(t), name = await profile(t), home = await fakeHome(t);
  const original = `${JSON.stringify({ [suiteGroup]: { Stop: [{ type: 'command', command: 'someone-else', timeout: 5 }] } }, null, 2)}\n`;
  await writeHooks(dir, original);
  await assert.rejects(clients('install', 'antigravity', name, target, { home, runAgy: fakeAgy(home) }), /already exists; refusing overwrite/);
  assert.equal(await readFile(resolve(dir, hooksRel), 'utf8'), original);
  assert.equal(await exists(resolve(dir, '.jev-memory-antigravity.json')), false);
});

test('antigravity remove deletes the hooks file only when install created it', async t => {
  const { dir, target } = await workspace(t), name = await profile(t), home = await fakeHome(t), runAgy = fakeAgy(home);
  await clients('install', 'antigravity', name, target, { home, runAgy });
  await clients('remove', 'antigravity', name, target, { home, runAgy });
  assert.equal(await exists(resolve(dir, hooksRel)), false);
  assert.equal(await exists(resolve(dir, '.jev-memory-antigravity.json')), false);
  await writeHooks(dir, '{}\n');
  await clients('install', 'antigravity', name, target, { home, runAgy });
  await clients('remove', 'antigravity', name, target, { home, runAgy });
  assert.equal(await readFile(resolve(dir, hooksRel), 'utf8'), '{}\n');
});

test('antigravity rollback restores the workspace hooks file when the manifest write fails', async t => {
  const { dir, target } = await workspace(t), name = await profile(t), home = await fakeHome(t);
  const original = `${JSON.stringify({ 'zz-team': { Stop: [] } }, null, 2)}\n`;
  await writeHooks(dir, original);
  await mkdir(resolve(dir, '.jev-memory-antigravity.json')); // Makes the last manifest rename fail.
  await assert.rejects(clients('install', 'antigravity', name, target, { home, runAgy: fakeAgy(home) }), (error: NodeJS.ErrnoException) => ['EPERM', 'EISDIR', 'EACCES'].includes(error.code ?? ''));
  assert.equal(await readFile(resolve(dir, hooksRel), 'utf8'), original);
  assert.equal(await exists(resolve(dir, '.ai-memory.toml')), false);
});

test('antigravity warns when upstream ai-memory hooks are also registered', async t => {
  const { dir, target } = await workspace(t), name = await profile(t), home = await fakeHome(t), runAgy = fakeAgy(home);
  await writeHooks(dir, JSON.stringify({ 'ai-memory': { Stop: [{ type: 'command', command: 'ai-memory-stop', timeout: 5 }] } }));
  const installed = await clients('install', 'antigravity', name, target, { home, runAgy }) as Report;
  assert.match(installed.warnings?.[0] ?? '', /Upstream ai-memory Antigravity hooks are also registered/);
  const checked = await clients('check', 'antigravity', name, target, { home, runAgy }) as Report;
  assert.equal(checked.warnings?.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(resolve(dir, hooksRel), 'utf8')) as object), ['ai-memory', suiteGroup]);
});

test('antigravity check reports MCP state and fails on drift', async t => {
  const { dir, target } = await workspace(t), name = await profile(t), home = await fakeHome(t), runAgy = fakeAgy(home);
  const before = await clients('check', 'antigravity', name, target, { home }) as Report;
  assert.equal(before.registered, false);
  assert.equal(before.mcp, 'missing');
  await clients('install', 'antigravity', name, target, { home, runAgy });
  const after = await clients('check', 'antigravity', name, target, { home }) as Report;
  assert.equal(after.registered, true);
  assert.equal(after.mcp, 'registered');
  assert.match(after.hookHash ?? '', /^[0-9a-f]{64}$/);
  const path = resolve(dir, hooksRel);
  await writeFile(path, (await readFile(path, 'utf8')).replace('antigravity-cli pre-tool-use', 'antigravity-cli pre-tool-use-x'));
  await assert.rejects(clients('check', 'antigravity', name, target, { home }), /Managed hook changed/);
});

test('antigravity install aborts before writing workspace files on an MCP conflict', async t => {
  const { dir, target } = await workspace(t), name = await profile(t), home = await fakeHome(t);
  await mkdir(resolve(home, '.gemini/config'), { recursive: true });
  await writeFile(antigravityMcpPath(home), JSON.stringify({ mcpServers: { [serverId]: { command: 'other', args: [] } } }));
  await assert.rejects(clients('install', 'antigravity', name, target, { home, runAgy: fakeAgy(home) }), /already used by another/);
  assert.equal(await exists(resolve(dir, hooksRel)), false);
  assert.equal(await exists(resolve(dir, '.jev-memory-antigravity.json')), false);
});

test('antigravity hook commands are bare tokens that end with the suite event names', () => {
  const group = antigravityHookGroup('p', '/usr/local/bin/node', 'linux');
  const commands = [...JSON.stringify(group).matchAll(/"command":"([^"]*)"/g)].map(match => match[1]!);
  assert.deepEqual(commands.map(line => line.slice(line.lastIndexOf(' ') + 1)), ['session-start', 'pre-tool-use', 'post-tool-use', 'stop']);
  for (const line of commands) {
    assert.doesNotMatch(line, /["'`]/);
    assert.equal(line.split(' ').length, 5, line);
    assert.match(line, /^\/usr\/local\/bin\/node \S+hook\.js p antigravity-cli /);
  }
});
test('antigravity hook group rejects spaced or shell-unsafe executable paths and accepts bare win32 paths', () => {
  assert.throws(() => antigravityHookGroup('p', 'C:\\Program Files\\nodejs\\node.exe', 'linux'), /without spaces or shell characters/);
  assert.throws(() => antigravityHookGroup('p', '/opt/a&b/node', 'linux'), /without spaces or shell characters/);
  const group = antigravityHookGroup('p', 'C:\\nodejs\\node.exe', 'win32');
  assert.match(JSON.stringify(group), /C:\\\\nodejs\\\\node\.exe \S+hook\.js p antigravity-cli session-start/);
});
test('shortPath refuses characters that cannot be passed to cmd.exe', () => {
  assert.throws(() => shortPath('C:\\bad"name\\node.exe'), /cannot be safely converted/);
  assert.throws(() => shortPath('C:\\100%\\node.exe'), /cannot be safely converted/);
});
test('shortPath returns a space-free path for the running node on win32', { skip: process.platform !== 'win32' }, () => {
  assert.doesNotMatch(shortPath(process.execPath), /\s/);
});
test('antigravityMcpState classifies missing, registered, conflict, bom and unreadable files', async t => {
  const name = 'mcp-state', home = await fakeHome(t), path = antigravityMcpPath(home);
  assert.equal(await antigravityMcpState(name, home), 'missing');
  await mkdir(resolve(home, '.gemini/config'), { recursive: true });
  await writeFile(path, JSON.stringify({ mcpServers: { [serverId]: bridgeEntry(name) } }));
  assert.equal(await antigravityMcpState(name, home), 'registered');
  await writeFile(path, JSON.stringify({ mcpServers: { [serverId]: { command: 'other', args: [] } } }));
  assert.equal(await antigravityMcpState(name, home), 'conflict');
  await writeFile(path, Buffer.concat([bom, Buffer.from(JSON.stringify({ mcpServers: {} }))]));
  assert.equal(await antigravityMcpState(name, home), 'bom');
  await writeFile(path, '{not json');
  assert.equal(await antigravityMcpState(name, home), 'unreadable');
});
test('registerAntigravityMcp strips the BOM with a backup and keeps the rest byte-identical', async t => {
  const name = 'mcp-bom', home = await fakeHome(t), path = antigravityMcpPath(home), calls: string[][] = [];
  await mkdir(resolve(home, '.gemini/config'), { recursive: true });
  const original = Buffer.concat([bom, Buffer.from(`${JSON.stringify({ mcpServers: { other: { command: 'o', args: [] }, [serverId]: bridgeEntry(name) } }, null, 2)}\n`)]);
  await writeFile(path, original);
  assert.deepEqual(await registerAntigravityMcp(name, home, fakeAgy(home, calls)), { mcp: 'registered', changed: true });
  assert.deepEqual(calls, []);
  assert.ok((await readFile(path)).equals(original.subarray(bom.length)));
  const dir = resolve(home, '.gemini/config'), backups = (await readdir(dir)).filter(file => /^mcp_config\.json\.jev-bom-.*\.bak$/.test(file));
  assert.equal(backups.length, 1);
  assert.ok((await readFile(resolve(dir, backups[0]!))).equals(original));
});
test('registerAntigravityMcp adds the entry through agy with the bridge argv', async t => {
  const name = 'mcp-add', home = await fakeHome(t), calls: string[][] = [];
  assert.deepEqual(await registerAntigravityMcp(name, home, fakeAgy(home, calls)), { mcp: 'registered', changed: true });
  assert.deepEqual(calls, [['mcp', 'add', serverId, process.execPath, resolve(root, 'dist/src/bridge.js'), name]]);
  assert.equal(await antigravityMcpState(name, home), 'registered');
  assert.deepEqual(await registerAntigravityMcp(name, home, fakeAgy(home, calls)), { mcp: 'registered', changed: false });
  assert.equal(calls.length, 1);
});
test('registerAntigravityMcp refuses a conflicting entry without calling agy', async t => {
  const name = 'mcp-conflict', home = await fakeHome(t), path = antigravityMcpPath(home), calls: string[][] = [];
  await mkdir(resolve(home, '.gemini/config'), { recursive: true });
  const original = JSON.stringify({ mcpServers: { [serverId]: { command: 'other', args: [] } } });
  await writeFile(path, original);
  await assert.rejects(registerAntigravityMcp(name, home, fakeAgy(home, calls)), /already used by another Antigravity server/);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(path, 'utf8'), original);
});

function command(entries: Record<string, unknown>, event: string): string {
  return (entries[event] as HookGroup).hooks[0]!.command;
}
