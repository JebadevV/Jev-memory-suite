// Stylesheet for the suite dashboard. Tokens and classes mirror upstream jev-gateway dashboard.html so both panels read as one site.
// Purpose: maintainers. Date: 2026-10-21.
export const dashboardCss = `
  :root {
    color-scheme: light;
    --plane: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --border: rgba(11, 11, 11, 0.1); --wash: rgba(11, 11, 11, 0.04);
    --good: #0ca30c; --warning: #fab219; --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --plane: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --border: rgba(255, 255, 255, 0.1); --wash: rgba(255, 255, 255, 0.05);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --plane: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --border: rgba(255, 255, 255, 0.1); --wash: rgba(255, 255, 255, 0.05);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--plane); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1180px; margin: 0 auto; padding: 20px 16px 24px; display: grid; gap: 16px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; }
  h1 { font-size: 18px; margin: 0; font-weight: 650; }
  h2 { font-size: 13px; margin: 0 0 12px; font-weight: 600; color: var(--ink-2); }
  .live { color: var(--muted); font-size: 12px; }
  .scope { color: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; min-width: 0; }
  .row-state { display: grid; gap: 16px; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
  @media (max-width: 760px) { .row-state { grid-template-columns: minmax(0, 1fr); } }
  main section, main article { min-width: 0; }

  .state-card { display: grid; gap: 6px; border-left: 4px solid var(--state, var(--muted)); }
  .state-card .who { font-size: 12px; color: var(--ink-2); }
  .state-card .state { display: flex; align-items: center; gap: 10px; font-size: 28px; font-weight: 650; line-height: 1.15; }
  .state-card .icon { flex: none; width: 26px; height: 26px; border-radius: 50%; background: var(--state, var(--muted)); color: #fff; font-size: 15px; font-weight: 700; display: grid; place-items: center; }
  .state-card .why { margin: 0; color: var(--ink-2); }
  .state-card .meta { margin: 0; color: var(--ink-2); font-size: 12px; overflow-wrap: anywhere; }
  .s-capturing { --state: var(--good); }
  .s-idle { --state: var(--muted); }
  .s-offline { --state: var(--critical); }

  .pair { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tile { padding: 12px 14px; min-width: 0; }
  .tile.pending { border-left: 4px solid var(--warning); }
  .tile .label { font-size: 12px; color: var(--ink-2); }
  .tile .value { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .tile .sub { font-size: 12px; color: var(--ink-2); }
  .tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }

  .recent { list-style: none; margin: 0; padding: 0; }
  .recent li { display: grid; gap: 2px; padding: 10px 0; border-top: 1px solid var(--border); }
  .recent li:first-child { border-top: 0; padding-top: 0; }
  .recent .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; min-width: 0; }
  .recent .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .recent .when { flex: none; font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .recent .meta { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; color: var(--ink-2); }
  .recent .badge { flex: none; font-size: 11px; color: var(--ink-2); border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; }
  .recent .path { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .empty { color: var(--ink-2); font-size: 13px; margin: 0; }

  .projects { display: flex; flex-wrap: wrap; gap: 4px; padding: 3px; width: fit-content; max-width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
  .project-tab { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; font: inherit; font-size: 13px; color: var(--ink-2); background: transparent; border: 0; border-radius: 9px; padding: 6px 12px; cursor: pointer; }
  .project-tab[aria-selected="true"] { color: var(--ink); background: var(--wash); font-weight: 600; }
  .project-name { min-width: 0; overflow-wrap: anywhere; }
  .project-tab .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .project-tab .dot.on { background: var(--good); }
  .project-tab .dot.off { background: var(--critical); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  .gateway-head { max-width: 1180px; margin: 0 auto; padding: 24px 16px 8px; }
  .gateway-frame { display: block; width: 100%; height: 100vh; border: 0; background: var(--plane); }
  .toasts { position: fixed; right: 16px; bottom: 16px; z-index: 10; display: grid; gap: 8px; width: min(360px, calc(100vw - 32px)); max-width: calc(100vw - 32px); pointer-events: none; }
  .toast { display: grid; gap: 2px; width: 100%; padding: 12px 14px; font: inherit; text-align: left; color: var(--ink); background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--good); border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); cursor: pointer; pointer-events: auto; animation: toast-in 180ms ease-out; }
  .toast-project { font-size: 11px; font-weight: 600; color: var(--ink-2); overflow-wrap: anywhere; }
  .toast-label { font-size: 12px; font-weight: 700; color: var(--ink); }
  .toast-title { font-weight: 600; overflow-wrap: anywhere; }
  .toast-body { font-size: 12px; color: var(--ink-2); overflow-wrap: anywhere; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
  [hidden] { display: none !important; }
  :focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
`;
