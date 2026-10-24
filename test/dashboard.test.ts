import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { summarize, summarizeFeed, dashboardHandler, mergeProjectFeeds, type MemoryFeed, type FeedItem } from '../src/dashboard.js';
import type { ProjectEntry } from '../src/dashboard-projects.js';
import {
  aggregatorFor, emptySnapshot, type GatewayProbe, type GatewaySnapshot, type GatewayStatus, type UpstreamClient, type UpstreamGateway,
} from '../src/gateways.js';
import { summarizeRouteEvents } from '../src/gateway-metrics.js';

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }
interface CallOptions { method?: string; host?: string; headers?: Record<string, string>; body?: string }

function briefing(recentCount: number, titleLength = 10) {
  return {
    counts: { sessions: 3, observations: 42, pages_latest: 7 },
    last_observation_at: '2026-10-21T10:00:00Z',
    pending_handoff_count: 1,
    pending_message_count: 2,
    unrelated_field: { ignored: true },
    recent_pages: Array.from({ length: recentCount }, (_, i) => ({
      path: `wiki/${'p'.repeat(200)}-${i}`.slice(0, 200),
      title: 't'.repeat(titleLength) + i,
      updated_at: `2026-10-2${i}T00:00:00Z`,
    })),
  };
}

const emptyFeed = async (): Promise<MemoryFeed> => ({ ok: true, sessionId: null, items: [] });
const oneProject = async (): Promise<ProjectEntry[]> => [{ id: 'default', label: 'jev-memory-suite' }];
const PORTS: Record<UpstreamClient, number> = { claude: 19789, codex: 19790 };
const ROUTER = { routing: true, shadow: false, minConfidence: null, recorded: 0, startedAt: null, upstream: null, jevModel: null, jevProvider: null };

// The gateway as the port spec resolves it; origin is loopback like the real check.
function gatewayOf(client: UpstreamClient, port: number): UpstreamGateway {
  return {
    client, label: client === 'claude' ? 'Claude' : 'Codex', portEnv: `JEV_${client.toUpperCase()}_PORT`, port,
    source: 'installed', portValid: true, origin: `http://127.0.0.1:${port}`, dashboardUrl: `http://localhost:${port}/dashboard`,
  };
}

// A gateway status as the real check reports it for a running or stopped gateway.
function statusOf(client: UpstreamClient, running: boolean, port: number): GatewayStatus {
  return {
    client, label: client === 'claude' ? 'Claude' : 'Codex', port, portValid: true,
    state: running ? 'running' : 'stopped', metrics: running ? 'ok' : 'offline',
    router: running ? ROUTER : null, history: null, historyCompare: null,
    cost: { history: null }, models: { history: [] }, experiment: 'default',
  };
}

// The snapshot the real check builds: the aggregator comes from the same probe states through aggregatorFor.
function snapshotWith(running: UpstreamClient[], ports: Record<UpstreamClient, number> = PORTS): GatewaySnapshot {
  const gateways = (['claude', 'codex'] as const).map(client => gatewayOf(client, ports[client]));
  const states: Partial<Record<UpstreamClient, GatewayProbe['state']>> = {
    claude: running.includes('claude') ? 'running' : 'stopped',
    codex: running.includes('codex') ? 'running' : 'stopped',
  };
  const aggregator = aggregatorFor(gateways, states);
  return {
    ...emptySnapshot(),
    gateways: gateways.map(g => statusOf(g.client, running.includes(g.client), g.port)),
    ...(aggregator ? { aggregator } : {}),
  };
}
const bothRunning = async (): Promise<GatewaySnapshot> => snapshotWith(['claude', 'codex']);

async function withDashboard(
  summary: (projectId?: string) => Promise<unknown>,
  run: (port: number) => Promise<void>,
  feed: (projectId?: string) => Promise<MemoryFeed> = emptyFeed,
  projects: () => Promise<ProjectEntry[]> = oneProject,
  gateways: () => Promise<GatewaySnapshot> = bothRunning,
): Promise<void> {
  let handler: ReturnType<typeof dashboardHandler> | undefined;
  const server: Server = createServer((req, res) => handler?.(req, res));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as AddressInfo).port;
    handler = dashboardHandler({ port, gateways, summary, feed, projects });
    await run(port);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

function call(port: number, path: string, options: CallOptions = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { host: options.host ?? `127.0.0.1:${port}`, ...options.headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', fail);
    req.end(options.body);
  });
}

test('summarize maps a real briefing and keeps only five recent pages', () => {
  const result = summarize(briefing(8));
  assert.deepEqual(result.counts, { sessions: 3, observations: 42, pages: 7 });
  assert.equal(result.lastObservationAt, '2026-10-21T10:00:00Z');
  assert.equal(result.pendingHandoffs, 1);
  assert.equal(result.pendingMessages, 2);
  assert.equal(result.recent.length, 5);
  assert.equal(result.recent[0]?.updatedAt, '2026-10-20T00:00:00Z');
});

test('summarize truncates titles and paths to 120 characters', () => {
  const result = summarize(briefing(1, 300));
  assert.equal(result.recent[0]?.title.length, 120);
  assert.equal(result.recent[0]?.path.length, 120);
});

test('summarize rejects a briefing without the required counts', () => {
  assert.throws(() => summarize({ counts: {} }));
});

test('summarize carries scope, seven-day activity and page kind when the briefing has them', () => {
  const full = {
    ...briefing(1),
    scope: { workspace: 'jev-suite', project: 'jev-memory-suite', resolved_by: 'explicit' },
    activity_7d: { days: 7, sessions: 4, observations: 19, pages_updated: 2 },
    recent_pages: [{ path: 'decisions/x.md', title: 'Decisão', kind: 'decision', updated_at: '2026-10-21T10:00:00Z' }],
  };
  const result = summarize(full);
  assert.deepEqual(result.scope, { workspace: 'jev-suite', project: 'jev-memory-suite' });
  assert.deepEqual(result.activity7d, { sessions: 4, observations: 19, pagesUpdated: 2 });
  assert.equal(result.recent[0]?.kind, 'decision');
});

test('summarize tolerates a briefing without the optional blocks and page kind', () => {
  const minimal = { ...briefing(2), recent_pages: [{ path: 'a.md', title: 'A' }] };
  const result = summarize(minimal);
  assert.equal(result.scope, null);
  assert.equal(result.activity7d, null);
  assert.equal(result.recent[0]?.kind, null);
  assert.equal(result.recent[0]?.updatedAt, null);
  assert.equal(result.counts.pages, 7);
});

test('summarize truncates page kind to 40 characters', () => {
  const result = summarize({ ...briefing(0), recent_pages: [{ path: 'a.md', title: 'A', kind: 'k'.repeat(90) }] });
  assert.equal(result.recent[0]?.kind?.length, 40);
});

test('a request with a foreign Host header is rejected with 403', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/', { host: `evil.com:${port}` });
    assert.equal(reply.status, 403);
  });
});

test('memory summary failure returns a generic offline body without the error text', async () => {
  await withDashboard(async () => { throw new Error('token sk-secret-123 at /internal/stack'); }, async port => {
    const reply = await call(port, '/memory/summary');
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body), { ok: false, error: 'memory offline' });
    assert.doesNotMatch(reply.body, /sk-secret|stack|internal/);
  });
});

test('summarizeFeed keeps only toast fields and bounds title and body', () => {
  const items = summarizeFeed({
    observations: [{ id: 'o1', session_id: 's', kind: 'post-tool-use', title: 'T'.repeat(300), body: 'B'.repeat(900), importance: 2, created_at: '2026-10-21T10:00:00Z' }],
  });
  assert.deepEqual(items.map(i => [i.id, i.kind, i.title.length, i.body.length, i.createdAt]), [['o1', 'post-tool-use', 120, 300, '2026-10-21T10:00:00Z']]);
});

test('summarizeFeed rejects a response without an observations array', () => {
  assert.throws(() => summarizeFeed({ session: {} }));
});

test('memory feed returns merged items tagged with their project and no-store JSON headers', async () => {
  const item: FeedItem = { id: 'o1', kind: 'post-tool-use', title: 'Bash', body: 'ls', createdAt: null };
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/memory/feed');
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(JSON.parse(reply.body), { ok: true, items: [{ ...item, projectId: 'default', projectLabel: 'jev-memory-suite' }] });
  }, async () => ({ ok: true, sessionId: 'sess-1', items: [item] }));
});

test('a request to the feed route with a foreign Host header is rejected with 403', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/memory/feed', { host: `evil.com:${port}` });
    assert.equal(reply.status, 403);
  }, emptyFeed);
});

test('a failing project is skipped from the merged feed without leaking its error text', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/memory/feed');
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body), { ok: true, items: [] });
    assert.doesNotMatch(reply.body, /sk-secret|stack|internal/);
  }, async () => { throw new Error('token sk-secret-123 at /internal/stack'); });
});

test('panel script renders toasts with textContent only and no innerHTML', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/app.js');
    assert.match(reply.body, /\/memory\/feed/);
    assert.match(reply.body, /toastRoot\.appendChild|textContent = kindLabel/);
    assert.match(reply.body, /textContent = excerpt\(item\.body\)|body\.textContent = text/);
    assert.doesNotMatch(reply.body, /innerHTML|outerHTML|insertAdjacentHTML/);
  });
});

test('index page includes the toast container as a polite live region', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/');
    assert.match(reply.body, /<div class="toasts" id="toasts" aria-live="polite"><\/div>/);
  });
});

test('index page with no running gateway carries a CSP with no frame sources and no iframe', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/');
    const csp = String(reply.headers['content-security-policy']);
    assert.match(csp, /frame-src 'none';/);
    assert.doesNotMatch(csp, /frame-src (?!'none')/);
    assert.match(csp, /script-src 'self';/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(csp, /connect-src 'self';/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal((reply.body.match(/<iframe/g) ?? []).length, 0);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['x-content-type-options'], 'nosniff');
    assert.equal(reply.headers['referrer-policy'], 'no-referrer');
  }, emptyFeed, oneProject, async () => snapshotWith([]));
});

test('index page frames only the aggregator loopback origins, codex first when both run', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/');
    const csp = String(reply.headers['content-security-policy']);
    assert.match(csp, /frame-src http:\/\/localhost:19790 http:\/\/127\.0\.0\.1:19790;/);
    assert.doesNotMatch(csp, /frame-src[^;]*19789/);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /frame-ancestors 'none'/);
  });
});

test('index page frames the claude aggregator alone when codex is not running', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const csp = String((await call(port, '/')).headers['content-security-policy']);
    assert.match(csp, /frame-src http:\/\/localhost:19789 http:\/\/127\.0\.0\.1:19789;/);
  }, emptyFeed, oneProject, async () => snapshotWith(['claude']));
});

test('index page reflects custom gateway ports in its frame policy and its one iframe', async () => {
  const custom = async () => snapshotWith(['claude', 'codex'], { claude: 18789, codex: 18790 });
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/');
    const csp = String(reply.headers['content-security-policy']);
    assert.match(csp, /frame-src http:\/\/localhost:18790 http:\/\/127\.0\.0\.1:18790;/);
    assert.doesNotMatch(csp, /19790|19789/);
    assert.equal((reply.body.match(/<iframe/g) ?? []).length, 1);
    assert.match(reply.body, /src="http:\/\/localhost:18790\/dashboard\?peers=18789"/);
  }, emptyFeed, oneProject, custom);
});

test('index page carries exactly one iframe pointing at the codex aggregator when both gateways run', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/');
    assert.equal((reply.body.match(/<iframe/g) ?? []).length, 1);
    assert.match(reply.body, /src="http:\/\/localhost:19790\/dashboard\?peers=19789"/);
  });
});

test('index page has the stable memory sections in pt-BR', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/');
    assert.match(reply.body, /<html lang="pt-BR">/);
    for (const id of ['live', 'scope', 'state-card', 'state-text', 'state-why', 'm-handoffs', 'm-messages',
      'm-sessions', 'm-observations', 'm-pages', 'm-last', 'recent', 'recent-empty']) {
      assert.match(reply.body, new RegExp(`id="${id}"`), id);
    }
    assert.match(reply.body, /<header>/);
    assert.match(reply.body, /<main>/);
    assert.match(reply.body, /aria-labelledby="pending-title"/);
    assert.match(reply.body, /aria-labelledby="recent-title"/);
  });
});

test('panel script formats times with Intl and never writes HTML', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/app.js');
    assert.match(reply.body, /Intl\.RelativeTimeFormat\('pt-BR'/);
    assert.match(reply.body, /5000/);
    assert.doesNotMatch(reply.body, /innerHTML|outerHTML|insertAdjacentHTML/);
  });
});

test('no response exposes CORS headers', async () => {
  await withDashboard(async () => summarize(briefing(1)), async port => {
    for (const path of ['/', '/app.js', '/memory/summary', '/missing', '/gateways/status']) {
      const reply = await call(port, path);
      assert.equal(reply.headers['access-control-allow-origin'], undefined, path);
    }
  });
});

test('non-GET requests are refused on memory routes', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/memory/summary', { method: 'POST' });
    assert.equal(reply.status, 405);
    assert.equal(reply.headers.allow, 'GET');
  });
});

test('panel script writes untrusted text only through textContent', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/app.js');
    assert.equal(reply.status, 200);
    assert.doesNotMatch(reply.body, /innerHTML/);
    assert.match(reply.body, /textContent/);
  });
});

const twoProjects: ProjectEntry[] = [{ id: 'default', label: 'jev-memory-suite' }, { id: 'project-abc', label: 'example-app' }];

test('memory projects lists each project with an online flag and no-store JSON headers', async () => {
  const summary = async (id?: string) => {
    if (id === 'project-abc') throw new Error('engine down');
    return summarize(briefing(0));
  };
  await withDashboard(summary, async port => {
    const reply = await call(port, '/memory/projects');
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(reply.body), { ok: true, projects: [
      { id: 'default', label: 'jev-memory-suite', online: true },
      { id: 'project-abc', label: 'example-app', online: false },
    ] });
  }, emptyFeed, async () => twoProjects);
});

test('a request to the projects route with a foreign Host header is rejected with 403', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/memory/projects', { host: `evil.com:${port}` });
    assert.equal(reply.status, 403);
  });
});

test('memory summary with an unknown project returns 400 and never calls the summary', async () => {
  const seen: (string | undefined)[] = [];
  await withDashboard(async (id?: string) => { seen.push(id); return summarize(briefing(0)); }, async port => {
    const reply = await call(port, '/memory/summary?project=..%2Fetc');
    assert.equal(reply.status, 400);
    assert.deepEqual(JSON.parse(reply.body), { ok: false, error: 'unknown project' });
  });
  assert.deepEqual(seen, []);
});

test('memory summary without a project parameter selects the current profile', async () => {
  const seen: (string | undefined)[] = [];
  await withDashboard(async (id?: string) => { seen.push(id); return summarize(briefing(0)); }, async port => {
    const reply = await call(port, '/memory/summary');
    assert.equal(reply.status, 200);
  });
  assert.deepEqual(seen, [undefined]);
});

test('memory summary passes a listed project id through', async () => {
  const seen: (string | undefined)[] = [];
  await withDashboard(async (id?: string) => { seen.push(id); return summarize(briefing(0)); }, async port => {
    const reply = await call(port, '/memory/summary?project=project-abc');
    assert.equal(reply.status, 200);
  }, emptyFeed, async () => twoProjects);
  assert.deepEqual(seen, ['project-abc']);
});

test('memory feed restricted to one project rejects an unknown id and tags items with the project', async () => {
  const item: FeedItem = { id: 'o1', kind: 'stop', title: 'T', body: '', createdAt: '2026-10-22T10:00:00Z' };
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const bad = await call(port, '/memory/feed?project=nope');
    assert.equal(bad.status, 400);
    const ok = await call(port, '/memory/feed?project=project-abc');
    assert.deepEqual(JSON.parse(ok.body), { ok: true, items: [{ ...item, projectId: 'project-abc', projectLabel: 'example-app' }] });
  }, async () => ({ ok: true, sessionId: 's', items: [item] }), async () => twoProjects);
});

test('mergeProjectFeeds sorts newest first across projects and caps the total at 30', () => {
  const project: ProjectEntry = { id: 'p', label: 'P' };
  const items: FeedItem[] = Array.from({ length: 40 }, (_, i) => ({
    id: `i${i}`, kind: 'stop', title: '', body: '', createdAt: new Date(Date.UTC(2026, 9, 22, 0, i)).toISOString(),
  }));
  const merged = mergeProjectFeeds([{ project, items }, { project: { id: 'q', label: 'Q' }, items: [{ id: 'x', kind: 'stop', title: '', body: '', createdAt: null }] }]);
  assert.equal(merged.length, 30);
  assert.equal(merged[0]?.id, 'i39');
  assert.equal(merged[0]?.projectLabel, 'P');
  assert.equal(merged.some(i => i.id === 'x'), false);
});

test('panel script reads and writes the project choice only inside try/catch', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/app.js');
    assert.match(reply.body, /jms\.dashboard\.project/);
    assert.match(reply.body, /try \{ return window\.localStorage\.getItem/);
    assert.match(reply.body, /try \{ window\.localStorage\.setItem/);
    assert.match(reply.body, /\/memory\/projects/);
    assert.match(reply.body, /role/);
    assert.doesNotMatch(reply.body, /innerHTML|outerHTML|insertAdjacentHTML/);
  });
});

test('gateways status returns ok with per-client statuses, combined totals and pricing as no-store JSON', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/gateways/status');
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8');
    const body = JSON.parse(reply.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.gateways.map((g: GatewayStatus) => [g.client, g.state, g.metrics]), [['claude', 'running', 'ok'], ['codex', 'running', 'ok']]);
    assert.deepEqual(Object.keys(body.combined).sort(), ['cost', 'history', 'historyCompare', 'models']);
    assert.ok(body.combined.history);
    assert.ok(body.combined.cost.history);
    assert.deepEqual(body.pricing, { models: {}, jev: null });
  });
});

test('gateways status exposes only the aggregator client and port, codex first when both run', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const body = JSON.parse((await call(port, '/gateways/status')).body);
    assert.deepEqual(body.aggregator, { client: 'codex', port: 19790 });
    assert.doesNotMatch(JSON.stringify(body), /origins|peers=|https?:\/\/|localhost|127\.0\.0\.1/);
  });
});

test('gateways status reports a null aggregator when no gateway runs', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const body = JSON.parse((await call(port, '/gateways/status')).body);
    assert.equal(body.aggregator, null);
  }, emptyFeed, oneProject, async () => snapshotWith([]));
});

test('gateways status relays the per-model entries and the pricing echo as the snapshot has them', async () => {
  const base = snapshotWith(['claude', 'codex']);
  const entry = { model: 'model-a', metrics: summarizeRouteEvents([]), cost: { currency: 'USD' as const, llm: 2, jev: null, total: null, missing: ['jev-price', 'jev-output-tokens'] } };
  const snapshot: GatewaySnapshot = {
    ...base,
    gateways: base.gateways.map(g => (g.client === 'claude' ? { ...g, models: { history: [entry] } } : g)),
    pricing: { models: { 'model-a': { source: 'test-llm', verifiedAt: '2026-10-01' } }, jev: null },
  };
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const body = JSON.parse((await call(port, '/gateways/status')).body);
    assert.deepEqual(body.gateways[0].models.history.map((e: { model: string }) => e.model), ['model-a']);
    assert.deepEqual(body.gateways[1].models, { history: [] });
    assert.deepEqual(body.pricing, snapshot.pricing);
  }, emptyFeed, oneProject, async () => snapshot);
});

test('gateways status rejects a foreign Host header with 403', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/gateways/status', { host: `evil.com:${port}` });
    assert.equal(reply.status, 403);
  });
});

test('gateways status exposes no URLs, credentials or key material', async () => {
  const gateways = async (): Promise<GatewaySnapshot> => {
    const base = snapshotWith(['claude', 'codex']);
    return { ...base, gateways: base.gateways.map(g => ({ ...g, history: { ...summarizeRouteEvents([{ mode: 'forced', durationMs: 120 }]), complete: true } })) };
  };
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/gateways/status');
    assert.doesNotMatch(reply.body, /key=|Bearer|authorization|secret|https?:\/\//i);
    assert.match(reply.body, /"durationMsAvg":120/);
  }, emptyFeed, oneProject, gateways);
});

test('gateways status with a non-GET method is refused', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/gateways/status', { method: 'POST' });
    assert.equal(reply.status, 405);
    assert.equal(reply.headers.allow, 'GET');
  });
});

test('a failing gateway check answers ok with no gateways instead of failing', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const status = await call(port, '/gateways/status');
    assert.equal(status.status, 200);
    const body = JSON.parse(status.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.gateways, []);
    assert.equal(body.aggregator, null);
    const index = await call(port, '/');
    assert.equal((index.body.match(/<iframe/g) ?? []).length, 0);
    assert.match(String(index.headers['content-security-policy']), /frame-src 'none';/);
  }, emptyFeed, oneProject, async () => { throw new Error('probe failed at http://127.0.0.1:19790 with secret-token'); });
});

test('the gateway check is cached for a few seconds and loads once for concurrent requests', async () => {
  let loads = 0;
  const gateways = async (): Promise<GatewaySnapshot> => { loads += 1; await new Promise(r => setTimeout(r, 20)); return snapshotWith(['codex']); };
  await withDashboard(async () => summarize(briefing(0)), async port => {
    await Promise.all([call(port, '/gateways/status'), call(port, '/gateways/status')]);
    await call(port, '/gateways/status');
    assert.equal(loads, 1);
  }, emptyFeed, oneProject, gateways);
});

test('the page script polls gateway status and never writes HTML', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/app.js');
    assert.match(reply.body, /\/gateways\/status/);
    assert.doesNotMatch(reply.body, /innerHTML|outerHTML|insertAdjacentHTML/);
  });
});

test('every path is GET-only, including the removed routing path, which answers 405 with allow GET', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    for (const path of ['/', '/app.js', '/memory/summary', '/memory/feed', '/memory/projects', '/gateways/status', '/gateways/routing']) {
      const reply = await call(port, path, { method: 'POST' });
      assert.equal(reply.status, 405, path);
      assert.equal(reply.headers.allow, 'GET', path);
    }
  });
});

test('the routing path is not served by GET either', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    assert.equal((await call(port, '/gateways/routing?client=codex&enabled=true')).status, 404);
  });
});

test('a request with a foreign Host header is refused before the method check', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/gateways/status', { method: 'POST', host: `evil.com:${port}` });
    assert.equal(reply.status, 403);
  });
});
