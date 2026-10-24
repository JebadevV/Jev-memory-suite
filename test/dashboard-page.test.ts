import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHtml } from '../src/dashboard-page.js';
import { dashboardJs } from '../src/dashboard-script.js';
import { dashboardCss } from '../src/dashboard-style.js';
import type { Aggregator } from '../src/gateways.js';

const AGGREGATOR: Aggregator = { client: 'codex', port: 8790, origins: ['http://localhost:8790', 'http://127.0.0.1:8790'], url: 'http://localhost:8790/dashboard?peers=8789' };
const QUOTED = { ...AGGREGATOR, url: 'http://localhost:8790/dashboard?peers="8789"&x=<1>' };
const OBS_SCOPES = ['claude', 'codex', 'agy', 'combined'];
const OBS_ROW_KEYS = ['requests', 'jevCalls', 'jevInput', 'jevOutput', 'llmInput', 'cacheRead', 'cacheWrite', 'llmOutput', 'blocking', 'avoided', 'cost', 'period'];

test('html with an aggregator renders exactly one iframe pointing at it', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.equal(html.split('<iframe').length - 1, 1);
  assert.ok(html.includes('src="http://localhost:8790/dashboard?peers=8789"'));
  assert.ok(html.includes('sandbox="allow-scripts allow-same-origin"'));
  assert.ok(html.includes('data-aggregator="codex:8790"'));
  assert.ok(html.includes('id="gateway-slot"'));
  assert.equal(html.includes('Gateways offline'), false);
});

test('html escapes quotes and markup in the aggregator url', () => {
  const html = dashboardHtml(QUOTED);
  assert.ok(html.includes('src="http://localhost:8790/dashboard?peers=&quot;8789&quot;&amp;x=&lt;1&gt;"'));
  assert.equal(html.includes('peers="8789"'), false);
  assert.equal(html.includes('x=<1>'), false);
});

test('html without an aggregator renders no iframe and the offline fallback in the same slot', () => {
  const html = dashboardHtml(null);
  assert.equal(html.includes('<iframe'), false);
  assert.ok(html.includes('id="gateway-slot" data-aggregator="none"'));
  assert.ok(html.includes('Gateways offline'));
  assert.ok(html.includes('jev-memory-codex'));
  assert.ok(html.includes('jev-memory-claude'));
});

test('html has the aggregator-change notice hidden by default', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.match(html, /<p class="empty" id="gateway-notice" role="status" hidden>/);
});

test('html has the token observability section with claude, codex and combined cards', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.ok(html.includes('id="token-observability"'));
  assert.ok(html.includes('Observabilidade de tokens (histórico do log)'));
  for (const scope of OBS_SCOPES) {
    assert.ok(html.includes(`id="obs-${scope}"`), `missing card obs-${scope}`);
    assert.ok(html.includes(`id="obs-${scope}-state"`), `missing state obs-${scope}`);
    assert.ok(html.includes(`id="obs-${scope}-experiment"`), `missing experiment obs-${scope}`);
    assert.ok(html.includes(`id="obs-${scope}-models-body"`), `missing models body obs-${scope}`);
    assert.ok(html.includes(`id="obs-${scope}-compare-body"`), `missing compare body obs-${scope}`);
    assert.ok(html.includes(`id="obs-${scope}-compare-note"`), `missing compare note obs-${scope}`);
    for (const key of OBS_ROW_KEYS) {
      assert.ok(html.includes(`id="obs-${scope}-${key}"`), `missing obs-${scope}-${key}`);
    }
  }
  assert.ok(html.includes('Chamadas Jev (erros)'));
  assert.ok(html.includes('LLM saída (raciocínio)'));
  assert.ok(html.includes('Latência adicionada pelo Jev (total)'));
  assert.ok(html.includes('Chamadas LLM evitadas (direct)'));
  assert.ok(html.includes('Com Jev × Baseline (histórico)'));
  assert.ok(html.includes('não representam cobrança de assinatura nem economia confirmada'));
  assert.ok(html.includes('Tokens de saída do Jev não são registrados pelo gateway.'));
});

test('html labels the Antigravity card and the combined card of all three clients', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.ok(html.includes('id="obs-agy"'));
  assert.ok(html.includes('>Antigravity</h3>'));
  assert.ok(html.includes('Combinado (Claude + Codex + Antigravity)'));
  assert.ok(html.includes('id="obs-agy-compare-title"'));
  assert.ok(html.includes('id="obs-agy-compare-wrap"'));
  assert.ok(html.indexOf('id="obs-codex"') < html.indexOf('id="obs-agy"'));
  assert.ok(html.indexOf('id="obs-agy"') < html.indexOf('id="obs-combined"'));
});

test('script counts all three clients and states that Antigravity is passthrough', () => {
  assert.ok(dashboardJs.includes("var GW_CLIENTS = ['claude', 'codex', 'agy'];"));
  assert.ok(dashboardJs.includes('Passthrough: este gateway não roteia pelo Jev.'));
  assert.ok(dashboardJs.includes('Somente Claude e Codex entram nesta comparação.'));
});

test('html puts the observability section before the embedded gateway panel', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.ok(html.indexOf('id="token-observability"') < html.indexOf('id="gateway-slot"'));
});

test('each client card names its cost as an API price estimate and has a billing line; the combined card has none', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.ok(html.includes('Estimativa de preço de API (USD)'));
  for (const scope of ['claude', 'codex', 'agy']) assert.ok(html.includes(`id="obs-${scope}-billing"`), scope);
  assert.equal(html.includes('id="obs-combined-billing"'), false);
});

test('script words the billing line for subscription, api and unknown, and marks alias, expiry and missing Jev price', () => {
  for (const text of [
    'Cobrança real: assinatura (custo por token não se aplica)', 'Cobrança real: API por token', 'Base de cobrança não configurada',
    'preço equivalente assumido', 'preço vencido em', 'sem preço do Jev', 'válido até',
  ]) assert.ok(dashboardJs.includes(text), text);
});

test('html has no toolbar, timeline, request table, router state or csrf meta', () => {
  const html = dashboardHtml(AGGREGATOR);
  for (const absent of ['gw-toolbar', 'gw-timeline', 'gw-requests', 'gw-recent-body', 'gw-router', 'gw-toggle',
    'jms-csrf', 'data-gw-client', 'data-gw-range', 'gw-share', 'gw-legend', 'gw-compare-window']) {
    assert.equal(html.includes(absent), false, `unexpected ${absent}`);
  }
});

test('script has no innerHTML, eval or iframe usage', () => {
  assert.equal(dashboardJs.includes('innerHTML'), false);
  assert.equal(dashboardJs.includes('eval('), false);
  assert.equal(dashboardJs.includes('iframe'), false);
});

test('script has no routing endpoint, csrf header or toggle', () => {
  assert.equal(dashboardJs.includes('/gateways/routing'), false);
  assert.equal(dashboardJs.includes('x-jms-csrf'), false);
  assert.equal(dashboardJs.includes('jms-csrf'), false);
});

test('script polls the gateway status and keeps the aggregator notice', () => {
  assert.ok(dashboardJs.includes('/gateways/status'));
  assert.ok(dashboardJs.includes('gateway-notice'));
  assert.ok(dashboardJs.includes("data-aggregator"));
});

test('generated script is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(dashboardJs));
});

test('style keeps the gateway frame rules', () => {
  assert.ok(dashboardCss.includes('.gateway-frame'));
  assert.ok(dashboardCss.includes('.gateway-frame.gateway-tall { height: 80vh; }'));
  assert.ok(dashboardCss.includes('.gateway-offline'));
});

test('style has no rules for the removed native gateway views', () => {
  for (const removed of ['.gw-toolbar', '.gw-timeline', '.gw-requests', '.gw-router', '.gw-toggle', '.gw-share', '.gw-compare-window', '.cat-', '.k-routing', '.gw-stale-']) {
    assert.equal(dashboardCss.includes(removed), false, `unexpected rule ${removed}`);
  }
});
