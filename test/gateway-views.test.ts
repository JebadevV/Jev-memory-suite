import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineCompare, compareGroups } from '../src/gateway-views.js';

// A metered passthrough event shaped like the upstream log; overrides replace whole top-level fields.
function ev(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'route', time: '2026-10-01T12:00:00.000Z', path: '/v1/messages', mode: 'passthrough', reason: 'low_confidence',
    usage: { input: 100, output: 10, cached: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 2000, shadowMode: false,
    ...overrides,
  };
}

const withJevA = ev({ mode: 'forced', usage: { input: 1000, output: 100, cached: 600, cacheWrite: 0, reasoning: 20 }, durationMs: 2000 });
const withJevB = ev({ usage: { input: 3000, output: 300, cached: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 4000 });
const baselineC = ev({ reason: 'routing_disabled', usage: { input: 500, output: 50, cached: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 1000 });
const shadowD = ev({ shadowMode: true, reason: 'shadow', usage: { input: 2000, output: 200, cached: 1000, cacheWrite: 0, reasoning: 0 }, durationMs: 3000 });
const shadowG = ev({ shadowMode: true, reason: 'low_confidence', usage: { input: 1000, output: 100, cached: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 1000 });
const direct = ev({ mode: 'direct', reason: undefined, usage: undefined });

test('compareGroups splits metered events into withJev, baseline and shadow', () => {
  // Arrange
  const events = [withJevA, withJevB, baselineC, shadowD, shadowG, direct];

  // Act
  const compare = compareGroups(events);

  // Assert
  assert.equal(compare.withJev.requests, 2);
  assert.equal(compare.baseline.requests, 1);
  assert.equal(compare.shadow?.requests, 2);
});

test('compareGroups averages per request and pools cached share over input tokens', () => {
  // Act
  const { withJev } = compareGroups([withJevA, withJevB]);

  // Assert
  assert.equal(withJev.inputPerRequest, 2000);
  assert.equal(withJev.cachedPct, 15);
  assert.equal(withJev.outputPerRequest, 200);
  assert.equal(withJev.reasoningPerRequest, 10);
  assert.equal(withJev.secondsPerRequest, 3);
  assert.equal(withJev.totalInput, 4000);
});

test('compareGroups ignores events without usage, since they were never metered', () => {
  const unmetered = ev({ usage: undefined });

  const compare = compareGroups([unmetered, withJevA]);

  assert.equal(compare.withJev.requests, 1);
  assert.equal(compare.shadow, null);
});

test('compareGroups counts a routing-off shadow event in both baseline and shadow', () => {
  const both = ev({ reason: 'routing_disabled', shadowMode: true, usage: { input: 10, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 } });

  const compare = compareGroups([both]);

  assert.equal(compare.baseline.requests, 1);
  assert.equal(compare.shadow?.requests, 1);
  assert.equal(compare.withJev.requests, 0);
});

test('compareGroups reports null averages and no shadow row when there are no events', () => {
  const compare = compareGroups([]);

  assert.equal(compare.withJev.requests, 0);
  assert.equal(compare.withJev.inputPerRequest, null);
  assert.equal(compare.withJev.cachedPct, null);
  assert.equal(compare.baseline.secondsPerRequest, null);
  assert.equal(compare.shadow, null);
});

test('compareGroups reports a null cached share when no input tokens were metered', () => {
  const noInput = ev({ usage: { input: 0, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 } });

  const { withJev } = compareGroups([noInput]);

  assert.equal(withJev.cachedPct, null);
  assert.equal(withJev.outputPerRequest, 5);
});

test('combineCompare weights per-request averages by requests and the cached share by input tokens', () => {
  // Arrange
  const one = compareGroups([ev({ mode: 'forced', usage: { input: 1000, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 1000 })]);
  const two = compareGroups([withJevA, withJevB]);

  // Act
  const { withJev } = combineCompare([one, two]);

  // Assert
  assert.equal(withJev.requests, 3);
  assert.ok(withJev.inputPerRequest !== null && Math.abs(withJev.inputPerRequest - 5000 / 3) < 1e-9);
  assert.equal(withJev.totalInput, 5000);
  assert.equal(withJev.cachedPct, 12);
});

test('combineCompare keeps shadow null unless some client has shadow requests', () => {
  const plain = compareGroups([withJevA]);
  const shadowed = compareGroups([shadowD]);
  const other = compareGroups([shadowG]);

  assert.equal(combineCompare([plain]).shadow, null);

  const shadow = combineCompare([shadowed, other, plain]).shadow;
  assert.equal(shadow?.requests, 2);
  assert.equal(shadow?.inputPerRequest, 1500);
  assert.ok(shadow?.cachedPct !== null && Math.abs((shadow?.cachedPct ?? 0) - 100 / 3) < 1e-9);
  assert.equal(shadow?.outputPerRequest, 150);
});

test('combineCompare of an empty list is an empty comparison', () => {
  const combined = combineCompare([]);

  assert.equal(combined.withJev.requests, 0);
  assert.equal(combined.withJev.inputPerRequest, null);
  assert.equal(combined.shadow, null);
});
