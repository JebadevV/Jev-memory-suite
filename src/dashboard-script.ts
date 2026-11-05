// Panel script for the suite dashboard. Untrusted titles, paths and project labels are written with textContent only.
// Purpose: maintainers. Date: 2026-10-22.
import { dashboardGatewayJs } from './dashboard-gateway-script.js';
export const dashboardJs = `(function () {
  'use strict';
  var POLL_MS = 5000;
  var PROJECTS_POLL_MS = 15000;
  var PROJECT_KEY = 'jms.dashboard.project';
  var ACTIVE_WINDOW_MS = 10 * 60 * 1000;
  var RECENT_SLOTS = 5;
  var FEED_POLL_MS = 3000;
  var TOAST_TTL_MS = 6000;
  var TOAST_MAX = 4;
  var SEEN_MAX = 2000;
  var EXCERPT_MAX = 160;
  var KIND_LABELS = { session: 'sessão', decision: 'decisão', gotcha: 'armadilha', procedure: 'procedimento', rule: 'regra' };
  var AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'OpenAI Codex', 'antigravity-cli': 'Google Antigravity' };
  var FEED_LABELS = { 'post-tool-use': 'Ferramenta concluída', 'user-prompt': 'Prompt enviado', 'session-start': 'Sessão iniciada', 'session-end': 'Sessão encerrada', 'stop': 'Turno encerrado' };
  var SILENT_KINDS = { 'pre-tool-use': true };
  var UNITS = [['day', 86400], ['hour', 3600], ['minute', 60]];
  var rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto', style: 'short' });
  // preferred is the saved choice; selected is what the panel shows after the list has loaded.
  var state = { data: null, fetchedAt: 0, projects: [], preferred: null, selected: null, tabKey: '' };

  function $(id) { return document.getElementById(id); }
  function setText(id, value) { $(id).textContent = value; }
  function dash(value) { return value === null || value === undefined || value === '' ? '—' : String(value); }
  function parseTime(iso) {
    if (typeof iso !== 'string') return null;
    var time = Date.parse(iso.replace(/(\\.\\d{3})\\d+/, '$1'));
    return isNaN(time) ? null : time;
  }
  function ago(iso, now) {
    var time = parseTime(iso);
    if (time === null) return null;
    var diff = (time - now) / 1000;
    for (var i = 0; i < UNITS.length; i++) {
      if (Math.abs(diff) >= UNITS[i][1]) return rtf.format(Math.trunc(diff / UNITS[i][1]), UNITS[i][0]);
    }
    return rtf.format(Math.trunc(diff), 'second');
  }
  function clock(ms) {
    return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function localDate(iso) {
    var time = parseTime(iso);
    return time === null ? 'sem registros' : new Date(time).toLocaleString('pt-BR');
  }

  // Storage can be blocked (private windows, policy); the panel then simply falls back to the first project.
  function readSaved() {
    try { return window.localStorage.getItem(PROJECT_KEY); } catch (e) { return null; }
  }
  function saveChoice(id) {
    try { window.localStorage.setItem(PROJECT_KEY, id); } catch (e) { /* Storage is optional; the choice still applies for this page. */ }
  }
  function pickSelection(list) {
    for (var i = 0; i < list.length; i++) { if (list[i].id === state.preferred) return list[i].id; }
    return list.length ? list[0].id : null;
  }

  // The live dot is solid while the panel is current and red only when the page cannot reach the service.
  function renderLive(ok, now) {
    var live = $('live');
    live.setAttribute('data-tone', ok ? 's-ok' : 's-offline');
    if (ok) { live.textContent = 'ao vivo · atualizado ' + clock(now); return; }
    live.textContent = state.fetchedAt ? 'sem conexão · último dado ' + clock(state.fetchedAt) : 'sem conexão';
  }
  // The state is shown by its glyph and its text; the tone only sets the glyph's colour (see the stylesheet).
  function renderState(ok, view, now) {
    var card = $('state-card');
    var lastTime = view ? parseTime(view.lastObservationAt) : null;
    var kind = 'idle', text = 'Ociosa', icon = '○', why = 'Nenhuma observação ainda.';
    if (!ok) {
      kind = 'offline'; text = 'Offline'; icon = '!'; why = 'O serviço de memória não respondeu.';
    } else if (lastTime !== null) {
      why = ('Última observação ' + ago(view.lastObservationAt, now) + '.').replace(/\\.\\.$/, '.');
      if (now - lastTime < ACTIVE_WINDOW_MS) { kind = 'capturing'; text = 'Capturando'; icon = '●'; }
    }
    card.setAttribute('data-tone', 's-' + kind);
    setText('state-text', text);
    setText('state-icon', icon);
    setText('state-why', why);
    setText('side-overview-pill', text);
  }
  // The sidebar footer repeats the memory state and the memory port, so the drawer on a phone still shows them.
  function renderSideMemory(view) {
    var port = view && view.memoryPort ? ' · porta :' + view.memoryPort : '';
    setText('side-memory', 'AI Memory · ' + $('state-text').textContent + port);
  }
  function renderScope(view) {
    var scope = view && view.scope;
    var label = scope ? scope.workspace + '/' + scope.project : '—';
    setText('scope', view && view.memoryPort ? label + ' · :' + view.memoryPort : label);
  }
  // Totals use the pt-BR thousands separator (13.463); subs and times keep their plain text.
  var COUNT_FORMAT = new Intl.NumberFormat('pt-BR');
  function countText(value) { return typeof value === 'number' && isFinite(value) ? COUNT_FORMAT.format(value) : '—'; }
  function renderPending(view) {
    var pairs = [['m-handoffs', 't-handoffs', view && view.pendingHandoffs], ['m-messages', 't-messages', view && view.pendingMessages]];
    pairs.forEach(function (pair) {
      var count = typeof pair[2] === 'number' ? pair[2] : null;
      setText(pair[0], countText(count));
      $(pair[1]).classList.toggle('pending', count !== null && count > 0);
    });
  }
  function renderTiles(view, now) {
    var counts = view ? view.counts : null, activity = view ? view.activity7d : null;
    setText('m-sessions', countText(counts && counts.sessions));
    setText('m-sessions-sub', activity ? activity.sessions + ' nos últimos 7 dias' : 'sessões de agente registradas');
    setText('m-observations', countText(counts && counts.observations));
    setText('m-observations-sub', 'eventos capturados pelos hooks' + (activity ? ' · ' + activity.observations + ' em 7 dias' : ''));
    setText('m-pages', countText(counts && counts.pages));
    setText('m-pages-sub', 'conhecimento compilado' + (activity ? ' · ' + activity.pagesUpdated + ' atualizadas em 7 dias' : ''));
    var last = view ? view.lastObservationAt : null;
    setText('m-last', parseTime(last) === null ? '—' : ago(last, now));
    setText('m-last-sub', view ? localDate(last) : 'sem registros');
    // The explanatory sub lines move to each total's title attribute, so the totals row stays plain.
    tip('t-sessions', 'm-sessions-sub');
    tip('t-observations', 'm-observations-sub');
    tip('t-pages', 'm-pages-sub');
    tip('t-last', 'm-last-sub');
  }
  function tip(tileId, subId) { $(tileId).title = $(subId).textContent; }

  var recentList = $('recent');
  var slots = [];
  // One line per row: title (ellipsis), kind badge, relative time. The path goes into the row's title attribute.
  for (var i = 0; i < RECENT_SLOTS; i++) {
    var li = document.createElement('li');
    var row = document.createElement('div'); row.className = 'row';
    var title = document.createElement('span'); title.className = 'title';
    var badge = document.createElement('span'); badge.className = 'badge';
    var when = document.createElement('time'); when.className = 'when';
    row.appendChild(title); row.appendChild(badge); row.appendChild(when);
    li.appendChild(row); li.hidden = true;
    recentList.appendChild(li);
    slots.push({ li: li, title: title, when: when, badge: badge });
  }
  function renderRecent(view, now) {
    var items = view && view.recent ? view.recent : [];
    slots.forEach(function (slot, index) {
      var item = items[index];
      slot.li.hidden = !item;
      if (!item) return;
      slot.title.textContent = dash(item.title);
      slot.title.title = dash(item.title);
      slot.li.title = dash(item.path);
      var relative = ago(item.updatedAt, now);
      slot.when.textContent = relative || '—';
      if (item.updatedAt) slot.when.dateTime = item.updatedAt;
      slot.badge.hidden = !item.kind;
      slot.badge.textContent = KIND_LABELS[item.kind] || dash(item.kind);
    });
    var empty = $('recent-empty');
    empty.hidden = items.length > 0;
    empty.textContent = view ? 'Nenhuma página ainda — cada sessão aparece aqui quando termina.' : 'Carregando…';
  }
  function render(data) {
    var now = Date.now();
    var ok = !!(data && data.ok === true);
    if (ok) { state.data = data; state.fetchedAt = now; }
    var view = state.data;
    renderLive(ok, now);
    renderState(ok, view, now);
    renderScope(view);
    renderSideMemory(view);
    renderPending(view);
    renderTiles(view, now);
    renderRecent(view, now);
  }

  // Each response is checked against the selection at request time, so a slow reply for a previous project cannot overwrite the current one.
  function refresh() {
    var project = state.selected;
    var url = '/memory/summary' + (project ? '?project=' + encodeURIComponent(project) : '');
    fetch(url, { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) { if (project === state.selected) render(data); },
        function () { if (project === state.selected) render({ ok: false }); });
  }
  refresh();
  setInterval(refresh, POLL_MS);

  // Project selector: a segmented tablist. Tabs are rebuilt only when the list changes, so keyboard focus survives the poll.
  var tabBar = $('projects');
  function rebuildTabs(list) {
    while (tabBar.firstChild) tabBar.removeChild(tabBar.firstChild);
    list.forEach(function (project) {
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'project-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('data-id', project.id);
      var dot = document.createElement('span');
      dot.className = 'dot ' + (project.online ? 'on' : 'off');
      dot.setAttribute('aria-hidden', 'true');
      var name = document.createElement('span'); name.className = 'project-name';
      name.textContent = dash(project.label);
      var status = document.createElement('span'); status.className = 'project-state';
      status.textContent = project.online ? 'online' : 'offline';
      tab.appendChild(dot); tab.appendChild(name); tab.appendChild(status);
      tab.addEventListener('click', function () { selectProject(project.id); });
      tabBar.appendChild(tab);
    });
  }
  function renderProjects(list) {
    var key = JSON.stringify(list.map(function (p) { return [p.id, p.label, p.online]; }));
    if (key !== state.tabKey) { state.tabKey = key; rebuildTabs(list); }
    Array.prototype.forEach.call(tabBar.children, function (tab) {
      var on = tab.getAttribute('data-id') === state.selected;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
    });
  }
  function selectProject(id) {
    if (id === state.selected) return;
    state.selected = id;
    state.preferred = id;
    saveChoice(id);
    state.data = null;
    state.fetchedAt = 0;
    renderProjects(state.projects);
    refresh();
  }
  tabBar.addEventListener('keydown', function (event) {
    var step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    var tabs = Array.prototype.slice.call(tabBar.querySelectorAll('[role="tab"]'));
    var index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    var next = tabs[(index + step + tabs.length) % tabs.length];
    event.preventDefault();
    next.focus();
    selectProject(next.getAttribute('data-id'));
  });
  function applyProjects(list) {
    var previous = state.selected;
    state.projects = list;
    state.selected = pickSelection(list);
    renderProjects(list);
    if (state.selected !== previous) { state.data = null; state.fetchedAt = 0; refresh(); }
  }
  function loadProjects() {
    fetch('/memory/projects', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || data.ok !== true || !Array.isArray(data.projects)) return;
        applyProjects(data.projects);
      })
      .catch(function () { /* Silent: the summary panel already reports the offline state. */ });
  }
  state.preferred = readSaved();
  loadProjects();
  setInterval(loadProjects, PROJECTS_POLL_MS);

  // Theme: the saved choice goes to <html data-theme>. Without a choice the system preference decides (CSS), and the buttons show it.
  // Storage can be blocked, so every read and write is guarded; the theme then lasts for the page only.
  var THEME_KEY = 'jms.dashboard.theme';
  function readTheme() {
    try { var saved = window.localStorage.getItem(THEME_KEY); return saved === 'light' || saved === 'dark' ? saved : null; } catch (e) { return null; }
  }
  function saveTheme(value) {
    try { window.localStorage.setItem(THEME_KEY, value); } catch (e) { /* Storage is optional; the theme still applies for this page. */ }
  }
  function systemTheme() {
    try { return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
  }
  function currentTheme() {
    var root = document.documentElement;
    var set = root ? root.getAttribute('data-theme') : null;
    return set === 'light' || set === 'dark' ? set : systemTheme();
  }
  function paintTheme() {
    var value = currentTheme();
    ['side', 'top'].forEach(function (where) {
      ['dark', 'light'].forEach(function (name) {
        $('theme-' + name + '-' + where).setAttribute('aria-pressed', name === value ? 'true' : 'false');
      });
    });
  }
  function applyTheme(value, save) {
    var root = document.documentElement;
    if (root) root.setAttribute('data-theme', value);
    if (save) saveTheme(value);
    paintTheme();
  }
  ['side', 'top'].forEach(function (where) {
    ['dark', 'light'].forEach(function (name) {
      $('theme-' + name + '-' + where).addEventListener('click', function () { applyTheme(name, true); });
    });
  });
  var savedTheme = readTheme();
  if (savedTheme) applyTheme(savedTheme, false); else paintTheme();

  // The sticky top bar height is measured once and on resize, so the sidebar and the scroll margin of a view clear it.
  function measureTopbar() {
    var bar = $('topbar');
    var height = bar && bar.offsetHeight ? bar.offsetHeight : 0;
    if (height > 0 && document.documentElement && document.documentElement.style) {
      document.documentElement.style.setProperty('--topbar-h', height + 'px');
    }
  }
  measureTopbar();
  if (typeof window.addEventListener === 'function') window.addEventListener('resize', measureTopbar);

  // Toasts: a project's first appearance only marks its existing items as seen, so opening the dashboard or bringing a project online never floods the screen.
  var toastRoot = $('toasts');
  var seen = new Set();
  var primed = new Set();
  function feedKey(item) { return item.projectId + '\\n' + item.id; }
  function kindLabel(kind) { return FEED_LABELS[kind] || kind; }
  function excerpt(body) {
    var kept = String(body || '').split(/\\r?\\n/).filter(function (line) {
      var text = line.trim();
      return text !== '---' && !/^(tool_family|tool_call_id|outcome):/.test(text);
    });
    var text = kept.join(' ').replace(/\\s+/g, ' ').trim();
    return text.length > EXCERPT_MAX ? text.slice(0, EXCERPT_MAX) + '…' : text;
  }
  function showToast(item) {
    var toast = document.createElement('button');
    toast.type = 'button';
    toast.className = 'toast';
    var project = document.createElement('span'); project.className = 'toast-project';
    var agentName = Object.prototype.hasOwnProperty.call(AGENT_NAMES, item.agent) ? AGENT_NAMES[item.agent] : item.agentLabel;
    project.textContent = dash(agentName) + ' · ' + dash(item.projectLabel);
    var label = document.createElement('span'); label.className = 'toast-label';
    label.textContent = kindLabel(item.kind);
    var title = document.createElement('span'); title.className = 'toast-title';
    title.textContent = dash(item.title);
    toast.appendChild(project); toast.appendChild(label); toast.appendChild(title);
    var text = excerpt(item.body);
    if (text) {
      var body = document.createElement('span'); body.className = 'toast-body';
      body.textContent = text;
      toast.appendChild(body);
    }
    toastRoot.appendChild(toast);
    while (toastRoot.children.length > TOAST_MAX) toastRoot.removeChild(toastRoot.firstElementChild);
    var timer = setTimeout(function () { toast.remove(); }, TOAST_TTL_MS);
    toast.addEventListener('click', function () { clearTimeout(timer); toast.remove(); });
  }
  function handleFeed(data) {
    if (!data || data.ok !== true || !Array.isArray(data.items)) return;
    var items = data.items;
    var fresh = items.filter(function (item) { return !seen.has(feedKey(item)); }).reverse();
    // Accumulated, not replaced: an item that leaves the feed and comes back must not toast again. Re-adding moves a current key to the newest slot, so only old keys are evicted.
    items.forEach(function (item) { seen.delete(feedKey(item)); seen.add(feedKey(item)); });
    var oldest = seen.values();
    while (seen.size > SEEN_MAX) seen.delete(oldest.next().value);
    // A project's first sighting with items is baseline, not news. An online project without items is primed now, so its first real event toasts.
    var baseline = {};
    items.forEach(function (item) { if (!primed.has(item.projectId)) baseline[item.projectId] = true; });
    state.projects.forEach(function (project) { if (project.online && !baseline[project.id]) primed.add(project.id); });
    Object.keys(baseline).forEach(function (id) { primed.add(id); });
    fresh.forEach(function (item) {
      if (baseline[item.projectId] || SILENT_KINDS[item.kind]) return;
      showToast(item);
    });
  }
  function pollFeed() {
    fetch('/memory/feed', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(handleFeed)
      .catch(function () { /* Silent: the summary panel already reports the offline state. */ });
  }
  pollFeed();
  setInterval(pollFeed, FEED_POLL_MS);

  // The frame or fallback was built for one aggregator; a different one means a reload is needed. The panel never reloads by itself.
  function checkAggregatorNotice(data) {
    var slot = $('gateway-slot');
    var current = data && data.ok === true && data.aggregator ? data.aggregator.client + ':' + data.aggregator.port : 'none';
    $('gateway-notice').hidden = current === slot.getAttribute('data-aggregator');
  }

  ${dashboardGatewayJs}
})();
`;
