import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { projectContext } from '../src/projects.js';
import { prepare, readConfig, root } from '../src/config.js';
import { stop } from '../src/lifecycle.js';
import { Mcp } from '../src/mcp.js';
import { nativeHook } from '../src/hook.js';
import { sleep } from '../src/local.js';

async function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [resolve(root, 'bin/jev-memory.mjs'), ...args], { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); fail(new Error('External-project CLI timeout')); }, 90_000);
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.once('error', e => { clearTimeout(timer); fail(e); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) ok(stdout); else fail(new Error(`CLI exit ${code}: ${stderr}`)); });
  });
}
async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) { if (await check()) return true; await sleep(1000); }
  return false;
}
async function shortCommand(cwd: string, command: 'jev-memory-codex' | 'jev-memory-claude', env: NodeJS.ProcessEnv): Promise<string> {
  const childEnv = { ...process.env, ...env };
  const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  childEnv[pathKey] = `${childEnv[pathKey] ?? ''};${resolve(root, 'bin')}`;
  return new Promise((ok, fail) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${command} --version; exit $LASTEXITCODE`],
      { cwd, env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); fail(new Error('Short-command timeout')); }, 30_000);
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); }); child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.once('error', e => { clearTimeout(timer); fail(e); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) ok(stdout); else fail(new Error(`Short-command exit ${code}: ${stderr}`)); });
  });
}

test('external projects: real CLI, independent memory processes, hooks, isolation and restart', { timeout: 240_000 }, async t => {
  const scratch = await mkdtemp(resolve(tmpdir(), 'jev-suite-external-e2e-'));
  const a = resolve(scratch, 'A with spaces'), b = resolve(scratch, 'B');
  await mkdir(a); await mkdir(b);
  const ca = await projectContext('default', '.', a), cb = await projectContext('default', '.', b);
  t.after(async () => { await stop(ca.name); await stop(cb.name); });
  const ac = await readConfig(ca.name), bc = await readConfig(cb.name);
  for (const cwd of [a, b]) {
    await cli(cwd, ['clients', 'install', 'claude']);
    await cli(cwd, ['clients', 'install', 'codex', '.']);
    assert.equal((JSON.parse(await cli(cwd, ['start'])) as { phase: string }).phase, 'ready');
  }
  const explicit = JSON.parse(await cli(root, ['--dir', b, 'clients', 'check', 'codex'])) as { profile: string; registered: boolean };
  assert.equal(explicit.profile, cb.name); assert.equal(explicit.registered, true);
  const codexVersion = (await cli(a, ['launch', 'codex', '--', '--version'])).trim();
  const claudeVersion = (await cli(b, ['launch', 'claude', '--', '--version'])).trim();
  assert.match(codexVersion, /codex/i); assert.match(claudeVersion, /claude/i);
  // Exercise the recommended upstream launchers without starting a global router or making provider requests.
  let origin = '';
  const health = createServer((req, res) => {
    if (req.url !== '/health') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', upstream: origin }));
  });
  await new Promise<void>(done => health.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { health.close(() => done()); health.closeAllConnections(); }));
  const address = health.address(); assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  const env = { JEV_CODEX_PORT: String(address.port), JEV_CLAUDE_PORT: String(address.port), JEV_CODEX_UPSTREAM_BASE_URL: origin, JEV_CLAUDE_UPSTREAM_BASE_URL: origin };
  assert.match(await cli(a, ['codex', '--version'], env), /codex/i);
  assert.match(await cli(b, ['claude', '--version'], env), /claude/i);
  if (process.platform === 'win32') {
    assert.match(await shortCommand(a, 'jev-memory-codex', env), /codex/i);
    assert.match(await shortCommand(b, 'jev-memory-claude', env), /claude/i);
  }
  let ma = await Mcp.connect(ca.name);
  const mb = await Mcp.connect(cb.name), scopeA = { workspace: ac.workspace, project: ac.project }, scopeB = { workspace: bc.workspace, project: bc.project };
  const marker = `EXTERNAL${randomUUID().replaceAll('-', '')}`, sessionId = randomUUID();
  const payload = { cwd: a, session_id: sessionId };
  await nativeHook(ca.name, 'claude-code', 'session-start', { ...payload, hook_event_name: 'SessionStart', source: 'startup' });
  await nativeHook(ca.name, 'claude-code', 'user-prompt', { ...payload, hook_event_name: 'UserPromptSubmit', prompt: `Synthetic external-project check ${marker}` });
  await nativeHook(ca.name, 'claude-code', 'session-end', { ...payload, hook_event_name: 'SessionEnd', reason: 'other' });
  const observed = async (mcp: Mcp, scope: typeof scopeA) => JSON.stringify(await mcp.call('memory_read_session_observations', { ...scope, session_id: sessionId })).includes(marker);
  assert.ok(await eventually(() => observed(ma, scopeA)), 'external hook capture was not persisted');
  await assert.rejects(observed(mb, scopeB), /MCP RPC failed: -32602/, 'another project must not resolve the captured session');
  const pageMarker = `PAGE${randomUUID().replaceAll('-', '')}`;
  await ma.call('memory_write_page', { ...scopeA, path: 'notes/external-launch-check', title: 'External launch check', body: `# External launch check\n${pageMarker}`, tags: [] });
  assert.ok(await eventually(async () => JSON.stringify(await ma.call('memory_query', { ...scopeA, query: pageMarker })).includes(pageMarker)));
  assert.equal(JSON.stringify(await mb.call('memory_query', { ...scopeB, query: pageMarker })).includes(pageMarker), false);
  await assert.rejects(nativeHook(ca.name, 'codex', 'user-prompt', { cwd: b, session_id: randomUUID(), prompt: 'must reject wrong project' }), /boundary/);
  await cli(a, ['restart']); ma = await Mcp.connect(ca.name);
  assert.ok(await observed(ma, scopeA), 'capture disappeared after restart');
  const evidence = { purpose: 'Validate external project launch and isolated memory', audience: 'maintainers', date: new Date().toISOString(),
    status: 'passed', fixture: scratch, profiles: [ca.name, cb.name], versions: { codex: codexVersion, claude: claudeVersion },
    checks: ['CLI from external cwd with spaces', 'workspace-scoped client registration', 'two real memory services', 'native CLI versions through launch and upstream jev launchers', 'Windows short commands resolved through PATH in PowerShell',
      'real native hook capture', 'cross-project session/page isolation', 'wrong-project hook rejection', 'capture persists after restart'],
    limitations: ['Hook events were submitted by the integration test, not by an interactive native client', 'Codex hook trust and Desktop remain separate pending checks', 'Upstream launcher used a synthetic gateway health response; no model-provider requests were made'],
    cleanup: 'Services stopped by test cleanup; fixtures, synthetic memory and evidence retained' };
  await prepare(resolve(root, '.local/evidence'));
  await writeFile(resolve(root, '.local/evidence/external-projects-e2e.json'), `${JSON.stringify(evidence, null, 2)}\n`);
});
