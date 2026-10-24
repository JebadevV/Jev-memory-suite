import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { access, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { assertWithin, prepare, profileDir, readConfig, root, workspaceDir, type Config } from './config.js';
import { atomicJson, baseEnv, sleep, token } from './local.js';
import { control, running, start } from './lifecycle.js';
import { probeGateway, upstreamGateways } from './gateways.js';
import { headroomRoute, type HeadroomRoute } from './headroom.js';
import { gatewayDir, memoryBinary } from './install.js';
import { agyExecutable, antigravityMcpState, bridgeEntry, hookEntries, serverId } from './clients.js';
import { AGY_LAUNCH_ENV, launchSessionsFile, readLaunchSessions } from './hook.js';
import { projectScopeMarker } from './scope.js';

export type Client = 'claude' | 'codex';
type LaunchHost = Client | 'antigravity';
export interface LaunchPlan { args: string[]; env: NodeJS.ProcessEnv; files: string[]; marker: string | undefined }

const rootManifestNames: Record<LaunchHost, string> = { claude: '.jev-memory-claude.json', codex: '.jev-memory-codex.json', antigravity: '.jev-memory-antigravity.json' };
const markerName = '.ai-memory.toml';
const registrationSchema = z.object({ profile: z.string() });
const codexHooksWarning = 'Codex hooks are not registered for this workspace, so capture requires `clients install codex .` and native /hooks trust review; this launch does not trust hooks.';

export function clientName(client: string): Client {
  if (client === 'claude' || client === 'codex') return client;
  throw new Error('Client must be claude or codex; launch Desktop through its native app');
}
export async function clientCommand(client: string): Promise<{ command: string; prefix: string[] }> {
  clientName(client);
  if (process.platform !== 'win32') return { command: client, prefix: [] };
  const exec = promisify(execFile);
  try {
    const exe = (await exec('where.exe', [`${client}.exe`])).stdout.trim().split(/\r?\n/)[0];
    if (exe) return { command: exe, prefix: [] };
  } catch { /* npm launcher may be JavaScript. */ }
  if (client === 'codex' && process.env.LOCALAPPDATA) {
    // Desktop also ships a standalone CLI; use it without changing the user's PATH.
    const bundled = resolve(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe');
    if (await access(bundled).then(() => true, () => false)) return { command: bundled, prefix: [] };
  }
  if (client === 'claude') {
    const launcher = (await exec('where.exe', ['claude.cmd'])).stdout.trim().split(/\r?\n/)[0];
    if (launcher) {
      const script = resolve(dirname(launcher), 'node_modules/@anthropic-ai/claude-code/cli.js');
      await access(script); return { command: process.execPath, prefix: [script] };
    }
  }
  throw new Error('Native CLI executable not found');
}
// Pure check: a registration of another profile must block launch; our own registration needs no duplicate flags.
export function ownRootRegistration(name: string, manifest: unknown): boolean {
  if (manifest === undefined) return false;
  const parsed = registrationSchema.safeParse(manifest);
  if (!parsed.success) throw new Error('Workspace client registration is unreadable; remove it or repair it before launching');
  if (parsed.data.profile !== name)
    throw new Error(`Workspace client registration belongs to profile ${parsed.data.profile}; remove it or launch with that profile`);
  return true;
}
// The native client reads project files from its working directory, so the registration lives there.
async function readDirManifest(client: LaunchHost, cwd: string): Promise<unknown> {
  const path = resolve(cwd, rootManifestNames[client]);
  await assertWithin(cwd, path);
  const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
  return text === undefined ? undefined : JSON.parse(text.replace(/^﻿/, '')) as unknown;
}
function codexMemoryArgs(name: string): string[] {
  const bridge = bridgeEntry(name);
  return ['-c', `mcp_servers.${serverId}.command=${JSON.stringify(bridge.command)}`, '-c', `mcp_servers.${serverId}.args=${JSON.stringify(bridge.args)}`];
}
// Claude gets per-profile files so the MCP server and hooks match the selected profile, without --strict-mcp-config.
async function claudeMemoryFiles(name: string): Promise<{ args: string[]; files: string[] }> {
  const dir = resolve(profileDir(name), 'launch');
  await prepare(dir);
  const mcp = resolve(dir, 'claude-mcp.json'), settings = resolve(dir, 'claude-settings.json');
  await atomicJson(mcp, { mcpServers: { [serverId]: bridgeEntry(name, 'claude-code') } });
  // Claude settings expect each event to hold an array of matcher groups.
  await atomicJson(settings, { hooks: Object.fromEntries(Object.entries(hookEntries(name, 'claude-code')).map(([event, group]) => [event, [group]])) });
  return { args: ['--mcp-config', mcp, '--settings', settings], files: [mcp, settings] };
}
async function gatewayArgs(client: Client, name: string, port: number, env: NodeJS.ProcessEnv): Promise<string[]> {
  const key = await token(profileDir(name), 'router-token'), base = `http://127.0.0.1:${port}`;
  if (client === 'claude') {
    env.ANTHROPIC_BASE_URL = base; env.ANTHROPIC_AUTH_TOKEN = key; delete env.ANTHROPIC_API_KEY;
    return [];
  }
  env.JMS_ROUTER_KEY = key;
  return ['-c', 'model_provider="jev_memory_suite"', '-c', 'model_providers.jev_memory_suite.name="Jev Memory Suite"',
    '-c', `model_providers.jev_memory_suite.base_url=${JSON.stringify(`${base}/v1`)}`,
    '-c', 'model_providers.jev_memory_suite.wire_api="responses"', '-c', 'model_providers.jev_memory_suite.env_key="JMS_ROUTER_KEY"'];
}
// Hook capture uses --capture-mode allowlist, so a marker that matches the profile scope is required.
async function checkScopeMarker(client: LaunchHost, cwd: string, scope: Pick<Config, 'workspace' | 'project' | 'projectRoot'>): Promise<string | undefined> {
  const path = await projectScopeMarker(cwd, scope);
  if (path === undefined) {
    process.stderr.write(`No ${markerName} scope marker in this project: hook capture is disabled (allowlist). Run: node "${resolve(root, 'bin/jev-memory.mjs')}" --dir "${cwd}" clients install ${client} .\n`);
    return undefined;
  }
  return path;
}
// Builds flags and environment without spawning or contacting the supervisor.
export async function planLaunch(client: Client, name: string, cwd = root): Promise<LaunchPlan> {
  const c = await readConfig(name), env: NodeJS.ProcessEnv = { ...process.env }, args: string[] = [], files: string[] = [];
  cwd = await workspaceDir(cwd, c.projectRoot ?? root);
  const registered = ownRootRegistration(name, await readDirManifest(client, cwd));
  const warn = (message: string) => process.stderr.write(`${message}\n`);
  let marker: string | undefined;
  if (c.memory.enabled) {
    marker = await checkScopeMarker(client, cwd, c);
    if (client === 'codex') {
      args.push(...codexMemoryArgs(name));
      if (!registered) warn(codexHooksWarning);
    } else if (!registered) {
      const memory = await claudeMemoryFiles(name);
      args.push(...memory.args); files.push(...memory.files);
    }
  } else if (registered) {
    warn(`Workspace ${client} registration for ${name} is still loaded by project files while memory is disabled.`);
  }
  if (c.gateway.enabled) args.push(...await gatewayArgs(client, name, c.gateway.port, env));
  return { args, env, files, marker };
}
const codexSubcommands = new Set(['exec', 'e', 'resume', 'review', 'fork']);
// codex subcommands ignore -c overrides placed before them, so plan overrides go right after the subcommand.
export function nativeArgv(client: Client, planArgs: string[], userArgs: string[]): string[] {
  const [first, ...rest] = userArgs;
  if (client === 'codex' && first !== undefined && codexSubcommands.has(first)) return [first, ...planArgs, ...rest];
  return [...planArgs, ...userArgs];
}
export async function launch(client: string, name: string, args: string[], dir = '.'): Promise<void> {
  const supported = clientName(client), c = await readConfig(name), cwd = await workspaceDir(resolve(dir), c.projectRoot ?? root), executable = await clientCommand(supported);
  if (c.memory.enabled || c.gateway.enabled) {
    const state = await control(name, 'status'); if (state.phase !== 'ready') throw new Error('Start healthy suite services first');
  }
  const plan = await planLaunch(supported, name, cwd);
  await new Promise<void>((ok, fail) => {
    const child = spawn(executable.command, [...executable.prefix, ...nativeArgv(supported, plan.args, args)],{ cwd, env: plan.env, shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', fail); child.once('exit', code => code === 0 ? ok() : fail(new Error(`${supported} exit ${code}`)));
  });
}

// Upstream launcher flags are handled by jev-<client> itself; memory arguments must not be added to them.
export const launcherFlags = new Set(['--dashboard', '--status', '--stop', '--start', '--setup', '--logs', '--routing', '--print-config', '--gateway-help']);
// The upstream launcher prefixes codex's spec overrides before the argv, which codex subcommands ignore.
export function hasCodexSubcommand(client: Client, userArgs: string[]): boolean {
  return client === 'codex' && codexSubcommands.has(userArgs[0] ?? '');
}
export function jevLauncherArgv(client: Client, planArgs: string[], userArgs: string[], providerArgs: string[] = []): { passthrough: boolean; argv: string[] } {
  if (launcherFlags.has(userArgs[0] ?? '')) return { passthrough: true, argv: userArgs };
  if (hasCodexSubcommand(client, userArgs)) {
    const [subcommand = '', ...rest] = userArgs;
    return { passthrough: false, argv: [subcommand, ...providerArgs, ...planArgs, ...rest] };
  }
  return { passthrough: false, argv: nativeArgv(client, planArgs, userArgs) };
}
export function jevLauncherPath(client: Client, dir = gatewayDir()): string {
  return resolve(dir, 'bin', `jev-${client}.mjs`);
}
interface UpstreamCodexSpec { portEnv: string; defaultPort: number; args: (origin: string) => string[] }
// Loads the installed upstream codex spec so the suite reuses its provider overrides instead of copying them.
export async function loadUpstreamCodexSpec(dir = gatewayDir()): Promise<UpstreamCodexSpec> {
  const mod = await import(pathToFileURL(resolve(dir, 'bin', 'clients.mjs')).href) as { codex?: Partial<UpstreamCodexSpec> };
  const spec = mod.codex;
  if (!spec || typeof spec.args !== 'function' || typeof spec.portEnv !== 'string' || typeof spec.defaultPort !== 'number')
    throw new Error('Installed gateway clients.mjs has no usable codex spec');
  return spec as UpstreamCodexSpec;
}
// Provider overrides for codex subcommands, using the same port source as the upstream launcher.
export async function codexProviderArgs(dir = gatewayDir()): Promise<string[]> {
  const spec = await loadUpstreamCodexSpec(dir);
  const port = Number(process.env[spec.portEnv] ?? spec.defaultPort);
  return spec.args(`http://127.0.0.1:${port}`);
}
export async function ensureServicesReady(name: string, services: string[]): Promise<void> {
  if (!(await running(name))) await start(name);
  const state = await control(name, 'status');
  const current = state.services as Record<string, unknown> | undefined;
  for (const service of services) {
    if (current?.[service] !== 'ready') throw new Error(`${service} service is not ready; run doctor`);
  }
}
// Env the suite adds when it starts an upstream router: the configured routing experiment only.
export function gatewayLaunchEnv(client: Client, c: Config): Record<string, string> {
  const env: Record<string, string> = {};
  const mode = c.gatewayExperiment[client];
  if (mode === 'shadow') Object.assign(env, { JEV_ROUTING: 'true', JEV_SHADOW: 'true' });
  if (mode === 'metering') Object.assign(env, { JEV_ROUTING: 'false', JEV_SHADOW: 'false' });
  return env;
}
// Opens the local URL in the default browser without blocking the CLI.
export function openBrowser(url: string): void {
  const win = process.platform === 'win32';
  const command = win ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = win ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
  child.once('error', () => process.stderr.write('Could not open a browser; open the dashboard URL manually.\n'));
  child.unref();
}
// Shared by `dashboard` and `claude|codex --dashboard`: the suite page embeds the Jev dashboard, so both open the same URL.
export async function openDashboard(name: string): Promise<string> {
  const { dashboard } = await readConfig(name);
  await ensureServicesReady(name, ['memory', 'dashboard']);
  const url = `http://127.0.0.1:${dashboard.port}/`;
  openBrowser(url);
  return url;
}
// Direct claude spawn for Headroom: argv matches launch(), and only ANTHROPIC_BASE_URL changes, so the other auth variables reach Claude as before.
export function headroomClaudeSpawn(executable: { command: string; prefix: string[] }, planArgs: string[], userArgs: string[], env: NodeJS.ProcessEnv, baseUrl: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return { command: executable.command, args: [...executable.prefix, ...nativeArgv('claude', planArgs, userArgs)], env: { ...env, ANTHROPIC_BASE_URL: baseUrl } };
}
// Direct codex spawn for Headroom: the argv is the one the upstream launcher builds (its provider overrides, then the suite argv), with the Headroom origin, and env is passed through unchanged.
export function headroomCodexSpawn(executable: { command: string; prefix: string[] }, planArgs: string[], userArgs: string[], env: NodeJS.ProcessEnv, providerArgs: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return { command: executable.command, args: [...executable.prefix, ...providerArgs, ...jevLauncherArgv('codex', planArgs, userArgs, providerArgs).argv], env };
}
export interface HeadroomSpawn { command: string; args: string[]; env: NodeJS.ProcessEnv }
export type HeadroomSpawnResult = { ok: true; spec: HeadroomSpawn } | { ok: false; reason: string };
export interface CodexSpawnDeps { executable: () => Promise<{ command: string; prefix: string[] }>; spec: () => Promise<UpstreamCodexSpec> }
// Builds the codex spawn for a Headroom route. Any failure before spawn becomes a reason, so the caller keeps the upstream launcher.
export async function buildCodexHeadroomSpawn(baseUrl: string, planArgs: string[], userArgs: string[], env: NodeJS.ProcessEnv,
  deps: CodexSpawnDeps = { executable: () => clientCommand('codex'), spec: () => loadUpstreamCodexSpec() }): Promise<HeadroomSpawnResult> {
  try {
    const executable = await deps.executable();
    const providerArgs = (await deps.spec()).args(baseUrl);
    return { ok: true, spec: headroomCodexSpawn(executable, planArgs, userArgs, env, providerArgs) };
  } catch {
    return { ok: false, reason: 'Codex provider spec unavailable' };
  }
}
// Starts or reuses the Jev gateway for the client through its own launcher; stdin stays attached so its first-run key prompt still works.
// Its stdout ("router up on ...") goes to stderr, so `claude -p --output-format json` output stays parseable.
function startJev(client: Client, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise<boolean>(ok => {
    const child = spawn(process.execPath, [jevLauncherPath(client), '--start'], { cwd: root, env, shell: false, windowsHide: true, stdio: ['inherit', 2, 2] });
    child.once('error', () => ok(false)); child.once('exit', code => ok(code === 0));
  });
}
// Any failure reads as not live, so the caller falls back to the upstream launcher.
async function headroomLive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/livez`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    await res.body?.cancel();
    return res.ok;
  } catch { return false; }
}
export interface HeadroomWaitOptions { timeoutMs: number; intervalMs: number; sleep: (ms: number) => Promise<void> }
// Headroom starts in the background, so its state is polled while it is still starting or restarting; the last status is returned at timeout.
export async function waitForHeadroom(read: () => Promise<Record<string, unknown>>, options: HeadroomWaitOptions): Promise<Record<string, unknown>> {
  const transient = (status: Record<string, unknown>): boolean => {
    const state = (status.services as Record<string, unknown> | undefined)?.headroom;
    return state === 'starting' || state === 'restarting';
  };
  // Waiting is counted in intervals rather than wall-clock time, so an injected sleep stays deterministic.
  let waited = 0;
  for (;;) {
    const status = await read();
    if (!transient(status) || waited >= options.timeoutMs) return status;
    await options.sleep(options.intervalMs);
    waited += options.intervalMs;
  }
}
// Decides whether the client goes through Headroom. Never throws: a check that cannot finish is a reason to skip Headroom.
export async function prepareHeadroom(name: string, c: Config, env: NodeJS.ProcessEnv, client: Client = 'claude'): Promise<HeadroomRoute> {
  try {
    // The opt-out is checked before anything starts, so JMS_HEADROOM=off has no side effects.
    if (process.env.JMS_HEADROOM === 'off')
      return headroomRoute({ enabled: c.headroom.enabled, optOut: true, serviceState: undefined, upstreamPort: undefined, jevPort: 0, live: false, port: c.headroom.port });
    // Memory-enabled profiles already started the supervisor; otherwise Headroom needs it running on its own.
    if (!(await running(name))) await start(name);
    if (!(await startJev(client, env))) return { use: false, reason: `jev-${client} --start failed` };
    // Python startup can take several seconds, so the decision uses the status after any background start settles.
    const status = await waitForHeadroom(() => control(name, 'status'), { timeoutMs: 60_000, intervalMs: 500, sleep });
    const services = status.services as Record<string, unknown> | undefined;
    const headroom = status.headroom as Record<string, unknown> | undefined;
    const serviceState = typeof services?.headroom === 'string' ? services.headroom : undefined;
    // Codex traffic is routed only when the supervisor launched the Codex shim; otherwise the supervisor's reason is shown.
    if (client === 'codex' && headroom?.codex !== true) {
      const reason = typeof status.headroomCodexReason === 'string' ? status.headroomCodexReason : undefined;
      return { use: false, reason: `Headroom Codex routing is not active${reason ? `: ${reason}` : ''}` };
    }
    // Each client has its own Headroom upstream port: the Claude gateway for Claude, the Codex gateway for Codex.
    const upstreamField = client === 'claude' ? 'upstreamPort' : 'codexUpstreamPort';
    const routedPort = headroom?.[upstreamField];
    const upstreamPort = typeof routedPort === 'number' ? routedPort : undefined;
    const jevPort = (await upstreamGateways(process.env)).find(gateway => gateway.client === client)?.port;
    if (jevPort === undefined) return { use: false, reason: `Jev ${client} gateway port is unknown` };
    if ((await probeGateway(`http://127.0.0.1:${jevPort}`)).state !== 'running')
      return { use: false, reason: client === 'claude' ? 'Jev gateway is not running' : 'Jev codex gateway is not running' };
    return headroomRoute({ enabled: c.headroom.enabled, optOut: false, serviceState, upstreamPort, jevPort, live: await headroomLive(c.headroom.port), port: c.headroom.port });
  } catch {
    return { use: false, reason: 'Headroom check failed' };
  }
}

// Runs the upstream jev-<client> launcher, which owns the gateway and the client's own login.
export async function jevLaunch(client: string, name: string, userArgs: string[], dir = '.'): Promise<void> {
  const supported = clientName(client);
  if (userArgs[0] === '--dashboard') { console.log(await openDashboard(name)); return; }
  const c = await readConfig(name), cwd = await workspaceDir(resolve(dir), c.projectRoot ?? root);
  if (c.gateway.enabled) throw new Error('The suite gateway is enabled for this profile; jev-<client> owns the gateway. Disable gateway in the profile or use `launch`.');
  const passthrough = launcherFlags.has(userArgs[0] ?? '');
  const plan = passthrough ? undefined : await planLaunch(supported, name, cwd);
  const providerArgs = hasCodexSubcommand(supported, userArgs) ? await codexProviderArgs() : [];
  const { argv } = jevLauncherArgv(supported, plan?.args ?? [], userArgs, providerArgs);
  if (!passthrough && c.memory.enabled) await ensureServicesReady(name, ['memory']);
  const env = { ...(plan?.env ?? process.env) };
  env.HOST = '127.0.0.1';
  // The upstream launcher reuses an already-running router, so these only take effect when the router (re)starts.
  Object.assign(env, gatewayLaunchEnv(supported, c));
  if (!passthrough && process.platform === 'win32') {
    const executable = await clientCommand(supported);
    if (executable.prefix.length === 0) {
      const key = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
      env[key] = `${dirname(executable.command)};${env[key] ?? ''}`;
    }
  }
  // Headroom only ever replaces the launcher before the client starts; any other outcome keeps the upstream path below.
  if (!passthrough && c.headroom.enabled && (supported === 'claude' || (supported === 'codex' && c.headroom.codex))) {
    const route = await prepareHeadroom(name, c, env, supported);
    // Codex is started directly with the Headroom origin in its provider overrides; any failure while building that spawn keeps the upstream launcher.
    const built: HeadroomSpawnResult = route.use
      ? supported === 'claude'
        ? { ok: true, spec: headroomClaudeSpawn(await clientCommand('claude'), plan?.args ?? [], userArgs, env, route.baseUrl) }
        : await buildCodexHeadroomSpawn(route.baseUrl, plan?.args ?? [], userArgs, env)
      : { ok: false, reason: route.reason };
    if (built.ok) {
      const spec = built.spec;
      await new Promise<void>((ok, fail) => {
        const child = spawn(spec.command, spec.args, { cwd, env: spec.env, shell: false, windowsHide: true, stdio: 'inherit' });
        child.once('error', fail); child.once('exit', code => code === 0 ? ok() : fail(new Error(`${supported} exit ${code}`)));
      });
      return;
    }
    process.stderr.write(`Headroom not used: ${built.reason}; launching through jev-${supported}.\n`);
  }
  await new Promise<void>((ok, fail) => {
    const child = spawn(process.execPath, [jevLauncherPath(supported), ...argv], { cwd, env, shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', fail); child.once('exit', code => code === 0 ? ok() : fail(new Error(`${supported} exit ${code}`)));
  });
}

// Antigravity has no session-end hook. `agy` launches record their conversation ids under a per-launch id, and the wrapper finalizes them after the client exits.
const agySessionId = /^[A-Za-z0-9._:-]{1,200}$/;
// Pure: `--reopen` lets a conversation continued with `agy -c` be finalized again; without a session id the native side picks the latest open one.
export function agyFinalizeArgs(c: Pick<Config, 'workspace' | 'project'>, dataDir: string, sessionId?: string): string[] {
  const session = sessionId === undefined ? [] : ['--session-id', sessionId, '--reopen'];
  return ['--data-dir', dataDir, 'finalize-session', '--agent', 'antigravity-cli', ...session,
    '--workspace', c.workspace, '--project', c.project, '--json'];
}
const execFileAsync = promisify(execFile);
// Validates the id before anything runs; the native finalize uses the memory data dir and the profile's server port.
export async function finalizeAgySession(name: string, c: Config, sessionId: string | undefined, cwd: string): Promise<string> {
  if (sessionId !== undefined && (!agySessionId.test(sessionId) || sessionId.startsWith('-')))
    throw new Error('Invalid Antigravity session id');
  const { stdout } = await execFileAsync(memoryBinary(), agyFinalizeArgs(c, resolve(profileDir(name), 'memory'), sessionId), {
    cwd, env: { ...baseEnv(), AI_MEMORY_SERVER_URL: `http://127.0.0.1:${c.memory.port}` }, windowsHide: true, shell: false, timeout: 60_000, encoding: 'utf8'
  });
  return stdout;
}
// Ctrl+C reaches agy through the shared console; the wrapper ignores it so it can still finalize the launch.
async function runAgy(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const ignore = () => undefined;
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
  for (const signal of signals) process.on(signal, ignore);
  try {
    return await new Promise<number>((ok, fail) => {
      const child = spawn(exe, args, { cwd, env, shell: false, windowsHide: true, stdio: 'inherit' });
      child.once('error', fail); child.once('exit', code => ok(code ?? 1));
    });
  } finally {
    for (const signal of signals) process.off(signal, ignore);
  }
}
// Finalization problems are reported but never change agy's exit code.
async function finalizeAgyLaunch(name: string, c: Config, launchId: string, cwd: string): Promise<void> {
  try {
    const ids = await readLaunchSessions(profileDir(name), launchId);
    for (const id of ids) {
      try { await finalizeAgySession(name, c, id, cwd); }
      catch (error) {
        const message = error instanceof Error ? error.message : 'finalize failed';
        process.stderr.write(`Could not finalize Antigravity session ${id}: ${message}; run jev-memory agy-finalize --session ${id}\n`);
      }
    }
    await unlink(launchSessionsFile(profileDir(name), launchId)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'launch cleanup failed';
    process.stderr.write(`Could not finish Antigravity launch tracking: ${message}\n`);
  }
}
// Runs the native agy binary with the user's arguments unchanged. No gateway: Antigravity traffic is not routed through the Jev gateway.
export async function agyLaunch(name: string, userArgs: string[], dir = '.'): Promise<number> {
  const c = await readConfig(name), cwd = await workspaceDir(resolve(dir), c.projectRoot ?? root), exe = await agyExecutable();
  if (c.memory.enabled) {
    await ensureServicesReady(name, ['memory']);
    const warn = (message: string) => process.stderr.write(`${message}\n`);
    const registered = ownRootRegistration(name, await readDirManifest('antigravity', cwd));
    if (!registered) warn('Antigravity hooks are not registered for this workspace; capture and handoffs need `jev-memory clients install antigravity .`');
    const mcp = await antigravityMcpState(name);
    if (mcp !== 'registered') warn(`Antigravity MCP state: ${mcp}; run jev-memory clients install antigravity .`);
    await checkScopeMarker('antigravity', cwd, c);
  }
  const launchId = randomBytes(16).toString('hex');
  const code = await runAgy(exe, userArgs, cwd, { ...process.env, [AGY_LAUNCH_ENV]: launchId });
  if (c.memory.enabled) await finalizeAgyLaunch(name, c, launchId, cwd);
  return code;
}
// Finds `agy` before option parsing, so Antigravity's own flags reach the client unchanged (like delegatedCommand for codex/claude).
export function agyDelegation(raw: string[]): { head: string[]; rest: string[] } | undefined {
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i] ?? '';
    if (arg === '--profile' || arg === '--dir') { i++; continue; }
    if (arg.startsWith('-')) continue;
    return arg === 'agy' ? { head: raw.slice(0, i), rest: raw.slice(i + 1) } : undefined;
  }
  return undefined;
}
