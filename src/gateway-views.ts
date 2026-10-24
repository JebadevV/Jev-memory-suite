// Pure comparison views over Jev Gateway route events: the with-Jev, baseline and shadow groups for the token comparison.
// Rules follow the legacy page (upstream/jev-gateway/src/dashboard.html). Input is untrusted; validation is shared with gateway-metrics.

import { isRecord, isRouteEvent, isShadowEvent, normalizeReason, safeNumber } from './gateway-metrics.js';

export interface CompareRow {
  requests: number; inputPerRequest: number | null; cachedPct: number | null; outputPerRequest: number | null;
  reasoningPerRequest: number | null; secondsPerRequest: number | null; totalInput: number;
}
export interface Compare { withJev: CompareRow; baseline: CompareRow; shadow: CompareRow | null }

interface GroupSums { requests: number; input: number; cached: number; output: number; reasoning: number; durationMs: number }
export interface CompareAccumulator { withJev: GroupSums; baseline: GroupSums; shadow: GroupSums }

const asArray = (events: unknown): unknown[] => (Array.isArray(events) ? events : []);
const isBaselineEvent = (raw: Record<string, unknown>): boolean => normalizeReason(raw.reason) === 'routing_disabled';

function emptySums(): GroupSums {
  return { requests: 0, input: 0, cached: 0, output: 0, reasoning: 0, durationMs: 0 };
}

export function createCompareAccumulator(): CompareAccumulator {
  return { withJev: emptySums(), baseline: emptySums(), shadow: emptySums() };
}

function addSums(sums: GroupSums, usage: Record<string, unknown>, durationMs: unknown): void {
  sums.requests += 1;
  sums.input += safeNumber(usage.input) ?? 0;
  sums.cached += safeNumber(usage.cached) ?? 0;
  sums.output += safeNumber(usage.output) ?? 0;
  sums.reasoning += safeNumber(usage.reasoning) ?? 0;
  sums.durationMs += safeNumber(durationMs) ?? 0;
}

// Only metered events (usage present) are compared (dashboard.html:335). A routing-off event can also be a shadow one,
// so each event counts in every group it belongs to: withJev takes the rest (:338).
export function addCompareEvent(acc: CompareAccumulator, raw: unknown): void {
  if (!isRouteEvent(raw) || !isRecord(raw.usage)) return;
  const baseline = isBaselineEvent(raw);
  const shadow = isShadowEvent(raw);
  if (!baseline && !shadow) addSums(acc.withJev, raw.usage, raw.durationMs);
  if (baseline) addSums(acc.baseline, raw.usage, raw.durationMs);
  if (shadow) addSums(acc.shadow, raw.usage, raw.durationMs);
}

function rowOf(sums: GroupSums): CompareRow {
  const n = sums.requests;
  const perRequest = (value: number): number | null => (n === 0 ? null : value / n);
  return {
    requests: n,
    inputPerRequest: perRequest(sums.input),
    cachedPct: sums.input === 0 ? null : (100 * sums.cached) / sums.input,
    outputPerRequest: perRequest(sums.output),
    reasoningPerRequest: perRequest(sums.reasoning),
    secondsPerRequest: perRequest(sums.durationMs / 1000),
    totalInput: sums.input,
  };
}

export function finishCompare(acc: CompareAccumulator): Compare {
  return { withJev: rowOf(acc.withJev), baseline: rowOf(acc.baseline), shadow: acc.shadow.requests > 0 ? rowOf(acc.shadow) : null };
}

export function compareGroups(events: unknown[]): Compare {
  const acc = createCompareAccumulator();
  for (const raw of asArray(events)) addCompareEvent(acc, raw);
  return finishCompare(acc);
}

// Weighted mean of the non-null values; weight is requests for per-request values, input tokens for the cached share.
function pooled(rows: CompareRow[], pick: (row: CompareRow) => number | null, weightOf: (row: CompareRow) => number): number | null {
  let total = 0;
  let weight = 0;
  for (const row of rows) {
    const value = pick(row);
    if (value === null) continue;
    total += value * weightOf(row);
    weight += weightOf(row);
  }
  return weight === 0 ? null : total / weight;
}

function combineRows(rows: CompareRow[]): CompareRow {
  const requests = rows.reduce((sum, row) => sum + row.requests, 0);
  return {
    requests,
    inputPerRequest: pooled(rows, row => row.inputPerRequest, row => row.requests),
    cachedPct: pooled(rows, row => row.cachedPct, row => row.totalInput),
    outputPerRequest: pooled(rows, row => row.outputPerRequest, row => row.requests),
    reasoningPerRequest: pooled(rows, row => row.reasoningPerRequest, row => row.requests),
    secondsPerRequest: pooled(rows, row => row.secondsPerRequest, row => row.requests),
    totalInput: rows.reduce((sum, row) => sum + row.totalInput, 0),
  };
}

// Pools several clients' comparisons: per-request figures are weighted by requests, so the result equals the pooled average.
export function combineCompare(list: Compare[]): Compare {
  const shadow = combineRows(list.flatMap(compare => (compare.shadow ? [compare.shadow] : [])));
  return {
    withJev: combineRows(list.map(compare => compare.withJev)),
    baseline: combineRows(list.map(compare => compare.baseline)),
    shadow: shadow.requests > 0 ? shadow : null,
  };
}
