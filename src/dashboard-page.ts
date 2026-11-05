// Markup for the suite dashboard: an app shell (top bar, sidebar, one view at a time) with the memory and gateway views.
// Below 1000px the sidebar becomes a drawer opened from the top bar. Purpose: maintainers. Date: 2026-10-25.
import { dashboardCss } from './dashboard-style.js';
import { clientIcons } from './dashboard-icons.js';
import type { Aggregator } from './gateways.js';

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Product names and their icons. The icon is decorative (alt="") because the name next to it carries the meaning.
type ClientKey = 'claude' | 'codex' | 'agy';
type ViewKey = 'overview' | 'combined' | ClientKey | 'gateway';
const CLIENTS: readonly ClientKey[] = ['claude', 'codex', 'agy'];
const CLIENT_NAMES: Record<ClientKey, string> = { claude: 'Claude Code', codex: 'OpenAI Codex', agy: 'Google Antigravity' };
const clientIcon = (client: ClientKey, small: boolean): string => {
  const size = small ? 16 : 20;
  return `<img class="client-icon${small ? ' client-icon-sm' : ''}" src="${clientIcons[client]}" alt="" width="${size}" height="${size}">`;
};
const clientName = (client: ClientKey, small = false): string =>
  `<span class="client-name">${clientIcon(client, small)}${CLIENT_NAMES[client]}</span>`;

// Both clients render in the one aggregator frame; data-aggregator lets the script detect a changed gateway.
const gatewayFrame = (aggregator: Aggregator): string =>
  `<iframe class="gateway-frame gateway-tall" id="gateway-slot" data-aggregator="${escapeHtml(`${aggregator.client}:${aggregator.port}`)}" title="Dashboard do Jev Gateway (Claude Code + OpenAI Codex)" src="${escapeHtml(aggregator.url)}" sandbox="allow-scripts allow-same-origin"></iframe>`;

const gatewayFallback = (): string => `<section class="card gateway-offline" id="gateway-slot" data-aggregator="none" aria-labelledby="gateway-offline-title">
  <h2 id="gateway-offline-title">Gateways offline</h2>
  <p>Claude Code e OpenAI Codex não estão respondendo nas portas configuradas.</p>
  <p>Inicie um dos launchers: <code>jev-memory-codex</code> ou <code>jev-memory-claude</code>; cada um sobe o gateway correspondente.</p>
  <p class="meta">Esta página confere o status sozinha a cada poucos segundos.</p>
</section>`;

// Exactly one gateway frame: the aggregator already shows both clients, so a second frame would repeat its view.
const gatewayPanel = (aggregator: Aggregator | null): string => `<div class="gateway-head"><h2>Jev Gateway · ${clientName('claude', true)} + ${clientName('codex', true)}</h2></div>
${aggregator ? gatewayFrame(aggregator) : gatewayFallback()}`;

// The views in navigation order. `tab` labels the top tab, `side` the sidebar entry; both switch the same view.
const VIEWS: readonly { key: ViewKey; tab: string; side: string }[] = [
  { key: 'overview', tab: 'Visão geral', side: 'Visão geral & AI Memory' },
  { key: 'combined', tab: 'Tokens', side: 'Tokens & custos' },
  { key: 'claude', tab: 'Claude Code', side: 'Claude Code' },
  { key: 'codex', tab: 'OpenAI Codex', side: 'OpenAI Codex' },
  { key: 'agy', tab: 'Google Antigravity', side: 'Google Antigravity' },
  { key: 'gateway', tab: 'Jev Gateway', side: 'Painel do Jev Gateway' },
];

// Column headers of the per-model table; the script fills one row per model (max 12) in the matching order.
// Under 600px the table keeps columns 1, 2, 5 and 7 (Modelo, Requisições, LLM não cacheada, LLM saída).
const MODEL_COLUMNS: readonly string[] = ['Modelo', 'Reqs', 'Jev', 'Entrada Jev', 'LLM não-cache', 'Cache', 'Saída', 'Preço'];

// Rows of the Jev disclosure (history values; the Jev output is never logged upstream). Keys match the script's OBS_ROW_KEYS.
const JEV_ROWS: readonly (readonly [string, string])[] = [
  ['jevCalls', 'Chamadas Jev (erros)'],
  ['jevInput', 'Tokens entrada Jev'],
  ['jevOutput', 'Tokens saída Jev'],
  ['cacheRead', 'Cache leitura'],
  ['cacheWrite', 'Cache escrita'],
  ['blocking', 'Latência adicionada pelo Jev (total)'],
  ['avoided', 'Chamadas LLM evitadas (direct)'],
];

// The per-model table. Its footer totals are filled by the script from the rows shown.
const modelTable = (scope: string, label: string, totalLabel: string): string => `<div class="gw-table-wrap">
        <table class="gw-table gw-models" aria-label="${escapeHtml(`Modelos do ${label} no histórico`)}">
          <thead><tr>${MODEL_COLUMNS.map((column) => `<th scope="col">${column}</th>`).join('')}</tr></thead>
          <tbody id="obs-${scope}-models-body"></tbody>
          <tfoot><tr><th scope="row" class="tf-label">${totalLabel}</th><td id="obs-${scope}-models-total-requests">—</td><td></td><td></td><td></td><td id="obs-${scope}-models-total-cache">—</td><td></td><td></td></tr></tfoot>
        </table>
      </div>
      <p class="empty" id="obs-${scope}-models-empty" hidden></p>`;

// Compare blocks are filled by the script: request count, per-request averages and cache share, with and without Jev.
const compareList = (scope: string): string => `<div class="cmp-list" id="obs-${scope}-compare-body"></div>
      <p class="meta" id="obs-${scope}-compare-note"></p>`;

// One primary KPI: a label, a value and an optional sub line. The ids are the ones the script fills.
const kpi = (key: string, label: string, scope: string, sub: boolean, extra = ''): string =>
  `<div class="kpi${extra}" id="obs-${scope}-kpi-${key}"><dt>${label}</dt><dd class="kpi-value" id="obs-${scope}-${key}">—</dd>${sub ? `<dd class="kpi-sub" id="obs-${scope}-${key}-sub">—</dd>` : ''}</div>`;

// The five primary numbers of a client: the latency and the cache share come from the history.
const kpiBlock = (scope: string): string => `<dl class="kpis">
          ${kpi('requests', 'Requisições', scope, false)}
          ${kpi('llmInput', 'Entrada não cacheada', scope, true)}
          ${kpi('llmOutput', 'Saída', scope, true)}
          ${kpi('latency', 'Latência p50', scope, true)}
          ${kpi('period', 'Período', scope, false, ' kpi-period')}
        </dl>`;

// Plain label/value rows used inside the cards and the disclosures.
const rowList = (scope: string, rows: readonly (readonly [string, string])[]): string =>
  `<dl class="rows">${rows.map(([key, text]) => `<div><dt>${text}</dt><dd id="obs-${scope}-${key}">—</dd></div>`).join('')}</dl>`;

// A disclosure is closed by default; its summary names the content. It is a card like the others.
const disclosure = (summary: string, body: string): string =>
  `<details class="card disclosure"><summary><span>${summary}</span></summary><div class="disc-body">${body}</div></details>`;

// Antigravity: passthrough and subscription, so no Jev calls, cost or comparison. Its KPIs map to the same five slots.
const AGY_FACTS: readonly (readonly [string, string])[] = [
  ['mode', 'Modo'],
  ['contract', 'Code Assist'],
  ['pid', 'PID'],
  ['uptime', 'Ativo há'],
  ['upstream', 'Upstream'],
  ['billing', 'Cobrança'],
];
const AGY_KPIS: readonly (readonly [string, string])[] = [
  ['requests', 'Requisições'],
  ['input', 'Entrada'],
  ['output', 'Saída'],
  ['latency', 'Latência p50'],
  ['last', 'Última requisição'],
];

const agyKpiBlock = (): string => `<dl class="kpis">
          ${AGY_KPIS.map(([key, text]) => kpi(key, text, 'agy', true, key === 'last' ? ' kpi-period' : '')).join('\n          ')}
        </dl>`;

const agyView = (): string => `<section class="view" id="gw-panel-agy" role="tabpanel" aria-labelledby="gw-tab-agy" tabindex="-1" hidden>
    <article class="gw-card view-card" id="obs-agy" aria-labelledby="obs-agy-name" data-tone="s-idle">
      <header class="view-top">
        <h2 class="view-title" id="obs-agy-name">${clientName('agy')}</h2>
        <p class="view-meta"><span class="state" id="obs-agy-state">Carregando</span><span class="caption">Jev Gateway v2 · passthrough</span></p>
        <p class="why" id="obs-agy-why"></p>
      </header>
      <section class="card" aria-labelledby="agy-facts-title">
        <h3 class="card-title" id="agy-facts-title">Ficha do gateway</h3>
        <dl class="rows spec">
          ${AGY_FACTS.map(([key, text]) => `<div><dt>${text}</dt><dd id="obs-agy-${key}">—</dd></div>`).join('\n          ')}
          <div class="agy-kpi" id="obs-agy-kpi-errors"><dt>Erros (janela recente)</dt><dd id="obs-agy-errors">—</dd><dd class="kpi-sub" id="obs-agy-errors-sub">—</dd></div>
        </dl>
        <p class="agy-period" id="obs-agy-period">Carregando…</p>
      </section>
      ${agyKpiBlock()}
      <section class="card" aria-labelledby="agy-models-title">
        <h3 class="card-title" id="agy-models-title">Modelos (<span id="obs-agy-models-count">—</span>)</h3>
        <ol class="agy-models" id="obs-agy-models-body"></ol>
        <p class="empty" id="obs-agy-models-empty" hidden></p>
      </section>
      <section class="card" aria-labelledby="agy-recent-title">
        <h3 class="card-title" id="agy-recent-title">Atividade recente (<span id="obs-agy-recent-count">—</span>)</h3>
        <div class="agy-recent-wrap">
          <div class="agy-recent-head" aria-hidden="true"><span>Hora</span><span>Modelo</span><span>Status</span><span>Método</span><span>Duração</span><span>Entrada</span><span>Saída</span><span>Raciocínio</span></div>
          <ol class="recent agy-recent" id="obs-agy-recent"></ol>
        </div>
        <button type="button" class="agy-more" id="obs-agy-recent-more" aria-controls="obs-agy-recent" aria-expanded="false" hidden></button>
        <p class="empty" id="obs-agy-recent-empty" hidden></p>
      </section>
    </article>
  </section>`;

// One provider view: state and experiment, the five KPIs, then the models table beside the Jev metrics, the comparison and the cost.
const providerView = (client: 'claude' | 'codex'): string => `<section class="view" id="gw-panel-${client}" role="tabpanel" aria-labelledby="gw-tab-${client}" tabindex="-1" hidden>
    <article class="gw-card view-card" id="obs-${client}" aria-labelledby="obs-${client}-name" data-tone="s-idle">
      <header class="view-top">
        <h2 class="view-title" id="obs-${client}-name">${clientName(client)}</h2>
        <p class="view-meta"><span class="state" id="obs-${client}-state">Carregando</span><span class="caption">Experimento: <span id="obs-${client}-experiment">—</span></span></p>
        <p class="caption" id="obs-${client}-billing" hidden></p>
        <p class="why" id="obs-${client}-why"></p>
      </header>
      ${kpiBlock(client)}
      <div class="view-grid">
        <section class="card" aria-labelledby="obs-${client}-models-title">
          <h3 class="card-title" id="obs-${client}-models-title">Por modelo (<span id="obs-${client}-models-count">—</span>)</h3>
          ${modelTable(client, CLIENT_NAMES[client], 'TOTAL')}
        </section>
        <div class="view-side">
          <section class="card" aria-labelledby="obs-${client}-jev-title">
            <h3 class="card-title" id="obs-${client}-jev-title">Métricas do Jev</h3>
            ${rowList(client, JEV_ROWS)}
          </section>
          <section class="card" aria-labelledby="obs-${client}-cmp-title">
            <h3 class="card-title" id="obs-${client}-cmp-title">Com Jev × Baseline (histórico)</h3>
            ${compareList(client)}
          </section>
          ${disclosure('Custo estimado', rowList(client, [['cost', 'Estimativa de preço de API (USD)']]))}
        </div>
      </div>
    </article>
  </section>`;

// Provider cards of the Tokens view: each opens its provider view. The output and latency values stay in a hidden block.
const PROVIDER_CARD = (client: 'claude' | 'codex' | 'agy'): string => `<button type="button" class="pcard" id="gw-prov-${client}-row" data-view="${client}">
          <span class="pcard-head"><span class="client-name">${clientIcon(client, true)}${CLIENT_NAMES[client]}</span><span class="pill"><span class="gs-dot" id="gw-prov-${client}-dot" aria-hidden="true"></span><span id="gw-prov-${client}-state">—</span></span></span>
          <span class="pcard-big"><span class="pcard-num" id="gw-prov-${client}-requests">—</span><span class="pcard-unit">REQS</span></span>
          <span class="pcard-row"><span class="pcard-label">Entrada</span><span class="pcard-val" id="gw-prov-${client}-input">—</span></span>
          <span class="pcard-row"><span class="pcard-label">Cache de leitura</span><span class="pcard-val" id="gw-prov-${client}-cacheread">—</span></span>
          <span class="pcard-foot"><span class="pcard-label">Taxa de cache</span><span class="pcard-val" id="gw-prov-${client}-cache">—</span></span>
        </button>`;
// Values the script fills that have no visible place now: the output and p50 of each provider card, and the combined period
// (shown in the breadcrumb chip instead). They stay in this hidden block so the script's ids all exist.
const providerExtras = (): string => `<span hidden id="gw-prov-extras">${CLIENTS.map((client) => `<span id="gw-prov-${client}-output">—</span><span id="gw-prov-${client}-p50">—</span>`).join('')}<span id="obs-combined-period">—</span></span>`;

// Total card: the combined history, shown as the fourth provider card.
const totalCard = (): string => `<article class="pcard total-card" id="obs-combined" aria-labelledby="obs-combined-name" data-tone="s-idle">
          <span class="pcard-head"><span class="pcard-name" id="obs-combined-name">Total combinado</span><span class="pill"><span class="gs-dot" aria-hidden="true"></span><span id="obs-combined-state">Carregando</span></span></span>
          <span class="pcard-big"><span class="pcard-num" id="obs-combined-requests">—</span><span class="pcard-unit">total reqs</span></span>
          <span class="tiles">
            <span class="tile"><span class="pcard-label">Entrada</span><span class="pcard-val" id="obs-combined-llmInput">—</span></span>
            <span class="tile"><span class="pcard-label">Cache leitura</span><span class="pcard-val" id="obs-combined-cacheRead">—</span></span>
          </span>
          <span class="pcard-row"><span class="pcard-label">LLM saída</span><span class="pcard-val-wrap"><span class="pcard-val" id="obs-combined-llmOutput">—</span><span class="kpi-sub" id="obs-combined-llmOutput-sub">—</span></span></span>
          <span class="pcard-row" id="obs-combined-kpi-latency"><span class="pcard-label">Latência p50</span><span class="pcard-val-wrap"><span class="pcard-val" id="obs-combined-latency">—</span><span class="kpi-sub" id="obs-combined-latency-sub">—</span></span></span>
          <span class="pcard-foot"><span class="pcard-label">Taxa de cache</span><span class="pcard-val" id="obs-combined-llmInput-sub">—</span></span>
        </article>`;

// Tokens view: the provider cards, the comparison and traffic split, the per-model table, the Jev panel link and the cost details.
const combinedView = (): string => `<section class="view" id="gw-panel-combined" role="tabpanel" aria-labelledby="gw-tab-combined" tabindex="-1" hidden>
    <div class="view-head">
      <h2 class="view-title">Tokens & custos</h2>
      <p class="view-desc">Totais do log completo do launcher, por provedor, modelo e custo estimado. A janela recente, os filtros e o roteamento ficam no Painel do Jev Gateway.</p>
    </div>
    <div class="pcards" id="provider-cards">
        ${CLIENTS.map(PROVIDER_CARD).join('\n        ')}
        ${totalCard()}
    </div>
    ${providerExtras()}
    <p class="caption" id="obs-combined-experiment">—</p>
    <p class="why" id="obs-combined-why"></p>
    <div class="tokens-grid">
      <div class="tokens-left">
        <section class="card" aria-labelledby="cmp-title">
          <h3 class="card-title" id="cmp-title">Com Jev × Baseline (histórico)</h3>
          <p class="meta">Somente Claude Code e OpenAI Codex entram nesta comparação.</p>
          ${compareList('combined')}
        </section>
        <section class="card" aria-labelledby="traffic-title">
          <h3 class="card-title" id="traffic-title">Distribuição de tráfego</h3>
          <p class="meta">Participação das requisições por modelo</p>
          <div class="traffic-bar" id="traffic-bar" aria-hidden="true"></div>
          <ul class="traffic-legend" id="traffic-legend"></ul>
          <p class="empty" id="traffic-empty" hidden></p>
        </section>
      </div>
      <div class="tokens-right">
        <section class="card" aria-labelledby="models-title">
          <div class="card-head">
            <h3 class="card-title" id="models-title">Telemetria por modelo</h3>
            <p class="meta"><span id="obs-combined-models-count">—</span> modelos indexados no registro</p>
          </div>
          ${modelTable('combined', 'Claude Code, OpenAI Codex e Google Antigravity', 'TOTAL CONSOLIDADO')}
        </section>
        <section class="card callout" aria-labelledby="callout-title">
          <div>
            <h3 class="card-title" id="callout-title">Painel do Jev Gateway</h3>
            <p class="meta">Janela recente, filtros e roteamento ficam no painel original.</p>
          </div>
          <button type="button" class="btn" id="go-gateway" data-view="gateway">Abrir painel do gateway</button>
        </section>
      </div>
    </div>
    ${disclosure('Custo estimado e fontes de preço', `${rowList('combined', [['cost', 'Estimativa de preço de API (USD)']])}
        <p class="meta" id="gw-pricing">Carregando preços…</p>
        <p class="meta gw-disclaimer">Custos são estimativas de preço de API com base nos preços configurados em observability.pricing; não representam cobrança de assinatura nem economia confirmada. Tokens de saída do Jev não são registrados pelo gateway.</p>`)}
    ${disclosure('Métricas do Jev (todos os gateways)', rowList('combined', JEV_ROWS.filter(([key]) => key !== 'cacheRead')))}
  </section>`;

const gatewayView = (aggregator: Aggregator | null): string => `<section class="view" id="gw-panel-gateway" role="tabpanel" aria-labelledby="gw-tab-gateway" tabindex="-1" hidden>
    <div class="view-head">
      <h2 class="view-title">Painel do Jev Gateway</h2>
      <p class="view-desc">Janela recente, filtros e roteamento do gateway, no painel original do Jev.</p>
    </div>
    <p class="empty" id="gateway-notice" role="status" hidden>O gateway mudou desde que esta página foi carregada. Recarregue a página para ver o painel atualizado.</p>
    ${gatewayPanel(aggregator)}
  </section>`;

// Overview: the AI Memory state, the totals and the recent activity. The totals keep their ids and tooltips.
const stateCard = `<section class="card state-panel" aria-label="Estado da memória">
    <div class="state-card" id="state-card" data-tone="s-idle">
      <span class="who" id="state-label">AI Memory</span>
      <span class="state"><span class="icon" id="state-icon" aria-hidden="true">○</span><span id="state-text">Carregando</span></span>
      <span class="why" id="state-why" role="status">Consultando o serviço de memória.</span>
    </div>
  </section>`;
const numberTile = (id: string, label: string, valueId: string, subId: string, sub: string): string =>
  `<div class="num" id="${id}"><span class="label">${label}</span><span class="value" id="${valueId}">—</span><span class="sub" id="${subId}">${sub}</span></div>`;
const numbersRow = `<section class="numbers" aria-labelledby="totals-title">
    <h2 class="sr-only" id="totals-title">Totais da memória</h2>
    ${numberTile('t-sessions', 'Sessões', 'm-sessions', 'm-sessions-sub', 'sessões de agente registradas')}
    ${numberTile('t-observations', 'Observações', 'm-observations', 'm-observations-sub', 'eventos capturados pelos hooks')}
    ${numberTile('t-pages', 'Páginas', 'm-pages', 'm-pages-sub', 'conhecimento compilado')}
    ${numberTile('t-handoffs', 'Handoffs', 'm-handoffs', 'm-handoffs-sub', 'contexto deixado para a próxima sessão retomar')}
    ${numberTile('t-messages', 'Mensagens', 'm-messages', 'm-messages-sub', 'pedidos de outros projetos na caixa de entrada')}
    ${numberTile('t-last', 'Última atividade', 'm-last', 'm-last-sub', 'sem registros')}
  </section>`;

const recentSection = `<section class="card recent-section" aria-labelledby="recent-title">
  <h2 class="card-title" id="recent-title">Atividade recente</h2>
  <ol class="recent" id="recent"></ol>
  <p class="empty" id="recent-empty" hidden></p>
</section>`;

const overviewView = `<section class="view" id="gw-panel-overview" role="tabpanel" aria-labelledby="gw-tab-overview" tabindex="-1">
    <div class="view-head">
      <h2 class="view-title">Visão geral</h2>
      <p class="view-desc">Estado da AI Memory do projeto selecionado, com totais e atividade recente.</p>
    </div>
    ${stateCard}
    ${numbersRow}
    ${recentSection}
  </section>`;

// Theme choice: a segmented control; the top copy shows below 1000px, the sidebar copy in the sidebar footer.
const themeSwitch = (where: 'side' | 'top'): string => `<div class="theme-switch" role="group" aria-label="Tema">
          <button type="button" class="theme-btn" id="theme-dark-${where}" aria-pressed="false">Escuro</button>
          <button type="button" class="theme-btn" id="theme-light-${where}" aria-pressed="false">Claro</button>
        </div>`;

// The top bar: brand, scope, project chips, live state and (on the desktop) the view tabs. Below 1000px the drawer is the navigation.
const tabs = (): string => `<nav class="tabs" id="gw-tablist" role="tablist" aria-label="Visões">
        ${VIEWS.map(({ key, tab }, index) => {
          const icon = CLIENTS.includes(key as ClientKey) ? clientIcon(key as ClientKey, true) : '';
          return `<button type="button" role="tab" class="tab" id="gw-tab-${key}" aria-controls="gw-panel-${key}" aria-selected="${index === 0 ? 'true' : 'false'}" tabindex="${index === 0 ? '0' : '-1'}">${icon}${tab}</button>`;
        }).join('\n        ')}
      </nav>`;
const topbar = `<header class="topbar" id="topbar">
  <div class="topbar-row">
    <div class="brand">
      <button type="button" class="menu-btn" id="menu-toggle" aria-expanded="false" aria-controls="sidebar" aria-label="Abrir menu de navegação"><span class="menu-bars" aria-hidden="true"></span></button>
      <h1>jev-memory</h1>
      <span class="scope" id="scope">—</span>
    </div>
    <div class="topbar-tools">
      <span class="live" id="live" role="status">conectando…</span>
      <p class="meta stale" id="obs-stale" hidden>dados desatualizados</p>
      <div class="theme-top">${themeSwitch('top')}</div>
    </div>
  </div>
  <div class="topbar-row topbar-second">
    <div class="projects" id="projects" role="tablist" aria-label="Projetos com memória"></div>
    <p class="topbar-view" id="topbar-view">Visão geral</p>
    ${tabs()}
  </div>
</header>`;

// Sidebar: the primary navigation at 1000px and up; below that it is a drawer. The entries mirror the top tabs.
const sideLabel = (text: string): string => `<p class="side-label">${text}</p>`;
const sideItem = (key: ViewKey, label: string, pill = ''): string => `<button type="button" class="side-item" id="${key === 'overview' || key === 'combined' || key === 'gateway' ? `side-${key}` : `gs-${key}`}" aria-current="false"><span class="side-text">${label}</span>${pill}</button>`;
const sideClient = (client: ClientKey): string => `<button type="button" class="side-item" id="gs-${client}" aria-current="false">${clientIcon(client, true)}<span class="side-text">${CLIENT_NAMES[client]}</span><span class="side-pill" id="gs-pill-${client}">—</span><span class="gs-dot" id="gs-dot-${client}" aria-hidden="true" hidden></span><span class="sr-only" id="gs-state-${client}">Carregando</span></button>`;
const sidebar = `<aside class="sidebar" id="sidebar" data-open="false" aria-label="Navegação">
    <div class="drawer-head">
      <button type="button" class="drawer-close" id="drawer-close">Fechar menu</button>
    </div>
    <nav class="side-nav" aria-label="Visões">
      ${sideLabel('Observabilidade')}
      ${sideItem('overview', VIEWS[0]!.side, '<span class="side-pill" id="side-overview-pill">—</span>')}
      ${sideItem('combined', VIEWS[1]!.side)}
      ${sideLabel('Clientes')}
      ${CLIENTS.map(sideClient).join('\n      ')}
      ${sideLabel('Jev Gateway')}
      ${sideItem('gateway', VIEWS[5]!.side)}
    </nav>
    <div class="side-foot">
      ${themeSwitch('side')}
      <p class="side-memory" id="side-memory">AI Memory · Carregando</p>
      <div class="side-cache"><span class="side-label">Cache geral</span><span class="side-cache-value" id="side-cache">—</span></div>
      <div class="side-bar" aria-hidden="true"><span id="side-cache-bar"></span></div>
    </div>
  </aside>`;

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
${topbar}
<div class="scrim" id="scrim" hidden></div>
<div class="shell">
${sidebar}
<main class="content" id="content">
  <nav class="crumbs" aria-label="Caminho">
    <span>jev-memory</span><span class="sep" aria-hidden="true">/</span><span id="crumb-view">Visão geral</span>
    <span class="period-chip" id="crumb-period">Período: —</span>
  </nav>
  ${overviewView}
  <div class="gateway-views" id="token-observability">
    ${combinedView()}
    ${providerView('claude')}
    ${providerView('codex')}
    ${agyView()}
  </div>
  ${gatewayView(aggregator ?? null)}
</main>
</div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script src="/app.js" defer></script>
</body>
</html>
`;
}
