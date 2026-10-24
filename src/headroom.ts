import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { root, type Config } from './config.js';

export type HeadroomDetection = { ok: true; executable: string; version: string } | { ok: false; reason: string };
export interface DetectDeps { exec?: (file: string, args: string[]) => Promise<string>; exists?: (path: string) => Promise<boolean>; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
export type HeadroomRoute = { use: true; baseUrl: string } | { use: false; reason: string };
export interface RouteInput { enabled: boolean; optOut: boolean; serviceState: string | undefined; upstreamPort: number | undefined; jevPort: number; live: boolean; port: number }

const execFileAsync = promisify(execFile);
const run = (file: string, args: string[]): Promise<string> =>
  execFileAsync(file, args, { shell: false, windowsHide: true, timeout: 20_000, encoding: 'utf8' }).then(result => result.stdout);
const fileExists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const toolName = (platform: NodeJS.Platform): string => platform === 'win32' ? 'headroom.exe' : 'headroom';

// Only the documented one-line banner is trusted; any other output is treated as an unreadable version.
export function parseHeadroomVersion(stdout: string): string | undefined {
  return /^headroom, version (\d+\.\d+\.\d+)$/m.exec(stdout.replace(/\r/g, ''))?.[1];
}

// A configured path is authoritative and never falls back, so a typo cannot silently pick another install.
async function locate(c: Pick<Config, 'headroom'>, env: NodeJS.ProcessEnv, platform: NodeJS.Platform,
  exec: (file: string, args: string[]) => Promise<string>, exists: (path: string) => Promise<boolean>): Promise<string | undefined> {
  const configured = c.headroom.executable;
  if (configured) return await exists(configured) ? configured : undefined;
  const onPath = await exec(platform === 'win32' ? 'where.exe' : 'which', [toolName(platform)])
    .then(out => out.split(/\r?\n/)[0]?.trim() || undefined, () => undefined);
  if (onPath && await exists(onPath)) return onPath;
  // uv installs tools into ~/.local/bin by default, even when that directory is not on PATH yet.
  const home = env.USERPROFILE || env.HOME;
  if (!home) return undefined;
  const uvBin = join(home, '.local', 'bin', toolName(platform));
  return await exists(uvBin) ? uvBin : undefined;
}

export async function detectHeadroom(c: Pick<Config, 'headroom'>, deps: DetectDeps = {}): Promise<HeadroomDetection> {
  const exec = deps.exec ?? run;
  const executable = await locate(c, deps.env ?? process.env, deps.platform ?? process.platform, exec, deps.exists ?? fileExists);
  if (executable === undefined) return { ok: false, reason: 'Headroom executable not found; install it with uv or set headroom.executable' };
  const found = await exec(executable, ['--version']).then(parseHeadroomVersion, () => undefined);
  if (found === undefined) return { ok: false, reason: 'Headroom version could not be read' };
  // The pinned version is compared exactly: a newer or older proxy may change the request shape Jev depends on.
  if (found !== c.headroom.version) return { ok: false, reason: `Headroom ${found} found; this profile requires ${c.headroom.version}` };
  return { ok: true, executable, version: found };
}

export type HeadroomPythonDetection = { ok: true; python: string; version: string } | { ok: false; reason: string };
const PYTHON_VERSION_SCRIPT = "import importlib.metadata as m; print(m.version('headroom-ai'))";

// Interpreter of the uv tool environment that holds headroom-ai.
const toolPython = (toolDir: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? join(toolDir, 'headroom-ai', 'Scripts', 'python.exe') : join(toolDir, 'headroom-ai', 'bin', 'python');

// Where uv keeps tool environments when neither UV_TOOL_DIR nor `uv tool dir` gives an answer.
function defaultToolDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') return env.APPDATA ? join(env.APPDATA, 'uv', 'tools') : undefined;
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'uv', 'tools');
  return env.HOME ? join(env.HOME, '.local', 'share', 'uv', 'tools') : undefined;
}

async function pythonCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform,
  exec: (file: string, args: string[]) => Promise<string>): Promise<string[]> {
  const uvDir = await exec('uv', ['tool', 'dir']).then(out => out.split(/\r?\n/)[0]?.trim(), () => undefined);
  const toolDirs = [env.UV_TOOL_DIR, uvDir, defaultToolDir(env, platform)];
  return [...new Set(toolDirs.filter((dir): dir is string => !!dir).map(dir => toolPython(dir, platform)))];
}

// The shim is versioned with Headroom: one directory per release, and a release without one has no Codex patch.
export function shimPath(version: string): string {
  return resolve(root, 'patches/headroom', version, 'jms_headroom_shim.py');
}

// A configured interpreter is authoritative and never falls back; otherwise the first existing candidate wins.
export async function detectHeadroomPython(c: Pick<Config, 'headroom'>, deps: DetectDeps = {}): Promise<HeadroomPythonDetection> {
  const exec = deps.exec ?? run;
  const exists = deps.exists ?? fileExists;
  const { version, python: configured } = c.headroom;
  const candidates = configured ? [configured] : await pythonCandidates(deps.env ?? process.env, deps.platform ?? process.platform, exec);
  let python: string | undefined;
  for (const candidate of candidates) if (await exists(candidate)) { python = candidate; break; }
  if (python === undefined) return { ok: false, reason: 'Headroom python not found; install headroom-ai with uv or set headroom.python' };
  const found = await exec(python, ['-I', '-c', PYTHON_VERSION_SCRIPT]).then(out => out.trim(), () => '');
  if (!/^\d+\.\d+\.\d+$/.test(found)) return { ok: false, reason: 'Headroom version could not be read from its python' };
  if (found !== version) return { ok: false, reason: `Headroom ${found} found; this profile requires ${version}` };
  if (!await exists(shimPath(version))) return { ok: false, reason: `No Codex patch for Headroom ${version}` };
  return { ok: true, python, version };
}

// Headroom reads its Codex upstream from this variable; the shim accepts only the loopback gateway as its value.
export function codexShimEnv(env: NodeJS.ProcessEnv, codexJevPort: number): NodeJS.ProcessEnv {
  return { ...env, HEADROOM_CHATGPT_CODEX_BASE_URL: `http://127.0.0.1:${codexJevPort}/v1` };
}

// The last stdout line is the report; a failing --check still prints one, so success and failure are read the same way.
function parseReport(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export async function checkCodexShim(python: string, version: string, env: NodeJS.ProcessEnv):
  Promise<{ ok: boolean; reason?: string; report?: unknown }> {
  const outcome = await execFileAsync(python, ['-I', shimPath(version), '--check'], { shell: false, windowsHide: true, timeout: 60_000, encoding: 'utf8', env })
    .then(result => ({ failed: false, stdout: result.stdout }), (err: { stdout?: string }) => ({ failed: true, stdout: err.stdout ?? '' }));
  const report = parseReport(outcome.stdout);
  if (report === undefined) return { ok: false, reason: 'Codex shim check printed no report' };
  if (!outcome.failed && report.ok === true) return { ok: true, report };
  return { ok: false, reason: typeof report.reason === 'string' ? report.reason : 'Codex shim check failed', report };
}

// cache mode keeps earlier turns byte-identical so provider prefix caching still hits.
// --no-ccr injects no headroom_retrieve tool (Jev would see it) and emits no retrieval markers.
// --no-cache disables Headroom's semantic response cache so every request reaches Jev and the provider.
// --no-rate-limit because Headroom's default 60 rpm would throttle Claude Code.
// codexJevPort, when given, sends Codex API-key requests to the Jev codex gateway; ChatGPT-login ones use codexShimEnv.
export function headroomArgs(port: number, jevPort: number, logFile: string, codexJevPort?: number): string[] {
  const args = ['proxy', '--host', '127.0.0.1', '--port', String(port), '--mode', 'cache', '--no-ccr', '--no-cache', '--no-rate-limit',
    '--anthropic-api-url', `http://127.0.0.1:${jevPort}`, '--log-file', logFile];
  if (codexJevPort !== undefined) args.push('--openai-api-url', `http://127.0.0.1:${codexJevPort}/v1`);
  return args;
}

// Inherited Headroom switches would override the pinned ones, so they are stripped before the profile values are set.
const inherited = (key: string): boolean => {
  const upper = key.toUpperCase();
  return upper.startsWith('HEADROOM_') || upper === 'DO_NOT_TRACK' || upper === 'HF_HUB_OFFLINE';
};
export function headroomEnv(base: NodeJS.ProcessEnv, workspaceDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!inherited(key)) env[key] = value;
  return {
    ...env,
    // OFFLINE refuses every connection Headroom starts itself (beacon, update check, pollers, model downloads); user traffic is still forwarded.
    HEADROOM_OFFLINE: '1', HEADROOM_BEACON: 'off', HEADROOM_TELEMETRY: 'off', HEADROOM_UPDATE_CHECK: 'off',
    // SmartCrusher strict mode keeps lossless tabular compaction but never drops array rows without a marker (CCR is off).
    HEADROOM_LOSSLESS_ONLY: '1',
    DO_NOT_TRACK: '1', HF_HUB_OFFLINE: '1',
    // litellm (a Headroom dependency) fetches its model price map from GitHub at import unless told to use the bundled copy.
    LITELLM_LOCAL_MODEL_COST_MAP: 'True',
    HEADROOM_UPSTREAM_ALLOWED_HOSTS: '127.0.0.1',
    HEADROOM_WORKSPACE_DIR: workspaceDir, HEADROOM_CONFIG_DIR: join(workspaceDir, 'config'),
    PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
  };
}

// The first failing check is reported, so the reason names the cause the user can act on.
export function headroomRoute(input: RouteInput): HeadroomRoute {
  if (!input.enabled) return { use: false, reason: 'Headroom is disabled for this profile' };
  if (input.optOut) return { use: false, reason: 'Headroom bypassed by JMS_HEADROOM=off' };
  if (input.serviceState !== 'ready') return { use: false, reason: `Headroom service is ${input.serviceState ?? 'not running'}` };
  if (input.upstreamPort !== input.jevPort) return { use: false, reason: 'Headroom forwards to another Jev port; restart the profile' };
  if (!input.live) return { use: false, reason: 'Headroom did not answer its health check' };
  return { use: true, baseUrl: `http://127.0.0.1:${input.port}` };
}
