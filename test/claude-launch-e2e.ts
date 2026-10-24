import { test, describe, before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { open, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { configSchema, json, prepare, profileDir, readConfig, root, type Config } from '../src/config.js';
import { init, control, stop } from '../src/lifecycle.js';
import { atomicJson, sleep } from '../src/local.js';
import { Mcp } from '../src/mcp.js';
import { clientCommand } from '../src/launch.js';
import { delegatedCommand } from '../src/cli-args.js';
import { detectHeadroom } from '../src/headroom.js';
import { gatewayDir } from '../src/install.js';
import { projectContext } from '../src/projects.js';

// Real `jev-memory claude` launch path, end to end, with isolated profiles and local mocks only:
// CLI -> projectContext -> jevLaunch -> prepareHeadroom -> supervisor-managed Headroom -> real Claude Code.
// Claude's upstream is a mock Anthropic server reached through the Jev router; Jev's tool selection goes to mock-jev.
// Nothing reaches a paid API, a real credential, the live gateways (8789/8790) or the user's real home.

const HEADROOM_VERSION = '0.41.0';
const detection = await detectHeadroom({ headroom: { enabled: true, port: 1, version: HEADROOM_VERSION, codex: false } });
const claudeFound = await clientCommand('claude').then(() => true, () => false);
const skip: string | false = !detection.ok ? `Headroom ${HEADROOM_VERSION} is not usable: ${detection.reason}`
  : !claudeFound ? 'Claude Code (claude) is not installed on PATH' : false;

const CLI = resolve(root, 'dist/src/cli.js');
const LAUNCHER = resolve(gatewayDir(), 'bin/jev-claude.mjs');
const E2E_BASE = resolve(root, '.local/e2e');
const EVIDENCE_DIR = resolve(root, '.local/evidence'), EVIDENCE_FILE = 'claude-launch-e2e.json';
const PROMPT = 'Run node emit.js and count ERROR entries';
const RESULT = 'E2E-CLAUDE-DONE';
const TOOL = 'Bash', TOOL_ID = 'toolu_e2e_bash';
const TOOL_INPUT = { command: 'node emit.js', description: 'emit logs' };
const LOG_COUNT = 120;
const WORKSPACE = 'e2e-claude';
const TEMPLATES = { on: 'e2e-hr-on', off: 'e2e-hr-off', bad: 'e2e-hr-bad' } as const;
const EMIT_JS = `// Synthetic log fixture for the claude launch e2e: 120 rows, every 47th is ERROR.
const rows = Array.from({ length: ${LOG_COUNT} }, (_, i) => ({
  ts: new Date(Date.UTC(2026, 9, 23, 12) + i * 1000).toISOString(),
  level: i % 47 === 0 ? 'ERROR' : 'INFO',
  service: 'synthetic-api',
  request_id: \`req-\${100000 + i}\`,
  latency_ms: 20 + ((i * 37) % 400),
  status: i % 47 === 0 ? 500 : 200,
  path: \`/v1/items/\${i % 10}\`,
  msg: i % 47 === 0 ? 'upstream timeout' : 'request completed',
}));
console.log(JSON.stringify(rows, null, 2));
`;
// Variables that would point the client or the suite at real credentials or real state; removed case-insensitively.
const REMOVED_ENV = new Set(['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'JMS_HEADROOM', 'CLAUDE_CONFIG_DIR']);

type Json = Record<string, unknown>;
type Slot = keyof typeof TEMPLATES;
interface Recorded { method: string | undefined; path: string; headers: IncomingHttpHeaders; raw: string; body: Json }
interface Mock { port: number; seen: Recorded[]; close: () => Promise<void> }
interface EnvBase { home: string; fakeKey: string; mockPort: number; mockJevPort: number; jevClaudePort: number; jevCodexPort: number }
interface Project { slot: Slot; template: string; name: string; dir: string; config: Config }
interface RunResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }
interface RunInfo { result: RunResult; calls: Recorded[]; seen: Recorded[]; routeDelta: number; requestsDelta: number }
interface Ctx {
  base: EnvBase; tmp: string; e2eDir: string; mock: Mock; mockJev: ChildProcess; mockJevLog: FileHandle; mockJevDump: string;
  projects: Record<Slot, Project>; runs: Record<string, RunInfo>; marker: string; sessionId?: string;
  supervisorPids: Record<string, number>; realBefore: HomeState; realClaudeLogSize: number; tmpName: string;
}
interface HomeState { jevGateway: string[] | null; headroom: string[] | null; claudeJson: string | null }
interface RealHomeCheck {
  strictListingUnchanged: boolean; isolatedRouterRunIds: number; claudeLogLinesFromIsolatedRouters: number;
  claudeLogTmpMarkerHits: number; claudeJsonTmpMarkerHits: number; liveClaudeLogBytesAdded: number; liveClaudeJsonMtimeChanged: boolean;
}

// ---- JSON and HTTP helpers -------------------------------------------------------------

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
function asJson(text: string): Json {
  const value: unknown = JSON.parse(text);
  if (!isJson(value)) throw new Error('expected a JSON object');
  return value;
}
function parseBody(raw: string): Json {
  try { return asJson(raw); } catch { return {}; }
}
function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isJson) : [];
}
function readText(req: IncomingMessage): Promise<string> {
  return (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  })();
}
function closeServer(server: Server): Promise<void> {
  return new Promise(done => { server.close(() => done()); server.closeAllConnections(); });
}
async function freeTcpPort(): Promise<number> {
  const server = netServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(done => server.close(() => done()));
  return port;
}
async function freePorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(await freeTcpPort());
  return [...ports];
}
async function refuses(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000), redirect: 'error' }); return false; }
  catch (e) { return (e as { cause?: { code?: unknown } }).cause?.code === 'ECONNREFUSED'; }
}
// A check that throws is "not yet"; the deadline turns a persistent miss into a plain false for the assertion to report.
async function eventually(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await check()) return true; } catch { /* Not visible yet. */ }
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

// ---- Process helpers -------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const alive = (child: ChildProcess): boolean => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function killTree(child: ChildProcess): Promise<void> {
  if (!alive(child) || child.pid === undefined) return;
  if (process.platform === 'win32') await execFileAsync('taskkill', ['/pid', String(child.pid), '/t', '/f']).catch(() => undefined);
  else child.kill('SIGKILL');
}
// Stops a child started by this file; a child that already exited is left alone.
async function stopChild(child: ChildProcess): Promise<void> {
  if (!alive(child)) return;
  const exited = new Promise<void>(done => child.once('exit', () => done()));
  child.kill();
  await Promise.race([exited, sleep(5000)]);
  if (alive(child)) await killTree(child);
}
// PIDs with a LISTENING socket on exactly this port. Windows uses netstat; other platforms use lsof.
async function listenerPids(port: number): Promise<number[]> {
  const pids = new Set<number>();
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, encoding: 'utf8' });
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
      if (match && Number(match[1]) === port) pids.add(Number(match[2]));
    }
  } else {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).catch(() => ({ stdout: '' }));
    for (const line of stdout.split(/\s+/)) if (/^\d+$/.test(line)) pids.add(Number(line));
  }
  return [...pids];
}
// Captures stdout and stderr in full. Grandchildren may hold the pipes open after the CLI exits, so output closes on a short grace period.
function runProcess(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise(done => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      done({ code, signal, stdout, stderr, durationMs: Date.now() - started, timedOut });
    };
    child.stdout?.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; void killTree(child); }, timeoutMs);
    child.once('error', e => { stderr += `spawn error: ${e.message}\n`; finish(null, null); });
    child.once('close', (code, signal) => finish(code, signal));
    child.once('exit', (code, signal) => { setTimeout(() => finish(code, signal), 3000).unref(); });
  });
}
// The suite's own environment for every spawned process: real PATH and APPDATA, but a fake key and an isolated home.
function envFor(base: EnvBase, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !REMOVED_ENV.has(key.toUpperCase())) env[key] = value;
  }
  Object.assign(env, {
    USERPROFILE: base.home, HOME: base.home,
    ANTHROPIC_API_KEY: base.fakeKey,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    JEV_CLAUDE_PORT: String(base.jevClaudePort), JEV_CODEX_PORT: String(base.jevCodexPort),
    JEV_CLAUDE_UPSTREAM_BASE_URL: `http://127.0.0.1:${base.mockPort}/v1`,
    JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'synthetic-jev', TYPESAFE_BASE_URL: `http://127.0.0.1:${base.mockJevPort}`,
    JEV_SKIP_PROJECT_ENV: '1',
  }, extra);
  return env;
}

// ---- Mock Anthropic upstream -----------------------------------------------------------

function wantsTool(body: Json): boolean {
  const offered = list(body.tools).some(tool => tool.name === TOOL);
  const answered = list(body.messages).some(message => list(message.content).some(block => block.type === 'tool_result'));
  return offered && !answered;
}
function messageJson(tool: boolean, model: string, inputTokens: number): Json {
  return {
    id: 'msg_e2e_claude', type: 'message', role: 'assistant', model,
    content: tool ? [{ type: 'tool_use', id: TOOL_ID, name: TOOL, input: TOOL_INPUT }] : [{ type: 'text', text: RESULT }],
    stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 5 },
  };
}
// Anthropic SSE framing: each frame is "event: X", then "data: {json}", then a blank line.
function sseFrames(tool: boolean, model: string, inputTokens: number): string {
  const block = tool ? { type: 'tool_use', id: TOOL_ID, name: TOOL, input: {} } : { type: 'text', text: '' };
  const delta = tool ? { type: 'input_json_delta', partial_json: JSON.stringify(TOOL_INPUT) } : { type: 'text_delta', text: RESULT };
  const frames: Array<[string, Json]> = [
    ['message_start', { type: 'message_start', message: { id: 'msg_e2e_claude', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
async function startMockAnthropic(): Promise<Mock> {
  const seen: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const raw = await readText(req);
    // Claude Code appends a query string (for example ?beta=true), so only the pathname is compared.
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const body = parseBody(raw);
    seen.push({ method: req.method, path, headers: req.headers, raw, body });
    if (req.method === 'POST' && path.endsWith('/v1/messages/count_tokens')) {
      sendJson(res, 200, { input_tokens: Math.ceil(Buffer.byteLength(raw) / 4) });
      return;
    }
    if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
      sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'mock upstream serves POST /v1/messages' } });
      return;
    }
    const model = typeof body.model === 'string' ? body.model : 'synthetic-claude';
    const inputTokens = Math.ceil(Buffer.byteLength(raw) / 4);
    const tool = wantsTool(body);
    if (body.stream === true) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).end(sseFrames(tool, model, inputTokens));
    else sendJson(res, 200, messageJson(tool, model, inputTokens));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return { port, seen, close: () => closeServer(server) };
}

// ---- Fixture and inspection helpers ----------------------------------------------------

const isMessageCall = (record: Recorded): boolean => record.method === 'POST' && record.path.endsWith('/v1/messages');
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  return list(value).map(block => (typeof block.text === 'string' ? block.text : '')).join('');
}
function toolResultText(body: Json): string {
  const parts: string[] = [];
  for (const message of list(body.messages)) {
    for (const block of list(message.content)) if (block.type === 'tool_result') parts.push(contentText(block.content));
  }
  return parts.join('\n');
}
const hasToolResult = (body: Json): boolean => toolResultText(body).length > 0;
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;
// Recursively collects every string under a "kind" key, so observation shapes can change without breaking the check.
function collectKinds(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(item => collectKinds(item, out));
  else if (isJson(value)) {
    if (typeof value.kind === 'string') out.push(value.kind);
    for (const item of Object.values(value)) collectKinds(item, out);
  }
  return out;
}
async function lineCount(file: string): Promise<number> {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(line => line.trim() !== '').length; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e; }
}
async function routeLineCount(file: string): Promise<number> {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(line => line.includes('"event":"route"')).length; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e; }
}
// Counts of a needle in every file under a tree; the needle is never returned, only counts and sizes.
async function scanTree(dir: string, needles: string[]): Promise<{ files: number; bytes: number; hits: number[] }> {
  const hits = needles.map(() => 0);
  let names: string[];
  try { names = await readdir(dir, { recursive: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { files: 0, bytes: 0, hits }; throw e; }
  let files = 0, bytes = 0;
  for (const name of names) {
    const path = join(dir, name);
    if (!(await stat(path)).isFile()) continue;
    const text = await readFile(path, 'utf8');
    files++; bytes += Buffer.byteLength(text);
    needles.forEach((needle, i) => { hits[i] = (hits[i] ?? 0) + occurrences(text, needle); });
  }
  return { files, bytes, hits };
}
// Non-recursive listing of a directory (name, size, mtime); null when it does not exist.
async function dirListing(dir: string): Promise<string[] | null> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const rows: string[] = [];
  for (const entry of entries) {
    const info = await stat(join(dir, entry.name));
    rows.push(`${entry.name}|${info.size}|${info.mtimeMs}`);
  }
  return rows.sort();
}
async function fileListing(path: string): Promise<string | null> {
  try { const info = await stat(path); return `${info.size}|${info.mtimeMs}`; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
// The real user state: the suite's gateway home, Headroom's home and Claude's global file.
async function realHomeState(): Promise<HomeState> {
  const home = homedir();
  return {
    jevGateway: await dirListing(join(home, '.jev-gateway')),
    headroom: await dirListing(join(home, '.headroom')),
    claudeJson: await fileListing(join(home, '.claude.json')),
  };
}
// The live gateway and a live Claude session keep writing claude.log and .claude.json while the suite runs, so those two are
// checked by attribution (no line or reference from this run) instead of by listing. Everything else must be unchanged.
async function realHomeCheck(c: Ctx): Promise<RealHomeCheck> {
  const now = await realHomeState();
  const stable = (state: HomeState) => JSON.stringify({ jevGateway: state.jevGateway?.filter(row => !row.startsWith('claude.log|')) ?? null, headroom: state.headroom });
  const realLog = await readFile(join(homedir(), '.jev-gateway', 'claude.log')).catch(() => Buffer.alloc(0));
  const offset = Math.min(c.realClaudeLogSize, realLog.length);
  const added = realLog.subarray(offset).toString('utf8');
  const isolated = await readFile(join(c.base.home, '.jev-gateway', 'claude.log'), 'utf8').catch(() => '');
  const runIds = new Set<string>();
  for (const line of isolated.split(/\r?\n/)) {
    const match = /"gatewayRunId":"([^"]+)"/.exec(line);
    if (match?.[1]) runIds.add(match[1]);
  }
  const linesFromIsolated = added.split(/\r?\n/).filter(line => {
    const match = /"gatewayRunId":"([^"]+)"/.exec(line);
    return match?.[1] !== undefined && runIds.has(match[1]);
  }).length;
  const claudeJsonText = await readFile(join(homedir(), '.claude.json'), 'utf8').catch(() => '');
  return {
    strictListingUnchanged: stable(now) === stable(c.realBefore),
    isolatedRouterRunIds: runIds.size,
    claudeLogLinesFromIsolatedRouters: linesFromIsolated,
    claudeLogTmpMarkerHits: occurrences(realLog.toString('utf8'), c.tmpName),
    claudeJsonTmpMarkerHits: occurrences(claudeJsonText, c.tmpName),
    liveClaudeLogBytesAdded: realLog.length - offset,
    liveClaudeJsonMtimeChanged: now.claudeJson !== c.realBefore.claudeJson,
  };
}
function parseClientJson(stdout: string): Json | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()) as unknown; } catch { return undefined; }
  if (Array.isArray(parsed)) return list(parsed).find(item => item.type === 'result');
  return isJson(parsed) ? parsed : undefined;
}
async function mcpCall(mcp: Mcp, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await mcp.rpc('tools/call', { name, arguments: args }) as { isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined;
  if (!result || result.isError) throw new Error(`${name} returned an error`);
  const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

// ---- Profiles and runs -----------------------------------------------------------------

function templateConfig(base: Config, ports: number[], headroom: { enabled: boolean; version: string }): Config {
  const [control, memory, gateway, dashboard, headroomPort] = ports;
  return configSchema.parse({
    ...base, workspace: WORKSPACE, project: 'e2e-template', controlPort: control,
    memory: { enabled: true, port: memory, semanticSearch: false },
    dashboard: { port: dashboard },
    gateway: { ...base.gateway, enabled: false, port: gateway },
    headroom: { enabled: headroom.enabled, port: headroomPort, version: headroom.version },
  });
}
// Each template is written once and kept on disk; a leftover template from an interrupted run is removed first.
async function writeTemplate(template: string, headroom: { enabled: boolean; version: string }): Promise<void> {
  const base = configSchema.parse(await json(resolve(root, 'config/default.json')));
  await rm(profileDir(template), { recursive: true, force: true, maxRetries: 5 });
  await init(template);
  const ports = await freePorts(5);
  await atomicJson(resolve(profileDir(template), 'suite.json'), templateConfig(base, ports, headroom));
}
// The project profile is the one a launch from the project folder uses; its marker is written from that profile's own config.
async function setupProject(tmp: string, slot: Slot, template: string): Promise<Project> {
  const dir = join(tmp, `hr-${slot}`);
  await mkdir(dir, { recursive: true });
  const context = await projectContext(template, dir);
  const config = await readConfig(context.name);
  await writeFile(join(context.cwd, '.ai-memory.toml'), `workspace = "${config.workspace}"\nproject = "${config.project}"\n`);
  await writeFile(join(context.cwd, 'emit.js'), EMIT_JS);
  return { slot, template, name: context.name, dir: context.cwd, config };
}
function cliArgs(p: Project, ...rest: string[]): string[] {
  return ['--profile', p.template, '--dir', p.dir, ...rest];
}
// Starts a project profile through the same CLI a user runs. Its environment matches the claude runs, so the supervisor and Headroom stay isolated.
async function startProject(c: Ctx, p: Project): Promise<number | undefined> {
  const run = await runProcess([CLI, ...cliArgs(p, 'start')], envFor(c.base), p.dir, 150_000);
  assert.equal(run.code, 0, `start of ${p.template} exited ${run.code ?? run.signal}`);
  const pid = (parseClientJson(run.stdout) ?? {}).pid;
  return typeof pid === 'number' ? pid : undefined;
}
// Runs the native `claude -p` through `jev-memory claude`. The CLI is invoked directly with the profile options before the client name, which is the form the CLI's delegation parser expects.
async function runClaude(c: Ctx, p: Project, label: string, extra: Record<string, string> = {}): Promise<RunInfo> {
  const requestsLog = join(profileDir(p.name), 'logs', 'headroom-requests.jsonl');
  const routeLog = join(c.base.home, '.jev-gateway', 'claude.log');
  const seenStart = c.mock.seen.length, routesBefore = await routeLineCount(routeLog), requestsBefore = await lineCount(requestsLog);
  const args = cliArgs(p, 'claude', '-p', PROMPT, '--output-format', 'json', '--allowedTools', 'Bash(node emit.js)');
  const result = await runProcess([CLI, ...args], envFor(c.base, extra), p.dir, 180_000);
  await writeFile(join(c.e2eDir, `${label}.stdout.txt`), result.stdout);
  await writeFile(join(c.e2eDir, `${label}.stderr.txt`), result.stderr);
  const seen = c.mock.seen.slice(seenStart);
  // Log writers flush asynchronously, so the deltas are read after a bounded wait for them to appear.
  await eventually(async () => (await routeLineCount(routeLog)) > routesBefore, 15_000);
  await eventually(async () => (await lineCount(requestsLog)) > requestsBefore, 15_000);
  const routeDelta = (await routeLineCount(routeLog)) - routesBefore;
  const requestsDelta = (await lineCount(requestsLog)) - requestsBefore;
  const info: RunInfo = { result, calls: seen.filter(isMessageCall), seen, routeDelta, requestsDelta };
  c.runs[label] = info;
  return info;
}

// ---- Evidence --------------------------------------------------------------------------

const results: Array<{ name: string; status: 'pass' | 'fail'; durationMs: number }> = [];
const evidence: Record<string, unknown> = {};
function step(name: string, timeout: number, body: (t: TestContext) => Promise<void>): void {
  test(name, { timeout }, async t => {
    const started = Date.now();
    let status: 'pass' | 'fail' = 'fail';
    try { await body(t); status = 'pass'; }
    finally { results.push({ name, status, durationMs: Date.now() - started }); }
  });
}

describe('jev-memory claude launch e2e (Headroom, isolated)', { skip, concurrency: 1, timeout: 1_500_000 }, () => {
  let c: Ctx | undefined;
  let finished = false;
  const liveState = (): Ctx => {
    if (!c) throw new Error('claude launch rig was not started');
    return c;
  };

  async function finish(): Promise<void> {
    if (finished || !c) return;
    finished = true;
    const r = c, errors: unknown[] = [];
    const guard = async (step: () => Promise<unknown>) => { try { await step(); } catch (e) { errors.push(e); } };
    // Profiles stop first, so Headroom and the supervisors are gone before their directories are removed.
    for (const p of Object.values(r.projects)) await guard(() => stop(p.name));
    // Scratch Jev router: stopped through its own launcher with the same environment, then probed.
    const stopped = await runProcess([LAUNCHER, '--stop'], envFor(r.base), root, 30_000).catch(() => undefined);
    evidence.jevScratchRouterStop = { exitCode: stopped?.code ?? null, stoppedMessage: stopped?.stdout.includes('stopped router') ?? false };
    const jevRouterRefused = await eventually(() => refuses(r.base.jevClaudePort), 10_000);
    if (!jevRouterRefused) {
      const pids = await listenerPids(r.base.jevClaudePort);
      for (const pid of pids) process.kill(pid);
      evidence.jevScratchRouterLastResortKills = pids.length;
    }
    // Last-resort cleanup for leftovers from a failed run: only processes listening on this run's own ports.
    const leftovers: Record<string, number> = {};
    for (const p of Object.values(r.projects)) {
      const pids = await listenerPids(p.config.headroom.port);
      leftovers[`${p.slot}.headroom`] = pids.length;
      for (const pid of pids) process.kill(pid);
    }
    evidence.headroomLastResortKills = leftovers;
    // The isolated router's log is read here, before its temp home is removed, to attribute the real log's new lines.
    await guard(async () => {
      const check = await realHomeCheck(r);
      evidence.realHome = check;
      evidence.realHomeUnchanged = check.strictListingUnchanged && check.claudeLogTmpMarkerHits === 0 && check.claudeJsonTmpMarkerHits === 0 && check.claudeLogLinesFromIsolatedRouters === 0;
    });
    await guard(() => stopChild(r.mockJev));
    await guard(() => r.mockJevLog.close());
    await guard(() => r.mock.close());
    const profileNames = [...Object.values(r.projects).map(p => p.name), ...Object.values(TEMPLATES)];
    for (const name of profileNames) await guard(() => rm(profileDir(name), { recursive: true, force: true, maxRetries: 5 }));
    await guard(() => rm(r.tmp, { recursive: true, force: true, maxRetries: 5 }));
    await guard(() => rm(r.e2eDir, { recursive: true, force: true, maxRetries: 5 }));
    evidence.passedTests = results.filter(item => item.status === 'pass').map(item => item.name);
    evidence.tests = results;
    await prepare(EVIDENCE_DIR);
    const text = JSON.stringify(evidence, null, 2);
    assert.equal(text.includes(r.base.fakeKey), false, 'evidence must not contain the fake key');
    assert.equal(text.includes(r.marker), false, 'evidence must not contain the handoff marker');
    await atomicJson(resolve(EVIDENCE_DIR, EVIDENCE_FILE), evidence);
    if (errors.length > 0) throw new AggregateError(errors, 'claude launch cleanup failed');
  }

  before(async () => {
    const realBefore = await realHomeState();
    await prepare(E2E_BASE);
    const e2eDir = await mkdtemp(resolve(E2E_BASE, 'claude-launch-'));
    // The isolated home and the external project folders live under the OS temp dir, outside the repository.
    const tmp = await mkdtemp(join(tmpdir(), 'jev-claude-launch-'));
    const home = join(tmp, 'home');
    await mkdir(home, { recursive: true });
    const mock = await startMockAnthropic();
    const mockJevPort = await freeTcpPort(), jevClaudePort = await freeTcpPort(), jevCodexPort = await freeTcpPort();
    const base: EnvBase = { home, fakeKey: `sk-ant-e2e-fake-${randomUUID()}`, mockPort: mock.port, mockJevPort, jevClaudePort, jevCodexPort };
    const mockJevDump = join(e2eDir, 'mock-jev-dump'), mockJevLogPath = join(e2eDir, 'mock-jev.log');
    const mockJevLog = await open(mockJevLogPath, 'a');
    const mockJev = spawn(process.execPath, [resolve(root, 'upstream/jev-gateway/scripts/mock-jev.mjs')], {
      cwd: root, shell: false, windowsHide: true, stdio: ['ignore', mockJevLog.fd, mockJevLog.fd],
      env: envFor(base, { MOCK_JEV_PORT: String(mockJevPort), MOCK_JEV_SCRIPT: `${TOOL},no_tool_needed`, MOCK_JEV_DUMP_DIR: mockJevDump }),
    });
    mockJev.on('error', () => undefined);
    const ready = await eventually(async () => (await readFile(mockJevLogPath, 'utf8')).includes('mock-jev on'), 20_000);
    assert.ok(ready, 'mock-jev did not start');
    c = { base, tmp, e2eDir, mock, mockJev, mockJevLog, mockJevDump, projects: {} as Record<Slot, Project>, runs: {},
      marker: `HANDOFF-E2E-${randomUUID()}`, supervisorPids: {}, realBefore,
      realClaudeLogSize: await stat(join(homedir(), '.jev-gateway', 'claude.log')).then(info => info.size, () => 0), tmpName: basename(tmp) };
    try {
      await writeTemplate(TEMPLATES.on, { enabled: true, version: HEADROOM_VERSION });
      await writeTemplate(TEMPLATES.off, { enabled: false, version: HEADROOM_VERSION });
      await writeTemplate(TEMPLATES.bad, { enabled: true, version: '0.0.1' });
      const projects: Partial<Record<Slot, Project>> = {};
      for (const slot of ['on', 'off', 'bad'] as const) projects[slot] = await setupProject(tmp, slot, TEMPLATES[slot]);
      c.projects = projects as Record<Slot, Project>;
    } catch (error) {
      await finish().catch(() => undefined);
      throw error;
    }
  }, { timeout: 240_000 });

  after(async () => {
    await finish();
  }, { timeout: 300_000 });

  step('headroom enabled: claude goes Claude -> Headroom -> Jev -> provider', 900_000, async t => {
    const r = liveState();
    const p = r.projects.on;
    const pid = await startProject(r, p);
    if (pid !== undefined) r.supervisorPids.on = pid;
    // A pending handoff is created through MCP before the first run, so the SessionStart hook has something to inject.
    const mcp = await Mcp.connect(p.name);
    const handoff = await mcpCall(mcp, 'memory_handoff_begin', {
      summary: `${r.marker} synthetic handoff for the claude launch e2e`, open_questions: [], next_steps: ['none'], files_touched: [],
      shared: true, workspace: p.config.workspace, project: p.config.project,
    });
    t.diagnostic(`handoff created: ${isJson(handoff) ? 'object' : typeof handoff}`);
    const info = await runClaude(r, p, 'run1');
    const { result } = info;
    assert.equal(result.timedOut, false, 'run 1 timed out');
    assert.equal(result.code, 0, `run 1 exit code ${result.code ?? result.signal}\n${result.stderr.slice(-2000)}`);
    // Regression check for the stdout fix: with Headroom in the path, stdout is exactly one JSON document.
    const reply = parseClientJson(result.stdout);
    let topLevel: string;
    try { topLevel = Array.isArray(JSON.parse(result.stdout.trim())) ? 'array' : 'object'; } catch { topLevel = 'not-json'; }
    assert.equal(topLevel === 'not-json', false, 'stdout must parse as a single JSON document');
    assert.ok(reply, 'stdout must contain a result object');
    assert.equal(reply.result, RESULT);
    assert.equal(reply.is_error, false);
    const turns = typeof reply.num_turns === 'number' ? reply.num_turns : 0;
    assert.ok(turns >= 2, `num_turns ${turns} is below 2`);
    assert.equal(result.stderr.includes('Headroom not used'), false, 'Headroom must be used in run 1');
    r.sessionId = typeof reply.session_id === 'string' ? reply.session_id : undefined;
    assert.ok(r.sessionId, 'stdout must carry the session id');
    assert.ok(info.requestsDelta >= 2, `headroom-requests.jsonl grew by ${info.requestsDelta}, expected >= 2`);
    assert.ok(info.calls.length >= 2, `mock saw ${info.calls.length} POST /v1/messages, expected >= 2`);
    assert.ok(info.routeDelta >= 1, `claude.log gained ${info.routeDelta} route lines`);
    for (const record of info.seen) {
      assert.equal(record.headers['x-api-key'], r.base.fakeKey, `${record.path} carried a different x-api-key`);
      assert.equal(record.headers.authorization, undefined, `${record.path} carried an authorization header`);
    }
    // Tool result: every request_id and every ERROR line must survive; the body must be smaller than the raw output.
    const toolTurn = info.calls.find(record => hasToolResult(record.body));
    assert.ok(toolTurn, 'no forwarded request carries the tool_result');
    const forwardedText = toolResultText(toolTurn.body);
    const emitted = (await execFileAsync(process.execPath, ['emit.js'], { cwd: p.dir, encoding: 'utf8' })).stdout;
    assert.equal(occurrences(forwardedText, 'req-1'), LOG_COUNT, 'every request_id must survive compression');
    assert.equal(occurrences(forwardedText, 'ERROR'), 3, 'every ERROR line must survive compression');
    assert.ok(forwardedText.length < emitted.length, `tool result was not compressed (${forwardedText.length} >= ${emitted.length})`);
    for (let i = 0; i < LOG_COUNT; i++) assert.ok(forwardedText.includes(`req-${100000 + i}"`) || forwardedText.includes(`req-${100000 + i}`), `request req-${100000 + i} missing`);
    for (const record of info.calls) {
      assert.equal(list(record.body.tools).some(tool => tool.name === 'headroom_retrieve'), false, 'headroom_retrieve must not be offered');
    }
    evidence.run1 = {
      exitCode: result.code, durationMs: result.durationMs, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
      topLevel, numTurns: turns, mockPostMessages: info.calls.length, mockRequests: info.seen.length, routeLines: info.routeDelta,
      headroomRequestLines: info.requestsDelta, toolResultBytes: forwardedText.length, emitBytes: emitted.length,
      requestIdOccurrences: occurrences(forwardedText, 'req-1'), errorOccurrences: occurrences(forwardedText, 'ERROR'),
    };
    t.diagnostic(`run1 ${result.durationMs} ms, ${info.calls.length} POST /v1/messages, ${info.requestsDelta} headroom lines, tool result ${forwardedText.length} vs emit ${emitted.length} bytes`);
  });

  step('AI Memory hooks and handoff survive Headroom', 120_000, async t => {
    const r = liveState();
    const info = r.runs.run1;
    assert.ok(info, 'run 1 must complete first');
    const first = info.calls[0];
    assert.ok(first, 'run 1 sent no /v1/messages request');
    assert.ok(first.raw.includes(r.marker), 'the first /v1/messages body of run 1 has no handoff marker');
    const withMarker = info.calls.filter(record => record.raw.includes(r.marker)).length;
    assert.ok(r.sessionId, 'run 1 must report a session id');
    const mcp = await Mcp.connect(r.projects.on.name);
    let kinds: string[] = [];
    const ok = await eventually(async () => {
      const reply = await mcpCall(mcp, 'memory_read_session_observations', {
        session_id: r.sessionId, workspace: r.projects.on.config.workspace, project: r.projects.on.config.project,
        order: 'asc', limit: 200, body_max_chars: 200,
      });
      kinds = collectKinds(reply);
      return kinds.some(kind => kind === 'pre-tool-use' || kind === 'post-tool-use') && kinds.some(kind => kind === 'stop' || kind === 'session-end');
    }, 30_000);
    const counts: Record<string, number> = {};
    for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
    t.diagnostic(`observation kinds: ${JSON.stringify(counts)}`);
    assert.ok(ok, `observations lack a tool use and a stop/session-end: ${JSON.stringify(counts)}`);
    evidence.handoffAndObservations = {
      firstMessageHasHandoff: true, messagesWithHandoff: withMarker, observationKinds: counts, observationTotal: kinds.length,
    };
  });

  step('per-launch opt-out: JMS_HEADROOM=off bypasses Headroom', 300_000, async t => {
    const r = liveState();
    const p = r.projects.on;
    const headroomBefore = await lineCount(join(profileDir(p.name), 'logs', 'headroom-requests.jsonl'));
    const info = await runClaude(r, p, 'run3', { JMS_HEADROOM: 'off' });
    assert.equal(info.result.code, 0, `run 3 exit code ${info.result.code ?? info.result.signal}`);
    assert.ok(info.result.stderr.includes('Headroom not used: Headroom bypassed by JMS_HEADROOM=off'), 'stderr lacks the opt-out reason');
    await sleep(1000);
    assert.equal(await lineCount(join(profileDir(p.name), 'logs', 'headroom-requests.jsonl')), headroomBefore, 'Headroom log grew during the opt-out run');
    const reply = parseClientJson(info.result.stdout);
    assert.equal(reply?.result, RESULT, 'the opt-out run must still answer through Jev');
    assert.ok(info.calls.length >= 1, 'mock upstream must serve the opt-out run');
    assert.ok(info.routeDelta >= 1, 'the opt-out run must route through Jev');
    evidence.optOut = { exitCode: info.result.code, durationMs: info.result.durationMs, mockPostMessages: info.calls.length, routeLines: info.routeDelta, headroomLinesAdded: 0 };
    t.diagnostic(`opt-out run ${info.result.durationMs} ms`);
  });

  step('fallback before the client starts: unavailable Headroom version', 300_000, async t => {
    const r = liveState();
    const p = r.projects.bad;
    const info = await runClaude(r, p, 'run4');
    assert.equal(info.result.code, 0, `run 4 exit code ${info.result.code ?? info.result.signal}`);
    assert.ok(info.result.stderr.includes('Headroom not used: Headroom service is unavailable'), 'stderr lacks the unavailable reason');
    assert.equal(parseClientJson(info.result.stdout)?.result, RESULT, 'the fallback run must still answer');
    const status = await control(p.name, 'status');
    const services = (status.services ?? {}) as Record<string, unknown>;
    assert.equal(services.headroom, 'unavailable');
    assert.equal(status.phase, 'ready');
    const reason = String(status.headroomReason ?? '');
    assert.ok(reason.includes('0.0.1'), `headroomReason does not name the required version: ${reason}`);
    r.supervisorPids.bad = Number(status.pid);
    evidence.fallbackUnavailable = { exitCode: info.result.code, durationMs: info.result.durationMs, serviceState: services.headroom, phase: status.phase, reasonNamesRequiredVersion: true };
    t.diagnostic(`unavailable fallback ${info.result.durationMs} ms`);
  });

  step('disabled keeps the original launcher path', 300_000, async t => {
    const r = liveState();
    const p = r.projects.off;
    const info = await runClaude(r, p, 'run5');
    assert.equal(info.result.code, 0, `run 5 exit code ${info.result.code ?? info.result.signal}`);
    assert.equal(info.result.stderr.includes('Headroom'), false, 'a disabled profile must not mention Headroom');
    assert.equal(parseClientJson(info.result.stdout)?.result, RESULT, 'the disabled run must still answer');
    assert.ok(info.calls.length >= 1 && info.routeDelta >= 1, 'the disabled run must be served through Jev');
    const status = await control(p.name, 'status');
    const services = (status.services ?? {}) as Record<string, unknown>;
    assert.equal('headroom' in services, false, 'a disabled profile must not report a headroom service');
    assert.equal(status.phase, 'ready');
    r.supervisorPids.off = Number(status.pid);
    evidence.disabled = { exitCode: info.result.code, durationMs: info.result.durationMs, mockPostMessages: info.calls.length, routeLines: info.routeDelta, headroomServiceReported: false };
    t.diagnostic(`disabled run ${info.result.durationMs} ms`);
  });

  step('recovery between launches: a killed Headroom comes back', 420_000, async t => {
    const r = liveState();
    const p = r.projects.on;
    const port = p.config.headroom.port;
    const pids = await listenerPids(port);
    assert.ok(pids.length >= 1, `no process listens on the Headroom port ${port}`);
    for (const pid of pids) process.kill(pid);
    const recovered = await eventually(async () => {
      const status = await control(p.name, 'status');
      const services = (status.services ?? {}) as Record<string, unknown>;
      const restarts = (status.restarts ?? {}) as Record<string, unknown>;
      return services.headroom === 'ready' && Number(restarts.headroom ?? 0) >= 1 && status.phase === 'ready';
    }, 120_000);
    assert.ok(recovered, 'Headroom did not return to ready with a restart recorded');
    const status = await control(p.name, 'status');
    const restarts = (status.restarts ?? {}) as Record<string, unknown>;
    const info = await runClaude(r, p, 'run6');
    assert.equal(info.result.code, 0, `run 6 exit code ${info.result.code ?? info.result.signal}`);
    assert.equal(info.result.stderr.includes('Headroom not used'), false, 'run 6 must use Headroom after recovery');
    assert.equal(parseClientJson(info.result.stdout)?.result, RESULT, 'the recovered run must answer');
    assert.ok(info.requestsDelta >= 1, 'the recovered run must add lines to the Headroom log');
    evidence.recovery = { killedListeners: pids.length, restarts: Number(restarts.headroom ?? 0), phase: status.phase, durationMs: info.result.durationMs, headroomRequestLines: info.requestsDelta };
    t.diagnostic(`recovery restarts=${String(restarts.headroom)} run ${info.result.durationMs} ms`);
  });

  step('cleanup: profiles, Headroom and Jev scratch router stop; real home unchanged', 300_000, async t => {
    const r = liveState();
    for (const p of Object.values(r.projects)) await stop(p.name);
    const ports = Object.values(r.projects).map(p => p.config.headroom.port);
    const refused = await Promise.all(ports.map(port => eventually(() => refuses(port), 15_000)));
    assert.deepEqual(refused, ports.map(() => true), 'a Headroom port still accepts connections after stop');
    for (const p of Object.values(r.projects)) {
      const pid = r.supervisorPids[p.slot];
      if (pid !== undefined) assert.equal(pidAlive(pid), false, `supervisor ${pid} for ${p.slot} is still running`);
    }
    const jevStop = await runProcess([LAUNCHER, '--stop'], envFor(r.base), root, 30_000);
    assert.equal(jevStop.code, 0, 'the scratch Jev router must stop through its launcher');
    assert.ok(await eventually(() => refuses(r.base.jevClaudePort), 15_000), 'the scratch Jev router still accepts connections');
    // Security scan: the fake key must appear nowhere in the project logs, Headroom workspace or isolated gateway home.
    const hr = r.projects.on;
    const key = r.base.fakeKey, marker = r.marker;
    const logs = await scanTree(join(profileDir(hr.name), 'logs'), [key]);
    const headroomWs = await scanTree(join(profileDir(hr.name), 'headroom'), [key]);
    const gateway = await scanTree(join(r.base.home, '.jev-gateway'), [key]);
    assert.equal(logs.hits[0], 0, 'the fake key appears in the project logs');
    assert.equal(headroomWs.hits[0], 0, 'the fake key appears in the Headroom workspace');
    assert.equal(gateway.hits[0], 0, 'the fake key appears in the isolated gateway home');
    const requestsFile = join(profileDir(hr.name), 'logs', 'headroom-requests.jsonl');
    const requestsText = await readFile(requestsFile, 'utf8').catch(() => '');
    const handoffInRequests = occurrences(requestsText, marker);
    assert.equal(handoffInRequests, 0, 'the handoff marker appears in headroom-requests.jsonl');
    const runOutputs = Object.values(r.runs).map(run => run.result.stdout + run.result.stderr);
    const keyInRunOutput = runOutputs.reduce((sum, text) => sum + occurrences(text, key), 0);
    assert.equal(keyInRunOutput, 0, 'the fake key appears in run output');
    evidence.securityScan = {
      projectLogs: { files: logs.files, bytes: logs.bytes, fakeKeyHits: logs.hits[0] },
      headroomWorkspace: { files: headroomWs.files, bytes: headroomWs.bytes, fakeKeyHits: headroomWs.hits[0] },
      isolatedGatewayHome: { files: gateway.files, bytes: gateway.bytes, fakeKeyHits: gateway.hits[0] },
      headroomRequestsHandoffHits: handoffInRequests, runOutputFakeKeyHits: keyInRunOutput,
    };
    evidence.cleanup = { headroomPortsRefused: refused.every(Boolean), jevScratchRouterStopped: jevStop.code === 0, jevPortRefused: true };
    const check = await realHomeCheck(r);
    evidence.realHome = check;
    assert.equal(check.strictListingUnchanged, true, 'the real ~/.jev-gateway (except claude.log) or ~/.headroom listing changed during the run');
    assert.equal(check.claudeLogLinesFromIsolatedRouters, 0, 'the real claude.log holds lines from this run\'s isolated router');
    assert.equal(check.claudeLogTmpMarkerHits, 0, 'the real claude.log references this run\'s temp home');
    assert.equal(check.claudeJsonTmpMarkerHits, 0, 'the real ~/.claude.json references this run\'s temp home');
    // Records the wrapper defect: with "claude" prepended, --profile/--dir never reach the CLI parser.
    const wrapperForwardsOptions = delegatedCommand(['claude', '--profile', 'x'])?.rest.includes('--profile') ?? false;
    evidence.binWrapper = {
      note: 'bin/jev-memory-claude.mjs prepends "claude" before the user arguments, so --profile/--dir are passed to Claude instead of the CLI',
      profileOptionsForwardedToClient: wrapperForwardsOptions,
    };
    t.diagnostic('cleanup verified');
  });
});
