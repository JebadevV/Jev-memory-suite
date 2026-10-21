import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configSchema, json, profileDir, readConfig, root } from '../src/config.js';
import { atomicJson, token, type TokenFile } from '../src/local.js';
import { init } from '../src/lifecycle.js';
import { nativeArgv, ownRootRegistration, planLaunch, jevLauncherArgv, jevLauncherPath, codexProviderArgs, loadUpstreamCodexSpec } from '../src/launch.js';
import { delegatedCommand } from '../src/cli-args.js';

async function profile(t: TestContext): Promise<string> {
  const name = `launch-${Date.now()}-${randomBytes(3).toString('hex')}`;
  await init(name);
  t.after(() => rm(profileDir(name), { recursive: true, force: true }));
  return name;
}
async function fixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(resolve(root, '.local/launch-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function markerText(workspace: string, project: string): string {
  return `workspace = "${workspace}"\nproject = "${project}"\n`;
}
function flagValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args[index + 1] ?? '';
}

test('router token is a separate per-profile secret and token() rejects unknown files', async t => {
  const name = await profile(t), dir = profileDir(name);
  const control = await token(dir), router = await token(dir, 'router-token');
  assert.notEqual(router, control);
  assert.match(router, /^[a-f0-9]{64}$/);
  assert.equal(await token(dir, 'router-token'), router);
  await assert.rejects(token(dir, 'bad' as TokenFile), /Unknown local token file/);
});

test('claude plan points MCP and settings flags at per-profile launch files bound to the profile', async t => {
  const name = await profile(t), launchDir = resolve(profileDir(name), 'launch');
  const plan = await planLaunch('claude', name);
  const mcpFile = flagValue(plan.args, '--mcp-config'), settingsFile = flagValue(plan.args, '--settings');
  assert.ok(mcpFile.startsWith(launchDir)); assert.ok(settingsFile.startsWith(launchDir));
  assert.ok(!plan.args.includes('--strict-mcp-config'));
  assert.deepEqual(plan.files, [mcpFile, settingsFile]);
  const mcp = JSON.parse(await readFile(mcpFile, 'utf8')) as { mcpServers: { jev_memory_suite: { args: string[] } } };
  assert.equal(mcp.mcpServers.jev_memory_suite.args.at(-1), name);
  const settings = JSON.parse(await readFile(settingsFile, 'utf8')) as { hooks: Record<string, unknown> };
  assert.ok(Object.keys(settings.hooks).length > 0);
  assert.ok(Object.values(settings.hooks).every(groups => Array.isArray(groups) && groups.length === 1), 'each hook event must be an array of matcher groups');
});

test('codex plan carries the profile in the MCP bridge -c overrides', async t => {
  const name = await profile(t);
  const plan = await planLaunch('codex', name);
  assert.ok(plan.args.some(arg => arg.startsWith('mcp_servers.jev_memory_suite.args=') && arg.endsWith(`,${JSON.stringify(name)}]`)));
  assert.deepEqual(plan.files, []);
});

test('memory disabled adds no MCP or hook flags for either client', async t => {
  const name = await profile(t), path = resolve(profileDir(name), 'suite.json');
  const config = configSchema.parse(await json(path));
  config.memory.enabled = false; config.gateway.enabled = false;
  await atomicJson(path, config);
  assert.deepEqual((await planLaunch('claude', name)).args, []);
  assert.deepEqual((await planLaunch('codex', name)).args, []);
});

test('codex exec receives plan overrides right after the exec subcommand', () => {
  assert.deepEqual(nativeArgv('codex', ['-c', 'a=1'], ['exec', 'hello']), ['exec', '-c', 'a=1', 'hello']);
});

test('codex plain prompt keeps plan overrides as a prefix', () => {
  assert.deepEqual(nativeArgv('codex', ['-c', 'a=1'], ['hello']), ['-c', 'a=1', 'hello']);
});

test('claude keeps plan flags as a prefix even when the first user arg is exec', () => {
  assert.deepEqual(nativeArgv('claude', ['--mcp-config', 'x'], ['exec', 'hi']), ['--mcp-config', 'x', 'exec', 'hi']);
});

test('root registration check accepts absence and the same profile', () => {
  assert.equal(ownRootRegistration('alpha', undefined), false);
  assert.equal(ownRootRegistration('alpha', { profile: 'alpha', host: 'codex' }), true);
});

test('root registration check refuses another profile with a clear message', () => {
  assert.throws(() => ownRootRegistration('alpha', { profile: 'beta' }),
    /Workspace client registration belongs to profile beta; remove it or launch with that profile/);
});

test('root registration check refuses an unreadable registration', () => {
  assert.throws(() => ownRootRegistration('alpha', 'not-an-object'), /unreadable/);
});

test('plan without a scope marker reports none and still warns on stderr', async t => {
  const name = await profile(t), dir = await fixture(t);
  const plan = await planLaunch('claude', name, dir);
  assert.equal(plan.marker, undefined);
});

test('plan with a matching scope marker returns its path', async t => {
  const name = await profile(t), dir = await fixture(t);
  const config = await readConfig(name);
  await writeFile(resolve(dir, '.ai-memory.toml'), markerText(config.workspace, config.project));
  const plan = await planLaunch('claude', name, dir);
  assert.equal(plan.marker, resolve(await realpath(dir), '.ai-memory.toml'));
});

test('plan rejects a scope marker that declares another project', async t => {
  const name = await profile(t), dir = await fixture(t);
  const config = await readConfig(name);
  await writeFile(resolve(dir, '.ai-memory.toml'), markerText(config.workspace, 'other-project'));
  await assert.rejects(planLaunch('claude', name, dir), /Scope marker/);
});

test('plan reads the root registration from the launch cwd, not the workspace root', async t => {
  const name = await profile(t), dir = await fixture(t);
  await writeFile(resolve(dir, '.jev-memory-claude.json'), JSON.stringify({ profile: 'other' }));
  await assert.rejects(planLaunch('claude', name, dir), /belongs to profile/);
});

test('jev-launcher passthrough keeps upstream flags unchanged and adds no memory arguments', () => {
  assert.deepEqual(jevLauncherArgv('codex', ['-c', 'a=1'], ['--dashboard']), { passthrough: true, argv: ['--dashboard'] });
  assert.deepEqual(jevLauncherArgv('claude', ['--mcp-config', 'x'], ['--status']), { passthrough: true, argv: ['--status'] });
});

test('jev-launcher codex places plan args right after the exec subcommand', () => {
  assert.deepEqual(jevLauncherArgv('codex', ['-c', 'a=1'], ['exec', 'hi']), { passthrough: false, argv: ['exec', '-c', 'a=1', 'hi'] });
});

test('jev-launcher codex subcommand places provider and plan args right after it', () => {
  const provider = ['-c', 'model_provider="jev-gateway"'];
  assert.deepEqual(jevLauncherArgv('codex', ['-c', 'a=1'], ['exec', 'hi'], provider),
    { passthrough: false, argv: ['exec', '-c', 'model_provider="jev-gateway"', '-c', 'a=1', 'hi'] });
});

test('jev-launcher interactive codex does not add provider args', () => {
  assert.deepEqual(jevLauncherArgv('codex', ['-c', 'a=1'], ['hi'], ['-c', 'model_provider="jev-gateway"']),
    { passthrough: false, argv: ['-c', 'a=1', 'hi'] });
});

test('installed upstream codex spec supplies the jev-gateway provider overrides', async () => {
  const spec = await loadUpstreamCodexSpec();
  const args = spec.args('http://127.0.0.1:8790');
  assert.ok(args.includes('model_provider="jev-gateway"'));
  assert.ok(args.includes('model_providers.jev-gateway.requires_openai_auth=true'));
  assert.equal(spec.defaultPort, 8790);
  assert.equal(spec.portEnv, 'JEV_CODEX_PORT');
});

test('codex provider args follow the upstream port env, defaulting to 8790', async () => {
  const spec = await loadUpstreamCodexSpec();
  const previous = process.env.JEV_CODEX_PORT;
  delete process.env.JEV_CODEX_PORT;
  try {
    assert.deepEqual(await codexProviderArgs(), spec.args('http://127.0.0.1:8790'));
  } finally {
    if (previous === undefined) delete process.env.JEV_CODEX_PORT; else process.env.JEV_CODEX_PORT = previous;
  }
});

test('jev-launcher claude places plan args before the prompt', () => {
  assert.deepEqual(jevLauncherArgv('claude', ['--mcp-config', 'x'], ['-p', 'hi']), { passthrough: false, argv: ['--mcp-config', 'x', '-p', 'hi'] });
});

test('jev-launcher path points at the upstream launcher inside the gateway engine', () => {
  const base = resolve('/engines/jev-gateway');
  assert.equal(jevLauncherPath('codex', base), resolve(base, 'bin', 'jev-codex.mjs'));
  assert.equal(jevLauncherPath('claude', base), resolve(base, 'bin', 'jev-claude.mjs'));
});

test('installed upstream launchers exist in the real gateway engine', async () => {
  assert.ok((await stat(jevLauncherPath('codex'))).isFile());
  assert.ok((await stat(jevLauncherPath('claude'))).isFile());
});

test('cli routes codex and claude commands and keeps everything after them raw', () => {
  assert.deepEqual(delegatedCommand(['--profile', 'x', 'codex', '--dashboard']), { head: ['--profile', 'x'], client: 'codex', rest: ['--dashboard'] });
  assert.deepEqual(delegatedCommand(['codex', 'exec', '--profile', 'y']), { head: [], client: 'codex', rest: ['exec', '--profile', 'y'] });
  assert.deepEqual(delegatedCommand(['--dir', 'sub', 'claude', '-p', 'hi']), { head: ['--dir', 'sub'], client: 'claude', rest: ['-p', 'hi'] });
});

test('cli leaves other commands alone, including launch with a client argument', () => {
  assert.equal(delegatedCommand(['status']), undefined);
  assert.equal(delegatedCommand(['launch', 'codex', '--', 'exec']), undefined);
  assert.equal(delegatedCommand(['--profile', 'codex']), undefined);
  assert.equal(delegatedCommand([]), undefined);
});
