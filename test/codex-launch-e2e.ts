import { test, describe, before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { configSchema, json, prepare, profileDir, readConfig, root, type Config } from '../src/config.js';
import { init, control, stop } from '../src/lifecycle.js';
import { atomicJson, sleep } from '../src/local.js';
import { clientCommand } from '../src/launch.js';
import { detectHeadroomPython } from '../src/headroom.js';
import { gatewayDir } from '../src/install.js';
import { projectContext } from '../src/projects.js';
import { hookEntries } from '../src/clients.js';
import { Mcp } from '../src/mcp.js';

// Real `jev-memory codex` launch path, end to end, with isolated profiles and local mocks only:
// CLI -> projectContext -> jevLaunch -> prepareHeadroom -> supervisor-managed Headroom (Codex shim) -> real Codex CLI.
// Codex's ChatGPT backend is a local mock reached through the Jev codex router; Jev's tool selection goes to mock-jev.
// Every process runs with an egress fence (an HTTP proxy that refuses and records each target), so any direct connection is refused and logged.
// Nothing reaches a paid API, a real credential, the live gateways (8789/8790), or the user's real Codex, Claude or Headroom state.

const HEADROOM_VERSION = '0.41.0';
const headroomDetection = await detectHeadroomPython({ headroom: { enabled: true, port: 1, version: HEADROOM_VERSION, codex: true } });
const codexFound = await clientCommand('codex').then(() => true, () => false);
const claudeFound = await clientCommand('claude').then(() => true, () => false);
const skip: string | false = !headroomDetection.ok ? `Headroom ${HEADROOM_VERSION} Codex route is not usable: ${headroomDetection.reason}`
  : !codexFound ? 'Codex CLI (codex) is not installed on PATH'
    : !claudeFound ? 'Claude Code (claude) is not installed on PATH' : false;

const CLI = resolve(root, 'dist/src/cli.js');
const CODEX_LAUNCHER = resolve(gatewayDir(), 'bin/jev-codex.mjs');
const CLAUDE_LAUNCHER = resolve(gatewayDir(), 'bin/jev-claude.mjs');
const E2E_BASE = resolve(root, '.local/e2e');
const EVIDENCE_DIR = resolve(root, '.local/evidence'), EVIDENCE_FILE = 'codex-launch-e2e.json';
const WORKSPACE = 'e2e-codex';
const PROMPT = 'Run node emit.js and count ERROR entries';
const CODEX_DONE = 'E2E-CODEX-DONE', CLAUDE_DONE = 'E2E-CLAUDE-DONE';
const EXEC_TOOL = 'exec', CALL_ID = 'call_e2e_exec', MODEL = 'gpt-e2e';
// The code-mode script the mock asks Codex to run: one shell command, inside the temp project.
const EXEC_CODE = 'const r = await tools.exec_command({ cmd: "node emit.js" });\ntext(r);';
const LOG_COUNT = 120;
const RESPONSES_PATH = '/backend-api/codex/responses', MODELS_PATH = '/backend-api/codex/models';
const MESSAGES_PATH = '/v1/messages', COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
const TEMPLATES = { on: 'e2e-cx-on', noshim: 'e2e-cx-noshim', off: 'e2e-cx-off' } as const;
const LIVE_LOGS = ['claude.log', 'codex.log'] as const;

// Synthetic identifiers. The fake login is unsigned and its account id is unique to this run; no real credential is read or written.
const UUID = randomUUID();
const CANARY = `CANARY-CODEX-${UUID}`;
const ACCOUNT_ID = `acct-e2e-${UUID}`;
const EXP = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeJwt = (claims: Record<string, unknown>): string => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.sig`;
const AUTH_CLAIM = { chatgpt_account_id: ACCOUNT_ID, chatgpt_plan_type: 'plus' };
const ACCESS_TOKEN = fakeJwt({ exp: EXP, sub: `e2e|${UUID}`, 'https://api.openai.com/auth': AUTH_CLAIM });
const ID_TOKEN = fakeJwt({ exp: EXP, email: `e2e-${UUID}@example.invalid`, 'https://api.openai.com/auth': AUTH_CLAIM });
const REFRESH_TOKEN = `rt_e2e_fake_${UUID}`;
const CLIENT_BEARER = `Bearer ${ACCESS_TOKEN}`;
const ANTHROPIC_KEY = `sk-ant-e2e-fake-${UUID}`;
const FORBIDDEN = [CANARY, ACCESS_TOKEN, ID_TOKEN, REFRESH_TOKEN, ACCOUNT_ID, ANTHROPIC_KEY];
// Synthetic log fixture: 120 rows, every 47th is ERROR. The canary rides in row 0 so it reaches the tool output.
const EMIT_JS = `// Synthetic log fixture for the codex launch e2e: ${LOG_COUNT} rows, every 47th is ERROR.
const rows = Array.from({ length: ${LOG_COUNT} }, (_, i) => ({
  ts: new Date(Date.UTC(2026, 9, 23, 12) + i * 1000).toISOString(),
  level: i % 47 === 0 ? 'ERROR' : 'INFO',
  service: 'synthetic-api',
  request_id: \`req-\${100000 + i}\`,
  latency_ms: 20 + ((i * 37) % 400),
  status: i % 47 === 0 ? 500 : 200,
  path: \`/v1/items/\${i % 10}\`,
  msg: i % 47 === 0 ? 'upstream timeout' : 'request completed',
  ...(i === 0 ? { trace: '${CANARY}' } : {}),
}));
console.log(JSON.stringify(rows, null, 2));
`;
const FORBIDDEN_LABELS = ['canary', 'access token', 'id token', 'refresh token', 'account id', 'anthropic key'];
const PROXY_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);
// Variables that would point a client or the suite at real credentials or real state; removed case-insensitively.
const removedEnv = (key: string): boolean => {
  const upper = key.toUpperCase();
  return ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'JMS_HEADROOM', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME'].includes(upper)
    || upper.startsWith('ANTHROPIC_') || PROXY_KEYS.has(upper);
};

type Json = Record<string, unknown>;
type Slot = keyof typeof TEMPLATES;
interface Recorded { method: string | undefined; path: string; headers: IncomingHttpHeaders; raw: string; body: Json }
interface Mock { port: number; seen: Recorded[]; close: () => Promise<void>; setExecCode: (code?: string) => void }
interface Fence { port: number; url: string; hits: Array<{ kind: 'connect' | 'http'; host: string }>; close: () => Promise<void> }
interface EnvBase { home: string; codexHome: string; fenceUrl: string; mockPort: number; mockJevPort: number; jevCodexPort: number; jevClaudePort: number }
interface Project { slot: Slot; template: string; name: string; dir: string; config: Config }
interface RunResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }
interface RunInfo {
  result: RunResult; responses: Recorded[]; messages: Recorded[]; seen: Recorded[]; routeDelta: number; requestsDelta: number;
  // Hosts the egress fence refused during this run only, and MCP request lines the memory server logged during it.
  fenceHosts: string[]; mcpRequestLines: number;
}
interface HomeState { jevGateway: string[] | null; headroom: string[] | null; codexEntries: string[] | null; codexAuth: string | null; claudeJson: string | null }
interface RealHomeCheck {
  jevGatewayUnchanged: boolean; headroomUnchanged: boolean; codexAuthUnchanged: boolean; codexEntriesAdded: number; codexEntriesRemoved: number;
  isolatedRouterRunIds: number; liveLogLinesFromIsolatedRouters: number; liveLogTmpMarkerHits: number; claudeJsonTmpMarkerHits: number;
  liveLogBytesAdded: number; claudeJsonMtimeChanged: boolean;
}
interface Ctx {
  base: EnvBase; tmp: string; e2eDir: string; mock: Mock; fence: Fence; mockJev: ChildProcess; mockJevLog: FileHandle; mockJevDump: string;
  projects: Record<Slot, Project>; runs: Record<string, RunInfo>; realBefore: HomeState; realLogSizes: Record<string, number>; tmpName: string;
  supervisorPids: Record<string, number>;
}

// ---- JSON and HTTP helpers -------------------------------------------------------------

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const field = (value: unknown): Json => (isJson(value) ? value : {});
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
const headerOf = (record: Recorded, name: string): string | undefined => {
  const value = record.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
};

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
// The suite's own environment for every spawned process: real PATH and APPDATA, but an isolated home and Codex home,
// local mocks only, and an egress fence that refuses (and records) every proxied connection.
function envFor(base: EnvBase, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !removedEnv(key)) env[key] = value;
  }
  Object.assign(env, {
    USERPROFILE: base.home, HOME: base.home, CODEX_HOME: base.codexHome,
    HTTPS_PROXY: base.fenceUrl, HTTP_PROXY: base.fenceUrl, ALL_PROXY: base.fenceUrl, NO_PROXY: '127.0.0.1,localhost',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    JEV_CLAUDE_PORT: String(base.jevClaudePort), JEV_CODEX_PORT: String(base.jevCodexPort),
    JEV_CLAUDE_UPSTREAM_BASE_URL: `http://127.0.0.1:${base.mockPort}/v1`,
    JEV_CODEX_UPSTREAM_BASE_URL: `http://127.0.0.1:${base.mockPort}/backend-api/codex`,
    JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'synthetic-jev', TYPESAFE_BASE_URL: `http://127.0.0.1:${base.mockJevPort}`,
    JEV_SKIP_PROJECT_ENV: '1',
  }, extra);
  return env;
}

// ---- Mock ChatGPT backend and Anthropic upstream ---------------------------------------

// Every tool declaration reachable in the body, whether it sits in tools[] or inside an additional_tools input item.
interface ToolDecl { name: string; type: string }
function declaredTools(value: unknown, out: ToolDecl[] = []): ToolDecl[] {
  if (Array.isArray(value)) value.forEach(item => declaredTools(item, out));
  else if (isJson(value)) {
    if (typeof value.name === 'string' && (value.type === 'custom' || value.type === 'function')) out.push({ name: value.name, type: value.type });
    for (const item of Object.values(value)) declaredTools(item, out);
  }
  return out;
}
// The code-mode exec tool is answered with a custom tool call once; after its output is in the input, the model answers in text.
function wantsExecCall(body: Json): boolean {
  const offered = declaredTools(body).some(tool => tool.name === EXEC_TOOL && tool.type === 'custom');
  const answered = list(body.input).some(item => item.type === 'custom_tool_call_output' || item.type === 'function_call_output');
  return offered && !answered;
}
function execItem(code: string): Json {
  return { type: 'custom_tool_call', id: 'ctc_e2e1', call_id: CALL_ID, namespace: 'functions', name: EXEC_TOOL, input: code, status: 'completed' };
}
function textItem(): Json {
  return { type: 'message', id: 'msg_e2e1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: CODEX_DONE, annotations: [] }] };
}
function responsesUsage(inputTokens: number): Json {
  return { input_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: inputTokens + 5 };
}
// Responses API framing: each frame is "event: X" then "data: {json}" then a blank line.
function responsesSse(model: string, exec: boolean, inputTokens: number, code: string): string {
  const item = exec ? execItem(code) : textItem();
  const base = { id: 'resp_e2e', object: 'response', status: 'in_progress', model, output: [] };
  const frames: Array<[string, Json]> = [['response.created', { type: 'response.created', response: base }]];
  if (exec) {
    frames.push(['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, input: '', status: 'in_progress' } }]);
    frames.push(['response.custom_tool_call_input.delta', { type: 'response.custom_tool_call_input.delta', item_id: 'ctc_e2e1', output_index: 0, delta: code }]);
  } else {
    frames.push(['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }]);
    frames.push(['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_e2e1', output_index: 0, content_index: 0, delta: CODEX_DONE }]);
  }
  frames.push(['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }]);
  frames.push(['response.completed', { type: 'response.completed', response: { ...base, status: 'completed', output: [item], usage: responsesUsage(inputTokens) } }]);
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
function anthropicSse(model: string, inputTokens: number): string {
  const frames: Array<[string, Json]> = [
    ['message_start', { type: 'message_start', message: { id: 'msg_e2e_codex_rig', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: CLAUDE_DONE } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
// The model list uses the entry shape Headroom synthesizes for Codex ChatGPT auth (headroom/providers/codex/model_metadata.py,
// codex_model_registry_entry), so a Codex decode failure can only come from the path, not from a sparse fixture.
const REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
];
function modelEntry(slug: string): Json {
  return {
    slug, display_name: 'GPT-E2e', description: 'Codex model available through ChatGPT subscription auth.',
    default_reasoning_level: 'medium', supported_reasoning_levels: REASONING_LEVELS, shell_type: 'shell_command', visibility: 'list',
    supported_in_api: true, priority: 50, additional_speed_tiers: ['fast'],
    service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }], availability_nux: null, upgrade: null,
    context_window: 272000, max_context_window: 272000, effective_context_window_percent: 95, experimental_supported_tools: [],
    input_modalities: ['text', 'image'], supports_search_tool: true, use_responses_lite: false, support_verbosity: true, default_verbosity: 'low',
    apply_patch_tool_type: 'freeform', web_search_tool_type: 'text_and_image', truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_image_detail_original: true, supports_parallel_tool_calls: true, supports_reasoning_summaries: true, default_reasoning_summary: 'none',
  };
}
function modelsPayload(): Json {
  return {
    object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'openai' }], models: [modelEntry(MODEL)],
  };
}
// One mock for both upstreams: the Codex backend under /backend-api/codex and the Anthropic API under /v1.
async function startMock(): Promise<Mock> {
  const seen: Recorded[] = [];
  // The code-mode script the exec tool call carries; a step can swap it and restore the default with setExecCode().
  let execCode = EXEC_CODE;
  const server = createServer(async (req, res) => {
    const raw = await readText(req);
    const path = req.url ?? '/';
    const pathname = new URL(path, 'http://mock.invalid').pathname;
    const body = parseBody(raw);
    seen.push({ method: req.method, path, headers: req.headers, raw, body });
    const jsonHeaders = { 'content-type': 'application/json' };
    if (req.method === 'POST' && pathname === RESPONSES_PATH) {
      const model = typeof body.model === 'string' ? body.model : MODEL;
      const exec = wantsExecCall(body);
      const inputTokens = Math.ceil(Buffer.byteLength(raw) / 4);
      if (body.stream === true) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).end(responsesSse(model, exec, inputTokens, execCode));
      else res.writeHead(200, jsonHeaders).end(JSON.stringify({ id: 'resp_e2e', object: 'response', status: 'completed', model, output: [exec ? execItem(execCode) : textItem()], usage: responsesUsage(inputTokens) }));
      return;
    }
    if (req.method === 'GET' && pathname === MODELS_PATH) {
      res.writeHead(200, jsonHeaders).end(JSON.stringify(modelsPayload()));
      return;
    }
    if (req.method === 'POST' && pathname === COUNT_TOKENS_PATH) {
      sendJson(res, 200, { input_tokens: Math.ceil(Buffer.byteLength(raw) / 4) });
      return;
    }
    if (req.method === 'POST' && pathname === MESSAGES_PATH) {
      const model = typeof body.model === 'string' ? body.model : 'synthetic-claude';
      const inputTokens = Math.ceil(Buffer.byteLength(raw) / 4);
      if (body.stream === true) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).end(anthropicSse(model, inputTokens));
      else sendJson(res, 200, { id: 'msg_e2e_codex_rig', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: CLAUDE_DONE }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 5 } });
      return;
    }
    sendJson(res, 404, { error: { type: 'not_found', message: 'mock serves the Codex backend and the Anthropic messages API only' } });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return { port, seen, close: () => closeServer(server), setExecCode: code => { execCode = code ?? EXEC_CODE; } };
}
// Egress fence: an HTTP proxy that refuses every CONNECT and absolute-URI request with 403 and records only the target host.
async function startFence(): Promise<Fence> {
  const hits: Fence['hits'] = [];
  const server = createServer((req, res) => {
    let host = 'unparsed';
    try { host = new URL(req.url ?? '').hostname.toLowerCase(); } catch { host = String(req.headers.host ?? 'unparsed').split(':')[0] ?? 'unparsed'; }
    hits.push({ kind: 'http', host });
    res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' }).end('refused by the codex-launch e2e egress fence');
  });
  server.on('connect', (req, socket) => {
    hits.push({ kind: 'connect', host: String(req.url ?? '').split(':')[0]?.toLowerCase() ?? 'unparsed' });
    socket.on('error', () => undefined);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}`, hits, close: () => closeServer(server) };
}

// ---- Fixture and inspection helpers ----------------------------------------------------

const isResponsesCall = (record: Recorded): boolean => record.method === 'POST' && new URL(record.path, 'http://mock.invalid').pathname === RESPONSES_PATH;
const isModelsCall = (record: Recorded): boolean => record.method === 'GET' && new URL(record.path, 'http://mock.invalid').pathname === MODELS_PATH;
const isMessagesCall = (record: Recorded): boolean => record.method === 'POST' && new URL(record.path, 'http://mock.invalid').pathname === MESSAGES_PATH;
function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}
// Text of every tool output in the request input, for both code-mode and function tool outputs.
function toolOutputText(body: Json): string {
  return list(body.input)
    .filter(item => item.type === 'custom_tool_call_output' || item.type === 'function_call_output')
    .map(item => outputText(item.output))
    .join('\n');
}
const hasToolOutput = (body: Json): boolean => toolOutputText(body).length > 0;
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;
// Names of every tool object in a value, for counting what an item declares.
function toolNames(value: unknown): string[] {
  return declaredTools(value).map(tool => tool.name);
}
// Recursively collects every string under a "kind" key: observations carry the hook's kebab-case event name there.
function collectKinds(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(item => collectKinds(item, out));
  else if (isJson(value)) {
    if (typeof value.kind === 'string') out.push(value.kind.toLowerCase().replace(/_/g, '-'));
    for (const item of Object.values(value)) collectKinds(item, out);
  }
  return out;
}
// The thread id Codex announces on its first `exec --json` event.
function threadIdOf(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    let event: Json;
    try { event = asJson(line); } catch { continue; }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
  }
  return undefined;
}
async function lineCount(file: string): Promise<number> {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(line => line.trim() !== '').length; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e; }
}
async function routeLineCount(file: string): Promise<number> {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(line => line.includes('"event":"route"')).length; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e; }
}
// memory.log lines that name an MCP request path. The server's startup banner also names /mcp, so it is not counted.
async function mcpRequestLineCount(file: string): Promise<number> {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(line => line.includes('/mcp') && !line.includes('HTTP server ready')).length; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e; }
}
async function routePaths(file: string): Promise<string[]> {
  const paths: string[] = [];
  for (const line of (await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/)) {
    if (!line.includes('"event":"route"')) continue;
    try { const path = asJson(line).path; if (typeof path === 'string') paths.push(path); } catch { /* Not a JSON log line. */ }
  }
  return paths;
}
// Counts of a needle in every file under a tree; the needle is never returned, only counts, sizes and the relative names of files that hit.
async function scanTree(dir: string, needles: string[]): Promise<{ files: number; bytes: number; hits: number[]; hitFiles: string[] }> {
  const hits = needles.map(() => 0), hitFiles: string[] = [];
  let names: string[];
  try { names = await readdir(dir, { recursive: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { files: 0, bytes: 0, hits, hitFiles }; throw e; }
  let files = 0, bytes = 0;
  for (const name of names) {
    const path = join(dir, name);
    if (!(await stat(path)).isFile()) continue;
    const text = await readFile(path, 'utf8');
    files++; bytes += Buffer.byteLength(text);
    let fileHits = 0;
    needles.forEach((needle, i) => { const n = occurrences(text, needle); hits[i] = (hits[i] ?? 0) + n; fileHits += n; });
    if (fileHits > 0) hitFiles.push(name);
  }
  return { files, bytes, hits, hitFiles };
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
// SHA-256 of a file's bytes, or null when it does not exist. Only the digest is ever kept.
async function fileHash(path: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
async function entryNames(dir: string): Promise<string[] | null> {
  try { return (await readdir(dir)).sort(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
// The real user state: the suite's gateway home, Headroom's home, Codex's login file and listing, and Claude's global file.
async function realHomeState(): Promise<HomeState> {
  const home = homedir();
  return {
    jevGateway: await dirListing(join(home, '.jev-gateway')),
    headroom: await dirListing(join(home, '.headroom')),
    codexEntries: await entryNames(join(home, '.codex')),
    codexAuth: await fileListing(join(home, '.codex', 'auth.json')),
    claudeJson: await fileListing(join(home, '.claude.json')),
  };
}
async function realLogSizes(): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const name of LIVE_LOGS) sizes[name] = await stat(join(homedir(), '.jev-gateway', name)).then(info => info.size, () => 0);
  return sizes;
}
// The live gateways and a live Codex or Claude session keep writing their logs and state, so those are checked by attribution
// (no line or reference from this run) instead of by listing. Everything else must be unchanged.
async function realHomeCheck(c: Ctx): Promise<RealHomeCheck> {
  const now = await realHomeState();
  const liveRows = (rows: string[] | null): string => JSON.stringify((rows ?? []).filter(row => !LIVE_LOGS.some(name => row.startsWith(`${name}|`))));
  const isolatedText = (await Promise.all(LIVE_LOGS.map(name => readFile(join(c.base.home, '.jev-gateway', name), 'utf8').catch(() => '')))).join('\n');
  const runIds = new Set<string>();
  for (const line of isolatedText.split(/\r?\n/)) {
    const match = /"gatewayRunId":"([^"]+)"/.exec(line);
    if (match?.[1]) runIds.add(match[1]);
  }
  let addedBytes = 0, linesFromIsolated = 0, tmpHits = 0;
  for (const name of LIVE_LOGS) {
    const real = await readFile(join(homedir(), '.jev-gateway', name)).catch(() => Buffer.alloc(0));
    const offset = Math.min(c.realLogSizes[name] ?? 0, real.length);
    const added = real.subarray(offset).toString('utf8');
    addedBytes += real.length - offset;
    linesFromIsolated += added.split(/\r?\n/).filter(line => {
      const match = /"gatewayRunId":"([^"]+)"/.exec(line);
      return match?.[1] !== undefined && runIds.has(match[1]);
    }).length;
    tmpHits += occurrences(added, c.tmpName);
  }
  const claudeJsonText = await readFile(join(homedir(), '.claude.json'), 'utf8').catch(() => '');
  const before = c.realBefore;
  const codexBefore = new Set(before.codexEntries ?? []), codexNow = new Set(now.codexEntries ?? []);
  return {
    jevGatewayUnchanged: liveRows(now.jevGateway) === liveRows(before.jevGateway),
    headroomUnchanged: JSON.stringify(now.headroom) === JSON.stringify(before.headroom),
    codexAuthUnchanged: now.codexAuth === before.codexAuth,
    codexEntriesAdded: [...codexNow].filter(name => !codexBefore.has(name)).length,
    codexEntriesRemoved: [...codexBefore].filter(name => !codexNow.has(name)).length,
    isolatedRouterRunIds: runIds.size,
    liveLogLinesFromIsolatedRouters: linesFromIsolated,
    liveLogTmpMarkerHits: tmpHits,
    claudeJsonTmpMarkerHits: occurrences(claudeJsonText, c.tmpName),
    liveLogBytesAdded: addedBytes,
    claudeJsonMtimeChanged: now.claudeJson !== before.claudeJson,
  };
}
function parseClientJson(stdout: string): Json | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()) as unknown; } catch { return undefined; }
  if (Array.isArray(parsed)) return list(parsed).find(item => item.type === 'result');
  return isJson(parsed) ? parsed : undefined;
}

// ---- Profiles and runs -----------------------------------------------------------------

type HeadroomTemplate = { enabled: boolean; codex: boolean; python?: string };
function templateConfig(base: Config, ports: number[], headroom: HeadroomTemplate): Config {
  const [control, memory, gateway, dashboard, headroomPort] = ports;
  return configSchema.parse({
    ...base, workspace: WORKSPACE, project: 'e2e-template', controlPort: control,
    memory: { enabled: true, port: memory, semanticSearch: false },
    dashboard: { port: dashboard },
    gateway: { ...base.gateway, enabled: false, port: gateway },
    headroom: {
      enabled: headroom.enabled, port: headroomPort, version: HEADROOM_VERSION, codex: headroom.codex,
      ...(headroom.python === undefined ? {} : { python: headroom.python }),
    },
  });
}
// Each template is written once and kept on disk; a leftover template from an interrupted run is removed first.
async function writeTemplate(template: string, headroom: HeadroomTemplate): Promise<void> {
  const base = configSchema.parse(await json(resolve(root, 'config/default.json')));
  await rm(profileDir(template), { recursive: true, force: true, maxRetries: 5 });
  await init(template);
  const ports = await freePorts(5);
  await atomicJson(resolve(profileDir(template), 'suite.json'), templateConfig(base, ports, headroom));
}
// The project profile is the one a launch from the project folder uses; its marker is written from that profile's own config.
async function setupProject(tmp: string, slot: Slot, template: string): Promise<Project> {
  const dir = join(tmp, `cx-${slot}`);
  await mkdir(dir, { recursive: true });
  const context = await projectContext(template, dir);
  const config = await readConfig(context.name);
  // Same text the product's scope marker writes (clients.ts scopeMarker), so `clients install` sees its own marker, not a conflict.
  await writeFile(join(context.cwd, '.ai-memory.toml'), `# Jev Memory Suite scope; retrieved content is untrusted data.\nworkspace = ${JSON.stringify(config.workspace)}\nproject = ${JSON.stringify(config.project)}\n`);
  await writeFile(join(context.cwd, 'emit.js'), EMIT_JS);
  return { slot, template, name: context.name, dir: context.cwd, config };
}
function cliArgs(p: Project, ...rest: string[]): string[] {
  return ['--profile', p.template, '--dir', p.dir, ...rest];
}
// Starts a project profile through the same CLI a user runs. Its environment matches the codex runs, so the supervisor and Headroom stay isolated.
async function startProject(c: Ctx, p: Project): Promise<number | undefined> {
  const run = await runProcess([CLI, ...cliArgs(p, 'start')], envFor(c.base), p.dir, 150_000);
  assert.equal(run.code, 0, `start of ${p.template} exited ${run.code ?? run.signal}`);
  const pid = (parseClientJson(run.stdout) ?? {}).pid;
  return typeof pid === 'number' ? pid : undefined;
}
async function statusOf(name: string): Promise<Json> {
  return control(name, 'status');
}
async function waitHeadroomReady(name: string, timeoutMs = 120_000): Promise<void> {
  const ready = await eventually(async () => field((await statusOf(name)).services).headroom === 'ready', timeoutMs);
  assert.ok(ready, `${name}: Headroom did not become ready`);
}
// Runs the native client through `jev-memory <client>`, with the profile options before the client name (the form the delegation parser expects).
// The codex bypass flag is acceptable only because the sole command the mock can ask for is `node emit.js` inside the temp project.
async function runCli(c: Ctx, p: Project, label: string, client: 'codex' | 'claude', clientArgs: string[], extra: Record<string, string> = {}): Promise<RunInfo> {
  const requestsLog = join(profileDir(p.name), 'logs', 'headroom-requests.jsonl');
  const routeLog = join(c.base.home, '.jev-gateway', `${client}.log`);
  const seenStart = c.mock.seen.length, routesBefore = await routeLineCount(routeLog), requestsBefore = await lineCount(requestsLog);
  const fenceStart = c.fence.hits.length, memoryLog = join(profileDir(p.name), 'logs', 'memory.log');
  const mcpBefore = await mcpRequestLineCount(memoryLog);
  const result = await runProcess([CLI, ...cliArgs(p, client, ...clientArgs)], envFor(c.base, extra), p.dir, 180_000);
  await writeFile(join(c.e2eDir, `${label}.stdout.txt`), result.stdout);
  await writeFile(join(c.e2eDir, `${label}.stderr.txt`), result.stderr);
  const seen = c.mock.seen.slice(seenStart);
  // Log writers flush asynchronously, so the deltas are read after a bounded wait for them to appear.
  await eventually(async () => (await routeLineCount(routeLog)) > routesBefore, 15_000);
  await eventually(async () => (await lineCount(requestsLog)) > requestsBefore, 15_000);
  await sleep(500);
  const info: RunInfo = {
    result, responses: seen.filter(isResponsesCall), messages: seen.filter(isMessagesCall), seen,
    routeDelta: (await routeLineCount(routeLog)) - routesBefore, requestsDelta: (await lineCount(requestsLog)) - requestsBefore,
    fenceHosts: c.fence.hits.slice(fenceStart).map(hit => hit.host), mcpRequestLines: (await mcpRequestLineCount(memoryLog)) - mcpBefore,
  };
  c.runs[label] = info;
  return info;
}
const runCodex = (c: Ctx, p: Project, label: string, extra: Record<string, string> = {}): Promise<RunInfo> =>
  runCli(c, p, label, 'codex', ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', PROMPT], extra);

// Calls a memory tool over JSON-RPC. Mcp.call allows only read tools, so writes such as a handoff go through rpc.
async function mcpCall(mcp: Mcp, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await mcp.rpc('tools/call', { name, arguments: args }) as { isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined;
  if (!result || result.isError) throw new Error(`${name} returned an error`);
  const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
  try { return JSON.parse(text) as unknown; } catch { return text; }
}
// Polls the memory server until every wanted kind is held for one session. A session with no observations yet makes the call throw: not yet.
async function awaitKinds(p: Project, sessionId: string, wanted: string[]): Promise<{ kinds: string[]; reply: unknown }> {
  const mcp = await Mcp.connect(p.name);
  let found: { kinds: string[]; reply: unknown } = { kinds: [], reply: undefined };
  await eventually(async () => {
    const reply = await mcpCall(mcp, 'memory_read_session_observations', {
      workspace: p.config.workspace, project: p.config.project, session_id: sessionId, order: 'asc', limit: 200, body_max_chars: 200,
    });
    found = { kinds: [...new Set(collectKinds(reply))].sort(), reply };
    return wanted.every(kind => found.kinds.includes(kind));
  }, 30_000);
  return found;
}
// Codex app-server over stdio: one JSON object per line, requests answered by id. Its CODEX_HOME is the isolated one from envFor.
interface AppServer { request: (method: string, params: Json) => Promise<Json>; notify: (method: string) => void; close: () => Promise<void> }
async function startAppServer(base: EnvBase, cwd: string): Promise<AppServer> {
  const executable = await clientCommand('codex');
  const child = spawn(executable.command, [...executable.prefix, 'app-server'], { cwd, env: envFor(base), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', () => undefined);
  child.stderr?.resume();
  const pending = new Map<number, (message: Json) => void>();
  let nextId = 0, buffer = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      let message: Json;
      try { message = asJson(line); } catch { continue; }
      const id = message.id;
      const settle = typeof id === 'number' ? pending.get(id) : undefined;
      if (settle && (message.result !== undefined || message.error !== undefined)) { pending.delete(id as number); settle(message); }
    }
  });
  const write = (payload: Json): void => { child.stdin?.write(`${JSON.stringify(payload)}\n`); };
  return {
    request: (method, params) => new Promise((done, fail) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); fail(new Error(`app-server ${method} timed out`)); }, 30_000);
      pending.set(id, message => {
        clearTimeout(timer);
        if (message.error !== undefined) fail(new Error(`app-server ${method} failed`));
        else done(field(message.result));
      });
      write({ jsonrpc: '2.0', id, method, params });
    }),
    notify: method => write({ jsonrpc: '2.0', method }),
    close: async () => { child.stdin?.end(); await stopChild(child); },
  };
}
// hooks/list returns one entry per requested cwd; this file asks for one cwd.
const hooksOf = (response: Json): Json[] => list(field(list(response.data)[0]).hooks);

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

describe('jev-memory codex launch e2e (Headroom Codex route, isolated)', { skip, concurrency: 1, timeout: 2_400_000 }, () => {
  let c: Ctx | undefined;
  let finished = false;
  // Code word of the handoff the code-mode step creates; the hook step reuses it to check SessionStart injection.
  let handoffCode: string | undefined;
  const liveState = (): Ctx => {
    if (!c) throw new Error('codex launch rig was not started');
    return c;
  };

  async function finish(): Promise<void> {
    if (finished || !c) return;
    finished = true;
    const r = c, errors: unknown[] = [];
    const guard = async (step: () => Promise<unknown>) => { try { await step(); } catch (e) { errors.push(e); } };
    // Profiles stop first, so Headroom and the supervisors are gone before their directories are removed.
    for (const p of Object.values(r.projects)) await guard(() => stop(p.name));
    // Scratch Jev routers: stopped through their own launchers with the same environment, then probed.
    for (const [label, launcher, port] of [['codex', CODEX_LAUNCHER, r.base.jevCodexPort], ['claude', CLAUDE_LAUNCHER, r.base.jevClaudePort]] as const) {
      const stopped = await runProcess([launcher, '--stop'], envFor(r.base), root, 30_000).catch(() => undefined);
      evidence[`${label}RouterStop`] = { exitCode: stopped?.code ?? null, stoppedMessage: stopped?.stdout.includes('stopped router') ?? false };
      const refused = await eventually(() => refuses(port), 10_000);
      if (!refused) {
        const pids = await listenerPids(port);
        for (const pid of pids) process.kill(pid);
        evidence[`${label}RouterLastResortKills`] = pids.length;
      }
    }
    // Last-resort cleanup for leftovers from a failed run: only processes listening on this run's own Headroom ports.
    const leftovers: Record<string, number> = {};
    for (const p of Object.values(r.projects)) {
      const pids = await listenerPids(p.config.headroom.port);
      leftovers[`${p.slot}.headroom`] = pids.length;
      for (const pid of pids) process.kill(pid);
    }
    evidence.headroomLastResortKills = leftovers;
    // The isolated routers' logs are read here, before their temp home is removed, to attribute the real logs' new lines.
    await guard(async () => {
      const check = await realHomeCheck(r);
      evidence.realHome = check;
      evidence.realHomeUnchanged = check.jevGatewayUnchanged && check.headroomUnchanged && check.codexAuthUnchanged
        && check.liveLogTmpMarkerHits === 0 && check.claudeJsonTmpMarkerHits === 0 && check.liveLogLinesFromIsolatedRouters === 0;
    });
    await guard(() => stopChild(r.mockJev));
    await guard(() => r.mockJevLog.close());
    await guard(() => r.mock.close());
    await guard(() => r.fence.close());
    // Every scratch listener is probed after its owner closed; a refusal means nothing is left listening.
    const scratchPorts = { mock: r.mock.port, fence: r.fence.port, mockJev: r.base.mockJevPort, jevCodex: r.base.jevCodexPort, jevClaude: r.base.jevClaudePort };
    evidence.portsRefused = Object.fromEntries(await Promise.all(Object.entries(scratchPorts).map(async ([name, port]) => [name, await eventually(() => refuses(port), 10_000)] as const)));
    const profileNames = [...Object.values(r.projects).map(p => p.name), ...Object.values(TEMPLATES)];
    for (const name of profileNames) await guard(() => rm(profileDir(name), { recursive: true, force: true, maxRetries: 5 }));
    await guard(() => rm(r.tmp, { recursive: true, force: true, maxRetries: 5 }));
    await guard(() => rm(r.e2eDir, { recursive: true, force: true, maxRetries: 5 }));
    evidence.passedTests = results.filter(item => item.status === 'pass').map(item => item.name);
    evidence.tests = results;
    await prepare(EVIDENCE_DIR);
    const text = JSON.stringify(evidence, null, 2);
    for (const secret of FORBIDDEN) assert.equal(text.includes(secret), false, 'evidence must not contain tokens, the account id or the canary');
    await atomicJson(resolve(EVIDENCE_DIR, EVIDENCE_FILE), evidence);
    if (errors.length > 0) throw new AggregateError(errors, 'codex launch cleanup failed');
  }

  before(async () => {
    const realBefore = await realHomeState();
    const realSizes = await realLogSizes();
    await prepare(E2E_BASE);
    const e2eDir = await mkdtemp(resolve(E2E_BASE, 'codex-launch-'));
    // The isolated home, Codex home and external project folders live under the OS temp dir, outside the repository.
    const tmp = await mkdtemp(join(tmpdir(), 'jev-codex-launch-'));
    const home = join(tmp, 'home'), codexHome = join(tmp, 'codex-home');
    await mkdir(home, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    // Fake ChatGPT login in the mirrored key layout (auth_mode, OPENAI_API_KEY null, tokens{...}, last_refresh).
    // last_refresh is now, so Codex has no reason to refresh and never reaches auth.openai.com.
    await writeFile(join(codexHome, 'auth.json'), `${JSON.stringify({
      auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { id_token: ID_TOKEN, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, account_id: ACCOUNT_ID },
      last_refresh: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    const mock = await startMock();
    const fence = await startFence();
    const mockJevPort = await freeTcpPort(), jevCodexPort = await freeTcpPort(), jevClaudePort = await freeTcpPort();
    const base: EnvBase = { home, codexHome, fenceUrl: fence.url, mockPort: mock.port, mockJevPort, jevCodexPort, jevClaudePort };
    const mockJevDump = join(e2eDir, 'mock-jev-dump'), mockJevLogPath = join(e2eDir, 'mock-jev.log');
    const mockJevLog = await open(mockJevLogPath, 'a');
    const mockJev = spawn(process.execPath, [resolve(root, 'upstream/jev-gateway/scripts/mock-jev.mjs')], {
      cwd: root, shell: false, windowsHide: true, stdio: ['ignore', mockJevLog.fd, mockJevLog.fd],
      env: envFor(base, { MOCK_JEV_PORT: String(mockJevPort), MOCK_JEV_SCRIPT: 'no_tool_needed', MOCK_JEV_DUMP_DIR: mockJevDump }),
    });
    mockJev.on('error', () => undefined);
    const ready = await eventually(async () => (await readFile(mockJevLogPath, 'utf8')).includes('mock-jev on'), 20_000);
    assert.ok(ready, 'mock-jev did not start');
    c = { base, tmp, e2eDir, mock, fence, mockJev, mockJevLog, mockJevDump, projects: {} as Record<Slot, Project>, runs: {},
      realBefore, realLogSizes: realSizes, tmpName: basename(tmp), supervisorPids: {} };
    try {
      await writeTemplate(TEMPLATES.on, { enabled: true, codex: true });
      await writeTemplate(TEMPLATES.noshim, { enabled: true, codex: true, python: 'C:/nonexistent/python.exe' });
      await writeTemplate(TEMPLATES.off, { enabled: true, codex: false });
      const projects: Partial<Record<Slot, Project>> = {};
      for (const slot of ['on', 'noshim', 'off'] as const) projects[slot] = await setupProject(tmp, slot, TEMPLATES[slot]);
      c.projects = projects as Record<Slot, Project>;
    } catch (error) {
      await finish().catch(() => undefined);
      throw error;
    }
  }, { timeout: 300_000 });

  after(async () => {
    await finish();
  }, { timeout: 420_000 });

  step('Codex goes Codex -> Headroom -> Jev -> ChatGPT backend', 900_000, async t => {
    const r = liveState();
    const p = r.projects.on;
    const pid = await startProject(r, p);
    if (pid !== undefined) r.supervisorPids.on = pid;
    await waitHeadroomReady(p.name);
    const info = await runCodex(r, p, 'run1');
    const { result } = info;
    assert.equal(result.timedOut, false, 'run 1 timed out');
    assert.equal(result.code, 0, `run 1 exit code ${result.code ?? result.signal}\n${result.stderr.slice(-2000)}`);
    assert.ok(result.stdout.includes(CODEX_DONE), `stdout does not contain ${CODEX_DONE}`);
    assert.equal(result.stderr.includes('Headroom not used'), false, 'Headroom must be used in run 1');
    const status = await statusOf(p.name);
    const services = field(status.services), headroom = field(status.headroom);
    assert.equal(services.headroom, 'ready', 'Headroom service must be ready');
    assert.equal(headroom.codex, true, 'status must report headroom.codex === true');
    assert.equal(headroom.codexUpstreamPort, r.base.jevCodexPort, 'codexUpstreamPort must be the scratch Jev codex port');
    assert.ok(info.requestsDelta >= 1, `headroom-requests.jsonl grew by ${info.requestsDelta}, expected >= 1`);
    assert.ok(info.responses.length >= 2, `mock saw ${info.responses.length} POST ${RESPONSES_PATH}, expected >= 2 (tool call and tool output)`);
    assert.ok(info.routeDelta >= 1, `codex.log gained ${info.routeDelta} route lines`);
    const routed = await routePaths(join(r.base.home, '.jev-gateway', 'codex.log'));
    assert.ok(routed.includes('/v1/responses'), 'codex.log has no route line with path "/v1/responses"');
    for (const record of info.responses) {
      assert.equal(headerOf(record, 'authorization'), CLIENT_BEARER, `${record.path} carried a different authorization header`);
      assert.equal(headerOf(record, 'chatgpt-account-id'), ACCOUNT_ID, `${record.path} carried a different chatgpt-account-id`);
    }
    for (const record of info.seen.filter(isModelsCall)) {
      assert.equal(headerOf(record, 'authorization'), CLIENT_BEARER, 'model discovery carried a different authorization header');
    }
    // Tool result: every request_id and every ERROR line must survive; the forwarded output must be smaller than the raw output.
    const toolTurn = info.responses.find(record => hasToolOutput(record.body));
    assert.ok(toolTurn, 'no forwarded request carries the tool output');
    const forwardedText = toolOutputText(toolTurn.body);
    const emitted = (await execFileAsync(process.execPath, ['emit.js'], { cwd: p.dir, encoding: 'utf8' })).stdout;
    assert.equal(occurrences(forwardedText, 'req-1'), LOG_COUNT, 'every request_id must survive compression');
    assert.equal(occurrences(forwardedText, 'ERROR'), 3, 'every ERROR line must survive compression');
    assert.ok(forwardedText.length < emitted.length, `tool output was not compressed (${forwardedText.length} >= ${emitted.length})`);
    for (const record of info.responses) {
      assert.equal(record.raw.includes('headroom_retrieve'), false, 'headroom_retrieve must not be offered');
      assert.equal(record.raw.includes('<<ccr'), false, 'forwarded body must not carry <<ccr markers');
    }
    evidence.run1 = {
      exitCode: result.code, durationMs: result.durationMs, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
      mockPostResponses: info.responses.length, mockRequests: info.seen.length, routeLines: info.routeDelta, headroomRequestLines: info.requestsDelta,
      toolOutputBytes: forwardedText.length, emitBytes: emitted.length,
      requestIdOccurrences: occurrences(forwardedText, 'req-1'), errorOccurrences: occurrences(forwardedText, 'ERROR'),
      modelsRequests: info.seen.filter(isModelsCall).length, headroomCodex: true, codexUpstreamPortMatches: true,
    };
    t.diagnostic(`run1 ${result.durationMs} ms, ${info.responses.length} POST responses, tool output ${forwardedText.length} vs emit ${emitted.length} bytes`);
  });

  // The no-Headroom run is the parity baseline: the original jev-codex path (JMS_HEADROOM=off), same profile and same prompt.
  // It is memoized, so whichever comparison needs it first runs it once.
  async function baselineRun(r: Ctx): Promise<RunInfo> {
    const existing = r.runs.baseline;
    if (existing) return existing;
    const info = await runCodex(r, r.projects.on, 'baseline', { JMS_HEADROOM: 'off' });
    assert.equal(info.result.code, 0, `baseline run exit code ${info.result.code ?? info.result.signal}`);
    assert.ok(info.result.stderr.includes('Headroom not used: Headroom bypassed by JMS_HEADROOM=off; launching through jev-codex.'),
      'the baseline must be the original jev-codex path');
    return info;
  }

  step('AI Memory MCP parity: Headroom keeps the no-Headroom tool roster', 300_000, async t => {
    const r = liveState();
    const withHeadroom = r.runs.run1;
    assert.ok(withHeadroom, 'run 1 must complete first');
    const without = await baselineRun(r);
    const first = withHeadroom.responses[0], baseFirst = without.responses[0];
    assert.ok(first && baseFirst, 'both runs must reach the mock with a Responses request');
    // Names of every declared tool in the first forwarded request of each path (MCP tools would be declared the same way).
    const rosterOf = (record: Recorded): string[] => [...new Set(toolNames(record.body))].sort();
    const memoryNames = (roster: string[]): string[] => roster.filter(name => /memory/i.test(name));
    const rosterHeadroom = rosterOf(first), rosterBaseline = rosterOf(baseFirst);
    // Headroom may compact tool schemas, but it must not add, drop or rename a tool.
    assert.deepEqual(rosterHeadroom, rosterBaseline, 'Headroom changed the forwarded tool roster');
    const rawMentions = (record: Recorded): number => occurrences(record.raw, 'jev_memory_suite') + occurrences(record.raw, 'memory_');
    const memoryFound = memoryNames(rosterHeadroom).length + memoryNames(rosterBaseline).length > 0;
    // In Codex code mode MCP tools are not top-level Responses tools. The exec runtime lists them in ALL_TOOLS and exec code calls them,
    // so neither path declares memory tools at top level. This step asserts roster parity; the next step asserts MCP reachability.
    evidence.aiMemory = {
      rosterSizeHeadroom: rosterHeadroom.length, rosterSizeBaseline: rosterBaseline.length, rosterParity: true,
      memoryToolNamesHeadroom: memoryNames(rosterHeadroom).length, memoryToolNamesBaseline: memoryNames(rosterBaseline).length,
      rawMemoryMentionsHeadroom: rawMentions(first), rawMemoryMentionsBaseline: rawMentions(baseFirst),
      memoryMcpRequestLinesHeadroom: withHeadroom.mcpRequestLines, memoryMcpRequestLinesBaseline: without.mcpRequestLines,
      memoryToolsDeclaredTopLevel: memoryFound,
    };
    t.diagnostic(`tool roster ${rosterHeadroom.length} with Headroom, ${rosterBaseline.length} baseline; memory tools declared top-level: ${memoryFound}`);
  });

  step('AI Memory MCP through code mode: memory tools reachable from exec with and without Headroom', 300_000, async t => {
    const r = liveState();
    const p = r.projects.on;
    const { workspace, project } = p.config;
    const code = `HANDOFF-E2E-${randomUUID().slice(0, 8)}`;
    handoffCode = code;
    const mcp = await Mcp.connect(p.name);
    await mcpCall(mcp, 'memory_handoff_begin', {
      summary: `E2E handoff. Code word: ${code}.`, open_questions: [], next_steps: ['state the code word'], files_touched: [],
      shared: true, workspace, project,
    });
    // Exec code: list the MCP tools the runtime exposes, then call the memory handoff list from inside exec.
    const execCode = [
      'const names = ALL_TOOLS.filter(t => t.name.startsWith("mcp__jev_memory_suite__")).map(t => t.name);',
      `const r = await tools.mcp__jev_memory_suite__memory_handoff_list({ workspace: ${JSON.stringify(workspace)}, project: ${JSON.stringify(project)} });`,
      'text(JSON.stringify({ names, r }));',
    ].join('\n');
    let headroomRun: RunInfo, baselineRun: RunInfo;
    r.mock.setExecCode(execCode);
    try {
      headroomRun = await runCodex(r, p, 'mcp-on');
      baselineRun = await runCodex(r, p, 'mcp-off', { JMS_HEADROOM: 'off' });
    } finally {
      r.mock.setExecCode();
    }
    // Each run must finish, answer, and forward the exec output; the output must name the memory tool and carry the code word.
    const forwardedOutput = (info: RunInfo, label: string): string => {
      assert.equal(info.result.timedOut, false, `${label} timed out`);
      assert.equal(info.result.code, 0, `${label} exit code ${info.result.code ?? info.result.signal}\n${info.result.stderr.slice(-2000)}`);
      assert.ok(info.result.stdout.includes(CODEX_DONE), `${label} stdout does not contain ${CODEX_DONE}`);
      const toolTurn = info.responses.find(record => hasToolOutput(record.body));
      assert.ok(toolTurn, `${label}: no forwarded request carries the tool output`);
      return toolOutputText(toolTurn.body);
    };
    const headroomText = forwardedOutput(headroomRun, 'mcp-on'), baselineText = forwardedOutput(baselineRun, 'mcp-off');
    const memoryToolMarker = 'mcp__jev_memory_suite__memory_handoff_list';
    const toolsListed = (text: string): number => occurrences(text, 'mcp__jev_memory_suite__');
    assert.ok(headroomText.includes(memoryToolMarker), 'Headroom run: exec did not list the memory handoff tool');
    assert.ok(baselineText.includes(memoryToolMarker), 'baseline run: exec did not list the memory handoff tool');
    assert.ok(headroomText.includes(code), 'Headroom run: the handoff read from exec lacks the code word');
    assert.ok(baselineText.includes(code), 'baseline run: the handoff read from exec lacks the code word');
    const codeMode = {
      memoryToolsListedHeadroom: toolsListed(headroomText), memoryToolsListedBaseline: toolsListed(baselineText),
      handoffReadHeadroom: headroomText.includes(code), handoffReadBaseline: baselineText.includes(code),
    };
    evidence.aiMemoryCodeMode = codeMode;
    assert.equal(codeMode.memoryToolsListedHeadroom, codeMode.memoryToolsListedBaseline, 'Headroom dropped memory tool names from the tool output');
    t.diagnostic(`code mode: memory tools listed ${toolsListed(headroomText)} with Headroom, ${toolsListed(baselineText)} baseline; handoff read on both paths`);
  });

  step('no model traffic bypasses Jev: the Headroom run reaches no host the no-Headroom baseline does not', 300_000, async t => {
    const r = liveState();
    const withHeadroom = r.runs.run1;
    assert.ok(withHeadroom, 'run 1 must complete first');
    const without = await baselineRun(r);
    const countHosts = (hosts: string[]): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const host of hosts) counts[host] = (counts[host] ?? 0) + 1;
      return counts;
    };
    const hostsHeadroom = countHosts(withHeadroom.fenceHosts), hostsBaseline = countHosts(without.fenceHosts);
    // Codex's own ChatGPT services (ps/mcp connectors, ab analytics) are attempted with or without Headroom. The requirement is
    // that model traffic stays on Jev, so the Headroom run must not reach any host the baseline did not.
    const extra = Object.keys(hostsHeadroom).filter(host => hostsBaseline[host] === undefined).sort();
    // Model traffic: every forwarded Responses call went through Headroom and Jev (a route line each) to the mock.
    const routed = withHeadroom.routeDelta >= withHeadroom.responses.length && withHeadroom.responses.length > 0;
    const headroomLogs = await Promise.all(Object.values(r.projects).map(p => readFile(join(profileDir(p.name), 'logs', 'headroom.log'), 'utf8').catch(() => '')));
    const blocked = headroomLogs.reduce((sum, text) => sum + occurrences(text, 'jms-egress-blocked host=chatgpt.com'), 0);
    evidence.egress = {
      headroomRunHosts: hostsHeadroom, baselineRunHosts: hostsBaseline, headroomRunAttempts: withHeadroom.fenceHosts.length,
      baselineRunAttempts: without.fenceHosts.length, hostsOnlyWithHeadroom: extra, modelTrafficRoutedThroughJev: routed,
      headroomChatgptBlockLines: blocked,
    };
    t.diagnostic(`fence hosts with Headroom ${JSON.stringify(hostsHeadroom)}; baseline ${JSON.stringify(hostsBaseline)}`);
    const violations: string[] = [];
    if (!routed) violations.push('model traffic did not show a route line per Responses call through Jev');
    if (extra.length > 0) violations.push(`hosts reached only with Headroom: ${extra.join(', ')}`);
    if (blocked > 0) violations.push(`Headroom logged ${blocked} egress block(s) for chatgpt.com`);
    assert.deepEqual(violations, [], violations.join('; '));
  });

  step('models list decodes in Codex with and without Headroom', 300_000, async t => {
    const r = liveState();
    const withHeadroom = r.runs.run1;
    assert.ok(withHeadroom, 'run 1 must complete first');
    const without = await baselineRun(r);
    const decodeWarnings = (stderr: string): number => occurrences(stderr, 'failed to decode models response');
    const hr = decodeWarnings(withHeadroom.result.stderr), base = decodeWarnings(without.result.stderr);
    evidence.modelsDecode = {
      decodeWarningsHeadroom: hr, decodeWarningsBaseline: base,
      modelsGetHeadroom: withHeadroom.seen.filter(isModelsCall).length, modelsGetBaseline: without.seen.filter(isModelsCall).length,
    };
    t.diagnostic(`decode warnings: ${hr} with Headroom, ${base} baseline`);
    // A warning that appears only on the Headroom path would be a Headroom defect; both-or-neither is the same as the original path.
    assert.ok(!(hr > 0 && base === 0), `Codex fails to decode the models list only with Headroom (${hr} vs ${base}): a Headroom defect`);
  });

  step('per-launch opt-out: JMS_HEADROOM=off bypasses Headroom', 300_000, async t => {
    const r = liveState();
    const p = r.projects.on;
    const requestsLog = join(profileDir(p.name), 'logs', 'headroom-requests.jsonl');
    const headroomBefore = await lineCount(requestsLog);
    const info = await runCodex(r, p, 'run4', { JMS_HEADROOM: 'off' });
    assert.equal(info.result.code, 0, `run 4 exit code ${info.result.code ?? info.result.signal}`);
    assert.ok(info.result.stderr.includes('Headroom not used: Headroom bypassed by JMS_HEADROOM=off; launching through jev-codex.'), 'stderr lacks the opt-out reason');
    await sleep(1000);
    assert.equal(await lineCount(requestsLog), headroomBefore, 'Headroom log grew during the opt-out run');
    assert.ok(info.result.stdout.includes(CODEX_DONE), 'the opt-out run must still answer through Jev');
    assert.ok(info.responses.length >= 1, 'mock ChatGPT backend must serve the opt-out run');
    assert.ok(info.routeDelta >= 1, 'the opt-out run must route through Jev');
    evidence.optOut = { exitCode: info.result.code, durationMs: info.result.durationMs, mockPostResponses: info.responses.length, routeLines: info.routeDelta, headroomLinesAdded: 0 };
    t.diagnostic(`opt-out run ${info.result.durationMs} ms`);
  });

  step('Codex prerequisites fail: Claude-only Headroom, Codex falls back through Jev', 420_000, async t => {
    const r = liveState();
    const p = r.projects.noshim;
    const pid = await startProject(r, p);
    if (pid !== undefined) r.supervisorPids.noshim = pid;
    await waitHeadroomReady(p.name);
    const status = await statusOf(p.name);
    const headroom = field(status.headroom);
    assert.equal(headroom.codex, false, 'status must report headroom.codex === false');
    assert.equal(typeof status.headroomCodexReason, 'string', 'status must carry headroomCodexReason');
    const info = await runCodex(r, p, 'run5');
    assert.equal(info.result.code, 0, `run 5 exit code ${info.result.code ?? info.result.signal}`);
    assert.ok(info.result.stderr.includes('Headroom not used: Headroom Codex routing is not active'), 'stderr lacks the Codex routing reason');
    assert.ok(info.result.stdout.includes(CODEX_DONE), 'the fallback run must still answer');
    assert.ok(info.routeDelta >= 1 && info.responses.length >= 1, 'the fallback run must be served through Jev');
    evidence.codexFallback = { exitCode: info.result.code, durationMs: info.result.durationMs, reasonSet: true, routeLines: info.routeDelta, mockPostResponses: info.responses.length };
    t.diagnostic(`fallback run ${info.result.durationMs} ms`);
  });

  step('codex disabled keeps the original path', 420_000, async t => {
    const r = liveState();
    const p = r.projects.off;
    const pid = await startProject(r, p);
    if (pid !== undefined) r.supervisorPids.off = pid;
    await waitHeadroomReady(p.name);
    const status = await statusOf(p.name);
    const headroom = field(status.headroom);
    assert.equal(headroom.codex, false, 'a codex-disabled profile must report headroom.codex === false');
    const info = await runCodex(r, p, 'run6');
    assert.equal(info.result.code, 0, `run 6 exit code ${info.result.code ?? info.result.signal}`);
    assert.equal(info.result.stderr.includes('Headroom'), false, 'a codex-disabled profile must not mention Headroom');
    assert.ok(info.result.stdout.includes(CODEX_DONE), 'the disabled run must still answer');
    assert.ok(info.routeDelta >= 1 && info.responses.length >= 1, 'the disabled run must be served through Jev');
    evidence.codexDisabled = { exitCode: info.result.code, durationMs: info.result.durationMs, routeLines: info.routeDelta, headroomClaudeOnlyReady: true };
    t.diagnostic(`disabled run ${info.result.durationMs} ms`);
  });

  step('Claude still works in a Codex-mode profile', 420_000, async t => {
    const r = liveState();
    const p = r.projects.on;
    const routeLog = join(r.base.home, '.jev-gateway', 'claude.log');
    const routesBefore = await routeLineCount(routeLog);
    const seenStart = r.mock.seen.length;
    const result = await runProcess([CLI, ...cliArgs(p, 'claude', '-p', 'say hi', '--output-format', 'json')],
      envFor(r.base, { ANTHROPIC_API_KEY: ANTHROPIC_KEY }), p.dir, 180_000);
    await writeFile(join(r.e2eDir, 'run7.stdout.txt'), result.stdout);
    await writeFile(join(r.e2eDir, 'run7.stderr.txt'), result.stderr);
    assert.equal(result.timedOut, false, 'claude run timed out');
    assert.equal(result.code, 0, `claude run exit code ${result.code ?? result.signal}\n${result.stderr.slice(-2000)}`);
    let topLevel: string;
    try { topLevel = Array.isArray(JSON.parse(result.stdout.trim())) ? 'array' : 'object'; } catch { topLevel = 'not-json'; }
    assert.equal(topLevel === 'not-json', false, 'stdout must parse as a single JSON document');
    assert.equal(parseClientJson(result.stdout)?.result, CLAUDE_DONE, 'the Claude run must answer');
    assert.equal(result.stderr.includes('Headroom not used'), false, 'Headroom must be used by Claude in a Codex-mode profile');
    await eventually(async () => (await routeLineCount(routeLog)) > routesBefore, 15_000);
    const messages = r.mock.seen.slice(seenStart).filter(isMessagesCall);
    assert.ok(messages.length >= 1, 'mock saw no POST /v1/messages');
    for (const record of messages) assert.equal(headerOf(record, 'x-api-key'), ANTHROPIC_KEY, 'the Claude upstream request carried a different x-api-key');
    const routeDelta = (await routeLineCount(routeLog)) - routesBefore;
    assert.ok(routeDelta >= 1, `claude.log gained ${routeDelta} route lines; the Claude run must go through the Jev claude router`);
    evidence.claudeInCodexProfile = { exitCode: result.code, durationMs: result.durationMs, topLevel, mockPostMessages: messages.length, routeLines: routeDelta };
    t.diagnostic(`claude run ${result.durationMs} ms, ${messages.length} POST /v1/messages`);
  });

  step('recovery: a killed Headroom returns in Codex mode and Codex uses it again', 480_000, async t => {
    const r = liveState();
    const p = r.projects.on;
    const port = p.config.headroom.port;
    const pids = await listenerPids(port);
    assert.ok(pids.length >= 1, `no process listens on the Headroom port ${port}`);
    for (const pid of pids) process.kill(pid);
    const recovered = await eventually(async () => {
      const status = await statusOf(p.name);
      const services = field(status.services), restarts = field(status.restarts), headroom = field(status.headroom);
      return services.headroom === 'ready' && Number(restarts.headroom ?? 0) >= 1 && headroom.codex === true;
    }, 120_000);
    assert.ok(recovered, 'Headroom did not return to ready in Codex mode with a restart recorded');
    const status = await statusOf(p.name);
    const restarts = field(status.restarts);
    const info = await runCodex(r, p, 'run8');
    assert.equal(info.result.code, 0, `run 8 exit code ${info.result.code ?? info.result.signal}`);
    assert.equal(info.result.stderr.includes('Headroom not used'), false, 'run 8 must use Headroom after recovery');
    assert.ok(info.result.stdout.includes(CODEX_DONE), 'the recovered run must answer');
    assert.ok(info.requestsDelta >= 1, 'the recovered run must add lines to the Headroom log');
    evidence.recovery = { killedListeners: pids.length, restarts: Number(restarts.headroom ?? 0), codexMode: true, durationMs: info.result.durationMs, headroomRequestLines: info.requestsDelta };
    t.diagnostic(`recovery restarts=${String(restarts.headroom)} run ${info.result.durationMs} ms`);
  });

  step('AI Memory hook capture with native Codex trust (no bypass flag)', 480_000, async t => {
    const r = liveState();
    const p = r.projects.on;
    const realConfig = join(homedir(), '.codex', 'config.toml');
    const realConfigBefore = await fileHash(realConfig);
    // Hooks are registered through the same CLI a user runs, into this project only.
    const install = await runProcess([CLI, ...cliArgs(p, 'clients', 'install', 'codex', '.')], envFor(r.base), p.dir, 120_000);
    assert.equal(install.code, 0, `clients install codex exited ${install.code ?? install.signal}\n${install.stderr.slice(-2000)}`);
    assert.ok(await stat(join(p.dir, '.codex', 'hooks.json')).then(() => true, () => false), 'clients install must write .codex/hooks.json');
    const check = await runProcess([CLI, ...cliArgs(p, 'clients', 'check', 'codex', '.')], envFor(r.base), p.dir, 120_000);
    assert.equal(check.code, 0, `clients check codex exited ${check.code ?? check.signal}\n${check.stderr.slice(-2000)}`);
    const checked = parseClientJson(check.stdout);
    assert.equal(checked?.registered, true, 'clients check must report the codex registration');
    assert.equal(typeof checked?.hookHash, 'string', 'clients check must report a hook hash for the registration');
    // Native trust, as Codex itself records it: the project is trusted, then each project hook is trusted at its current hash.
    const expectedHooks = Object.keys(hookEntries(p.name, 'codex')).length;
    const inProject = (path: unknown): boolean => resolve(String(path)).toLowerCase().startsWith(resolve(p.dir).toLowerCase());
    const app = await startAppServer(r.base, p.dir);
    let hooksListed = 0, untrustedBefore = 0, trustedAfter = 0;
    try {
      await app.request('initialize', { clientInfo: { name: 'jms-e2e', version: '0.0.0' } });
      app.notify('initialized');
      await app.request('config/batchWrite', { edits: [{ keyPath: 'projects', mergeStrategy: 'upsert', value: { [p.dir.toLowerCase()]: { trust_level: 'trusted' } } }], reloadUserConfig: true });
      const before = hooksOf(await app.request('hooks/list', { cwds: [p.dir] }));
      hooksListed = before.length;
      assert.equal(hooksListed, expectedHooks, `hooks listed for the project (${hooksListed}) must match the registered events (${expectedHooks})`);
      for (const hook of before) {
        assert.equal(hook.source, 'project', 'a listed hook must come from the project');
        assert.ok(inProject(hook.sourcePath), 'a listed hook must come from this project folder');
      }
      untrustedBefore = before.filter(hook => hook.trustStatus === 'untrusted').length;
      assert.equal(untrustedBefore, hooksListed, 'every project hook must start untrusted');
      await app.request('config/batchWrite', { edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value: Object.fromEntries(before.map(hook => [String(hook.key), { trusted_hash: hook.currentHash }])) }], reloadUserConfig: true });
      const after = hooksOf(await app.request('hooks/list', { cwds: [p.dir] }));
      trustedAfter = after.filter(hook => hook.trustStatus === 'trusted').length;
      assert.equal(trustedAfter, hooksListed, `every project hook must be trusted after the native review (${trustedAfter}/${hooksListed})`);
    } finally {
      await app.close();
    }
    // The run uses the approval/sandbox flag only; the hook-trust bypass must never be passed.
    const hookArgs = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', PROMPT];
    const HOOK_KINDS = ['user-prompt', 'pre-tool-use', 'post-tool-use', 'stop'];
    const missingKinds = (kinds: string[]): string[] => HOOK_KINDS.filter(kind => !kinds.includes(kind));
    const hookLogCounts = async (): Promise<Record<string, number>> => ({
      errors: await lineCount(join(profileDir(p.name), 'logs', 'hook-errors.log')),
      skips: await lineCount(join(profileDir(p.name), 'logs', 'hook-skips.log')),
    });
    const on = await runCli(r, p, 'hooks-on', 'codex', hookArgs);
    assert.equal(on.result.code, 0, `hooks-on exit code ${on.result.code ?? on.result.signal}\n${on.result.stderr.slice(-2000)}`);
    assert.ok(on.result.stdout.includes(CODEX_DONE), `hooks-on stdout does not contain ${CODEX_DONE}`);
    const onThread = threadIdOf(on.result.stdout);
    assert.ok(onThread, 'exec --json must announce its thread id');
    const onCapture = await awaitKinds(p, onThread, HOOK_KINDS);
    await writeFile(join(r.e2eDir, 'hooks-on.observations.json'), `${JSON.stringify(onCapture.reply ?? null, null, 2)}\n`);
    if (missingKinds(onCapture.kinds).length > 0) {
      t.diagnostic(`hooks-on kinds ${JSON.stringify(onCapture.kinds)}; hook log lines ${JSON.stringify(await hookLogCounts())}`);
    }
    assert.deepEqual(missingKinds(onCapture.kinds), [], `hooks-on: observations lack ${missingKinds(onCapture.kinds).join(', ')}`);
    const off = await runCli(r, p, 'hooks-off', 'codex', hookArgs, { JMS_HEADROOM: 'off' });
    assert.equal(off.result.code, 0, `hooks-off exit code ${off.result.code ?? off.result.signal}\n${off.result.stderr.slice(-2000)}`);
    assert.ok(off.result.stdout.includes(CODEX_DONE), `hooks-off stdout does not contain ${CODEX_DONE}`);
    const offThread = threadIdOf(off.result.stdout);
    assert.ok(offThread, 'the baseline exec --json must announce its thread id');
    const offCapture = await awaitKinds(p, offThread, HOOK_KINDS);
    if (missingKinds(offCapture.kinds).length > 0) {
      t.diagnostic(`hooks-off kinds ${JSON.stringify(offCapture.kinds)}; hook log lines ${JSON.stringify(await hookLogCounts())}`);
    }
    assert.deepEqual(missingKinds(offCapture.kinds), [], `hooks-off: observations lack ${missingKinds(offCapture.kinds).join(', ')}`);
    assert.deepEqual(onCapture.kinds, offCapture.kinds, 'hook kinds captured with Headroom differ from the no-Headroom baseline');
    // Evidence only: the SessionStart handoff injection is recorded, not asserted.
    const handoffInjected = handoffCode !== undefined && (on.responses[0]?.raw.includes(handoffCode) ?? false);
    const handoffInjectedBaseline = handoffCode !== undefined && (off.responses[0]?.raw.includes(handoffCode) ?? false);
    const realConfigAfter = await fileHash(realConfig);
    assert.equal(realConfigAfter, realConfigBefore, 'the real ~/.codex/config.toml changed during the hook capture');
    evidence.hookCapture = {
      hooksListed, untrustedBefore, trustedAfter, kindsHeadroom: onCapture.kinds, kindsBaseline: offCapture.kinds,
      handoffInjectedHeadroom: handoffInjected, handoffInjectedBaseline, realCodexConfigUnchanged: realConfigAfter === realConfigBefore,
      bypassFlagUsed: hookArgs.some(arg => arg.includes('hook-trust')),
    };
    t.diagnostic(`hook capture: ${hooksListed} hooks, kinds ${onCapture.kinds.join(', ')}; handoff injected with Headroom: ${handoffInjected}`);
  });

  step('cleanup and secrets: profiles, Headroom and Jev routers stop; no secret in logs; real homes unchanged', 420_000, async t => {
    const r = liveState();
    for (const p of Object.values(r.projects)) await stop(p.name);
    const ports = Object.values(r.projects).map(p => p.config.headroom.port);
    const refused = await Promise.all(ports.map(port => eventually(() => refuses(port), 15_000)));
    assert.deepEqual(refused, ports.map(() => true), 'a Headroom port still accepts connections after stop');
    for (const [slot, pid] of Object.entries(r.supervisorPids)) assert.equal(pidAlive(pid), false, `supervisor ${pid} for ${slot} is still running`);
    for (const [label, launcher] of [['codex', CODEX_LAUNCHER], ['claude', CLAUDE_LAUNCHER]] as const) {
      const stopRun = await runProcess([launcher, '--stop'], envFor(r.base), root, 30_000);
      assert.equal(stopRun.code, 0, `the scratch Jev ${label} router must stop through its launcher`);
    }
    assert.ok(await eventually(() => refuses(r.base.jevCodexPort), 15_000), 'the scratch Jev codex router still accepts connections');
    assert.ok(await eventually(() => refuses(r.base.jevClaudePort), 15_000), 'the scratch Jev claude router still accepts connections');
    // Security scan: no fake login, account id, Claude key or canary may be written to a project's logs, Headroom workspace or the isolated gateway home.
    // Every area is scanned before anything is asserted, so the report names each leak at once (file names only, never values).
    const scanned = { logs: 0, headroom: 0, gateway: 0 };
    const leaks: string[] = [];
    const areaLeaks = (where: string, scan: { hits: number[]; hitFiles: string[] }): void => {
      FORBIDDEN_LABELS.forEach((label, i) => {
        if ((scan.hits[i] ?? 0) > 0) leaks.push(`${where}: ${label} in ${scan.hitFiles.join(', ')}`);
      });
    };
    for (const p of Object.values(r.projects)) {
      const logs = await scanTree(join(profileDir(p.name), 'logs'), FORBIDDEN);
      const workspace = await scanTree(join(profileDir(p.name), 'headroom'), FORBIDDEN);
      scanned.logs += logs.files; scanned.headroom += workspace.files;
      areaLeaks(`${p.slot} logs`, logs);
      areaLeaks(`${p.slot} headroom`, workspace);
    }
    const gateway = await scanTree(join(r.base.home, '.jev-gateway'), FORBIDDEN);
    scanned.gateway = gateway.files;
    areaLeaks('isolated .jev-gateway', gateway);
    const leakCount = leaks.length;
    // Run output: the fake login and the Claude key must not appear in what the clients printed (the canary is echoed by the tool output by design).
    const runOutputs = Object.values(r.runs).map(run => run.result.stdout + run.result.stderr).join('\n');
    const secretsInRunOutput = [ACCESS_TOKEN, ID_TOKEN, REFRESH_TOKEN, ACCOUNT_ID, ANTHROPIC_KEY].reduce((sum, secret) => sum + occurrences(runOutputs, secret), 0);
    assert.equal(secretsInRunOutput, 0, 'a fake credential appears in client run output');
    const check = await realHomeCheck(r);
    evidence.realHome = check;
    assert.equal(check.jevGatewayUnchanged, true, 'the real ~/.jev-gateway (except its live logs) changed during the run');
    assert.equal(check.headroomUnchanged, true, 'the real ~/.headroom listing changed during the run');
    assert.equal(check.codexAuthUnchanged, true, 'the real ~/.codex/auth.json changed during the run');
    assert.equal(check.liveLogLinesFromIsolatedRouters, 0, 'the real Jev logs hold lines from this run\'s isolated routers');
    assert.equal(check.liveLogTmpMarkerHits, 0, 'the real Jev logs reference this run\'s temp folder');
    assert.equal(check.claudeJsonTmpMarkerHits, 0, 'the real ~/.claude.json references this run\'s temp folder');
    evidence.securityScan = { scannedFiles: scanned, leakKinds: leakCount, runOutputSecretHits: secretsInRunOutput };
    evidence.cleanup = { headroomPortsRefused: refused.every(Boolean), codexRouterStopped: true, claudeRouterStopped: true };
    assert.equal(leakCount, 0, `secret or canary found in written files: ${leaks.join(' | ')}`);
    t.diagnostic('cleanup verified');
  });
});
