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
import { detectHeadroom, headroomArgs, headroomEnv, headroomRoute } from '../src/headroom.js';
import { atomicJson, baseEnv, sleep } from '../src/local.js';

// Claude -> Headroom (real, pinned) -> Jev gateway (real) -> mock Anthropic upstream, with mock-jev as the Jev model.
// Everything binds 127.0.0.1 on ephemeral ports and stays under .local/e2e; no external request is made.
// The suite is skipped with its reason when the pinned Headroom is not installed, so CI without it still passes.
const HEADROOM_VERSION = '0.41.0';
const detection = await detectHeadroom({ headroom: { enabled: true, port: 1, version: HEADROOM_VERSION, codex: false } });
const skip = detection.ok ? false : `Headroom ${HEADROOM_VERSION} is not usable: ${detection.reason}`;

const E2E_BASE = resolve(root, '.local/e2e');
const EVIDENCE_DIR = resolve(root, '.local/evidence'), EVIDENCE_FILE = 'headroom-e2e.json';
const TOOL = 'get_synthetic_logs', TOOL_ID = 'toolu_e2e1', MODEL = 'synthetic-model';
const LOG_COUNT = 120;
const UUID = randomUUID();
const CANARY = `CANARY-PROMPT-${UUID}`;
const CLIENT_BEARER = `Bearer synthetic-client-token-${UUID}`;
const CLIENT_TOKEN_PREFIX = 'synthetic-client-token';
const JEV_KEY = 'synthetic-jev-key';
const FORBIDDEN_IN_EVIDENCE = [CANARY, CLIENT_TOKEN_PREFIX, JEV_KEY, CLIENT_BEARER];

// 120 log lines; every 47th is a failure. Compression must keep all ids and all failures.
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
  };
}), null, 2);

type Json = Record<string, unknown>;
interface Recorded { method: string | undefined; path: string; headers: IncomingHttpHeaders; raw: string; body: Json }
interface Mock { port: number; seen: Recorded[]; close: () => Promise<void> }
interface SseEvent { event: string; data: Json }
interface Ports { mock: number; mockJev: number; jev: number; headroom: number }
interface Files { jevLog: string; headroomLog: string; requestsLog: string; mockJevLog: string; workspace: string }
interface Rig {
  mock: Mock; mockJev: ChildProcess; jev: ChildProcess; headroom: ChildProcess;
  ports: Ports; files: Files; homeDir: string; homeBefore: string[] | null; startMs: Record<string, number>;
}
interface Turn2 { sent: Json; raw: string; forwarded: Recorded }

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
async function snapshotTree(dir: string): Promise<string[] | null> {
  let names: string[];
  try { names = await readdir(dir, { recursive: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const rows: string[] = [];
  for (const name of names.sort()) {
    const info = await stat(join(dir, name));
    rows.push(`${name}|${info.size}|${info.mtimeMs}`);
  }
  return rows;
}

// ---- Mock Anthropic upstream -----------------------------------------------------------

function replyIsToolUse(body: Json): boolean {
  const offered = list(body.tools).some(tool => tool.name === TOOL);
  const answered = list(body.messages).some(message => list(message.content).some(block => block.type === 'tool_result'));
  return offered && !answered;
}
function messageJson(tool: boolean, model: string, inputTokens: number): Json {
  return {
    id: 'msg_e2e', type: 'message', role: 'assistant', model,
    content: tool ? [{ type: 'tool_use', id: TOOL_ID, name: TOOL, input: {} }] : [{ type: 'text', text: 'E2E-DONE' }],
    stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 5 },
  };
}
// Anthropic SSE framing: each frame is "event: X" then "data: {json}" then a blank line.
function sseFrames(tool: boolean, model: string, inputTokens: number): string {
  const block = tool ? { type: 'tool_use', id: TOOL_ID, name: TOOL, input: {} } : { type: 'text', text: '' };
  const delta = tool ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: 'E2E-DONE' };
  const frames: Array<[string, Json]> = [
    ['message_start', { type: 'message_start', message: { id: 'msg_e2e', type: 'message', role: 'assistant', model, content: [],
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
    const path = req.url ?? '';
    const body = parseBody(raw);
    seen.push({ method: req.method, path, headers: req.headers, raw, body });
    if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock upstream serves POST /v1/messages' } }));
      return;
    }
    const model = typeof body.model === 'string' ? body.model : MODEL;
    const inputTokens = Math.ceil(Buffer.byteLength(raw) / 4);
    const tool = replyIsToolUse(body);
    if (body.stream === true) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).end(sseFrames(tool, model, inputTokens));
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(messageJson(tool, model, inputTokens)));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return { port, seen, close: () => closeServer(server) };
}

// ---- Fixtures --------------------------------------------------------------------------

const cacheControl = (): Json => ({ type: 'ephemeral' });
const systemBlocks = (): unknown[] => [{ type: 'text', text: `You are a synthetic E2E assistant. ${CANARY}`, cache_control: cacheControl() }];
const toolDefs = (): unknown[] => [{
  name: TOOL, description: 'Returns synthetic service log lines for the Headroom E2E fixture.',
  input_schema: { type: 'object', properties: { level: { type: 'string' } } },
}];
const turn1Messages = (): unknown[] => [{ role: 'user', content: [{ type: 'text', text: 'Fetch the synthetic service logs and list the failing requests.', cache_control: cacheControl() }] }];
function turn2Messages(): unknown[] {
  return [
    ...turn1Messages(),
    { role: 'assistant', content: [{ type: 'tool_use', id: TOOL_ID, name: TOOL, input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_ID, content: LOGS, cache_control: cacheControl() }] },
  ];
}
function requestBody(messages: unknown[], stream: boolean): Json {
  return { model: MODEL, max_tokens: 256, stream, system: systemBlocks(), tools: toolDefs(), messages };
}
interface Sent { status: number; text: string; raw: string; durationMs: number }
async function send(port: number, body: Json): Promise<Sent> {
  const raw = JSON.stringify(body);
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { authorization: CLIENT_BEARER, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, text, raw, durationMs: Date.now() - started };
}

// ---- Stream and body inspection --------------------------------------------------------

function parseSse(text: string): SseEvent[] {
  return text.split(/\r?\n\r?\n/).filter(block => block.trim() !== '').map(block => {
    const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? '';
    const data = /^data:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? '{}';
    return { event, data: asJson(data) };
  });
}
function blockOf(event: SseEvent): Json | undefined {
  const block = event.data.content_block;
  return isJson(block) ? block : undefined;
}
function textOfStream(text: string): string {
  return parseSse(text).map(event => {
    const delta = event.data.delta;
    return event.event === 'content_block_delta' && isJson(delta) && delta.type === 'text_delta' ? String(delta.text) : '';
  }).join('');
}
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
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;
const countCacheControl = (raw: string): number => occurrences(raw, '"cache_control"');
const isMessageCall = (record: Recorded): boolean => record.method === 'POST' && record.path.endsWith('/v1/messages');
async function readRouteEntries(file: string): Promise<Json[]> {
  const entries: Json[] = [];
  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    if (!line.includes('"event":"route"')) continue;
    try { entries.push(asJson(line)); } catch { /* Not a JSON log line. */ }
  }
  return entries;
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

describe('headroom proxy e2e', { skip, concurrency: 1, timeout: 900_000 }, () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  const evidence: Record<string, unknown> = {};
  const passed: string[] = [];
  const turns: { turn1?: Json; turn2?: Turn2 } = {};
  let rig: Rig | undefined;
  const live = (): Rig => {
    if (!rig) throw new Error('Headroom rig was not started');
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
    // Snapshot first: nothing in this run may change ~/.headroom, so the baseline is taken before any process starts.
    const homeDir = join(homedir(), '.headroom');
    const homeBefore = await snapshotTree(homeDir);
    await prepare(E2E_BASE);
    const base = await mkdtemp(resolve(E2E_BASE, 'headroom-'));
    cleanups.push(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
    try {
      const files: Files = {
        jevLog: join(base, 'jev.log'), headroomLog: join(base, 'headroom.log'),
        requestsLog: join(base, 'headroom-requests.jsonl'), mockJevLog: join(base, 'mock-jev.log'),
        workspace: join(base, 'hr-workspace'),
      };
      await mkdir(files.workspace, { recursive: true });
      const startMs: Record<string, number> = {};

      const mock = await startMockAnthropic();
      cleanups.push(() => mock.close());
      const mockJevPort = await freeTcpPort(), jevPort = await freeTcpPort(), headroomPort = await freeTcpPort();

      const mockJevLog = await openLog(files.mockJevLog);
      const mockJevStarted = Date.now();
      const mockJev = spawn(process.execPath, [resolve(root, 'upstream/jev-gateway/scripts/mock-jev.mjs')], {
        cwd: root, shell: false, windowsHide: true, stdio: ['ignore', mockJevLog.fd, mockJevLog.fd],
        env: { ...baseEnv(), MOCK_JEV_PORT: String(mockJevPort), MOCK_JEV_SCRIPT: `${TOOL},no_tool_needed`, MOCK_JEV_DUMP_DIR: join(base, 'mock-jev-dump') },
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
          ...baseEnv(), HOST: '127.0.0.1', PORT: String(jevPort), JEV_CLIENT: 'claude',
          UPSTREAM_BASE_URL: `http://127.0.0.1:${mock.port}/v1`, JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: JEV_KEY,
          TYPESAFE_BASE_URL: `http://127.0.0.1:${mockJevPort}`, JEV_LOG_FILE: files.jevLog,
        },
      });
      jev.on('error', () => undefined);
      cleanups.push(() => stopProcess(jev));
      await waitFor('Jev gateway', jev, async () => (await httpStatus(`http://127.0.0.1:${jevPort}/health`)) === 200, 60_000);
      startMs.jev = Date.now() - jevStarted;

      // Headroom is started with the same argv, env and cwd the supervisor will use for the profile.
      const headroomLog = await openLog(files.headroomLog);
      const headroomStarted = Date.now();
      const headroom = spawn(detection.executable, headroomArgs(headroomPort, jevPort, files.requestsLog), {
        cwd: files.workspace, env: headroomEnv(baseEnv(), files.workspace), shell: false, windowsHide: true,
        stdio: ['ignore', headroomLog.fd, headroomLog.fd],
      });
      headroom.on('error', () => undefined);
      cleanups.push(() => stopProcess(headroom));
      await waitFor('Headroom', headroom, async () => (await httpStatus(`http://127.0.0.1:${headroomPort}/livez`)) === 200, 90_000);
      startMs.headroom = Date.now() - headroomStarted;

      rig = {
        mock, mockJev, jev, headroom, files, homeDir, homeBefore, startMs,
        ports: { mock: mock.port, mockJev: mockJevPort, jev: jevPort, headroom: headroomPort },
      };
      evidence.headroomVersion = detection.version;
    } catch (error) {
      await runCleanups().catch(cleanupError => process.stderr.write(`headroom e2e cleanup failed: ${String(cleanupError)}\n`));
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

  test('streaming tool call flows through Headroom and Jev', { timeout: 120_000 }, async () => {
    const r = live();
    const sent = requestBody(turn1Messages(), true);
    const reply = await send(r.ports.headroom, sent);
    assert.equal(reply.status, 200, `Headroom answered HTTP ${reply.status}`);
    const events = parseSse(reply.text);
    const names = events.map(event => event.event);
    assert.ok(names.includes('message_start'), 'stream has no message_start');
    assert.ok(events.some(event => event.event === 'content_block_start' && blockOf(event)?.type === 'tool_use' && blockOf(event)?.name === TOOL),
      `stream has no content_block_start for the ${TOOL} tool_use`);
    assert.ok(names.includes('message_stop'), 'stream has no message_stop');
    const calls = r.mock.seen.filter(isMessageCall).length;
    assert.equal(calls, 1, `mock upstream saw ${calls} /v1/messages requests, expected exactly 1`);
    const hinted = await eventually(async () => (await readRouteEntries(r.files.jevLog)).some(entry => entry.mode === 'hint' && entry.tool === TOOL));
    assert.ok(hinted, 'jev.log has no route line with mode "hint" for the tool');
    turns.turn1 = sent;
    evidence.turn1 = { status: reply.status, durationMs: reply.durationMs, sseEvents: names.length, sentBodyBytes: Buffer.byteLength(reply.raw), mockMessageCalls: calls };
    passed.push('streaming tool call flows through Headroom and Jev');
  });

  test('tool result is compressed losslessly with no retrieval tool', { timeout: 120_000 }, async () => {
    const r = live();
    const before = r.mock.seen.filter(isMessageCall).length;
    const sent = requestBody(turn2Messages(), true);
    const reply = await send(r.ports.headroom, sent);
    assert.equal(reply.status, 200, `Headroom answered HTTP ${reply.status}`);
    assert.equal(textOfStream(reply.text), 'E2E-DONE', 'turn 2 must end with the mock text reply');
    const forwarded = r.mock.seen.filter(isMessageCall).slice(before);
    assert.equal(forwarded.length, 1, `mock saw ${forwarded.length} forwarded requests for turn 2, expected 1`);
    const turn2 = forwarded[0];
    assert.ok(turn2, 'forwarded turn 2 request is missing');
    const resultText = toolResultText(turn2.body);
    assert.equal(occurrences(resultText, 'req-1'), LOG_COUNT, 'every request_id must survive compression');
    assert.equal(occurrences(resultText, 'ERROR'), 3, 'every ERROR line must survive compression');
    assert.ok(resultText.length < LOGS.length, `tool result was not compressed (${resultText.length} >= ${LOGS.length} bytes)`);
    const names = list(turn2.body.tools).map(tool => tool.name);
    assert.ok(names.includes(TOOL), `the offered ${TOOL} tool must still be forwarded`);
    assert.equal(names.includes('headroom_retrieve'), false, 'Headroom retrieval tool must not be injected into the forwarded body');
    assert.equal(turn2.raw.includes('hash='), false, 'forwarded body must not carry hash= markers');
    assert.equal(turn2.raw.includes('<<ccr'), false, 'forwarded body must not carry <<ccr markers');
    turns.turn2 = { sent, raw: reply.raw, forwarded: turn2 };
    evidence.turn2 = {
      status: reply.status, durationMs: reply.durationMs, sentToolResultBytes: LOGS.length,
      forwardedToolResultBytes: Buffer.byteLength(resultText), requestIdOccurrences: occurrences(resultText, 'req-1'),
      errorOccurrences: occurrences(resultText, 'ERROR'), sentBodyBytes: Buffer.byteLength(reply.raw),
      forwardedBodyBytes: Buffer.byteLength(turn2.raw), retrievalTool: false,
    };
    passed.push('tool result is compressed losslessly with no retrieval tool');
  });

  test('earlier turns stay byte-identical for prefix caching', { timeout: 60_000 }, () => {
    assert.ok(turns.turn1 && turns.turn2, 'turns 1 and 2 must run first');
    const { sent, raw, forwarded } = turns.turn2;
    assert.equal(JSON.stringify(forwarded.body.system), JSON.stringify(sent.system), 'system block changed in the forwarded turn 2');
    const sentTurn1 = list(turns.turn1.messages), forwardedMessages = list(forwarded.body.messages);
    assert.ok(sentTurn1.length > 0, 'turn 1 must carry messages');
    sentTurn1.forEach((message, i) => {
      assert.equal(JSON.stringify(forwardedMessages[i]), JSON.stringify(message), `turn 1 message ${i} changed in the forwarded turn 2`);
    });
    const sentCache = countCacheControl(raw), forwardedCache = countCacheControl(forwarded.raw);
    assert.ok(sentCache > 0, 'the fixture must carry cache breakpoints');
    assert.equal(forwardedCache, sentCache, 'cache_control markers must be neither added nor removed');
    evidence.prefixCache = { systemIdentical: true, turn1MessagesIdentical: sentTurn1.length, cacheControlSent: sentCache, cacheControlForwarded: forwardedCache };
    passed.push('earlier turns stay byte-identical for prefix caching');
  });

  test('client credentials pass through unchanged and nothing leaks into logs', { timeout: 120_000 }, async () => {
    const r = live();
    assert.ok(r.mock.seen.length > 0, 'mock upstream saw no traffic');
    for (const record of r.mock.seen) {
      assert.equal(record.headers.authorization, CLIENT_BEARER, `forwarded ${record.path} carried a different authorization header`);
      assert.equal(Object.keys(record.headers).some(name => name.startsWith('x-headroom-')), false, `forwarded ${record.path} carried an x-headroom-* header`);
    }
    const headroomLog = await readFile(r.files.headroomLog, 'utf8');
    const requestsLog = await readFile(r.files.requestsLog, 'utf8');
    for (const [name, text] of [['headroom.log', headroomLog], ['headroom-requests.jsonl', requestsLog]] as const) {
      assert.equal(text.includes(CANARY), false, `${name} contains the prompt canary`);
      assert.equal(text.includes(CLIENT_TOKEN_PREFIX), false, `${name} contains the client token`);
    }
    const upstreamCalls = r.mock.seen.filter(isMessageCall).length;
    let routeLines = -1;
    await eventually(async () => {
      routeLines = (await readRouteEntries(r.files.jevLog)).length;
      return routeLines === upstreamCalls;
    });
    assert.equal(routeLines, upstreamCalls, `jev.log has ${routeLines} route lines but the mock saw ${upstreamCalls} /v1/messages requests`);
    evidence.credentials = {
      forwardedRequests: r.mock.seen.length, authorizationMatches: r.mock.seen.length, headroomHeadersForwarded: 0,
      headroomLogBytes: Buffer.byteLength(headroomLog), requestsLogBytes: Buffer.byteLength(requestsLog),
      mockMessageCalls: upstreamCalls, jevRouteLines: routeLines,
    };
    passed.push('client credentials pass through unchanged and nothing leaks into logs');
  });

  test('non-streaming request works', { timeout: 120_000 }, async () => {
    const r = live();
    const reply = await send(r.ports.headroom, requestBody(turn1Messages(), false));
    assert.equal(reply.status, 200, `Headroom answered HTTP ${reply.status}`);
    const message = asJson(reply.text);
    assert.equal(message.type, 'message', 'non-streaming reply must be an Anthropic message');
    const kinds = list(message.content).map(block => block.type);
    assert.ok(kinds.some(kind => kind === 'text' || kind === 'tool_use'), `non-streaming reply has no text or tool_use block: ${JSON.stringify(kinds)}`);
    evidence.nonStreaming = { status: reply.status, durationMs: reply.durationMs, blockKinds: kinds };
    passed.push('non-streaming request works');
  });

  test('state stays in the profile workspace', { timeout: 60_000 }, async () => {
    const r = live();
    const entries = await readdir(r.files.workspace, { recursive: true });
    assert.ok(entries.length > 0, 'profile workspace is empty after traffic');
    assert.deepEqual(await snapshotTree(r.homeDir), r.homeBefore, '~/.headroom changed during the run');
    evidence.workspace = { entries: entries.length, homeHeadroomUnchanged: true };
    passed.push('state stays in the profile workspace');
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
