// Markup and panel script for the suite dashboard. Purpose: AI Memory panel plus the embedded Jev Gateway dashboard.
// Audience: maintainers. Date: 2026-10-21.
import { dashboardCss } from './dashboard-style.js';

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function dashboardHtml(gatewayUrl: string): string {
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
</main>

<div class="gateway-head"><h2>Jev Gateway</h2></div>
<iframe class="gateway-frame" title="Dashboard do Jev Gateway" src="${escapeHtml(gatewayUrl)}" sandbox="allow-scripts allow-same-origin"></iframe>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script src="/app.js" defer></script>
</body>
</html>
`;
}

