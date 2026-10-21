import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { assertLocal, prepare, profileDir, readConfig, root, workspaceDir, type Config } from './config.js';
import { atomicJson, token } from './local.js';
import { control, running, start } from './lifecycle.js';
import { gatewayDir } from './install.js';
import { bridgeEntry, hookEntries, serverId } from './clients.js';

export type Client = 'claude' | 'codex';
export interface LaunchPlan { args: string[]; env: NodeJS.ProcessEnv; files: string[]; marker: string | undefined }

const rootManifestNames: Record<Client, string> = { claude: '.jev-memory-claude.json', codex: '.jev-memory-codex.json' };
const markerName = '.ai-memory.toml';
const registrationSchema = z.object({ profile: z.string() });
const markerSchema = z.object({ workspace: z.string(), project: z.string() });
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
  await assertLocal(path);
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
// Walks from dir up to base (inclusive) and returns the nearest scope marker path, if any.
async function findScopeMarker(dir: string, base: string): Promise<string | undefined> {
  const candidate = resolve(dir, markerName);
  await assertLocal(candidate);
  const found = await stat(candidate).then(info => info.isFile(), (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });
  if (found) return candidate;
  const parent = dirname(dir);
  if (relative(base, dir) === '' || parent === dir) return undefined;
  return findScopeMarker(parent, base);
}
// Hook capture uses --capture-mode allowlist, so a marker that matches the profile scope is required.
async function checkScopeMarker(client: Client, cwd: string, scope: Pick<Config, 'workspace' | 'project'>): Promise<string | undefined> {
  const base = await realpath(root), start = await realpath(cwd);
  const path = await findScopeMarker(start, base);
  if (path === undefined) {
    const dir = relative(base, start) || '.';
    process.stderr.write(`No ${markerName} scope marker between ${cwd} and the workspace root: hook capture is disabled (allowlist). Run \`clients install ${client} ${dir}\` to create it.\n`);
    return undefined;
  }
  const text = await readFile(path, 'utf8');
  const declared = markerSchema.safeParse(parseMarker(text, path));
  if (!declared.success) throw new Error(`Scope marker ${path} is unreadable`);
  if (declared.data.workspace !== scope.workspace || declared.data.project !== scope.project)
    throw new Error(`Scope marker ${path} declares ${declared.data.workspace}/${declared.data.project}, profile expects ${scope.workspace}/${scope.project}`);
  return path;
}
function parseMarker(text: string, path: string): unknown {
  try { return parse(text); } catch { throw new Error(`Scope marker ${path} is unreadable`); }
}
// Builds flags and environment without spawning or contacting the supervisor.
export async function planLaunch(client: Client, name: string, cwd = root): Promise<LaunchPlan> {
  const c = await readConfig(name), env: NodeJS.ProcessEnv = { ...process.env }, args: string[] = [], files: string[] = [];
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
  const supported = clientName(client), c = await readConfig(name), cwd = await workspaceDir(resolve(root, dir)), executable = await clientCommand(supported);
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
async function ensureMemoryReady(name: string): Promise<void> {
  if (!(await running(name))) await start(name);
  const state = await control(name, 'status');
  const services = state.services as Record<string, unknown> | undefined;
  if (services?.memory !== 'ready') throw new Error('Memory service is not ready; run doctor');
}
// Runs the upstream jev-<client> launcher, which owns the gateway and the client's own login.
export async function jevLaunch(client: string, name: string, userArgs: string[], dir = '.'): Promise<void> {
  const supported = clientName(client), c = await readConfig(name), cwd = await workspaceDir(resolve(root, dir));
  if (c.gateway.enabled) throw new Error('The suite gateway is enabled for this profile; jev-<client> owns the gateway. Disable gateway in the profile or use `launch`.');
  const passthrough = launcherFlags.has(userArgs[0] ?? '');
  const plan = passthrough ? undefined : await planLaunch(supported, name, cwd);
  const providerArgs = hasCodexSubcommand(supported, userArgs) ? await codexProviderArgs() : [];
  const { argv } = jevLauncherArgv(supported, plan?.args ?? [], userArgs, providerArgs);
  if (!passthrough && c.memory.enabled) await ensureMemoryReady(name);
  const env = plan?.env ?? process.env;
  await new Promise<void>((ok, fail) => {
    const child = spawn(process.execPath, [jevLauncherPath(supported), ...argv], { cwd, env, shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', fail); child.once('exit', code => code === 0 ? ok() : fail(new Error(`${supported} exit ${code}`)));
  });
}
