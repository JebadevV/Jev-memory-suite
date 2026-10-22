import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { projectContext } from '../src/projects.js';
import { assertLocal, assertWithin, inside, profileDir, readConfig, root } from '../src/config.js';
import { clients } from '../src/clients.js';
import { parseHookPayload } from '../src/hook.js';
import { planLaunch } from '../src/launch.js';
import { projectScopeMarker } from '../src/scope.js';

test('external projects retain cwd, isolate profiles, preserve client settings and confine hooks', async t => {
  const scratch = await mkdtemp(resolve(tmpdir(), 'jev-suite-project-test-'));
  const profiles = new Set<string>();
  t.after(async () => {
    for (const name of profiles) { inside(resolve(root, '.local/profiles'), profileDir(name)); await rm(profileDir(name), { recursive: true, force: true }); }
    inside(tmpdir(), scratch); await rm(scratch, { recursive: true, force: true });
  });
  const a = resolve(scratch, 'A with spaces', 'same-name'), b = resolve(scratch, 'B', 'same-name');
  await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true }); await mkdir(resolve(a, '.git'));
  const [ca, cb] = await Promise.all([projectContext('default', '.', a), projectContext('default', b, root)]);
  profiles.add(ca.name); profiles.add(cb.name);
  assert.equal(ca.cwd, await realpath(a)); assert.equal(cb.cwd, await realpath(b)); assert.notEqual(ca.name, cb.name);
  assert.deepEqual(await projectContext('default', a, root), ca);
  const sub = resolve(a, 'src'); await mkdir(sub);
  assert.equal((await projectContext('default', '.', sub)).name, ca.name);
  const ac = await readConfig(ca.name), bc = await readConfig(cb.name);
  assert.equal(ac.projectRoot, ca.cwd); assert.notEqual(ac.project, bc.project);
  assert.equal(new Set([ac.controlPort, ac.memory.port, ac.gateway.port, ac.dashboard.port,
    bc.controlPort, bc.memory.port, bc.gateway.port, bc.dashboard.port]).size, 8);
  await assert.rejects(assertLocal(resolve(a, 'foreign')), /boundary/);
  await assert.rejects(assertWithin(a, resolve(b, 'foreign')), /boundary/);
  const other = { command: 'existing-server', args: ['keep-me'] };
  await mkdir(resolve(a, '.claude'));
  await writeFile(resolve(a, '.mcp.json'), JSON.stringify({ mcpServers: { other } }));
  await writeFile(resolve(a, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
  await clients('install', 'claude', ca.name, a);
  await clients('install', 'codex', ca.name, a);
  assert.equal((await clients('check', 'codex', ca.name, a) as { registered: boolean }).registered, true);
  const ap = await planLaunch('claude', ca.name, a), cp = await planLaunch('codex', ca.name, a);
  assert.ok(ap.marker); assert.ok(cp.args.includes('-c'));
  const doc = JSON.parse(await readFile(resolve(a, '.mcp.json'), 'utf8')) as { mcpServers: { other: unknown } };
  assert.deepEqual(doc.mcpServers.other, other);
  const payload = { session_id: 'external-test', cwd: sub };
  assert.equal((await parseHookPayload('codex', 'session-start', payload, a)).cwd, await realpath(sub));
  await assert.rejects(parseHookPayload('codex', 'session-start', { ...payload, cwd: b }, a), /boundary/);
  await assert.rejects(clients('install', 'codex', ca.name, b), /boundary/);
  await assert.rejects(planLaunch('codex', ca.name, b), /boundary/);
  const nestedMarker = resolve(sub, '.ai-memory.toml');
  await writeFile(nestedMarker, `workspace = "other"\nproject = "other"\n`);
  await assert.rejects(projectScopeMarker(sub, ac), /Scope marker/);
  await rm(nestedMarker);
  const link = resolve(a, 'alias'); await symlink(b, link, 'junction');
  try {
    await assert.rejects(projectContext('default', link, root), /Symlink\/junction/);
    await assert.rejects(assertWithin(a, resolve(link, 'file')), /Symlink\/junction/);
  } finally { await rmdir(link); }
  await clients('remove', 'claude', ca.name, a); await clients('remove', 'codex', ca.name, a);
  const settings = JSON.parse(await readFile(resolve(a, '.claude/settings.local.json'), 'utf8')) as { permissions: unknown };
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
});

test('suite-local launch selection keeps existing profiles and default cwd', async () => {
  assert.deepEqual(await projectContext('default', '.', root), { name: 'default', cwd: await realpath(root) });
  await assert.rejects(projectContext('default', resolve(root, 'missing-project-dir')), /ENOENT/);
});
