import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configSchema, json, profileDir, readConfig, root, type Config } from '../src/config.js';
import { atomicJson, token, type TokenFile } from '../src/local.js';
import { init } from '../src/lifecycle.js';
import { nativeArgv, ownRootRegistration, planLaunch, jevLauncherArgv, jevLauncherPath, codexProviderArgs, loadUpstreamCodexSpec, gatewayLaunchEnv, agyFinalizeArgs, finalizeAgySession, agyDelegation, headroomClaudeSpawn, headroomCodexSpawn, buildCodexHeadroomSpawn, prepareHeadroom, waitForHeadroom } from '../src/launch.js';
import { delegatedCommand } from '../src/cli-args.js';

// Each test gets a profile whose projectRoot is a fresh directory outside the repository, so the
// suite's own .ai-memory.toml and client registrations never apply, and the returned dir is the launch cwd.
async function profile(t: TestContext): Promise<{ name: string; dir: string }> {
  const name = `launch-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'launch-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await init(name);
  const path = resolve(profileDir(name), 'suite.json');
  await atomicJson(path, configSchema.parse({ ...await readConfig(name), projectRoot: dir }));
  t.after(() => rm(profileDir(name), { recursive: true, force: true }));
  return { name, dir };
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
  const { name } = await profile(t), dir = profileDir(name);
  const control = await token(dir), router = await token(dir, 'router-token');
  assert.notEqual(router, control);
  assert.match(router, /^[a-f0-9]{64}$/);
  assert.equal(await token(dir, 'router-token'), router);
  await assert.rejects(token(dir, 'bad' as TokenFile), /Unknown local token file/);
});

test('claude plan points MCP and settings flags at per-profile launch files bound to the profile', async t => {
  const { name, dir } = await profile(t), launchDir = resolve(profileDir(name), 'launch');
  const plan = await planLaunch('claude', name, dir);
  const mcpFile = flagValue(plan.args, '--mcp-config'), settingsFile = flagValue(plan.args, '--settings');
  assert.ok(mcpFile.startsWith(launchDir)); assert.ok(settingsFile.startsWith(launchDir));
  assert.ok(!plan.args.includes('--strict-mcp-config'));
  assert.deepEqual(plan.files, [mcpFile, settingsFile]);
  const mcp = JSON.parse(await readFile(mcpFile, 'utf8')) as { mcpServers: { jev_memory_suite: { args: string[] } } };
  assert.deepEqual(mcp.mcpServers.jev_memory_suite.args.slice(1), [name, 'claude-code']);
  const settings = JSON.parse(await readFile(settingsFile, 'utf8')) as { hooks: Record<string, unknown> };
  assert.ok(Object.keys(settings.hooks).length > 0);
  assert.ok(Object.values(settings.hooks).every(groups => Array.isArray(groups) && groups.length === 1), 'each hook event must be an array of matcher groups');
});

test('codex plan carries the profile in the MCP bridge -c overrides', async t => {
  const { name, dir } = await profile(t);
  const plan = await planLaunch('codex', name, dir);
  assert.ok(plan.args.some(arg => arg.startsWith('mcp_servers.jev_memory_suite.args=') && arg.endsWith(`,${JSON.stringify(name)}]`)));
  assert.deepEqual(plan.files, []);
});

test('memory disabled adds no MCP or hook flags for either client', async t => {
  const { name, dir } = await profile(t), path = resolve(profileDir(name), 'suite.json');
  const config = configSchema.parse(await json(path));
  config.memory.enabled = false; config.gateway.enabled = false;
  await atomicJson(path, config);
  assert.deepEqual((await planLaunch('claude', name, dir)).args, []);
  assert.deepEqual((await planLaunch('codex', name, dir)).args, []);
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
  const { name, dir } = await profile(t);
  const plan = await planLaunch('claude', name, dir);
  assert.equal(plan.marker, undefined);
});

test('plan with a matching scope marker returns its path', async t => {
  const { name, dir } = await profile(t);
  const config = await readConfig(name);
  await writeFile(resolve(dir, '.ai-memory.toml'), markerText(config.workspace, config.project));
  const plan = await planLaunch('claude', name, dir);
  assert.equal(plan.marker, resolve(await realpath(dir), '.ai-memory.toml'));
});

test('plan rejects a scope marker that declares another project', async t => {
  const { name, dir } = await profile(t);
  const config = await readConfig(name);
  await writeFile(resolve(dir, '.ai-memory.toml'), markerText(config.workspace, 'other-project'));
  await assert.rejects(planLaunch('claude', name, dir), /Scope marker/);
});

test('plan reads the root registration from the launch cwd, not the workspace root', async t => {
  const { name, dir } = await profile(t);
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

// Defaults come from the schema, so these configs match what a profile written without the new keys would load.
async function gatewayConfig(overrides: Record<string, unknown> = {}): Promise<Config> {
  return configSchema.parse({ ...await json(resolve(root, 'config/default.json')) as Record<string, unknown>, ...overrides });
}
test('gateway launch env with default experiments sets nothing', async () => {
  const c = await gatewayConfig();
  assert.deepEqual(gatewayLaunchEnv('claude', c), {});
  assert.deepEqual(gatewayLaunchEnv('codex', c), {});
});

test('gateway launch env shadow experiment asks Jev in parallel without changing routing', async () => {
  const c = await gatewayConfig({ gatewayExperiment: { claude: 'shadow', codex: 'shadow' } });
  assert.deepEqual(gatewayLaunchEnv('claude', c), { JEV_ROUTING: 'true', JEV_SHADOW: 'true' });
  assert.deepEqual(gatewayLaunchEnv('codex', c), { JEV_ROUTING: 'true', JEV_SHADOW: 'true' });
});

test('gateway launch env metering experiment disables Jev for both clients', async () => {
  const c = await gatewayConfig({ gatewayExperiment: { claude: 'metering', codex: 'metering' } });
  assert.deepEqual(gatewayLaunchEnv('claude', c), { JEV_ROUTING: 'false', JEV_SHADOW: 'false' });
  assert.deepEqual(gatewayLaunchEnv('codex', c), { JEV_ROUTING: 'false', JEV_SHADOW: 'false' });
});

test('gateway launch env applies each client experiment independently', async () => {
  const c = await gatewayConfig({ gatewayExperiment: { claude: 'metering', codex: 'default' } });
  assert.deepEqual(gatewayLaunchEnv('claude', c), { JEV_ROUTING: 'false', JEV_SHADOW: 'false' });
  assert.deepEqual(gatewayLaunchEnv('codex', c), {});
});

test('gateway launch env never sets the removed dashboard redirect, whatever the dashboard port', async () => {
  const c = await gatewayConfig({ dashboard: { port: 19000 }, gatewayExperiment: { claude: 'shadow', codex: 'metering' } });
  for (const client of ['claude', 'codex'] as const) assert.equal('JEV_DASHBOARD_REDIRECT' in gatewayLaunchEnv(client, c), false);
});

test('gateway launch env returns a fresh object so callers cannot change later launches', async () => {
  const c = await gatewayConfig({ gatewayExperiment: { claude: 'shadow', codex: 'default' } });
  const first = gatewayLaunchEnv('claude', c);
  first.JEV_ROUTING = 'false';
  assert.notEqual(gatewayLaunchEnv('claude', c), first);
  assert.equal(gatewayLaunchEnv('claude', c).JEV_ROUTING, 'true');
});

test('agy finalize args target one session with --reopen and pass the memory data dir through', () => {
  assert.deepEqual(agyFinalizeArgs({ workspace: 'ws', project: 'pj' }, '/data/memory', 'conv-1'), [
    '--data-dir', '/data/memory', 'finalize-session', '--agent', 'antigravity-cli',
    '--session-id', 'conv-1', '--reopen', '--workspace', 'ws', '--project', 'pj', '--json']);
});

test('agy finalize args without a session id omit --session-id and --reopen', () => {
  assert.deepEqual(agyFinalizeArgs({ workspace: 'ws', project: 'pj' }, '/data/memory'), [
    '--data-dir', '/data/memory', 'finalize-session', '--agent', 'antigravity-cli', '--workspace', 'ws', '--project', 'pj', '--json']);
});

test('agy finalize rejects an invalid session id before running anything', async () => {
  const c = await gatewayConfig();
  await assert.rejects(finalizeAgySession('no-such-profile', c, '-bad id; rm', tmpdir()), /Invalid Antigravity session id/);
  await assert.rejects(finalizeAgySession('no-such-profile', c, '--reopen', tmpdir()), /Invalid Antigravity session id/);
});

test('agy delegation keeps everything after agy raw, including flags parseArgs would reject', () => {
  assert.deepEqual(agyDelegation(['--profile', 'x', 'agy', '-p', 'hi', '--json']), { head: ['--profile', 'x'], rest: ['-p', 'hi', '--json'] });
  assert.equal(agyDelegation(['agy-finalize', '--session', 'x']), undefined);
  assert.equal(agyDelegation(['launch', 'agy', '--', 'x']), undefined);
});

test('package bin and the agy wrapper point at the agy command', async () => {
  const pkg = await json(resolve(root, 'package.json')) as { bin: Record<string, string> };
  assert.equal(pkg.bin['jev-memory-agy'], 'bin/jev-memory-agy.mjs');
  const script = await readFile(resolve(root, 'bin/jev-memory-agy.mjs'), 'utf8');
  assert.match(script, /'agy', \.\.\.process\.argv\.slice\(2\)/);
  assert.match(await readFile(resolve(root, 'bin/jev-memory-agy.cmd'), 'utf8'), /jev-memory-agy\.mjs/);
});

test('headroom claude spawn keeps plan and user argv and points only ANTHROPIC_BASE_URL at Headroom', () => {
  const env = { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'token', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789' };
  const spec = headroomClaudeSpawn({ command: 'claude', prefix: [] }, ['--mcp-config', 'x'], ['-p', 'hi'], env, 'http://127.0.0.1:18880');
  assert.equal(spec.command, 'claude');
  assert.deepEqual(spec.args, ['--mcp-config', 'x', '-p', 'hi']);
  assert.deepEqual(spec.env, { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'token', ANTHROPIC_BASE_URL: 'http://127.0.0.1:18880' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8789', 'the caller env must not be changed');
});

test('headroom claude spawn keeps the executable prefix before the argv', () => {
  const spec = headroomClaudeSpawn({ command: '/node', prefix: ['/cli.js'] }, [], ['hi'], {}, 'http://127.0.0.1:18880');
  assert.deepEqual(spec, { command: '/node', args: ['/cli.js', 'hi'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18880' } });
});

test('headroom codex spawn points the provider at the Headroom origin and keeps plan args for interactive codex', async () => {
  const providerArgs = (await loadUpstreamCodexSpec()).args('http://127.0.0.1:18880');
  const env = { PATH: '/bin', OPENAI_API_KEY: 'key' };
  const spec = headroomCodexSpawn({ command: 'codex', prefix: [] }, ['-c', 'a=1'], ['hi'], env, providerArgs);
  assert.equal(spec.command, 'codex');
  assert.deepEqual(spec.args, [...providerArgs, '-c', 'a=1', 'hi']);
  assert.ok(spec.args.includes('model_providers.jev-gateway.base_url="http://127.0.0.1:18880/v1"'));
  assert.ok(!spec.args.some(arg => arg.includes('8790')), 'the Jev codex gateway port must not be used as the Codex origin');
  assert.equal(spec.env, env);
  assert.deepEqual(env, { PATH: '/bin', OPENAI_API_KEY: 'key' }, 'the env must not gain Anthropic or Headroom variables');
});

test('headroom codex spawn places provider overrides after the exec subcommand, as the upstream argv does', async () => {
  const providerArgs = (await loadUpstreamCodexSpec()).args('http://127.0.0.1:18880');
  const spec = headroomCodexSpawn({ command: 'codex', prefix: [] }, ['-c', 'a=1'], ['exec', 'hi'], {}, providerArgs);
  assert.deepEqual(spec.args, [...providerArgs, 'exec', ...providerArgs, '-c', 'a=1', 'hi']);
});

test('headroom codex spawn keeps the executable prefix before the argv', () => {
  const spec = headroomCodexSpawn({ command: '/node', prefix: ['/codex.js'] }, [], ['hi'], {}, []);
  assert.deepEqual(spec, { command: '/node', args: ['/codex.js', 'hi'], env: {} });
});

// Injected dependencies keep these tests from spawning: the builder only reads the executable and the spec.
test('codex headroom spawn becomes a fallback reason when the upstream spec cannot be read', async () => {
  const deps = { executable: async () => ({ command: 'codex', prefix: [] }), spec: async (): Promise<never> => { throw new Error('missing'); } };
  assert.deepEqual(await buildCodexHeadroomSpawn('http://127.0.0.1:18880', [], ['hi'], {}, deps), { ok: false, reason: 'Codex provider spec unavailable' });
});

test('codex headroom spawn becomes the same fallback reason when the codex executable is not found', async () => {
  const deps = { executable: async (): Promise<never> => { throw new Error('Native CLI executable not found'); }, spec: async () => ({ portEnv: 'JEV_CODEX_PORT', defaultPort: 8790, args: () => [] }) };
  assert.deepEqual(await buildCodexHeadroomSpawn('http://127.0.0.1:18880', [], ['hi'], {}, deps), { ok: false, reason: 'Codex provider spec unavailable' });
});

test('codex headroom spawn builds the same spawn as the direct helper when its inputs are available', async () => {
  const spec = await loadUpstreamCodexSpec();
  const deps = { executable: async () => ({ command: 'codex', prefix: [] }), spec: async () => spec };
  const env = { PATH: '/bin' };
  const built = await buildCodexHeadroomSpawn('http://127.0.0.1:18880', ['-c', 'a=1'], ['hi'], env, deps);
  assert.deepEqual(built, { ok: true, spec: headroomCodexSpawn({ command: 'codex', prefix: [] }, ['-c', 'a=1'], ['hi'], env, spec.args('http://127.0.0.1:18880')) });
});

test('JMS_HEADROOM=off returns the codex opt-out reason before anything starts', async t => {
  const { name } = await profile(t);
  const config = await readConfig(name);
  config.headroom.enabled = true;
  config.headroom.codex = true;
  const previous = process.env.JMS_HEADROOM;
  process.env.JMS_HEADROOM = 'off';
  try {
    assert.deepEqual(await prepareHeadroom(name, config, {}, 'codex'), { use: false, reason: 'Headroom bypassed by JMS_HEADROOM=off' });
  } finally {
    if (previous === undefined) delete process.env.JMS_HEADROOM; else process.env.JMS_HEADROOM = previous;
  }
  await assert.rejects(stat(resolve(profileDir(name), 'logs')));
});

// Status stub for waitForHeadroom: only the headroom service state matters to the wait.
const headroomStatus = (state: string) => ({ services: { headroom: state } });
// Reads come from a script; each sleep is recorded instead of waiting.
function scripted(statuses: Record<string, unknown>[]) {
  const sleeps: number[] = [];
  let reads = 0;
  return {
    read: async () => statuses[Math.min(reads++, statuses.length - 1)] ?? {},
    sleep: async (ms: number) => { sleeps.push(ms); },
    sleeps, reads: () => reads,
  };
}

test('headroom wait returns at once when the service is already ready', async () => {
  const script = scripted([headroomStatus('ready')]);
  const status = await waitForHeadroom(script.read, { timeoutMs: 60_000, intervalMs: 500, sleep: script.sleep });
  assert.deepEqual(status, headroomStatus('ready'));
  assert.equal(script.reads(), 1);
  assert.deepEqual(script.sleeps, []);
});

test('headroom wait keeps polling through starting and returns the ready status', async () => {
  const script = scripted([headroomStatus('starting'), headroomStatus('starting'), headroomStatus('ready')]);
  const status = await waitForHeadroom(script.read, { timeoutMs: 60_000, intervalMs: 500, sleep: script.sleep });
  assert.deepEqual(status, headroomStatus('ready'));
  assert.deepEqual(script.sleeps, [500, 500]);
});

test('headroom wait also polls through restarting and stops on a terminal state', async () => {
  const script = scripted([headroomStatus('restarting'), headroomStatus('failed'), headroomStatus('ready')]);
  const status = await waitForHeadroom(script.read, { timeoutMs: 60_000, intervalMs: 500, sleep: script.sleep });
  assert.deepEqual(status, headroomStatus('failed'));
  assert.deepEqual(script.sleeps, [500]);
});

test('headroom wait returns the last starting status at timeout without throwing', async () => {
  const script = scripted([headroomStatus('starting')]);
  const status = await waitForHeadroom(script.read, { timeoutMs: 1000, intervalMs: 500, sleep: script.sleep });
  assert.deepEqual(status, headroomStatus('starting'));
  assert.equal(script.reads(), 3);
  assert.deepEqual(script.sleeps, [500, 500]);
});

test('JMS_HEADROOM=off returns the opt-out reason before anything starts', async t => {
  const { name } = await profile(t);
  const config = await readConfig(name);
  config.headroom.enabled = true;
  const previous = process.env.JMS_HEADROOM;
  process.env.JMS_HEADROOM = 'off';
  try {
    assert.deepEqual(await prepareHeadroom(name, config, {}), { use: false, reason: 'Headroom bypassed by JMS_HEADROOM=off' });
  } finally {
    if (previous === undefined) delete process.env.JMS_HEADROOM; else process.env.JMS_HEADROOM = previous;
  }
  // start() creates the profile logs directory first, so its absence shows the supervisor was never started.
  await assert.rejects(stat(resolve(profileDir(name), 'logs')));
});
