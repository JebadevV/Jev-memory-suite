import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { summarize, summarizeFeed, dashboardHandler, mergeProjectFeeds, type MemoryFeed, type FeedItem } from '../src/dashboard.js';
import type { ProjectEntry } from '../src/dashboard-projects.js';

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

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

async function withDashboard(
  summary: (projectId?: string) => Promise<unknown>,
  run: (port: number) => Promise<void>,
  feed: (projectId?: string) => Promise<MemoryFeed> = emptyFeed,
  projects: () => Promise<ProjectEntry[]> = oneProject,
): Promise<void> {
  let handler: ReturnType<typeof dashboardHandler> | undefined;
  const server: Server = createServer((req, res) => handler?.(req, res));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as AddressInfo).port;
    handler = dashboardHandler({ port, gatewayDashboardUrl: 'http://localhost:8790/dashboard', summary, feed, projects });
    await run(port);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

function call(port: number, path: string, options: { method?: string; host?: string } = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { host: options.host ?? `127.0.0.1:${port}` } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', fail);
    req.end();
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

test('index page carries a CSP scoped to the gateway origin and embeds the iframe', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/');
    const csp = String(reply.headers['content-security-policy']);
    assert.match(csp, /frame-src http:\/\/localhost:8790 http:\/\/127\.0\.0\.1:8790/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(reply.body, /<iframe[^>]*src="http:\/\/localhost:8790\/dashboard"[^>]*sandbox="allow-scripts allow-same-origin"/);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['x-content-type-options'], 'nosniff');
    assert.equal(reply.headers['referrer-policy'], 'no-referrer');
  });
});

test('index page has the stable sections in pt-BR with the panel and gateway frame', async () => {
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
    assert.match(reply.body, /<iframe class="gateway-frame"/);
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
    for (const path of ['/', '/app.js', '/memory/summary', '/missing']) {
      const reply = await call(port, path);
      assert.equal(reply.headers['access-control-allow-origin'], undefined, path);
    }
  });
});

test('non-GET requests are refused', async () => {
  await withDashboard(async () => summarize(briefing(0)), async port => {
    const reply = await call(port, '/memory/summary', { method: 'POST' });
    assert.ok([405, 404].includes(reply.status));
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
