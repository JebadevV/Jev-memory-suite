import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { access, readdir, readFile, rename, unlink, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { assertWithin, prepare, profileDir, profileName, readConfig, root, workspaceDir, type Config } from './config.js';
import { atomicJson, baseEnv, sleep, token } from './local.js';
import { control, running, start } from './lifecycle.js';
import { probeGateway, upstreamGateways } from './gateways.js';
import { headroomRoute, type HeadroomRoute } from './headroom.js';
import { gatewayDir, memoryBinary } from './install.js';
import { agyExecutable, antigravityMcpState, bridgeEntry, hookEntries, serverId } from './clients.js';
import { AGY_LAUNCH_ENV, clearActiveSession, launchSessionsFile } from './hook.js';
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
async function runAgy(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onSpawn?: (pid: number) => void): Promise<number> {
  const ignore = () => undefined;
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
  for (const signal of signals) process.on(signal, ignore);
  try {
    return await new Promise<number>((ok, fail) => {
      const child = spawn(exe, args, { cwd, env, shell: false, windowsHide: true, stdio: 'inherit' });
      child.once('error', fail); child.once('exit', code => ok(code ?? 1));
      if (child.pid !== undefined) onSpawn?.(child.pid);
    });
  } finally {
    for (const signal of signals) process.off(signal, ignore);
  }
}
// Missing files are expected: every cleanup step may find its file already gone.
const ignoreMissing = (error: unknown): void => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; };
// Launch owner record: written when a launch starts, removed once its sessions are finalized. It holds ids and scope only, never conversation content.
export const AGY_HANGUP_BUDGET_MS = 7_000;
const agyLaunchIdPattern = /^[a-f0-9]{32}$/;
const agyOwnerSchema = z.object({
  pid: z.number().int().positive().max(2_147_483_647),
  childPid: z.number().int().positive().max(2_147_483_647).optional(), // the agy client; a killed wrapper leaves it running
  startedAt: z.iso.datetime(),
  workspace: profileName,
  project: profileName,
  cwd: z.string().min(1).max(4096),
});
export type AgyOwner = z.infer<typeof agyOwnerSchema>;
export type AgyScope = Pick<AgyOwner, 'workspace' | 'project' | 'cwd'>;
const agyLaunchDir = (dir: string): string => resolve(dir, 'launch', 'agy');
const agyOwnerFile = (dir: string, launchId: string): string => join(agyLaunchDir(dir), `${launchId}.owner.json`);
// A claimed sessions file is renamed to this name by the process that finalizes it; the pid lets a later recovery tell a dead claimant from a live one.
const agyClaimFile = (dir: string, launchId: string, pid: number): string => join(agyLaunchDir(dir), `${launchId}.sessions.recovering-${pid}`);
export async function writeAgyOwner(dir: string, launchId: string, scope: AgyScope, now = new Date(), childPid?: number): Promise<void> {
  if (!agyLaunchIdPattern.test(launchId)) throw new Error('Invalid Antigravity launch id');
  await mkdir(agyLaunchDir(dir), { recursive: true });
  // JSON drops an undefined childPid, so an owner written before agy starts keeps the old shape.
  await atomicJson(agyOwnerFile(dir, launchId), { pid: process.pid, startedAt: now.toISOString(), ...scope, childPid });
}
// Pure check for a live pid: ESRCH means gone; EPERM means alive but not ours; any other failure counts as alive so nothing live is touched.
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
// Session ids that finalize would accept, deduplicated. A missing file reads as no sessions.
async function readSessionIds(file: string): Promise<string[]> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return [...new Set(text.split(/\r?\n/).filter(line => agySessionId.test(line) && !line.startsWith('-')))];
}
async function writeTextAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try { await writeFile(tmp, text, { mode: 0o600, flag: 'wx' }); await rename(tmp, file); }
  catch (error) { await unlink(tmp).catch(ignoreMissing); throw error; }
}
// Removes one finalized id. The file is re-read first so ids recorded meanwhile survive; an empty file is removed.
async function dropSessionId(file: string, id: string): Promise<void> {
  const remaining = (await readSessionIds(file)).filter(line => line !== id);
  if (remaining.length === 0) { await unlink(file).catch(ignoreMissing); return; }
  await writeTextAtomic(file, `${remaining.join('\n')}\n`);
}
// Finalizes the sessions of one file in order. A success leaves the file at once, so a later attempt never repeats it; a failure stays listed for retry.
async function finalizeSessionsFile(file: string, finalizeOne: (id: string) => Promise<unknown>, onError: (id: string, error: unknown) => void): Promise<{ done: string[]; failed: number }> {
  const done: string[] = []; let failed = 0;
  for (const id of await readSessionIds(file)) {
    try { await finalizeOne(id); }
    catch (error) { failed++; onError(id, error); continue; }
    done.push(id);
    await dropSessionId(file, id);
  }
  return { done, failed };
}
// Runs a launch's finalization once, whichever of the normal exit and a hangup asks first.
export function onceAsync(task: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => { pending ??= task(); return pending; };
}
export interface SignalHost { on(event: string, listener: () => void): unknown; off(event: string, listener: () => void): unknown }
// Closing the console sends SIGHUP. The handler finalizes at once within a total budget, then exits with agy's code or 129; past the budget the next launch's recovery takes over.
export function armAgyHangup(options: { host: SignalHost; finish: () => Promise<void>; budgetMs: number; exit: (code: number) => void; exitCode: () => number | undefined }): () => void {
  let fired = false;
  const onHangup = (): void => {
    if (fired) return;
    fired = true;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>(done => { timer = setTimeout(done, options.budgetMs); });
    void Promise.race([options.finish().catch(() => undefined), deadline]).finally(() => {
      clearTimeout(timer);
      options.exit(options.exitCode() ?? 129);
    });
  };
  options.host.on('SIGHUP', onHangup);
  return () => options.host.off('SIGHUP', onHangup);
}
// A hook can append to the sessions file while it is finalized, so each pass claims what is there and a later pass takes the rest.
const agyFinalizePasses = 3;
// Windows reports a file a hook still holds open as busy; a few short retries clear it, and recovery takes whatever remains.
const agyRenameRetries = 5;
const agyRenameRetryMs = 100;
const agyBusyCodes = new Set(['EBUSY', 'EPERM', 'EACCES']);
// Test seam: the rename that claims a sessions file and the wait between busy retries. Omitted, the real ones are used.
export interface AgyFsOps { rename?: typeof rename; sleep?: (ms: number) => Promise<void> }
// 'none' means no sessions file; 'busy' means it stayed locked through every retry.
async function claimSessions(from: string, to: string, fsOps: AgyFsOps = {}): Promise<'claimed' | 'none' | 'busy'> {
  const doRename = fsOps.rename ?? rename, doSleep = fsOps.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try { await doRename(from, to); return 'claimed'; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 'none';
      if (code === undefined || !agyBusyCodes.has(code)) throw error;
      if (attempt >= agyRenameRetries) return 'busy';
      await doSleep(agyRenameRetryMs);
    }
  }
}
const fileExists = (file: string): Promise<boolean> => access(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
// Finalization problems are reported but never change agy's exit code. A session that fails stays recorded with the owner, so the next recovery retries it.
export async function finalizeAgyLaunch(name: string, c: Config, launchId: string, cwd: string, finalize: AgyFinalize, dir = profileDir(name), fsOps: AgyFsOps = {}): Promise<void> {
  const sessions = launchSessionsFile(dir, launchId), claim = agyClaimFile(dir, launchId, process.pid), owner = agyOwnerFile(dir, launchId);
  const finalizeOne = async (id: string): Promise<void> => {
    await finalize(name, c, id, cwd);
    await clearActiveSession(dir, 'antigravity-cli', id).catch(() => undefined);
  };
  try {
    for (let pass = 0; pass < agyFinalizePasses; pass++) {
      const claimed = await claimSessions(sessions, claim, fsOps);
      if (claimed === 'none') break;
      if (claimed === 'busy') { process.stderr.write('Antigravity sessions of this launch are busy; run jev-memory agy-finalize --recover to finish them\n'); return; }
      const { failed } = await finalizeSessionsFile(claim, finalizeOne, (id, error) => {
        const message = error instanceof Error ? error.message : 'finalize failed';
        process.stderr.write(`Could not finalize Antigravity session ${id}: ${message}; run jev-memory agy-finalize --session ${id}\n`);
      });
      if (failed > 0) return;
      await unlink(claim).catch(ignoreMissing);
    }
    // Ids appended after the last pass stay recorded with the owner, so the next recovery finalizes them.
    if (await fileExists(sessions)) return;
    await unlink(owner).catch(ignoreMissing);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'launch cleanup failed';
    process.stderr.write(`Could not finish Antigravity launch tracking: ${message}\n`);
  }
}
type AgyOwnerRead = { status: 'missing' } | { status: 'invalid' } | { status: 'ok'; owner: AgyOwner };
// Anything that is not a well-formed owner reads as invalid, so the automatic path never touches it.
async function readAgyOwner(file: string): Promise<AgyOwnerRead> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'invalid' }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { status: 'invalid' }; }
  const result = agyOwnerSchema.safeParse(parsed);
  return result.success ? { status: 'ok', owner: result.data } : { status: 'invalid' };
}
const sessionsPattern = /^([a-f0-9]{32})\.sessions$/;
const ownerPattern = /^([a-f0-9]{32})\.owner\.json$/;
const claimPattern = /^([a-f0-9]{32})\.sessions\.recovering-(\d{1,10})$/;
interface AgyLaunchEntry { sessions: boolean; claims: number[] }
// Groups the launch records of one profile by launch id. Only this profile's directory is read.
async function scanAgyLaunches(dir: string): Promise<Map<string, AgyLaunchEntry>> {
  const launches = new Map<string, AgyLaunchEntry>();
  const entry = (launch: string): AgyLaunchEntry => {
    let found = launches.get(launch);
    if (!found) { found = { sessions: false, claims: [] }; launches.set(launch, found); }
    return found;
  };
  const files = await readdir(agyLaunchDir(dir)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  for (const file of files) {
    const sessions = sessionsPattern.exec(file)?.[1], owner = ownerPattern.exec(file)?.[1], claim = claimPattern.exec(file);
    if (sessions !== undefined) entry(sessions).sessions = true;
    if (owner !== undefined) entry(owner);
    if (claim && Number(claim[2]) > 0) entry(claim[1] ?? '').claims.push(Number(claim[2]));
  }
  return launches;
}
// The rename is the claim: only one process can move a sessions file away. Any failure means another process got there first.
async function renameIfPresent(from: string, to: string, doRename: typeof rename = rename): Promise<boolean> {
  try { await doRename(from, to); return true; }
  catch { return false; }
}
export type AgyFinalize = (name: string, c: Config, sessionId: string, cwd: string) => Promise<unknown>;
export interface AgyRecoveryDeps {
  config: Config;                 // the profile's current config: scope check and legacy finalization
  cwd: string;                    // working directory for legacy finalization
  legacy?: boolean;               // also finalize sessions with no owner record, using the current config
  recordedScope?: boolean;        // manual command only: finalize a dead launch under its recorded scope when it differs from the current config
  profileDirPath?: string;        // default profileDir(name)
  pid?: number;                   // the claiming process; default process.pid
  isAlive?: (pid: number) => boolean;
  finalize?: AgyFinalize;
  warn?: (message: string) => void;
  fsOps?: AgyFsOps;               // test seam: the rename used to claim sessions files
}
export type AgySkipReason = 'owner-alive' | 'owner-invalid' | 'no-owner' | 'scope-mismatch' | 'claimed-by-other' | 'finalize-failed' | 'unreadable';
// A session finalized under a recorded scope that differs from the current profile is listed with scope 'recorded'; other sessions are plain ids.
export interface AgyRecoveryReport { recovered: Array<string | { id: string; scope: 'recorded' }>; skipped: Array<{ launch: string; reason: AgySkipReason }>; note?: string }
// A launch stays alive while its wrapper or the agy client it started still runs.
const agyOwnerAlive = (owner: AgyOwner, isAlive: (pid: number) => boolean): boolean => isAlive(owner.pid) || (owner.childPid !== undefined && isAlive(owner.childPid));
// Finalizes sessions left by launches whose process died. Never throws: problems become skips and stderr warnings without conversation content.
export async function recoverAgyLaunches(name: string, deps: AgyRecoveryDeps): Promise<AgyRecoveryReport> {
  const report: AgyRecoveryReport = { recovered: [], skipped: [] };
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const isAlive = deps.isAlive ?? pidAlive;
  const finalize = deps.finalize ?? finalizeAgySession;
  const renameFile = deps.fsOps?.rename ?? rename;
  const pid = deps.pid ?? process.pid;
  const { config } = deps;
  const skip = (launch: string, reason: AgySkipReason): void => { report.skipped.push({ launch, reason }); };
  try {
    const dir = deps.profileDirPath ?? profileDir(name);
    for (const [launch, entry] of await scanAgyLaunches(dir)) {
      try {
        const ownerFile = agyOwnerFile(dir, launch);
        const owner = await readAgyOwner(ownerFile);
        if (!entry.sessions && entry.claims.length === 0) {
          // An owner left by a dead launch with nothing recorded is only clutter.
          if (owner.status === 'ok' && !agyOwnerAlive(owner.owner, isAlive)) await unlink(ownerFile).catch(ignoreMissing);
          continue;
        }
        if (owner.status === 'invalid') { skip(launch, 'owner-invalid'); continue; }
        let scope: AgyScope;
        let scopeRecorded = false;
        if (owner.status === 'missing') {
          if (!deps.legacy) { skip(launch, 'no-owner'); continue; }
          scope = { workspace: config.workspace, project: config.project, cwd: deps.cwd };
        } else {
          if (agyOwnerAlive(owner.owner, isAlive)) { skip(launch, 'owner-alive'); continue; }
          scope = owner.owner;
          if (owner.owner.workspace !== config.workspace || owner.owner.project !== config.project) {
            // The sessions were stored under the recorded scope, so the manual command finalizes them there; the automatic path leaves them for that command.
            if (!deps.recordedScope) {
              warn(`Antigravity launch ${launch} was recorded for another workspace or project; run jev-memory agy-finalize --recover to finalize it with its recorded scope`);
              skip(launch, 'scope-mismatch');
              continue;
            }
            scopeRecorded = true;
            warn(`Antigravity launch ${launch} is finalized with its recorded scope (${scope.workspace}/${scope.project}), not the current profile`);
          }
        }
        if (entry.claims.some(claimant => isAlive(claimant))) { skip(launch, 'claimed-by-other'); continue; }
        const sources = [...entry.claims.map(claimant => agyClaimFile(dir, launch, claimant)), ...(entry.sessions ? [launchSessionsFile(dir, launch)] : [])];
        const target = agyClaimFile(dir, launch, pid);
        const scoped: Config = { ...config, workspace: scope.workspace, project: scope.project };
        const finalizeOne = async (id: string): Promise<void> => {
          await finalize(name, scoped, id, scope.cwd);
          await clearActiveSession(dir, 'antigravity-cli', id).catch(() => undefined);
        };
        let outcome: AgySkipReason | undefined;
        for (const source of sources) {
          if (!(await renameIfPresent(source, target, renameFile))) { outcome = 'claimed-by-other'; break; }
          const { done, failed } = await finalizeSessionsFile(target, finalizeOne, () => {
            warn(`Could not finalize an Antigravity session of launch ${launch}; it stays recorded for the next attempt`);
          });
          report.recovered.push(...done.map(id => (scopeRecorded ? { id, scope: 'recorded' as const } : id)));
          if (failed > 0) { outcome = 'finalize-failed'; break; }
        }
        if (outcome !== undefined) { skip(launch, outcome); continue; }
        if (owner.status === 'ok') await unlink(ownerFile).catch(ignoreMissing);
      } catch {
        skip(launch, 'unreadable');
        warn(`Could not recover Antigravity launch ${launch}; it stays recorded`);
      }
    }
  } catch {
    warn('Could not read Antigravity launch records; nothing was recovered');
  }
  if (!deps.legacy && report.skipped.some(item => item.reason === 'no-owner'))
    warn('Antigravity launch records without an owner were left in place; after confirming no agy is running, run jev-memory agy-finalize --recover --legacy');
  if (deps.legacy) report.note = `Sessions without an owner record were finalized with the current profile config (${config.workspace}/${config.project}).`;
  return report;
}
// Only agy builds whose Code Assist methods were checked against the Jev gateway are routed through it; a newer agy needs revalidation.
export const VALIDATED_AGY_VERSIONS = ['1.4.7']; // validated 2026-10-24
const AGY_UPSTREAMS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'] as const;
// The gateway launcher must not inherit the gateway's own keys and upstream, or this launch's routing variables.
const AGY_START_STRIPPED = ['UPSTREAM_API_KEY', 'ROUTER_API_KEY', 'JEV_SHADOW', 'JEV_DEBUG_DUMP_DIR', 'CLOUD_CODE_URL', AGY_LAUNCH_ENV];
const agyVersionToken = /\b\d+\.\d+\.\d+\b/;
// Pure: the first x.y.z token of `agy --version` output, or undefined when there is none.
export function agyVersionOf(output: string): string | undefined {
  return agyVersionToken.exec(output)?.[0];
}
// Pure: only an exact validated version passes; unrecognized output never does.
export function agyVersionValidated(output: string): boolean {
  const version = agyVersionOf(output);
  return version !== undefined && VALIDATED_AGY_VERSIONS.includes(version);
}
// Pure: JEV_AGY_PORT is used only when it is a whole port in 1024-65535; anything else takes the gateway's default.
export function agyGatewayPort(raw: string | undefined, defaultPort: number): number {
  const port = raw !== undefined && /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  return port >= 1024 && port <= 65535 ? port : defaultPort;
}
// Code Assist route sets the gateway may report: 1 is the original 9-method allowlist; 2 adds the routes declared by agy 1.4.7.
export const AGY_CODE_ASSIST_VERSIONS = [1, 2] as const;
// Strict on the fields it names; the gateway may add others. The reason lists field names only, never their values.
const agyHealthSchema = z.object({
  status: z.literal('ok'),
  client: z.literal('agy'),
  codeAssist: z.number().refine(version => (AGY_CODE_ASSIST_VERSIONS as readonly number[]).includes(version), 'unsupported codeAssist version'),
  upstream: z.enum(AGY_UPSTREAMS),
  pid: z.number().int()
});
export type AgyHealth = { ok: true; pid: number } | { ok: false; reason: string };
// Pure: accepts only a health body from the agy Code Assist gateway.
export function parseAgyHealth(body: unknown): AgyHealth {
  const parsed = agyHealthSchema.safeParse(body);
  if (parsed.success) return { ok: true, pid: parsed.data.pid };
  const fields = [...new Set(parsed.error.issues.map(issue => String(issue.path[0] ?? 'body')))];
  return { ok: false, reason: `gateway health invalid: ${fields.join(', ')}` };
}
// Pure: the gateway launcher's environment, without the variables listed above.
export function agyStartEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of AGY_START_STRIPPED) delete next[key];
  return next;
}
// Mirrors the gateway launcher: its state dir is ~/.jev-gateway (no env override) and each client writes <client>.pid there.
export function agyPidFile(home = homedir()): string {
  return join(home, '.jev-gateway', 'agy.pid');
}
// The pid the launcher recorded for agy, or undefined when the file is absent, unreadable or not a pid.
export async function readAgyPid(home = homedir()): Promise<number | undefined> {
  try {
    const text = (await readFile(agyPidFile(home), 'utf8')).trim();
    return /^\d+$/.test(text) ? Number(text) : undefined;
  } catch { return undefined; }
}
export interface AgySpec { portEnv: string; defaultPort: number }
// Loads the installed upstream agy spec. An older gateway does not export it, which the caller reports as no agy support.
export async function loadAgySpec(dir = gatewayDir()): Promise<AgySpec | undefined> {
  const mod = await import(pathToFileURL(resolve(dir, 'bin', 'clients.mjs')).href) as { agy?: Partial<AgySpec> };
  const spec = mod.agy;
  if (spec === undefined) return undefined;
  if (typeof spec.portEnv !== 'string' || !Number.isInteger(spec.defaultPort)) throw new Error('Installed gateway agy spec is unusable');
  return { portEnv: spec.portEnv, defaultPort: spec.defaultPort as number };
}
export type AgyGatewayRoute = { url: string } | { reason: string };
// Pure: only agy's own environment gets CLOUD_CODE_URL; the caller's environment is never changed.
export function agyLaunchEnv(env: NodeJS.ProcessEnv, launchId: string, route: AgyGatewayRoute): NodeJS.ProcessEnv {
  return { ...env, [AGY_LAUNCH_ENV]: launchId, ...('url' in route ? { CLOUD_CODE_URL: route.url } : {}) };
}
export interface AgyRouteDeps {
  env: NodeJS.ProcessEnv;
  gateway: () => string;
  spec: (dir: string) => Promise<AgySpec | undefined>;
  exec: (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number }) => Promise<string>;
  fetch: typeof fetch;
  // The pid of the gateway that jev-agy started, as recorded in the state dir.
  readPid: () => Promise<number | undefined>;
}
const defaultAgyExec: AgyRouteDeps['exec'] = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, { ...options, encoding: 'utf8', windowsHide: true, shell: false });
  return String(stdout);
};
// Any failure reads as not answering, so the caller starts the gateway or keeps agy on its direct path.
async function probeAgyHealth(fetchFn: typeof fetch, port: number): Promise<unknown> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!res.ok) { await res.body?.cancel(); return undefined; }
    return await res.json() as unknown;
  } catch { return undefined; }
}
// Decides whether agy goes through the Jev gateway. Never throws: a check that cannot finish keeps agy on its direct path.
// The gateway is persistent like the Claude and Codex ones, so leaving agy never stops it.
export async function agyGatewayRoute(exe: string, overrides: Partial<AgyRouteDeps> = {}): Promise<AgyGatewayRoute> {
  const deps: AgyRouteDeps = { env: process.env, gateway: () => gatewayDir(), spec: loadAgySpec, exec: defaultAgyExec, fetch, readPid: () => readAgyPid(), ...overrides };
  try {
    if (deps.env.JMS_AGY_GATEWAY === 'off') return { reason: 'disabled by JMS_AGY_GATEWAY=off' };
    // A CLOUD_CODE_URL set by the user is a deliberate choice, so it is never overwritten.
    if (deps.env.CLOUD_CODE_URL) return { reason: 'CLOUD_CODE_URL already set' };
    const version = await deps.exec(exe, ['--version'], { timeout: 5000 }).catch(() => undefined);
    if (version === undefined) return { reason: 'agy --version failed' };
    if (!agyVersionValidated(version)) {
      const found = agyVersionOf(version);
      return { reason: found === undefined ? 'agy version not recognized' : `agy ${found} not validated with the Jev gateway` };
    }
    let dir: string;
    try { dir = deps.gateway(); }
    catch { return { reason: 'gateway engine not installed' }; }
    const spec = await deps.spec(dir).catch(() => undefined);
    if (spec === undefined) return { reason: 'installed gateway has no agy support' };
    const port = agyGatewayPort(deps.env[spec.portEnv], spec.defaultPort);
    let body = await probeAgyHealth(deps.fetch, port);
    if (body === undefined) {
      const started = await deps.exec(process.execPath, [resolve(dir, 'bin', 'jev-agy.mjs'), '--start'], { cwd: dir, env: agyStartEnv(deps.env), timeout: 20_000 })
        .then(() => true, () => false);
      if (!started) return { reason: 'jev-agy --start failed' };
      body = await probeAgyHealth(deps.fetch, port);
      if (body === undefined) return { reason: `gateway did not answer on 127.0.0.1:${port}` };
    }
    const health = parseAgyHealth(body);
    if (!health.ok) return { reason: health.reason };
    // The OAuth token travels to whoever answers this port, so only the gateway jev-agy recorded may receive it.
    if (await deps.readPid().catch(() => undefined) !== health.pid) return { reason: 'gateway pid does not match jev-agy' };
    return { url: `http://127.0.0.1:${port}` };
  } catch {
    return { reason: 'Jev gateway check failed' };
  }
}

// Runs the native agy binary with the user's arguments unchanged. Traffic goes through the Jev gateway only when the route check passes; otherwise agy reaches Google directly.
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
  return runAgyLaunch(name, c, cwd, exe, userArgs);
}
export interface AgyRunOptions { route?: () => Promise<AgyGatewayRoute>; finalize?: AgyFinalize }
// One tracked agy run: owner record, recovery of earlier launches, SIGHUP handling and finalization. Services are not started here; agyLaunch does that first.
export async function runAgyLaunch(name: string, c: Config, cwd: string, exe: string, userArgs: string[], options: AgyRunOptions = {}): Promise<number> {
  const launchId = randomBytes(16).toString('hex');
  const finalize = options.finalize ?? finalizeAgySession;
  const dir = profileDir(name), scope: AgyScope = { workspace: c.workspace, project: c.project, cwd }, startedAt = new Date();
  // The owner record lets a later launch finalize this one if the wrapper dies before it finishes.
  await writeAgyOwner(dir, launchId, scope, startedAt)
    .catch(() => process.stderr.write('Antigravity launch record could not be written; an interrupted launch needs agy-finalize --recover --legacy\n'));
  if (c.memory.enabled) await recoverAgyLaunches(name, { config: c, cwd, finalize });
  // The owner is rewritten with agy's pid once it spawns; finalization waits for that write so the record is not recreated after cleanup.
  let ownerWrite: Promise<void> = Promise.resolve();
  const finish = onceAsync(async () => { await ownerWrite; await finalizeAgyLaunch(name, c, launchId, cwd, finalize); });
  let known: number | undefined;
  const disarm = armAgyHangup({ host: process, finish, budgetMs: AGY_HANGUP_BUDGET_MS, exit: code => process.exit(code), exitCode: () => known });
  try {
    const route = await (options.route ?? (() => agyGatewayRoute(exe)))();
    if ('url' in route) process.stderr.write(`Jev gateway: ${route.url} (passthrough)\n`);
    else process.stderr.write(`Jev not used: ${route.reason}\n`);
    known = await runAgy(exe, userArgs, cwd, agyLaunchEnv(process.env, launchId, route), childPid => {
      ownerWrite = writeAgyOwner(dir, launchId, scope, startedAt, childPid)
        .catch(() => { process.stderr.write('Antigravity launch record could not be updated with the agy pid; if the wrapper is killed, recovery may not see a live agy\n'); });
    });
    return known;
  } finally {
    await finish();
    disarm();
  }
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
