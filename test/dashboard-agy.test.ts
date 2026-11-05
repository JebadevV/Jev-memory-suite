// Behavior tests for the Antigravity (agy) panel of the suite dashboard.
// The real /app.js (dashboardJs, which embeds dashboardGatewayJs) runs inside node:vm against a tiny fake DOM built
// from the real dashboardHtml(null) markup. fetch, timers and Date are stubbed; polls are driven by calling the captured
// interval callbacks. innerHTML is a setter that throws and records a violation, so any markup write fails the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dashboardHtml } from '../src/dashboard-page.js';
import { dashboardJs } from '../src/dashboard-script.js';
import type { AgyLive, AgyRecent, GatewayStatus } from '../src/gateways.js';
import type { CostEstimate, RouteMetrics } from '../src/gateway-metrics.js';
import type { Compare, CompareRow } from '../src/gateway-views.js';

// Strings the browser script shows; copied from dashboard-gateway-script.ts.
const AGY_PASSTHROUGH_NOTE = 'Tráfego do Google Antigravity vai direto ao Google; o Jev só observa.';
const AGY_NO_LIVE_RECENT = 'Gateway parado ou sem resposta: atividade recente indisponível.';
const HOSTILE = '<img src=x onerror=alert(1)>';
const TONES = ['s-ok', 's-warn', 's-key', 's-idle', 's-offline'];

const FAIL = Symbol('fetch failure');
const NOW_MS = Date.parse('2026-10-25T12:00:00.000Z');
const START_AT = '2026-10-25T08:00:00.000Z'; // 4 h before NOW
const LAST_AT = '2026-10-25T11:57:00.000Z'; // 3 min before NOW

const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length === 0 ? [NOW_MS] : args) as [number]));
  }
  static now(): number { return NOW_MS; }
}

// Expected text is built with the same Intl formats the browser script uses.
const pt = (value: number, options?: Intl.NumberFormatOptions): string => new Intl.NumberFormat('pt-BR', options).format(value);
const count = (value: number): string => pt(value);
const compact = (value: number): string => pt(value, { notation: 'compact', maximumFractionDigits: 1 });
const seconds = (ms: number): string => pt(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' s';

// ---- Fake DOM -------------------------------------------------------------------------------------------------------

class FakeClassList {
  constructor(private readonly node: FakeElement) {}
  private tokens(): string[] { return this.node.className.split(/\s+/).filter(Boolean); }
  private write(tokens: string[]): void { this.node.className = tokens.join(' '); }
  contains(name: string): boolean { return this.tokens().includes(name); }
  add(...names: string[]): void {
    const tokens = this.tokens();
    for (const name of names) if (!tokens.includes(name)) tokens.push(name);
    this.write(tokens);
  }
  remove(...names: string[]): void { this.write(this.tokens().filter(token => !names.includes(token))); }
  toggle(name: string, force?: boolean): boolean {
    const want = force ?? !this.contains(name);
    if (want) this.add(name); else this.remove(name);
    return want;
  }
}

class FakeElement {
  className = '';
  hidden = false;
  title = '';
  textContent = '';
  tabIndex = 0;
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly listeners: Array<{ type: string; fn: unknown }> = [];
  readonly classList: FakeClassList;

  constructor(readonly tagName: string, readonly id: string, private readonly violations: string[]) {
    this.classList = new FakeClassList(this);
  }
  get innerHTML(): string { return ''; }
  set innerHTML(value: string) {
    this.violations.push(`innerHTML on ${this.tagName}#${this.id}`);
    throw new Error(`innerHTML is not allowed: ${value.slice(0, 40)}`);
  }
  get firstChild(): FakeElement | null { return this.children[0] ?? null; }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  appendChild(node: FakeElement): FakeElement {
    node.parentNode?.removeChild(node);
    this.children.push(node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: FakeElement): FakeElement {
    const index = this.children.indexOf(node);
    if (index < 0) throw new Error('removeChild: not a child');
    this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  remove(): void { this.parentNode?.removeChild(this); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  addEventListener(type: string, fn: unknown): void { this.listeners.push({ type, fn }); }
  click(): void { this.dispatch('click', {}); }
  dispatch(type: string, event: object): void {
    for (const listener of this.listeners) if (listener.type === type) (listener.fn as (e: object) => void)(event);
  }
  focused = false;
  focus(): void { this.focused = true; }
  scrolled = 0;
  scrollIntoView(): void { this.scrolled += 1; }
}

// Parses opening tags that carry an id, and their attributes (bare attributes such as `hidden` included).
const OPEN_TAG = /<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g;
const ATTR = /([\w:-]+)(?:="([^"]*)")?/g;
function parseIds(html: string): Array<{ tag: string; id: string; attrs: Map<string, string> }> {
  const found: Array<{ tag: string; id: string; attrs: Map<string, string> }> = [];
  for (const match of html.matchAll(OPEN_TAG)) {
    const attrs = new Map<string, string>();
    for (const attr of (match[2] ?? '').matchAll(ATTR)) attrs.set(attr[1] ?? '', attr[2] ?? '');
    const id = attrs.get('id');
    if (id !== undefined) found.push({ tag: match[1] ?? 'div', id, attrs });
  }
  return found;
}

function descendants(node: FakeElement): FakeElement[] {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}
const byClass = (node: FakeElement, name: string): FakeElement[] => descendants(node).filter(n => n.classList.contains(name));

// ---- Harness --------------------------------------------------------------------------------------------------------

const flush = (): Promise<void> => new Promise(ok => setImmediate(ok));
const never = (): Promise<never> => new Promise<never>(() => undefined);

class Dashboard {
  readonly byId = new Map<string, FakeElement>();
  readonly violations: string[] = [];
  readonly createdTags: string[] = [];
  readonly fetchLog: Array<{ url: string; options: unknown }> = [];
  // The <html> element (where the theme is set) and the keydown listeners registered on the document (the drawer's Escape).
  readonly root: FakeElement;
  readonly documentKeys: Array<(event: object) => void> = [];
  private readonly intervals: Array<() => void> = [];
  private readonly queue: unknown[];
  private readonly context: vm.Context;

  // `replies` are the gateway responses for the polls, in order; the first one is consumed by the load-time poll.
  // `storage` is the window.localStorage stand-in; left out, the window has no storage at all (as a blocked browser may).
  // `summary` is the body the memory summary route answers with; left out, that route stays unanswered.
  constructor(replies: unknown[], storage?: unknown, summary?: unknown) {
    this.queue = [...replies];
    const html = dashboardHtml(null);
    const parsed = parseIds(html);
    const idAttributes = (html.match(/\sid="/g) ?? []).length;
    assert.equal(parsed.length, idAttributes, 'every id in the markup is parsed');
    for (const { tag, id, attrs } of parsed) {
      assert.equal(this.byId.has(id), false, `duplicate id ${id}`);
      const node = new FakeElement(tag, id, this.violations);
      node.className = attrs.get('class') ?? '';
      node.hidden = attrs.has('hidden');
      for (const [name, value] of attrs) if (name !== 'id' && name !== 'class') node.setAttribute(name, value);
      this.byId.set(id, node);
    }

    this.root = new FakeElement('html', 'html-root', this.violations);
    const document = {
      activeElement: null,
      documentElement: this.root,
      getElementById: (id: string): FakeElement | null => this.byId.get(id) ?? null,
      createElement: (tag: string): FakeElement => {
        this.createdTags.push(tag);
        return new FakeElement(tag, '', this.violations);
      },
      addEventListener: (type: string, fn: (event: object) => void): void => { if (type === 'keydown') this.documentKeys.push(fn); },
    };
    const fetch = (url: string, options: unknown): Promise<unknown> => {
      this.fetchLog.push({ url, options });
      if (url.split('?')[0] === '/memory/summary' && summary !== undefined) {
        return Promise.resolve({ json: () => Promise.resolve(JSON.parse(JSON.stringify(summary))) });
      }
      // Only the gateway route is answered by the queue; the other memory routes stay unanswered and do not touch the agy panel.
      if (url.split('?')[0] !== '/gateways/status') return never();
      if (this.queue.length === 0) return never();
      const reply = this.queue.shift();
      if (reply === FAIL) return Promise.reject(new TypeError('fetch failed'));
      const text = JSON.stringify(reply);
      return Promise.resolve({ json: () => Promise.resolve(JSON.parse(text)) });
    };
    const sandbox: Record<string, unknown> = {
      document,
      window: storage === undefined ? {} : { localStorage: storage }, // no localStorage by default: the guarded reads fall back
      URL,
      Date: FixedDate,
      fetch,
      setInterval: (fn: () => void): number => this.intervals.push(fn),
      clearInterval: (): void => undefined,
      // Timeouts are captured but never run: toast expiry is out of scope for the agy panel.
      setTimeout: (): number => 0,
      clearTimeout: (): void => undefined,
    };
    this.context = vm.createContext(sandbox);
    vm.runInContext(dashboardJs, this.context, { filename: 'app.js' });
  }

  // Queues the given gateway replies, then fires every captured interval once and lets the promise chains settle.
  async tick(...replies: unknown[]): Promise<void> {
    this.queue.push(...replies);
    for (const run of [...this.intervals]) run();
    await flush();
  }

  el(id: string): FakeElement {
    const node = this.byId.get(id);
    if (!node) throw new Error(`missing #${id}`);
    return node;
  }
  text(id: string): string { return this.el(id).textContent; }
  // The tone is the data-tone attribute: the layout classes are never rewritten by the script.
  tones(id: string): string[] {
    const tone = this.el(id).getAttribute('data-tone');
    return TONES.filter(name => name === tone);
  }
  pressDocumentKey(key: string): void { for (const fn of this.documentKeys) fn({ key, preventDefault: () => undefined }); }
  polls(): number { return this.fetchLog.filter(entry => entry.url.startsWith('/gateways/status')).length; }
}

async function loadDashboard(replies: unknown[] = [], storage?: unknown, summary?: unknown): Promise<Dashboard> {
  const dashboard = new Dashboard(replies, storage, summary);
  await flush();
  return dashboard;
}

// ---- Fixtures (shapes from src/gateways.ts, src/gateway-metrics.ts and src/gateway-views.ts) --------------------------

function routeMetrics(events: number): RouteMetrics & { complete: boolean } {
  return {
    events, firstAt: '2026-10-01T10:00:00.000Z', lastAt: LAST_AT, complete: true,
    modes: { passthrough: events, none: 0, forced: 0, hint: 0, direct: 0, other: 0 },
    reasons: {},
    jev: {
      calls: 0, errors: 0, inputTokens: 0, outputTokens: null, latencyMsAvg: null, latencyMsP50: null, latencyMsP90: null,
      blockingLatencyMs: 0, confidence: { below50: 0, from50to70: 0, from70to90: 0, atLeast90: 0 },
    },
    llm: { calls: events, input: 180000, uncachedInput: 60000, cacheRead: 120000, cacheWrite: 0, output: 9000, reasoning: 1500 },
    avoidedLlmCalls: 0, durationMsAvg: 1800, durationMsP50: 1500, durationMsP90: 3200, shadowEvents: 0,
  };
}
function costOf(total: number | null, llm: number | null): CostEstimate {
  return { currency: 'USD', llm, jev: null, total, missing: total === null ? ['jev-price'] : [] };
}
function compareRow(requests: number): CompareRow {
  return { requests, inputPerRequest: 4000, cachedPct: 70, outputPerRequest: 300, reasoningPerRequest: 50, secondsPerRequest: 2.1, totalInput: 4000 * requests };
}
const COMPARE: Compare = { withJev: compareRow(30), baseline: compareRow(12), shadow: null };

function classicGateway(client: 'claude' | 'codex', state: 'running' | 'stopped'): GatewayStatus {
  const running = state === 'running';
  return {
    client, label: client === 'claude' ? 'Claude' : 'Codex', port: client === 'claude' ? 8789 : 8790, portValid: true,
    state, metrics: running ? 'ok' : 'offline',
    router: running
      ? {
        routing: true, shadow: false, minConfidence: 0.7, recorded: 30, startedAt: START_AT,
        upstream: client === 'claude' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1', jevModel: null, jevProvider: null,
      }
      : null,
    history: routeMetrics(12), historyCompare: COMPARE, cost: { history: costOf(null, 0.42) },
    models: { history: [{ model: client === 'claude' ? 'claude-sonnet-4-5' : 'gpt-5-codex', metrics: routeMetrics(12), cost: costOf(null, 0.42) }] },
    experiment: 'default', billing: 'api',
  };
}

function agyGateway(state: GatewayStatus['state'], metrics: GatewayStatus['metrics'], live: AgyLive | null): GatewayStatus {
  const running = state === 'running';
  return {
    client: 'agy', label: 'Antigravity', port: 8794, portValid: true, state, metrics,
    router: running
      ? {
        routing: false, shadow: false, minConfidence: null, recorded: 42, startedAt: START_AT,
        upstream: 'https://cloudcode-pa.googleapis.com/v1internal', jevModel: null, jevProvider: null,
      }
      : null,
    history: routeMetrics(42), historyCompare: null, cost: { history: null },
    models: {
      history: [
        { model: 'gemini-2.5-pro', metrics: routeMetrics(30), cost: costOf(null, null) },
        { model: 'gemini-2.5-flash', metrics: routeMetrics(12), cost: costOf(null, null) },
      ],
    },
    experiment: 'passthrough', billing: 'subscription', agyLive: live,
  };
}

const RECENT: AgyRecent[] = [
  { time: '2026-10-25T11:57:00.000Z', model: 'gemini-2.5-pro', method: 'streamGenerateContent', status: 200, durationMs: 1500, input: 9000, cacheRead: 7000, output: 300, reasoning: 50 },
  { time: '2026-10-25T11:50:00.000Z', model: 'gemini-2.5-flash', method: 'generateContent', status: 200, durationMs: 800, input: 4000, cacheRead: 0, output: 120, reasoning: 0 },
  { time: '2026-10-25T11:20:00.000Z', model: 'gemini-2.5-pro', method: 'generateContent', status: 200, durationMs: 1200, input: 8000, cacheRead: 6000, output: 200, reasoning: 20 },
];

function agyLive(window: Partial<AgyLive['window']> = {}, recent: AgyRecent[] = RECENT): AgyLive {
  return {
    pid: 4242, codeAssist: 2, routing: false, startedAt: START_AT,
    window: {
      requests: 42, errors: 0, statuses: { ok: 42, clientError: 0, serverError: 0, other: 0 },
      input: 180000, cacheRead: 120000, output: 9000, reasoning: 1500,
      durationMsP50: 1500, durationMsP90: 3200, firstAt: '2026-10-25T09:00:00.000Z', lastAt: LAST_AT,
      ...window,
    },
    recent,
  };
}

// The body of GET /gateways/status as the server sends it (aggregator exposed as client+port or null).
function statusBody(gateways: GatewayStatus[]): unknown {
  return {
    ok: true, generatedAt: '2026-10-25T12:00:00.000Z', gateways,
    combined: {
      history: routeMetrics(42), cost: { history: costOf(null, 0.42) }, models: { history: [] }, historyCompare: COMPARE,
    },
    pricing: { models: {}, jev: null }, aggregator: null,
  };
}
const agyOk = (): GatewayStatus => agyGateway('running', 'ok', agyLive());

// ---- Tests ----------------------------------------------------------------------------------------------------------

test('before the first poll the agy panel shows Carregando and no data', async () => {
  const d = await loadDashboard([]);
  assert.ok(d.fetchLog.some(entry => entry.url === '/gateways/status'));
  assert.equal(d.text('obs-agy-state'), 'Carregando');
  assert.deepEqual(d.tones('obs-agy'), ['s-idle']);
  assert.equal(d.text('obs-agy-why'), '');
  assert.equal(d.text('obs-agy-requests'), '—');
  assert.equal(d.text('obs-agy-period'), 'Carregando…');
  assert.equal(d.el('obs-agy-recent-empty').hidden, false);
  assert.equal(d.text('obs-agy-recent-empty'), 'Carregando…');
  assert.equal(d.violations.length, 0);
});

test('running with metrics and live data shows Em execução, facts, KPIs and recent rows', async () => {
  const d = await loadDashboard([statusBody([classicGateway('claude', 'running'), classicGateway('codex', 'running'), agyOk()])]);
  assert.equal(d.text('obs-agy-state'), 'Em execução');
  assert.deepEqual(d.tones('obs-agy'), ['s-ok']);
  assert.equal(d.text('obs-agy-why'), AGY_PASSTHROUGH_NOTE);

  // Facts
  assert.equal(d.text('obs-agy-pid'), count(4242));
  assert.equal(d.text('obs-agy-contract'), 'contrato v2');
  assert.ok(d.text('obs-agy-mode').includes('roteamento travado'));
  assert.equal(d.text('obs-agy-mode'), 'Passthrough · roteamento travado');
  assert.equal(d.text('obs-agy-upstream'), 'cloudcode-pa.googleapis.com');
  assert.equal(d.text('obs-agy-billing'), 'Assinatura');
  assert.equal(d.text('obs-agy-uptime'), '4 h 0 min');

  // KPIs: none of the values is a dash
  assert.equal(d.text('obs-agy-requests'), '42');
  assert.equal(d.text('obs-agy-requests-sub'), '42 na janela recente');
  assert.equal(d.text('obs-agy-input'), compact(180000));
  assert.equal(d.text('obs-agy-input-sub'), '67% do cache');
  assert.equal(d.text('obs-agy-output'), compact(9000));
  assert.equal(d.text('obs-agy-output-sub'), 'raciocínio ' + compact(1500));
  assert.equal(d.text('obs-agy-latency'), seconds(1500));
  assert.equal(d.text('obs-agy-latency-sub'), 'p90 ' + seconds(3200));
  assert.equal(d.text('obs-agy-errors'), '0');
  assert.equal(d.text('obs-agy-errors-sub'), 'de 42 · 4xx 0 · 5xx 0');
  assert.equal(d.text('obs-agy-last'), 'há 3 min');
  assert.equal(d.el('obs-agy-kpi-errors').classList.contains('agy-kpi-warn'), false);

  // Model rows from the history, sorted by requests, with their share
  const models = d.el('obs-agy-models-body').children;
  assert.equal(models.length, 2);
  assert.equal(byClass(models[0]!, 'agy-name')[0]?.textContent, 'gemini-2.5-pro');
  assert.equal(byClass(models[0]!, 'agy-count')[0]?.textContent, '30 req · 71%');
  assert.equal(d.el('obs-agy-models-empty').hidden, true);

  // Recent list: one item per live entry, text only
  const recent = d.el('obs-agy-recent').children;
  assert.equal(recent.length, RECENT.length);
  assert.equal(byClass(recent[0]!, 'title')[0]?.textContent, 'gemini-2.5-pro');
  assert.equal(byClass(recent[0]!, 'badge')[0]?.textContent, '200');
  assert.ok(byClass(recent[0]!, 'badge')[0]?.classList.contains('agy-ok'));
  assert.equal(d.el('obs-agy-recent-empty').hidden, true);
  assert.equal(d.el('obs-agy-recent-more').hidden, true, 'three rows need no toggle');
  assert.ok(d.text('obs-agy-period').startsWith('Histórico: '));
  assert.ok(d.text('obs-agy-period').includes('Janela recente: '));
  assert.ok(d.text('obs-agy-period').includes('Gateway ativo desde '));
  assert.equal(d.violations.length, 0);
});

test('running without live metrics shows Em execução with a warning and no recent activity', async () => {
  const d = await loadDashboard([statusBody([agyGateway('running', 'unavailable', null)])]);
  assert.equal(d.text('obs-agy-state'), 'Em execução');
  assert.deepEqual(d.tones('obs-agy'), ['s-warn']);
  assert.equal(d.text('obs-agy-why'), 'Respondeu, mas não entregou métricas.');
  assert.equal(d.text('obs-agy-mode'), '—');
  assert.equal(d.text('obs-agy-pid'), '—');
  assert.equal(d.text('obs-agy-errors'), '—');
  assert.equal(d.text('obs-agy-errors-sub'), 'sem dados ao vivo');
  assert.equal(d.el('obs-agy-recent').children.length, 0);
  assert.equal(d.el('obs-agy-recent-empty').hidden, false);
  assert.equal(d.text('obs-agy-recent-empty'), AGY_NO_LIVE_RECENT);
  // History still feeds the KPIs and the model rows.
  assert.equal(d.text('obs-agy-requests'), '42');
  assert.equal(d.el('obs-agy-models-body').children.length, 2);
});

test('stopped gateway shows Parado and keeps the history KPIs', async () => {
  const d = await loadDashboard([statusBody([agyGateway('stopped', 'offline', null)])]);
  assert.equal(d.text('obs-agy-state'), 'Parado');
  assert.deepEqual(d.tones('obs-agy'), ['s-idle']);
  assert.equal(d.text('obs-agy-why'), 'Parado; o histórico do launcher continua visível.');
  assert.equal(d.text('obs-agy-requests'), '42');
  assert.equal(d.text('obs-agy-requests-sub'), 'sem dados ao vivo');
  assert.equal(d.text('obs-agy-input'), compact(180000));
  assert.equal(d.text('obs-agy-input-sub'), '67% do cache');
  assert.equal(d.text('obs-agy-upstream'), '—');
  assert.equal(d.text('obs-agy-recent-empty'), AGY_NO_LIVE_RECENT);
  assert.equal(d.el('obs-agy-models-body').children.length, 2);
});

test('state unavailable shows Indisponível with the offline tone', async () => {
  const d = await loadDashboard([statusBody([agyGateway('unavailable', 'unavailable', null)])]);
  assert.equal(d.text('obs-agy-state'), 'Indisponível');
  assert.deepEqual(d.tones('obs-agy'), ['s-offline']);
  assert.equal(d.text('obs-agy-why'), 'Métricas indisponíveis neste momento.');
});

test('metrics auth-required shows Exige chave with the warning tone', async () => {
  const d = await loadDashboard([statusBody([agyGateway('running', 'auth-required', null)])]);
  assert.equal(d.text('obs-agy-state'), 'Exige chave');
  assert.deepEqual(d.tones('obs-agy'), ['s-key'], 'key-required is the only amber state');
  assert.equal(d.text('obs-agy-why'), 'O gateway exige chave; este painel não envia credenciais.');
});

test('a response without an agy entry shows Indisponível and the other cards still render', async () => {
  const d = await loadDashboard([statusBody([classicGateway('claude', 'running'), classicGateway('codex', 'stopped')])]);
  assert.equal(d.text('obs-agy-state'), 'Indisponível');
  assert.deepEqual(d.tones('obs-agy'), ['s-offline']);
  assert.equal(d.text('obs-agy-requests'), '—');
  assert.equal(d.text('obs-agy-mode'), '—');
  assert.equal(d.el('obs-agy-recent-empty').hidden, false);

  assert.equal(d.text('obs-claude-state'), 'Em execução');
  assert.deepEqual(d.tones('obs-claude'), ['s-ok']);
  assert.equal(d.text('obs-codex-state'), 'Parado');
  assert.deepEqual(d.tones('obs-codex'), ['s-idle']);
  assert.equal(d.text('obs-combined-state'), '1 de 3 em execução');
  assert.equal(d.violations.length, 0);
});

for (const [label, failure] of [['a network failure', FAIL], ['an {ok:false} body', { ok: false, error: 'memory offline' }]] as const) {
  test(`a poll failure after a good load keeps the last agy values and shows the stale marker (${label})`, async () => {
    const d = await loadDashboard([statusBody([agyOk()])]);
    assert.equal(d.el('obs-stale').hidden, true);
    assert.equal(d.text('obs-agy-requests'), '42');

    await d.tick(failure);
    assert.equal(d.text('obs-agy-state'), 'Indisponível');
    assert.deepEqual(d.tones('obs-agy'), ['s-offline']);
    assert.equal(d.el('obs-stale').hidden, false);
    // Last values stay on screen.
    assert.equal(d.text('obs-agy-mode'), 'Passthrough · roteamento travado');
    assert.equal(d.text('obs-agy-requests'), '42');
    assert.equal(d.text('obs-agy-input'), compact(180000));
    assert.equal(d.el('obs-agy-recent').children.length, RECENT.length);

    await d.tick(statusBody([agyOk()]));
    assert.equal(d.el('obs-stale').hidden, true);
    assert.equal(d.text('obs-agy-state'), 'Em execução');
    assert.equal(d.violations.length, 0);
  });
}

test('errors above zero mark the errors tile and zero removes the mark', async () => {
  const errored = agyLive({ errors: 2, statuses: { ok: 40, clientError: 1, serverError: 1, other: 0 } });
  const d = await loadDashboard([statusBody([agyGateway('running', 'ok', errored)])]);
  const tile = d.el('obs-agy-kpi-errors');
  assert.equal(d.text('obs-agy-errors'), '2');
  assert.equal(d.text('obs-agy-errors-sub'), 'de 42 · 4xx 1 · 5xx 1');
  assert.equal(tile.classList.contains('agy-kpi-warn'), true);
  assert.equal(tile.classList.contains('agy-kpi'), true);

  await d.tick(statusBody([agyGateway('running', 'ok', agyLive())]));
  assert.equal(d.text('obs-agy-errors'), '0');
  assert.equal(tile.classList.contains('agy-kpi-warn'), false);
  assert.equal(tile.classList.contains('agy-kpi'), true);
});

test('the combined card counts agy: 3 of 3 when all three run, and 2 of 3 when agy stops', async () => {
  const d = await loadDashboard([statusBody([classicGateway('claude', 'running'), classicGateway('codex', 'running'), agyOk()])]);
  assert.equal(d.text('obs-combined-state'), '3 de 3 em execução');
  assert.deepEqual(d.tones('obs-combined'), ['s-ok']);
  assert.equal(d.text('obs-combined-experiment'), 'Claude Code: padrão · OpenAI Codex: padrão · Google Antigravity: passthrough');
  assert.equal(d.text('obs-combined-why'), '');

  await d.tick(statusBody([classicGateway('claude', 'running'), classicGateway('codex', 'running'), agyGateway('stopped', 'offline', null)]));
  assert.equal(d.text('obs-combined-state'), '2 de 3 em execução');
  assert.equal(d.violations.length, 0);
});

test('hostile model names reach the page only as text', async () => {
  const gateway = agyOk();
  gateway.models.history[0]!.model = HOSTILE;
  const recent = RECENT.map((entry, index) => (index === 0 ? { ...entry, model: HOSTILE } : entry));
  const d = await loadDashboard([statusBody([{ ...gateway, agyLive: agyLive({}, recent) }])]);

  const modelName = byClass(d.el('obs-agy-models-body').children[0]!, 'agy-name')[0];
  assert.equal(modelName?.textContent, HOSTILE);
  assert.equal(modelName?.children.length, 0);
  const title = byClass(d.el('obs-agy-recent').children[0]!, 'title')[0];
  assert.equal(title?.textContent, HOSTILE);
  assert.equal(title?.children.length, 0);

  // No markup was parsed: no img was created, and no innerHTML write happened.
  assert.equal(d.createdTags.includes('img'), false);
  for (const root of [d.el('obs-agy-models-body'), d.el('obs-agy-recent')]) {
    assert.equal(descendants(root).some(n => n.tagName === 'img'), false);
  }
  assert.deepEqual(d.violations, []);
});

test('recent activity shows the newest eight rows, and the button reveals all fifteen and folds them back', async () => {
  const many: AgyRecent[] = Array.from({ length: 15 }, (_, index) => ({ ...RECENT[0]!, model: `model-${index}`, time: LAST_AT }));
  const d = await loadDashboard([statusBody([{ ...agyOk(), agyLive: agyLive({}, many) }])]);

  const visible = () => d.el('obs-agy-recent').children.filter(item => !item.hidden).length;
  const more = d.el('obs-agy-recent-more');
  assert.equal(d.el('obs-agy-recent').children.length, 15);
  assert.equal(visible(), 8);
  assert.equal(more.hidden, false);
  assert.equal(more.textContent, 'Mostrar todas (15)');
  assert.equal(more.getAttribute('aria-expanded'), 'false');

  more.click();
  assert.equal(visible(), 15);
  assert.equal(more.textContent, 'Mostrar menos');
  assert.equal(more.getAttribute('aria-expanded'), 'true');

  more.click();
  assert.equal(visible(), 8);
  assert.equal(more.textContent, 'Mostrar todas (15)');
  assert.deepEqual(d.violations, []);
});

// ---- Views, sidebar, drawer, provider cards and the Tokens view ------------------------------------------------------

const VIEW_KEYS = ['overview', 'combined', 'claude', 'codex', 'agy', 'gateway'] as const;
const SIDE_IDS: Record<(typeof VIEW_KEYS)[number], string> = {
  overview: 'side-overview', combined: 'side-combined', claude: 'gs-claude', codex: 'gs-codex', agy: 'gs-agy', gateway: 'side-gateway',
};
const VIEW_STORAGE_KEY = 'jms.dashboard.view';
const THEME_STORAGE_KEY = 'jms.dashboard.theme';

// A Map-backed localStorage stand-in; `broken` makes every access throw, as private or blocked windows do.
function storageStub(initial: Record<string, string> = {}, broken = false) {
  const items = new Map(Object.entries(initial));
  const fail = (): never => { throw new Error('storage blocked'); };
  return {
    items,
    getItem: (key: string): string | null => (broken ? fail() : items.get(key) ?? null),
    setItem: (key: string, value: string): void => { if (broken) fail(); items.set(key, value); },
  };
}
// The top tab that is selected (aria-selected) and the views that are visible (no hidden attribute).
function selectedView(d: Dashboard): string[] {
  return VIEW_KEYS.filter(key => d.el(`gw-tab-${key}`).getAttribute('aria-selected') === 'true');
}
function visiblePanels(d: Dashboard): string[] {
  return VIEW_KEYS.filter(key => !d.el(`gw-panel-${key}`).hidden);
}
// The sidebar entry that is current (aria-current="page"); it must always name the same view as the top tab.
function currentSide(d: Dashboard): string[] {
  return VIEW_KEYS.filter(key => d.el(SIDE_IDS[key]).getAttribute('aria-current') === 'page');
}
function pressKey(d: Dashboard, key: string): boolean {
  let prevented = false;
  d.el('gw-tablist').dispatch('keydown', { key, preventDefault: () => { prevented = true; } });
  return prevented;
}

test('views open on the overview: one selected tab, the matching sidebar entry is current, only the overview is visible', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  assert.deepEqual(selectedView(d), ['overview']);
  assert.deepEqual(currentSide(d), ['overview']);
  assert.deepEqual(visiblePanels(d), ['overview']);
  assert.equal(d.el('gw-tab-overview').tabIndex, 0);
  assert.equal(d.el('gw-tab-combined').tabIndex, -1);
  assert.equal(d.text('crumb-view'), 'Visão geral');
  assert.deepEqual(d.violations, []);
});

test('ArrowRight and ArrowLeft move through the six views in order and wrap; Home and End jump', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  assert.equal(pressKey(d, 'ArrowRight'), true);
  assert.deepEqual(selectedView(d), ['combined']);
  assert.deepEqual(visiblePanels(d), ['combined']);
  for (const expected of ['claude', 'codex', 'agy', 'gateway', 'overview']) {
    pressKey(d, 'ArrowRight');
    assert.deepEqual(selectedView(d), [expected]);
  }
  pressKey(d, 'ArrowLeft');
  assert.deepEqual(selectedView(d), ['gateway'], 'wraps to the last view');
  pressKey(d, 'Home');
  assert.deepEqual(selectedView(d), ['overview']);
  pressKey(d, 'End');
  assert.deepEqual(selectedView(d), ['gateway']);
  assert.equal(d.el('gw-tab-gateway').focused, true, 'the moved-to tab takes focus');
  assert.equal(d.el('gw-tab-gateway').tabIndex, 0);
  assert.equal(d.el('gw-tab-overview').tabIndex, -1);
  assert.equal(pressKey(d, 'a'), false, 'other keys are left alone');
  assert.deepEqual(d.violations, []);
});

test('clicking a top tab selects its view and hides the others, and the sidebar follows', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  d.el('gw-tab-codex').click();
  assert.deepEqual(selectedView(d), ['codex']);
  assert.deepEqual(visiblePanels(d), ['codex']);
  assert.deepEqual(currentSide(d), ['codex']);
  assert.equal(d.el('gw-panel-codex').scrolled, 1, 'the chosen view is revealed below the top bar');
});

test('sidebar entries and top tabs are one navigation: a sidebar click selects the tab and the view', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  d.el('side-combined').click();
  assert.deepEqual(selectedView(d), ['combined']);
  assert.deepEqual(currentSide(d), ['combined']);
  assert.deepEqual(visiblePanels(d), ['combined']);
  d.el('side-gateway').click();
  assert.deepEqual(selectedView(d), ['gateway']);
  assert.deepEqual(currentSide(d), ['gateway']);
});

test('the sidebar client entries select their provider view and carry the short state pill', async () => {
  const d = await loadDashboard([statusBody([classicGateway('claude', 'running'), classicGateway('codex', 'stopped'), agyGateway('running', 'unavailable', null)])]);
  assert.equal(d.text('gs-pill-claude'), 'online');
  assert.equal(d.text('gs-pill-codex'), 'parado');
  assert.equal(d.text('gs-pill-agy'), 'online');
  d.el('gs-agy').click();
  assert.deepEqual(selectedView(d), ['agy']);
  assert.deepEqual(visiblePanels(d), ['agy']);
  assert.equal(d.el('gw-panel-agy').scrolled, 1);
  d.el('gs-codex').click();
  assert.deepEqual(selectedView(d), ['codex']);
});

test('a provider card opens its provider view, and the Tokens callout opens the Jev Gateway view', async () => {
  const d = await loadDashboard([statusBody([classicGateway('claude', 'running'), classicGateway('codex', 'running'), agyOk()])]);
  d.el('gw-prov-claude-row').click();
  assert.deepEqual(selectedView(d), ['claude']);
  assert.deepEqual(visiblePanels(d), ['claude']);
  d.el('gw-prov-agy-row').click();
  assert.deepEqual(selectedView(d), ['agy']);
  d.el('go-gateway').click();
  assert.deepEqual(selectedView(d), ['gateway']);
  assert.deepEqual(visiblePanels(d), ['gateway']);
  assert.deepEqual(d.violations, []);
});

test('the last chosen view is remembered and restored on the next load', async () => {
  const storage = storageStub();
  const first = await loadDashboard([statusBody([agyOk()])], storage);
  first.el('gw-tab-codex').click();
  assert.equal(storage.items.get(VIEW_STORAGE_KEY), 'codex');
  const second = await loadDashboard([statusBody([agyOk()])], storage);
  assert.deepEqual(selectedView(second), ['codex']);
  assert.deepEqual(visiblePanels(second), ['codex']);
});

test('a stored value that is not a known view falls back to the overview', async () => {
  const d = await loadDashboard([statusBody([agyOk()])], storageStub({ [VIEW_STORAGE_KEY]: 'nope' }));
  assert.deepEqual(selectedView(d), ['overview']);
});

test('view switching still works when localStorage throws on every access', async () => {
  const d = await loadDashboard([statusBody([agyOk()])], storageStub({}, true));
  assert.deepEqual(selectedView(d), ['overview']);
  d.el('gw-tab-agy').click();
  assert.deepEqual(selectedView(d), ['agy']);
  assert.deepEqual(visiblePanels(d), ['agy']);
  d.el('gs-claude').click();
  assert.deepEqual(selectedView(d), ['claude']);
  assert.deepEqual(d.violations, []);
});

// ---- Drawer (below 1000px the sidebar is a drawer opened from the top bar) --------------------------------------------

test('the menu button opens the drawer: aria-expanded, scrim, focus in the drawer and the content made inert', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  assert.equal(d.el('menu-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(d.el('sidebar').getAttribute('data-open'), 'false');
  assert.equal(d.el('scrim').hidden, true);
  d.el('menu-toggle').click();
  assert.equal(d.el('menu-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(d.el('sidebar').getAttribute('data-open'), 'true');
  assert.equal(d.el('scrim').hidden, false);
  assert.equal(d.el('drawer-close').focused, true, 'focus moves into the drawer');
  assert.equal(d.el('content').getAttribute('inert'), '', 'the page behind is inert while the drawer is open');
});

test('Escape closes the drawer and returns focus to the menu button', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  d.el('menu-toggle').click();
  d.el('sidebar').dispatch('keydown', { key: 'Escape', preventDefault: () => undefined });
  assert.equal(d.el('sidebar').getAttribute('data-open'), 'false');
  assert.equal(d.el('menu-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(d.el('scrim').hidden, true);
  assert.equal(d.el('menu-toggle').focused, true);
  assert.equal(d.el('content').getAttribute('inert'), null);
});

test('Escape also closes the drawer when the key reaches the document', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  d.el('menu-toggle').click();
  d.pressDocumentKey('a');
  assert.equal(d.el('sidebar').getAttribute('data-open'), 'true', 'other keys keep it open');
  d.pressDocumentKey('Escape');
  assert.equal(d.el('sidebar').getAttribute('data-open'), 'false');
});

test('choosing a view in the drawer shows that view and closes the drawer', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  d.el('menu-toggle').click();
  d.el('gs-agy').click();
  assert.deepEqual(selectedView(d), ['agy']);
  assert.deepEqual(visiblePanels(d), ['agy']);
  assert.equal(d.el('sidebar').getAttribute('data-open'), 'false');
  assert.equal(d.el('menu-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(d.el('menu-toggle').focused, true);
});

test('the scrim and the close button close the drawer', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  d.el('menu-toggle').click();
  d.el('scrim').click();
  assert.equal(d.el('sidebar').getAttribute('data-open'), 'false');
  assert.equal(d.el('scrim').hidden, true);
  d.el('menu-toggle').click();
  d.el('drawer-close').click();
  assert.equal(d.el('sidebar').getAttribute('data-open'), 'false');
  assert.equal(d.el('content').getAttribute('inert'), null);
  assert.deepEqual(d.violations, []);
});

test('the menu button toggles the drawer closed when it is open', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  d.el('menu-toggle').click();
  d.el('menu-toggle').click();
  assert.equal(d.el('sidebar').getAttribute('data-open'), 'false');
  assert.equal(d.el('menu-toggle').getAttribute('aria-expanded'), 'false');
});

// ---- Theme ----------------------------------------------------------------------------------------------------------

test('the theme buttons set data-theme on the html element, mark the chosen one and save it', async () => {
  const storage = storageStub();
  const d = await loadDashboard([statusBody([agyOk()])], storage);
  d.el('theme-dark-top').click();
  assert.equal(d.root.getAttribute('data-theme'), 'dark');
  assert.equal(d.el('theme-dark-top').getAttribute('aria-pressed'), 'true');
  assert.equal(d.el('theme-dark-side').getAttribute('aria-pressed'), 'true');
  assert.equal(d.el('theme-light-side').getAttribute('aria-pressed'), 'false');
  assert.equal(storage.items.get(THEME_STORAGE_KEY), 'dark');
  d.el('theme-light-side').click();
  assert.equal(d.root.getAttribute('data-theme'), 'light');
  assert.equal(d.el('theme-light-top').getAttribute('aria-pressed'), 'true');
  assert.equal(storage.items.get(THEME_STORAGE_KEY), 'light');
});

test('a saved theme is applied on load', async () => {
  const d = await loadDashboard([statusBody([agyOk()])], storageStub({ [THEME_STORAGE_KEY]: 'light' }));
  assert.equal(d.root.getAttribute('data-theme'), 'light');
  assert.equal(d.el('theme-light-side').getAttribute('aria-pressed'), 'true');
});

test('the theme toggle still switches the page when localStorage throws on every access', async () => {
  const d = await loadDashboard([statusBody([agyOk()])], storageStub({}, true));
  d.el('theme-dark-side').click();
  assert.equal(d.root.getAttribute('data-theme'), 'dark');
  d.el('theme-light-top').click();
  assert.equal(d.root.getAttribute('data-theme'), 'light');
  assert.deepEqual(d.violations, []);
});

// ---- Tokens view: totals, traffic split and status pills -------------------------------------------------------------

function combinedWithModels(models: Array<[string, number, number]>): unknown {
  const body = statusBody([agyOk()]) as { combined: { models: { history: unknown[] } } };
  body.combined.models.history = models.map(([model, events, cacheRead]) => ({
    model, metrics: { ...routeMetrics(events), llm: { ...routeMetrics(events).llm, cacheRead } }, cost: costOf(null, null),
  }));
  return body;
}

test('the totals show counts with the pt-BR thousands separator and a dash when missing', async () => {
  const summary = {
    ok: true, counts: { sessions: 60, observations: 13463, pages: 39 }, pendingHandoffs: 1234, pendingMessages: 0,
    lastObservationAt: null, recent: [], scope: null, activity7d: null,
  };
  const d = await loadDashboard([statusBody([agyOk()])], undefined, summary);
  await flush();
  assert.equal(d.text('m-sessions'), '60');
  assert.equal(d.text('m-observations'), pt(13463));
  assert.equal(d.text('m-observations'), '13.463');
  assert.equal(d.text('m-pages'), '39');
  assert.equal(d.text('m-handoffs'), '1.234');
  assert.equal(d.text('m-messages'), '0');
  assert.deepEqual(d.violations, []);
});

test('the Tokens view shows the traffic split as top three models and one rest segment, with percentages from real counts', async () => {
  const d = await loadDashboard([combinedWithModels([['gpt-a', 50, 0], ['gpt-b', 30, 0], ['gpt-c', 15, 0], ['gpt-d', 3, 0], ['gpt-e', 2, 0]])]);
  const rows = d.el('traffic-legend').children.map(item => `${byClass(item, 'legend-name')[0]?.textContent} ${byClass(item, 'legend-pct')[0]?.textContent}`);
  assert.deepEqual(rows, ['gpt-a 50%', 'gpt-b 30%', 'gpt-c 15%', 'outros 2 5%']);
  const bar = d.el('traffic-bar').children.map(segment => segment.style.width);
  assert.deepEqual(bar, ['50%', '30%', '15%', '5%']);
});

test('traffic percentages sum to 100 even when the shares do not divide evenly', async () => {
  const d = await loadDashboard([combinedWithModels([['m1', 7, 0], ['m2', 7, 0], ['m3', 7, 0]])]);
  const pcts = d.el('traffic-legend').children.map(item => Number(/\d+/.exec(byClass(item, 'legend-pct')[0]?.textContent ?? '')?.[0]));
  assert.equal(pcts.reduce((sum, value) => sum + value, 0), 100);
  assert.deepEqual(pcts, [34, 33, 33]);
});

test('the Total consolidado footer equals the sum of the model rows shown', async () => {
  const d = await loadDashboard([combinedWithModels([['gpt-a', 50, 1000], ['gpt-b', 30, 2000], ['gpt-c', 15, 4000]])]);
  const rows = d.el('obs-combined-models-body').children;
  assert.equal(rows.length, 3);
  const shownRequests = rows.reduce((sum, row) => sum + Number(row.children[1]?.textContent.replace(/\./g, '') ?? '0'), 0);
  assert.equal(shownRequests, 95);
  assert.equal(d.text('obs-combined-models-total-requests'), count(95));
  assert.equal(d.text('obs-combined-models-total-cache'), compact(7000));
  assert.equal(d.text('obs-combined-models-count'), '3');
  assert.deepEqual(d.violations, []);
});

test('the Todos latency KPI is hidden when the combined history has no p50, and shown when it has one', async () => {
  const noP50 = statusBody([agyOk()]) as { combined: { history: RouteMetrics } };
  noP50.combined.history = { ...noP50.combined.history, durationMsP50: null } as unknown as RouteMetrics;
  const hidden = await loadDashboard([noP50]);
  assert.equal(hidden.el('obs-combined-kpi-latency').hidden, true);
  assert.equal(hidden.el('obs-agy-latency').textContent, seconds(1500), 'the provider view keeps its own p50');
  const shown = await loadDashboard([statusBody([agyOk()])]);
  assert.equal(shown.el('obs-combined-kpi-latency').hidden, false);
});

test('the provider cards fill each gateway with its state, requests, input, cache read and cache share, as text', async () => {
  const d = await loadDashboard([statusBody([classicGateway('claude', 'running'), classicGateway('codex', 'stopped'), agyOk()])]);
  assert.equal(d.text('gw-prov-claude-state'), 'Em execução');
  assert.equal(d.text('gw-prov-codex-state'), 'Parado');
  assert.equal(d.text('gw-prov-agy-state'), 'Em execução');
  assert.equal(d.text('gw-prov-agy-requests'), count(42));
  assert.equal(d.text('gw-prov-agy-cache'), '67%');
  assert.equal(d.text('gw-prov-agy-cacheread'), compact(120000));
  assert.equal(d.text('gw-prov-agy-p50'), seconds(1500));
  assert.deepEqual(d.violations, []);
});

test('the status pills of the cards and the sidebar take the tone of each gateway and name its state', async () => {
  const d = await loadDashboard([statusBody([classicGateway('claude', 'running'), classicGateway('codex', 'stopped'), agyGateway('running', 'unavailable', null)])]);
  assert.equal(d.el('gs-dot-claude').getAttribute('data-tone'), 's-ok');
  assert.equal(d.el('gs-dot-codex').getAttribute('data-tone'), 's-idle');
  assert.equal(d.el('gs-dot-agy').getAttribute('data-tone'), 's-warn');
  assert.equal(d.el('gw-prov-codex-dot').getAttribute('data-tone'), 's-idle');
  assert.equal(d.text('gs-state-claude'), 'Em execução');
  assert.equal(d.text('gs-state-codex'), 'Parado');
  assert.equal(d.text('gs-state-agy'), 'Em execução');
  assert.equal(d.el('gs-claude').title, 'Claude Code: Em execução');
});

test('the AI Memory state uses the same tone attribute and the sidebar footer repeats it with the memory port', async () => {
  // The last observation is 3 minutes before the frozen clock, inside the 10-minute capture window: the state is capturing.
  const summary = {
    ok: true, counts: { sessions: 1, observations: 2, pages: 3 }, pendingHandoffs: 0, pendingMessages: 0,
    lastObservationAt: LAST_AT, recent: [], scope: null, activity7d: null, memoryPort: 49375,
  };
  const d = await loadDashboard([statusBody([agyOk()])], undefined, summary);
  await flush();
  assert.equal(d.el('state-card').getAttribute('data-tone'), 's-capturing');
  assert.equal(d.text('state-text'), 'Capturando');
  assert.equal(d.text('side-memory'), 'AI Memory · Capturando · porta :49375');
  assert.equal(d.text('side-overview-pill'), 'Capturando');
  assert.deepEqual(d.violations, []);
});

test('the sidebar footer shows the combined cache share with a bar of the same width', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  // Combined history: 120 000 cache-read tokens of 180 000 input tokens.
  assert.equal(d.text('side-cache'), '67%');
  assert.equal(d.el('side-cache-bar').style.width, '67%');
});

test('the breadcrumb shows the combined period with its length', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  assert.ok(d.text('crumb-period').startsWith('Período: '), d.text('crumb-period'));
  assert.ok(/\(\d+d \d+h\)$/.test(d.text('crumb-period')), d.text('crumb-period'));
});

test('the sidebar and the top bar show the current view title below the desktop width', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  assert.equal(d.text('topbar-view'), 'Visão geral');
  d.el('gw-tab-claude').click();
  assert.equal(d.text('topbar-view'), 'Claude Code');
  assert.equal(d.text('crumb-view'), 'Claude Code');
});

test('the Antigravity panel renders from its live data with the same numbers as before', async () => {
  const d = await loadDashboard([statusBody([agyOk()])]);
  d.el('gw-tab-agy').click();
  assert.equal(d.text('obs-agy-requests'), '42');
  assert.equal(d.text('obs-agy-input'), compact(180000));
  assert.equal(d.text('obs-agy-last'), 'há 3 min');
});
