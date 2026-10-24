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
  var GW_NAMES = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
  var GW_EXPERIMENTS = { 'default': 'padrão', shadow: 'sombra', metering: 'medição', passthrough: 'passthrough' };
  var GW_PASSTHROUGH_NOTE = 'Passthrough: este gateway não roteia pelo Jev.';
  var GW_NO_COMPARE_PASSTHROUGH = 'Sem comparação com e sem Jev: este gateway roda sempre em passthrough.';
  var GW_COMBINED_COMPARE_NOTE = 'Somente Claude e Codex entram nesta comparação.';
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
  var gwData = { polled: false, loaded: false, ok: false, stale: false, gateways: { claude: null, codex: null }, combined: null, pricing: null };

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
    if (key === 'llmOutput') return fmtTokens(field(metrics, ['llm', 'output'])) + ' / ' + fmtTokens(field(metrics, ['llm', 'reasoning']));
    var spec = GW_FIELDS[key];
    return spec ? spec[1](field(metrics, spec[0])) : '—';
  }
  function fillMetrics(scope, metrics, cost) {
    GW_OBS_ROW_KEYS.forEach(function (key) {
      setText('obs-' + scope + '-' + key, obsText(key, metrics, cost));
    });
  }

  function cardView(gateway) {
    if (!gateway) return { tone: 's-offline', label: 'Indisponível', note: 'Não foi possível consultar este gateway agora.' };
    if (gateway.metrics === 'auth-required') return { tone: 's-warn', label: 'Exige chave', note: 'O gateway exige chave; este painel não envia credenciais.' };
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
  function modelEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries
      .filter(function (item) { return isRecord(item) && typeof item.model === 'string' && item.model !== '' && isRecord(item.metrics); })
      .slice(0, GW_MODEL_MAX);
  }
  function modelRow(entry) {
    var tr = el('tr');
    var name = el('th', entry.model);
    name.setAttribute('scope', 'row');
    tr.appendChild(name);
    GW_MODEL_KEYS.forEach(function (key) {
      var spec = GW_FIELDS[key];
      tr.appendChild(el('td', spec ? spec[1](field(entry.metrics, spec[0])) : '—'));
    });
    tr.appendChild(el('td', modelCostText(entry)));
    return tr;
  }
  function renderModels(scope, owner) {
    var rows = modelEntries(field(owner, ['models', 'history']));
    var body = $('obs-' + scope + '-models-body');
    clearChildren(body);
    rows.forEach(function (entry) { body.appendChild(modelRow(entry)); });
    setText('obs-' + scope + '-models-empty', dataEmptyText('Nenhum modelo no histórico do log ainda.'));
    $('obs-' + scope + '-models-empty').hidden = rows.length > 0;
  }

  // Comparison: a row shows the request count, then per-request averages and cache share with and without Jev.
  // Passthrough clients have no with-Jev side, so their comparison block is hidden and replaced by a note.
  function setHidden(id, hidden) { $(id).hidden = hidden; }
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
  function compareRow(row, withGroup, baseGroup) {
    var tr = el('tr');
    var label = el('th', row[0]);
    label.setAttribute('scope', 'row');
    tr.appendChild(label);
    tr.appendChild(el('td', compareCell(row, withGroup)));
    tr.appendChild(el('td', compareCell(row, baseGroup)));
    tr.appendChild(el('td', row[3] ? compareDelta(withGroup, baseGroup, row[1]) : ''));
    return tr;
  }
  function renderCompare(scope, compare) {
    var routed = scope !== 'agy';
    setHidden('obs-' + scope + '-compare-title', !routed);
    setHidden('obs-' + scope + '-compare-wrap', !routed);
    var body = $('obs-' + scope + '-compare-body');
    clearChildren(body);
    if (!routed) return setText('obs-' + scope + '-compare-note', GW_NO_COMPARE_PASSTHROUGH);
    var withGroup = field(compare, ['withJev']);
    var baseGroup = field(compare, ['baseline']);
    GW_COMPARE_ROWS.forEach(function (row) { body.appendChild(compareRow(row, withGroup, baseGroup)); });
    var note = '';
    if (!isRecord(compare)) note = dataEmptyText('Sem dados de histórico para comparar.');
    else if (field(baseGroup, ['requests']) === 0) note = GW_NO_BASELINE;
    if (scope === 'combined') note = [note, GW_COMBINED_COMPARE_NOTE].filter(function (part) { return part !== ''; }).join(' ');
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
    $('obs-' + scope).className = 'card gw-card ' + view.tone;
    setText('obs-' + scope + '-state', view.label);
    setText('obs-' + scope + '-why', scope === 'agy' ? (GW_PASSTHROUGH_NOTE + ' ' + view.note).trim() : view.note);
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
    $('obs-combined').className = 'card gw-card gw-wide ' + view.tone;
    setText('obs-combined-state', view.label);
    setText('obs-combined-why', gwData.ok ? '' : 'Não foi possível consultar os gateways agora.');
    setText('obs-combined-experiment', GW_CLIENTS.map(function (client) {
      return GW_NAMES[client] + ': ' + experimentText(gwData.gateways[client]);
    }).join(' · '));
    fillMetrics('combined', field(combined, ['history']), field(combined, ['cost', 'history']));
    renderCompare('combined', field(combined, ['historyCompare']));
    renderModels('combined', combined);
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

  function renderAll() {
    GW_CLIENTS.forEach(function (client) { renderCard(client); });
    renderCombined();
    renderPricing();
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
      gwData.gateways = { claude: pickGateway(data.gateways, 'claude'), codex: pickGateway(data.gateways, 'codex') };
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

  renderAll();
  pollGateways();
  setInterval(pollGateways, GW_POLL_MS);
`;
