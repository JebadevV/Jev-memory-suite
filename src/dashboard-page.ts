// Markup and panel script for the suite dashboard. Purpose: AI Memory panel plus the embedded Jev Gateway dashboard.
// Audience: maintainers. Date: 2026-10-22.
import { dashboardCss } from './dashboard-style.js';
import type { Aggregator } from './gateways.js';

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Both clients render in the one aggregator frame; data-aggregator lets the script detect a changed gateway.
const gatewayFrame = (aggregator: Aggregator): string =>
  `<iframe class="gateway-frame gateway-tall" id="gateway-slot" data-aggregator="${escapeHtml(`${aggregator.client}:${aggregator.port}`)}" title="Dashboard do Jev Gateway (Claude + Codex)" src="${escapeHtml(aggregator.url)}" sandbox="allow-scripts allow-same-origin"></iframe>`;

const gatewayFallback = (): string => `<section class="card gateway-offline" id="gateway-slot" data-aggregator="none" aria-labelledby="gateway-offline-title">
  <h2 id="gateway-offline-title">Gateways offline</h2>
  <p>Claude e Codex não estão respondendo nas portas configuradas.</p>
  <p>Inicie um dos launchers: <code>jev-memory-codex</code> ou <code>jev-memory-claude</code>; cada um sobe o gateway correspondente.</p>
  <p class="meta">Esta página confere o status sozinha a cada poucos segundos.</p>
</section>`;

// Exactly one gateway frame: the aggregator already shows both clients, so a second frame would repeat its view.
const gatewayPanel = (aggregator: Aggregator | null): string => `<div class="gateway-head"><h2>Jev Gateway · Claude + Codex</h2></div>
${aggregator ? gatewayFrame(aggregator) : gatewayFallback()}`;

// Column headers of the per-model table; the script fills one row per model (max 12) in the matching order.
const MODEL_COLUMNS: readonly string[] = ['Modelo', 'Requisições', 'Chamadas Jev', 'Tokens entrada Jev', 'LLM não cacheada',
  'Cache leitura', 'LLM saída', 'Estimativa de preço de API (USD)'];

// History values only: the launcher log, which the upstream window does not keep. Keys match the script's OBS_ROW_KEYS.
const OBS_ROWS: readonly (readonly [string, string])[] = [
  ['requests', 'Requisições'],
  ['jevCalls', 'Chamadas Jev (erros)'],
  ['jevInput', 'Tokens entrada Jev'],
  ['jevOutput', 'Tokens saída Jev'],
  ['llmInput', 'LLM entrada não cacheada'],
  ['cacheRead', 'Cache leitura'],
  ['cacheWrite', 'Cache escrita'],
  ['llmOutput', 'LLM saída (raciocínio)'],
  ['blocking', 'Latência adicionada pelo Jev (total)'],
  ['avoided', 'Chamadas LLM evitadas (direct)'],
  ['cost', 'Estimativa de preço de API (USD)'],
  ['period', 'Período'],
];

const modelTable = (scope: string, label: string): string => `<div class="gw-table-wrap">
      <table class="gw-table gw-models" aria-label="${escapeHtml(`Modelos do ${label} no histórico`)}">
        <thead><tr>${MODEL_COLUMNS.map((column) => `<th scope="col">${column}</th>`).join('')}</tr></thead>
        <tbody id="obs-${scope}-models-body"></tbody>
      </table>
    </div>
    <p class="empty" id="obs-${scope}-models-empty" hidden></p>`;

// Compare rows are filled by the script: request count, per-request averages and cache share, with and without Jev.
const compareTable = (scope: string, label: string): string => `<div class="gw-table-wrap" id="obs-${scope}-compare-wrap">
      <table class="gw-table gw-compare" aria-label="${escapeHtml(`Comparação com e sem Jev do ${label}`)}">
        <thead><tr><th scope="col">Métrica</th><th scope="col">Com Jev</th><th scope="col">Baseline</th><th scope="col">Diferença</th></tr></thead>
        <tbody id="obs-${scope}-compare-body"></tbody>
      </table>
    </div>
    <p class="meta" id="obs-${scope}-compare-note"></p>`;

const obsCard = (scope: string, label: string, wide: boolean): string => `<article class="card gw-card s-idle${wide ? ' gw-wide' : ''}" id="obs-${scope}" aria-labelledby="obs-${scope}-name">
    <div class="gw-head">
      <h3 class="who" id="obs-${scope}-name">${label}</h3>
      <div class="state" id="obs-${scope}-state">Carregando</div>
      <p class="why" id="obs-${scope}-why"></p>
      <p class="why">Experimento: <span id="obs-${scope}-experiment">—</span></p>
      ${scope === 'combined' ? '' : `<p class="why" id="obs-${scope}-billing" hidden></p>`}
    </div>
    <dl class="gw-metrics">
      ${OBS_ROWS.map(([key, text]) => `<div><dt>${text}</dt><dd id="obs-${scope}-${key}">—</dd></div>`).join('\n      ')}
    </dl>
    <h4 class="gw-sub">Por modelo</h4>
    ${modelTable(scope, label)}
    <h4 class="gw-sub" id="obs-${scope}-compare-title">Com Jev × Baseline (histórico)</h4>
    ${compareTable(scope, label)}
  </article>`;

const observabilitySection = `<section class="card gw-section" id="token-observability" aria-labelledby="obs-title">
  <h2 id="obs-title">Observabilidade de tokens (histórico do log)</h2>
  <p class="meta gw-note">Complementa o painel do Jev Gateway abaixo: totais do log completo do launcher, por modelo, e custo estimado. A janela recente, filtros e o controle de roteamento ficam no painel original.</p>
  <p class="empty" id="gateway-notice" role="status" hidden>O gateway mudou desde que esta página foi carregada. Recarregue a página para ver o painel atualizado.</p>
  <p class="meta gw-stale" id="obs-stale" hidden>dados desatualizados</p>
  <div class="gw-grid">
    ${obsCard('claude', 'Claude', false)}
    ${obsCard('codex', 'Codex', false)}
    ${obsCard('agy', 'Antigravity', false)}
    ${obsCard('combined', 'Combinado (Claude + Codex + Antigravity)', true)}
  </div>
  <p class="meta gw-disclaimer">Custos são estimativas de preço de API com base nos preços configurados em observability.pricing; não representam cobrança de assinatura nem economia confirmada. Tokens de saída do Jev não são registrados pelo gateway.</p>
  <p class="meta" id="gw-pricing">Carregando preços…</p>
</section>`;

export function dashboardHtml(aggregator: Aggregator | null): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev Memory Suite</title>
<style>${dashboardCss}</style>
</head>
<body>
<main>
<header>
  <div>
    <h1>jev-memory</h1>
    <span class="live" id="live" role="status">conectando…</span>
  </div>
  <span class="scope" id="scope">—</span>
</header>

<div class="projects" id="projects" role="tablist" aria-label="Projetos com memória"></div>

<div class="row-state">
  <article class="card state-card s-idle" id="state-card" aria-labelledby="state-label">
    <div class="who" id="state-label">AI Memory</div>
    <div class="state"><span class="icon" id="state-icon" aria-hidden="true">○</span><span id="state-text">Carregando</span></div>
    <p class="why" id="state-why" role="status">Consultando o serviço de memória.</p>
    <p class="meta">Os hooks do Claude/Codex registram cada sessão aqui; a wiki compila o que vale guardar.</p>
  </article>
  <section class="card" aria-labelledby="pending-title">
    <h2 id="pending-title">Pendências</h2>
    <div class="pair">
      <div class="tile" id="t-handoffs">
        <div class="label">Handoffs</div>
        <div class="value" id="m-handoffs">—</div>
        <div class="sub">contexto deixado para a próxima sessão retomar</div>
      </div>
      <div class="tile" id="t-messages">
        <div class="label">Mensagens</div>
        <div class="value" id="m-messages">—</div>
        <div class="sub">pedidos de outros projetos na caixa de entrada</div>
      </div>
    </div>
  </section>
</div>

<section class="tiles" aria-label="Totais da memória">
  <div class="card tile">
    <div class="label">Sessões</div>
    <div class="value" id="m-sessions">—</div>
    <div class="sub" id="m-sessions-sub">sessões de agente registradas</div>
  </div>
  <div class="card tile">
    <div class="label">Observações</div>
    <div class="value" id="m-observations">—</div>
    <div class="sub" id="m-observations-sub">eventos capturados pelos hooks</div>
  </div>
  <div class="card tile">
    <div class="label">Páginas na wiki</div>
    <div class="value" id="m-pages">—</div>
    <div class="sub" id="m-pages-sub">conhecimento compilado</div>
  </div>
  <div class="card tile">
    <div class="label">Última atividade</div>
    <div class="value" id="m-last">—</div>
    <div class="sub" id="m-last-sub">sem registros</div>
  </div>
</section>

<section class="card" aria-labelledby="recent-title">
  <h2 id="recent-title">Atividade recente</h2>
  <ol class="recent" id="recent"></ol>
  <p class="empty" id="recent-empty" hidden></p>
</section>

${observabilitySection}
</main>

${gatewayPanel(aggregator)}
<div class="toasts" id="toasts" aria-live="polite"></div>
<script src="/app.js" defer></script>
</body>
</html>
`;
}
