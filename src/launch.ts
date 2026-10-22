import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { assertWithin, prepare, profileDir, readConfig, root, workspaceDir, type Config } from './config.js';
import { atomicJson, token } from './local.js';
import { control, running, start } from './lifecycle.js';
import { gatewayDir } from './install.js';
import { bridgeEntry, hookEntries, serverId } from './clients.js';
import { projectScopeMarker } from './scope.js';

export type Client = 'claude' | 'codex';
export interface LaunchPlan { args: string[]; env: NodeJS.ProcessEnv; files: string[]; marker: string | undefined }

const rootManifestNames: Record<Client, string> = { claude: '.jev-memory-claude.json', codex: '.jev-memory-codex.json' };
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
async function readDirManifest(client: Client, cwd: string): Promise<unknown> {
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
  await atomicJson(mcp, { mcpServers: { [serverId]: bridgeEntry(name) } });
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
async function checkScopeMarker(client: Client, cwd: string, scope: Pick<Config, 'workspace' | 'project' | 'projectRoot'>): Promise<string | undefined> {
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
  if (!passthrough && process.platform === 'win32') {
    const executable = await clientCommand(supported);
    if (executable.prefix.length === 0) {
      const key = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
      env[key] = `${dirname(executable.command)};${env[key] ?? ''}`;
    }
  }
  await new Promise<void>((ok, fail) => {
    const child = spawn(process.execPath, [jevLauncherPath(supported), ...argv], { cwd, env, shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', fail); child.once('exit', code => code === 0 ? ok() : fail(new Error(`${supported} exit ${code}`)));
  });
}
