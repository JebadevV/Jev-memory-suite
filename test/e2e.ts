import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configSchema, json, prepare, profileDir, root, type Config } from '../src/config.js';
import { init, start, stop, running, control } from '../src/lifecycle.js';
import { atomicJson, baseEnv, sleep, token } from '../src/local.js';
import { Mcp } from '../src/mcp.js';
import { nativeHook } from '../src/hook.js';
import { planLaunch, finalizeAgySession } from '../src/launch.js';

// Real processes end to end: supervisor, memory engine, gateway, native hook, mock Jev and a mock upstream.
type Mode = 'gateway' | 'memory' | 'both' | 'disabled';
type ServiceState = { phase: string; services: Record<string, string> };
type Evidence = Record<string, unknown>;
interface Ports { control: number; memory: number; gateway: number }
interface Recorded { path: string | undefined; authorization: string | undefined; body: unknown }
interface Upstream { url: string; seen: Recorded[]; close: () => Promise<void> }
interface GatewayRig { upstream: Upstream; jev: ChildProcess; jevUrl: string; dumpDir: string; close: () => Promise<void> }

const PORTS: Record<Mode, Ports> = {
  gateway: { control: 19511, memory: 19512, gateway: 19513 },
  memory: { control: 19521, memory: 19522, gateway: 19523 },
  both: { control: 19531, memory: 19532, gateway: 19533 },
  disabled: { control: 19541, memory: 19542, gateway: 19543 }
};
const UPSTREAM_KEY = 'synthetic-upstream-key', JEV_KEY = 'synthetic-jev-key';
const TOOL_NAME = 'get_synthetic_weather';
const CHAT_REQUEST = {
  model: 'synthetic-model',
  messages: [{ role: 'user', content: 'What is the weather in Lisbon?' }],
  tools: [{ type: 'function', function: { name: TOOL_NAME, description: 'Returns synthetic weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }]
};
const E2E_DIR = resolve(root, '.local/e2e'), EVIDENCE_DIR = resolve(root, '.local/evidence');
const FORBIDDEN_IN_EVIDENCE = [UPSTREAM_KEY, JEV_KEY];

const errorCode = (e: unknown): unknown => (e as { cause?: { code?: unknown } }).cause?.code;
const mentions = (value: unknown, needle: string): boolean => JSON.stringify(value).includes(needle);

async function refuses(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000), redirect: 'error' }); return false; }
  catch (e) { return errorCode(e) === 'ECONNREFUSED'; }
}
// Polls a condition; a read that fails is retried until the deadline, and the final assertion reports the miss.
async function eventually(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await check()) return true; } catch { /* Not visible yet. */ }
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}
async function freeTcpPort(): Promise<number> {
  const server = netServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(r => server.close(() => r()));
  return port;
}
function readText(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (b: Buffer) => chunks.push(b));
    req.once('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.once('error', fail);
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise(r => { server.close(() => r()); server.closeAllConnections(); });
}
function restoreVar(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
function setGatewayKeys(): () => void {
  const saved = { up: process.env.JMS_UPSTREAM_KEY, jev: process.env.JMS_JEV_KEY };
  process.env.JMS_UPSTREAM_KEY = UPSTREAM_KEY; process.env.JMS_JEV_KEY = JEV_KEY;
  return () => { restoreVar('JMS_UPSTREAM_KEY', saved.up); restoreVar('JMS_JEV_KEY', saved.jev); };
}

// Upstream stand-in: records every chat completion it receives and answers with a valid reply.
async function startUpstream(): Promise<Upstream> {
  const seen: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const text = await readText(req);
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let body: unknown;
    try { body = JSON.parse(text) as unknown; } catch { body = text; }
    seen.push({ path: req.url, authorization: req.headers.authorization, body });
    const model = typeof body === 'object' && body !== null && 'model' in body ? String(body.model) : 'synthetic-model';
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      id: 'chatcmpl-synthetic', object: 'chat.completion', created: 0, model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic upstream reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, seen, close: () => closeServer(server) };
}

function startMockJev(port: number, dumpDir: string): Promise<ChildProcess> {
  const script = resolve(root, 'upstream/jev-gateway/scripts/mock-jev.mjs');
  const env = { ...baseEnv(), MOCK_JEV_PORT: String(port), MOCK_JEV_SCRIPT: TOOL_NAME, MOCK_JEV_DUMP_DIR: dumpDir };
  const child = spawn(process.execPath, [script], { cwd: root, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  return new Promise<ChildProcess>((ok, fail) => {
    let out = '';
    const timer = setTimeout(() => fail(new Error('mock-jev did not start')), 20_000);
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      if (out.includes('mock-jev on')) { clearTimeout(timer); ok(child); }
    });
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`mock-jev exited ${code}`)); });
  });
}
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(r => child.once('exit', () => r()));
  child.kill();
  await Promise.race([exited, sleep(5000)]);
}
async function startGatewayRig(): Promise<GatewayRig> {
  await prepare(E2E_DIR);
  const upstream = await startUpstream();
  const dumpDir = await mkdtemp(resolve(E2E_DIR, 'jev-dump-'));
  const jevPort = await freeTcpPort();
  let jev: ChildProcess;
  try { jev = await startMockJev(jevPort, dumpDir); }
  catch (e) { await upstream.close(); await rm(dumpDir, { recursive: true, force: true }); throw e; }
  return {
    upstream, jev, dumpDir, jevUrl: `http://127.0.0.1:${jevPort}/v1/systemone`,
    close: async () => {
      await stopChild(jev); await upstream.close();
      await rm(dumpDir, { recursive: true, force: true });
    }
  };
}

// Creates a fresh profile with its own distinct ports; the suite.json is rewritten through the schema.
// projectRoot is optional: only a test that plans a launch needs an external root (the hook fixtures stay under .local/e2e).
async function createProfile(mode: Mode, flags: { memory: boolean; gateway: boolean }, rig?: GatewayRig, projectRoot?: string): Promise<{ name: string; config: Config }> {
  const name = `e2e-${mode}-${Date.now()}`, ports = PORTS[mode];
  await init(name);
  try {
    const path = resolve(profileDir(name), 'suite.json');
    const base = configSchema.parse(await json(path));
    const routing = rig ? { upstreamUrl: rig.upstream.url, jevUrl: rig.jevUrl, allowedHosts: ['127.0.0.1'] } : {};
    const config = configSchema.parse({
      ...base, controlPort: ports.control, ...(projectRoot === undefined ? {} : { projectRoot }),
      dashboard: { port: await freeTcpPort() },
      memory: { enabled: flags.memory, port: ports.memory },
      gateway: { ...base.gateway, ...routing, enabled: flags.gateway, port: ports.gateway }
    });
    await atomicJson(path, config);
    return { name, config };
  } catch (error) {
    await rm(profileDir(name), { recursive: true, force: true, maxRetries: 5 }); // Created here, so removed here on failure.
    throw error;
  }
}
// Stops the profile this test started, then deletes the profile folder it created. A profile that will not stop is kept.
async function removeProfile(name: string): Promise<void> {
  await stop(name);
  await rm(profileDir(name), { recursive: true, force: true, maxRetries: 5 });
}
async function startProfile(name: string): Promise<ServiceState> {
  return await start(name) as ServiceState;
}
async function writeEvidence(mode: Mode, evidence: Evidence, secret: string): Promise<void> {
  await prepare(EVIDENCE_DIR);
  const text = JSON.stringify(evidence, null, 2);
  assert.equal(text.includes(secret), false, 'evidence must not contain the profile token');
  for (const forbidden of FORBIDDEN_IN_EVIDENCE) assert.equal(text.includes(forbidden), false, 'evidence must not contain keys');
  await atomicJson(resolve(EVIDENCE_DIR, `e2e-${mode}.json`), evidence);
}

function postChat(port: number, key?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(CHAT_REQUEST),
    signal: AbortSignal.timeout(60_000), redirect: 'error' });
}
// Authenticated routed request: the router must forward with the upstream key, never the router token.
async function assertGatewayRoute(name: string, c: Config, rig: GatewayRig, evidence: Evidence): Promise<void> {
  const key = await token(profileDir(name), 'router-token'), controlKey = await token(profileDir(name));
  const beforeUpstream = rig.upstream.seen.length;
  const noKey = await postChat(c.gateway.port);
  await noKey.text();
  assert.equal(noKey.status, 401, 'gateway must reject a request without the router key');
  const withControl = await postChat(c.gateway.port, controlKey);
  await withControl.text();
  assert.equal(withControl.status, 401, 'gateway must reject the supervisor control token');
  const started = Date.now();
  const routed = await postChat(c.gateway.port, key);
  await routed.text();
  assert.equal(routed.status, 200, `routed request returned HTTP ${routed.status}`);
  const mode = routed.headers.get('x-jev-gateway-mode');
  assert.ok(mode, 'x-jev-gateway-mode header missing');
  const calls = rig.upstream.seen.slice(beforeUpstream);
  assert.ok(calls.length >= 1, 'mock upstream did not receive the routed request');
  assert.ok(calls.every(r => r.path === '/v1/chat/completions' && r.authorization === `Bearer ${UPSTREAM_KEY}`),
    'upstream must receive the upstream key only');
  assert.equal(rig.upstream.seen.some(r => r.authorization?.includes(key)), false, 'router token leaked upstream');
  const jevRequests = (await readdir(rig.dumpDir)).length;
  assert.ok(jevRequests >= 1, 'mock-jev received no request');
  evidence.gatewayRoute = {
    noKeyStatus: noKey.status, controlTokenStatus: withControl.status, routedStatus: routed.status, gatewayMode: mode,
    gatewayTool: routed.headers.get('x-jev-gateway-tool'), upstreamCalls: calls.length,
    upstreamKeyOnly: true, jevRequests, routedMs: Date.now() - started
  };
}
async function assertGatewayAuth(name: string, c: Config): Promise<number> {
  const status = await fetch(`http://127.0.0.1:${c.controlPort}/status`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  await status.text();
  assert.equal(status.status, 401, 'supervisor /status must require the control token');
  const routerKey = await token(profileDir(name), 'router-token');
  const withRouter = await fetch(`http://127.0.0.1:${c.controlPort}/status`, { headers: { authorization: `Bearer ${routerKey}` },
    signal: AbortSignal.timeout(2000), redirect: 'error' });
  await withRouter.text();
  assert.equal(withRouter.status, 401, 'supervisor /status must reject the router token');
  return status.status;
}

// Synthetic page round trip: write, search by unique marker, then read the exact path back.
async function syntheticPage(mcp: Mcp, c: Config, stamp: string): Promise<{ queryFound: boolean; readFound: boolean }> {
  const marker = `SYNTH${stamp}`, path = `e2e/synthetic-${stamp}`, scope = { workspace: c.workspace, project: c.project };
  await mcp.call('memory_write_page', { ...scope, path, title: `Synthetic ${stamp}`,
    body: `# Synthetic ${stamp}\n\n${marker} synthetic page body.\n`, tags: [] });
  const queryFound = await eventually(async () => mentions(await mcp.call('memory_query', { ...scope, query: marker }), marker));
  const readFound = await eventually(async () => mentions(await mcp.call('memory_read_page', { ...scope, path }), marker));
  return { queryFound, readFound };
}
async function assertMemoryTools(name: string, c: Config, stamp: string, evidence: Evidence): Promise<Mcp> {
  const mcp = await Mcp.connect(name);
  const tools = await mcp.tools();
  assert.ok(tools.includes('memory_status') && tools.includes('memory_query'), 'required memory tools missing');
  const scope = { workspace: c.workspace, project: c.project };
  const status = await mcp.call('memory_status', scope);
  assert.ok(mentions(status, c.workspace) && mentions(status, c.project), 'memory_status must report the profile scope');
  const page = await syntheticPage(mcp, c, stamp);
  assert.ok(page.queryFound, 'memory_query did not find the synthetic page');
  assert.ok(page.readFound, 'memory_read_page did not return the synthetic body');
  evidence.memory = { toolCount: tools.length, statusScopeReported: true, pageQueryFound: page.queryFound, pageReadFound: page.readFound };
  return mcp;
}
async function unauthenticatedMemory(c: Config): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${c.memory.port}/mcp`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  await res.text();
  assert.equal(res.status, 401, 'memory /mcp must reject requests without the bearer');
  return res.status;
}

// Runs the real hook entry point with the same argv and stdin contract the client uses.
function runHook(name: string, cwd: string, event: string, payload: Record<string, unknown>): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [resolve(root, 'dist/src/hook.js'), name, 'claude-code', event],
      { cwd, env: baseEnv(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    child.once('error', fail);
    child.once('close', code => code === 0 ? ok() : fail(new Error(`hook ${event} exit ${code}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}
async function createFixture(c: Config): Promise<string> {
  await prepare(E2E_DIR);
  const dir = await mkdtemp(resolve(E2E_DIR, 'fixture-'));
  await writeFile(resolve(dir, '.ai-memory.toml'), `workspace = "${c.workspace}"\nproject = "${c.project}"\n`, { flag: 'wx' });
  return dir;
}
async function captureHookLifecycle(name: string, fixture: string, sessionId: string, marker: string): Promise<void> {
  const base = { session_id: sessionId, cwd: fixture, model: 'synthetic-model' };
  await runHook(name, fixture, 'session-start', { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  await runHook(name, fixture, 'user-prompt', { ...base, hook_event_name: 'UserPromptSubmit', prompt: `synthetic capture token ${marker}` });
  await runHook(name, fixture, 'post-tool-use', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read',
    tool_input: { file_path: 'synthetic.txt' }, tool_response: { content: 'ok' } });
  await runHook(name, fixture, 'session-end', { ...base, hook_event_name: 'SessionEnd', reason: 'other' });
}

test('gateway only: supervisor and gateway auth, routed request, memory disabled', { timeout: 240_000 }, async () => {
  const restoreEnv = setGatewayKeys();
  const rig = await startGatewayRig();
  let name: string | undefined;
  try {
    const profile = await createProfile('gateway', { memory: false, gateway: true }, rig);
    name = profile.name;
    const c = profile.config, key = await token(profileDir(name)), evidence: Evidence = { mode: 'gateway', ports: PORTS.gateway };
    const startAt = Date.now();
    const state = await startProfile(name);
    evidence.startMs = Date.now() - startAt;
    assert.equal(state.phase, 'ready');
    assert.deepEqual(state.services, { gateway: 'ready' });
    evidence.services = state.services;
    evidence.supervisorStatusNoTokenStatus = await assertGatewayAuth(name, c);
    await assertGatewayRoute(name, c, rig, evidence);
    assert.equal(await refuses(c.memory.port), true, 'memory port must refuse when memory is disabled');
    await assert.rejects(Mcp.connect(name), /Memory engine disabled/);
    evidence.memoryPortRefused = true; evidence.mcpConnectRejected = true;
    await writeEvidence('gateway', evidence, key);
  } finally {
    if (name) await removeProfile(name);
    await rig.close();
    restoreEnv();
  }
});

test('memory only: MCP auth, tools, synthetic page, hook capture and persistence', { timeout: 240_000 }, async () => {
  const stamp = String(Date.now()), marker = `CAPTURE${stamp}`;
  // The memory engine accepts only UUID session ids for observation reads (invalid session id otherwise).
  const sessionId = randomUUID();
  const { name, config: c } = await createProfile('memory', { memory: true, gateway: false });
  const key = await token(profileDir(name));
  const evidence: Evidence = { mode: 'memory', ports: PORTS.memory };
  let fixture: string | undefined;
  try {
    const startAt = Date.now();
    const state = await startProfile(name);
    evidence.startMs = Date.now() - startAt;
    assert.equal(state.phase, 'ready');
    assert.deepEqual(state.services, { memory: 'ready', dashboard: 'ready' });
    evidence.services = state.services;
    evidence.unauthenticatedMcpStatus = await unauthenticatedMemory(c);
    await assertMemoryTools(name, c, stamp, evidence);
    fixture = await createFixture(c);
    const hookStart = Date.now();
    await captureHookLifecycle(name, fixture, sessionId, marker);
    const mcp = await Mcp.connect(name);
    const captured = await eventually(async () => mentions(
      await mcp.call('memory_read_session_observations', { workspace: c.workspace, project: c.project, session_id: sessionId }), marker));
    evidence.capture = { found: captured, hookMs: Date.now() - hookStart };
    assert.ok(captured, 'captured prompt observation not found within 30s');
    await stop(name);
    assert.equal(await running(name), false, 'profile must be stopped before restart');
    evidence.stoppedAfterCapture = true;
    await startProfile(name);
    const reconnected = await Mcp.connect(name);
    const persistedPage = await eventually(async () => mentions(
      await reconnected.call('memory_query', { workspace: c.workspace, project: c.project, query: `SYNTH${stamp}` }), `SYNTH${stamp}`));
    const persistedCapture = await eventually(async () => mentions(
      await reconnected.call('memory_read_session_observations', { workspace: c.workspace, project: c.project, session_id: sessionId }), marker));
    evidence.persisted = { page: persistedPage, capture: persistedCapture };
    assert.ok(persistedPage && persistedCapture, 'synthetic page or capture did not persist across restart');
    assert.equal(await refuses(c.gateway.port), true, 'gateway port must refuse when gateway is disabled');
    evidence.gatewayPortRefused = true;
    await writeEvidence('memory', evidence, key);
  } finally {
    await removeProfile(name);
    if (fixture) await rm(fixture, { recursive: true, force: true });
  }
});

// Writes go through JSON-RPC: Mcp.call allows only read tools, and a handoff is created by a write.
async function mcpTool(mcp: Mcp, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await mcp.rpc('tools/call', { name, arguments: args }) as { isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined;
  if (!result || result.isError) throw new Error(`${name} returned an error`);
  const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
  try { return JSON.parse(text) as unknown; } catch { return text; }
}
// Harness marker stored for each agy user turn (AGY_USER_TURN_PROMPT in src/hook.ts), and the old English text it replaced.
const AGY_TURN_MARKER = '<agy-user-turn/>';
const AGY_LEAK_NEEDLES = ['agy-user-turn', 'Antigravity user turn'];
function agyPayload(dir: string, conversation: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { conversationId: conversation, workspacePaths: [dir], artifactDirectoryPath: join(homedir(), '.gemini', 'antigravity-cli', 'brain', conversation), ...extra };
}
// How many user-prompt observations of one conversation carry the agy turn marker as their body or title.
async function agyTurnMarkers(mcp: Mcp, c: Config, sessionId: string): Promise<number> {
  const page = await mcpTool(mcp, 'memory_read_session_observations', { workspace: c.workspace, project: c.project, session_id: sessionId, kinds: ['user-prompt'] }) as { observations?: Array<{ body?: string; title?: string }> };
  return (page.observations ?? []).filter(o => o.body === AGY_TURN_MARKER || o.title === AGY_TURN_MARKER).length;
}
const hasLeak = (value: unknown): boolean => AGY_LEAK_NEEDLES.some(needle => JSON.stringify(value).includes(needle));
// True when any `title` string, at any depth of a result, carries a leak needle.
function titleLeaks(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(titleLeaks);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, v]) => (key === 'title' && typeof v === 'string' && AGY_LEAK_NEEDLES.some(n => v.includes(n))) || titleLeaks(v));
}
// Antigravity has no prompt hook; a tool-less session must still count as substantive, so its handoff is claimed once and not re-opened at session end.
test('memory only: a tool-less Antigravity session consumes its handoff exactly once', { timeout: 240_000 }, async () => {
  const stamp = String(Date.now()), marker = `AGYHANDOFF${stamp}`, controlMarker = `CONTROLHANDOFF${stamp}`;
  const { name, config: c } = await createProfile('memory', { memory: true, gateway: false });
  const scope = { workspace: c.workspace, project: c.project }, otherProject = `${c.project}-control`;
  let fixture: string | undefined;
  try {
    const state = await startProfile(name);
    assert.equal(state.phase, 'ready');
    const dir = await createFixture(c);
    fixture = dir;
    const mcp = await Mcp.connect(name);
    await mcpTool(mcp, 'memory_handoff_begin', { ...scope, summary: `E2E tool-less handoff ${marker}.`, open_questions: [], next_steps: ['state the marker'], files_touched: [], shared: true });
    // Control: a handoff in another project of the same workspace must stay open and must not reach this project.
    await mcpTool(mcp, 'memory_handoff_begin', { workspace: c.workspace, project: otherProject, summary: `E2E control handoff ${controlMarker}.`, open_questions: [], next_steps: ['none'], files_touched: [], shared: true });
    const openIn = async (project: string): Promise<string> => JSON.stringify(await mcpTool(mcp, 'memory_handoff_list', { workspace: c.workspace, project }));
    // Session A: a user turn with no tool calls. The session-start claims the handoff.
    const sessionA = randomUUID();
    const startA = await nativeHook(name, 'antigravity-cli', 'session-start', agyPayload(dir, sessionA, { invocationNum: 0 }));
    assert.ok(startA.includes(marker), 'session A must receive its handoff');
    // (c) A second user turn of the same conversation, before it ends: nothing is injected.
    const startA2 = await nativeHook(name, 'antigravity-cli', 'session-start', agyPayload(dir, sessionA, { invocationNum: 0 }));
    assert.equal(JSON.parse(startA2).injectSteps, undefined, 'a second turn of session A must inject no handoff');
    assert.equal(startA2.includes(marker), false, 'a second turn of session A must not re-inject the claimed handoff');
    await nativeHook(name, 'antigravity-cli', 'stop', agyPayload(dir, sessionA, { fullyIdle: true }));
    await finalizeAgySession(name, c, sessionA, dir);
    const claimedOnce = await eventually(async () => !(await openIn(c.project)).includes(marker));
    assert.ok(claimedOnce, 'the claimed handoff was re-opened by a tool-less session end');
    assert.ok((await openIn(otherProject)).includes(controlMarker), 'a handoff in another project must stay open');
    // (b) Whatever the engine wrote for session A (the auto handoff, if any) must not carry the marker text in any open handoff, nor a page title.
    assert.equal(hasLeak(JSON.parse(await openIn(c.project))), false, 'an open handoff for session A must not contain the agy turn marker text');
    const recent = await mcpTool(mcp, 'memory_recent', { ...scope, limit: 50 });
    assert.equal(titleLeaks(recent), false, 'no recent page may use the agy turn marker as its title');
    // Session B: a new user turn must not replay the handoff of session A, nor receive any marker text.
    const startB = await nativeHook(name, 'antigravity-cli', 'session-start', agyPayload(dir, randomUUID(), { invocationNum: 0 }));
    assert.equal(startB.includes(marker), false, 'session B must not replay the handoff of session A');
    assert.equal(startB.includes(controlMarker), false, 'session B must not receive a handoff from another project');
    assert.equal(hasLeak(startB), false, 'session B must not receive the agy turn marker text');
    // (a) Hook observations are spooled and drained at session end, so the stored turns are read once A has ended: one marker per user turn (two turns here).
    assert.ok(await eventually(async () => await agyTurnMarkers(mcp, c, sessionA) === 2), 'session A must store one agy turn marker per user turn');
  } finally {
    await removeProfile(name);
    if (fixture) await rm(fixture, { recursive: true, force: true });
  }
});

// Two agy session-starts race for one open handoff: the claim must let exactly one of them inject it.
test('memory only: concurrent Antigravity session-starts claim one open handoff once', { timeout: 240_000 }, async () => {
  const stamp = String(Date.now()), marker = `AGYRACE${stamp}`;
  const { name, config: c } = await createProfile('memory', { memory: true, gateway: false });
  const scope = { workspace: c.workspace, project: c.project };
  let fixture: string | undefined;
  try {
    const state = await startProfile(name);
    assert.equal(state.phase, 'ready');
    const dir = await createFixture(c);
    fixture = dir;
    const mcp = await Mcp.connect(name);
    await mcpTool(mcp, 'memory_handoff_begin', { ...scope, summary: `E2E race handoff ${marker}.`, open_questions: [], next_steps: ['none'], files_touched: [], shared: true });
    const starts = await Promise.all([randomUUID(), randomUUID()].map(conversation =>
      nativeHook(name, 'antigravity-cli', 'session-start', agyPayload(dir, conversation, { invocationNum: 0 }))));
    assert.equal(starts.filter(out => out.includes(marker)).length, 1, 'exactly one concurrent session must receive the single open handoff');
    assert.equal(JSON.stringify(await mcpTool(mcp, 'memory_handoff_list', scope)).includes(marker), false, 'the claimed handoff must not stay open');
  } finally {
    await removeProfile(name);
    if (fixture) await rm(fixture, { recursive: true, force: true });
  }
});

test('gateway and memory: routed request plus MCP page round trip', { timeout: 240_000 }, async () => {
  const restoreEnv = setGatewayKeys();
  const rig = await startGatewayRig();
  const stamp = String(Date.now());
  let name: string | undefined;
  try {
    const profile = await createProfile('both', { memory: true, gateway: true }, rig);
    name = profile.name;
    const c = profile.config, key = await token(profileDir(name)), evidence: Evidence = { mode: 'both', ports: PORTS.both };
    const startAt = Date.now();
    const state = await startProfile(name);
    evidence.startMs = Date.now() - startAt;
    assert.equal(state.phase, 'ready');
    assert.deepEqual(state.services, { memory: 'ready', dashboard: 'ready', gateway: 'ready' });
    evidence.services = state.services;
    await assertGatewayRoute(name, c, rig, evidence);
    await assertMemoryTools(name, c, stamp, evidence);
    await writeEvidence('both', evidence, key);
  } finally {
    if (name) await removeProfile(name);
    await rig.close();
    restoreEnv();
  }
});

test('both disabled: ready with no services, closed ports, and no launch flags', { timeout: 240_000 }, async t => {
  // The launch plan reads the cwd's registration, so this profile and its cwd are both outside the repository.
  const launchRoot = await realpath(await mkdtemp(join(tmpdir(), 'e2e-launch-')));
  t.after(() => rm(launchRoot, { recursive: true, force: true, maxRetries: 5 }));
  const { name, config: c } = await createProfile('disabled', { memory: false, gateway: false }, undefined, launchRoot);
  const key = await token(profileDir(name));
  const evidence: Evidence = { mode: 'disabled', ports: PORTS.disabled };
  try {
    const state = await startProfile(name);
    assert.equal(state.phase, 'ready');
    assert.deepEqual(state.services, {});
    evidence.services = state.services;
    assert.equal(await refuses(c.memory.port), true, 'memory port must refuse when disabled');
    assert.equal(await refuses(c.gateway.port), true, 'gateway port must refuse when disabled');
    await assert.rejects(Mcp.connect(name), /Memory engine disabled/);
    const claude = await planLaunch('claude', name, launchRoot), codex = await planLaunch('codex', name, launchRoot);
    assert.deepEqual(claude.args, []);
    assert.deepEqual(codex.args, []);
    evidence.portsRefused = true; evidence.mcpConnectRejected = true;
    evidence.launchArgs = { claude: claude.args.length, codex: codex.args.length };
    assert.equal((await control(name, 'status')).phase, 'ready');
    await writeEvidence('disabled', evidence, key);
  } finally {
    await stop(name);
    assert.equal(await running(name), false, 'profile must stop cleanly');
    await rm(profileDir(name), { recursive: true, force: true, maxRetries: 5 });
  }
});
