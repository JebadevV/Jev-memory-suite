// Jev Gateway part of the dashboard script: a compact token-observability summary (log history) per client and combined.
// The original Jev Gateway dashboard is embedded as one iframe (dashboard-page.ts), so this file renders no window, filters,
// timeline, request table or routing control. Concatenated inside the dashboard IIFE, so it reuses its helpers
// ($, setText, parseTime, localDate, checkAggregatorNotice). Purpose: maintainers. Date: 2026-10-22.
// Every value comes from /gateways/status and is checked before use. Written with textContent only.
// A failed poll keeps the last values and marks them stale.
export const dashboardGatewayJs = `
  var GW_POLL_MS = 5000;
  var GW_CLIENTS = ['claude', 'codex', 'agy'];
  var GW_SCOPES = ['claude', 'codex', 'agy', 'combined'];
  var GW_NAMES = { claude: 'Claude Code', codex: 'OpenAI Codex', agy: 'Google Antigravity' };
  var GW_EXPERIMENTS = { 'default': 'padrão', shadow: 'sombra', metering: 'medição', passthrough: 'passthrough' };
  var AGY_PASSTHROUGH_NOTE = 'Tráfego do Google Antigravity vai direto ao Google; o Jev só observa.';
  var AGY_BILLING_TEXT = { api: 'API por token', subscription: 'Assinatura' };
  var AGY_RECENT_MAX = 15;
  var AGY_RECENT_VISIBLE = 8;
  var agyRecentLive = null;
  var agyRecentExpanded = false;
  var AGY_NO_LIVE_RECENT = 'Gateway parado ou sem resposta: atividade recente indisponível.';
  var AGY_NO_RECENT = 'Nenhuma requisição na janela recente.';
  var GW_OBS_ROW_KEYS = ['requests', 'jevCalls', 'jevInput', 'jevOutput', 'llmInput', 'cacheRead', 'cacheWrite', 'llmOutput', 'blocking', 'avoided', 'cost', 'period'];
  var GW_MODEL_KEYS = ['requests', 'jevCalls', 'jevInput', 'llmInput', 'cacheRead', 'llmOutput'];
  var GW_MODEL_MAX = 12;
  var GW_PRICE_PREFIX = 'llm-price:';
  var GW_UNPRICED_SHOWN = 3;
  var GW_OUTPUT_NOTE = 'não registrado';
  var GW_EXPIRED_PREFIX = 'llm-price-expired:';
  var GW_BILLING_TEXT = {
    api: 'Cobrança real: API por token',
    subscription: 'Cobrança real: assinatura (custo por token não se aplica)',
    unknown: 'Base de cobrança não configurada'
  };
  var GW_ALIAS_NOTE = 'preço equivalente assumido';
  var GW_NO_JEV_PRICE = 'sem preço do Jev';
  var GW_NO_BASELINE = 'Sem baseline no histórico: desligue o roteamento no painel do Jev Gateway por um período para comparar.';
  var GW_COMPARE_ROWS = [
    ['Requisições medidas', 'requests', 'count', false],
    ['Tokens entrada / requisição', 'inputPerRequest', 'count', true],
    ['% cache', 'cachedPct', 'percent', true],
    ['Tokens saída / requisição', 'outputPerRequest', 'count', true],
    ['Segundos / requisição', 'secondsPerRequest', 'seconds', true]
  ];
  var GW_NUMBER = new Intl.NumberFormat('pt-BR');
  var GW_DECIMAL = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
  var GW_SECONDS = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var GW_COMPACT = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
  var GW_USD = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
  // polled: a response (or failure) has arrived. loaded: a valid response has arrived. ok: the latest poll was valid. stale: the latest poll failed after data was shown.
  var gwData = { polled: false, loaded: false, ok: false, stale: false, gateways: { claude: null, codex: null, agy: null }, combined: null, pricing: null };

  function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
  function isCount(value) { return typeof value === 'number' && isFinite(value) && value >= 0; }
  function hasOwn(map, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key); }
  function field(source, path) {
    var value = source;
    for (var i = 0; i < path.length; i++) {
      if (!isRecord(value)) return undefined;
      value = value[path[i]];
    }
    return value;
  }
  function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function el(tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function dataEmptyText(ownText) {
    if (!gwData.polled) return 'Carregando…';
    return gwData.loaded ? ownText : 'Sem dados: o gateway não respondeu.';
  }

  function fmtCount(value) { return isCount(value) ? GW_NUMBER.format(value) : '—'; }
  function fmtTokens(value) { return isCount(value) ? GW_COMPACT.format(value) : '—'; }
  function fmtMs(value) { return isCount(value) ? GW_NUMBER.format(Math.round(value)) + ' ms' : '—'; }
  function missingList(estimate) {
    var missing = field(estimate, ['missing']);
    return Array.isArray(missing) ? missing.filter(function (item) { return typeof item === 'string'; }) : [];
  }
  // Models named as unpriced by "llm-price:<model>" entries, in the order the server sent them.
  function unpricedModels(missing) {
    return missing
      .filter(function (item) { return item.indexOf(GW_PRICE_PREFIX) === 0 && item.length > GW_PRICE_PREFIX.length; })
      .map(function (item) { return item.slice(GW_PRICE_PREFIX.length); });
  }
  function fmtUnpriced(names) {
    var shown = names.slice(0, GW_UNPRICED_SHOWN).join(', ');
    return 'sem preço para: ' + shown + (names.length > GW_UNPRICED_SHOWN ? ' +' + (names.length - GW_UNPRICED_SHOWN) : '');
  }
  // The price of a model's rate is read from the pricing echo for its validity date only; no rate is shown.
  function priceEntry(model) {
    var models = field(gwData.pricing, ['models']);
    return isRecord(models) && hasOwn(models, model) && isRecord(models[model]) ? models[model] : null;
  }
  function fmtExpired(missing) {
    var dates = [];
    missing.forEach(function (item) {
      if (item.indexOf(GW_EXPIRED_PREFIX) !== 0) return;
      var until = field(priceEntry(item.slice(GW_EXPIRED_PREFIX.length)), ['validUntil']);
      if (typeof until === 'string' && until !== '' && dates.indexOf(until) === -1) dates.push(until);
    });
    return dates.length ? 'preço vencido em ' + dates.join(', ') : 'preço vencido';
  }
  // Marks an estimate that used an assumed equivalent price (observability.pricing.aliases).
  function aliasNote(estimate) {
    var aliased = field(estimate, ['aliased']);
    return isRecord(aliased) && Object.keys(aliased).length > 0 ? ' · ' + GW_ALIAS_NOTE : '';
  }
  // The total shows when priced. Without a Jev price the LLM estimate still shows, marked as such. Otherwise expired rates are
  // named by their date, unpriced models by unpricedText, and anything else stays a dash.
  function costText(estimate, unpricedText) {
    if (!isRecord(estimate)) return '—';
    if (isCount(estimate.total)) return GW_USD.format(estimate.total) + aliasNote(estimate);
    if (isCount(estimate.llm)) return GW_USD.format(estimate.llm) + ' (' + GW_NO_JEV_PRICE + ')' + aliasNote(estimate);
    var missing = missingList(estimate);
    if (missing.some(function (item) { return item.indexOf(GW_EXPIRED_PREFIX) === 0; })) return fmtExpired(missing);
    var names = unpricedModels(missing);
    if (names.length > 0) return unpricedText(names);
    return missing.indexOf('llm-price') !== -1 || missing.indexOf('jev-price') !== -1 ? 'preço não configurado' : '—';
  }
  // A model's own cell: its price, or "sem preço" when the estimate names that model as unpriced.
  function modelCostText(entry) {
    return costText(entry.cost, function () { return 'sem preço'; });
  }
  // The billing line of a card: how the client's tokens are paid for. Empty until the gateway's status has arrived.
  function billingText(gateway) {
    if (!isRecord(gateway)) return '';
    var mode = field(gateway, ['billing']);
    return hasOwn(GW_BILLING_TEXT, mode) ? GW_BILLING_TEXT[mode] : GW_BILLING_TEXT.unknown;
  }
  function fmtPeriod(metrics) {
    var first = field(metrics, ['firstAt']);
    if (parseTime(first) === null) return 'sem registros';
    var text = localDate(first) + ' → ' + localDate(field(metrics, ['lastAt']));
    return field(metrics, ['complete']) === false ? text + ' (lendo…)' : text;
  }

  // Each metric reads one history path and formats it. Keys are shared by the card rows and the per-model cells.
  var GW_FIELDS = {
    requests: [['events'], fmtCount],
    jevCalls: [['jev', 'calls'], fmtCount],
    jevInput: [['jev', 'inputTokens'], fmtTokens],
    blocking: [['jev', 'blockingLatencyMs'], fmtMs],
    llmInput: [['llm', 'uncachedInput'], fmtTokens],
    cacheRead: [['llm', 'cacheRead'], fmtTokens],
    cacheWrite: [['llm', 'cacheWrite'], fmtTokens],
    llmOutput: [['llm', 'output'], fmtTokens],
    avoided: [['avoidedLlmCalls'], fmtCount]
  };
  // Card rows: calls show their errors, output shows its reasoning share, Jev output is never logged upstream.
  function obsText(key, metrics, cost) {
    if (key === 'cost') return costText(cost, fmtUnpriced);
    if (key === 'period') return fmtPeriod(metrics);
    if (key === 'jevOutput') return GW_OUTPUT_NOTE;
    if (key === 'jevCalls') return fmtCount(field(metrics, ['jev', 'calls'])) + ' (' + fmtCount(field(metrics, ['jev', 'errors'])) + ')';
    var spec = GW_FIELDS[key];
    return spec ? spec[1](field(metrics, spec[0])) : '—';
  }
  // Sub lines of the primary numbers: the cache share of the input, the reasoning share of the output, and the p90 latency.
  function cacheShareText(metrics) {
    var pct = fmtPercent(pick(metrics, ['llm', 'cacheRead']), pick(metrics, ['llm', 'input']));
    return pct !== null ? pct + ' do cache' : 'sem dados de cache';
  }
  function fillMetrics(scope, metrics, cost) {
    GW_OBS_ROW_KEYS.forEach(function (key) {
      setText('obs-' + scope + '-' + key, obsText(key, metrics, cost));
    });
    setText('obs-' + scope + '-llmInput-sub', cacheShareText(metrics));
    setText('obs-' + scope + '-llmOutput-sub', 'raciocínio ' + fmtTokens(pick(metrics, ['llm', 'reasoning'])));
    setText('obs-' + scope + '-latency', fmtSeconds(pick(metrics, ['durationMsP50'])));
    setText('obs-' + scope + '-latency-sub', 'p90 ' + fmtSeconds(pick(metrics, ['durationMsP90'])));
  }

  function cardView(gateway) {
    if (!gateway) return { tone: 's-offline', label: 'Indisponível', note: 'Não foi possível consultar este gateway agora.' };
    if (gateway.metrics === 'auth-required') return { tone: 's-key', label: 'Exige chave', note: 'O gateway exige chave; este painel não envia credenciais.' };
    if (gateway.state === 'running') {
      return gateway.metrics === 'ok'
        ? { tone: 's-ok', label: 'Em execução', note: '' }
        : { tone: 's-warn', label: 'Em execução', note: 'Respondeu, mas não entregou métricas.' };
    }
    if (gateway.state === 'stopped') return { tone: 's-idle', label: 'Parado', note: 'Parado; o histórico do launcher continua visível.' };
    return { tone: 's-offline', label: 'Indisponível', note: 'Métricas indisponíveis neste momento.' };
  }
  function experimentText(gateway) {
    var experiment = field(gateway, ['experiment']);
    return hasOwn(GW_EXPERIMENTS, experiment) ? GW_EXPERIMENTS[experiment] : '—';
  }

  // Per-model rows come from the history only; each row names its model and shows the same cells as the card.
  function validEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.filter(function (item) { return isRecord(item) && typeof item.model === 'string' && item.model !== '' && isRecord(item.metrics); });
  }
  function modelEntries(entries) { return validEntries(entries).slice(0, GW_MODEL_MAX); }
  function modelRow(entry) {
    var tr = el('tr');
    var name = el('th');
    name.setAttribute('scope', 'row');
    var dot = elc('span', 'mdot', '');
    dot.setAttribute('aria-hidden', 'true');
    name.appendChild(dot);
    var mname = elc('span', 'mname', entry.model);
    mname.title = entry.model;
    name.appendChild(mname);
    tr.appendChild(name);
    GW_MODEL_KEYS.forEach(function (key) {
      var spec = GW_FIELDS[key];
      tr.appendChild(el('td', spec ? spec[1](field(entry.metrics, spec[0])) : '—'));
    });
    // An unpriced model shows a dash; "sem preço" stays in the cell's title and in the cost details.
    var cost = modelCostText(entry);
    var costCell = el('td', cost === 'sem preço' ? '—' : cost);
    if (cost === 'sem preço') costCell.title = 'sem preço';
    tr.appendChild(costCell);
    return tr;
  }
  function renderModels(scope, owner) {
    var rows = modelEntries(field(owner, ['models', 'history']));
    var body = $('obs-' + scope + '-models-body');
    clearChildren(body);
    // The footer adds up the rows shown, so it always equals the figures above it.
    var total = { requests: 0, cache: 0 };
    rows.forEach(function (entry) {
      body.appendChild(modelRow(entry));
      total.requests += pick(entry.metrics, ['events']) || 0;
      total.cache += pick(entry.metrics, ['llm', 'cacheRead']) || 0;
    });
    setText('obs-' + scope + '-models-total-requests', rows.length ? fmtCount(total.requests) : '—');
    setText('obs-' + scope + '-models-total-cache', rows.length ? fmtTokens(total.cache) : '—');
    setText('obs-' + scope + '-models-empty', dataEmptyText('Nenhum modelo no histórico do log ainda.'));
    $('obs-' + scope + '-models-empty').hidden = rows.length > 0;
    setText('obs-' + scope + '-models-count', gwData.polled ? String(rows.length) : '—');
  }

  // Comparison: a row shows the request count, then per-request averages and cache share with and without Jev.
  // Claude and Codex only; the Antigravity panel has no comparison.
  function groupEmpty(group) {
    var requests = field(group, ['requests']);
    return !isCount(requests) || requests === 0;
  }
  function compareFormat(kind, value) {
    if (!isCount(value)) return '—';
    if (kind === 'percent') return Math.round(value) + '%';
    if (kind === 'seconds') return GW_SECONDS.format(value);
    return GW_NUMBER.format(Math.round(value));
  }
  // The request count stays visible ("0"); every other cell of an empty group is a dash.
  function compareCell(row, group) {
    if (row[1] === 'requests') return fmtCount(field(group, ['requests']));
    return groupEmpty(group) ? '—' : compareFormat(row[2], field(group, [row[1]]));
  }
  // The difference is against the baseline; it is a dash whenever either side lacks requests or a value.
  function compareDelta(withGroup, baseGroup, key) {
    if (groupEmpty(withGroup) || groupEmpty(baseGroup)) return '—';
    var withJev = field(withGroup, [key]);
    var baseline = field(baseGroup, [key]);
    if (!isCount(withJev) || !isCount(baseline) || baseline === 0) return '—';
    var delta = Math.round((100 * (withJev - baseline)) / baseline);
    return (delta > 0 ? '+' : '') + delta + '%';
  }
  // One stacked block per metric: the label, then the Com Jev and Baseline cells, then the difference when there is one.
  function cmpCell(caption, text) {
    var cell = elc('div', 'cmp-cell');
    cell.appendChild(elc('span', 'cmp-cap', caption));
    cell.appendChild(elc('span', 'cmp-val', text));
    return cell;
  }
  function compareRow(row, withGroup, baseGroup) {
    var block = elc('div', 'cmp-block');
    block.appendChild(elc('span', 'cmp-label', row[0]));
    var cells = elc('div', 'cmp-cells');
    cells.appendChild(cmpCell('Com Jev', compareCell(row, withGroup)));
    cells.appendChild(cmpCell('Baseline', compareCell(row, baseGroup)));
    block.appendChild(cells);
    var delta = row[3] ? compareDelta(withGroup, baseGroup, row[1]) : '—';
    if (delta !== '—') block.appendChild(elc('span', 'cmp-delta', 'Diferença ' + delta));
    return block;
  }
  function renderCompare(scope, compare) {
    var body = $('obs-' + scope + '-compare-body');
    clearChildren(body);
    var withGroup = field(compare, ['withJev']);
    var baseGroup = field(compare, ['baseline']);
    GW_COMPARE_ROWS.forEach(function (row) { body.appendChild(compareRow(row, withGroup, baseGroup)); });
    var note = '';
    if (!isRecord(compare)) note = dataEmptyText('Sem dados de histórico para comparar.');
    else if (field(baseGroup, ['requests']) === 0) note = GW_NO_BASELINE;
    setText('obs-' + scope + '-compare-note', note);
  }

  function renderFacts(scope, gateway, owner) {
    setText('obs-' + scope + '-experiment', experimentText(gateway));
    fillMetrics(scope, field(owner, ['history']), field(owner, ['cost', 'history']));
    renderCompare(scope, field(owner, ['historyCompare']));
    renderModels(scope, owner);
  }
  function renderCard(scope) {
    var gateway = gwData.gateways[scope];
    var live = gwData.ok ? gateway : null;
    var view = gwData.polled ? cardView(live) : { tone: 's-idle', label: 'Carregando', note: '' };
    $('obs-' + scope).setAttribute('data-tone', view.tone);
    setText('obs-' + scope + '-state', view.label);
    setText('obs-' + scope + '-why', view.note);
    var billing = billingText(gateway);
    setText('obs-' + scope + '-billing', billing);
    $('obs-' + scope + '-billing').hidden = billing === '';
    renderFacts(scope, gateway, gateway);
  }
  // Combined: the running count names how many gateways answer; the experiments of both clients are listed.
  function renderCombined() {
    var combined = gwData.combined;
    var running = GW_CLIENTS.filter(function (client) { return field(gwData.gateways[client], ['state']) === 'running'; }).length;
    var view = !gwData.polled
      ? { tone: 's-idle', label: 'Carregando' }
      : gwData.ok
        ? { tone: running > 0 ? 's-ok' : 's-idle', label: running + ' de ' + GW_CLIENTS.length + ' em execução' }
        : { tone: 's-offline', label: 'Indisponível' };
    $('obs-combined').setAttribute('data-tone', view.tone);
    setText('obs-combined-state', view.label);
    setText('obs-combined-why', gwData.ok ? '' : 'Não foi possível consultar os gateways agora.');
    setText('obs-combined-experiment', GW_CLIENTS.map(function (client) {
      return GW_NAMES[client] + ': ' + experimentText(gwData.gateways[client]);
    }).join(' · '));
    fillMetrics('combined', field(combined, ['history']), field(combined, ['cost', 'history']));
    // The combined history has no p50 of its own; the per-gateway p50 is in the table, so the KPI is hidden rather than estimated.
    $('obs-combined-kpi-latency').hidden = pick(field(combined, ['history']), ['durationMsP50']) === null;
    renderCompare('combined', field(combined, ['historyCompare']));
    renderModels('combined', combined);
    renderTraffic(field(combined, ['models', 'history']));
    renderSideCache(field(combined, ['history']));
    setText('crumb-period', periodChipText(field(combined, ['history'])));
  }
  // The period of the combined history, shown in the breadcrumb: first and last request, and how long they span.
  function periodChipText(metrics) {
    var first = parseTime(field(metrics, ['firstAt']));
    if (first === null) return 'Período: sem registros';
    var text = 'Período: ' + localDate(field(metrics, ['firstAt'])) + ' → ' + localDate(field(metrics, ['lastAt']));
    var last = parseTime(field(metrics, ['lastAt']));
    if (last === null) return text;
    var hours = Math.max(0, Math.floor((last - first) / 3600000));
    return text + ' (' + Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h)';
  }
  // Cache share of the whole history, shown in the sidebar footer with a bar of the same width.
  function renderSideCache(metrics) {
    var pct = fmtPercent(pick(metrics, ['llm', 'cacheRead']), pick(metrics, ['llm', 'input']));
    setText('side-cache', pct !== null ? pct : '—');
    $('side-cache-bar').style.width = pct !== null ? pct : '0%';
  }
  // Traffic split by request count over every model in the history: the top three, then the rest as one segment.
  // The shares are whole percentages that add up to 100 (largest remainder), so the legend always adds up.
  function trafficSegments(entries) {
    var models = entries.map(function (item) { return { name: item.model, count: pick(item.metrics, ['events']) || 0 }; });
    var total = models.reduce(function (sum, item) { return sum + item.count; }, 0);
    if (total === 0) return [];
    models.sort(function (a, b) { return b.count - a.count; });
    var segments = models.slice(0, 3);
    var rest = models.slice(3);
    if (rest.length > 0) segments.push({ name: 'outros ' + rest.length, count: rest.reduce(function (sum, item) { return sum + item.count; }, 0) });
    var raw = segments.map(function (item) { return (100 * item.count) / total; });
    var shares = raw.map(function (value) { return Math.floor(value); });
    var missing = 100 - shares.reduce(function (sum, value) { return sum + value; }, 0);
    raw.map(function (value, index) { return { index: index, rest: value - shares[index] }; })
      .sort(function (a, b) { return b.rest - a.rest; })
      .slice(0, missing)
      .forEach(function (item) { shares[item.index] += 1; });
    return segments.map(function (item, index) { return { name: item.name, share: shares[index] }; });
  }
  function renderTraffic(entries) {
    var bar = $('traffic-bar');
    var legend = $('traffic-legend');
    clearChildren(bar);
    clearChildren(legend);
    var segments = gwData.polled ? trafficSegments(validEntries(entries)) : [];
    segments.forEach(function (segment, index) {
      var slot = el('span');
      slot.setAttribute('data-seg', String(index + 1));
      slot.style.width = segment.share + '%';
      bar.appendChild(slot);
      var swatch = elc('span', 'swatch', '');
      swatch.setAttribute('data-seg', String(index + 1));
      swatch.setAttribute('aria-hidden', 'true');
      var item = el('li');
      item.appendChild(swatch);
      var legendName = elc('span', 'legend-name', segment.name);
      legendName.title = segment.name;
      item.appendChild(legendName);
      item.appendChild(elc('span', 'legend-pct', segment.share + '%'));
      legend.appendChild(item);
    });
    var empty = !gwData.polled ? 'Carregando…' : segments.length === 0 ? 'Sem requisições no histórico ainda.' : '';
    setText('traffic-empty', empty);
    $('traffic-empty').hidden = empty === '';
  }

  // Antigravity panel: passthrough through Code Assist and a subscription, so it shows counts, times and model names only.
  // The live part (agyLive) is read field by field; anything missing or malformed reads as absent ('—' or an empty list).
  function pick(source, path) {
    var value = field(source, path);
    return isCount(value) ? value : null;
  }
  function firstCount(first, second) { return first !== null ? first : second; }
  function fmtSeconds(ms) { return ms !== null ? GW_SECONDS.format(ms / 1000) + ' s' : '—'; }
  function fmtPercent(part, whole) { return part !== null && whole !== null && whole > 0 ? Math.round((100 * part) / whole) + '%' : null; }
  function elc(tag, className, text) {
    var node = el(tag, text);
    node.className = className;
    return node;
  }
  function fmtDuration(ms) {
    var minutes = Math.floor(ms / 60000);
    if (minutes < 1) return 'menos de 1 min';
    var days = Math.floor(minutes / 1440);
    var hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) return days + ' d ' + hours + ' h';
    if (hours > 0) return hours + ' h ' + (minutes % 60) + ' min';
    return minutes + ' min';
  }
  // "há 3 min", "há 2 h", "há 1 d": the time since an instant. A future instant (clock skew) reads as just now.
  function agoText(iso, now) {
    var time = parseTime(iso);
    if (time === null) return '—';
    var minutes = Math.floor(Math.max(0, now - time) / 60000);
    if (minutes < 1) return 'há menos de 1 min';
    if (minutes < 60) return 'há ' + minutes + ' min';
    if (minutes < 1440) return 'há ' + Math.floor(minutes / 60) + ' h';
    return 'há ' + Math.floor(minutes / 1440) + ' d';
  }
  function agyModeText(live) {
    if (!isRecord(live)) return '—';
    return field(live, ['routing']) === false ? 'Passthrough · roteamento travado' : 'Passthrough';
  }
  function agyUpstreamText(gateway) {
    var upstream = field(gateway, ['router', 'upstream']);
    if (typeof upstream !== 'string' || upstream === '') return '—';
    try { return new URL(upstream).hostname || '—'; } catch (error) { return '—'; }
  }
  function agyBillingText(gateway) {
    if (!isRecord(gateway)) return '—';
    var mode = field(gateway, ['billing']);
    return hasOwn(AGY_BILLING_TEXT, mode) ? AGY_BILLING_TEXT[mode] : 'não configurada';
  }
  function agyUptimeText(live, now) {
    var started = parseTime(field(live, ['startedAt']));
    return started === null ? '—' : fmtDuration(Math.max(0, now - started));
  }
  // Each KPI: its value and its sub line. Latency and the last request fall back to the live window when history lacks them.
  function renderAgyKpis(gateway, live, now) {
    var history = field(gateway, ['history']);
    var requests = pick(history, ['events']);
    var input = pick(history, ['llm', 'input']);
    var cacheRead = pick(history, ['llm', 'cacheRead']);
    var liveRequests = pick(live, ['window', 'requests']);
    var errors = pick(live, ['window', 'errors']);
    var p50 = firstCount(pick(history, ['durationMsP50']), pick(live, ['window', 'durationMsP50']));
    var p90 = firstCount(pick(history, ['durationMsP90']), pick(live, ['window', 'durationMsP90']));
    var lastAt = parseTime(field(history, ['lastAt'])) !== null ? field(history, ['lastAt']) : field(live, ['window', 'lastAt']);
    var cache = fmtPercent(cacheRead, input);
    setText('obs-agy-requests', fmtCount(requests));
    setText('obs-agy-requests-sub', liveRequests !== null ? fmtCount(liveRequests) + ' na janela recente' : 'sem dados ao vivo');
    setText('obs-agy-input', fmtTokens(input));
    setText('obs-agy-input-sub', cache !== null ? cache + ' do cache' : 'sem dados de cache');
    setText('obs-agy-output', fmtTokens(pick(history, ['llm', 'output'])));
    setText('obs-agy-output-sub', 'raciocínio ' + fmtTokens(pick(history, ['llm', 'reasoning'])));
    setText('obs-agy-latency', fmtSeconds(p50));
    setText('obs-agy-latency-sub', 'p90 ' + fmtSeconds(p90));
    setText('obs-agy-errors', isRecord(live) ? fmtCount(errors) : '—');
    setText('obs-agy-errors-sub', isRecord(live)
      ? 'de ' + fmtCount(liveRequests) + ' · 4xx ' + fmtCount(pick(live, ['window', 'statuses', 'clientError'])) +
        ' · 5xx ' + fmtCount(pick(live, ['window', 'statuses', 'serverError']))
      : 'sem dados ao vivo');
    $('obs-agy-kpi-errors').classList.toggle('agy-kpi-warn', errors !== null && errors > 0);
    setText('obs-agy-last', agoText(lastAt, now));
    setText('obs-agy-last-sub', localDate(lastAt));
  }
  // Models sorted by requests; the share is taken over every model in the history, not only the twelve shown.
  function agyModelRows(gateway) {
    var entries = field(gateway, ['models', 'history']);
    if (!Array.isArray(entries)) return [];
    var models = entries.filter(function (item) {
      return isRecord(item) && typeof item.model === 'string' && item.model !== '' && isRecord(item.metrics);
    });
    var requestsOf = function (item) { return pick(item.metrics, ['events']) || 0; };
    var total = models.reduce(function (sum, item) { return sum + requestsOf(item); }, 0);
    return models
      .sort(function (a, b) { return requestsOf(b) - requestsOf(a); })
      .slice(0, GW_MODEL_MAX)
      .map(function (item) {
        var requests = requestsOf(item);
        return { model: item.model, metrics: item.metrics, requests: requests, share: total > 0 ? Math.round((100 * requests) / total) : 0 };
      });
  }
  // "entrada X · cache Y% · saída Z · raciocínio W · p50 T s"; a part with no value is left out.
  function agyModelMeta(metrics) {
    var input = pick(metrics, ['llm', 'input']);
    var parts = [];
    if (input !== null) parts.push('entrada ' + fmtTokens(input));
    var cache = fmtPercent(pick(metrics, ['llm', 'cacheRead']), input);
    if (cache !== null) parts.push('cache ' + cache);
    if (pick(metrics, ['llm', 'output']) !== null) parts.push('saída ' + fmtTokens(pick(metrics, ['llm', 'output'])));
    if (pick(metrics, ['llm', 'reasoning']) !== null) parts.push('raciocínio ' + fmtTokens(pick(metrics, ['llm', 'reasoning'])));
    if (pick(metrics, ['durationMsP50']) !== null) parts.push('p50 ' + fmtSeconds(pick(metrics, ['durationMsP50'])));
    return parts.join(' · ');
  }
  function agyModelItem(row) {
    var li = el('li');
    var head = elc('div', 'agy-row');
    head.appendChild(elc('span', 'agy-name', row.model));
    head.appendChild(elc('span', 'agy-count', fmtCount(row.requests) + ' req · ' + row.share + '%'));
    var bar = elc('div', 'agy-bar');
    var fill = el('span');
    fill.style.width = row.share + '%';
    bar.appendChild(fill);
    li.appendChild(head);
    li.appendChild(bar);
    var meta = agyModelMeta(row.metrics);
    if (meta !== '') li.appendChild(elc('p', 'agy-meta', meta));
    return li;
  }
  function renderAgyModels(gateway) {
    var rows = agyModelRows(gateway);
    var body = $('obs-agy-models-body');
    clearChildren(body);
    rows.forEach(function (row) { body.appendChild(agyModelItem(row)); });
    setText('obs-agy-models-empty', dataEmptyText('Nenhum modelo no histórico do log ainda.'));
    $('obs-agy-models-empty').hidden = rows.length > 0;
    setText('obs-agy-models-count', gwData.polled ? String(rows.length) : '—');
  }
  // Recent requests from the live window (window.firstAt onward, not the gateway start), newest first as sent, at most AGY_RECENT_MAX.
  // One numeric cell per metric; data-label names it on narrow screens, where the cells wrap into lines.
  function agyNum(label, text) {
    var node = elc('span', 'agy-num', text);
    node.setAttribute('data-label', label);
    return node;
  }
  function agyRecentItem(entry) {
    var li = el('li');
    li.className = 'agy-item';
    var row = elc('div', 'row');
    row.appendChild(elc('span', 'title', typeof entry.model === 'string' && entry.model !== '' ? entry.model : '—'));
    var time = parseTime(entry.time);
    row.appendChild(elc('span', 'when', time === null ? '—' : clock(time)));
    li.appendChild(row);
    var status = pick(entry, ['status']);
    var ok = status !== null && status >= 200 && status < 400;
    var meta = elc('div', 'meta');
    meta.appendChild(elc('span', 'badge ' + (ok ? 'agy-ok' : 'agy-err'), status === null ? '—' : String(status)));
    meta.appendChild(elc('span', 'path', typeof entry.method === 'string' && entry.method !== '' ? entry.method : '—'));
    meta.appendChild(agyNum('duração', fmtSeconds(pick(entry, ['durationMs']))));
    meta.appendChild(agyNum('entrada', fmtTokens(pick(entry, ['input']))));
    meta.appendChild(agyNum('saída', fmtTokens(pick(entry, ['output']))));
    meta.appendChild(agyNum('raciocínio', fmtTokens(pick(entry, ['reasoning']))));
    li.appendChild(meta);
    return li;
  }
  // The newest AGY_RECENT_VISIBLE rows show; the button reveals the rest (up to AGY_RECENT_MAX) and folds them back.
  function renderAgyRecent(live) {
    agyRecentLive = live;
    var list = $('obs-agy-recent');
    clearChildren(list);
    var items = isRecord(live) && Array.isArray(live.recent) ? live.recent.filter(isRecord).slice(0, AGY_RECENT_MAX) : [];
    items.forEach(function (entry, index) {
      var item = agyRecentItem(entry);
      item.hidden = index >= AGY_RECENT_VISIBLE && !agyRecentExpanded;
      list.appendChild(item);
    });
    var more = $('obs-agy-recent-more');
    more.hidden = items.length <= AGY_RECENT_VISIBLE;
    more.setAttribute('aria-expanded', agyRecentExpanded ? 'true' : 'false');
    more.textContent = agyRecentExpanded ? 'Mostrar menos' : 'Mostrar todas (' + items.length + ')';
    setText('obs-agy-recent-count', gwData.polled ? String(items.length) : '—');
    var empty = !gwData.polled ? 'Carregando…' : !isRecord(live) ? AGY_NO_LIVE_RECENT : items.length === 0 ? AGY_NO_RECENT : '';
    setText('obs-agy-recent-empty', empty);
    $('obs-agy-recent-empty').hidden = empty === '';
  }
  $('obs-agy-recent-more').addEventListener('click', function () {
    agyRecentExpanded = !agyRecentExpanded;
    renderAgyRecent(agyRecentLive);
  });
  // Window and start are separate: the window can begin before the gateway's current start, so both dates are shown.
  function renderAgyPeriod(gateway, live) {
    if (!gwData.polled) return setText('obs-agy-period', 'Carregando…');
    var win = isRecord(live) && isRecord(live.window) ? live.window : null;
    var windowText = win && parseTime(win.firstAt) !== null
      ? 'Janela recente: ' + localDate(win.firstAt) + ' → ' + localDate(win.lastAt)
      : 'Janela recente: sem dados ao vivo';
    var startText = parseTime(field(live, ['startedAt'])) !== null ? 'Gateway ativo desde ' + localDate(field(live, ['startedAt'])) : 'Gateway ativo: sem dados ao vivo';
    setText('obs-agy-period', 'Histórico: ' + fmtPeriod(field(gateway, ['history'])) + ' · ' + windowText + ' · ' + startText +
      '. Só contagens, tempos e nomes de modelo; nenhum conteúdo de prompt é lido.');
  }
  // The panel follows the same stale rule as the cards: the state comes from the latest valid poll, the values from the last one.
  function renderAgy() {
    var gateway = gwData.gateways.agy;
    var live = field(gateway, ['agyLive']);
    var now = Date.now();
    var view = gwData.polled ? cardView(gwData.ok ? gateway : null) : { tone: 's-idle', label: 'Carregando', note: '' };
    $('obs-agy').setAttribute('data-tone', view.tone);
    setText('obs-agy-state', view.label);
    setText('obs-agy-why', view.tone === 's-ok' ? AGY_PASSTHROUGH_NOTE : view.note);
    setText('obs-agy-mode', agyModeText(live));
    setText('obs-agy-contract', pick(live, ['codeAssist']) !== null ? 'contrato v' + live.codeAssist : '—');
    setText('obs-agy-pid', fmtCount(pick(live, ['pid'])));
    setText('obs-agy-uptime', agyUptimeText(live, now));
    setText('obs-agy-upstream', agyUpstreamText(gateway));
    setText('obs-agy-billing', agyBillingText(gateway));
    renderAgyKpis(gateway, live, now);
    renderAgyModels(gateway);
    renderAgyRecent(live);
    renderAgyPeriod(gateway, live);
  }

  function priceNote(label, entry) {
    var source = field(entry, ['source']);
    var verified = field(entry, ['verifiedAt']);
    var until = field(entry, ['validUntil']);
    return label + ': ' + (typeof source === 'string' && source !== '' ? source : '—') +
      ' (verificado em ' + (typeof verified === 'string' && verified !== '' ? verified : '—') + ')' +
      (typeof until === 'string' && until !== '' ? ' (válido até ' + until + ')' : '');
  }
  // Priced models in the server's order, then the Jev price when configured.
  function pricingParts(pricing) {
    var models = field(pricing, ['models']);
    var parts = isRecord(models)
      ? Object.keys(models).filter(function (model) { return isRecord(models[model]); })
        .map(function (model) { return priceNote(model, models[model]); })
      : [];
    var jev = field(pricing, ['jev']);
    if (isRecord(jev)) parts.push(priceNote('Jev', jev));
    return parts;
  }
  function renderPricing() {
    if (!gwData.polled) return setText('gw-pricing', 'Carregando preços…');
    if (!gwData.loaded) return setText('gw-pricing', 'Preços indisponíveis: o gateway não respondeu.');
    var parts = pricingParts(gwData.pricing);
    setText('gw-pricing', parts.length ? 'Fontes de preço: ' + parts.join('; ') + '.' : 'Nenhum preço configurado (observability.pricing.models).');
  }

  // Status chips and the Todos provider table: the same state as the cards, one short value per column.
  function stateView(client) {
    if (!gwData.polled) return { tone: 's-idle', label: 'Carregando' };
    return cardView(gwData.ok ? gwData.gateways[client] : null);
  }
  function cachePctShort(metrics) {
    var pct = fmtPercent(pick(metrics, ['llm', 'cacheRead']), pick(metrics, ['llm', 'input']));
    return pct !== null ? pct : '—';
  }
  // The sidebar pills use the short words; the full state stays in the screen-reader text and the title.
  var GW_SHORT_STATE = { 'Em execução': 'online', 'Parado': 'parado', 'Indisponível': 'indisp.', 'Exige chave': 'chave', 'Carregando': '…' };
  function renderStrip() {
    GW_CLIENTS.forEach(function (client) {
      var view = stateView(client);
      $('gs-dot-' + client).setAttribute('data-tone', view.tone);
      setText('gs-state-' + client, view.label);
      setText('gs-pill-' + client, GW_SHORT_STATE[view.label] || '—');
      // The pill is the one status signal in the sidebar; only an unavailable gateway turns it red.
      $('gs-pill-' + client).setAttribute('data-tone', view.tone);
      $('gs-' + client).title = GW_NAMES[client] + ': ' + view.label;
    });
  }
  function renderProviders() {
    GW_CLIENTS.forEach(function (client) {
      var metrics = field(gwData.gateways[client], ['history']);
      var view = stateView(client);
      setText('gw-prov-' + client + '-state', view.label);
      $('gw-prov-' + client + '-dot').setAttribute('data-tone', view.tone);
      $('gw-prov-' + client + '-row').title = GW_NAMES[client] + ': ' + view.label;
      setText('gw-prov-' + client + '-requests', fmtCount(field(metrics, ['events'])));
      setText('gw-prov-' + client + '-input', fmtTokens(field(metrics, ['llm', 'uncachedInput'])));
      setText('gw-prov-' + client + '-cache', cachePctShort(metrics));
      setText('gw-prov-' + client + '-cacheread', fmtTokens(field(metrics, ['llm', 'cacheRead'])));
      setText('gw-prov-' + client + '-output', fmtTokens(field(metrics, ['llm', 'output'])));
      setText('gw-prov-' + client + '-p50', fmtSeconds(pick(metrics, ['durationMsP50'])));
    });
  }

  // Views: one visible at a time. The top tabs, the sidebar entries and the provider cards all select a view; the last one is remembered.
  // Blocked storage only loses the memory. The view titles are shown in the breadcrumb and, below 1000px, in the top bar.
  var GW_VIEW_KEY = 'jms.dashboard.view';
  var GW_VIEWS = ['overview', 'combined', 'claude', 'codex', 'agy', 'gateway'];
  var GW_VIEW_LABELS = { overview: 'Visão geral', combined: 'Tokens', claude: 'Claude Code', codex: 'OpenAI Codex', agy: 'Google Antigravity', gateway: 'Jev Gateway' };
  var GW_SIDE_IDS = { overview: 'side-overview', combined: 'side-combined', claude: 'gs-claude', codex: 'gs-codex', agy: 'gs-agy', gateway: 'side-gateway' };
  var gwView = 'overview';
  function readView() {
    try {
      var saved = window.localStorage.getItem(GW_VIEW_KEY);
      return GW_VIEWS.indexOf(saved) !== -1 ? saved : 'overview';
    } catch (e) { return 'overview'; }
  }
  function saveView(key) {
    try { window.localStorage.setItem(GW_VIEW_KEY, key); } catch (e) { /* Storage is optional; the view still changes for this page. */ }
  }
  // options.focus moves focus to the view's tab; options.reveal scrolls the view below the sticky top bar (scroll-margin in the stylesheet).
  function selectView(key, options) {
    if (GW_VIEWS.indexOf(key) === -1) return;
    gwView = key;
    GW_VIEWS.forEach(function (name) {
      var on = name === key;
      var tab = $('gw-tab-' + name);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      $('gw-panel-' + name).hidden = !on;
      $(GW_SIDE_IDS[name]).setAttribute('aria-current', on ? 'page' : 'false');
    });
    setText('crumb-view', GW_VIEW_LABELS[key]);
    setText('topbar-view', GW_VIEW_LABELS[key]);
    if (options && options.focus) $('gw-tab-' + key).focus();
    if (options && options.reveal) $('gw-panel-' + key).scrollIntoView({ block: 'start' });
    saveView(key);
  }
  // Arrow keys move through the top tabs in order, Home and End jump to the ends; the moved-to tab is selected at once.
  $('gw-tablist').addEventListener('keydown', function (event) {
    var index = GW_VIEWS.indexOf(gwView);
    var next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % GW_VIEWS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + GW_VIEWS.length) % GW_VIEWS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = GW_VIEWS.length - 1;
    if (next === null) return;
    event.preventDefault();
    selectView(GW_VIEWS[next], { focus: true });
  });

  // Below 1000px the sidebar is a drawer. The menu button opens it, Escape, the scrim, the close button or a chosen view closes it.
  // Focus moves into the drawer on open and back to the menu button on close; the content behind is inert while it is open.
  var drawerOpen = false;
  function setDrawer(open, restoreFocus) {
    drawerOpen = open;
    $('sidebar').setAttribute('data-open', open ? 'true' : 'false');
    $('menu-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('scrim').hidden = !open;
    if (open) $('content').setAttribute('inert', ''); else $('content').removeAttribute('inert');
    if (open) $('drawer-close').focus();
    else if (restoreFocus) $('menu-toggle').focus();
  }
  // A chosen view closes the drawer on a phone, so the page under it is the one that was picked.
  function openView(key) {
    selectView(key, { reveal: true });
    if (drawerOpen) setDrawer(false, true);
  }
  $('menu-toggle').addEventListener('click', function () {
    if (drawerOpen) setDrawer(false, true); else setDrawer(true, false);
  });
  $('drawer-close').addEventListener('click', function () { setDrawer(false, true); });
  $('scrim').addEventListener('click', function () { setDrawer(false, true); });
  function onEscape(event) {
    if (event.key === 'Escape' && drawerOpen) setDrawer(false, true);
  }
  $('sidebar').addEventListener('keydown', onEscape);
  if (typeof document.addEventListener === 'function') document.addEventListener('keydown', onEscape);
  // Growing past 1000px puts the sidebar back in the layout, so the drawer state is cleared.
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', function () {
      if (drawerOpen && typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1000px)').matches) setDrawer(false, false);
    });
  }

  GW_VIEWS.forEach(function (name) {
    $('gw-tab-' + name).addEventListener('click', function () { selectView(name, { reveal: true }); });
    $(GW_SIDE_IDS[name]).addEventListener('click', function () { openView(name); });
  });
  // The provider cards open their provider view; the Tokens callout opens the Jev Gateway view.
  GW_CLIENTS.forEach(function (client) {
    $('gw-prov-' + client + '-row').addEventListener('click', function () { openView(client); });
  });
  $('go-gateway').addEventListener('click', function () { openView('gateway'); });

  function renderAll() {
    renderCard('claude');
    renderCard('codex');
    renderAgy();
    renderCombined();
    renderPricing();
    renderStrip();
    renderProviders();
    $('obs-stale').hidden = !gwData.stale;
  }
  function pickGateway(list, client) {
    var match = list.filter(function (gateway) { return isRecord(gateway) && gateway.client === client; })[0];
    return match || null;
  }
  // A failed or invalid response keeps the last values; the cards say Indisponível and the section is marked stale.
  function applyGateways(data) {
    gwData.polled = true;
    if (!isRecord(data) || data.ok !== true || !Array.isArray(data.gateways)) {
      gwData.ok = false;
      gwData.stale = gwData.loaded;
    } else {
      gwData.loaded = true;
      gwData.ok = true;
      gwData.stale = false;
      gwData.gateways = { claude: pickGateway(data.gateways, 'claude'), codex: pickGateway(data.gateways, 'codex'), agy: pickGateway(data.gateways, 'agy') };
      gwData.combined = isRecord(data.combined) ? data.combined : null;
      gwData.pricing = isRecord(data.pricing) ? data.pricing : null;
    }
    checkAggregatorNotice(data);
    renderAll();
  }
  function pollGateways() {
    fetch('/gateways/status', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(applyGateways, function () { applyGateways(null); });
  }

  selectView(readView(), {});
  renderAll();
  pollGateways();
  setInterval(pollGateways, GW_POLL_MS);
`;
