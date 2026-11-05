import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHtml } from '../src/dashboard-page.js';
import { dashboardJs } from '../src/dashboard-script.js';
import { dashboardCss } from '../src/dashboard-style.js';
import type { Aggregator } from '../src/gateways.js';

const AGGREGATOR: Aggregator = { client: 'codex', port: 8790, origins: ['http://localhost:8790', 'http://127.0.0.1:8790'], url: 'http://localhost:8790/dashboard?peers=8789' };
const QUOTED = { ...AGGREGATOR, url: 'http://localhost:8790/dashboard?peers="8789"&x=<1>' };
const OBS_SCOPES = ['claude', 'codex', 'combined'];
const OBS_ROW_KEYS = ['requests', 'jevCalls', 'jevInput', 'jevOutput', 'llmInput', 'cacheRead', 'cacheWrite', 'llmOutput', 'blocking', 'avoided', 'cost', 'period'];
const AGY_IDS = [
  'obs-agy', 'obs-agy-name', 'obs-agy-state', 'obs-agy-why', 'obs-agy-mode', 'obs-agy-contract', 'obs-agy-pid', 'obs-agy-uptime',
  'obs-agy-upstream', 'obs-agy-billing', 'obs-agy-requests', 'obs-agy-requests-sub', 'obs-agy-input', 'obs-agy-input-sub',
  'obs-agy-output', 'obs-agy-output-sub', 'obs-agy-latency', 'obs-agy-latency-sub', 'obs-agy-errors', 'obs-agy-errors-sub',
  'obs-agy-kpi-errors', 'obs-agy-last', 'obs-agy-last-sub', 'obs-agy-models-body', 'obs-agy-models-empty', 'obs-agy-recent',
  'obs-agy-recent-empty', 'obs-agy-period',
];
const AGY_REMOVED_IDS = ['obs-agy-jevCalls', 'obs-agy-cost', 'obs-agy-compare-body', 'obs-agy-experiment', 'obs-agy-blocking', 'obs-agy-compare-title', 'obs-agy-compare-wrap', 'obs-agy-compare-note', 'obs-agy-models'];
// The six views in tab order; the overview is the default.
const VIEW_KEYS = ['overview', 'combined', 'claude', 'codex', 'agy', 'gateway'];
// The Antigravity view runs from its id to the end of the main column (the Jev Gateway view sits after it).
const agySection = (html: string): string => html.slice(html.indexOf('id="gw-panel-agy"'), html.indexOf('</main>'));

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

test('html has the token observability views with claude, codex and combined data', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.ok(html.includes('id="token-observability"'));
  assert.ok(html.includes('Totais do log completo do launcher, por provedor, modelo e custo estimado.'));
  for (const scope of OBS_SCOPES) {
    assert.ok(html.includes(`id="obs-${scope}"`), `missing card obs-${scope}`);
    assert.ok(html.includes(`id="obs-${scope}-state"`), `missing state obs-${scope}`);
    assert.ok(html.includes(`id="obs-${scope}-experiment"`), `missing experiment obs-${scope}`);
    assert.ok(html.includes(`id="obs-${scope}-models-body"`), `missing models body obs-${scope}`);
    assert.ok(html.includes(`id="obs-${scope}-models-total-requests"`), `missing models footer obs-${scope}`);
    assert.ok(html.includes(`id="obs-${scope}-compare-body"`), `missing compare body obs-${scope}`);
    assert.ok(html.includes(`id="obs-${scope}-compare-note"`), `missing compare note obs-${scope}`);
    for (const key of OBS_ROW_KEYS) {
      assert.ok(html.includes(`id="obs-${scope}-${key}"`), `missing obs-${scope}-${key}`);
    }
    for (const key of ['llmInput-sub', 'llmOutput-sub', 'latency', 'latency-sub', 'models-count']) {
      assert.ok(html.includes(`id="obs-${scope}-${key}"`), `missing obs-${scope}-${key}`);
    }
  }
  assert.ok(html.includes('Chamadas Jev (erros)'));
  assert.ok(html.includes('Saída'));
  assert.ok(html.includes('Latência adicionada pelo Jev (total)'));
  assert.ok(html.includes('Chamadas LLM evitadas (direct)'));
  assert.ok(html.includes('Com Jev × Baseline (histórico)'));
  assert.ok(html.includes('não representam cobrança de assinatura nem economia confirmada'));
  assert.ok(html.includes('Tokens de saída do Jev não são registrados pelo gateway.'));
});

test('html has a dedicated Antigravity view after the Claude and Codex views, and the Tokens view first', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.match(html, /<article class="gw-card view-card" id="obs-agy" aria-labelledby="obs-agy-name" data-tone="s-idle">/);
  assert.match(html, /<h2 class="view-title" id="obs-agy-name"><span class="client-name"><img [^>]*>Google Antigravity<\/span><\/h2>/);
  assert.ok(html.includes('Jev Gateway v2 · passthrough'));
  assert.ok(html.includes('Total combinado'));
  assert.ok(html.indexOf('id="gw-panel-combined"') < html.indexOf('id="gw-panel-claude"'));
  assert.ok(html.indexOf('id="gw-panel-codex"') < html.indexOf('id="gw-panel-agy"'));
});

test('html gives the Antigravity view its ids and drops the Jev, cost and comparison parts', () => {
  const html = dashboardHtml(AGGREGATOR);
  for (const id of AGY_IDS) assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  for (const id of AGY_REMOVED_IDS) assert.equal(html.includes(`id="${id}"`), false, `unexpected ${id}`);
  const panel = agySection(html);
  assert.equal(panel.includes('gw-table'), false, 'the Antigravity view has no wide model table');
  assert.equal(panel.includes('Com Jev × Baseline'), false);
  assert.equal(panel.includes('Estimativa de preço de API'), false);
  assert.equal(panel.includes('Chamadas Jev'), false);
  assert.ok(panel.includes('id="obs-agy-billing"'));
  for (const label of ['Modo', 'Code Assist', 'PID', 'Ativo há', 'Upstream', 'Cobrança', 'Requisições', 'Entrada', 'Saída',
    'Latência p50', 'Erros (janela recente)', 'Última requisição', 'Modelos (', 'Atividade recente (', 'Ficha do gateway']) {
    assert.ok(panel.includes(label), `missing label ${label}`);
  }
});

test('html keeps the Antigravity billing line in the gateway spec card', () => {
  const panel = agySection(dashboardHtml(AGGREGATOR));
  assert.match(panel, /<h3 class="card-title" id="agy-facts-title">Ficha do gateway<\/h3>[\s\S]*id="obs-agy-billing"[\s\S]*<\/dl>/);
});

test('script counts all three clients and states that Antigravity is passthrough', () => {
  assert.ok(dashboardJs.includes("var GW_CLIENTS = ['claude', 'codex', 'agy'];"));
  assert.ok(dashboardJs.includes('Tráfego do Google Antigravity vai direto ao Google; o Jev só observa.'));
  // The Claude Code and Codex comparison note is written once, at the top of the Tokens view (static markup).
  assert.equal(dashboardHtml(AGGREGATOR).split('Somente Claude Code e OpenAI Codex entram nesta comparação.').length - 1, 1);
  assert.ok(dashboardJs.includes("var GW_NAMES = { claude: 'Claude Code', codex: 'OpenAI Codex', agy: 'Google Antigravity' };"));
});

test('html shows the product names and no old short client labels', () => {
  const html = dashboardHtml(AGGREGATOR);
  for (const name of ['Claude Code', 'OpenAI Codex', 'Google Antigravity']) assert.ok(html.includes(name), name);
  assert.ok(html.includes('Jev Gateway · '));
  assert.equal(html.includes('Claude + Codex'), false);
  assert.equal(html.includes('>Claude</h3>'), false);
  assert.equal(html.includes('Os hooks do Claude/Codex'), false);
});

test('html shows the three client icons as inline PNG data URIs with empty alt text', () => {
  const html = dashboardHtml(AGGREGATOR);
  const tags = html.match(/<img class="client-icon[^>]*>/g) ?? [];
  // Sidebar entries (3), top tabs (3), provider cards (3), the Claude, Codex and Antigravity view titles (3), the gateway heading (2).
  assert.equal(tags.length, 14);
  for (const tag of tags) {
    assert.match(tag, / alt="" /);
    assert.match(tag, /src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  }
  const sources = new Set(tags.map((tag) => /src="([^"]+)"/.exec(tag)?.[1]));
  assert.equal(sources.size, 3);
});

test('the page has one view per section with the five primary numbers on the provider views', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 6, 'overview, Tokens, Claude Code, OpenAI Codex, Google Antigravity, Jev Gateway');
  // Claude Code, OpenAI Codex and Antigravity each have a KPI row; the Tokens view has provider cards instead.
  assert.equal((html.match(/<dl class="kpis">/g) ?? []).length, 3);
  // Claude and Codex each have a cost disclosure; the Tokens view has the cost and the Jev metrics disclosures.
  assert.equal((html.match(/<summary>/g) ?? []).length, 4);
  assert.match(html, /<div class="gateway-views" id="token-observability"/);
});

test('view tabs are ARIA tabs: six tabs, one selected, and only the overview visible', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.match(html, /<nav class="tabs" id="gw-tablist" role="tablist"/);
  const tablist = html.slice(html.indexOf('id="gw-tablist"'), html.indexOf('class="scrim"'));
  assert.equal((tablist.match(/role="tab"/g) ?? []).length, 6);
  assert.equal((tablist.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.match(html, /id="gw-tab-overview"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  for (const key of VIEW_KEYS) {
    assert.match(html, new RegExp(`id="gw-tab-${key}"[^>]*aria-controls="gw-panel-${key}"`), key);
    assert.match(html, new RegExp(`<section class="view"[^>]*id="gw-panel-${key}"[^>]*role="tabpanel"[^>]*aria-labelledby="gw-tab-${key}"`), key);
  }
  const panels = html.match(/<section class="view"[^>]*>/g) ?? [];
  assert.equal(panels.length, 6);
  assert.equal(panels.filter(tag => tag.includes(' hidden')).length, 5);
  assert.equal(panels.some(tag => tag.includes('id="gw-panel-overview"') && !tag.includes(' hidden')), true, 'the overview is the default');
});

test('the sidebar is the primary navigation, and the menu button controls it as a drawer below 1000px', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.match(html, /<aside class="sidebar" id="sidebar" data-open="false" aria-label="Navegação">/);
  assert.match(html, /<button type="button" class="menu-btn" id="menu-toggle" aria-expanded="false" aria-controls="sidebar"/);
  assert.match(html, /<button type="button" class="drawer-close" id="drawer-close">/);
  assert.match(html, /<div class="scrim" id="scrim" hidden><\/div>/);
  for (const id of ['side-overview', 'side-combined', 'side-gateway']) assert.ok(html.includes(`id="${id}"`), id);
  for (const text of ['Observabilidade', 'Clientes', 'Jev Gateway', 'Cache geral']) assert.ok(html.includes(text), text);
});

test('the sidebar groups and the top bar hold the theme switch twice, each a pair of pressed buttons', () => {
  const html = dashboardHtml(AGGREGATOR);
  for (const where of ['side', 'top']) {
    for (const name of ['dark', 'light']) {
      assert.match(html, new RegExp(`<button type="button" class="theme-btn" id="theme-${name}-${where}" aria-pressed="false">`), `${name}-${where}`);
    }
  }
  assert.match(html, /<div class="theme-switch" role="group" aria-label="Tema">/);
});

test('overview holds the AI Memory state card, and the sidebar has one button per client with its pill', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.match(html, /<div class="state-card" id="state-card" data-tone="s-idle">/);
  for (const client of ['claude', 'codex', 'agy']) {
    assert.match(html, new RegExp(`<button type="button" class="side-item" id="gs-${client}"`), client);
    assert.ok(html.includes(`id="gs-dot-${client}"`), client);
    assert.ok(html.includes(`id="gs-state-${client}"`), client);
    assert.ok(html.includes(`id="gs-pill-${client}"`), client);
  }
});

test('the provider cards are buttons that open their views and list the three gateways with state cells', () => {
  const html = dashboardHtml(AGGREGATOR);
  const cards = html.match(/<button type="button" class="pcard" id="gw-prov-[a-z]+-row" data-view="[a-z]+">/g) ?? [];
  assert.equal(cards.length, 3);
  for (const client of ['claude', 'codex', 'agy']) {
    for (const column of ['state', 'requests', 'input', 'cacheread', 'cache', 'output', 'p50']) assert.ok(html.includes(`id="gw-prov-${client}-${column}"`), `${client}-${column}`);
    assert.ok(html.includes(`id="gw-prov-${client}-dot"`), `${client}-dot`);
  }
  const grid = html.slice(html.indexOf('id="provider-cards"'), html.indexOf('id="obs-combined-experiment"'));
  for (const name of ['Claude Code', 'OpenAI Codex', 'Google Antigravity', 'Total combinado']) assert.ok(grid.includes(name), name);
});

test('the per-model tables keep four columns under 600px and end in a totals footer', () => {
  const html = dashboardHtml(AGGREGATOR);
  assert.equal((html.match(/<tfoot>/g) ?? []).length, 3, 'Claude Code, OpenAI Codex and the combined table');
  assert.equal(html.split('TOTAL CONSOLIDADO').length - 1, 1, 'the combined footer carries the consolidated label once');
  // Under 600px the hidden columns are 3, 4, 6 and 8: Chamadas Jev, Tokens entrada Jev, Cache leitura and Preço API.
  for (const column of [3, 4, 6, 8]) assert.ok(dashboardCss.includes(`.gw-models th:nth-child(${column})`), `column ${column}`);
});

test('the global disclaimer and the pricing line appear once, in the Tokens view', () => {
  const html = dashboardHtml(AGGREGATOR);
  const disclaimer = 'não representam cobrança de assinatura nem economia confirmada';
  assert.equal(html.split(disclaimer).length - 1, 1);
  assert.equal(html.split('id="gw-pricing"').length - 1, 1);
  const combined = html.slice(html.indexOf('id="gw-panel-combined"'), html.indexOf('id="gw-panel-claude"'));
  assert.ok(combined.includes(disclaimer));
  assert.ok(combined.includes('id="gw-pricing"'));
});

test('the Tokens view holds the traffic split, the comparison and the link to the Jev Gateway view', () => {
  const html = dashboardHtml(AGGREGATOR);
  const combined = html.slice(html.indexOf('id="gw-panel-combined"'), html.indexOf('id="gw-panel-claude"'));
  for (const id of ['traffic-bar', 'traffic-legend', 'obs-combined-compare-body', 'go-gateway']) assert.ok(combined.includes(`id="${id}"`), id);
  assert.ok(combined.includes('Distribuição de tráfego'));
  assert.ok(combined.includes('Painel do Jev Gateway'));
});

test('script stores the Antigravity gateway, so the card and the combined running count see it', () => {
  assert.ok(dashboardJs.includes("pickGateway(data.gateways, 'agy')"));
  assert.ok(dashboardJs.includes('gateways: { claude: null, codex: null, agy: null }'));
});

test('script renders the Antigravity view from its live data with textContent only', () => {
  assert.ok(dashboardJs.includes('function renderAgy()'));
  assert.ok(dashboardJs.includes("field(gateway, ['agyLive'])"));
  assert.ok(dashboardJs.includes("classList.toggle('agy-kpi-warn', errors !== null && errors > 0)"));
  assert.ok(dashboardJs.includes('var AGY_RECENT_MAX = 15;'));
  assert.ok(dashboardJs.includes('live.recent.filter(isRecord).slice(0, AGY_RECENT_MAX)'));
  assert.ok(dashboardJs.includes('Gateway parado ou sem resposta: atividade recente indisponível.'));
  assert.ok(dashboardJs.includes('Nenhuma requisição na janela recente.'));
  assert.ok(dashboardJs.includes('Janela recente: '));
  assert.ok(dashboardJs.includes('Gateway ativo desde '));
  assert.ok(dashboardJs.includes("'agy-ok' : 'agy-err'"));
  assert.equal(dashboardJs.includes('innerHTML'), false);
});

test('style has the Antigravity rules and the red tone for errors only', () => {
  for (const rule of ['.kpis', '.tab[aria-selected="true"]', '.agy-kpi-warn', '.agy-bar > span', '.agy-recent .badge.agy-err']) {
    assert.ok(dashboardCss.includes(rule), rule);
  }
  assert.equal(dashboardCss.includes('.agy-models { min-width'), false, 'the Antigravity model list must not force a wide table');
});

test('the stylesheet is monochrome: no brand tints, no shadows, no web fonts', () => {
  for (const colour of ['#3b82f6', '#2563eb', '#8b5cf6', '#7c3aed', '#a78bfa', '#4ade80', '#fbbf24']) {
    assert.equal(dashboardCss.toLowerCase().includes(colour), false, colour);
  }
  assert.equal(dashboardCss.includes('box-shadow'), false, 'no shadows or glows');
  assert.equal(dashboardCss.includes('@import'), false);
  assert.equal(dashboardCss.includes('font-face'), false);
});

test('the page carries no external resource and its tokens are the neutral ones', () => {
  const html = dashboardHtml(null);
  assert.equal(/https?:\/\//.test(html), false, 'no external URL in the markup');
  for (const token of ['--canvas: #fafafa', '--surface: #ffffff', '--border: #e5e5e5', '--canvas: #0a0a0a', '--surface: #111111', '--border: #262626']) {
    assert.ok(dashboardCss.includes(token), token);
  }
});

test('html puts the observability views before the embedded gateway view', () => {
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
