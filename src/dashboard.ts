// Suite dashboard: AI Memory panel and the upstream gateway aggregator frame, served on loopback only.
// Purpose: maintainers and operators. Date: 2026-10-22.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { profileDir, readConfig } from './config.js';
import { ACTIVE_SESSION_FILE } from './hook.js';
import { Mcp } from './mcp.js';
import { listProjects, type ProjectEntry } from './dashboard-projects.js';
import { dashboardHtml } from './dashboard-page.js';
import { dashboardJs } from './dashboard-script.js';
import { createHistoryReader, historyFile } from './gateway-history.js';
import {
  emptySnapshot, gatewaySnapshot, upstreamGateways,
  type Aggregator, type GatewaySnapshot, type GatewaySnapshotOptions,
} from './gateways.js';

const MAX_RECENT = 5;
const MAX_TEXT = 120;
const MAX_KIND = 40;
const SUMMARY_TTL_MS = 3000;
const FEED_TTL_MS = 2000;
const FEED_LIMIT = 10;
const FEED_BODY_MAX_CHARS = 300;
// Merged toasts across all projects; the panel only ever shows the newest few.
const FEED_MERGED_LIMIT = 30;
// A stalled engine must not hold up the whole panel, so each project gets a short answer window.
const ONLINE_TIMEOUT_MS = 2000;
// Same shape the hook writes; anything else is treated as no active session.
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

// Optional blocks may be absent in older engines; the panel shows a dash instead of failing.
const briefingSchema = z.object({
  scope: z.object({ workspace: z.string(), project: z.string() }).optional(),
  counts: z.object({ sessions: z.number(), observations: z.number(), pages_latest: z.number() }),
  activity_7d: z.object({ sessions: z.number(), observations: z.number(), pages_updated: z.number() }).optional(),
  last_observation_at: z.string().nullable(),
  pending_handoff_count: z.number(),
  pending_message_count: z.number(),
  recent_pages: z.array(z.object({
    path: z.string(), title: z.string(), updated_at: z.string().optional(), kind: z.string().optional(),
  })),
});
const clip = (text: string, max = MAX_TEXT): string => text.slice(0, max);

// Keeps only the fields the panel shows; unknown briefing fields are ignored by zod.
export function summarize(briefing: unknown) {
  const b = briefingSchema.parse(briefing);
  const activity = b.activity_7d;
  return {
    ok: true as const,
    scope: b.scope ?? null,
    counts: { sessions: b.counts.sessions, observations: b.counts.observations, pages: b.counts.pages_latest },
    activity7d: activity ? { sessions: activity.sessions, observations: activity.observations, pagesUpdated: activity.pages_updated } : null,
    lastObservationAt: b.last_observation_at,
    pendingHandoffs: b.pending_handoff_count,
    pendingMessages: b.pending_message_count,
    recent: b.recent_pages.slice(0, MAX_RECENT).map(p => ({
      title: clip(p.title),
      path: clip(p.path),
      kind: p.kind === undefined ? null : clip(p.kind, MAX_KIND),
      updatedAt: p.updated_at ?? null,
    })),
  };
}
// memoryPort is added by startDashboard from the profile config, not from the briefing.
export type MemorySummary = ReturnType<typeof summarize> & { memoryPort: number };

const feedSchema = z.object({
  observations: z.array(z.object({
    id: z.string().min(1).max(200), kind: z.string().max(64), title: z.string().nullish(),
    body: z.string().nullish(), created_at: z.string().nullish(),
  })),
});
export interface FeedItem { id: string; kind: string; title: string; body: string; createdAt: string | null }
export type MemoryFeed = { ok: true; sessionId: string | null; items: FeedItem[] };
export interface ProjectFeedItem extends FeedItem { projectId: string; projectLabel: string }
export interface ProjectStatus extends ProjectEntry { online: boolean }

// Keeps only the observation fields the toasts show; bodies are bounded again here in case the engine ignores its limit.
export function summarizeFeed(observations: unknown): FeedItem[] {
  return feedSchema.parse(observations).observations.map(o => ({
    id: o.id, kind: clip(o.kind, MAX_KIND), title: clip(o.title ?? ''), body: clip(o.body ?? '', FEED_BODY_MAX_CHARS), createdAt: o.created_at ?? null,
  }));
}

// Newest first across projects; a missing or unparsable timestamp sorts last.
const createdRank = (iso: string | null): number => {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(time) ? 0 : time;
};
export function mergeProjectFeeds(feeds: { project: ProjectEntry; items: FeedItem[] }[]): ProjectFeedItem[] {
  return feeds
    .flatMap(({ project, items }) => items.map(item => ({ ...item, projectId: project.id, projectLabel: project.label })))
    .sort((a, b) => createdRank(b.createdAt) - createdRank(a.createdAt))
    .slice(0, FEED_MERGED_LIMIT);
}

export interface DashboardOptions {
  port: number; gateways: () => Promise<GatewaySnapshot>;
  projects: () => Promise<ProjectEntry[]>;
  // Undefined selects the current suite profile; any other id must come from `projects`.
  summary: (projectId?: string) => Promise<unknown>;
  feed: (projectId?: string) => Promise<MemoryFeed>;
}

// Rejects when the work does not settle in time; a synchronous throw inside `work` also rejects.
function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error('timed out')), ms); });
  return Promise.race([new Promise<T>(ok => ok(work())), limit]).finally(() => clearTimeout(timer));
}

const GATEWAY_TTL_MS = 5000;
// Only the aggregator's own loopback origins may be framed; with no aggregator nothing may be.
const frameSources = (aggregator?: Aggregator): string => (aggregator ? aggregator.origins.join(' ') : "'none'");
const contentSecurityPolicy = (aggregator?: Aggregator): string =>
  `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src ${frameSources(aggregator)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

// One load at a time. A failed load is answered as an empty snapshot and cached like a success, so a broken check is not retried on every request.
function cachedSnapshots(load: () => Promise<GatewaySnapshot>): () => Promise<GatewaySnapshot> {
  let cached: { at: number; value: GatewaySnapshot } | undefined;
  let inflight: Promise<GatewaySnapshot> | undefined;
  const refresh = (): Promise<GatewaySnapshot> => new Promise<GatewaySnapshot>(ok => ok(load()))
    .catch(() => {
      process.stderr.write('dashboard: gateway status unavailable\n');
      return emptySnapshot();
    })
    .then(value => { cached = { at: Date.now(), value }; return value; })
    .finally(() => { inflight = undefined; });
  return () => {
    if (cached && Date.now() - cached.at < GATEWAY_TTL_MS) return Promise.resolve(cached.value);
    inflight ??= refresh();
    return inflight;
  };
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', text: 'text/plain; charset=utf-8' };
const OFFLINE_BODY = JSON.stringify({ ok: false, error: 'memory offline' });
const UNKNOWN_PROJECT_BODY = JSON.stringify({ ok: false, error: 'unknown project' });

export function dashboardHandler(opts: DashboardOptions): (req: IncomingMessage, res: ServerResponse) => void {
  // Exact Host match blocks DNS rebinding; a missing Host is rejected too.
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const gatewaysOf = cachedSnapshots(opts.gateways);
  const send = (res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { ...HEADERS, 'content-type': type, ...extra }).end(body);
  };
  // Errors never reach the client; only a generic line goes to the supervisor log.
  async function jsonOrOffline(label: string, load: () => Promise<unknown>): Promise<string> {
    try { return JSON.stringify(await load()); }
    catch {
      process.stderr.write(`dashboard: memory ${label} unavailable\n`);
      return OFFLINE_BODY;
    }
  }
  // A listing failure is answered like any memory failure, so no route throws out of the handler.
  async function listedProjects(): Promise<ProjectEntry[] | null> {
    try { return await opts.projects(); }
    catch { process.stderr.write('dashboard: project list unavailable\n'); return null; }
  }
  // Undefined means "no project parameter"; null means the id is not a listed project. The id is only compared, never used to build a path.
  function pickProject(listed: ProjectEntry[], params: URLSearchParams): string | undefined | null {
    if (!params.has('project')) return undefined;
    const wanted = params.get('project');
    return listed.find(p => p.id === wanted)?.id ?? null;
  }
  // A project that fails or stalls is skipped rather than failing the merged feed.
  async function isOnline(id: string): Promise<boolean> {
    return withTimeout(() => opts.summary(id), ONLINE_TIMEOUT_MS).then(() => true, () => false);
  }
  async function feedOf(id: string): Promise<FeedItem[]> {
    // Offline projects are expected here; the projects route reports them instead of logging on every poll.
    try { return (await withTimeout(() => opts.feed(id), ONLINE_TIMEOUT_MS)).items; }
    catch { return []; }
  }
  async function projectsRoute(res: ServerResponse): Promise<void> {
    const listed = await listedProjects();
    if (!listed) return send(res, 200, TYPES.json, OFFLINE_BODY);
    const projects: ProjectStatus[] = await Promise.all(listed.map(async p => ({ id: p.id, label: p.label, online: await isOnline(p.id) })));
    return send(res, 200, TYPES.json, JSON.stringify({ ok: true, projects }));
  }
  async function summaryRoute(res: ServerResponse, params: URLSearchParams): Promise<void> {
    const listed = await listedProjects();
    if (!listed) return send(res, 200, TYPES.json, OFFLINE_BODY);
    const id = pickProject(listed, params);
    if (id === null) return send(res, 400, TYPES.json, UNKNOWN_PROJECT_BODY);
    return send(res, 200, TYPES.json, await jsonOrOffline('summary', () => opts.summary(id)));
  }
  async function feedRoute(res: ServerResponse, params: URLSearchParams): Promise<void> {
    const listed = await listedProjects();
    if (!listed) return send(res, 200, TYPES.json, JSON.stringify({ ok: true, items: [] }));
    const id = pickProject(listed, params);
    if (id === null) return send(res, 400, TYPES.json, UNKNOWN_PROJECT_BODY);
    const targets = listed.filter(p => id === undefined || p.id === id);
    const feeds = await Promise.all(targets.map(async project => ({ project, items: await feedOf(project.id) })));
    return send(res, 200, TYPES.json, JSON.stringify({ ok: true, items: mergeProjectFeeds(feeds) }));
  }
  // The page is built per request from the cached snapshot, so its frame and CSP always match the aggregator it names.
  async function indexRoute(res: ServerResponse): Promise<void> {
    const { aggregator } = await gatewaysOf();
    return send(res, 200, TYPES.html, dashboardHtml(aggregator ?? null), { 'content-security-policy': contentSecurityPolicy(aggregator) });
  }
  // Only the aggregator's client and port are exposed; its URL and origins stay server-side.
  async function gatewaysRoute(res: ServerResponse): Promise<void> {
    const { aggregator, ...snapshot } = await gatewaysOf();
    const exposed = aggregator ? { client: aggregator.client, port: aggregator.port } : null;
    return send(res, 200, TYPES.json, JSON.stringify({ ok: true, ...snapshot, aggregator: exposed }));
  }
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has(req.headers.host ?? '')) return send(res, 403, TYPES.text, 'Forbidden');
    if (req.method !== 'GET') return send(res, 405, TYPES.text, 'Method Not Allowed', { allow: 'GET' });
    const raw = req.url ?? '', cut = raw.indexOf('?');
    const path = cut < 0 ? raw : raw.slice(0, cut);
    const params = new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1));
    switch (path) {
      case '/': return indexRoute(res);
      case '/gateways/status': return gatewaysRoute(res);
      case '/app.js': return send(res, 200, TYPES.js, dashboardJs);
      case '/memory/projects': return projectsRoute(res);
      case '/memory/summary': return summaryRoute(res, params);
      case '/memory/feed': return feedRoute(res, params);
      default: return send(res, 404, TYPES.text, 'Not Found');
    }
  }
  return (req, res) => { void route(req, res); };
}

// Missing file means no session yet; any other read error is a real failure and propagates.
async function readActiveSession(name: string): Promise<string | null> {
  try { return (await readFile(resolve(profileDir(name), ACTIVE_SESSION_FILE), 'utf8')).trim(); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

interface ProjectState { mcp?: Mcp; summary?: { at: number; value: MemorySummary }; feed?: { at: number; value: MemoryFeed } }

// The supervisor owns this server: each project keeps one MCP session, rebuilt after a failure, and its summary and feed are cached briefly.
// Gateway prices and experiment modes are read from the suite config once at start; the history readers live as long as the server.
export async function startDashboard(name: string): Promise<Server> {
  const { dashboard, observability, gatewayExperiment } = await readConfig(name);
  // State exists only for ids the listing returned; the handler validates ids before they reach these functions.
  const states = new Map<string, ProjectState>();
  const stateOf = (id: string): ProjectState => {
    const known = states.get(id) ?? {};
    states.set(id, known);
    return known;
  };
  const summary = async (projectId?: string): Promise<MemorySummary> => {
    const id = projectId ?? name, state = stateOf(id);
    if (state.summary && Date.now() - state.summary.at < SUMMARY_TTL_MS) return state.summary.value;
    try {
      const { workspace, project, memory } = await readConfig(id);
      const mcp = (state.mcp ??= await Mcp.connect(id));
      const briefing = await mcp.call('memory_briefing', { workspace, project, recent_pages_limit: MAX_RECENT });
      const value: MemorySummary = { ...summarize(briefing), memoryPort: memory.port };
      state.summary = { at: Date.now(), value };
      return value;
    } catch (e) {
      state.mcp = undefined;
      throw e;
    }
  };
  const feed = async (projectId?: string): Promise<MemoryFeed> => {
    const id = projectId ?? name, state = stateOf(id);
    if (state.feed && Date.now() - state.feed.at < FEED_TTL_MS) return state.feed.value;
    try {
      const raw = await readActiveSession(id);
      const sessionId = raw && SESSION_ID_PATTERN.test(raw) ? raw : null;
      let items: FeedItem[] = [];
      if (sessionId) {
        const { workspace, project } = await readConfig(id);
        const mcp = (state.mcp ??= await Mcp.connect(id));
        const observations = await mcp.call('memory_read_session_observations', { workspace, project, session_id: sessionId, order: 'desc', limit: FEED_LIMIT, body_max_chars: FEED_BODY_MAX_CHARS });
        items = summarizeFeed(observations);
      }
      const value: MemoryFeed = { ok: true, sessionId, items };
      state.feed = { at: Date.now(), value };
      return value;
    } catch (e) {
      state.mcp = undefined;
      throw e;
    }
  };
  const readers = { claude: createHistoryReader(historyFile('claude')), codex: createHistoryReader(historyFile('codex')) };
  const gatewayOptions: GatewaySnapshotOptions = {
    pricing: { models: observability.pricing.models, jev: observability.pricing.jev },
    experiment: gatewayExperiment,
    history: { claude: () => readers.claude.refresh(), codex: () => readers.codex.refresh() },
  };
  // The gateways are the ports the upstream launchers use, read from the supervisor environment on each check.
  const gateways = async (): Promise<GatewaySnapshot> => gatewaySnapshot(await upstreamGateways(), gatewayOptions);
  const handler = dashboardHandler({ port: dashboard.port, gateways, projects: () => listProjects(name), summary, feed });
  const server = createServer(handler);
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(dashboard.port, '127.0.0.1', ok); });
  return server;
}
