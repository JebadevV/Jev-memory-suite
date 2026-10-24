import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rename as realRename, rm, stat, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configSchema, json, profileDir, readConfig, root, type Config } from '../src/config.js';
import { atomicJson, token, type TokenFile } from '../src/local.js';
import { init } from '../src/lifecycle.js';
import { nativeArgv, ownRootRegistration, planLaunch, jevLauncherArgv, jevLauncherPath, codexProviderArgs, loadUpstreamCodexSpec, gatewayLaunchEnv, agyFinalizeArgs, finalizeAgySession, agyDelegation, headroomClaudeSpawn, headroomCodexSpawn, buildCodexHeadroomSpawn, prepareHeadroom, waitForHeadroom, VALIDATED_AGY_VERSIONS, AGY_CODE_ASSIST_VERSIONS, agyVersionOf, agyVersionValidated, agyGatewayPort, parseAgyHealth, agyStartEnv, agyLaunchEnv, agyGatewayRoute, loadAgySpec, agyPidFile, readAgyPid, writeAgyOwner, recoverAgyLaunches, finalizeAgyLaunch, armAgyHangup, pidAlive, AGY_HANGUP_BUDGET_MS, type AgyGatewayRoute, type AgySpec } from '../src/launch.js';
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

// Antigravity gateway route. Fakes stand in for fetch, the version probe and the gateway launcher, so no agy or gateway runs.
const AGY_GW = resolve('/jev-gateway-test');
const AGY_OK = { status: 'ok', pid: 4242, upstream: 'https://cloudcode-pa.googleapis.com', jev: 'up', client: 'agy', codeAssist: 1 };
type AgyAnswer = { body: unknown; status?: number } | 'down';
interface AgyCall { file: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number } }
interface AgyFakeOptions {
  env?: NodeJS.ProcessEnv;
  version?: string | Error;
  answers?: AgyAnswer[];
  startFails?: boolean;
  spec?: AgySpec | Error | undefined;
  gateway?: Error;
  // The recorded pid: defaults to the healthy body's pid; null means the pid file is absent.
  pid?: number | Error | null;
}
function agyFakes(options: AgyFakeOptions = {}) {
  const answers = [...(options.answers ?? [])], urls: string[] = [], calls: AgyCall[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(String(url));
    const answer = answers.shift() ?? 'down';
    if (answer === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  const exec = async (file: string, args: string[], callOptions: AgyCall['options']) => {
    calls.push({ file, args, options: callOptions });
    if (args[0] === '--version') {
      const version = options.version ?? 'agy 1.4.7\n';
      if (version instanceof Error) throw version;
      return version;
    }
    if (options.startFails) throw new Error('start failed');
    return '';
  };
  const spec = 'spec' in options ? options.spec : { portEnv: 'JEV_AGY_PORT', defaultPort: 8794 };
  const deps = {
    env: options.env ?? { PATH: '/bin' },
    gateway: () => { if (options.gateway) throw options.gateway; return AGY_GW; },
    spec: async () => { if (spec instanceof Error) throw spec; return spec; },
    exec, fetch: fakeFetch,
    readPid: async () => {
      const pid = options.pid === undefined ? AGY_OK.pid : options.pid;
      if (pid instanceof Error) throw pid;
      return pid ?? undefined;
    }
  };
  return { deps, urls, calls, start: () => calls.filter(call => call.args.includes('--start')) };
}

test('agy gateway route is skipped by JMS_AGY_GATEWAY=off before any check runs', async () => {
  const fakes = agyFakes({ env: { PATH: '/bin', JMS_AGY_GATEWAY: 'off' } });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: 'disabled by JMS_AGY_GATEWAY=off' });
  assert.deepEqual(fakes.calls, []);
  assert.deepEqual(fakes.urls, []);
});

test('agy gateway route never overwrites a CLOUD_CODE_URL the user set', async () => {
  const fakes = agyFakes({ env: { PATH: '/bin', CLOUD_CODE_URL: 'https://example.test' } });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: 'CLOUD_CODE_URL already set' });
  assert.deepEqual(fakes.calls, []);
});

test('agy gateway route refuses an agy version that was not validated and touches nothing else', async () => {
  const fakes = agyFakes({ version: 'agy 1.4.8\n' });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: 'agy 1.4.8 not validated with the Jev gateway' });
  assert.deepEqual(fakes.urls, []);
  assert.equal(fakes.start().length, 0);
});

test('agy gateway route refuses version output with no recognizable version', async () => {
  const fakes = agyFakes({ version: 'agy: unknown build\n' });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: 'agy version not recognized' });
});

test('agy gateway route reports a failed version probe instead of throwing', async () => {
  const fakes = agyFakes({ version: new Error('no agy') });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: 'agy --version failed' });
});

test('agy gateway route reports an installed gateway without agy support', async () => {
  const fakes = agyFakes({ spec: undefined });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: 'installed gateway has no agy support' });
  assert.deepEqual(fakes.urls, []);
});

test('agy gateway route treats an unloadable agy spec as no agy support', async () => {
  const fakes = agyFakes({ spec: new Error('bad clients.mjs') });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: 'installed gateway has no agy support' });
});

test('agy gateway route reports a missing gateway engine', async () => {
  const fakes = agyFakes({ gateway: new Error('Gateway engine not installed') });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: 'gateway engine not installed' });
  assert.deepEqual(fakes.calls.map(call => call.args[0]), ['--version']);
});

test('agy gateway route uses a healthy gateway on the default port without starting it', async () => {
  const fakes = agyFakes({ answers: [{ body: AGY_OK }] });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { url: 'http://127.0.0.1:8794' });
  assert.deepEqual(fakes.urls, ['http://127.0.0.1:8794/health']);
  assert.equal(fakes.start().length, 0);
});

test('agy gateway route starts the gateway only when health does not answer', async () => {
  const fakes = agyFakes({ answers: ['down', { body: AGY_OK }] });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { url: 'http://127.0.0.1:8794' });
  const [start] = fakes.start();
  assert.equal(fakes.start().length, 1);
  assert.equal(start?.file, process.execPath);
  assert.deepEqual(start?.args, [resolve(AGY_GW, 'bin', 'jev-agy.mjs'), '--start']);
  assert.equal(start?.options.cwd, AGY_GW);
  assert.equal(start?.options.timeout, 20_000);
  assert.equal(fakes.urls.length, 2);
});

test('agy gateway route accepts a healthy gateway whose pid is the one jev-agy recorded', async () => {
  const fakes = agyFakes({ answers: [{ body: AGY_OK }], pid: 4242 });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { url: 'http://127.0.0.1:8794' });
});

test('agy gateway route refuses a gateway whose pid differs from the recorded one, without values in the reason', async () => {
  const fakes = agyFakes({ answers: [{ body: AGY_OK }], pid: 9999 });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: 'gateway pid does not match jev-agy' });
  assert.equal(fakes.start().length, 0);
});

test('agy gateway route refuses when the pid file is absent, unreadable or not a pid', async () => {
  const absent = agyFakes({ answers: [{ body: AGY_OK }], pid: null });
  assert.deepEqual(await agyGatewayRoute('agy', absent.deps), { reason: 'gateway pid does not match jev-agy' });
  const unreadable = agyFakes({ answers: [{ body: AGY_OK }], pid: new Error('EACCES') });
  assert.deepEqual(await agyGatewayRoute('agy', unreadable.deps), { reason: 'gateway pid does not match jev-agy' });
});

test('agy gateway start flow succeeds only when the started gateway pid matches the recorded pid', async () => {
  const ok = agyFakes({ answers: ['down', { body: AGY_OK }], pid: 4242 });
  assert.deepEqual(await agyGatewayRoute('agy', ok.deps), { url: 'http://127.0.0.1:8794' });
  assert.equal(ok.start().length, 1);
  const other = agyFakes({ answers: ['down', { body: AGY_OK }], pid: 7 });
  assert.deepEqual(await agyGatewayRoute('agy', other.deps), { reason: 'gateway pid does not match jev-agy' });
});

test('agy pid file lives in ~/.jev-gateway under the injected home and holds the launcher pid', async t => {
  assert.equal(agyPidFile(join('/home', 'tester')), join('/home', 'tester', '.jev-gateway', 'agy.pid'));
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agy-pid-test-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(await readAgyPid(home), undefined);
  await mkdir(join(home, '.jev-gateway'));
  await writeFile(agyPidFile(home), '4242');
  assert.equal(await readAgyPid(home), 4242);
  await writeFile(agyPidFile(home), 'not a pid');
  assert.equal(await readAgyPid(home), undefined);
});

test('agy gateway route treats a non-OK health status as not answering and then starts', async () => {
  const fakes = agyFakes({ answers: [{ body: AGY_OK, status: 503 }, { body: AGY_OK }] });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { url: 'http://127.0.0.1:8794' });
  assert.equal(fakes.start().length, 1);
});

test('agy gateway route reports a failed gateway start', async () => {
  const fakes = agyFakes({ answers: ['down'], startFails: true });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: 'jev-agy --start failed' });
  assert.equal(fakes.start().length, 1);
});

test('agy gateway route reports a gateway that still does not answer after start', async () => {
  const fakes = agyFakes({ answers: ['down', 'down'] });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: 'gateway did not answer on 127.0.0.1:8794' });
  assert.equal(fakes.start().length, 1);
});

test('agy gateway route uses JEV_AGY_PORT when it is valid', async () => {
  const fakes = agyFakes({ env: { PATH: '/bin', JEV_AGY_PORT: '18794' }, answers: [{ body: AGY_OK }] });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { url: 'http://127.0.0.1:18794' });
  assert.deepEqual(fakes.urls, ['http://127.0.0.1:18794/health']);
});

test('agy gateway route falls back to the spec default port when JEV_AGY_PORT is invalid', async () => {
  const fakes = agyFakes({ env: { PATH: '/bin', JEV_AGY_PORT: '80' }, answers: [{ body: AGY_OK }] });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { url: 'http://127.0.0.1:8794' });
});

for (const codeAssist of AGY_CODE_ASSIST_VERSIONS) {
  test(`agy gateway route accepts a healthy gateway that reports codeAssist ${codeAssist}`, async () => {
    const fakes = agyFakes({ answers: [{ body: { ...AGY_OK, codeAssist } }] });
    assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { url: 'http://127.0.0.1:8794' });
    assert.equal(fakes.start().length, 0);
  });
}

// A body that answers but fails validation is a reason, not a reason to start a second gateway.
for (const [field, body] of [
  ['status', { ...AGY_OK, status: 'error' }],
  ['client', { ...AGY_OK, client: 'codex' }],
  ['codeAssist', { ...AGY_OK, codeAssist: 3 }],
  ['codeAssist', { ...AGY_OK, codeAssist: 0 }],
  ['codeAssist', { ...AGY_OK, codeAssist: '1' }],
  ['upstream', { ...AGY_OK, upstream: 'https://evil.example' }],
  ['pid', { ...AGY_OK, pid: '4242' }],
  ['pid', { ...AGY_OK, pid: 1.5 }],
  ['body', null]
] as const) {
  test(`agy gateway route rejects a health body with an invalid ${field} without starting`, async () => {
    const fakes = agyFakes({ answers: [{ body }] });
    assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { reason: `gateway health invalid: ${field}` });
    assert.equal(fakes.start().length, 0);
  });
}

test('agy gateway route never throws, even when a dependency throws synchronously', async () => {
  const fakes = agyFakes({ answers: [] });
  const route = await agyGatewayRoute('agy', { ...fakes.deps, exec: () => { throw new Error('boom'); } });
  assert.deepEqual(route, { reason: 'Jev gateway check failed' });
  const fetchThrows = await agyGatewayRoute('agy', { ...fakes.deps, fetch: (() => { throw new Error('boom'); }) as unknown as typeof fetch });
  assert.ok('reason' in fetchThrows);
});

test('agy gateway start runs with the environment minus the gateway keys and launch routing variables', async () => {
  const env = { PATH: '/bin', JEV_AGY_PORT: '18794', UPSTREAM_API_KEY: 'u', ROUTER_API_KEY: 'r', JEV_SHADOW: 'true', JEV_DEBUG_DUMP_DIR: '/dump', JEV_MEMORY_AGY_LAUNCH: 'id' };
  const fakes = agyFakes({ env, answers: ['down', { body: { ...AGY_OK, upstream: 'https://daily-cloudcode-pa.googleapis.com' } }] });
  assert.deepEqual(await agyGatewayRoute('agy', fakes.deps), { url: 'http://127.0.0.1:18794' });
  const [start] = fakes.start();
  assert.equal(start?.options.env?.PATH, '/bin');
  for (const key of ['UPSTREAM_API_KEY', 'ROUTER_API_KEY', 'JEV_SHADOW', 'JEV_DEBUG_DUMP_DIR', 'JEV_MEMORY_AGY_LAUNCH', 'CLOUD_CODE_URL']) {
    assert.equal(start?.options.env?.[key], undefined, key);
  }
});

test('VALIDATED_AGY_VERSIONS holds only the version checked against the Jev gateway', () => {
  assert.deepEqual(VALIDATED_AGY_VERSIONS, ['1.4.7']);
});

test('agyVersionValidated accepts only the exact validated version', () => {
  assert.equal(agyVersionValidated('agy 1.4.7\n'), true);
  assert.equal(agyVersionValidated('1.4.7'), true);
  assert.equal(agyVersionValidated('1.4.70'), false);
  assert.equal(agyVersionValidated('1.4.8'), false);
  assert.equal(agyVersionValidated(''), false);
  assert.equal(agyVersionOf('no version here'), undefined);
});

test('agyGatewayPort uses a whole port in 1024-65535 and otherwise the default', () => {
  assert.equal(agyGatewayPort(undefined, 8794), 8794);
  assert.equal(agyGatewayPort('18794', 8794), 18794);
  assert.equal(agyGatewayPort('1024', 8794), 1024);
  assert.equal(agyGatewayPort('65535', 8794), 65535);
  for (const raw of ['1023', '65536', '80', 'abc', '12e3', '-1', '', '1.5']) assert.equal(agyGatewayPort(raw, 8794), 8794, raw);
});

test('parseAgyHealth accepts the agy Code Assist health body and returns its pid', () => {
  assert.deepEqual(parseAgyHealth(AGY_OK), { ok: true, pid: 4242 });
  assert.deepEqual(parseAgyHealth(undefined), { ok: false, reason: 'gateway health invalid: body' });
});

test('agyStartEnv removes exactly the listed variables and keeps the rest', () => {
  const env = { PATH: '/bin', UPSTREAM_API_KEY: 'u', ROUTER_API_KEY: 'r', JEV_SHADOW: 'true', JEV_DEBUG_DUMP_DIR: '/d', CLOUD_CODE_URL: 'x', JEV_MEMORY_AGY_LAUNCH: 'id', JEV_AGY_PORT: '18794' };
  assert.deepEqual(agyStartEnv(env), { PATH: '/bin', JEV_AGY_PORT: '18794' });
  assert.equal(env.UPSTREAM_API_KEY, 'u');
});

test('agyLaunchEnv adds CLOUD_CODE_URL only for a gateway route and never changes the base environment', () => {
  const base = { PATH: '/bin' };
  const routed: AgyGatewayRoute = { url: 'http://127.0.0.1:8794' };
  assert.deepEqual(agyLaunchEnv(base, 'launch-1', routed), { PATH: '/bin', JEV_MEMORY_AGY_LAUNCH: 'launch-1', CLOUD_CODE_URL: 'http://127.0.0.1:8794' });
  assert.deepEqual(agyLaunchEnv(base, 'launch-1', { reason: 'agy 1.4.8 not validated with the Jev gateway' }), { PATH: '/bin', JEV_MEMORY_AGY_LAUNCH: 'launch-1' });
  assert.deepEqual(base, { PATH: '/bin' });
});

// Each gateway fixture gets its own directory, because the module loader caches a clients.mjs by its path.
async function gatewayFixture(t: TestContext, clients: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agy-spec-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'bin', 'clients.mjs'), clients);
  return dir;
}
test('loadAgySpec reads the agy spec from the installed clients module', async t => {
  const dir = await gatewayFixture(t, 'export const agy = { portEnv: "JEV_AGY_PORT", defaultPort: 8794 };\n');
  assert.deepEqual(await loadAgySpec(dir), { portEnv: 'JEV_AGY_PORT', defaultPort: 8794 });
});
test('loadAgySpec reports an absent agy spec and rejects an unusable one', async t => {
  const absent = await gatewayFixture(t, 'export const codex = { portEnv: "JEV_CODEX_PORT", defaultPort: 8790 };\n');
  assert.equal(await loadAgySpec(absent), undefined);
  const unusable = await gatewayFixture(t, 'export const agy = { portEnv: 1, defaultPort: 8794 };\n');
  await assert.rejects(loadAgySpec(unusable), /agy spec is unusable/);
});

// Recovery and hangup. Records live under .local/tmp in the repository, a finalize fake stands in for the memory binary, and liveness is injected.
async function recoveryDir(t: TestContext): Promise<string> {
  await mkdir(resolve(root, '.local', 'tmp'), { recursive: true });
  const dir = await realpath(await mkdtemp(join(resolve(root, '.local', 'tmp'), 'agy-recovery-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function recoveryConfig(t: TestContext): Promise<Config> {
  const { name } = await profile(t);
  return configSchema.parse({ ...await readConfig(name), workspace: 'ws-a', project: 'pj-a' });
}
const launchOf = (n: number): string => n.toString(16).padStart(32, '0');
const launchRecords = (dir: string): string => join(dir, 'launch', 'agy');
const validOwner = (cwd: string, extra: Record<string, unknown> = {}) => ({ pid: 4242, startedAt: '2026-10-24T10:00:00.000Z', workspace: 'ws-a', project: 'pj-a', cwd, ...extra });
async function seedOwner(dir: string, launch: string, owner: unknown): Promise<void> {
  await mkdir(launchRecords(dir), { recursive: true });
  await writeFile(join(launchRecords(dir), `${launch}.owner.json`), typeof owner === 'string' ? owner : JSON.stringify(owner));
}
async function seedSessions(dir: string, launch: string, ids: string[], file = `${launch}.sessions`): Promise<void> {
  await mkdir(launchRecords(dir), { recursive: true });
  await writeFile(join(launchRecords(dir), file), `${ids.join('\n')}\n`);
}
const listRecords = async (dir: string): Promise<string[]> => (await readdir(launchRecords(dir)).catch(() => [])).sort();
function fakeFinalize(options: { failOn?: string; delayMs?: number } = {}) {
  const calls: Array<{ workspace: string; project: string; id: string; cwd: string }> = [];
  const finalize = async (_name: string, c: Config, id: string, cwd: string): Promise<string> => {
    if (options.delayMs) await new Promise(ok => setTimeout(ok, options.delayMs));
    if (id === options.failOn) throw new Error('finalize refused');
    calls.push({ workspace: c.workspace, project: c.project, id, cwd });
    return 'ok';
  };
  return { calls, finalize };
}

test('owner record is written with pid, start time and scope, and nothing else', async t => {
  const dir = await recoveryDir(t), launch = launchOf(1);
  await writeAgyOwner(dir, launch, { workspace: 'ws-a', project: 'pj-a', cwd: '/work/one' }, new Date('2026-10-24T10:00:00Z'));
  assert.deepEqual(JSON.parse(await readFile(join(launchRecords(dir), `${launch}.owner.json`), 'utf8')), { pid: process.pid, startedAt: '2026-10-24T10:00:00.000Z', workspace: 'ws-a', project: 'pj-a', cwd: '/work/one' });
  assert.deepEqual(await listRecords(dir), [`${launch}.owner.json`]);
  assert.equal(pidAlive(process.pid), true);
});

test('recovery finalizes a dead launch with the scope and cwd recorded in its owner and removes both records', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(1), warnings: string[] = [];
  await seedOwner(dir, launch, validOwner('/work/one'));
  await seedSessions(dir, launch, ['sess-1', 'sess-2']);
  const fake = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: () => false, finalize: fake.finalize, warn: m => warnings.push(m) });
  assert.deepEqual(report, { recovered: ['sess-1', 'sess-2'], skipped: [] });
  assert.deepEqual(fake.calls, [
    { workspace: 'ws-a', project: 'pj-a', id: 'sess-1', cwd: '/work/one' },
    { workspace: 'ws-a', project: 'pj-a', id: 'sess-2', cwd: '/work/one' },
  ]);
  assert.deepEqual(await listRecords(dir), []);
  assert.deepEqual(warnings, []);
});

test('recovery leaves a launch whose owner is alive untouched', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(2);
  await seedOwner(dir, launch, validOwner('/work/two'));
  await seedSessions(dir, launch, ['sess-live']);
  const fake = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: pid => pid === 4242, finalize: fake.finalize, warn: () => undefined });
  assert.deepEqual(report, { recovered: [], skipped: [{ launch, reason: 'owner-alive' }] });
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(await listRecords(dir), [`${launch}.owner.json`, `${launch}.sessions`].sort());
});

test('a sessions file without an owner is never finalized automatically, and only --legacy finalizes it with the current config', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(3);
  await seedSessions(dir, launch, ['3b7157ea-legacy']);
  const warnings: string[] = [];
  const automatic = fakeFinalize();
  const quiet = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: () => false, finalize: automatic.finalize, warn: m => warnings.push(m) });
  assert.deepEqual(quiet, { recovered: [], skipped: [{ launch, reason: 'no-owner' }] });
  assert.deepEqual(automatic.calls, []);
  assert.deepEqual(await listRecords(dir), [`${launch}.sessions`]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /--recover --legacy/);

  const legacy = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: '/project/here', legacy: true, profileDirPath: dir, isAlive: () => false, finalize: legacy.finalize, warn: () => undefined });
  assert.deepEqual(report.recovered, ['3b7157ea-legacy']);
  assert.deepEqual(legacy.calls, [{ workspace: 'ws-a', project: 'pj-a', id: '3b7157ea-legacy', cwd: '/project/here' }]);
  assert.match(report.note ?? '', /current profile config \(ws-a\/pj-a\)/);
  assert.deepEqual(await listRecords(dir), []);
});

test('recovery never trusts an owner that does not match the schema', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t);
  const invalid = [
    'not json',
    JSON.stringify(validOwner('/work/x', { pid: 0 })),
    JSON.stringify(validOwner('/work/x', { pid: 1.5 })),
    JSON.stringify(validOwner('/work/x', { workspace: 'Bad_Name' })),
    JSON.stringify(validOwner('')),
    JSON.stringify({ pid: 4242, workspace: 'ws-a', project: 'pj-a', cwd: '/work/x' }),
  ];
  for (const [index, text] of invalid.entries()) {
    const launch = launchOf(10 + index);
    await seedOwner(dir, launch, text);
    await seedSessions(dir, launch, ['sess-bad']);
  }
  const fake = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: () => false, finalize: fake.finalize, warn: () => undefined });
  assert.deepEqual(report.recovered, []);
  assert.equal(report.skipped.length, invalid.length);
  assert.ok(report.skipped.every(item => item.reason === 'owner-invalid'));
  assert.deepEqual(fake.calls, []);
  assert.equal((await listRecords(dir)).length, invalid.length * 2);
});

test('recovery leaves a launch recorded for another workspace or project and warns', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(4);
  await seedOwner(dir, launch, validOwner('/work/four', { workspace: 'ws-old' }));
  await seedSessions(dir, launch, ['sess-old']);
  const warnings: string[] = [];
  const fake = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: () => false, finalize: fake.finalize, warn: m => warnings.push(m) });
  assert.deepEqual(report, { recovered: [], skipped: [{ launch, reason: 'scope-mismatch' }] });
  assert.deepEqual(fake.calls, []);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0] ?? '', /sess-old/);
  assert.equal((await listRecords(dir)).length, 2);
});

test('the manual recovery finalizes a divergent-scope launch with its recorded scope and lists it as recorded', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(11), warnings: string[] = [];
  await seedOwner(dir, launch, validOwner('/work/eleven', { workspace: 'ws-old', project: 'pj-old' }));
  await seedSessions(dir, launch, ['sess-old']);
  const fake = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, recordedScope: true, isAlive: () => false, finalize: fake.finalize, warn: m => warnings.push(m) });
  assert.deepEqual(report, { recovered: [{ id: 'sess-old', scope: 'recorded' }], skipped: [] });
  assert.deepEqual(fake.calls, [{ workspace: 'ws-old', project: 'pj-old', id: 'sess-old', cwd: '/work/eleven' }]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(await listRecords(dir), []);
});

test('two concurrent recoveries finalize each session exactly once', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(5);
  await seedOwner(dir, launch, validOwner('/work/five'));
  await seedSessions(dir, launch, ['sess-a', 'sess-b']);
  const fake = fakeFinalize({ delayMs: 5 });
  // Claimants 1001 and 1002 are live while they run; the dead owner 4242 is the only one recovery may act on.
  const isAlive = (pid: number): boolean => pid === 1001 || pid === 1002;
  const run = (pid: number) => recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, pid, isAlive, finalize: fake.finalize, warn: () => undefined });
  await Promise.all([run(1001), run(1002)]);
  assert.deepEqual(fake.calls.map(call => call.id).sort(), ['sess-a', 'sess-b']);
  assert.deepEqual(await listRecords(dir), []);
});

test('a claim left by a dead recovery process is claimed again', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(6);
  await seedOwner(dir, launch, validOwner('/work/six'));
  await seedSessions(dir, launch, ['sess-6'], `${launch}.sessions.recovering-999`);
  const fake = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, pid: 1003, isAlive: () => false, finalize: fake.finalize, warn: () => undefined });
  assert.deepEqual(report.recovered, ['sess-6']);
  assert.deepEqual(fake.calls.map(call => call.id), ['sess-6']);
  assert.deepEqual(await listRecords(dir), []);
});

test('a claim held by a live recovery process is left alone', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(7);
  await seedOwner(dir, launch, validOwner('/work/seven'));
  await seedSessions(dir, launch, ['sess-7'], `${launch}.sessions.recovering-888`);
  const fake = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: pid => pid === 888, finalize: fake.finalize, warn: () => undefined });
  assert.deepEqual(report, { recovered: [], skipped: [{ launch, reason: 'claimed-by-other' }] });
  assert.deepEqual(fake.calls, []);
});

test('a failed finalize keeps the failed session and the owner for the next attempt, with a warning', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(8), warnings: string[] = [];
  await seedOwner(dir, launch, validOwner('/work/eight'));
  await seedSessions(dir, launch, ['sess-ok', 'sess-fail']);
  const first = fakeFinalize({ failOn: 'sess-fail' });
  const failed = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, pid: 1003, isAlive: () => false, finalize: first.finalize, warn: m => warnings.push(m) });
  assert.deepEqual(failed, { recovered: ['sess-ok'], skipped: [{ launch, reason: 'finalize-failed' }] });
  assert.deepEqual(first.calls.map(call => call.id), ['sess-ok']);
  assert.equal(warnings.length, 1);
  assert.deepEqual(await listRecords(dir), [`${launch}.owner.json`, `${launch}.sessions.recovering-1003`].sort());
  assert.equal(await readFile(join(launchRecords(dir), `${launch}.sessions.recovering-1003`), 'utf8'), 'sess-fail\n');

  const retry = fakeFinalize();
  const second = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, pid: 1004, isAlive: () => false, finalize: retry.finalize, warn: () => undefined });
  assert.deepEqual(second.recovered, ['sess-fail']);
  assert.deepEqual(retry.calls.map(call => call.id), ['sess-fail']);
  assert.deepEqual(await listRecords(dir), []);
});

test('recovery reads only the directory of the profile it is given', async t => {
  const mine = await recoveryDir(t), other = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(9);
  await seedOwner(other, launch, validOwner('/work/other'));
  await seedSessions(other, launch, ['sess-other']);
  const fake = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: mine, profileDirPath: mine, isAlive: () => false, finalize: fake.finalize, warn: () => undefined });
  assert.deepEqual(report, { recovered: [], skipped: [] });
  assert.deepEqual(fake.calls, []);
  assert.equal((await listRecords(other)).length, 2);
});

test('a live agy client keeps its launch owned while the wrapper is dead, and recovery takes it once both are gone', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(12);
  await seedOwner(dir, launch, validOwner('/work/twelve', { childPid: 5151 }));
  await seedSessions(dir, launch, ['sess-child']);
  const fake = fakeFinalize();
  const live = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: pid => pid === 5151, finalize: fake.finalize, warn: () => undefined });
  assert.deepEqual(live, { recovered: [], skipped: [{ launch, reason: 'owner-alive' }] });
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(await listRecords(dir), [`${launch}.owner.json`, `${launch}.sessions`].sort());
  const dead = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: () => false, finalize: fake.finalize, warn: () => undefined });
  assert.deepEqual(dead.recovered, ['sess-child']);
  assert.deepEqual(await listRecords(dir), []);
});

test('an owner with no sessions is kept while its agy client lives and cleared once it is gone', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(13);
  await seedOwner(dir, launch, validOwner('/work/thirteen', { childPid: 5152 }));
  await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: pid => pid === 5152, finalize: fakeFinalize().finalize, warn: () => undefined });
  assert.deepEqual(await listRecords(dir), [`${launch}.owner.json`]);
  await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: () => false, finalize: fakeFinalize().finalize, warn: () => undefined });
  assert.deepEqual(await listRecords(dir), []);
});

test('an owner written before childPid existed is still read, and a non-positive childPid makes it invalid', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), old = launchOf(14), bad = launchOf(15);
  await seedOwner(dir, old, validOwner('/work/fourteen'));
  await seedSessions(dir, old, ['sess-old']);
  await seedOwner(dir, bad, validOwner('/work/fifteen', { childPid: 0 }));
  await seedSessions(dir, bad, ['sess-bad']);
  const fake = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: () => false, finalize: fake.finalize, warn: () => undefined });
  assert.deepEqual(report.recovered, ['sess-old']);
  assert.deepEqual(report.skipped, [{ launch: bad, reason: 'owner-invalid' }]);
  assert.deepEqual(fake.calls.map(call => call.id), ['sess-old']);
});

test('an id a hook appends during autofinalization is finalized in a later pass and never dropped', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(16);
  const sessions = join(launchRecords(dir), `${launch}.sessions`), calls: string[] = [];
  await seedOwner(dir, launch, validOwner('/work/sixteen'));
  await seedSessions(dir, launch, ['sess-1']);
  t.mock.method(process.stderr, 'write', () => true);
  const finalize = async (_name: string, _c: Config, id: string): Promise<void> => {
    calls.push(id);
    if (calls.length === 1) await appendFile(sessions, 'sess-late\n');
  };
  await finalizeAgyLaunch('unused', config, launch, '/work/sixteen', finalize, dir);
  assert.deepEqual(calls, ['sess-1', 'sess-late']);
  assert.deepEqual(await listRecords(dir), []);
});

test('ids still arriving after the last pass stay recorded with the owner for the next recovery', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(17);
  const sessions = join(launchRecords(dir), `${launch}.sessions`), calls: string[] = [];
  await seedOwner(dir, launch, validOwner('/work/seventeen'));
  await seedSessions(dir, launch, ['sess-1']);
  t.mock.method(process.stderr, 'write', () => true);
  const finalize = async (_name: string, _c: Config, id: string): Promise<void> => {
    calls.push(id);
    await appendFile(sessions, `late-${calls.length}\n`);
  };
  await finalizeAgyLaunch('unused', config, launch, '/work/seventeen', finalize, dir);
  assert.deepEqual(calls, ['sess-1', 'late-1', 'late-2']);
  assert.equal(await readFile(sessions, 'utf8'), 'late-3\n');
  assert.deepEqual(await listRecords(dir), [`${launch}.owner.json`, `${launch}.sessions`].sort());
  const retry = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: () => false, finalize: retry.finalize, warn: () => undefined });
  assert.deepEqual(report.recovered, ['late-3']);
  assert.deepEqual(await listRecords(dir), []);
});

test('a failed autofinalize keeps its claim and owner, and a later recovery with a dead claimant finishes the rest', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(18);
  const claim = `${launch}.sessions.recovering-${process.pid}`;
  await seedOwner(dir, launch, validOwner('/work/eighteen'));
  await seedSessions(dir, launch, ['sess-ok', 'sess-fail']);
  t.mock.method(process.stderr, 'write', () => true);
  const first = fakeFinalize({ failOn: 'sess-fail' });
  await finalizeAgyLaunch('unused', config, launch, '/work/eighteen', first.finalize, dir);
  assert.deepEqual(first.calls.map(call => call.id), ['sess-ok']);
  assert.deepEqual(await listRecords(dir), [`${launch}.owner.json`, claim].sort());
  assert.equal(await readFile(join(launchRecords(dir), claim), 'utf8'), 'sess-fail\n');
  const retry = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, pid: 1005, isAlive: () => false, finalize: retry.finalize, warn: () => undefined });
  assert.deepEqual(report.recovered, ['sess-fail']);
  assert.deepEqual(await listRecords(dir), []);
});

test('finalized ids clear only the antigravity breadcrumb that still holds them, in both finalize paths', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), first = launchOf(19), second = launchOf(20);
  const crumb = join(dir, 'active-session.antigravity-cli');
  await seedOwner(dir, first, validOwner('/work/nineteen'));
  await seedSessions(dir, first, ['sess-done']);
  await writeFile(crumb, 'sess-done');
  await writeFile(join(dir, 'active-session'), 'sess-done');
  t.mock.method(process.stderr, 'write', () => true);
  await finalizeAgyLaunch('unused', config, first, '/work/nineteen', fakeFinalize().finalize, dir);
  await assert.rejects(readFile(crumb, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dir, 'active-session'), 'utf8'), { code: 'ENOENT' });

  await seedOwner(dir, second, validOwner('/work/twenty'));
  await seedSessions(dir, second, ['sess-recovered']);
  await writeFile(crumb, 'sess-other');
  await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, isAlive: () => false, finalize: fakeFinalize().finalize, warn: () => undefined });
  assert.equal(await readFile(crumb, 'utf8'), 'sess-other');
  assert.deepEqual(await listRecords(dir), []);
});

// Windows file locks. The rename that claims a sessions file and the retry wait are injected, so busy renames are simulated without locking anything.
function fakeRename(code: string, fails: number) {
  const calls: string[] = [];
  const rename = (async (from: string, to: string) => {
    calls.push(`${from} -> ${to}`);
    if (calls.length <= fails) throw Object.assign(new Error(`${code}: simulated`), { code });
    await realRename(from, to);
  }) as unknown as typeof realRename;
  return { calls, rename };
}
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number): Promise<void> => { waits.push(ms); } };
}
function captureStderr(t: TestContext): string[] {
  const out: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => { out.push(String(chunk)); return true; });
  return out;
}

test('a sessions file locked by EBUSY twice is still claimed and finalized, and the owner is removed', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(21);
  await seedOwner(dir, launch, validOwner('/work/twenty-one'));
  await seedSessions(dir, launch, ['sess-1', 'sess-2']);
  const stderr = captureStderr(t);
  const locks = fakeRename('EBUSY', 2), pause = fakeSleep(), fake = fakeFinalize();
  await finalizeAgyLaunch('unused', config, launch, '/work/twenty-one', fake.finalize, dir, { rename: locks.rename, sleep: pause.sleep });
  assert.deepEqual(fake.calls.map(call => call.id), ['sess-1', 'sess-2']);
  assert.deepEqual(pause.waits, [100, 100]);
  assert.deepEqual(await listRecords(dir), []);
  assert.deepEqual(stderr, []);
});

test('a sessions file that stays locked is left with its owner, and a later recovery without the lock finishes it', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(22);
  await seedOwner(dir, launch, validOwner('/work/twenty-two'));
  await seedSessions(dir, launch, ['sess-locked']);
  const stderr = captureStderr(t);
  const locks = fakeRename('EBUSY', Infinity), pause = fakeSleep(), first = fakeFinalize();
  await finalizeAgyLaunch('unused', config, launch, '/work/twenty-two', first.finalize, dir, { rename: locks.rename, sleep: pause.sleep });
  assert.deepEqual(first.calls, []);
  assert.deepEqual(await listRecords(dir), [`${launch}.owner.json`, `${launch}.sessions`].sort());
  assert.equal(await readFile(join(launchRecords(dir), `${launch}.sessions`), 'utf8'), 'sess-locked\n');
  assert.equal(stderr.length, 1);
  assert.match(stderr[0] ?? '', /busy; run jev-memory agy-finalize --recover/);
  const retry = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, pid: 1006, isAlive: () => false, finalize: retry.finalize, warn: () => undefined });
  assert.deepEqual(report, { recovered: ['sess-locked'], skipped: [] });
  assert.deepEqual(await listRecords(dir), []);
});

for (const [code, first, second] of [['EPERM', 23, 33], ['EACCES', 24, 34]] as const) {
  test(`a sessions file locked by ${code} is retried like EBUSY, both when it clears and when it stays locked`, async t => {
    const dir = await recoveryDir(t), config = await recoveryConfig(t);
    await seedOwner(dir, launchOf(first), validOwner(`/work/${code}-clears`));
    await seedSessions(dir, launchOf(first), [`sess-${code}`]);
    captureStderr(t);
    const cleared = fakeRename(code, 2), pause = fakeSleep(), fake = fakeFinalize();
    await finalizeAgyLaunch('unused', config, launchOf(first), `/work/${code}-clears`, fake.finalize, dir, { rename: cleared.rename, sleep: pause.sleep });
    assert.deepEqual(fake.calls.map(call => call.id), [`sess-${code}`]);
    assert.deepEqual(pause.waits, [100, 100]);
    assert.deepEqual(await listRecords(dir), []);

    await seedOwner(dir, launchOf(second), validOwner(`/work/${code}-stays`));
    await seedSessions(dir, launchOf(second), [`sess-${code}-stuck`]);
    const stuck = fakeRename(code, Infinity), stuckPause = fakeSleep(), stuckFake = fakeFinalize();
    await finalizeAgyLaunch('unused', config, launchOf(second), `/work/${code}-stays`, stuckFake.finalize, dir, { rename: stuck.rename, sleep: stuckPause.sleep });
    assert.equal(stuck.calls.length, 1 + 5);
    assert.deepEqual(stuckFake.calls, []);
    assert.deepEqual(await listRecords(dir), [`${launchOf(second)}.owner.json`, `${launchOf(second)}.sessions`].sort());
  });
}

test('an error that is not a busy code is not retried, does not throw, and leaves the files in place', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(27);
  await seedOwner(dir, launch, validOwner('/work/twenty-seven'));
  await seedSessions(dir, launch, ['sess-d']);
  const stderr = captureStderr(t);
  const broken = fakeRename('EINVAL', Infinity), pause = fakeSleep(), fake = fakeFinalize();
  await finalizeAgyLaunch('unused', config, launch, '/work/twenty-seven', fake.finalize, dir, { rename: broken.rename, sleep: pause.sleep });
  assert.equal(broken.calls.length, 1);
  assert.deepEqual(pause.waits, []);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(await listRecords(dir), [`${launch}.owner.json`, `${launch}.sessions`].sort());
  assert.deepEqual(stderr, ['Could not finish Antigravity launch tracking: EINVAL: simulated\n']);
});

test('recovery treats a rename that fails as claimed-by-other and loses nothing, and a later recovery finishes the sessions', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(28);
  await seedOwner(dir, launch, validOwner('/work/twenty-eight'));
  await seedSessions(dir, launch, ['sess-e1', 'sess-e2']);
  const locks = fakeRename('EBUSY', Infinity), fake = fakeFinalize();
  const report = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, pid: 1007, isAlive: () => false, finalize: fake.finalize, warn: () => undefined, fsOps: { rename: locks.rename } });
  assert.deepEqual(report, { recovered: [], skipped: [{ launch, reason: 'claimed-by-other' }] });
  assert.equal(locks.calls.length, 1);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(await listRecords(dir), [`${launch}.owner.json`, `${launch}.sessions`].sort());
  assert.equal(await readFile(join(launchRecords(dir), `${launch}.sessions`), 'utf8'), 'sess-e1\nsess-e2\n');
  const retry = fakeFinalize();
  const second = await recoverAgyLaunches('unused', { config, cwd: dir, profileDirPath: dir, pid: 1008, isAlive: () => false, finalize: retry.finalize, warn: () => undefined });
  assert.deepEqual(second.recovered, ['sess-e1', 'sess-e2']);
  assert.deepEqual(await listRecords(dir), []);
});

test('a busy sessions file is tried once and then retried exactly five times, with no real wait', async t => {
  const dir = await recoveryDir(t), config = await recoveryConfig(t), launch = launchOf(29);
  await seedOwner(dir, launch, validOwner('/work/twenty-nine'));
  await seedSessions(dir, launch, ['sess-f']);
  captureStderr(t);
  const locks = fakeRename('EBUSY', Infinity), pause = fakeSleep(), fake = fakeFinalize();
  await finalizeAgyLaunch('unused', config, launch, '/work/twenty-nine', fake.finalize, dir, { rename: locks.rename, sleep: pause.sleep });
  assert.equal(locks.calls.length, 1 + 5);
  assert.deepEqual(pause.waits, [100, 100, 100, 100, 100]);
  assert.deepEqual(fake.calls, []);
});

test('a SIGHUP finalizes once, exits with the agy code when known, and stops listening afterwards', async () => {
  const host = new EventEmitter();
  let finishes = 0;
  const exits: number[] = [];
  const exited = new Promise<number>(ok => { const stop = setInterval(() => { if (exits.length) { clearInterval(stop); ok(exits[0] ?? -1); } }, 1); });
  const disarm = armAgyHangup({ host, finish: async () => { finishes++; await new Promise(ok => setTimeout(ok, 5)); }, budgetMs: 500, exit: code => { exits.push(code); }, exitCode: () => 3 });
  host.emit('SIGHUP'); host.emit('SIGHUP');
  assert.equal(await exited, 3);
  await new Promise(ok => setTimeout(ok, 20));
  assert.equal(finishes, 1);
  assert.deepEqual(exits, [3]);
  disarm();
  assert.equal(host.listenerCount('SIGHUP'), 0);
});

test('a SIGHUP whose finalize never finishes exits at the budget with 129 when agy has not reported a code', async () => {
  const host = new EventEmitter();
  const exits: number[] = [];
  const started = Date.now();
  const exited = new Promise<number>(ok => { const stop = setInterval(() => { if (exits.length) { clearInterval(stop); ok(exits[0] ?? -1); } }, 1); });
  const disarm = armAgyHangup({ host, finish: () => new Promise<void>(() => undefined), budgetMs: 40, exit: code => { exits.push(code); }, exitCode: () => undefined });
  host.emit('SIGHUP');
  assert.equal(await exited, 129);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 35 && elapsed < 2_000, `budget not respected: ${elapsed} ms`);
  disarm();
});

test('the hangup budget is about seven seconds', () => {
  assert.equal(AGY_HANGUP_BUDGET_MS, 7_000);
});
