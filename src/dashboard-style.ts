// Stylesheet for the suite dashboard: neutral black and white tokens, the app shell and the views.
// Status colours appear only on dots and badges (data-tone). No shadows, no web fonts. Purpose: maintainers. Date: 2026-10-25.
export const dashboardCss = `
  :root {
    color-scheme: light;
    --canvas: #fafafa; --surface: #ffffff; --surface-2: #f5f5f5; --border: #e5e5e5; --border-strong: #d4d4d4;
    --text: #0a0a0a; --text-2: #525252; --text-3: #737373;
    --ok: #22c55e; --warn: #f59e0b; --err: #ef4444; --idle: #737373;
    --seg-1: #0a0a0a; --seg-2: #525252; --seg-3: #a3a3a3; --seg-4: #d4d4d4;
    --scrim: rgba(0, 0, 0, 0.4);
    --font: system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
    --side-w: 248px; --topbar-h: 104px;
    --r: 4px; --r-pill: 8px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --canvas: #0a0a0a; --surface: #111111; --surface-2: #161616; --border: #262626; --border-strong: #333333;
      --text: #fafafa; --text-2: #a3a3a3; --text-3: #737373;
      --seg-1: #fafafa; --seg-2: #a3a3a3; --seg-3: #737373; --seg-4: #404040;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --canvas: #0a0a0a; --surface: #111111; --surface-2: #161616; --border: #262626; --border-strong: #333333;
    --text: #fafafa; --text-2: #a3a3a3; --text-3: #737373;
    --seg-1: #fafafa; --seg-2: #a3a3a3; --seg-3: #737373; --seg-4: #404040;
  }
  /* Status reads through shape first: running is a solid dot, idle a hollow ring, warning a text-2 ring, key-required an amber
     ring, and only an unavailable gateway is red. */
  [data-tone="s-capturing"], [data-tone="s-ok"] { --dot-fill: var(--text); --dot-line: var(--text); }
  [data-tone="s-idle"] { --dot-fill: transparent; --dot-line: var(--text-3); }
  [data-tone="s-warn"] { --dot-fill: transparent; --dot-line: var(--text-2); }
  [data-tone="s-key"] { --dot-fill: transparent; --dot-line: var(--warn); }
  [data-tone="s-offline"] { --dot-fill: var(--err); --dot-line: var(--err); }

  * { box-sizing: border-box; }
  body { margin: 0; min-width: 0; background: var(--canvas); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 20px; -webkit-font-smoothing: antialiased; }
  h1, h2, h3, p, dl, dd, ol, ul { margin: 0; }
  button { font: inherit; color: inherit; }
  [hidden] { display: none !important; }
  :focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .meta { color: var(--text-2); font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
  .empty { color: var(--text-2); font-size: 13px; line-height: 18px; }
  .caption { color: var(--text-2); font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
  .why { color: var(--text-2); font-size: 13px; line-height: 18px; overflow-wrap: anywhere; }
  .kpi-sub { font: 11px/16px var(--mono); color: var(--text-2); overflow-wrap: anywhere; }
  .client-name { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  .client-icon { flex: none; width: 20px; height: 20px; border-radius: 22%; outline: 1px solid var(--border); outline-offset: -1px; }
  .client-icon.client-icon-sm { width: 16px; height: 16px; }
  .gs-dot { flex: none; box-sizing: border-box; width: 8px; height: 8px; border-radius: 999px; background: var(--dot-fill, transparent); border: 1.5px solid var(--dot-line, var(--text-3)); }

  /* Top bar: sticky, brand and live state, then the project chips and (desktop) the view tabs. */
  .topbar { position: sticky; top: 0; z-index: 30; display: grid; gap: 8px; min-width: 0; padding: 10px 16px; background: var(--canvas); border-bottom: 1px solid var(--border); }
  .topbar-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; min-width: 0; }
  .topbar-second { justify-content: flex-start; }
  .brand { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; min-width: 0; }
  .brand h1 { font-size: 15px; line-height: 20px; font-weight: 700; letter-spacing: -0.01em; }
  .scope { font: 11px/16px var(--mono); color: var(--text-2); overflow-wrap: anywhere; min-width: 0; }
  .topbar-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  .topbar-view { display: none; font-size: 14px; font-weight: 600; min-width: 0; }
  .live { display: inline-flex; align-items: center; gap: 6px; font: 11px/16px var(--mono); color: var(--text-2); white-space: nowrap; }
  .live::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 999px; background: var(--text-3); }
  .live[data-tone="s-ok"]::before { background: var(--text); }
  .live[data-tone="s-offline"]::before { background: var(--err); }
  .stale { color: var(--text-2); }
  .projects { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; max-width: 100%; }
  .project-tab { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; max-width: 100%; padding: 2px 8px; font-size: 12px; line-height: 16px; color: var(--text-2); background: transparent; border: 1px solid var(--border); border-radius: var(--r); cursor: pointer; }
  .project-tab[aria-selected="true"] { color: var(--text); background: var(--surface-2); border-color: var(--border-strong); }
  .project-tab .dot { flex: none; box-sizing: border-box; width: 6px; height: 6px; border-radius: 999px; background: var(--text); border: 1px solid var(--text); }
  .project-tab .dot.off { background: transparent; border-color: var(--text-3); }
  .project-name { min-width: 0; overflow-wrap: anywhere; }
  .project-state { font: 10px/12px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
  .tab { display: inline-flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px 10px; font-size: 13px; line-height: 18px; color: var(--text-2); background: transparent; border: 1px solid transparent; border-radius: var(--r); cursor: pointer; white-space: nowrap; }
  .tab:hover { color: var(--text); background: var(--surface-2); }
  .tab[aria-selected="true"] { color: var(--text); font-weight: 600; background: var(--surface-2); border-color: var(--border-strong); }
  .menu-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r); cursor: pointer; }
  .menu-bars { position: relative; display: block; width: 16px; height: 2px; background: var(--text); }
  .menu-bars::before, .menu-bars::after { content: ""; position: absolute; left: 0; width: 16px; height: 2px; background: var(--text); }
  .menu-bars::before { top: -5px; }
  .menu-bars::after { top: 5px; }
  .theme-switch { display: inline-grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 2px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r); }
  .theme-btn { min-height: 28px; padding: 2px 12px; font-size: 12px; line-height: 16px; color: var(--text-2); background: transparent; border: 1px solid transparent; border-radius: 3px; cursor: pointer; }
  .theme-btn[aria-pressed="true"] { color: var(--text); background: var(--surface); border-color: var(--border-strong); }
  .theme-top { display: inline-flex; }

  /* Shell: the sidebar sits beside the content from 1000px; below it the same sidebar is a drawer. */
  .shell { min-width: 0; }
  .sidebar { position: fixed; top: 0; left: 0; bottom: 0; z-index: 50; display: flex; flex-direction: column; gap: 8px; width: min(272px, 82vw); padding: 12px; overflow-y: auto; background: var(--surface); border-right: 1px solid var(--border); transform: translateX(-100%); visibility: hidden; transition: transform 180ms ease-out, visibility 180ms; }
  .sidebar[data-open="true"] { transform: none; visibility: visible; }
  .drawer-head { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
  .drawer-close { min-height: 32px; padding: 4px 10px; font-size: 12px; background: transparent; border: 1px solid var(--border-strong); border-radius: var(--r); cursor: pointer; }
  .scrim { position: fixed; inset: 0; z-index: 40; background: var(--scrim); }
  .side-nav { display: grid; gap: 2px; }
  .side-label { font: 10px/16px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); padding: 12px 8px 4px; }
  .side-item { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 4px 8px; font-size: 13px; line-height: 18px; text-align: left; color: var(--text-2); background: transparent; border: 1px solid transparent; border-radius: var(--r); cursor: pointer; }
  .side-item:hover { color: var(--text); background: var(--surface-2); }
  .side-item[aria-current="page"] { color: var(--text); font-weight: 600; background: var(--surface-2); border-color: var(--border-strong); }
  .side-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .side-pill { flex: none; padding: 0 6px; font: 10px/16px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-2); background: transparent; border: 1px solid var(--border-strong); border-radius: var(--r-pill); white-space: nowrap; }
  .side-pill[data-tone="s-offline"] { color: var(--err); border-color: var(--err); }
  .side-foot { margin-top: auto; display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid var(--border); }
  .side-foot .theme-switch { justify-self: start; }
  .side-memory { font: 11px/16px var(--mono); color: var(--text-2); overflow-wrap: anywhere; }
  .side-cache { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .side-cache .side-label { padding: 0; }
  .side-cache-value { font: 600 12px/16px var(--mono); font-variant-numeric: tabular-nums; }
  .side-bar { height: 4px; overflow: hidden; background: var(--surface-2); border-radius: 999px; }
  .side-bar > span { display: block; width: 0; height: 100%; background: var(--text); border-radius: 999px; }
  @media (max-width: 999px) {
    .menu-btn { display: inline-flex; }
    .tabs { display: none; }
    .topbar-view { display: block; }
    .theme-top { display: inline-flex; }
  }
  @media (min-width: 1000px) {
    .topbar { padding: 12px 24px; }
    .topbar-view, .theme-top, .menu-btn, .drawer-close, .scrim { display: none !important; }
    .shell { display: grid; grid-template-columns: var(--side-w) minmax(0, 1fr); align-items: start; }
    .sidebar { position: sticky; top: var(--topbar-h); left: auto; right: auto; bottom: auto; z-index: 1; width: auto; height: calc(100vh - var(--topbar-h)); padding: 16px 12px; transform: none; visibility: visible; transition: none; }
    .drawer-head { display: none; }
  }

  /* Content: a breadcrumb row, then one view. */
  .content { min-width: 0; display: grid; align-content: start; gap: 20px; padding: 16px 16px 48px; }
  @media (min-width: 1000px) { .content { gap: 24px; padding: 20px 28px 64px; } }
  .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; font: 12px/16px var(--mono); color: var(--text-2); }
  .crumbs .sep { color: var(--text-3); }
  .period-chip { margin-left: auto; max-width: 100%; padding: 2px 8px; font: 11px/16px var(--mono); color: var(--text-2); border: 1px solid var(--border); border-radius: var(--r-pill); overflow-wrap: anywhere; }
  .view { display: grid; gap: 16px; min-width: 0; scroll-margin-top: calc(var(--topbar-h) + 12px); }
  .gateway-views { display: grid; gap: 24px; min-width: 0; }
  .view-head { display: grid; gap: 4px; min-width: 0; }
  .view-title { font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  .view-desc { max-width: 72ch; color: var(--text-2); font-size: 13px; line-height: 18px; }
  .view-card { display: grid; gap: 16px; min-width: 0; }
  .view-top { display: grid; gap: 6px; min-width: 0; }
  .view-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
  .view-meta .state { display: inline-flex; align-items: center; gap: 8px; min-height: 24px; padding: 0 10px; font-size: 14px; font-weight: 600; color: var(--text); background: transparent; border: 1px solid var(--border-strong); border-radius: var(--r-pill); }
  .view-meta .state::before { content: ""; flex: none; box-sizing: border-box; width: 8px; height: 8px; border-radius: 999px; background: var(--dot-fill, transparent); border: 1.5px solid var(--dot-line, var(--text-3)); }
  .view-grid { display: grid; gap: 16px; min-width: 0; }
  .view-side { display: grid; gap: 16px; align-content: start; min-width: 0; }
  @media (min-width: 1000px) { .view-side { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; } .view-side > .disclosure { grid-column: 1 / -1; } }
  .card { display: grid; align-content: start; gap: 12px; min-width: 0; padding: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); }
  .card-title { font-size: 14px; line-height: 20px; font-weight: 600; overflow-wrap: anywhere; }
  .card-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
  .disclosure { display: block; }
  .disclosure > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; font-size: 14px; font-weight: 600; cursor: pointer; list-style: none; }
  .disclosure > summary::-webkit-details-marker { display: none; }
  .disclosure > summary::after { content: "+"; flex: none; font: 400 14px/20px var(--mono); color: var(--text-2); }
  .disclosure[open] > summary::after { content: "\\2212"; }
  .disclosure[open] > .disc-body { margin-top: 12px; }
  .disc-body { display: grid; gap: 12px; min-width: 0; }
  .disclosure + .disclosure { margin-top: 16px; }

  /* Overview: the memory state, six totals and the recent rows. */
  .state-card { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
  .state-card .who { font: 11px/16px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }
  .state-card .state { display: inline-flex; align-items: center; gap: 8px; font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -0.01em; }
  .state-card .icon { flex: none; display: inline-block; width: 16px; color: var(--dot-line, var(--text-3)); font-size: 16px; line-height: 20px; text-align: center; }
  .state-card .why { flex-basis: 100%; }
  .numbers { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); min-width: 0; }
  @media (min-width: 600px) { .numbers { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (min-width: 1000px) { .numbers { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
  .num { display: grid; gap: 6px; align-content: start; min-width: 0; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); }
  .num .label { font: 11px/16px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }
  .num .value { font: 600 20px/24px var(--mono); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .num .sub { display: none; }
  .num.pending .label::before { content: ""; display: inline-block; box-sizing: border-box; width: 6px; height: 6px; margin-right: 6px; border-radius: 999px; border: 1px solid var(--text-2); vertical-align: middle; }
  .recent { list-style: none; margin: 0; padding: 0; }
  .recent li { display: grid; gap: 4px; min-width: 0; padding: 8px 0; }
  .recent li + li { border-top: 1px solid var(--border); }
  .recent .row { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .recent .title { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 13px; line-height: 18px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
  .recent .when { flex: none; font: 11px/16px var(--mono); color: var(--text-2); font-variant-numeric: tabular-nums; }
  .recent .badge { flex: none; padding: 0 6px; font: 10px/16px var(--mono); color: var(--text-2); border: 1px solid var(--border); border-radius: var(--r-pill); }
  .recent .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  .recent .path { min-width: 0; overflow: hidden; font: 11px/16px var(--mono); text-overflow: ellipsis; white-space: nowrap; }

  /* Tokens: the provider cards, then the comparison, the traffic split and the per-model table. */
  .pcards { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); min-width: 0; }
  @media (min-width: 600px) { .pcards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (min-width: 1200px) { .pcards { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  .pcard { display: flex; flex-direction: column; gap: 12px; width: 100%; min-width: 0; padding: 16px; text-align: left; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); }
  button.pcard { cursor: pointer; }
  button.pcard:hover { border-color: var(--border-strong); }
  .total-card { cursor: default; }
  .pcard-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px; min-width: 0; }
  .pcard-name { min-width: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
  .pill { display: inline-flex; flex: none; align-items: center; gap: 6px; min-height: 24px; padding: 0 8px; font-size: 12px; line-height: 18px; white-space: nowrap; color: var(--text-2); background: transparent; border: 1px solid var(--border-strong); border-radius: var(--r-pill); }
  .pill .gs-dot { width: 6px; height: 6px; }
  .pcard-big { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .pcard-num { min-width: 0; font: 600 24px/28px var(--mono); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .pcard-unit { font: 11px/16px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }
  .pcard-row, .pcard-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; }
  .pcard-row { padding: 6px 8px; background: var(--surface-2); border-radius: var(--r); }
  .pcard-foot { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border); }
  .pcard-label { min-width: 0; font-size: 12px; line-height: 16px; color: var(--text-2); }
  .pcard-foot .pcard-label { font: 11px/16px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }
  .pcard-val { font: 600 13px/18px var(--mono); font-variant-numeric: tabular-nums; text-align: right; overflow-wrap: anywhere; }
  .pcard-val-wrap { display: grid; justify-items: end; gap: 2px; min-width: 0; text-align: right; }
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .tile { display: grid; gap: 4px; min-width: 0; padding: 8px; background: var(--surface-2); border-radius: var(--r); }
  .tile .pcard-label { font: 10px/14px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }
  .tile .pcard-val { font-size: 16px; line-height: 22px; text-align: left; }
  .tokens-grid { display: grid; gap: 16px; min-width: 0; }
  .tokens-left, .tokens-right { display: grid; align-content: start; gap: 16px; min-width: 0; }
  @media (min-width: 1000px) { .tokens-grid { grid-template-columns: minmax(220px, 1fr) minmax(0, 2.6fr); align-items: start; } }
  .cmp-list { display: grid; min-width: 0; }
  .cmp-block { display: grid; gap: 8px; min-width: 0; padding: 12px 0; border-top: 1px solid var(--border); }
  .cmp-block:first-child { padding-top: 0; border-top: 0; }
  .cmp-label { font: 11px/16px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }
  .cmp-cells { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .cmp-cell { display: grid; gap: 2px; min-width: 0; padding: 8px; background: var(--surface-2); border-radius: var(--r); }
  .cmp-cap { font-size: 11px; line-height: 16px; color: var(--text-2); }
  .cmp-val { font: 600 15px/20px var(--mono); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .cmp-delta { font: 11px/16px var(--mono); color: var(--text-2); }
  .traffic-bar { display: flex; height: 10px; overflow: hidden; background: var(--surface-2); border-radius: var(--r); }
  .traffic-bar > span { display: block; height: 100%; min-width: 0; }
  .traffic-bar > [data-seg="1"] { background: var(--seg-1); }
  .traffic-bar > [data-seg="2"] { background: var(--seg-2); }
  .traffic-bar > [data-seg="3"] { background: var(--seg-3); }
  .traffic-bar > [data-seg="4"] { background: var(--seg-4); }
  .traffic-legend { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin: 0; padding: 0; list-style: none; font-size: 12px; line-height: 16px; }
  .traffic-legend li { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .legend-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
  .legend-pct { margin-left: auto; font: 600 12px/16px var(--mono); font-variant-numeric: tabular-nums; }
  .swatch { flex: none; width: 8px; height: 8px; border-radius: 999px; }
  .swatch[data-seg="1"] { background: var(--seg-1); }
  .swatch[data-seg="2"] { background: var(--seg-2); }
  .swatch[data-seg="3"] { background: var(--seg-3); }
  .swatch[data-seg="4"] { background: var(--seg-4); }
  .callout { flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; }
  .callout > div { display: grid; gap: 4px; min-width: 0; }
  .btn { min-height: 32px; padding: 6px 12px; font-size: 12px; line-height: 16px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r); cursor: pointer; }
  .btn:hover { border-color: var(--text-3); }
  .gw-table-wrap { min-width: 0; max-width: 100%; overflow-x: auto; }
  .gw-table { width: 100%; border-collapse: collapse; font: 12px/16px var(--mono); font-variant-numeric: tabular-nums; }
  .gw-table th, .gw-table td { height: 36px; padding: 0 4px; text-align: right; white-space: nowrap; vertical-align: middle; border-top: 1px solid var(--border); }
  @media (max-width: 599px) { .gw-table th, .gw-table td { padding: 0 3px; } .gw-table .mname { max-width: 70px; } }
  .gw-table .mname { display: inline-block; max-width: 128px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
  .gw-table thead th { height: auto; padding: 6px 6px; font: 10px/12px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); font-weight: 500; white-space: normal; border-top: 0; border-bottom: 1px solid var(--border); }
  .gw-table thead th:first-child, .gw-table tbody th, .gw-table tfoot th { text-align: left; }
  .gw-table tbody th { font-weight: 600; color: var(--text); }
  .gw-table tfoot th, .gw-table tfoot td { font-weight: 600; background: var(--surface-2); }
  .gw-table tfoot .tf-label { font: 11px/16px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; white-space: normal; }
  .mdot { display: inline-block; width: 6px; height: 6px; margin-right: 8px; vertical-align: middle; background: var(--text-3); border-radius: 999px; }
  .gw-models { min-width: 600px; }
  .gw-disclaimer { max-width: 90ch; }
  @media (max-width: 599px) {
    .gw-models { min-width: 0; }
    .gw-models th:nth-child(3), .gw-models td:nth-child(3), .gw-models th:nth-child(4), .gw-models td:nth-child(4),
    .gw-models th:nth-child(5), .gw-models td:nth-child(5),
    .gw-models th:nth-child(6), .gw-models td:nth-child(6), .gw-models th:nth-child(8), .gw-models td:nth-child(8) { display: none; }
  }

  /* From 1200px the telemetry card gets a fixed 300px left column, so the eight columns fit without truncation or inner scroll. */
  @media (min-width: 1200px) {
    .tokens-grid { grid-template-columns: 300px minmax(0, 1fr); }
    .gw-table th, .gw-table td { padding: 0 2px; }
    .gw-table .mname { max-width: none; }
  }

  /* Rows of label and value, and the KPI cards. */
  .rows { display: grid; min-width: 0; }
  .rows > div { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, auto); gap: 12px; align-items: baseline; min-width: 0; padding: 8px 0; border-top: 1px solid var(--border); }
  .rows > div:first-child { padding-top: 0; border-top: 0; }
  .rows dt { font-size: 12px; line-height: 16px; color: var(--text-2); }
  .rows dd { font: 600 13px/18px var(--mono); font-variant-numeric: tabular-nums; text-align: right; overflow-wrap: anywhere; }
  .rows.spec { grid-template-columns: minmax(0, 1fr); }
  @media (min-width: 600px) { .rows.spec { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 24px; } .rows.spec > div:nth-child(2) { border-top: 0; padding-top: 0; } }
  .agy-period { font: 11px/16px var(--mono); color: var(--text-2); overflow-wrap: anywhere; }
  .kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; min-width: 0; }
  @media (min-width: 760px) { .kpis { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
  .kpi { display: grid; align-content: start; gap: 4px; min-width: 0; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); }
  .kpi.kpi-period { grid-column: 1 / -1; }
  @media (min-width: 760px) { .kpi.kpi-period { grid-column: auto; } }
  .kpi dt { font: 11px/16px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }
  .kpi .kpi-value { font: 600 20px/24px var(--mono); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .kpi.kpi-period .kpi-value { font: 600 13px/18px var(--mono); }
  .kpi.agy-kpi-warn .kpi-value, .rows .agy-kpi-warn dd { color: var(--err); }

  /* Jev Gateway panel: the iframe or the offline notice. */
  .gateway-head h2 { font-size: 14px; line-height: 20px; font-weight: 600; }
  .gateway-frame { display: block; width: 100%; height: 100vh; border: 0; background: var(--canvas); }
  .gateway-frame.gateway-tall { height: 80vh; }
  .gateway-offline { display: grid; gap: 8px; }
  .gateway-offline p { color: var(--text-2); }
  .gateway-offline code { font: 12px/16px var(--mono); }

  /* Antigravity: the spec card, the model list and the recent grid. */
  .agy-models { display: grid; gap: 12px; min-width: 0; margin: 0; padding: 0; list-style: none; }
  @media (min-width: 760px) { .agy-models { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 24px; } }
  .agy-models li { display: grid; gap: 6px; min-width: 0; }
  .agy-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; font-size: 12px; line-height: 16px; }
  .agy-name { min-width: 0; overflow: hidden; font: 600 12px/16px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
  .agy-count { flex: none; font: 11px/16px var(--mono); color: var(--text-2); font-variant-numeric: tabular-nums; }
  .agy-bar { height: 6px; overflow: hidden; background: var(--surface-2); border-radius: 999px; }
  .agy-bar > span { display: block; height: 100%; max-width: 100%; background: var(--text-2); border-radius: 999px; }
  .agy-meta { margin: 0; font: 11px/16px var(--mono); color: var(--text-2); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .agy-recent .agy-num { font-variant-numeric: tabular-nums; }
  .agy-recent .agy-num::before { content: attr(data-label) " "; font-weight: 400; color: var(--text-2); }
  .agy-recent .badge.agy-err { color: var(--err); border-color: var(--err); }
  .agy-recent-head { display: none; }
  .agy-more { justify-self: start; min-height: 32px; padding: 4px 0; font-size: 12px; font-weight: 600; color: var(--text-2); background: transparent; border: 0; cursor: pointer; }
  .agy-more:hover { color: var(--text); }
  @media (min-width: 1000px) {
    .agy-recent-wrap { --agy-cols: 64px minmax(0, 1fr) 56px 150px 72px 80px 80px 96px; }
    .agy-recent-head { display: grid; grid-template-columns: var(--agy-cols); column-gap: 12px; padding-bottom: 6px; font: 10px/12px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); border-bottom: 1px solid var(--border); }
    .agy-recent-head span:nth-child(n+5) { text-align: right; }
    .agy-recent .agy-item { grid-template-columns: var(--agy-cols); column-gap: 12px; align-items: center; min-height: 36px; padding: 6px 0; font-size: 12px; line-height: 16px; }
    .agy-recent .agy-item .row, .agy-recent .agy-item .meta { display: contents; }
    .agy-recent .when { grid-column: 1; grid-row: 1; }
    .agy-recent .title { grid-column: 2; grid-row: 1; font-size: 12px; line-height: 16px; }
    .agy-recent .badge { grid-column: 3; grid-row: 1; justify-self: start; }
    .agy-recent .path { grid-column: 4; grid-row: 1; }
    .agy-recent .agy-num { grid-row: 1; text-align: right; white-space: nowrap; }
    .agy-recent .agy-num[data-label="duração"] { grid-column: 5; }
    .agy-recent .agy-num[data-label="entrada"] { grid-column: 6; }
    .agy-recent .agy-num[data-label="saída"] { grid-column: 7; }
    .agy-recent .agy-num[data-label="raciocínio"] { grid-column: 8; }
    .agy-recent .agy-num::before { content: none; }
  }

  .toasts { position: fixed; right: 16px; bottom: 16px; z-index: 60; display: grid; gap: 8px; width: min(360px, calc(100vw - 32px)); max-width: calc(100vw - 32px); pointer-events: none; }
  .toast { display: grid; gap: 2px; width: 100%; padding: 12px 16px; font: inherit; text-align: left; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r); cursor: pointer; pointer-events: auto; animation: toast-in 180ms ease-out; }
  .toast-project { font-size: 11px; font-weight: 600; color: var(--text-2); overflow-wrap: anywhere; }
  .toast-label { font-size: 12px; font-weight: 700; color: var(--text); }
  .toast-title { font-weight: 600; overflow-wrap: anywhere; }
  .toast-body { font-size: 12px; line-height: 16px; color: var(--text-2); overflow-wrap: anywhere; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) {
    .toast, .sidebar { animation: none; transition: none; }
  }
`;
