import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepare, root } from '../src/config.js';
import { gatewayDir } from '../src/install.js';
import { codexShimEnv, detectHeadroomPython, headroomArgs, headroomEnv, headroomRoute, shimPath } from '../src/headroom.js';
import { atomicJson, baseEnv, sleep } from '../src/local.js';

// Codex -> Headroom (real, pinned, shimmed) -> Jev codex gateway (real) -> mock ChatGPT backend, with mock-jev as the Jev model.
// Everything binds 127.0.0.1 on ephemeral ports and stays under .local/e2e; no external request is made.
// The suite is skipped with its reason when the pinned Headroom Codex route is not usable, so CI without it still passes.
const HEADROOM_VERSION = '0.41.0';
const detection = await detectHeadroomPython({ headroom: { enabled: true, port: 1, version: HEADROOM_VERSION, codex: true } });
const skip = detection.ok ? false : `Headroom ${HEADROOM_VERSION} Codex route is not usable: ${detection.reason}`;

const E2E_BASE = resolve(root, '.local/e2e');
const EVIDENCE_DIR = resolve(root, '.local/evidence'), EVIDENCE_FILE = 'headroom-codex-e2e.json';
const TOOL = 'get_synthetic_logs', CALL_ID = 'call_e2e1', MODEL = 'gpt-e2e', DONE = 'E2E-CODEX-DONE';
const RESPONSES_PATH = '/backend-api/codex/responses', MODELS_PATH = '/backend-api/codex/models';
const LOG_COUNT = 120;
const UUID = randomUUID();
const CANARY = `CANARY-CODEX-${UUID}`;
const ACCOUNT_ID = `acct-e2e-${UUID}`;
const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
// Unsigned JWT in the shape ChatGPT login uses: the account id travels in the auth claim.
const FAKE_JWT = `${b64url({ alg: 'none' })}.${b64url({ 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID } })}.sig`;
const CLIENT_BEARER = `Bearer ${FAKE_JWT}`;
const API_KEY = `sk-e2e-fake-${UUID}`;
const API_BEARER = `Bearer ${API_KEY}`;
const INSTRUCTIONS = `You are a synthetic Codex E2E assistant. ${CANARY}`;
const FORBIDDEN_IN_EVIDENCE = [CANARY, FAKE_JWT, ACCOUNT_ID, API_KEY, 'synthetic-jev-key'];
const SHIM_ALLOWED_BASE = ['jev.log', 'headroom.log', 'headroom-requests.jsonl', 'mock-jev.log', 'hr-workspace'];

// 120 log lines; every 47th is a failure. The canary rides in the first row, so it is part of the tool output.
const LOGS = JSON.stringify(Array.from({ length: LOG_COUNT }, (_, i) => {
  const failing = i % 47 === 0;
  return {
    ts: new Date(Date.UTC(2026, 9, 23, 12) + i * 1000).toISOString(),
    level: failing ? 'ERROR' : 'INFO',
    service: 'synthetic-api',
    request_id: `req-${100000 + i}`,
    latency_ms: 20 + ((i * 37) % 400),
    status: failing ? 500 : 200,
    path: `/v1/items/${i % 10}`,
    msg: failing ? 'upstream timeout' : 'request completed',
    ...(i === 0 ? { trace: CANARY } : {}),
  };
}), null, 2);

type Json = Record<string, unknown>;
interface Recorded { method: string | undefined; path: string; headers: IncomingHttpHeaders; raw: string; body: Json }
interface Mock { port: number; seen: Recorded[]; close: () => Promise<void> }
interface Ports { mock: number; mockJev: number; jev: number; headroom: number; dead: number }
interface Files { jevLog: string; headroomLog: string; requestsLog: string; mockJevLog: string; workspace: string; base: string }
interface Snapshots { homeHeadroom: string[] | null; homeCodex: string[] | null; homeGateway: string[] | null }
interface Rig { mock: Mock; mockJev: ChildProcess; jev: ChildProcess; headroom: ChildProcess; ports: Ports; files: Files; snapshots: Snapshots; startMs: Record<string, number> }
interface Turn { sent: Json; raw: string; forwarded: Recorded }
interface Sent { status: number; text: string; raw: string; durationMs: number }

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
async function refuses(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000), redirect: 'error' }); return false; }
  catch (e) { return (e as { cause?: { code?: unknown } }).cause?.code === 'ECONNREFUSED'; }
}
async function httpStatus(url: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  await res.text();
  return res.status;
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
// One request to the proxy or the mock. The bearer is the only credential; extra headers are for the bypass probe.
async function call(port: number, method: 'GET' | 'POST', path: string, bearer: string, body?: Json, headers: Record<string, string> = {}): Promise<Sent> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { authorization: bearer, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : raw,
  });
  const text = await res.text();
  return { status: res.status, text, raw, durationMs: Date.now() - started };
}

// ---- Process helpers -------------------------------------------------------------------

const alive = (child: ChildProcess): boolean => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
function runQuiet(file: string, args: string[]): Promise<void> {
  return new Promise(done => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: 'ignore', env: baseEnv() });
    child.once('error', () => done());
    child.once('exit', () => done());
  });
}
// Headroom from uv is a launcher that starts Python as a child, so the whole tree is stopped on Windows.
async function stopProcess(child: ChildProcess): Promise<void> {
  if (!alive(child)) return;
  const exited = new Promise<void>(done => child.once('exit', () => done()));
  if (process.platform === 'win32') await runQuiet('taskkill', ['/pid', String(child.pid), '/t', '/f']);
  else child.kill('SIGTERM');
  await Promise.race([exited, sleep(10_000)]);
  if (alive(child)) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(5_000)]);
  }
  if (alive(child)) throw new Error(`process ${child.pid} did not stop`);
}
// Waits for readiness; a child that exits first fails at once instead of waiting out the timeout.
async function waitFor(what: string, child: ChildProcess, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(child)) throw new Error(`${what} exited before it was ready (code ${child.exitCode ?? child.signalCode ?? 'spawn failed'})`);
    if (await check().catch(() => false)) return;
    if (Date.now() >= deadline) throw new Error(`${what} was not ready within ${timeoutMs} ms`);
    await sleep(250);
  }
}
// Listing and mtimes of a directory tree; null when it does not exist. Used to prove ~/.headroom is untouched.
async function snapshotTree(dir: string, recursive: boolean): Promise<string[] | null> {
  let names: string[];
  try { names = await readdir(dir, { recursive }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const rows: string[] = [];
  for (const name of names.sort()) {
    const info = await stat(join(dir, name));
    rows.push(`${name}|${info.size}|${info.mtimeMs}`);
  }
  return rows;
}

// Names of the entries whose listing row differs between two snapshots; rows are "name|size|mtime".
function changedEntries(before: string[] | null, after: string[] | null): string[] {
  const a = new Set(before ?? []), b = new Set(after ?? []);
  return [...new Set([...a, ...b].filter(row => !(a.has(row) && b.has(row))).map(row => row.split('|')[0] ?? row))].sort();
}
// Entry names only, so a file rewritten by a live session is not counted as an added or removed entry.
function entryNames(rows: string[] | null): string[] {
  return [...new Set((rows ?? []).map(row => row.split('|')[0] ?? row))].sort();
}

// ---- Mock ChatGPT backend --------------------------------------------------------------

const pathnameOf = (record: Recorded): string => new URL(record.path, 'http://mock.invalid').pathname;
const isResponsesCall = (record: Recorded): boolean => record.method === 'POST' && pathnameOf(record) === RESPONSES_PATH;
const headerOf = (record: Recorded, name: string): string | undefined => {
  const value = record.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
};
// The tool call answers the first turn only: once a function_call_output is in the input, the model answers in text.
function wantsToolCall(body: Json): boolean {
  const offered = list(body.tools).some(tool => tool.name === TOOL);
  const answered = list(body.input).some(item => item.type === 'function_call_output' || item.type === 'custom_tool_call_output');
  return offered && !answered;
}
function answerItem(toolCall: boolean): Json {
  return toolCall
    ? { type: 'function_call', id: 'fc_e2e1', call_id: CALL_ID, name: TOOL, arguments: '{}', status: 'completed' }
    : { type: 'message', id: 'msg_e2e1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: DONE, annotations: [] }] };
}
function usageOf(inputTokens: number): Json {
  return { input_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: inputTokens + 5 };
}
function responseJson(model: string, toolCall: boolean, inputTokens: number): Json {
  return { id: 'resp_e2e', object: 'response', status: 'completed', model, output: [answerItem(toolCall)], usage: usageOf(inputTokens) };
}
// Responses API framing: each frame is "event: X" then "data: {json}" then a blank line.
function responsesSse(model: string, toolCall: boolean, inputTokens: number): string {
  const item = answerItem(toolCall);
  const base = { id: 'resp_e2e', object: 'response', status: 'in_progress', model, output: [] };
  const started = toolCall ? { ...item, status: 'in_progress', arguments: '' } : { ...item, status: 'in_progress', content: [] };
  const frames: Array<[string, Json]> = [
    ['response.created', { type: 'response.created', response: base }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: started }],
  ];
  if (!toolCall) frames.push(['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_e2e1', output_index: 0, content_index: 0, delta: DONE }]);
  frames.push(['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }]);
  frames.push(['response.completed', { type: 'response.completed', response: { ...base, status: 'completed', output: [item], usage: usageOf(inputTokens) } }]);
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
async function startMockChatGpt(): Promise<Mock> {
  const seen: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const raw = await readText(req);
    const path = req.url ?? '';
    const body = parseBody(raw);
    seen.push({ method: req.method, path, headers: req.headers, raw, body });
    const pathname = new URL(path, 'http://mock.invalid').pathname;
    const json = { 'content-type': 'application/json' };
    if (req.method === 'POST' && pathname === RESPONSES_PATH) {
      const model = typeof body.model === 'string' ? body.model : MODEL;
      const toolCall = wantsToolCall(body);
      const inputTokens = Math.ceil(Buffer.byteLength(raw) / 4);
      if (body.stream === true) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).end(responsesSse(model, toolCall, inputTokens));
      else res.writeHead(200, json).end(JSON.stringify(responseJson(model, toolCall, inputTokens)));
      return;
    }
    if (req.method === 'GET' && pathname === MODELS_PATH) {
      res.writeHead(200, json).end(JSON.stringify({ models: [{ slug: MODEL, display_name: 'e2e' }] }));
      return;
    }
    res.writeHead(404, json).end(JSON.stringify({ error: { type: 'not_found', message: 'mock ChatGPT backend serves POST /backend-api/codex/responses and GET /backend-api/codex/models' } }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return { port, seen, close: () => closeServer(server) };
}

// ---- Fixtures --------------------------------------------------------------------------

const toolDefs = (): unknown[] => [{
  type: 'function', name: TOOL, description: 'Returns synthetic service log lines for the Headroom Codex E2E fixture.',
  parameters: { type: 'object', properties: { level: { type: 'string' } } },
}];
const userMessage = (text: string): Json => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const turn1Input = (): unknown[] => [userMessage('Fetch the synthetic service logs and list the failing requests.')];
function turn2Input(): unknown[] {
  return [
    ...turn1Input(),
    { type: 'function_call', call_id: CALL_ID, name: TOOL, arguments: '{}' },
    { type: 'function_call_output', call_id: CALL_ID, output: LOGS },
  ];
}
function requestBody(input: unknown[], stream: boolean): Json {
  return { model: MODEL, instructions: INSTRUCTIONS, input, tools: toolDefs(), stream };
}

// ---- Stream and body inspection --------------------------------------------------------

// Each SSE block carries one JSON object in its data line; its "type" field names the event.
function sseData(text: string): Json[] {
  const frames: Json[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = /^data:\s*(.+)$/m.exec(block)?.[1];
    if (data !== undefined) frames.push(asJson(data.trim()));
  }
  return frames;
}
function completedResponse(text: string): Json | undefined {
  const event = sseData(text).find(frame => frame.type === 'response.completed');
  return isJson(event?.response) ? event.response : undefined;
}
function outputText(response: Json | undefined): string {
  return list(response?.output)
    .filter(item => item.type === 'message')
    .flatMap(item => list(item.content))
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}
function toolOutputText(body: Json): string {
  return list(body.input)
    .filter(item => item.type === 'function_call_output')
    .map(item => (typeof item.output === 'string' ? item.output : JSON.stringify(item.output)))
    .join('\n');
}
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;
async function readRouteEntries(file: string): Promise<Json[]> {
  const entries: Json[] = [];
  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    if (!line.includes('"event":"route"')) continue;
    try { entries.push(asJson(line)); } catch { /* Not a JSON log line. */ }
  }
  return entries;
}

// ---- WebSocket probe -------------------------------------------------------------------

interface WsLike { send(data: string): void; close(): void; addEventListener(type: string, listener: (event: unknown) => void): void }
type WsCtor = new (url: string, init?: Record<string, unknown>) => WsLike;
// Resolves with what the peer did; the probe never waits longer than the timeout.
function attemptSocket(url: string, init: Record<string, unknown> | undefined, payload: string): Promise<{ constructed: boolean; outcome: string }> {
  const Ctor = (globalThis as { WebSocket?: unknown }).WebSocket as WsCtor | undefined;
  if (Ctor === undefined) return Promise.resolve({ constructed: false, outcome: 'WebSocket global unavailable' });
  let socket: WsLike;
  try { socket = init === undefined ? new Ctor(url) : new Ctor(url, init); }
  catch (e) { return Promise.resolve({ constructed: false, outcome: `constructor threw ${(e as Error).name}` }); }
  return new Promise(done => {
    const finish = (outcome: string): void => { clearTimeout(timer); socket.close(); done({ constructed: true, outcome }); };
    const timer = setTimeout(() => finish('no answer within 8 s'), 8_000);
    socket.addEventListener('open', () => socket.send(payload));
    socket.addEventListener('message', () => finish('message received'));
    socket.addEventListener('error', () => finish('error event'));
    socket.addEventListener('close', (event: unknown) => finish(`closed ${(event as { code?: number }).code ?? 'unknown'}`));
  });
}

// ---- Evidence ---------------------------------------------------------------------------

// Counts and sizes only: the secrets and the canary must never reach the evidence file.
async function writeEvidence(evidence: Record<string, unknown>): Promise<void> {
  await prepare(EVIDENCE_DIR);
  const text = JSON.stringify(evidence, null, 2);
  for (const forbidden of FORBIDDEN_IN_EVIDENCE) assert.equal(text.includes(forbidden), false, 'evidence must not contain tokens or canaries');
  await atomicJson(resolve(EVIDENCE_DIR, EVIDENCE_FILE), evidence);
}

// ---- Suite ------------------------------------------------------------------------------

describe('headroom codex proxy e2e', { skip, concurrency: 1, timeout: 900_000 }, () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  const evidence: Record<string, unknown> = {};
  const passed: string[] = [];
  const turns: { turn1?: { input: unknown[]; instructions: string; sent: Json }; turn2?: Turn } = {};
  let rig: Rig | undefined;
  const live = (): Rig => {
    if (!rig) throw new Error('Headroom Codex rig was not started');
    return rig;
  };
  // Last in, first out: processes stop before the log handles close, and the temp tree goes last.
  async function runCleanups(): Promise<void> {
    const errors: unknown[] = [];
    for (const step of cleanups.splice(0).reverse()) {
      try { await step(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'cleanup failed');
  }
  async function openLog(path: string): Promise<FileHandle> {
    const handle = await open(path, 'a');
    cleanups.push(() => handle.close());
    return handle;
  }

  before(async () => {
    if (!detection.ok) throw new Error(detection.reason);
    // Snapshots first: nothing in this run may change these trees, so the baselines are taken before any process starts.
    const snapshots: Snapshots = {
      homeHeadroom: await snapshotTree(join(homedir(), '.headroom'), true),
      homeCodex: await snapshotTree(join(homedir(), '.codex'), false),
      homeGateway: await snapshotTree(join(homedir(), '.jev-gateway'), false),
    };
    await prepare(E2E_BASE);
    const base = await mkdtemp(resolve(E2E_BASE, 'headroom-codex-'));
    cleanups.push(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
    try {
      const files: Files = {
        base, jevLog: join(base, 'jev.log'), headroomLog: join(base, 'headroom.log'),
        requestsLog: join(base, 'headroom-requests.jsonl'), mockJevLog: join(base, 'mock-jev.log'),
        workspace: join(base, 'hr-workspace'),
      };
      await mkdir(files.workspace, { recursive: true });
      const startMs: Record<string, number> = {};

      const mock = await startMockChatGpt();
      cleanups.push(() => mock.close());
      const mockJevPort = await freeTcpPort(), jevPort = await freeTcpPort(), headroomPort = await freeTcpPort();
      // Nothing listens here: Headroom's Claude upstream is unused in this suite.
      const deadPort = await freeTcpPort();

      const mockJevLog = await openLog(files.mockJevLog);
      const mockJevStarted = Date.now();
      const mockJev = spawn(process.execPath, [resolve(root, 'upstream/jev-gateway/scripts/mock-jev.mjs')], {
        cwd: root, shell: false, windowsHide: true, stdio: ['ignore', mockJevLog.fd, mockJevLog.fd],
        env: { ...baseEnv(), MOCK_JEV_PORT: String(mockJevPort), MOCK_JEV_SCRIPT: `${TOOL},no_tool_needed` },
      });
      mockJev.on('error', () => undefined);
      cleanups.push(() => stopProcess(mockJev));
      await waitFor('mock-jev', mockJev, async () => (await readFile(files.mockJevLog, 'utf8')).includes('mock-jev on'), 20_000);
      startMs.mockJev = Date.now() - mockJevStarted;

      const jevLog = await openLog(files.jevLog);
      const jevDir = gatewayDir();
      const jevStarted = Date.now();
      const jev = spawn(process.execPath, [resolve(jevDir, 'dist/index.js')], {
        cwd: jevDir, shell: false, windowsHide: true, stdio: ['ignore', jevLog.fd, jevLog.fd],
        env: {
          ...baseEnv(), HOST: '127.0.0.1', PORT: String(jevPort), JEV_CLIENT: 'codex',
          UPSTREAM_BASE_URL: `http://127.0.0.1:${mock.port}/backend-api/codex`, JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'synthetic-jev-key',
          TYPESAFE_BASE_URL: `http://127.0.0.1:${mockJevPort}`, JEV_LOG_FILE: files.jevLog,
        },
      });
      jev.on('error', () => undefined);
      cleanups.push(() => stopProcess(jev));
      await waitFor('Jev codex gateway', jev, async () => (await httpStatus(`http://127.0.0.1:${jevPort}/health`)) === 200, 60_000);
      startMs.jev = Date.now() - jevStarted;

      // Headroom is started with the same python, argv, env and cwd the supervisor uses for a Codex profile.
      const python = detection.python;
      const headroomLog = await openLog(files.headroomLog);
      const headroomStarted = Date.now();
      const headroom = spawn(python, ['-I', shimPath(HEADROOM_VERSION), ...headroomArgs(headroomPort, deadPort, files.requestsLog, jevPort)], {
        cwd: files.workspace, env: codexShimEnv(headroomEnv(baseEnv(), files.workspace), jevPort), shell: false, windowsHide: true,
        stdio: ['ignore', headroomLog.fd, headroomLog.fd],
      });
      headroom.on('error', () => undefined);
      cleanups.push(() => stopProcess(headroom));
      await waitFor('Headroom', headroom, async () => (await httpStatus(`http://127.0.0.1:${headroomPort}/livez`)) === 200, 90_000);
      startMs.headroom = Date.now() - headroomStarted;

      rig = {
        mock, mockJev, jev, headroom, files, snapshots, startMs,
        ports: { mock: mock.port, mockJev: mockJevPort, jev: jevPort, headroom: headroomPort, dead: deadPort },
      };
      evidence.headroomVersion = detection.version;
    } catch (error) {
      await runCleanups().catch(cleanupError => process.stderr.write(`headroom codex e2e cleanup failed: ${String(cleanupError)}\n`));
      throw error;
    }
  }, { timeout: 180_000 });

  after(async () => {
    const outcome: { error?: unknown } = {};
    await runCleanups().catch(error => { outcome.error = error; });
    if (rig) {
      const r = rig;
      evidence.processesStopped = { headroom: !alive(r.headroom), jev: !alive(r.jev), mockJev: !alive(r.mockJev) };
      evidence.portsRefused = {
        headroom: await refuses(r.ports.headroom), jev: await refuses(r.ports.jev),
        mockJev: await refuses(r.ports.mockJev), mock: await refuses(r.ports.mock),
      };
      evidence.passedTests = passed;
      await writeEvidence(evidence);
      assert.deepEqual(evidence.processesStopped, { headroom: true, jev: true, mockJev: true }, 'every spawned process must be stopped');
    }
    if (outcome.error) throw outcome.error;
  }, { timeout: 60_000 });

  test('streaming Responses call flows through Headroom and Jev to the ChatGPT backend', { timeout: 120_000 }, async () => {
    const r = live();
    const input = turn1Input();
    const sent = requestBody(input, true);
    const reply = await call(r.ports.headroom, 'POST', '/v1/responses', CLIENT_BEARER, sent);
    assert.equal(reply.status, 200, `Headroom answered HTTP ${reply.status}`);
    const completed = completedResponse(reply.text);
    assert.ok(completed, 'stream has no response.completed event');
    const calls = list(completed.output).filter(item => item.type === 'function_call');
    assert.ok(calls.some(item => item.name === TOOL), `response.completed has no function_call named ${TOOL}`);
    const posts = r.mock.seen.filter(isResponsesCall);
    assert.equal(posts.length, 1, `mock ChatGPT backend saw ${posts.length} POST ${RESPONSES_PATH} requests, expected exactly 1`);
    const forwarded = posts[0];
    assert.ok(forwarded, 'forwarded request is missing');
    assert.equal(headerOf(forwarded, 'authorization'), CLIENT_BEARER, 'forwarded authorization differs from the client bearer');
    assert.equal(headerOf(forwarded, 'chatgpt-account-id'), ACCOUNT_ID, 'forwarded chatgpt-account-id differs from the JWT account id');
    const routed = await eventually(async () => (await readRouteEntries(r.files.jevLog)).some(entry => entry.path === '/v1/responses'));
    assert.ok(routed, 'jev.log has no route line with path "/v1/responses"');
    turns.turn1 = { input, instructions: INSTRUCTIONS, sent };
    evidence.turn1 = {
      status: reply.status, durationMs: reply.durationMs, sentBodyBytes: Buffer.byteLength(reply.raw),
      functionCalls: calls.length, mockResponsesCalls: posts.length, accountIdForwarded: true, bearerForwarded: true,
    };
    passed.push('streaming Responses call flows through Headroom and Jev to the ChatGPT backend');
  });

  test('tool output is compressed losslessly with no retrieval tool', { timeout: 120_000 }, async () => {
    const r = live();
    const before = r.mock.seen.filter(isResponsesCall).length;
    const sent = requestBody(turn2Input(), true);
    const reply = await call(r.ports.headroom, 'POST', '/v1/responses', CLIENT_BEARER, sent);
    assert.equal(reply.status, 200, `Headroom answered HTTP ${reply.status}`);
    assert.equal(outputText(completedResponse(reply.text)), DONE, `turn 2 must end with the mock text reply ${DONE}`);
    const forwarded = r.mock.seen.filter(isResponsesCall).slice(before);
    assert.equal(forwarded.length, 1, `mock saw ${forwarded.length} forwarded requests for turn 2, expected 1`);
    const turn2 = forwarded[0];
    assert.ok(turn2, 'forwarded turn 2 request is missing');
    const resultText = toolOutputText(turn2.body);
    assert.equal(occurrences(resultText, 'req-1'), LOG_COUNT, 'every request_id must survive compression');
    assert.equal(occurrences(resultText, 'ERROR'), 3, 'every ERROR line must survive compression');
    assert.ok(resultText.length < LOGS.length, `tool output was not compressed (${resultText.length} >= ${LOGS.length} bytes)`);
    const names = list(turn2.body.tools).map(tool => tool.name);
    assert.ok(names.includes(TOOL), `the offered ${TOOL} tool must still be forwarded`);
    assert.equal(turn2.raw.includes('headroom_retrieve'), false, 'Headroom retrieval tool must not appear in the forwarded body');
    assert.equal(turn2.raw.includes('hash='), false, 'forwarded body must not carry hash= markers');
    assert.equal(turn2.raw.includes('<<ccr'), false, 'forwarded body must not carry <<ccr markers');
    turns.turn2 = { sent, raw: reply.raw, forwarded: turn2 };
    evidence.turn2 = {
      status: reply.status, durationMs: reply.durationMs, sentToolOutputBytes: LOGS.length,
      forwardedToolOutputBytes: Buffer.byteLength(resultText), requestIdOccurrences: occurrences(resultText, 'req-1'),
      errorOccurrences: occurrences(resultText, 'ERROR'), sentBodyBytes: Buffer.byteLength(reply.raw),
      forwardedBodyBytes: Buffer.byteLength(turn2.raw), retrievalTool: false,
    };
    passed.push('tool output is compressed losslessly with no retrieval tool');
  });

  test('earlier turns stay byte-identical for prefix caching', { timeout: 60_000 }, () => {
    assert.ok(turns.turn1 && turns.turn2, 'turns 1 and 2 must run first');
    const { forwarded } = turns.turn2;
    assert.equal(JSON.stringify(forwarded.body.instructions), JSON.stringify(turns.turn1.instructions), 'instructions changed in the forwarded turn 2');
    const sentTurn1 = turns.turn1.input;
    const forwardedInput = list(forwarded.body.input);
    assert.ok(sentTurn1.length > 0, 'turn 1 must carry input items');
    sentTurn1.forEach((item, i) => {
      assert.equal(JSON.stringify(forwardedInput[i]), JSON.stringify(item), `turn 1 input item ${i} changed in the forwarded turn 2`);
    });
    evidence.prefixCache = { instructionsIdentical: true, turn1InputItemsIdentical: sentTurn1.length };
    passed.push('earlier turns stay byte-identical for prefix caching');
  });

  test('model discovery goes through Jev, not directly to chatgpt.com', { timeout: 60_000 }, async () => {
    const r = live();
    const before = r.mock.seen.length;
    const reply = await call(r.ports.headroom, 'GET', '/v1/models?client_version=0.163.0', CLIENT_BEARER);
    assert.equal(reply.status, 200, `Headroom answered HTTP ${reply.status} for model discovery`);
    const slugs = list(asJson(reply.text).models).map(model => model.slug);
    assert.ok(slugs.includes(MODEL), `model list does not contain ${MODEL}`);
    const modelCalls = r.mock.seen.slice(before).filter(record => record.method === 'GET' && pathnameOf(record) === MODELS_PATH);
    assert.ok(modelCalls.length >= 1, `mock ChatGPT backend saw no GET ${MODELS_PATH} through Jev`);
    const last = modelCalls[modelCalls.length - 1];
    assert.ok(last, 'model discovery request is missing');
    assert.ok(last.path.includes('client_version=0.163.0'), 'client_version query did not reach the backend');
    assert.equal(headerOf(last, 'authorization'), CLIENT_BEARER, 'model discovery authorization differs from the client bearer');
    const headroomLog = await readFile(r.files.headroomLog, 'utf8');
    assert.equal(headroomLog.includes('host=chatgpt.com'), false, 'headroom.log shows an egress attempt to chatgpt.com');
    evidence.modelDiscovery = { status: reply.status, durationMs: reply.durationMs, backendModelCalls: modelCalls.length, models: slugs.length, chatgptEgressBlockedLines: 0 };
    passed.push('model discovery goes through Jev, not directly to chatgpt.com');
  });

  test('API-key Codex path reaches the backend through Jev with the key unchanged', { timeout: 120_000 }, async () => {
    const r = live();
    const before = r.mock.seen.filter(isResponsesCall).length;
    const reply = await call(r.ports.headroom, 'POST', '/v1/responses', API_BEARER, requestBody(turn1Input(), false));
    assert.equal(reply.status, 200, `Headroom answered HTTP ${reply.status} on the API-key path`);
    assert.equal(asJson(reply.text).object, 'response', 'API-key reply must be a Responses object');
    const forwarded = r.mock.seen.filter(isResponsesCall).slice(before);
    assert.equal(forwarded.length, 1, `mock saw ${forwarded.length} API-key requests, expected 1`);
    const first = forwarded[0];
    assert.ok(first, 'forwarded API-key request is missing');
    assert.equal(headerOf(first, 'authorization'), API_BEARER, 'API key was altered on the way to the backend');
    evidence.apiKeyPath = { status: reply.status, durationMs: reply.durationMs, backendResponsesCalls: forwarded.length, keyUnchanged: true, chatgptAccountIdPresent: headerOf(first, 'chatgpt-account-id') !== undefined };
    passed.push('API-key Codex path reaches the backend through Jev with the key unchanged');
  });

  // Headroom itself ignores an unsafe x-headroom-base-url override; any connection it still tries is refused by the egress guard.
  test('bypass header cannot send a request to a non-Jev host', { timeout: 60_000 }, async () => {
    const r = live();
    const beforeMock = r.mock.seen.length;
    const beforeRoutes = (await readRouteEntries(r.files.jevLog)).length;
    const refusedCount = async (): Promise<number> => (await readFile(r.files.headroomLog, 'utf8')).split(/\r?\n/).filter(line => line.includes('jms-egress-blocked host=api.openai.com')).length;
    const refusedBefore = await refusedCount();
    const reply = await call(r.ports.headroom, 'POST', '/v1/responses', API_BEARER, requestBody(turn1Input(), false), { 'x-headroom-base-url': 'https://api.openai.com/v1' });
    const added = r.mock.seen.slice(beforeMock);
    let jevRouteLinesAdded = 0;
    const routed = await eventually(async () => {
      jevRouteLinesAdded = (await readRouteEntries(r.files.jevLog)).length - beforeRoutes;
      return jevRouteLinesAdded >= added.length;
    });
    assert.ok(routed, `backend saw ${added.length} requests from the bypass probe but jev.log has ${jevRouteLinesAdded} route lines`);
    assert.ok(added.every(record => headerOf(record, 'authorization') === API_BEARER), 'bypass probe reached the backend with an unexpected authorization header');
    await sleep(500);
    const headroomLog = await readFile(r.files.headroomLog, 'utf8');
    const overrideIgnored = headroomLog.includes("ignoring unsafe x-headroom-base-url override: 'https://api.openai.com/v1'");
    assert.ok(overrideIgnored, 'Headroom did not report that it ignored the override');
    // The inbound echo, the ignore warning and the refused-egress line are not connections; any other api.openai.com line would be one.
    const stray = headroomLog.split(/\r?\n/).filter(line => line.includes('api.openai.com')
      && !line.includes('event=proxy_inbound_request') && !line.includes('ignoring unsafe x-headroom-base-url override')
      && !line.includes('jms-egress-blocked host=api.openai.com'));
    assert.deepEqual(stray, [], `headroom.log has a connection line for api.openai.com that was not refused: ${stray[0] ?? ''}`);
    const refusedDuringProbe = (await refusedCount()) - refusedBefore;
    evidence.bypassHeader = { status: reply.status, durationMs: reply.durationMs, overrideIgnoredByHeadroom: overrideIgnored, egressRefusedDuringProbe: refusedDuringProbe, outboundSucceeded: false, backendRequestsAdded: added.length, jevRouteLinesAdded };
    passed.push('bypass header cannot send a request to a non-Jev host');
  });

  test('WebSocket with the ChatGPT login reaches the backend only through Jev', { timeout: 60_000 }, async () => {
    const r = live();
    const beforeMock = r.mock.seen.length;
    const beforeRoutes = (await readRouteEntries(r.files.jevLog)).length;
    const url = `ws://127.0.0.1:${r.ports.headroom}/v1/responses`;
    const payload = JSON.stringify({ type: 'response.create', model: MODEL, instructions: INSTRUCTIONS, input: turn1Input(), tools: toolDefs() });
    // Node's global WebSocket may take a headers option; when it does not, the probe still runs without headers.
    const withHeaders = await attemptSocket(url, { headers: { authorization: CLIENT_BEARER } }, payload);
    const attempt = withHeaders.constructed ? withHeaders : await attemptSocket(url, undefined, payload);
    const added = r.mock.seen.slice(beforeMock);
    let jevRouteLinesAdded = 0;
    const routed = await eventually(async () => {
      jevRouteLinesAdded = (await readRouteEntries(r.files.jevLog)).length - beforeRoutes;
      return jevRouteLinesAdded >= added.length;
    });
    assert.ok(routed, `backend saw ${added.length} WebSocket-driven requests but jev.log has ${jevRouteLinesAdded} route lines`);
    assert.ok(added.every(record => headerOf(record, 'authorization') === CLIENT_BEARER && headerOf(record, 'chatgpt-account-id') === ACCOUNT_ID),
      'WebSocket-driven backend request carried an unexpected authorization or account header');
    const headroomLog = await readFile(r.files.headroomLog, 'utf8');
    assert.equal(headroomLog.includes('host=chatgpt.com'), false, 'WebSocket attempt produced a chatgpt.com egress block');
    evidence.websocket = { headersOptionAccepted: withHeaders.constructed, outcome: attempt.outcome, backendRequestsAdded: added.length, jevRouteLinesAdded, chatgptEgressBlocked: false };
    passed.push('WebSocket with the ChatGPT login reaches the backend only through Jev');
  });

  test('no connection attempt to chatgpt.com is logged', { timeout: 30_000 }, async () => {
    const r = live();
    const headroomLog = await readFile(r.files.headroomLog, 'utf8');
    const blocked = headroomLog.split(/\r?\n/).filter(line => line.includes('jms-egress-blocked'));
    assert.equal(headroomLog.includes('host=chatgpt.com'), false, 'headroom.log contains a chatgpt.com connection attempt');
    const hosts = [...new Set(blocked.map(line => /host=(\S+)/.exec(line)?.[1] ?? 'unknown'))].sort();
    evidence.egress = { blockedLines: blocked.length, blockedHosts: hosts, chatgptAttempts: 0 };
    passed.push('no connection attempt to chatgpt.com is logged');
  });

  test('credentials and content stay out of logs and the mock sees only the client credentials', { timeout: 120_000 }, async () => {
    const r = live();
    assert.ok(r.mock.seen.length > 0, 'mock ChatGPT backend saw no traffic');
    for (const record of r.mock.seen) {
      const auth = headerOf(record, 'authorization');
      assert.ok(auth === CLIENT_BEARER || auth === API_BEARER, `forwarded ${record.path} carried an unexpected authorization header`);
      assert.equal(Object.keys(record.headers).some(name => name.startsWith('x-headroom-')), false, `forwarded ${record.path} carried an x-headroom-* header`);
    }
    const headroomLog = await readFile(r.files.headroomLog, 'utf8');
    const requestsLog = await readFile(r.files.requestsLog, 'utf8');
    for (const [name, text] of [['headroom.log', headroomLog], ['headroom-requests.jsonl', requestsLog]] as const) {
      for (const [label, secret] of [['fake JWT', FAKE_JWT], ['account id', ACCOUNT_ID], ['API key', API_KEY], ['prompt canary', CANARY]] as const) {
        assert.equal(text.includes(secret), false, `${name} contains the ${label}`);
      }
    }
    const entries = await readdir(r.files.workspace, { recursive: true });
    const baseEntries = await readdir(r.files.base);
    const unexpected = baseEntries.filter(name => !SHIM_ALLOWED_BASE.includes(name));
    assert.deepEqual(unexpected, [], 'Headroom or the rig wrote outside the expected profile tree');
    evidence.credentials = {
      mockRequests: r.mock.seen.length, authorizationAllowed: true, headroomHeadersForwarded: 0,
      headroomLogBytes: Buffer.byteLength(headroomLog), requestsLogBytes: Buffer.byteLength(requestsLog),
      workspaceEntries: entries.length, unexpectedBaseEntries: unexpected.length,
    };
    passed.push('credentials and content stay out of logs and the mock sees only the client credentials');
  });

  test('state stays in the profile workspace and no home tree changes', { timeout: 60_000 }, async () => {
    const r = live();
    const homeHeadroom = await snapshotTree(join(homedir(), '.headroom'), true);
    const homeCodex = await snapshotTree(join(homedir(), '.codex'), false);
    const homeGateway = await snapshotTree(join(homedir(), '.jev-gateway'), false);
    assert.deepEqual(homeHeadroom, r.snapshots.homeHeadroom, '~/.headroom changed during the run');
    // ~/.codex and ~/.jev-gateway belong to live Codex and Claude sessions that rewrite their own files, so only added or removed entries are asserted.
    const codexModified = changedEntries(r.snapshots.homeCodex, homeCodex);
    const gatewayModified = changedEntries(r.snapshots.homeGateway, homeGateway);
    assert.deepEqual(entryNames(homeCodex), entryNames(r.snapshots.homeCodex), '~/.codex entries were added or removed during the run');
    assert.deepEqual(entryNames(homeGateway), entryNames(r.snapshots.homeGateway), '~/.jev-gateway entries were added or removed during the run');
    evidence.homes = { headroomUnchanged: true, addedOrRemovedEntries: 0, codexEntriesModified: codexModified.length, gatewayEntriesModified: gatewayModified.length };
    passed.push('state stays in the profile workspace and no home tree changes');
  });

  test('rollback: a stopped Headroom is reported and refused', { timeout: 60_000 }, async () => {
    const r = live();
    await stopProcess(r.headroom);
    assert.equal(alive(r.headroom), false, 'Headroom must be stopped');
    assert.ok(await eventually(() => refuses(r.ports.headroom), 15_000), 'Headroom port still accepts connections after stop');
    await assert.rejects(fetch(`http://127.0.0.1:${r.ports.headroom}/livez`, { signal: AbortSignal.timeout(2000), redirect: 'error' }));
    const stopped = headroomRoute({ enabled: true, optOut: false, serviceState: 'stopped', upstreamPort: r.ports.jev, jevPort: r.ports.jev, live: false, port: r.ports.headroom });
    assert.deepEqual(stopped, { use: false, reason: 'Headroom service is stopped' });
    const disabled = headroomRoute({ enabled: false, optOut: false, serviceState: 'stopped', upstreamPort: r.ports.jev, jevPort: r.ports.jev, live: false, port: r.ports.headroom });
    assert.deepEqual(disabled, { use: false, reason: 'Headroom is disabled for this profile' });
    evidence.rollback = { portRefusedAfterStop: true, livezRejected: true, stoppedRoute: stopped.use, disabledReason: disabled.reason };
    passed.push('rollback: a stopped Headroom is reported and refused');
  });
});
