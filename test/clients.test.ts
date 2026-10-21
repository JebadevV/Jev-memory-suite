import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { profileDir, root } from '../src/config.js';
import { clients } from '../src/clients.js';
import { init } from '../src/lifecycle.js';

interface Report { action: string; host: string; surface: string; profile: string; registered?: boolean; backupDir?: string; changed?: string[] }

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
