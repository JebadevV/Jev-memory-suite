import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  aggregatorFor, gatewayStatus, gatewaySnapshot, parsePort, probeGateway, upstreamGateways,
  type GatewayProbe, type UpstreamClient, type UpstreamGateway,
} from '../src/gateways.js';
import { summarizeByModel, summarizeRouteEvents, type JevPrice, type LlmPrice } from '../src/gateway-metrics.js';
import { compareGroups } from '../src/gateway-views.js';
import { createHistoryReader, type HistoryResult } from '../src/gateway-history.js';
import { configSchema, json, root } from '../src/config.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// Throwaway loopback server on an ephemeral port; the caller closes it.
async function fakeGateway(handler: Handler): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(ok => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

const answer = (body: unknown, status = 200): Handler => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

// An origin with nothing listening: the port was bound and released.
async function refusedOrigin(): Promise<string> {
  const server = createNetServer();
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(ok => server.close(() => ok()));
  return `http://127.0.0.1:${port}`;
}

// Installed-spec fixture: codex has a non-default port, claude carries an invalid spec.
async function specDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-gateways-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'bin', 'clients.mjs'),
    "export const codex = { portEnv: 'JEV_CODEX_PORT', defaultPort: 8791 };\nexport const claude = { portEnv: 'lower', defaultPort: 80 };\n");
  return dir;
}

// Installed-spec fixture with a valid agy spec, so agy is read from the install rather than the fallback.
async function specDirWithAgy(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await specDir(t);
  await writeFile(join(dir, 'bin', 'clients.mjs'),
    "export const codex = { portEnv: 'JEV_CODEX_PORT', defaultPort: 8791 };\nexport const claude = { portEnv: 'lower', defaultPort: 80 };\n"
    + "export const agy = { portEnv: 'JEV_AGY_PORT', defaultPort: 8795 };\n");
  return dir;
}

test('upstream gateways read the installed port specs and fall back per client when a spec is unusable', async t => {
  const dir = await specDir(t);
  const [claude, codex, agy] = await upstreamGateways({}, dir);
  assert.equal(codex?.port, 8791);
  assert.equal(codex?.source, 'installed');
  assert.equal(codex?.origin, 'http://127.0.0.1:8791');
  assert.equal(codex?.dashboardUrl, 'http://localhost:8791/dashboard');
  assert.equal(claude?.port, 8789);
  assert.equal(claude?.portEnv, 'JEV_CLAUDE_PORT');
  assert.equal(claude?.source, 'fallback');
  assert.equal(agy?.client, 'agy');
  assert.equal(agy?.label, 'Antigravity');
  assert.equal(agy?.portEnv, 'JEV_AGY_PORT');
  assert.equal(agy?.port, 8794);
  assert.equal(agy?.source, 'fallback');
});

test('an installed agy spec sets its port, and JEV_AGY_PORT overrides it when usable', async t => {
  const dir = await specDirWithAgy(t);
  const [, , installed] = await upstreamGateways({}, dir);
  assert.equal(installed?.port, 8795);
  assert.equal(installed?.source, 'installed');
  const [, , overridden] = await upstreamGateways({ JEV_AGY_PORT: '18794' }, dir);
  assert.equal(overridden?.port, 18794);
  assert.equal(overridden?.origin, 'http://127.0.0.1:18794');
});

test('a valid env override moves the gateway origin and dashboard to that port', async t => {
  const dir = await specDir(t);
  const [, codex] = await upstreamGateways({ JEV_CODEX_PORT: '18790' }, dir);
  assert.equal(codex?.port, 18790);
  assert.equal(codex?.portValid, true);
  assert.equal(codex?.origin, 'http://127.0.0.1:18790');
  assert.equal(codex?.dashboardUrl, 'http://localhost:18790/dashboard');
});

test('an unusable env override falls back to the spec default and is marked invalid', async t => {
  const dir = await specDir(t);
  for (const raw of ['abc', '80', '70000', '1.5', '', ' 8790', '-1', '0x1F9E']) {
    const [, codex] = await upstreamGateways({ JEV_CODEX_PORT: raw }, dir);
    assert.equal(codex?.port, 8791, raw);
    assert.equal(codex?.portValid, false, raw);
  }
});

test('a missing upstream install falls back to the built-in ports for every client', async t => {
  const dir = await specDir(t);
  const [claude, codex, agy] = await upstreamGateways({}, join(dir, 'missing'));
  assert.equal(claude?.port, 8789);
  assert.equal(codex?.port, 8790);
  assert.equal(codex?.source, 'fallback');
  assert.equal(agy?.port, 8794);
  assert.equal(agy?.source, 'fallback');
});

test('parsePort accepts only decimal digits within 1024-65535', () => {
  assert.equal(parsePort('1024'), 1024);
  assert.equal(parsePort('65535'), 65535);
  assert.equal(parsePort('65536'), undefined);
  assert.equal(parsePort('1023'), undefined);
  assert.equal(parsePort(undefined), undefined);
});

test('probe reports a running gateway with its pid and upstream', async () => {
  const gateway = await fakeGateway(answer({ status: 'ok', pid: 4242, upstream: 'https://api.example.test/v1' }));
  try {
    assert.deepEqual(await probeGateway(gateway.origin), { state: 'running', pid: 4242, upstream: 'https://api.example.test/v1' });
  } finally { await gateway.close(); }
});

test('probe reports a running gateway without pid or upstream when it has a router key', async () => {
  const gateway = await fakeGateway(answer({ status: 'ok', pid: 'not-a-pid' }));
  try {
    assert.deepEqual(await probeGateway(gateway.origin), { state: 'running' });
  } finally { await gateway.close(); }
});

test('probe never returns credentials, query or fragment of the reported upstream', async () => {
  const gateway = await fakeGateway(answer({ status: 'ok', upstream: 'https://user:hunter2@api.example.test/v1?key=abc#frag' }));
  try {
    const probe = await probeGateway(gateway.origin);
    assert.deepEqual(probe, { state: 'running' });
    assert.doesNotMatch(JSON.stringify(probe), /hunter2|abc|frag/);
  } finally { await gateway.close(); }
});

test('probe treats a non-ok status, a wrong status field and a non-JSON body as unavailable', async () => {
  const cases: Handler[] = [
    answer({ status: 'ok' }, 500),
    answer({ status: 'down' }),
    answer(['ok']),
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }).end('<html>not json</html>'); },
  ];
  for (const handler of cases) {
    const gateway = await fakeGateway(handler);
    try {
      assert.deepEqual(await probeGateway(gateway.origin), { state: 'unavailable' });
    } finally { await gateway.close(); }
  }
});

test('probe treats a redirect as unavailable instead of following it', async () => {
  const gateway = await fakeGateway((_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/health' }).end(); });
  try {
    assert.deepEqual(await probeGateway(gateway.origin), { state: 'unavailable' });
  } finally { await gateway.close(); }
});

test('probe gives up on a silent gateway after the timeout', async () => {
  const gateway = await fakeGateway(() => { /* never answers */ });
  try {
    assert.deepEqual(await probeGateway(gateway.origin, 50), { state: 'unavailable' });
  } finally { await gateway.close(); }
});

test('probe reports a port with nothing listening as stopped', async () => {
  assert.deepEqual(await probeGateway(await refusedOrigin()), { state: 'stopped' });
});

test('probe refuses any origin that is not IPv4 loopback without connecting', async () => {
  assert.deepEqual(await probeGateway('http://localhost:9'), { state: 'unavailable' });
  assert.deepEqual(await probeGateway('https://example.com'), { state: 'unavailable' });
});

// Fixture gateway for the status tests. The port is the one the dashboard names; the origin is where the stub listens.
function upstream(client: UpstreamClient, port: number, origin = `http://127.0.0.1:${port}`): UpstreamGateway {
  const label: Record<UpstreamClient, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
  return {
    client, label: label[client], portEnv: `JEV_${client.toUpperCase()}_PORT`, port,
    source: 'installed', portValid: true, origin, dashboardUrl: `http://localhost:${port}/dashboard`,
  };
}

// A gateway's /dashboard/events body. The upstream carries credentials and a query, so it must be dropped; model and provider are plain names.
const eventsBody = (overrides: Record<string, unknown> = {}) => ({
  router: {
    client: 'codex', upstream: 'https://user:sk-live-abc123def456@secret.example/v1?key=abc', jevModel: 'gpt-jev-small', jevProvider: 'typesafe',
    minConfidence: 0.5, routing: true, shadow: false, startedAt: '2026-10-22T09:00:00.000Z', now: '2026-10-22T10:10:00.000Z', recorded: 3,
  },
  events: [
    { seq: 1, time: '2026-10-22T10:00:00.000Z', path: '/v1/responses', model: 'model-alpha', tools: 2, mode: 'forced', reason: 'free text reason', status: 200, durationMs: 100, usage: { input: 10, output: 4, cached: 2, cacheWrite: 0, reasoning: 0 } },
    { seq: 2, time: '2026-10-22T10:05:00.000Z', path: '/v1/responses', tools: 0, mode: 'passthrough', status: 500, durationMs: 300 },
    { seq: 3, time: 'not a date', path: '/x', tools: 0, mode: 'passthrough' },
  ],
  ...overrides,
});

// Stub gateway: /health answers ok, /dashboard/events runs the given handler. Every request is recorded.
async function statusStub(events: Handler): Promise<{ origin: string; seen: IncomingMessage[]; close: () => Promise<void> }> {
  const seen: IncomingMessage[] = [];
  const gateway = await fakeGateway((req, res) => {
    seen.push(req);
    if (req.url?.startsWith('/health')) return answer({ status: 'ok' })(req, res);
    return events(req, res);
  });
  return { origin: gateway.origin, seen, close: gateway.close };
}

const LLM_PRICE: LlmPrice = { inputPerMTok: 1_000_000, cacheReadPerMTok: 0, cacheWritePerMTok: 0, outputPerMTok: 1_000_000, currency: 'USD', source: 'test-llm', verifiedAt: '2026-10-01' };
const JEV_PRICE: JevPrice = { inputPerMTok: 0, outputPerMTok: 0, currency: 'USD', source: 'test-jev', verifiedAt: '2026-10-01' };

// Two models in one log. The second event was requested as model-a but sent as model-b, and billing follows the sent model.
const TWO_MODEL_LOG = [
  { seq: 1, time: '2026-10-22T10:00:00.000Z', model: 'model-a', mode: 'passthrough', usage: { input: 10, output: 4, cached: 0, cacheWrite: 0, reasoning: 0 } },
  { seq: 2, time: '2026-10-22T10:01:00.000Z', model: 'model-a', sentModel: 'model-b', mode: 'forced', usage: { input: 6, output: 2, cached: 0, cacheWrite: 0, reasoning: 0 } },
];

// The history loader a log produces: totals, per-model breakdown and the comparison, as gateway-history builds them.
function historyFrom(logged: unknown[], complete = true): () => Promise<HistoryResult> {
  return async () => ({
    metrics: summarizeRouteEvents(logged), byModel: summarizeByModel(logged), compare: compareGroups(logged), complete, bytesRead: 1,
  });
}

test('gateway status exposes only the router routing state, shadow, confidence, counter and start time', async () => {
  const stub = await statusStub(answer(eventsBody()));
  try {
    const status = await gatewayStatus(upstream('codex', 0, stub.origin));
    assert.equal(status.state, 'running');
    assert.equal(status.metrics, 'ok');
    assert.deepEqual(status.router, {
      routing: true, shadow: false, minConfidence: 0.5, recorded: 3, startedAt: '2026-10-22T09:00:00.000Z',
      upstream: null, jevModel: 'gpt-jev-small', jevProvider: 'typesafe',
    });
    assert.doesNotMatch(JSON.stringify(status), /sk-live|secret\.example|Bearer|key=|free text/);
  } finally { await stub.close(); }
});

test('gateway status rejects the whole router when the client name or a boolean is malformed', async () => {
  const routers: Record<string, unknown>[] = [
    { client: 'bad name', routing: true },
    { client: 'c'.repeat(65), routing: true },
    { client: 'codex', routing: 'yes' },
    { client: 'codex', routing: true, shadow: 'no' },
  ];
  for (const router of routers) {
    const stub = await statusStub(answer({ router, events: [] }));
    try {
      const status = await gatewayStatus(upstream('codex', 0, stub.origin));
      assert.equal(status.metrics, 'unavailable', JSON.stringify(router));
      assert.equal(status.router, null);
    } finally { await stub.close(); }
  }
});

test('gateway status drops invalid optional router fields and defaults shadow to false', async () => {
  const stub = await statusStub(answer({
    router: { client: 'codex', routing: true, minConfidence: 1.5, recorded: -2, startedAt: 'not a date' }, events: [],
  }));
  try {
    const status = await gatewayStatus(upstream('codex', 0, stub.origin));
    assert.deepEqual(status.router, {
      routing: true, shadow: false, minConfidence: null, recorded: 0, startedAt: null, upstream: null, jevModel: null, jevProvider: null,
    });
  } finally { await stub.close(); }
});

test('gateway status keeps the router block only and has no event, window or range fields', async () => {
  const stub = await statusStub(answer(eventsBody()));
  try {
    const status = await gatewayStatus(upstream('codex', 0, stub.origin));
    assert.deepEqual(Object.keys(status).sort(), [
      'billing', 'client', 'cost', 'experiment', 'history', 'historyCompare', 'label', 'metrics', 'models', 'port', 'portValid', 'router', 'state',
    ]);
    assert.deepEqual(status.cost, { history: null });
    assert.deepEqual(status.models, { history: [] });
    assert.equal(status.history, null);
    assert.equal(status.experiment, 'default');
  } finally { await stub.close(); }
});

test('gateway status reports auth-required on 401 and 403 from the events route', async () => {
  for (const code of [401, 403]) {
    const stub = await statusStub(answer({ error: 'unauthorized' }, code));
    try {
      assert.equal((await gatewayStatus(upstream('claude', 0, stub.origin))).metrics, 'auth-required', String(code));
    } finally { await stub.close(); }
  }
});

test('gateway status reports unavailable for malformed JSON and an unexpected event shape', async () => {
  const cases: Handler[] = [
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end('{not json'); },
    answer({ events: [] }),
  ];
  for (const handler of cases) {
    const stub = await statusStub(handler);
    try {
      assert.equal((await gatewayStatus(upstream('codex', 0, stub.origin))).metrics, 'unavailable');
    } finally { await stub.close(); }
  }
});

test('gateway status reports unavailable for a body over the size cap', async () => {
  const huge = JSON.stringify({ ...eventsBody(), padding: 'x'.repeat(3 * 1024 * 1024) });
  const stub = await statusStub((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end(huge); });
  try {
    assert.equal((await gatewayStatus(upstream('codex', 0, stub.origin))).metrics, 'unavailable');
  } finally { await stub.close(); }
});

test('gateway status reports unavailable when the events route is slower than the timeout', async () => {
  const stub = await statusStub(() => { /* never answers */ });
  try {
    assert.equal((await gatewayStatus(upstream('codex', 0, stub.origin), { timeoutMs: 50 })).metrics, 'unavailable');
  } finally { await stub.close(); }
});

test('gateway status reports unavailable when the events route redirects', async () => {
  const stub = await statusStub((_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/x' }).end(); });
  try {
    assert.equal((await gatewayStatus(upstream('codex', 0, stub.origin))).metrics, 'unavailable');
  } finally { await stub.close(); }
});

test('gateway status reports offline for a refused port and never requests events', async () => {
  const stub = await statusStub(answer(eventsBody()));
  try {
    const status = await gatewayStatus(upstream('claude', 0, await refusedOrigin()));
    assert.equal(status.state, 'stopped');
    assert.equal(status.metrics, 'offline');
    assert.equal(status.router, null);
    assert.equal(stub.seen.length, 0);
  } finally { await stub.close(); }
});

test('gateway status includes the logged history when the gateway is stopped', async () => {
  const logged = [{ mode: 'forced', durationMs: 5 }, { mode: 'passthrough', reason: 'no_tools' }];
  const loaded: HistoryResult = { metrics: summarizeRouteEvents(logged), byModel: summarizeByModel(logged), compare: compareGroups(logged), complete: false, bytesRead: 10 };
  const status = await gatewayStatus(upstream('claude', 0, await refusedOrigin()), { history: { claude: async () => loaded } });
  assert.equal(status.metrics, 'offline');
  assert.equal(status.history?.events, 2);
  assert.equal(status.history?.complete, false);
  assert.equal(status.history?.reasons.no_tools, 1);
  assert.deepEqual(status.models.history.map(entry => [entry.model, entry.metrics.events]), [['unknown', 2]]);
});

test('a history loader that throws yields null history and never fails the snapshot', async () => {
  const gateways = [upstream('codex', 0, await refusedOrigin())];
  const snapshot = await gatewaySnapshot(gateways, {
    history: { codex: async () => { throw new Error('EACCES /home/user/.jev-gateway/codex.log'); } },
  });
  assert.equal(snapshot.gateways[0]?.history, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /EACCES|home\/user/);
});

test('gateway status reports the configured experiment mode for its client', async () => {
  const stub = await statusStub(answer(eventsBody()));
  try {
    const status = await gatewayStatus(upstream('codex', 0, stub.origin), { experiment: { claude: 'shadow', codex: 'metering' } });
    assert.equal(status.experiment, 'metering');
  } finally { await stub.close(); }
});

test('gateway status sends no credentials and only the events query to the stub', async () => {
  const stub = await statusStub(answer(eventsBody()));
  try {
    await gatewayStatus(upstream('codex', 0, stub.origin), { timeoutMs: 1000 });
    const events = stub.seen.find(req => req.url?.startsWith('/dashboard/events'));
    assert.equal(events?.url, '/dashboard/events?since=0');
    for (const name of ['authorization', 'cookie', 'x-api-key', 'x-jev-key', 'proxy-authorization']) {
      assert.equal(events?.headers[name], undefined, name);
    }
  } finally { await stub.close(); }
});

test('gateway status hands the events request an injected fetch with redirect error and no credentials', async () => {
  const stub = await statusStub(answer(eventsBody()));
  const calls: { url: string; init?: RequestInit }[] = [];
  const recording: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init });
    return fetch(input, init);
  };
  try {
    const status = await gatewayStatus(upstream('codex', 0, stub.origin), { fetch: recording });
    assert.equal(status.metrics, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, `${stub.origin}/dashboard/events?since=0`);
    assert.equal(calls[0]?.init?.redirect, 'error');
    assert.equal(calls[0]?.init?.credentials, 'omit');
    assert.equal(calls[0]?.init?.headers, undefined);
  } finally { await stub.close(); }
});

test('gateway status breaks the logged history down by model and ignores the live events for it', async () => {
  const stub = await statusStub(answer({ router: eventsBody().router, events: TWO_MODEL_LOG }));
  const logged = [{ mode: 'direct', model: 'model-c', usage: { input: 5, output: 1 } }];
  try {
    const status = await gatewayStatus(upstream('claude', 0, stub.origin), { history: { claude: historyFrom(logged) } });
    assert.deepEqual(status.models.history.map(entry => [entry.model, entry.metrics.events, entry.metrics.avoidedLlmCalls]), [['model-c', 1, 1]]);
  } finally { await stub.close(); }
});

test('client history cost is unknown when a model that made calls has no price, and the missing list names that model', async () => {
  const history = { claude: historyFrom(TWO_MODEL_LOG) };
  const stub = await statusStub(answer(eventsBody()));
  try {
    const status = await gatewayStatus(upstream('claude', 0, stub.origin), { pricing: { models: { 'model-a': LLM_PRICE } }, history });
    const [priced, unpriced] = status.models.history;
    assert.equal(priced?.cost.llm, 14);
    assert.equal(unpriced?.cost.llm, null);
    assert.equal(status.cost.history?.llm, null);
    assert.equal(status.cost.history?.total, null);
    assert.deepEqual(status.cost.history?.missing, ['llm-price:model-b']);
  } finally { await stub.close(); }
});

test('client history cost sums the per-model estimates when every model that made calls is priced', async () => {
  const stub = await statusStub(answer(eventsBody()));
  try {
    const status = await gatewayStatus(upstream('claude', 0, stub.origin), {
      pricing: { models: { 'model-a': LLM_PRICE, 'model-b': LLM_PRICE }, jev: JEV_PRICE },
      history: { claude: historyFrom(TWO_MODEL_LOG) },
    });
    assert.deepEqual(status.models.history.map(entry => entry.cost.llm), [14, 8]);
    assert.equal(status.cost.history?.llm, 22);
    assert.equal(status.cost.history?.jev, 0);
    assert.equal(status.cost.history?.total, 22);
    assert.deepEqual(status.cost.history?.missing, []);
  } finally { await stub.close(); }
});

test('client history cost counts only logged usage, with cached input priced at its own rate', async () => {
  // 10 input of which 2 cached: 8 uncached input and 4 output at $1 per token-million-times-one-million, so 12 USD.
  const logged = [{ seq: 1, time: '2026-10-22T10:00:00.000Z', model: 'model-alpha', mode: 'forced', usage: { input: 10, output: 4, cached: 2, cacheWrite: 0, reasoning: 0 } }];
  const stub = await statusStub(answer(eventsBody()));
  try {
    const status = await gatewayStatus(upstream('codex', 0, stub.origin), { pricing: { models: { 'model-alpha': LLM_PRICE } }, history: { codex: historyFrom(logged) } });
    assert.equal(status.cost.history?.llm, 12);
  } finally { await stub.close(); }
});

test('gateway snapshot lists each gateway status with a generated time', async () => {
  const claude = await statusStub(answer(eventsBody()));
  const codex = await refusedOrigin();
  try {
    const snapshot = await gatewaySnapshot([upstream('claude', 8789, claude.origin), upstream('codex', 8790, codex)]);
    assert.deepEqual(snapshot.gateways.map(g => [g.client, g.metrics]), [['claude', 'ok'], ['codex', 'offline']]);
    assert.equal(Number.isNaN(Date.parse(snapshot.generatedAt)), false);
  } finally { await claude.close(); }
});

test('gateway snapshot has the trimmed top-level and combined shape', async () => {
  const snapshot = await gatewaySnapshot([]);
  assert.deepEqual(Object.keys(snapshot).sort(), ['combined', 'gateways', 'generatedAt', 'pricing']);
  assert.deepEqual(Object.keys(snapshot.combined).sort(), ['cost', 'history', 'historyCompare', 'models']);
  assert.deepEqual(Object.keys(snapshot.combined.cost), ['history']);
});

test('gateway snapshot sums the history of both clients', async () => {
  const claude = await statusStub(answer(eventsBody()));
  const codex = await statusStub(answer(eventsBody()));
  const logged = [{ mode: 'direct', usage: { input: 5, output: 1 } }];
  try {
    const snapshot = await gatewaySnapshot([upstream('claude', 8789, claude.origin), upstream('codex', 8790, codex.origin)], {
      history: { claude: historyFrom(logged), codex: historyFrom(logged) },
    });
    assert.equal(snapshot.combined.history.events, 2);
    assert.equal(snapshot.combined.history.avoidedLlmCalls, 2);
  } finally {
    await claude.close();
    await codex.close();
  }
});

test('gateway snapshot has no history cost without prices and sums the per-client cost with prices', async () => {
  const claude = await statusStub(answer(eventsBody()));
  const codex = await statusStub(answer(eventsBody()));
  try {
    const gateways = [upstream('claude', 8789, claude.origin), upstream('codex', 8790, codex.origin)];
    const history = { claude: historyFrom(TWO_MODEL_LOG), codex: historyFrom(TWO_MODEL_LOG.slice(0, 1)) };
    const unpriced = await gatewaySnapshot(gateways, { history });
    assert.equal(unpriced.gateways[0]?.cost.history?.llm, null);
    assert.equal(unpriced.gateways[0]?.cost.history?.total, null);
    assert.deepEqual(unpriced.gateways[0]?.cost.history?.missing, ['llm-price:model-a', 'llm-price:model-b']);
    assert.equal(unpriced.combined.cost.history.llm, null);
    assert.equal(unpriced.combined.cost.history.total, null);
    assert.deepEqual(unpriced.pricing, { models: {}, jev: null });

    const priced = await gatewaySnapshot(gateways, { history, pricing: { models: { 'model-a': LLM_PRICE, 'model-b': LLM_PRICE }, jev: JEV_PRICE } });
    assert.equal(priced.gateways[0]?.cost.history?.llm, 22);
    assert.equal(priced.gateways[1]?.cost.history?.llm, 14);
    assert.equal(priced.combined.cost.history.llm, 36);
    assert.equal(priced.combined.cost.history.jev, 0);
    assert.equal(priced.combined.cost.history.total, 36);
    assert.deepEqual(priced.combined.cost.history.missing, []);
    assert.deepEqual(priced.pricing.models['model-a'], { source: 'test-llm', verifiedAt: '2026-10-01' });
    assert.equal(JSON.stringify(priced.pricing).includes('1000000'), false);
  } finally {
    await claude.close();
    await codex.close();
  }
});

// The verified Gemini defaults, as a profile without observability.pricing gets them.
const defaultPricing = async () => configSchema.parse(await json(resolve(root, 'config/default.json'))).observability.pricing;
const GEMINI_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';
// Usage as the launcher logs it: input includes the cached tokens, and output includes the reasoning tokens.
const LITE_USAGE = { input: 2_000_000, output: 1_000_000, cached: 1_000_000, cacheWrite: 0, reasoning: 400_000 };
const FLASH_USAGE = { input: 3_000_000, output: 500_000, cached: 1_000_000, cacheWrite: 0, reasoning: 200_000 };
const GEMINI_LOG = [
  { seq: 1, time: '2026-10-24T10:00:00.000Z', model: 'gemini-3.5-flash-lite', mode: 'passthrough', usage: LITE_USAGE },
  { seq: 2, time: '2026-10-24T10:01:00.000Z', model: 'gemini-3.8-flash', mode: 'passthrough', usage: FLASH_USAGE },
];
const TODAY = new Date('2026-10-24T12:00:00Z');

test('verified Gemini defaults cost the two observed models: thinking is inside output, cache reads at the cache rate', async () => {
  const stub = await statusStub(answer(eventsBody()));
  try {
    // Each call also carries a Jev object, so the Jev price is genuinely missing rather than unused.
    const withJev = GEMINI_LOG.map(entry => ({ ...entry, jev: { confidence: 0.4, latencyMs: 100, inputTokens: 1000 } }));
    const status = await gatewayStatus(upstream('claude', 0, stub.origin), { pricing: await defaultPricing(), history: { claude: historyFrom(withJev) }, now: TODAY });
    // lite: 1M uncached x 0.30 + 1M cache read x 0.03 + 1M output x 2.50 = 2.83
    // flash: 2M uncached x 0.75 + 1M cache read x 0.075 + 0.5M output x 3.75 = 3.45
    assert.deepEqual(status.models.history.map(entry => [entry.model, entry.cost.llm]), [['gemini-3.5-flash-lite', 2.83], ['gemini-3.8-flash', 3.45]]);
    assert.equal(status.cost.history?.llm, 6.28);
    assert.equal(status.cost.history?.total, null, 'Jev calls are logged but no Jev price is configured, so there is no total');
    assert.deepEqual(status.cost.history?.missing, ['jev-price', 'jev-output-tokens']);
  } finally { await stub.close(); }
});

test('a price is not used after its validUntil day: the model reports llm-price-expired and no LLM cost', async () => {
  const stub = await statusStub(answer(eventsBody()));
  try {
    const status = await gatewayStatus(upstream('claude', 0, stub.origin), {
      pricing: await defaultPricing(), history: { claude: historyFrom(GEMINI_LOG) }, now: new Date('2027-01-01T00:00:00Z'),
    });
    const [lite, flash] = status.models.history;
    assert.equal(lite?.cost.llm, 2.83);
    assert.equal(flash?.cost.llm, null);
    assert.deepEqual(flash?.cost.missing, ['llm-price-expired:gemini-3.8-flash']);
    assert.equal(status.cost.history?.llm, null);
    assert.deepEqual(status.cost.history?.missing, ['llm-price-expired:gemini-3.8-flash']);
  } finally { await stub.close(); }
});

test('an alias prices an unlisted model with its target rates and flags it; an alias to an unpriced target stays unpriced', async () => {
  const pricing = { ...await defaultPricing(), aliases: { 'gemini-3.8-flash-high': 'gemini-3.8-flash', 'gemini-3.8-flash-unpriced': 'gemini-9-missing' } };
  const log = [
    { seq: 1, time: '2026-10-24T10:00:00.000Z', model: 'gemini-3.8-flash-high', mode: 'passthrough', usage: FLASH_USAGE },
    { seq: 2, time: '2026-10-24T10:01:00.000Z', model: 'gemini-3.8-flash-unpriced', mode: 'passthrough', usage: FLASH_USAGE },
  ];
  const stub = await statusStub(answer(eventsBody()));
  try {
    const status = await gatewayStatus(upstream('claude', 0, stub.origin), { pricing, history: { claude: historyFrom(log) }, now: TODAY });
    const [aliased, unpriced] = status.models.history;
    assert.equal(aliased?.cost.llm, 3.45);
    assert.deepEqual(aliased?.cost.aliased, { 'gemini-3.8-flash-high': 'gemini-3.8-flash' });
    assert.equal(unpriced?.cost.llm, null);
    assert.equal(unpriced?.cost.aliased, undefined);
    assert.deepEqual(unpriced?.cost.missing, ['llm-price:gemini-3.8-flash-unpriced']);
    assert.deepEqual(status.cost.history?.aliased, { 'gemini-3.8-flash-high': 'gemini-3.8-flash' });
    assert.deepEqual(status.cost.history?.missing, ['llm-price:gemini-3.8-flash-unpriced']);
  } finally { await stub.close(); }
});

test('billing defaults to unknown for claude and codex and subscription for agy, and an explicit option applies per gateway', async () => {
  const origin = await refusedOrigin();
  const snapshot = await gatewaySnapshot([upstream('claude', 8789, origin), upstream('codex', 8790, origin), upstream('agy', 8794, origin)]);
  assert.deepEqual(snapshot.gateways.map(g => [g.client, g.billing]), [['claude', 'unknown'], ['codex', 'unknown'], ['agy', 'subscription']]);
  const set = await gatewaySnapshot([upstream('claude', 8789, origin), upstream('agy', 8794, origin)], { billing: { claude: 'api' } });
  assert.deepEqual(set.gateways.map(g => [g.client, g.billing]), [['claude', 'api'], ['agy', 'subscription']]);
  assert.equal((await gatewayStatus(upstream('agy', 0, origin))).billing, 'subscription');
});

test('the pricing echo lists the merged prices: defaults plus configured models, with the configured price winning on a shared id', async () => {
  const configured = configSchema.parse({
    ...await json(resolve(root, 'config/default.json')) as Record<string, unknown>,
    observability: { pricing: { models: {
      'claude-opus-5-5': { currency: 'USD', source: 'operator rate card', verifiedAt: '2026-10-30', inputPerMTok: 15, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75, outputPerMTok: 75 },
      'gemini-3.8-flash': { currency: 'USD', source: 'operator rate card', verifiedAt: '2026-10-30', inputPerMTok: 1, cacheReadPerMTok: 0.1, cacheWritePerMTok: 0, outputPerMTok: 4 },
    } } },
  }).observability.pricing;
  const snapshot = await gatewaySnapshot([], { pricing: configured });
  assert.deepEqual(Object.keys(snapshot.pricing.models).sort(), ['claude-opus-5-5', 'gemini-3.5-flash-lite', 'gemini-3.8-flash']);
  assert.deepEqual(snapshot.pricing.models['gemini-3.8-flash'], { source: 'operator rate card', verifiedAt: '2026-10-30' });
  assert.deepEqual(snapshot.pricing.models['gemini-3.5-flash-lite'], { source: GEMINI_SOURCE, verifiedAt: '2026-10-24' });
});

test('the pricing echo shows validUntil beside source and date, and still never shows rates', async () => {
  const snapshot = await gatewaySnapshot([], { pricing: await defaultPricing() });
  assert.deepEqual(snapshot.pricing.models['gemini-3.8-flash'], { source: GEMINI_SOURCE, verifiedAt: '2026-10-24', validUntil: '2026-12-31' });
  assert.deepEqual(snapshot.pricing.models['gemini-3.5-flash-lite'], { source: GEMINI_SOURCE, verifiedAt: '2026-10-24' });
  assert.doesNotMatch(JSON.stringify(snapshot.pricing), /PerMTok|0\.075|3\.75/);
});

test('gateway snapshot with no gateways still has the full shape', async () => {
  const snapshot = await gatewaySnapshot([]);
  assert.deepEqual(snapshot.gateways, []);
  assert.equal(snapshot.combined.history.events, 0);
  // No calls at all: no model is unpriced and no Jev cost exists, so the LLM and total cost are zero.
  assert.equal(snapshot.combined.cost.history.llm, 0);
  assert.equal(snapshot.combined.cost.history.jev, 0);
  assert.equal(snapshot.combined.cost.history.total, 0);
  assert.deepEqual(snapshot.combined.cost.history.missing, []);
});

test('a gateway with no Jev calls and every model priced has total equal to llm, jev 0 and nothing Jev missing', async () => {
  const stub = await statusStub(answer(eventsBody()));
  try {
    const status = await gatewayStatus(upstream('claude', 0, stub.origin), {
      pricing: { models: { 'model-a': LLM_PRICE, 'model-b': LLM_PRICE } },
      history: { claude: historyFrom(TWO_MODEL_LOG) },
    });
    assert.equal(status.cost.history?.llm, 22);
    assert.equal(status.cost.history?.jev, 0);
    assert.equal(status.cost.history?.total, 22);
    assert.deepEqual(status.cost.history?.missing, []);
  } finally { await stub.close(); }
});

test('combined models merge the same model name across clients and price the merged totals', async () => {
  const claude = await statusStub(answer(eventsBody()));
  const codex = await statusStub(answer(eventsBody()));
  try {
    const snapshot = await gatewaySnapshot([upstream('claude', 8789, claude.origin), upstream('codex', 8790, codex.origin)], {
      history: { claude: historyFrom(TWO_MODEL_LOG), codex: historyFrom(TWO_MODEL_LOG.slice(0, 1)) },
      pricing: { models: { 'model-a': LLM_PRICE, 'model-b': LLM_PRICE }, jev: JEV_PRICE },
    });
    assert.deepEqual(
      snapshot.combined.models.history.map(entry => [entry.model, entry.metrics.events, entry.metrics.llm.calls, entry.cost.llm]),
      [['model-a', 2, 2, 28], ['model-b', 1, 1, 8]],
    );
    assert.equal(snapshot.combined.cost.history.llm, 36);
    assert.equal(snapshot.combined.cost.history.total, 36);
  } finally {
    await claude.close();
    await codex.close();
  }
});

test('the pricing echo carries only source and verifiedAt, never the rates', async () => {
  const snapshot = await gatewaySnapshot([], { pricing: { models: { 'model-a': LLM_PRICE }, jev: JEV_PRICE } });
  assert.deepEqual(snapshot.pricing, {
    models: { 'model-a': { source: 'test-llm', verifiedAt: '2026-10-01' } },
    jev: { source: 'test-jev', verifiedAt: '2026-10-01' },
  });
  assert.doesNotMatch(JSON.stringify(snapshot.pricing), /PerMTok|currency|1000000/);
});

test('gateway status passes the history comparison through, and is null without history', async () => {
  const logged = [{ mode: 'forced', usage: { input: 10, output: 2 } }, { mode: 'passthrough', reason: 'routing_disabled', usage: { input: 6, output: 1 } }];
  const loaded: HistoryResult = {
    metrics: summarizeRouteEvents(logged), byModel: summarizeByModel(logged), compare: compareGroups(logged), complete: true, bytesRead: 1,
  };
  const withHistory = await gatewayStatus(upstream('claude', 0, await refusedOrigin()), { history: { claude: async () => loaded } });
  assert.deepEqual(withHistory.historyCompare, loaded.compare);
  assert.equal(withHistory.historyCompare?.baseline.requests, 1);
  assert.equal(withHistory.historyCompare?.withJev.requests, 1);
  assert.equal((await gatewayStatus(upstream('claude', 0, await refusedOrigin()))).historyCompare, null);
});

test('combined comparison pools the clients that have history', async () => {
  const claude = await statusStub(answer(eventsBody()));
  const codex = await statusStub(answer(eventsBody()));
  const logged = [{ mode: 'direct', usage: { input: 5, output: 1 } }];
  try {
    const both = await gatewaySnapshot([upstream('claude', 8789, claude.origin), upstream('codex', 8790, codex.origin)], {
      history: { claude: historyFrom(logged), codex: historyFrom(logged) },
    });
    assert.equal(both.combined.historyCompare?.withJev.requests, 2);
    const oneSide = await gatewaySnapshot([upstream('claude', 8789, claude.origin), upstream('codex', 8790, await refusedOrigin())], {
      history: { claude: historyFrom(logged) },
    });
    assert.equal(oneSide.combined.historyCompare?.withJev.requests, 1);
    const noHistory = await gatewaySnapshot([upstream('claude', 8789, claude.origin)]);
    assert.equal(noHistory.combined.historyCompare, null);
  } finally {
    await claude.close();
    await codex.close();
  }
});

// Route events one minute apart, ending at endMs, in the shape /dashboard/events returns.
function routeLog(count: number, endMs: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1, time: new Date(endMs - (count - 1 - index) * 60_000).toISOString(),
    path: '/v1/messages', tools: 1, mode: index % 2 === 0 ? 'forced' : 'passthrough', durationMs: 50,
    usage: { input: 10, output: 2, cached: 0, cacheWrite: 0, reasoning: 0 },
  }));
}

test('a snapshot stays small even when a gateway returns 1000 events, because only the router block is kept', async () => {
  const now = Date.now();
  const claude = await statusStub(answer({ router: eventsBody().router, events: routeLog(1000, now) }));
  const codex = await statusStub(answer({ router: eventsBody().router, events: routeLog(1000, now) }));
  try {
    const snapshot = await gatewaySnapshot([upstream('claude', 8789, claude.origin), upstream('codex', 8790, codex.origin)]);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 64 * 1024);
    assert.equal(snapshot.gateways[0]?.metrics, 'ok');
    assert.equal(snapshot.gateways[1]?.metrics, 'ok');
  } finally {
    await claude.close();
    await codex.close();
  }
});

test('router meta keeps a sanitized upstream and only plain Jev labels', async () => {
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [
      { upstream: 'https://user:sk-live-abc123def456@api.example.test/v1?key=abc#frag', jevModel: 'Bearer abc', jevProvider: 'k=v' },
      { upstream: null, jevModel: null, jevProvider: null },
    ],
    [
      { upstream: 'https://api.example.test/v1', jevModel: 'jev-small', jevProvider: 'typesafe:eu' },
      { upstream: 'https://api.example.test/v1', jevModel: 'jev-small', jevProvider: 'typesafe:eu' },
    ],
    [
      { upstream: 'https://api.example.test/v1#frag', jevModel: 'a'.repeat(81), jevProvider: 42 },
      { upstream: null, jevModel: null, jevProvider: null },
    ],
  ];
  for (const [router, expected] of cases) {
    const stub = await statusStub(answer({ router: { client: 'codex', routing: true, ...router }, events: [] }));
    try {
      const status = await gatewayStatus(upstream('codex', 0, stub.origin));
      assert.equal(status.metrics, 'ok');
      assert.deepEqual(
        { upstream: status.router?.upstream, jevModel: status.router?.jevModel, jevProvider: status.router?.jevProvider },
        expected,
      );
      assert.doesNotMatch(JSON.stringify(status), /sk-live|Bearer|key=|hunter2|abc123/);
    } finally { await stub.close(); }
  }
});

test('the snapshot JSON carries no secrets, keys, bearer tokens or upstream credentials', async () => {
  const claude = await statusStub(answer(eventsBody()));
  const codex = await statusStub(answer(eventsBody()));
  try {
    const snapshot = await gatewaySnapshot([upstream('claude', 8789, claude.origin), upstream('codex', 8790, codex.origin)], {
      history: { claude: historyFrom(TWO_MODEL_LOG) },
      pricing: { models: { 'model-a': LLM_PRICE }, jev: JEV_PRICE },
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /Bearer|key=|sk-|secret\.example|user:|hunter2/);
  } finally {
    await claude.close();
    await codex.close();
  }
});

test('aggregatorFor prefers codex when both gateways run, and names claude in ?peers=', () => {
  const gateways = [upstream('claude', 8789), upstream('codex', 8790)];
  assert.deepEqual(aggregatorFor(gateways, { claude: 'running', codex: 'running' }), {
    client: 'codex', port: 8790,
    origins: ['http://localhost:8790', 'http://127.0.0.1:8790'],
    url: 'http://localhost:8790/dashboard?peers=8789',
  });
});

test('aggregatorFor falls back to claude when codex is not running', () => {
  const gateways = [upstream('claude', 8789), upstream('codex', 8790)];
  for (const codex of ['stopped', 'unavailable'] as GatewayProbe['state'][]) {
    assert.deepEqual(aggregatorFor(gateways, { claude: 'running', codex }), {
      client: 'claude', port: 8789,
      origins: ['http://localhost:8789', 'http://127.0.0.1:8789'],
      url: 'http://localhost:8789/dashboard?peers=8790',
    }, codex);
  }
});

test('aggregatorFor returns undefined when no gateway is running, so nothing may be framed', () => {
  const gateways = [upstream('claude', 8789), upstream('codex', 8790)];
  assert.equal(aggregatorFor(gateways, {}), undefined);
  assert.equal(aggregatorFor(gateways, { claude: 'stopped', codex: 'unavailable' }), undefined);
  assert.equal(aggregatorFor([], { claude: 'running' }), undefined);
});

test('aggregatorFor with one running gateway has no peers query when the other is not configured', () => {
  const aggregator = aggregatorFor([upstream('codex', 8790)], { codex: 'running' });
  assert.equal(aggregator?.url, 'http://localhost:8790/dashboard');
});

test('aggregatorFor never lists its own port in ?peers= and drops duplicate peer ports', () => {
  const gateways = [upstream('codex', 8790), upstream('claude', 8789), upstream('claude', 8789, 'http://127.0.0.1:8789')];
  assert.equal(aggregatorFor(gateways, { codex: 'running' })?.url, 'http://localhost:8790/dashboard?peers=8789');
  assert.equal(aggregatorFor([upstream('codex', 8790), upstream('codex', 8790)], { codex: 'running' })?.url, 'http://localhost:8790/dashboard');
});

test('aggregatorFor keeps custom ports and leaves out peers whose port is not usable', () => {
  const custom = [upstream('codex', 18790), upstream('claude', 18789)];
  assert.equal(aggregatorFor(custom, { codex: 'running', claude: 'running' })?.url, 'http://localhost:18790/dashboard?peers=18789');
  assert.equal(aggregatorFor([upstream('codex', 8790), upstream('claude', 80)], { codex: 'running' })?.url, 'http://localhost:8790/dashboard');
});

test('gateway snapshot names the codex aggregator when both gateways run', async () => {
  const claude = await statusStub(answer(eventsBody()));
  const codex = await statusStub(answer(eventsBody()));
  try {
    const snapshot = await gatewaySnapshot([upstream('claude', 8789, claude.origin), upstream('codex', 8790, codex.origin)]);
    assert.deepEqual(snapshot.aggregator, {
      client: 'codex', port: 8790,
      origins: ['http://localhost:8790', 'http://127.0.0.1:8790'],
      url: 'http://localhost:8790/dashboard?peers=8789',
    });
  } finally {
    await claude.close();
    await codex.close();
  }
});

test('gateway snapshot has no aggregator key when no gateway is running', async () => {
  const snapshot = await gatewaySnapshot([upstream('claude', 8789, await refusedOrigin()), upstream('codex', 8790, await refusedOrigin())]);
  assert.equal('aggregator' in snapshot, false);
});

test('the gateway module no longer exports a routing toggle', async () => {
  const mod = await import('../src/gateways.js') as Record<string, unknown>;
  assert.equal('setRouting' in mod, false);
});

test('an Antigravity gateway without its installed spec is unavailable without a connection attempt', async () => {
  const stub = await statusStub(answer(eventsBody()));
  try {
    const agy = { ...upstream('agy', 8794, stub.origin), source: 'fallback' as const };
    const [status] = (await gatewaySnapshot([agy])).gateways;
    assert.equal(status?.state, 'unavailable');
    assert.equal(status?.metrics, 'unavailable');
    assert.equal((await gatewayStatus(agy)).state, 'unavailable');
    assert.equal(stub.seen.length, 0);
  } finally { await stub.close(); }
});

test('an installed Antigravity gateway that is not listening reads as stopped and always reports passthrough', async () => {
  const status = await gatewayStatus(upstream('agy', 0, await refusedOrigin()));
  assert.equal(status.state, 'stopped');
  assert.equal(status.metrics, 'offline');
  assert.equal(status.experiment, 'passthrough');
});

test('the Antigravity log joins the snapshot and the combined totals, but not the combined comparison', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-agy-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'agy.log');
  const line = (usage: Record<string, number>): string => JSON.stringify({
    event: 'route', time: '2026-10-22T10:00:00.000Z', mode: 'passthrough', reason: 'routing_disabled', model: 'gemini-3-pro', usage,
  });
  await writeFile(file, `${line({ input: 119, output: 3 })}\n${line({ input: 23192, output: 102, reasoning: 93 })}\n`);
  const claudeLog = [{ mode: 'forced', usage: { input: 100, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 1000 }];

  const snapshot = await gatewaySnapshot(
    [upstream('claude', 8789, await refusedOrigin()), upstream('agy', 8794, await refusedOrigin())],
    { history: { claude: historyFrom(claudeLog), agy: () => createHistoryReader(file).refresh() } },
  );

  const agy = snapshot.gateways.find(g => g.client === 'agy');
  assert.equal(agy?.history?.events, 2);
  assert.equal(agy?.history?.llm.input, 23311);
  assert.equal(snapshot.combined.history.events, 3);
  assert.equal(snapshot.combined.history.llm.input, 23411);
  assert.equal(snapshot.combined.history.llm.output, 110);
  assert.equal(snapshot.combined.historyCompare?.withJev.requests, 1);
  assert.equal(snapshot.combined.historyCompare?.baseline.requests, 0);
});

test('the aggregator names only claude and codex as peers, never the Antigravity port', () => {
  const gateways = [upstream('codex', 8790), upstream('claude', 8789), upstream('agy', 8794)];
  assert.equal(aggregatorFor(gateways, { codex: 'running', agy: 'running' })?.url, 'http://localhost:8790/dashboard?peers=8789');
});
