// Upstream launcher gateways (claude, codex and agy): where they listen, whether they answer, their normalized route data and the aggregator the dashboard frames. Purpose: operators.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gatewayDir } from './install.js';
import type { HistoryResult } from './gateway-history.js';
import {
  chooseLlmPrice, combineMetrics, estimateCost, estimateModelCost, isLlmMissing, modelKey, percentile, safeNumber, statusOf,
  type CostEstimate, type JevPrice, type LlmPrice, type ModelMetrics, type RouteMetrics,
} from './gateway-metrics.js';
import { combineCompare, type Compare } from './gateway-views.js';
import { defaultBilling, type BillingMode } from './config.js';

export type UpstreamClient = 'claude' | 'codex' | 'agy';
export interface UpstreamGateway {
  client: UpstreamClient; label: string; portEnv: string; port: number;
  // 'fallback' when the installed upstream spec was missing or unusable and the built-in values were used.
  source: 'installed' | 'fallback';
  // False when the env override is set but is not a usable port; the spec default is used instead.
  portValid: boolean; origin: string; dashboardUrl: string;
}
export interface GatewayProbe { state: 'running' | 'stopped' | 'unavailable'; pid?: number; upstream?: string; codeAssist?: number }
interface PortSpec { portEnv: string; defaultPort: number }
interface ResolvedSpec extends PortSpec { source: 'installed' | 'fallback' }

const MIN_PORT = 1024, MAX_PORT = 65535, PROBE_TIMEOUT_MS = 1000;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,60}$/;
const LABELS: Record<UpstreamClient, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
// Same values as upstream bin/clients.mjs; used only when the installed spec cannot be read.
const FALLBACK: Record<UpstreamClient, PortSpec> = {
  claude: { portEnv: 'JEV_CLAUDE_PORT', defaultPort: 8789 },
  codex: { portEnv: 'JEV_CODEX_PORT', defaultPort: 8790 },
  agy: { portEnv: 'JEV_AGY_PORT', defaultPort: 8794 },
};
// Codex first: whichever gateway answers serves the one dashboard page for both clients.
const AGGREGATOR_ORDER: readonly UpstreamClient[] = ['codex', 'claude'];
// Antigravity always runs in passthrough, so it has no experiment mode of its own.
const PASSTHROUGH_CLIENTS: readonly UpstreamClient[] = ['agy'];
// A client without its installed spec has only a guessed port, so it is not probed and reads as unavailable.
const UNPROBED_WITHOUT_SPEC: readonly UpstreamClient[] = ['agy'];

const validPort = (value: number): boolean => Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;

/** An env value the launcher can listen on: decimal digits only, 1024-65535. Anything else is undefined. */
export function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const port = Number(raw);
  return validPort(port) ? port : undefined;
}

// A spec that does not look like the upstream one is replaced by the built-in values, and says so.
function specOf(spec: Partial<PortSpec> | undefined, client: UpstreamClient): ResolvedSpec {
  const portEnv = spec?.portEnv, defaultPort = spec?.defaultPort;
  if (typeof portEnv === 'string' && ENV_NAME.test(portEnv) && typeof defaultPort === 'number' && validPort(defaultPort))
    return { portEnv, defaultPort, source: 'installed' };
  return { ...FALLBACK[client], source: 'fallback' };
}
// Reads the installed bin/clients.mjs the way the suite reads its codex spec. A missing install is not an error here.
async function upstreamSpecs(dir?: string): Promise<Record<UpstreamClient, ResolvedSpec>> {
  let mod: Partial<Record<UpstreamClient, Partial<PortSpec>>> = {};
  try {
    mod = await import(pathToFileURL(resolve(dir ?? gatewayDir(), 'bin', 'clients.mjs')).href) as typeof mod;
  } catch {
    // Not installed or unreadable: both clients fall back, and doctor reports the source.
  }
  return { claude: specOf(mod.claude, 'claude'), codex: specOf(mod.codex, 'codex'), agy: specOf(mod.agy, 'agy') };
}

/** Where each upstream launcher listens. An env override is used only when it is a usable port. */
export async function upstreamGateways(env: NodeJS.ProcessEnv = process.env, dir?: string): Promise<UpstreamGateway[]> {
  const specs = await upstreamSpecs(dir);
  return (['claude', 'codex', 'agy'] as const).map(client => {
    const { portEnv, defaultPort, source } = specs[client];
    const raw = env[portEnv], override = parsePort(raw), port = override ?? defaultPort;
    return {
      client, label: LABELS[client], portEnv, port, source,
      portValid: raw === undefined || override !== undefined,
      origin: `http://127.0.0.1:${port}`, dashboardUrl: `http://localhost:${port}/dashboard`,
    };
  });
}

// A refused connection means nothing listens on the port; fetch wraps the socket error as its cause.
export function isConnectionRefused(error: unknown): boolean {
  const cause = error instanceof TypeError ? (error.cause as NodeJS.ErrnoException | undefined) : undefined;
  return cause?.code === 'ECONNREFUSED';
}

// Loopback IPv4 only: the probe never reaches another host, whatever the origin says.
function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch { return false; }
}

// The gateway reports where it forwards traffic; credentials, query and fragment are never shown.
function safeUpstream(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.username || url.password || url.search || url.hash ? undefined : `${url.origin}${url.pathname}`;
  } catch { return undefined; }
}

// Code Assist mode is reported as a small integer; anything else is absent.
const codeAssistOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 99 ? value : undefined);

function healthOf(body: unknown): GatewayProbe {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || (body as { status?: unknown }).status !== 'ok') return { state: 'unavailable' };
  const { pid, upstream, codeAssist } = body as { pid?: unknown; upstream?: unknown; codeAssist?: unknown };
  const probe: GatewayProbe = { state: 'running' };
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) probe.pid = pid;
  const safe = safeUpstream(upstream);
  if (safe !== undefined) probe.upstream = safe;
  const mode = codeAssistOf(codeAssist);
  if (mode !== undefined) probe.codeAssist = mode;
  return probe;
}

/**
 * Asks a gateway's /health the way the upstream launcher does. Errors are reduced to a state:
 * their text can carry URLs and other private details, so none of it is returned.
 */
export async function probeGateway(origin: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<GatewayProbe> {
  if (!isLoopbackOrigin(origin)) return { state: 'unavailable' };
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      return { state: 'unavailable' };
    }
    return healthOf(await response.json());
  } catch (error) {
    return { state: isConnectionRefused(error) ? 'stopped' : 'unavailable' };
  }
}

export interface Aggregator { client: UpstreamClient; port: number; origins: string[]; url: string }
/**
 * The gateway whose dashboard shows both clients: the first running one in AGGREGATOR_ORDER.
 * Its URL names the other configured ports in ?peers= so the page also polls the second gateway.
 */
export function aggregatorFor(gateways: UpstreamGateway[], states: Partial<Record<UpstreamClient, GatewayProbe['state']>>): Aggregator | undefined {
  const client = AGGREGATOR_ORDER.find(name => states[name] === 'running');
  const gateway = gateways.find(g => g.client === client);
  if (!gateway) return undefined;
  // Only the clients this page shows are named as peers; the Antigravity port is not part of the frame.
  const peers = [...new Set(gateways.filter(g => AGGREGATOR_ORDER.includes(g.client)).map(g => g.port)
    .filter(port => port !== gateway.port && validPort(port)))];
  const query = peers.length ? `?peers=${peers.join(',')}` : '';
  return {
    client: gateway.client, port: gateway.port,
    origins: [`http://localhost:${gateway.port}`, `http://127.0.0.1:${gateway.port}`],
    url: `http://localhost:${gateway.port}/dashboard${query}`,
  };
}

export type GatewayMetrics = 'ok' | 'auth-required' | 'unavailable' | 'offline';
export type GatewayExperiment = 'default' | 'shadow' | 'metering' | 'passthrough';
// The router's routing state and counters. The upstream is origin and path only (see safeUpstream); the Jev model and
// provider are kept only when they match a plain name pattern. Anything else is null.
export interface RouterInfo {
  routing: boolean; shadow: boolean; minConfidence: number | null; recorded: number; startedAt: string | null;
  upstream: string | null; jevModel: string | null; jevProvider: string | null;
}
// One model's share of a history: its metrics and its own cost estimate (billing follows the model actually sent).
export interface ModelEntry { model: string; metrics: RouteMetrics; cost: CostEstimate }
export interface GatewayModels { history: ModelEntry[] }
// Antigravity's live state: content-free counts, sums and a short list of safe fields from the gateway's in-memory events.
export interface AgyRecent {
  time: string | null; model: string; method: string; status: number | null; durationMs: number | null;
  input: number; cacheRead: number; output: number; reasoning: number;
}
export interface AgyLive {
  pid: number | null;
  // Code Assist mode from /health: an integer 1..99, otherwise null.
  codeAssist: number | null;
  routing: boolean;
  startedAt: string | null;
  // The gateway's events since it started (newest 1000 at most).
  window: {
    requests: number; errors: number;
    statuses: { ok: number; clientError: number; serverError: number; other: number };
    input: number; cacheRead: number; output: number; reasoning: number;
    durationMsP50: number | null; durationMsP90: number | null;
    firstAt: string | null; lastAt: string | null;
  };
  // Newest first, at most 15.
  recent: AgyRecent[];
}
export interface GatewayStatus {
  client: UpstreamClient; label: string; port: number; portValid: boolean; state: GatewayProbe['state'];
  metrics: GatewayMetrics; router: RouterInfo | null;
  history: (RouteMetrics & { complete: boolean }) | null;
  // The all-time comparison from the log; null when there is no history.
  historyCompare: Compare | null;
  cost: { history: CostEstimate | null };
  models: GatewayModels;
  experiment: GatewayExperiment;
  // How this client's tokens are paid for (observability.billing). The cost figures are API price estimates either way.
  billing: BillingMode;
  // Antigravity only (the key is absent for other clients). Null when the gateway is not running or its events were not readable.
  agyLive?: AgyLive | null;
}
export interface PriceInfo { source: string; verifiedAt: string; validUntil?: string }
export interface GatewaySnapshot {
  generatedAt: string; gateways: GatewayStatus[];
  combined: {
    history: RouteMetrics;
    cost: { history: CostEstimate };
    models: GatewayModels;
    historyCompare: Compare | null;
  };
  pricing: { models: Record<string, PriceInfo>; jev: PriceInfo | null };
  // Set only when a gateway can be framed; the page names this origin in its iframe and CSP.
  aggregator?: Aggregator;
}
export interface GatewayFetchOptions { fetch?: typeof fetch; timeoutMs?: number }
export interface GatewaySnapshotOptions extends GatewayFetchOptions {
  pricing?: { models?: Record<string, LlmPrice>; jev?: JevPrice; aliases?: Record<string, string> };
  billing?: Partial<Record<UpstreamClient, BillingMode>>;
  // The instant that price validity is judged at; defaults to now.
  now?: Date;
  experiment?: Partial<Record<UpstreamClient, GatewayExperiment>>;
  history?: Partial<Record<UpstreamClient, () => Promise<HistoryResult | null>>>;
}

const EVENTS_TIMEOUT_MS = 1500, EVENTS_MAX_BYTES = 2 * 1024 * 1024;
const CLIENT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
// A Jev model or provider name as the router reports it; anything with spaces, '=' or other symbols is dropped.
const LABEL_TEXT = /^[A-Za-z0-9._:\/@-]{1,80}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const AUTH_STATUSES: readonly number[] = [401, 403];
const COST_DECIMALS = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const unitOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);
const countOf = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
function isoTimeOf(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const labelOf = (value: unknown): string | null => (typeof value === 'string' && LABEL_TEXT.test(value) ? value : null);

// Strict: a router block that does not match is treated as missing. Optional fields that do not match are dropped.
function routerInfoOf(raw: unknown): RouterInfo | undefined {
  if (!isRecord(raw) || typeof raw.client !== 'string' || !CLIENT_NAME.test(raw.client)) return undefined;
  if (typeof raw.routing !== 'boolean' || (raw.shadow !== undefined && typeof raw.shadow !== 'boolean')) return undefined;
  return {
    routing: raw.routing, shadow: raw.shadow === true, minConfidence: unitOf(raw.minConfidence),
    recorded: countOf(raw.recorded), startedAt: isoTimeOf(raw.startedAt),
    upstream: safeUpstream(raw.upstream) ?? null, jevModel: labelOf(raw.jevModel), jevProvider: labelOf(raw.jevProvider),
  };
}

// Reads at most maxBytes of the body; a longer one is cancelled and rejected.
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0, text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('body too large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const discard = async (response: Response): Promise<void> => { await response.body?.cancel().catch(() => undefined); };

type EventsRead = { metrics: 'ok'; router: RouterInfo; events: unknown[] } | { metrics: 'auth-required' | 'unavailable' };

// The router block is the status data for every client. The events list is passed on, but only Antigravity reads it (see inspectGateway).
function eventsBodyOf(raw: unknown): EventsRead {
  const router = isRecord(raw) ? routerInfoOf(raw.router) : undefined;
  const events = isRecord(raw) ? raw.events : undefined;
  return router && Array.isArray(events) ? { metrics: 'ok', router, events } : { metrics: 'unavailable' };
}

// Plain GET without credentials: no key, cookie or Authorization is ever sent, and redirects are not followed.
async function eventsOf(origin: string, options: GatewayFetchOptions): Promise<EventsRead> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(`${origin}/dashboard/events?since=0`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? EVENTS_TIMEOUT_MS), redirect: 'error', credentials: 'omit',
    });
    if (AUTH_STATUSES.includes(response.status)) {
      await discard(response);
      return { metrics: 'auth-required' };
    }
    if (!response.ok) {
      await discard(response);
      return { metrics: 'unavailable' };
    }
    return eventsBodyOf(JSON.parse(await readCapped(response, EVENTS_MAX_BYTES)));
  } catch {
    return { metrics: 'unavailable' };
  }
}

// A loader that throws is logged generically and treated as no history, so the snapshot never fails on the log.
async function historyOf(load: (() => Promise<HistoryResult | null>) | undefined): Promise<HistoryResult | null> {
  if (!load) return null;
  try {
    return await load();
  } catch {
    process.stderr.write('gateways: history unavailable\n');
    return null;
  }
}

interface GatewayPart { status: GatewayStatus; historyMetrics: RouteMetrics | null }

const roundCost = (value: number): number => Math.round(value * COST_DECIMALS) / COST_DECIMALS;
// The prices and the day they are judged on (UTC). A price is still valid on its validUntil day.
interface PriceContext { models?: Record<string, LlmPrice>; aliases?: Record<string, string>; jev?: JevPrice; today: string }
const contextOf = (options: GatewaySnapshotOptions): PriceContext => ({
  models: options.pricing?.models, aliases: options.pricing?.aliases, jev: options.pricing?.jev,
  today: (options.now ?? new Date()).toISOString().slice(0, 10),
});
const echoPrice = (price: { source: string; verifiedAt: string; validUntil?: string }): PriceInfo =>
  ({ source: price.source, verifiedAt: price.verifiedAt, ...(price.validUntil !== undefined ? { validUntil: price.validUntil } : {}) });
const billingOf = (options: GatewaySnapshotOptions, client: UpstreamClient): BillingMode => options.billing?.[client] ?? defaultBilling[client];

// One model's estimate: its rate is chosen by chooseLlmPrice (own price, alias, or none); Jev uses the gateway-wide price.
const modelCostOf = (model: string, metrics: RouteMetrics, ctx: PriceContext): CostEstimate =>
  estimateModelCost(model, metrics, chooseLlmPrice(ctx.models, ctx.aliases, model, ctx.today), ctx.jev);

// Per-model estimates.
function entriesOf(models: ModelMetrics[], ctx: PriceContext): ModelEntry[] {
  return models.map(({ model, metrics }) => ({ model, metrics, cost: modelCostOf(model, metrics, ctx) }));
}

// Client and combined cost. LLM is the sum of the model estimates, unknown if any model that made calls has no usable price.
// Jev has one price for the whole gateway, so it is estimated once from the total metrics.
function aggregateCost(entries: ModelEntry[], total: RouteMetrics, jev: JevPrice | undefined): CostEstimate {
  const unpriced = entries.filter(entry => entry.cost.llm === null && entry.metrics.llm.calls > 0);
  const llm = unpriced.length > 0 ? null : roundCost(entries.reduce((sum, entry) => sum + (entry.cost.llm ?? 0), 0));
  const jevEstimate = estimateCost(total, undefined, jev), jevCost = jevEstimate.jev;
  const missing = new Set<string>([
    ...unpriced.flatMap(entry => entry.cost.missing.filter(isLlmMissing)),
    ...jevEstimate.missing.filter(item => item.startsWith('jev-')),
  ]);
  const aliased: Record<string, string> = {};
  for (const entry of entries) Object.assign(aliased, entry.cost.aliased);
  const cost: CostEstimate = {
    currency: 'USD', llm, jev: jevCost, total: llm !== null && jevCost !== null ? roundCost(llm + jevCost) : null,
    missing: [...missing],
  };
  if (Object.keys(aliased).length > 0) cost.aliased = aliased;
  return cost;
}

// The probe for one gateway; a client without its installed spec is reported unavailable without any connection attempt.
const probeOf = (gateway: UpstreamGateway): Promise<GatewayProbe> =>
  UNPROBED_WITHOUT_SPEC.includes(gateway.client) && gateway.source === 'fallback'
    ? Promise.resolve({ state: 'unavailable' })
    : probeGateway(gateway.origin);

// Antigravity live window. Only counts, sums, validated numbers, a normalized model and a method name leave this block:
// no path, header, prompt, tool name or other free text is copied.
const AGY_RECENT_LIMIT = 15, AGY_WINDOW_LIMIT = 1000;
const V1INTERNAL_METHOD = /^\/v1internal:([A-Za-z]{1,64})$/;
const amountOf = (value: unknown): number => safeNumber(value) ?? 0;
const addAmount = (a: number, b: number): number => Math.min(a + b, Number.MAX_SAFE_INTEGER);
const methodOf = (value: unknown): string => (typeof value === 'string' ? V1INTERNAL_METHOD.exec(value)?.[1] : undefined) ?? 'other';

function agyRecentOf(raw: Record<string, unknown>): AgyRecent {
  const usage = isRecord(raw.usage) ? raw.usage : {};
  return {
    time: isoTimeOf(raw.time), model: modelKey(raw), method: methodOf(raw.path), status: statusOf(raw.status),
    durationMs: safeNumber(raw.durationMs) ?? null,
    input: amountOf(usage.input), cacheRead: amountOf(usage.cached), output: amountOf(usage.output), reasoning: amountOf(usage.reasoning),
  };
}

// 2xx and 3xx are ok, 4xx client errors, 5xx server errors; a missing, invalid or 1xx status is other.
function statusBucketOf(status: number | null): keyof AgyLive['window']['statuses'] {
  if (status === null || status < 200) return 'other';
  if (status < 400) return 'ok';
  return status < 500 ? 'clientError' : 'serverError';
}

function agyWindowOf(records: Record<string, unknown>[]): AgyLive['window'] {
  const statuses = { ok: 0, clientError: 0, serverError: 0, other: 0 };
  const sums = { input: 0, cacheRead: 0, output: 0, reasoning: 0 };
  const durations: number[] = [], instants: number[] = [];
  let errors = 0;
  for (const raw of records) {
    const status = statusOf(raw.status);
    statuses[statusBucketOf(status)] += 1;
    // A missing status counts as an error, as does any status of 400 or more.
    if (status === null || status >= 400) errors += 1;
    const usage = isRecord(raw.usage) ? raw.usage : {};
    sums.input = addAmount(sums.input, amountOf(usage.input));
    sums.cacheRead = addAmount(sums.cacheRead, amountOf(usage.cached));
    sums.output = addAmount(sums.output, amountOf(usage.output));
    sums.reasoning = addAmount(sums.reasoning, amountOf(usage.reasoning));
    const duration = safeNumber(raw.durationMs);
    if (duration !== undefined) durations.push(duration);
    const time = isoTimeOf(raw.time);
    if (time !== null) instants.push(Date.parse(time));
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const first = instants.length > 0 ? Math.min(...instants) : null, last = instants.length > 0 ? Math.max(...instants) : null;
  return {
    requests: records.length, errors, statuses, ...sums,
    durationMsP50: percentile(sorted, 0.5), durationMsP90: percentile(sorted, 0.9),
    firstAt: first === null ? null : new Date(first).toISOString(),
    lastAt: last === null ? null : new Date(last).toISOString(),
  };
}

// The events are oldest first, so the newest ones are at the end of the list.
function agyLiveOf(probe: GatewayProbe, router: RouterInfo, events: unknown[]): AgyLive {
  const records = events.filter(isRecord).slice(-AGY_WINDOW_LIMIT);
  return {
    pid: probe.pid ?? null, codeAssist: probe.codeAssist ?? null,
    routing: router.routing, startedAt: router.startedAt,
    window: agyWindowOf(records),
    recent: records.slice(-AGY_RECENT_LIMIT).reverse().map(agyRecentOf),
  };
}

async function inspectGateway(gateway: UpstreamGateway, options: GatewaySnapshotOptions, probe?: GatewayProbe): Promise<GatewayPart> {
  const { client, label, port, portValid, origin } = gateway;
  const ctx = contextOf(options);
  const [current, history] = await Promise.all([probe ?? probeOf(gateway), historyOf(options.history?.[client])]);
  // Events are read only from a running gateway. Only its router block is kept, except for Antigravity's window.
  const read = current.state === 'running' ? await eventsOf(origin, options) : undefined;
  const metrics: GatewayMetrics = current.state === 'running' ? (read?.metrics ?? 'unavailable') : (current.state === 'stopped' ? 'offline' : 'unavailable');
  const router = read?.metrics === 'ok' ? read.router : null;
  const historyModels = entriesOf(history?.byModel ?? [], ctx);
  const status: GatewayStatus = {
    client, label, port, portValid, state: current.state, metrics, router,
    history: history ? { ...history.metrics, complete: history.complete } : null,
    historyCompare: history?.compare ?? null,
    cost: { history: history ? aggregateCost(historyModels, history.metrics, ctx.jev) : null },
    models: { history: historyModels },
    experiment: PASSTHROUGH_CLIENTS.includes(client) ? 'passthrough' : (options.experiment?.[client] ?? 'default'),
    billing: billingOf(options, client),
  };
  // Only Antigravity carries the key; the shape of the other clients' statuses is unchanged.
  if (client === 'agy') status.agyLive = read?.metrics === 'ok' ? agyLiveOf(current, read.router, read.events) : null;
  return { status, historyMetrics: history?.metrics ?? null };
}

/** One gateway's status for the dashboard. Probes first; events are read only from a running gateway. */
export async function gatewayStatus(gateway: UpstreamGateway, options: GatewaySnapshotOptions = {}): Promise<GatewayStatus> {
  return (await inspectGateway(gateway, options)).status;
}

// Same model name across clients is one model: its metrics are merged, then priced once with the configured rates.
function mergeModelEntries(lists: ModelEntry[][], ctx: PriceContext): ModelEntry[] {
  const byName = new Map<string, RouteMetrics[]>();
  for (const entry of lists.flat()) byName.set(entry.model, [...(byName.get(entry.model) ?? []), entry.metrics]);
  return [...byName]
    .map(([model, parts]) => {
      const metrics = combineMetrics(parts);
      return { model, metrics, cost: modelCostOf(model, metrics, ctx) };
    })
    .sort((a, b) => b.metrics.events - a.metrics.events || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

// Pools the routed clients' comparisons; with none, there is nothing to compare. Passthrough clients are left out:
// their events are all "routing disabled", which would count as a baseline they never had.
const combinedCompareOf = (parts: GatewayPart[]): Compare | null => {
  const list = parts.flatMap(part => (part.status.historyCompare && !PASSTHROUGH_CLIENTS.includes(part.status.client) ? [part.status.historyCompare] : []));
  return list.length > 0 ? combineCompare(list) : null;
};

// Pricing echo: source, verifiedAt and validUntil only. Rates never leave the server.
function assemble(parts: GatewayPart[], options: GatewaySnapshotOptions, aggregator?: Aggregator): GatewaySnapshot {
  const histories = parts.flatMap(part => (part.historyMetrics ? [part.historyMetrics] : []));
  const history = combineMetrics(histories);
  const statuses = parts.map(part => part.status);
  const ctx = contextOf(options);
  const historyModels = mergeModelEntries(statuses.map(status => status.models.history), ctx);
  return {
    generatedAt: new Date().toISOString(),
    gateways: statuses,
    combined: {
      history,
      cost: { history: aggregateCost(historyModels, history, ctx.jev) },
      models: { history: historyModels },
      historyCompare: combinedCompareOf(parts),
    },
    pricing: {
      models: Object.fromEntries(Object.entries(options.pricing?.models ?? {}).map(([model, price]) => [model, echoPrice(price)])),
      jev: ctx.jev ? echoPrice(ctx.jev) : null,
    },
    ...(aggregator ? { aggregator } : {}),
  };
}

/** Every gateway's status plus the combined totals, computed from the same probes. The aggregator is chosen from those probes. */
export async function gatewaySnapshot(gateways: UpstreamGateway[], options: GatewaySnapshotOptions = {}): Promise<GatewaySnapshot> {
  const probes = await Promise.all(gateways.map(probeOf));
  const states: Partial<Record<UpstreamClient, GatewayProbe['state']>> = {};
  gateways.forEach((gateway, index) => {
    const probe = probes[index];
    if (probe) states[gateway.client] = probe.state;
  });
  const parts = await Promise.all(gateways.map((gateway, index) => inspectGateway(gateway, options, probes[index])));
  return assemble(parts, options, aggregatorFor(gateways, states));
}

/** The snapshot with no gateways: used when the check itself fails, so the page still has a valid shape. */
export function emptySnapshot(): GatewaySnapshot {
  return assemble([], {});
}
