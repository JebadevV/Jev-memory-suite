// Pure aggregation of Jev Gateway route events into metrics, cost estimates and recent decisions. Purpose: history view.
// Input is untrusted: every field is validated, unknown reasons collapse to 'other', and no raw text is passed through.

export type RouteMode = 'passthrough' | 'none' | 'forced' | 'hint' | 'direct' | 'other';
export interface RouteMetrics {
  events: number; firstAt: string | null; lastAt: string | null;
  modes: Record<RouteMode, number>;
  // Normalized passthrough reasons only (see ALLOWED_REASONS).
  reasons: Record<string, number>;
  jev: {
    calls: number; errors: number; inputTokens: number; outputTokens: null;
    latencyMsAvg: number | null; latencyMsP50: number | null; latencyMsP90: number | null;
    blockingLatencyMs: number;
    confidence: { below50: number; from50to70: number; from70to90: number; atLeast90: number };
  };
  llm: { calls: number; input: number; uncachedInput: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number };
  avoidedLlmCalls: number;
  durationMsAvg: number | null; durationMsP50: number | null; durationMsP90: number | null;
  shadowEvents: number;
}
export interface ModelMetrics { model: string; metrics: RouteMetrics }
export interface RecentDecision {
  time: string | null; mode: RouteMode; model: string; reason: string | null; tool: string | null; confidence: number | null;
  jevLatencyMs: number | null; durationMs: number | null; input: number; cacheRead: number; output: number;
  path: string; tools: number; status: number | null; reasoning: number; shadow: boolean;
}
export interface LlmPrice { inputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number; outputPerMTok: number; currency: 'USD'; source: string; verifiedAt: string }
export interface JevPrice { inputPerMTok: number; outputPerMTok: number; currency: 'USD'; source: string; verifiedAt: string }
export interface CostEstimate { currency: 'USD'; llm: number | null; jev: number | null; total: number | null; missing: string[] }

type LlmTotals = RouteMetrics['llm'];
type ConfidenceCounts = RouteMetrics['jev']['confidence'];
type ConfidenceBucket = keyof ConfidenceCounts;
interface Total { n: number; sum: number }
// Samples keep the newest MAX_SAMPLES values for percentiles; the total keeps an exact running average.
interface Series { total: Total; values: number[]; next: number }

// Opaque to callers: only the functions in this module read or write it.
export interface MetricsAccumulator {
  events: number;
  firstMs: number | null; lastMs: number | null;
  modes: Record<RouteMode, number>;
  reasons: Record<string, number>;
  jev: { calls: number; errors: number; inputTokens: number; blockingLatencyMs: number; confidence: ConfidenceCounts; latency: Series };
  llm: LlmTotals;
  avoidedLlmCalls: number;
  duration: Series;
  shadowEvents: number;
}

interface Stats { avg: number | null; p50: number | null; p90: number | null }
interface SampleTotals { latency: Total; duration: Total }

const KNOWN_MODES = new Set<RouteMode>(['passthrough', 'none', 'forced', 'hint', 'direct']);
const MAX_MODE_CHARS = 40;
const MAX_SAMPLES = 20000;
const MAX_SUMMARY_EVENTS = 5000;
const DEFAULT_RECENT_LIMIT = 20;
const REASON_SCAN_CHARS = 200;
const TOOL_NAME = /^[\p{L}\p{N}_.:/-]{1,128}$/u;
const TOKENS_PER_MTOK = 1_000_000;
const COST_DECIMALS = 10_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// Reason codes the upstream jev-gateway can log. Built from `grep -rhoE "(reason|skip): \"[a-z_]+\"" upstream/jev-gateway/src`
// plus the codes it builds at runtime (upstream_rejected_<mode>, jev_error, router_error, ...). Anything else becomes 'other'.
const ALLOWED_REASONS: ReadonlySet<string> = new Set([
  'agent_message', 'codex_auto_review', 'disabled_by_header', 'hosted_tool_selected', 'incomplete_routing_context',
  'jev_answers_disagree', 'jev_unexpected_answer', 'jev_unknown_tool', 'low_confidence', 'malformed_tools',
  'namespaced_tool_selected', 'no_messages', 'no_tool_needed', 'no_tools', 'previous_response_id', 'routing_disabled',
  'shadow', 'tool_calls', 'tool_use', 'unreadable_request',
  'jev_error', 'router_error', 'upstream_rejected_forced', 'upstream_rejected_none', 'upstream_rejected_hint',
  'upstream_rejected_direct', 'unsupported_encoding', 'unparseable_body',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Finite numbers >= 0, clamped to MAX_SAFE; anything else is absent.
export function safeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, MAX_SAFE);
}
const countOf = (value: unknown): number => safeNumber(value) ?? 0;
const plus = (a: number, b: number): number => Math.min(a + b, MAX_SAFE);

// Shared gate for every entry point: an object with a string mode of bounded length.
export function isRouteEvent(raw: unknown): raw is Record<string, unknown> {
  return isRecord(raw) && typeof raw.mode === 'string' && raw.mode.length <= MAX_MODE_CHARS;
}

export function timeOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
const isoOf = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function zeroModes(): Record<RouteMode, number> {
  return { passthrough: 0, none: 0, forced: 0, hint: 0, direct: 0, other: 0 };
}

export function normalizeMode(raw: unknown): RouteMode {
  return typeof raw === 'string' && KNOWN_MODES.has(raw as RouteMode) ? (raw as RouteMode) : 'other';
}

// Upstream appends detail after a colon ("jev_error: 503 from TypeSafe"); only the code is kept.
export function normalizeReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const head = raw.slice(0, REASON_SCAN_CHARS);
  const colon = head.indexOf(':');
  const code = (colon === -1 ? head : head.slice(0, colon)).trim();
  return ALLOWED_REASONS.has(code) ? code : 'other';
}

function confidenceBucket(confidence: number): ConfidenceBucket {
  if (confidence < 0.5) return 'below50';
  if (confidence < 0.7) return 'from50to70';
  if (confidence < 0.9) return 'from70to90';
  return 'atLeast90';
}

function newSeries(): Series {
  return { total: { n: 0, sum: 0 }, values: [], next: 0 };
}

// Ring buffer: once full, the oldest sample is overwritten.
function addSample(series: Series, value: number): void {
  series.total.n += 1;
  series.total.sum = plus(series.total.sum, value);
  if (series.values.length < MAX_SAMPLES) {
    series.values.push(value);
    return;
  }
  series.values[series.next] = value;
  series.next = (series.next + 1) % MAX_SAMPLES;
}

function averageOf(total: Total): number | null {
  return total.n === 0 ? null : Math.round(total.sum / total.n);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
}

function statsOf(series: Series): Stats {
  const sorted = [...series.values].sort((a, b) => a - b);
  return { avg: averageOf(series.total), p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) };
}

// Exact sums behind each metrics object, so combineMetrics can weight averages correctly.
const totalsByMetrics = new WeakMap<RouteMetrics, SampleTotals>();

export function createAccumulator(): MetricsAccumulator {
  return {
    events: 0, firstMs: null, lastMs: null,
    modes: zeroModes(), reasons: {},
    jev: {
      calls: 0, errors: 0, inputTokens: 0, blockingLatencyMs: 0,
      confidence: { below50: 0, from50to70: 0, from70to90: 0, atLeast90: 0 },
      latency: newSeries(),
    },
    llm: { calls: 0, input: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    avoidedLlmCalls: 0,
    duration: newSeries(),
    shadowEvents: 0,
  };
}

function addJev(acc: MetricsAccumulator, jev: Record<string, unknown>, shadow: boolean): void {
  acc.jev.inputTokens = plus(acc.jev.inputTokens, countOf(jev.inputTokens));
  const latency = safeNumber(jev.latencyMs);
  if (latency !== undefined) {
    addSample(acc.jev.latency, latency);
    // Shadow calls run beside the request, so they do not block it.
    if (!shadow) acc.jev.blockingLatencyMs = plus(acc.jev.blockingLatencyMs, latency);
  }
  const confidence = safeNumber(jev.confidence);
  if (confidence !== undefined) acc.jev.confidence[confidenceBucket(confidence)] += 1;
}

function addUsage(acc: MetricsAccumulator, usage: Record<string, unknown>): void {
  const input = countOf(usage.input);
  const cached = countOf(usage.cached);
  const cacheWrite = countOf(usage.cacheWrite);
  const llm = acc.llm;
  llm.calls += 1;
  llm.input = plus(llm.input, input);
  // usage.input is the total, including cached and cache-write tokens.
  llm.uncachedInput = plus(llm.uncachedInput, Math.max(0, input - cached - cacheWrite));
  llm.cacheRead = plus(llm.cacheRead, cached);
  llm.cacheWrite = plus(llm.cacheWrite, cacheWrite);
  llm.output = plus(llm.output, countOf(usage.output));
  llm.reasoning = plus(llm.reasoning, countOf(usage.reasoning));
}

export function addRouteEvent(acc: MetricsAccumulator, raw: unknown): void {
  if (!isRouteEvent(raw)) return;
  acc.events += 1;
  const mode = normalizeMode(raw.mode);
  acc.modes[mode] += 1;
  const reason = normalizeReason(raw.reason);
  if (mode === 'passthrough' && reason !== null) acc.reasons[reason] = (acc.reasons[reason] ?? 0) + 1;

  const time = timeOf(raw.time);
  if (time !== null) {
    acc.firstMs = Math.min(acc.firstMs ?? time, time);
    acc.lastMs = Math.max(acc.lastMs ?? time, time);
  }

  const shadow = raw.shadowMode === true;
  if (shadow) acc.shadowEvents += 1;
  if (mode === 'direct') acc.avoidedLlmCalls += 1;

  // A Jev call is either a logged jev object or a jev_error reason (which has no object).
  const jev = isRecord(raw.jev) ? raw.jev : undefined;
  const jevError = reason === 'jev_error';
  if (jev || jevError) acc.jev.calls += 1;
  if (jevError) acc.jev.errors += 1;
  if (jev) addJev(acc, jev, shadow);

  if (isRecord(raw.usage)) addUsage(acc, raw.usage);

  const duration = safeNumber(raw.durationMs);
  if (duration !== undefined) addSample(acc.duration, duration);
}

export function finishMetrics(acc: MetricsAccumulator): RouteMetrics {
  const latency = statsOf(acc.jev.latency);
  const duration = statsOf(acc.duration);
  const metrics: RouteMetrics = {
    events: acc.events,
    firstAt: isoOf(acc.firstMs),
    lastAt: isoOf(acc.lastMs),
    modes: { ...acc.modes },
    reasons: { ...acc.reasons },
    jev: {
      calls: acc.jev.calls, errors: acc.jev.errors, inputTokens: acc.jev.inputTokens, outputTokens: null,
      latencyMsAvg: latency.avg, latencyMsP50: latency.p50, latencyMsP90: latency.p90,
      blockingLatencyMs: acc.jev.blockingLatencyMs,
      confidence: { ...acc.jev.confidence },
    },
    llm: { ...acc.llm },
    avoidedLlmCalls: acc.avoidedLlmCalls,
    durationMsAvg: duration.avg, durationMsP50: duration.p50, durationMsP90: duration.p90,
    shadowEvents: acc.shadowEvents,
  };
  totalsByMetrics.set(metrics, { latency: { ...acc.jev.latency.total }, duration: { ...acc.duration.total } });
  return metrics;
}

// The newest 5000 events are read; older ones are ignored.
export function summarizeRouteEvents(events: unknown[]): RouteMetrics {
  const acc = createAccumulator();
  if (!Array.isArray(events)) return finishMetrics(acc);
  for (let i = Math.max(0, events.length - MAX_SUMMARY_EVENTS); i < events.length; i += 1) addRouteEvent(acc, events[i]);
  return finishMetrics(acc);
}

// Totals for a metrics object. Objects not made by finishMetrics (e.g. parsed JSON) are approximated from their counts.
function totalsOf(m: RouteMetrics): SampleTotals {
  const known = totalsByMetrics.get(m);
  if (known) return known;
  const latencyN = m.jev.latencyMsAvg === null ? 0 : countOf(m.jev.calls);
  const durationN = m.durationMsAvg === null ? 0 : countOf(m.events);
  return {
    latency: { n: latencyN, sum: plus(0, latencyN * (m.jev.latencyMsAvg ?? 0)) },
    duration: { n: durationN, sum: plus(0, durationN * (m.durationMsAvg ?? 0)) },
  };
}

export function combineMetrics(list: RouteMetrics[]): RouteMetrics {
  const sum = (pick: (m: RouteMetrics) => unknown): number => list.reduce((total, m) => plus(total, countOf(pick(m))), 0);
  const modes = zeroModes();
  for (const mode of Object.keys(modes) as RouteMode[]) modes[mode] = sum(m => m.modes[mode]);

  const reasons: Record<string, number> = {};
  const reasonKeys = new Set(list.flatMap(m => Object.keys(m.reasons)));
  for (const key of reasonKeys) if (normalizeReason(key) === key) reasons[key] = sum(m => m.reasons[key]);

  const totals = list.map(totalsOf);
  const merge = (pick: (t: SampleTotals) => Total): Total => totals.reduce<Total>(
    (acc, t) => ({ n: acc.n + pick(t).n, sum: plus(acc.sum, pick(t).sum) }), { n: 0, sum: 0 });
  const latency = merge(t => t.latency);
  const duration = merge(t => t.duration);

  const firsts = list.map(m => timeOf(m.firstAt)).filter((ms): ms is number => ms !== null);
  const lasts = list.map(m => timeOf(m.lastAt)).filter((ms): ms is number => ms !== null);
  const result: RouteMetrics = {
    events: sum(m => m.events),
    firstAt: isoOf(firsts.length ? Math.min(...firsts) : null),
    lastAt: isoOf(lasts.length ? Math.max(...lasts) : null),
    modes,
    reasons,
    jev: {
      calls: sum(m => m.jev.calls), errors: sum(m => m.jev.errors), inputTokens: sum(m => m.jev.inputTokens), outputTokens: null,
      latencyMsAvg: averageOf(latency), latencyMsP50: null, latencyMsP90: null,
      blockingLatencyMs: sum(m => m.jev.blockingLatencyMs),
      confidence: {
        below50: sum(m => m.jev.confidence.below50), from50to70: sum(m => m.jev.confidence.from50to70),
        from70to90: sum(m => m.jev.confidence.from70to90), atLeast90: sum(m => m.jev.confidence.atLeast90),
      },
    },
    llm: {
      calls: sum(m => m.llm.calls), input: sum(m => m.llm.input), uncachedInput: sum(m => m.llm.uncachedInput),
      cacheRead: sum(m => m.llm.cacheRead), cacheWrite: sum(m => m.llm.cacheWrite), output: sum(m => m.llm.output),
      reasoning: sum(m => m.llm.reasoning),
    },
    avoidedLlmCalls: sum(m => m.avoidedLlmCalls),
    durationMsAvg: averageOf(duration),
    durationMsP50: null, durationMsP90: null,
    shadowEvents: sum(m => m.shadowEvents),
  };
  totalsByMetrics.set(result, { latency, duration });
  return result;
}

const toolOf = (value: unknown): string | null => (typeof value === 'string' && TOOL_NAME.test(value) ? value : null);

// Whether shadow evaluation recorded this event: a flag set on every line, or the 'shadow' reason (dashboard.html:336).
export function isShadowEvent(raw: Record<string, unknown>): boolean {
  return raw.shadowMode === true || normalizeReason(raw.reason) === 'shadow';
}

// Known API paths only; anything else is 'other', so no arbitrary URL reaches the page (dashboard.html:459 shows the path).
const KNOWN_PATHS: ReadonlySet<string> = new Set(['/v1/messages', '/v1/responses', '/v1/chat/completions']);
const PATH_PREFIXES: readonly (readonly [prefix: string, path: string])[] = [['/v1beta/models', '/v1beta/models'], ['/exa.', '/exa']];
export function pathOf(value: unknown): string {
  if (typeof value !== 'string') return 'other';
  if (KNOWN_PATHS.has(value)) return value;
  return PATH_PREFIXES.find(([prefix]) => value.startsWith(prefix))?.[1] ?? 'other';
}

// HTTP status codes only; anything else is absent.
const statusOf = (value: unknown): number | null => (Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599 ? (value as number) : null);

function decisionOf(raw: Record<string, unknown>): RecentDecision {
  const jev = isRecord(raw.jev) ? raw.jev : {};
  const usage = isRecord(raw.usage) ? raw.usage : {};
  const time = timeOf(raw.time);
  return {
    time: isoOf(time),
    mode: normalizeMode(raw.mode),
    model: modelKey(raw),
    reason: normalizeReason(raw.reason),
    tool: toolOf(raw.tool),
    confidence: safeNumber(raw.confidence) ?? safeNumber(jev.confidence) ?? null,
    jevLatencyMs: safeNumber(jev.latencyMs) ?? null,
    durationMs: safeNumber(raw.durationMs) ?? null,
    input: countOf(usage.input),
    cacheRead: countOf(usage.cached),
    output: countOf(usage.output),
    path: pathOf(raw.path),
    tools: countOf(raw.tools),
    status: statusOf(raw.status),
    reasoning: countOf(usage.reasoning),
    shadow: isShadowEvent(raw),
  };
}

// Newest first: the last element of the array is the newest event.
export function recentDecisions(events: unknown[], limit: number = DEFAULT_RECENT_LIMIT): RecentDecision[] {
  const max = Number.isSafeInteger(limit) && limit >= 0 ? limit : DEFAULT_RECENT_LIMIT;
  const decisions: RecentDecision[] = [];
  if (!Array.isArray(events)) return decisions;
  for (let i = events.length - 1; i >= 0 && decisions.length < max; i -= 1) {
    const raw = events[i];
    if (isRouteEvent(raw)) decisions.push(decisionOf(raw));
  }
  return decisions;
}

const isRate = (value: number): boolean => Number.isFinite(value) && value >= 0;
function llmPriceUsable(price: LlmPrice | undefined): price is LlmPrice {
  return price !== undefined && isRate(price.inputPerMTok) && isRate(price.cacheReadPerMTok)
    && isRate(price.cacheWritePerMTok) && isRate(price.outputPerMTok);
}
function jevPriceUsable(price: JevPrice | undefined): price is JevPrice {
  return price !== undefined && isRate(price.inputPerMTok) && isRate(price.outputPerMTok);
}
const roundCost = (value: number | null): number | null => (value === null ? null : Math.round(value * COST_DECIMALS) / COST_DECIMALS);

// Estimates only from logged counts. Jev output tokens are never logged upstream, so no Jev output cost is ever counted.
export function estimateCost(m: RouteMetrics, llm?: LlmPrice, jev?: JevPrice): CostEstimate {
  const llmCost = llmPriceUsable(llm)
    ? (m.llm.uncachedInput * llm.inputPerMTok + m.llm.cacheRead * llm.cacheReadPerMTok
      + m.llm.cacheWrite * llm.cacheWritePerMTok + m.llm.output * llm.outputPerMTok) / TOKENS_PER_MTOK
    : null;
  const jevCost = jevPriceUsable(jev) ? (m.jev.inputTokens * jev.inputPerMTok) / TOKENS_PER_MTOK : null;
  const missing: string[] = [];
  if (llmCost === null) missing.push('llm-price');
  if (jevCost === null) missing.push('jev-price');
  missing.push('jev-output-tokens');
  const total = llmCost !== null && jevCost !== null ? llmCost + jevCost : null;
  return { currency: 'USD', llm: roundCost(llmCost), jev: roundCost(jevCost), total: roundCost(total), missing };
}

// Per-model breakdown. Billing follows the model actually sent upstream (sentModel), which can differ from the requested model.
const MODEL_NAME = /^[A-Za-z0-9._:\/@-]{1,80}$/;
const DEFAULT_MAX_MODELS = 50;
const OTHER_MODEL = 'other';
const UNKNOWN_MODEL = 'unknown';

const validModel = (value: unknown): string | null => (typeof value === 'string' && MODEL_NAME.test(value) ? value : null);

// First valid of sentModel, model. Absent in both is 'unknown'; present but never valid is 'other'.
export function modelKey(raw: unknown): string {
  if (!isRecord(raw)) return UNKNOWN_MODEL;
  const present = [raw.sentModel, raw.model].filter(value => value !== undefined && value !== null);
  if (present.length === 0) return UNKNOWN_MODEL;
  for (const value of present) {
    const valid = validModel(value);
    if (valid !== null) return valid;
  }
  return OTHER_MODEL;
}

export interface ModelAccumulator {
  maxModels: number;
  // Distinct named models so far; the 'other' bucket is not counted.
  named: number;
  byModel: Map<string, MetricsAccumulator>;
}

export function createModelAccumulator(maxModels: number = DEFAULT_MAX_MODELS): ModelAccumulator {
  const limit = Number.isSafeInteger(maxModels) && maxModels >= 0 ? maxModels : DEFAULT_MAX_MODELS;
  return { maxModels: limit, named: 0, byModel: new Map() };
}

// Models beyond the limit are folded into 'other'; already-known models keep their own bucket.
function bucketFor(acc: ModelAccumulator, key: string): string {
  if (key === OTHER_MODEL || acc.byModel.has(key)) return key;
  return acc.named < acc.maxModels ? key : OTHER_MODEL;
}

export function addModelEvent(acc: ModelAccumulator, raw: unknown): void {
  if (!isRouteEvent(raw)) return;
  const key = bucketFor(acc, modelKey(raw));
  let bucket = acc.byModel.get(key);
  if (!bucket) {
    bucket = createAccumulator();
    acc.byModel.set(key, bucket);
    if (key !== OTHER_MODEL) acc.named += 1;
  }
  addRouteEvent(bucket, raw);
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Most events first, then model name ascending.
export function finishModels(acc: ModelAccumulator): ModelMetrics[] {
  return [...acc.byModel]
    .map(([model, bucket]) => ({ model, metrics: finishMetrics(bucket) }))
    .sort((a, b) => b.metrics.events - a.metrics.events || compareText(a.model, b.model));
}

// Same window as summarizeRouteEvents: the newest 5000 events are read.
export function summarizeByModel(events: unknown[]): ModelMetrics[] {
  const acc = createModelAccumulator();
  if (!Array.isArray(events)) return [];
  for (let i = Math.max(0, events.length - MAX_SUMMARY_EVENTS); i < events.length; i += 1) addModelEvent(acc, events[i]);
  return finishModels(acc);
}
