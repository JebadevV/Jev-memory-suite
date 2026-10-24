import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, symlink } from 'node:fs/promises';
import { configSchema, json, root, profileDir, inside, assertLocal } from '../src/config.js';
test('configuration fails closed on unknown fields, secret URLs, remote HTTP and shared ports', async () => {
  const c = configSchema.parse(await json(resolve(root, 'config/default.json')));
  for (const candidate of [
    { ...c, token: 'secret' }, { ...c, controlPort: c.memory.port },
    { ...c, gateway: { ...c.gateway, upstreamUrl: 'http://api.openai.com/v1' } },
    { ...c, gateway: { ...c.gateway, upstreamUrl: 'https://user:pass@api.openai.com/v1' } },
    { ...c, gateway: { ...c.gateway, jevUrl: 'https://evil.example/v1' } }
  ]) assert.equal(configSchema.safeParse(candidate).success, false);
});
test('dashboard port defaults when absent and must differ from every other service port', async () => {
  const c = configSchema.parse(await json(resolve(root, 'config/default.json')));
  assert.equal(c.dashboard.port, 18879);
  assert.equal(configSchema.safeParse({ ...c, dashboard: { port: c.memory.port } }).success, false);
  assert.equal(configSchema.safeParse({ ...c, dashboard: { port: c.gateway.port } }).success, false);
});
test('managed paths reject traversal and symlinks', async () => {
  assert.throws(() => profileDir('../other')); assert.throws(() => inside(root, '../outside'));
  const dir = await mkdtemp(resolve(root, '.local/path-test-'));
  const link = resolve(dir, 'link'); await symlink(resolve(root, 'docs'), link, 'junction');
  await assert.rejects(assertLocal(resolve(link, 'file')));
});
test('memory.semanticSearch defaults to true for profiles that predate it and accepts an explicit false', async () => {
  const c = configSchema.parse(await json(resolve(root, 'config/default.json')));
  const legacyMemory = { enabled: c.memory.enabled, port: c.memory.port };
  assert.equal(configSchema.parse({ ...c, memory: legacyMemory }).memory.semanticSearch, true);
  assert.equal(configSchema.parse({ ...c, memory: { ...c.memory, semanticSearch: false } }).memory.semanticSearch, false);
});
// A profile written before dashboard redirects, experiments and pricing existed, with those keys removed.
async function legacyConfig(): Promise<Record<string, unknown>> {
  const legacy: Record<string, unknown> = { ...await json(resolve(root, 'config/default.json')) as Record<string, unknown>, dashboard: { port: 18879 } };
  delete legacy.gatewayExperiment; delete legacy.observability;
  return legacy;
}
const validPrice = { currency: 'USD', source: 'vendor pricing page', verifiedAt: '2026-10-01', inputPerMTok: 3, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, outputPerMTok: 15 };
const withModel = (base: Record<string, unknown>, price: unknown, name = 'claude-opus-5-5') =>
  ({ ...base, observability: { pricing: { models: { [name]: price } } } });
test('profiles without the new keys parse with legacy redirect on, both experiments default and no prices', async () => {
  const c = configSchema.parse(await legacyConfig());
  assert.deepEqual(c.dashboard, { port: 18879 });
  assert.deepEqual(c.gatewayExperiment, { claude: 'default', codex: 'default' });
  assert.deepEqual(c.observability, { pricing: { models: {} } });
});
test('empty gatewayExperiment object fills both clients with default', async () => {
  const c = configSchema.parse({ ...await legacyConfig(), gatewayExperiment: {} });
  assert.deepEqual(c.gatewayExperiment, { claude: 'default', codex: 'default' });
});
test('gatewayExperiment rejects a mode outside default, shadow and metering', async () => {
  assert.equal(configSchema.safeParse({ ...await legacyConfig(), gatewayExperiment: { claude: 'live' } }).success, false);
});
test('dashboard rejects the removed legacyRedirect key, whatever its value', async () => {
  assert.equal(configSchema.safeParse({ ...await legacyConfig(), dashboard: { port: 18879, legacyRedirect: true } }).success, false);
  assert.equal(configSchema.safeParse({ ...await legacyConfig(), dashboard: { port: 18879, legacyRedirect: false } }).success, false);
});
test('pricing accepts a two-model map and keeps each model price separate', async () => {
  const base = await legacyConfig();
  const models = { 'claude-opus-5-5': validPrice, 'claude-haiku-5-5': { ...validPrice, inputPerMTok: 1 } };
  const c = configSchema.parse({ ...base, observability: { pricing: { models } } });
  assert.deepEqual(c.observability.pricing.models, models);
});
test('price accepts a valid LLM price and rejects negative, NaN, out-of-range and misdated values', async () => {
  const base = await legacyConfig();
  const withPrice = (price: unknown) => withModel(base, price);
  assert.equal(configSchema.safeParse(withPrice(validPrice)).success, true);
  assert.equal(configSchema.safeParse(withPrice({ ...validPrice, inputPerMTok: -1 })).success, false);
  assert.equal(configSchema.safeParse(withPrice({ ...validPrice, outputPerMTok: Number.NaN })).success, false);
  assert.equal(configSchema.safeParse(withPrice({ ...validPrice, outputPerMTok: 10001 })).success, false);
  assert.equal(configSchema.safeParse(withPrice({ ...validPrice, verifiedAt: '2026/10/01' })).success, false);
});
test('price rejects unknown keys and any currency other than USD', async () => {
  const base = await legacyConfig();
  const withPrice = (price: unknown) => withModel(base, price);
  assert.equal(configSchema.safeParse(withPrice({ ...validPrice, discount: 0.1 })).success, false);
  assert.equal(configSchema.safeParse(withPrice({ ...validPrice, currency: 'EUR' })).success, false);
});
test('model names accept provider-style identifiers up to 80 characters', async () => {
  const base = await legacyConfig();
  for (const name of ['gpt-6.1-sol', 'anthropic/claude:opus@1', 'x'.repeat(80)])
    assert.equal(configSchema.safeParse(withModel(base, validPrice, name)).success, true, name);
});
test('model names reject spaces, empty strings and names longer than 80 characters', async () => {
  const base = await legacyConfig();
  for (const name of ['bad name', '', 'x'.repeat(81)])
    assert.equal(configSchema.safeParse(withModel(base, validPrice, name)).success, false, name);
});
test('pricing accepts up to 100 priced models and rejects 101', async () => {
  const base = await legacyConfig();
  const models = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`model-${i}`, validPrice]));
  assert.equal(configSchema.safeParse({ ...base, observability: { pricing: { models: models(100) } } }).success, true);
  assert.equal(configSchema.safeParse({ ...base, observability: { pricing: { models: models(101) } } }).success, false);
});
test('old claude and codex pricing keys are rejected in favour of the models map', async () => {
  const base = await legacyConfig();
  for (const key of ['claude', 'codex'])
    assert.equal(configSchema.safeParse({ ...base, observability: { pricing: { [key]: validPrice } } }).success, false, key);
});
test('jev price takes input and output rates only and rejects cache fields', async () => {
  const base = await legacyConfig();
  const jev = { currency: 'USD', source: 'jev rate card', verifiedAt: '2026-10-01', inputPerMTok: 1, outputPerMTok: 2 };
  const withJev = (price: unknown) => ({ ...base, observability: { pricing: { jev: price } } });
  assert.equal(configSchema.safeParse(withJev(jev)).success, true);
  assert.equal(configSchema.safeParse(withJev({ ...jev, cacheReadPerMTok: 0.1 })).success, false);
});
test('headroom defaults to off on the pinned release for profiles that predate it', async () => {
  const legacy = await legacyConfig(); delete legacy.headroom;
  assert.deepEqual(configSchema.parse(legacy).headroom, { enabled: false, port: 18880, version: '0.41.0', codex: false });
  assert.deepEqual(configSchema.parse({ ...legacy, headroom: {} }).headroom, { enabled: false, port: 18880, version: '0.41.0', codex: false });
});
test('headroom codex routing is off by default and the Headroom python must be absolute', async () => {
  const c = configSchema.parse(await json(resolve(root, 'config/default.json')));
  assert.equal(c.headroom.codex, false);
  assert.equal(configSchema.safeParse({ ...c, headroom: { ...c.headroom, codex: true } }).success, true);
  assert.equal(configSchema.safeParse({ ...c, headroom: { ...c.headroom, python: 'bin/python' } }).success, false);
  assert.equal(configSchema.safeParse({ ...c, headroom: { ...c.headroom, python: resolve(root, 'python.exe') } }).success, true);
});
test('headroom port must differ from every other service port', async () => {
  const c = configSchema.parse(await json(resolve(root, 'config/default.json')));
  for (const port of [c.controlPort, c.memory.port, c.gateway.port, c.dashboard.port])
    assert.equal(configSchema.safeParse({ ...c, headroom: { ...c.headroom, port } }).success, false, String(port));
});
test('headroom executable must be absolute and the pinned version must be an exact release', async () => {
  const c = configSchema.parse(await json(resolve(root, 'config/default.json')));
  assert.equal(configSchema.safeParse({ ...c, headroom: { ...c.headroom, executable: 'bin/headroom.exe' } }).success, false);
  assert.equal(configSchema.safeParse({ ...c, headroom: { ...c.headroom, executable: resolve(root, 'headroom') } }).success, true);
  assert.equal(configSchema.safeParse({ ...c, headroom: { ...c.headroom, version: '0.41' } }).success, false);
});
