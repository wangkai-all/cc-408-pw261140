/* Event quality & settlement console — vanilla ES module, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  meta: null,
  from: null,
  to: null,
  view: 'overview',
  rules: [],
  runs: [],
};

/* ------------------------------------------------------------------ utils */

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const num = (n) => Number(n || 0).toLocaleString('zh-CN');
const money = (cents) =>
  cents == null ? '—' : (Number(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const signedMoney = (cents) => `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${money(Math.abs(cents))}`;
const timeLabel = (iso) => (iso ? String(iso).replace('T', ' ').replace(/(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, '') : '—');
const dateOnly = (iso) => (iso ? String(iso).slice(0, 10) : '—');

function daysBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`响应不是 JSON（${res.status}）`);
  }
  if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
  return data;
}

/* verdict / status vocabulary */

const VERDICTS = {
  valid: { label: '有效', cls: 'badge-valid' },
  invalid: { label: '无效', cls: 'badge-invalid' },
  suspect: { label: '可疑', cls: 'badge-suspect' },
  superseded: { label: '已存档', cls: 'badge-neutral' },
  committed: { label: '已提交', cls: 'badge-valid' },
  running: { label: '进行中', cls: 'badge-info' },
  failed: { label: '失败', cls: 'badge-invalid' },
  draft: { label: '草稿', cls: 'badge-neutral' },
  sealed: { label: '已封存', cls: 'badge-valid' },
  approved: { label: '已批准', cls: 'badge-valid' },
  rejected: { label: '已驳回', cls: 'badge-invalid' },
  queued: { label: '排队中', cls: 'badge-neutral' },
  succeeded: { label: '成功', cls: 'badge-valid' },
  canceled: { label: '已取消', cls: 'badge-neutral' },
  published: { label: '已发布', cls: 'badge-valid' },
  retired: { label: '已退役', cls: 'badge-neutral' },
  note: { label: '记录', cls: 'badge-info' },
  pass: { label: '通过', cls: 'badge-valid' },
  skip: { label: '跳过', cls: 'badge-neutral' },
  fail: { label: '不通过', cls: 'badge-invalid' },
};

function badge(key, text = null) {
  const v = VERDICTS[key] || { label: key || '—', cls: 'badge-neutral' };
  return `<span class="badge ${v.cls}"><span class="dot"></span>${esc(text || v.label)}</span>`;
}

const statusLabel = (key) => (VERDICTS[key] || { label: key || '—' }).label;

function severityBadge(sev) {
  if (sev === 'hard') return '<span class="badge badge-hard">硬性</span>';
  if (sev === 'soft') return '<span class="badge badge-soft">软性</span>';
  return '<span class="badge badge-info">参考</span>';
}

const DIRECTION_LABELS = {
  became_valid: '转为有效',
  became_invalid: '转为无效',
  became_suspect: '转为可疑',
  became_other: '判定变化',
  reason_changed: '理由变化',
};

/* ------------------------------------------------------------------ charts */

const svgEl = (strings, ...values) => strings.map((s, i) => s + (values[i] ?? '')).join('');

function niceMax(value) {
  if (!(value > 0)) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const steps = [1, 2, 2.5, 5, 10];
  for (const s of steps) {
    if (value <= s * base) return s * base;
  }
  return 10 * base;
}

function fmtCompact(n) {
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}万`;
  return String(n);
}

function chartSvg({ width = 780, height = 250, pad = { l: 48, r: 16, t: 16, b: 32 }, yTicks = 4, categories, yMax, yFmt = fmtCompact }) {
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const step = innerW / Math.max(categories.length, 1);
  const parts = [];
  for (let i = 0; i <= yTicks; i += 1) {
    const v = (yMax / yTicks) * i;
    const y = pad.t + innerH - (innerH * i) / yTicks;
    parts.push(`<line class="gridline" x1="${pad.l}" y1="${y}" x2="${width - pad.r}" y2="${y}"></line>`);
    parts.push(`<text class="tick-label" x="${pad.l - 8}" y="${y + 3.5}" text-anchor="end">${esc(yFmt(v))}</text>`);
  }
  parts.push(`<line class="axisline" x1="${pad.l}" y1="${pad.t + innerH}" x2="${width - pad.r}" y2="${pad.t + innerH}"></line>`);
  const tickEvery = Math.ceil(categories.length / 8);
  categories.forEach((c, i) => {
    if (i % tickEvery !== 0) return;
    parts.push(`<text class="tick-label" x="${pad.l + step * i + step / 2}" y="${height - 10}" text-anchor="middle">${esc(c.slice(5))}</text>`);
  });
  return { svg: parts.join(''), innerW, innerH, step, pad, width, height, yMax };
}

function legendHtml(items) {
  return `<div class="legend">${items
    .map((s) => `<span class="key"><span class="swatch" style="background:${s.color}"></span>${esc(s.label)}</span>`)
    .join('')}</div>`;
}

/** Stacked bar chart. series: [{key,label,color,values}] */
function stackedBarChart({ categories, series, height = 240, unit = '条', note = null }) {
  const totals = categories.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const yMax = niceMax(Math.max(...totals, 1));
  const frame = chartSvg({ categories, yMax, height });
  const bars = [];
  categories.forEach((cat, i) => {
    let cum = 0;
    const x = frame.pad.l + frame.step * i + frame.step * 0.19;
    const w = frame.step * 0.62;
    series.forEach((s, k) => {
      const v = s.values[i] || 0;
      if (v <= 0) return;
      const y0 = frame.pad.t + frame.innerH - (frame.innerH * cum) / yMax;
      const y1 = frame.pad.t + frame.innerH - (frame.innerH * (cum + v)) / yMax;
      const gap = k === 0 ? 0 : 2;
      // y1 is the top edge (smaller y), y0 the bottom edge of this segment.
      const h = Math.max(y0 - y1 - gap, 1);
      bars.push(
        `<rect class="bar" x="${x.toFixed(2)}" y="${(y1 + gap).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="1.5" fill="${s.color}"></rect>`,
      );
      cum += v;
    });
    bars.push(
      `<rect class="hit" data-chart-hit="${i}" x="${frame.pad.l + frame.step * i}" y="${frame.pad.t}" width="${frame.step}" height="${frame.innerH}" tabindex="0" role="img" aria-label="${esc(
        `${cat}：${series.map((s) => `${s.label} ${s.values[i] || 0}`).join('，')}`,
      )}"></rect>`,
    );
  });
  const data = categories.map((c, i) => ({ category: c, values: series.map((s) => ({ label: s.label, value: s.values[i] || 0, color: s.color })), total: totals[i] }));
  return {
    html: `<div class="chart" data-chart='${esc(JSON.stringify(data))}' data-unit="${esc(unit)}">${legendHtml(series)}<svg viewBox="0 0 ${frame.width} ${frame.height}" role="group" aria-label="每日构成柱状图">${frame.svg}${bars.join('')}</svg></div>`,
    table: `<div class="table-wrap"><table><thead><tr><th>日期</th>${series.map((s) => `<th class="num">${esc(s.label)}</th>`).join('')}<th class="num">合计</th></tr></thead><tbody>${categories
      .map((c, i) => `<tr><td>${esc(c)}</td>${series.map((s) => `<td class="num">${num(s.values[i] || 0)}</td>`).join('')}<td class="num">${num(totals[i])}</td></tr>`)
      .join('')}</tbody></table></div>`,
  };
}

/** Grouped bars for two entities, one axis. Values are counts, or cents when cents=true. */
function groupedBarChart({ categories, series, height = 250, cents = false }) {
  const fmt = cents ? money : num;
  const max = Math.max(...series.flatMap((s) => s.values.map((v) => Math.abs(v))), 1);
  const yMax = niceMax(max);
  const frame = chartSvg({ categories, yMax, height, yFmt: cents ? (v) => fmtCompact(v / 100) : fmtCompact });
  const bars = [];
  const each = (frame.step * 0.66) / series.length;
  categories.forEach((cat, i) => {
    series.forEach((s, k) => {
      const v = s.values[i] || 0;
      const x = frame.pad.l + frame.step * i + frame.step * 0.17 + each * k;
      const h = (frame.innerH * Math.abs(v)) / yMax;
      const y = frame.pad.t + frame.innerH - h;
      bars.push(
        `<rect class="bar" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(each - 2, 1).toFixed(2)}" height="${Math.max(h, v === 0 ? 0 : 1).toFixed(2)}" rx="2" fill="${s.color}"></rect>`,
      );
    });
    bars.push(
      `<rect class="hit" data-chart-hit="${i}" x="${frame.pad.l + frame.step * i}" y="${frame.pad.t}" width="${frame.step}" height="${frame.innerH}" tabindex="0" role="img" aria-label="${esc(
        `${cat}：${series.map((s) => `${s.label} ${fmt(s.values[i] || 0)}`).join('，')}`,
      )}"></rect>`,
    );
  });
  const data = categories.map((c, i) => ({ category: c, values: series.map((s) => ({ label: s.label, value: s.values[i] || 0, color: s.color })) }));
  return {
    html: `<div class="chart" data-chart='${esc(JSON.stringify(data))}' data-format="${cents ? 'money' : 'count'}">${legendHtml(series)}<svg viewBox="0 0 ${frame.width} ${frame.height}" role="group" aria-label="每日金额对比柱状图">${frame.svg}${bars.join('')}</svg></div>`,
    table: `<div class="table-wrap"><table><thead><tr><th>日期</th>${series.map((s) => `<th class="num">${esc(s.label)}</th>`).join('')}</tr></thead><tbody>${categories
      .map((c, i) => `<tr><td>${esc(c)}</td>${series.map((s) => `<td class="num">${fmt(s.values[i] || 0)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`,
  };
}

/** Single-series line chart of cent amounts (daily net settlement). */
function lineChart({ categories, values, height = 230, label = '金额（元）' }) {
  const yMax = niceMax(Math.max(...values.map((v) => Math.abs(v)), 1));
  const frame = chartSvg({ categories, yMax, height, yFmt: (v) => fmtCompact(v / 100) });
  const pts = values.map((v, i) => {
    const x = frame.pad.l + frame.step * i + frame.step / 2;
    const y = frame.pad.t + frame.innerH - (frame.innerH * Math.max(v, 0)) / yMax;
    return { x, y, v };
  });
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
  const hits = pts
    .map(
      (p, i) =>
        `<rect class="hit" data-chart-hit="${i}" x="${(p.x - frame.step / 2).toFixed(2)}" y="${frame.pad.t}" width="${frame.step.toFixed(2)}" height="${frame.innerH}" tabindex="0" role="img" aria-label="${esc(`${categories[i]}：${money(p.v)} 元`)}"></rect>`,
    )
    .join('');
  const dots = pts.map((p) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="3.5" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"></circle>`).join('');
  const data = categories.map((c, i) => ({ category: c, values: [{ label, value: values[i], color: 'var(--series-1)' }] }));
  return {
    html: `<div class="chart" data-chart='${esc(JSON.stringify(data))}' data-format="money"><svg viewBox="0 0 ${frame.width} ${frame.height}" role="group" aria-label="每日结算净额折线图">${frame.svg}<path d="${path}" fill="none" stroke="var(--series-1)" stroke-width="2"></path>${dots}${hits}</svg></div>`,
    table: `<div class="table-wrap"><table><thead><tr><th>日期</th><th class="num">${esc(label)}</th></tr></thead><tbody>${categories
      .map((c, i) => `<tr><td>${esc(c)}</td><td class="num">${money(values[i])}</td></tr>`)
      .join('')}</tbody></table></div>`,
  };
}

/** Horizontal bars, labelled directly. rows: [{label, value, note, color?}] */
function hbarChart({ rows, max = null, fmt = num, unit = '条' }) {
  if (!rows.length) return '<div class="empty">没有数据</div>';
  const top = max ?? Math.max(...rows.map((r) => r.value), 1);
  return `<div class="hbars" role="group">${rows
    .map(
      (r) => `<div class="hbar" title="${esc(`${r.label}：${fmt(r.value)} ${unit}${r.note ? `（${r.note}）` : ''}`)}">
        <div class="hbar-label" title="${esc(r.label)}">${esc(r.label)}</div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max((r.value / top) * 100, r.value > 0 ? 1.5 : 0).toFixed(1)}%;background:${r.color || 'var(--series-1)'}"></div></div>
        <div class="hbar-value">${esc(fmt(r.value))}${r.note ? `<span class="muted small"> · ${esc(r.note)}</span>` : ''}</div>
      </div>`,
    )
    .join('')}</div>`;
}

function tableTwin(chart) {
  return `<details class="table-view"><summary>查看数据表</summary>${chart.table}</details>`;
}

/* tooltips */
let tipTarget = null;

function showTip(x, y, html) {
  const tip = $('#tooltip');
  tip.innerHTML = html;
  tip.hidden = false;
  const rect = tip.getBoundingClientRect();
  const left = Math.min(Math.max(x - rect.width / 2, 8), window.innerWidth - rect.width - 8);
  const top = y - rect.height - 12 < 8 ? y + 16 : y - rect.height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTip() {
  $('#tooltip').hidden = true;
  tipTarget = null;
}

function chartTipFrom(container, index) {
  const data = JSON.parse(container.dataset.chart || '[]');
  const row = data[index];
  if (!row) return '';
  const unit = container.dataset.unit || '';
  const isMoney = container.dataset.format === 'money';
  const show = (v) => (isMoney ? `${money(v)} 元` : `${num(v)} ${unit}`);
  const lines = row.values
    .map((v) => `<div class="row-between"><span class="tt-label"><span class="swatch" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${v.color};margin-right:6px"></span>${esc(v.label)}</span><span>${show(v.value)}</span></div>`)
    .join('');
  return `<div class="tt-label">${esc(row.category)}</div>${lines}${row.total != null ? `<div class="row-between" style="margin-top:3px"><span class="tt-label">合计</span><span class="tt-value">${show(row.total)}</span></div>` : ''}`;
}

document.addEventListener('mousemove', (e) => {
  const hit = e.target.closest?.('[data-chart-hit]');
  if (!hit) {
    if (tipTarget) hideTip();
    return;
  }
  const container = hit.closest('.chart');
  if (!container) return;
  tipTarget = hit;
  const idx = Number(hit.dataset.chartHit);
  showTip(e.clientX, e.clientY, chartTipFrom(container, idx));
});

document.addEventListener('focusin', (e) => {
  const hit = e.target.closest?.('[data-chart-hit]');
  if (!hit) return;
  const container = hit.closest('.chart');
  const rect = hit.getBoundingClientRect();
  showTip(rect.left + rect.width / 2, rect.top + 40, chartTipFrom(container, Number(hit.dataset.chartHit)));
});

document.addEventListener('focusout', () => hideTip());

/* ------------------------------------------------------------------ drawer */

function openDrawer(title, html) {
  $('#drawer-title').textContent = title;
  $('#drawer-body').innerHTML = html;
  $('#drawer').hidden = false;
  $('#drawer-backdrop').hidden = false;
  $('#drawer-close').focus();
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawer-backdrop').hidden = true;
  $('#drawer-body').innerHTML = '';
  hideTip();
}

$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
});

/* ------------------------------------------------------------------ theme */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('eqs-theme', theme);
}

(function initTheme() {
  const saved = localStorage.getItem('eqs-theme');
  if (saved === 'light' || saved === 'dark') applyTheme(saved);
  else document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  $('#theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
})();

/* ------------------------------------------------------------------ routing */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart || '');
  return { view: parts[0] || 'overview', id: parts[1] || null, params };
}

function setRange(from, to, { push = true } = {}) {
  state.from = from;
  state.to = to;
  const { view, id } = parseHash();
  const q = new URLSearchParams({ from, to });
  if (push) history.replaceState(null, '', `#/${view}${id ? `/${id}` : ''}?${q}`);
  $('#range-from').value = from;
  $('#range-to').value = to;
  $('#range-note').textContent = `${from} ～ ${to}（${daysBetween(from, to).length} 天）`;
}

function go(view, id = null) {
  const q = new URLSearchParams({ from: state.from, to: state.to });
  location.hash = `#/${view}${id != null ? `/${id}` : ''}?${q}`;
}

async function render() {
  const { view, id, params } = parseHash();
  state.view = view;
  const meta = state.meta;
  const from = params.get('from') || state.from || meta.defaultFrom;
  const to = params.get('to') || state.to || meta.defaultTo;
  setRange(from, to, { push: false });
  $$('.tabs a').forEach((a) => {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#filterbar').hidden = !['overview', 'quality', 'settlements'].includes(view);
  // Replace the container so listeners bound by the previous view are dropped.
  const stale = $('#view');
  const viewEl = stale.cloneNode(false);
  viewEl.innerHTML = '<div class="loading">正在加载…</div>';
  stale.replaceWith(viewEl);
  hideTip();
  try {
    const html = await views[view]?.(id);
    viewEl.innerHTML = html ?? '<div class="empty">页面不存在</div>';
    bindView(view, id);
  } catch (err) {
    viewEl.innerHTML = `<div class="card"><div class="callout danger"><strong>加载失败：</strong>${esc(err.message)}</div></div>`;
  }
  // Move the viewport, not focus: a programmatic focus ring around the whole
  // page reads as an error state and a11y gains nothing here (the tab nav
  // already keeps keyboard focus in place with a visible indicator).
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------------ overview */

function settlementState(dayRow) {
  if (dayRow.settlement) return badge('sealed');
  if (dayRow.draft) return badge('draft');
  return '<span class="muted small">未结算</span>';
}

async function viewOverview() {
  const s = await api(`/api/summary?from=${state.from}&to=${state.to}`);
  const withRuns = s.days.filter((d) => d.totals);
  const categories = s.days.map((d) => d.day);

  const stacked = stackedBarChart({
    categories,
    series: [
      { key: 'valid', label: '有效', color: 'var(--good)', values: s.days.map((d) => d.totals?.valid || 0) },
      { key: 'suspect', label: '可疑', color: 'var(--warning)', values: s.days.map((d) => d.totals?.suspect || 0) },
      { key: 'invalid', label: '无效', color: 'var(--critical)', values: s.days.map((d) => d.totals?.invalid || 0) },
    ],
    unit: '条',
  });

  const sealedIdx = s.days.map((d, i) => (d.settlement ? i : -1)).filter((i) => i >= 0);
  const settlementChart = sealedIdx.length
    ? lineChart({
        categories: sealedIdx.map((i) => categories[i]),
        values: sealedIdx.map((i) => s.days[i].settlement.netSettled),
        label: '已封存净额（元）',
      })
    : null;

  const headDays = s.days.filter((d) => d.head);
  const ruleChips = s.ruleVersionsOnDays.length
    ? s.ruleVersionsOnDays.map((r) => `<span class="chip">规则 #${r.id} ${esc(r.label)}</span>`).join('')
    : '<span class="chip">窗口内暂无已提交运行</span>';

  return `
  <div class="stack">
    <div class="hero card">
      <div class="stat">
        <span class="stat-label">有效率（按事件）</span>
        <span class="hero-figure">${pct(s.qualityRate)}</span>
        <span class="stat-delta">${num(s.totals.valid)} / ${num(s.totals.events)} 条事件通过质量判定</span>
      </div>
      <div class="grid grid-3" style="flex:1;min-width:320px">
        <div class="stat"><span class="stat-label">无效事件</span><span class="stat-value sm">${num(s.totals.invalid)}</span><span class="stat-delta">占比 ${s.totals.events ? pct(s.totals.invalid / s.totals.events) : '—'}</span></div>
        <div class="stat"><span class="stat-label">可疑事件</span><span class="stat-value sm">${num(s.totals.suspect)}</span><span class="stat-delta">默认不计入结算</span></div>
        <div class="stat"><span class="stat-label">已封存净额</span><span class="stat-value sm">${money(s.settlements.sealedNet)}</span><span class="stat-delta">${s.settlements.sealedDays} 天 · 调整 ${signedMoney(s.settlements.adjustedTotal)} 元</span></div>
      </div>
    </div>

    ${s.totals.daysMissingRuns ? `<div class="callout warn"><strong>${s.totals.daysMissingRuns} 天没有已提交的判定运行。</strong>这些天在图表中显示为空缺，而不是 0 —— 没有数据不等于零事件。可在「任务队列」投递 evaluate 任务。</div>` : ''}

    <div class="row">${ruleChips}</div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><div><h3>每日判定构成</h3><p>来自各日当前头部运行的逐条判定（attribution-day 归属）</p></div><span class="chip">${num(withRuns.length)} 天有运行</span></div>
        ${stacked.html}
        ${tableTwin(stacked)}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>跨日会话</h3><p>会话整体判定，事件归属到发生日</p></div></div>
        <div class="stat"><span class="stat-label">涉及跨日会话的事件</span><span class="stat-value">${num(s.totals.crossDayEvents)}</span><span class="stat-delta">占全部事件 ${s.totals.events ? pct(s.totals.crossDayEvents / s.totals.events) : '—'}</span></div>
        <p class="section-note">跨日会话会在每个事件上留下「跨日会话」判定贡献。默认只记录、不升级为可疑；是否升级由规则版本中的 <span class="mono">cross_day.escalate_to_suspect</span> 决定。</p>
        <div class="divider"></div>
        <div class="stat"><span class="stat-label">毛额（含被排除事件）</span><span class="stat-value sm">${money(s.totals.gross)}</span><span class="stat-delta">有效金额 ${money(s.totals.validAmount)} 元</span></div>
      </div>
    </div>

    ${
      settlementChart
        ? `<div class="card"><div class="card-head"><div><h3>每日已封存净额</h3><p>封存金额 + 已批准报告的调整分录；未封存日不画点</p></div></div>${settlementChart.html}${tableTwin(settlementChart)}</div>`
        : '<div class="card"><div class="empty">窗口内没有已封存结算。到「结算」页生成草稿并封存。</div></div>'
    }

    <div class="card flush">
      <div class="card-head" style="padding:16px 18px 0"><div><h3>逐日明细</h3><p>运行、规则、判定构成与结算状态</p></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>日期</th><th>当前运行</th><th>规则</th><th class="num">事件</th><th class="num">有效</th><th class="num">无效</th><th class="num">可疑</th><th class="num">已封存</th><th class="num">调整</th><th class="num">净额</th><th>结算</th></tr></thead>
        <tbody>${s.days
          .map(
            (d) => `<tr>
          <td class="nowrap">${d.day}</td>
          <td>${d.head ? `#${d.head.run_id} <span class="muted small">seq ${d.head.sequence}</span>` : '<span class="muted small">无运行</span>'}</td>
          <td class="small">${d.head ? esc(d.head.rule_label) : '—'}</td>
          <td class="num">${d.totals ? num(d.totals.events) : '—'}</td>
          <td class="num">${d.totals ? num(d.totals.valid) : '—'}</td>
          <td class="num">${d.totals ? num(d.totals.invalid) : '—'}</td>
          <td class="num">${d.totals ? num(d.totals.suspect) : '—'}</td>
          <td class="num">${d.settlement ? money(d.settlement.settled_amount_cents) : d.draft ? `<span class="muted">${money(d.draft.settled_amount_cents)}*</span>` : '—'}</td>
          <td class="num">${d.settlement ? signedMoney(d.settlement.adjustmentTotal) : '—'}</td>
          <td class="num">${d.settlement ? `<strong>${money(d.settlement.netSettled)}</strong>` : d.draft ? `${money(d.draft.settled_amount_cents)}` : '—'}</td>
          <td>${settlementState(d)}</td>
        </tr>`,
          )
          .join('')}</tbody>
      </table></div>
      <p class="section-note" style="padding:0 18px 14px">* 草稿金额尚未封存，可被重新生成覆盖；封存金额不会因新证据改变，只会追加调整分录。</p>
    </div>
  </div>`;
}

function bindView(view) {
  if (view === 'quality') bindQuality();
  if (view === 'rules') bindRules();
  if (view === 'evidence') bindEvidence();
  if (view === 'reports') bindReports();
  if (view === 'settlements') bindSettlements();
  if (view === 'jobs') bindJobs();
}

/* ------------------------------------------------------------------ quality */

async function pickRun() {
  const runs = await api(`/api/runs?from=${state.from}&to=${state.to}`);
  return runs.runs || [];
}

async function viewQuality(id) {
  const runs = await pickRun();
  if (!runs.length) {
    return `<div class="card"><div class="callout warn"><strong>窗口内没有已提交的运行。</strong>先到「任务队列」投递 evaluate 任务，并启动判定进程消费。</div></div>`;
  }
  const runId = id && /^\d+$/.test(id) ? Number(id) : runs[runs.length - 1].run_id;
  const detail = await api(`/api/runs/${runId}`);
  const report = await api(`/api/runs/${runId}/report`);
  const excluded = await api(`/api/runs/${runId}/excluded?only=excluded&limit=60`);
  const run = detail.run;
  const t = detail.totals;

  const reasons = (report.reasons || []).map((r) => ({
    label: r.rule_label,
    value: r.events,
    note: `${money(r.amount)} 元`,
    color: r.severity === 'hard' ? 'var(--critical)' : 'var(--warning)',
  }));

  const suspectRows = excluded.rows.filter((r) => r.verdict === 'suspect');

  return `
  <div class="stack">
    <div class="card">
      <div class="row-between">
        <div>
          <div class="row"><h2>运行 #${run.id}</h2>${badge(run.status)}<span class="chip">序号 ${run.sequence}</span><span class="chip mono">${esc(run.digest?.slice(0, 12) || '—')}</span></div>
          <p class="muted small" style="margin-top:4px">规则「${esc(run.rule_label || run.rule_version_id)}」 · ${run.scope_from} ～ ${run.scope_to} · 提交于 ${timeLabel(run.committed_at)} · 归属模式 ${esc(run.attribution)}</p>
        </div>
        <div class="row">
          <label class="small muted" for="run-pick">切换运行</label>
          <select id="run-pick">${runs
            .slice()
            .reverse()
            .map((r) => `<option value="${r.run_id}"${r.run_id === runId ? ' selected' : ''}>#${r.run_id} · ${esc(r.local_day)} · seq ${r.sequence}</option>`)
            .join('')}</select>
        </div>
      </div>
      <div class="divider"></div>
      <div class="grid grid-4">
        <div class="stat"><span class="stat-label">事件</span><span class="stat-value sm">${num(t.events)}</span><span class="stat-delta">毛额 ${money(t.grossAmount)} 元</span></div>
        <div class="stat"><span class="stat-label">有效</span><span class="stat-value sm">${num(t.valid)}</span><span class="stat-delta">${t.events ? pct(t.valid / t.events) : '—'} · ${money(t.validAmount)} 元</span></div>
        <div class="stat"><span class="stat-label">无效</span><span class="stat-value sm">${num(t.invalid)}</span><span class="stat-delta">${t.events ? pct(t.invalid / t.events) : '—'}，不计入结算</span></div>
        <div class="stat"><span class="stat-label">可疑</span><span class="stat-value sm">${num(t.suspect)}</span><span class="stat-delta">${t.events ? pct(t.suspect / t.events) : '—'}，默认不计入结算</span></div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><div><h3>被排除原因（按事件数）</h3><p>每个失败检查都来自逐条判定贡献，不是聚合估计；红色为硬性检查，黄色为软性检查</p></div></div>
        ${hbarChart({ rows: reasons, unit: '条事件' })}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>按事件类型</h3><p>曝光 / 点击 / 转化 的判定分布</p></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>类型</th><th class="num">事件</th><th class="num">有效</th><th class="num">无效</th><th class="num">可疑</th></tr></thead>
          <tbody>${(report.funnel || [])
            .map(
              (f) => `<tr><td>${esc({ impression: '曝光', click: '点击', conversion: '转化' }[f.event_type] || f.event_type)}</td><td class="num">${num(f.total)}</td><td class="num">${num(f.valid)}</td><td class="num">${num(f.invalid)}</td><td class="num">${num(f.suspect)}</td></tr>`,
            )
            .join('')}</tbody>
        </table></div>
        <div class="divider"></div>
        <div class="kv small">
          <dt>跨日事件</dt><dd>${num(t.crossDayEvents)} 条（会话整体判定）</dd>
          <dt>会话数</dt><dd>${num(detail.sessions?.sessions || 0)}，其中跨日 ${num(detail.sessions?.cross_day_sessions || 0)} 个</dd>
          <dt>可复现摘要</dt><dd class="mono">${esc(run.digest || '—')}</dd>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>被排除事件</h3><p>点击任意事件查看逐条检查的观测值、比较符、阈值与证据引用</p></div><span class="chip">${num(excluded.total)} 条</span></div>
      <div class="row" style="margin-bottom:10px">
        <div class="presets" role="group" aria-label="判定筛选" id="excluded-filter">
          <button class="chip-btn" data-verdict="excluded" aria-pressed="true" type="button">全部被排除</button>
          <button class="chip-btn" data-verdict="invalid" aria-pressed="false" type="button">无效</button>
          <button class="chip-btn" data-verdict="suspect" aria-pressed="false" type="button">可疑</button>
          <button class="chip-btn" data-verdict="" aria-pressed="false" type="button">全部事件</button>
        </div>
        <span class="muted small" id="excluded-count">共 ${num(excluded.total)} 条，显示前 ${excluded.rows.length} 条</span>
      </div>
      <div id="excluded-table">${excludedTable(excluded.rows)}</div>
      ${suspectRows.length ? `<p class="section-note">可疑事件被排除在结算之外，但仍可在规则中通过 settlement.include_suspect 打开。</p>` : ''}
    </div>
  </div>`;
}

function excludedTable(rows) {
  if (!rows.length) return '<div class="empty">没有符合条件的事件</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>发生时间</th><th>事件</th><th>类型</th><th>判定</th><th>主要原因</th><th class="num">金额</th><th class="num">失败检查</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr class="clickable" data-event="${esc(r.event_id)}" tabindex="0">
        <td class="nowrap small">${timeLabel(r.occurred_at)}</td>
        <td class="mono">${esc(r.event_id)}</td>
        <td class="small">${esc({ impression: '曝光', click: '点击', conversion: '转化' }[r.event_type] || r.event_type)}</td>
        <td>${badge(r.verdict)}</td>
        <td class="small">${esc(r.primary_detail || '—')}</td>
        <td class="num">${money(r.amount_cents)}</td>
        <td class="num">${r.failures?.length || 0}</td>
      </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

let currentRunId = null;

function bindQuality() {
  const pick = $('#run-pick');
  if (pick) pick.addEventListener('change', () => go('quality', pick.value));

  const filter = $('#excluded-filter');
  const fromHash = location.hash.match(/quality\/(\d+)/);
  currentRunId = fromHash ? Number(fromHash[1]) : null;
  if (!currentRunId) {
    const opts = $('#run-pick');
    currentRunId = opts ? Number(opts.value) : null;
  }

  filter?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-verdict]');
    if (!btn) return;
    $$('#excluded-filter .chip-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    const verdict = btn.dataset.verdict;
    const target = $('#excluded-table');
    const q = verdict === 'excluded' ? 'only=excluded&' : verdict ? `verdict=${verdict}&` : '';
    target.innerHTML = '<div class="loading">加载中…</div>';
    try {
      const res = await api(`/api/runs/${currentRunId}/excluded?${q}limit=60`);
      target.innerHTML = excludedTable(res.rows);
      $('#excluded-count').textContent = `共 ${res.total} 条，显示前 ${res.rows.length} 条`;
    } catch (err) {
      target.innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
    }
  });

  $('#view').addEventListener('click', (e) => {
    const tr = e.target.closest('[data-event]');
    if (tr) openEvent(tr.dataset.event, currentRunId);
  });
  $('#view').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest('[data-event]');
    if (tr) {
      e.preventDefault();
      openEvent(tr.dataset.event, currentRunId);
    }
  });
}

/* event drawer */

async function openEvent(eventId, runId) {
  openDrawer('事件详情', '<div class="loading">加载中…</div>');
  try {
    const d = await api(`/api/events/${encodeURIComponent(eventId)}${runId ? `?run=${runId}` : ''}`);
    if (!d || !d.event) throw new Error('事件不存在');
    $('#drawer-body').innerHTML = eventDetailHtml(d);
    $('#drawer-body').addEventListener('click', (e) => {
      const row = e.target.closest('[data-session-event]');
      if (row) openEvent(row.dataset.sessionEvent, d.run?.id || runId);
    });
  } catch (err) {
    $('#drawer-body').innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
  }
}

function eventDetailHtml(d) {
  const ev = d.event;
  const dec = d.decision;
  const contribs = d.contributions || [];
  const typeLabel = { impression: '曝光', click: '点击', conversion: '转化' }[ev.event_type] || ev.event_type;
  return `
  <div class="stack" style="gap:14px">
    <div class="row">${dec ? badge(dec.verdict) : badge('draft', '未判定')}${dec?.primary_detail ? `<span class="small secondary">${esc(dec.primary_detail)}</span>` : ''}</div>
    <dl class="kv">
      <dt>事件</dt><dd class="mono">${esc(ev.event_id)}</dd>
      <dt>类型</dt><dd>${esc(typeLabel)}</dd>
      <dt>发生时间</dt><dd>${timeLabel(ev.occurred_at)} <span class="muted small">归属 ${esc(dec?.local_day || ev.local_day)}</span></dd>
      <dt>会话</dt><dd class="mono">${esc(ev.session_id)}</dd>
      <dt>设备</dt><dd class="mono">${esc(ev.device_id || '—')}</dd>
      <dt>IP</dt><dd class="mono">${esc(ev.ip || '—')}</dd>
      <dt>UA</dt><dd class="small">${esc(ev.user_agent || '—')}</dd>
      ${ev.impression_id ? `<dt>曝光引用</dt><dd class="mono">${esc(ev.impression_id)}</dd>` : ''}
      ${ev.click_id ? `<dt>点击引用</dt><dd class="mono">${esc(ev.click_id)}</dd>` : ''}
      ${ev.order_id ? `<dt>订单号</dt><dd class="mono">${esc(ev.order_id)}</dd>` : ''}
      ${ev.click_delay_ms != null ? `<dt>上报点击间隔</dt><dd>${num(ev.click_delay_ms)} ms</dd>` : ''}
      <dt>金额</dt><dd>${money(dec?.amount_cents ?? 0)} 元</dd>
      <dt>摄入序号</dt><dd>${num(ev.ingest_seq)}</dd>
    </dl>

    ${
      dec
        ? `<div>
      <div class="row-between"><h3>逐条判定贡献</h3><span class="chip">${contribs.length} 项检查</span></div>
      <p class="muted small" style="margin:4px 0 8px">每一项都是对可观测字段的比较，按检查顺序执行。失败项决定判定，可疑项在硬性检查全部通过时降级为可疑。</p>
      <ol class="contrib-list">${contribs
        .map(
          (c) => `<li class="contrib${c.outcome === 'fail' ? ' contrib-fail' : ''}">
          <div class="contrib-top">
            <span class="contrib-num">${c.check_order}</span>
            <span class="contrib-label">${esc(c.rule_label)}</span>
            ${c.severity === 'hard' ? '<span class="badge badge-hard">硬</span>' : c.severity === 'soft' ? '<span class="badge badge-soft">软</span>' : ''}
            <span class="chip chip-plain">${esc({ event: '事件', session: '会话', evidence: '证据' }[c.scope] || c.scope)}</span>
            ${badge(c.outcome)}
          </div>
          <dl class="contrib-facts">
            <dt>观测值</dt><dd>${esc(c.observed ?? '—')}</dd>
            <dt>比较</dt><dd>${esc(c.comparator ?? '—')}</dd>
            <dt>阈值</dt><dd>${esc(c.threshold ?? '—')}</dd>
          </dl>
          ${c.detail ? `<p class="contrib-detail">${esc(c.detail)}${c.evidence_ref ? ` <span class="badge badge-info">${esc(c.evidence_ref)}</span>` : ''}</p>` : c.evidence_ref ? `<p class="contrib-detail"><span class="badge badge-info">${esc(c.evidence_ref)}</span></p>` : ''}
        </li>`,
        )
        .join('')}</ol>
    </div>`
        : ''
    }

    ${
      dec?.session_id
        ? `<div>
      <div class="row-between"><h3>同会话事件</h3><span class="chip">${d.session.length} 条${dec.session_cross_day ? ' · 跨日' : ''}</span></div>
      <p class="muted small" style="margin:4px 0 8px">会话起始日 ${esc(dec.session_start_day)}，归属日 ${esc((JSON.parse(dec.session_days_json || '[]') || []).join(' / '))}。会话整体判定：跨日事件共享同一份会话上下文。</p>
      <div class="table-wrap"><table>
        <thead><tr><th>时间</th><th>事件</th><th>类型</th><th>判定</th><th>理由</th><th class="num">金额</th></tr></thead>
        <tbody>${d.session
          .map(
            (x) => `<tr class="clickable${x.event_id === ev.event_id ? ' selected' : ''}" data-session-event="${esc(x.event_id)}" tabindex="0">
            <td class="nowrap small">${timeLabel(x.occurred_at)}</td>
            <td class="mono">${esc(x.event_id)}</td>
            <td class="small">${esc({ impression: '曝光', click: '点击', conversion: '转化' }[x.event_type] || x.event_type)}</td>
            <td>${badge(x.verdict)}</td>
            <td class="small">${esc(x.primary_detail || '—')}</td>
            <td class="num">${money(x.amount_cents)}</td>
          </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </div>`
        : ''
    }

    ${
      (d.history || []).length
        ? `<div>
      <h3>判定历史</h3>
      <p class="muted small" style="margin:4px 0 8px">同一事件在不同运行中的判定，按入队序号从新到旧。封存的结算以当时提交的判定为基础，不会被这里的更新静默改写。</p>
      <div class="timeline">${d.history
        .map(
          (h) => `<div class="timeline-item"><div class="timeline-rail"><span class="timeline-dot"></span></div>
          <div class="timeline-body">
            <div class="row">${badge(h.verdict)}<span class="small">运行 #${h.run_id} · seq ${h.sequence} · ${esc(h.rule_label)}</span>${h.status === 'superseded' ? badge('superseded') : ''}</div>
            <div class="t">${esc(h.primary_detail || '—')} · ${timeLabel(h.decided_at)}</div>
          </div></div>`,
        )
        .join('')}</div>
    </div>`
        : ''
    }
  </div>`;
}

/* ------------------------------------------------------------------ rules */

let ruleDraft = null;

async function viewRules(id) {
  const res = await api('/api/rules');
  const versions = res.versions || [];
  state.rules = versions;
  const published = versions.filter((v) => v.status === 'published');
  const current = (id && versions.find((v) => String(v.id) === String(id))) || published[0] || versions[0];
  ruleDraft = JSON.parse(JSON.stringify(current?.rules || state.meta.defaultRules));

  return `
  <div class="split">
    <div class="stack">
      <div class="card">
        <div class="card-head"><div><h3>规则版本</h3><p>发布后的规则不可修改；调整需要新建版本。版本内容以摘要寻址，重复创建会复用同一版本。</p></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>名称</th><th>状态</th><th>摘要</th><th>创建</th><th></th></tr></thead>
          <tbody>${versions
            .map(
              (v) => `<tr>
            <td class="num">${v.id}</td>
            <td>${esc(v.label)}${v.slug ? `<div class="muted small mono">${esc(v.slug)}</div>` : ''}</td>
            <td>${badge(v.status)}</td>
            <td class="mono small">${esc(v.digest.slice(0, 10))}</td>
            <td class="small">${dateOnly(v.created_at)}<div class="muted small">${esc(v.created_by || '')}</div></td>
            <td class="nowrap">
              <button class="btn btn-sm" data-load-rule="${v.id}" type="button">载入</button>
              ${v.status === 'draft' ? `<button class="btn btn-sm btn-primary" data-publish="${v.id}" type="button">发布</button>` : ''}
              ${v.status === 'published' ? `<button class="btn btn-sm" data-retire="${v.id}" type="button">退役</button>` : ''}
            </td>
          </tr>`,
            )
            .join('')}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>检查项目录</h3><p>每个检查都输出「观测值 / 比较符 / 阈值」，没有黑箱打分</p></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>检查</th><th>标识</th><th>严重性</th></tr></thead>
          <tbody>${(res.catalog || [])
            .map((c) => `<tr><td>${esc(c.label)}</td><td class="mono small">${esc(c.id)}</td><td>${severityBadge(c.severity)}</td></tr>`)
            .join('')}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>跨日与会话策略</h3><p>规则版本的一部分，随版本一起冻结</p></div></div>
        <div class="small secondary stack" style="gap:8px">
          <p><strong>会话整体判定：</strong>目标日的每个事件都会拿到同会话在回溯窗口内的全部事件，作为点击归因、密度与间隔检查的上下文。跨日会话不会被切成两半分别判定。</p>
          <p><strong>归属模式：</strong><span class="mono">attribution-day</span> 把事件记在自己发生的自然日；<span class="mono">session-day</span> 把整个会话的事件记到会话起始日，因此某天的运行可能判定发生在之后的事件。</p>
          <p><strong>跨日贡献：</strong>跨日会话在每个事件上都会产生一条「跨日会话」贡献。默认只记录（note），打开 <span class="mono">escalate_to_suspect</span> 后升级为可疑，进入可疑池而不直接判无效。</p>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>编辑 / 新建版本</h3><p id="rule-base">基于「${esc(current?.label || '默认规则')}」</p></div>${current ? badge(current.status) : ''}</div>
      <div class="stack" style="gap:12px">
        <div class="field"><label for="rule-label">版本名称</label><input id="rule-label" type="text" value="${esc((current?.label || '新规则') + ' 副本')}" /></div>
        <div class="field"><label for="rule-notes">说明</label><input id="rule-notes" type="text" placeholder="例如：提高点击间隔下限，启用 IDC 前缀" /></div>
        <div id="rule-form"></div>
        <div class="row">
          <button class="btn" id="rule-validate" type="button">校验</button>
          <button class="btn" id="rule-save" type="button">保存为草稿</button>
          <button class="btn btn-primary" id="rule-save-publish" type="button">保存并发布</button>
        </div>
        <div id="rule-result"></div>
        <details><summary>查看规则 JSON（可直接编辑）</summary>
          <textarea id="rule-json" class="codeblock" style="width:100%;min-height:240px;margin-top:8px" spellcheck="false"></textarea>
          <button class="btn btn-sm" id="rule-json-apply" type="button" style="margin-top:6px">应用 JSON</button>
        </details>
      </div>
    </div>
  </div>`;
}

function ruleFormHtml(r) {
  const h = r.hard_checks;
  const s = r.soft_checks;
  const f = (path, label, value, type = 'number', extra = '') =>
    `<div class="field"><label for="rf-${path}">${esc(label)}</label><input id="rf-${path}" data-rule-path="${path}" type="${type}" value="${esc(value)}" ${extra} /></div>`;
  const chk = (path, label) =>
    `<label class="check-row"><input type="checkbox" data-rule-path="${path}" ${r[path.split('.')[0]]?.[path.split('.')[1]] ? 'checked' : ''} />${esc(label)}</label>`;
  const nested = (path) => path.split('.').reduce((o, k) => o?.[k], r);
  const chk2 = (path, label) => `<label class="check-row"><input type="checkbox" data-rule-path="${path}" ${nested(path) ? 'checked' : ''} />${esc(label)}</label>`;
  return `
  <div class="stack" style="gap:12px">
    <div class="field">
      <label for="rf-lookback">会话回溯天数</label>
      <input id="rf-lookback" data-rule-path="lookback_days" type="number" min="0" max="30" value="${esc(r.lookback_days)}" />
      <span class="hint">跨日会话向前回溯的上限；超出部分会在判定中标记为截断。</span>
    </div>

    <fieldset><legend>点击间隔</legend>
      <div class="stack" style="gap:8px">
        ${chk2('hard_checks.click_delay.enabled', '启用点击间隔检查')}
        <div class="grid grid-3">
          ${f('hard_checks.click_delay.min_ms', '下限 (ms)', h.click_delay.min_ms)}
          ${f('hard_checks.click_delay.max_ms', '上限 (ms)', h.click_delay.max_ms)}
          <div class="field"><label for="rf-faster">低于下限时</label><select id="rf-faster" data-rule-path="hard_checks.click_delay.treat_faster_than_min_as">
            <option value="invalid"${h.click_delay.treat_faster_than_min_as === 'invalid' ? ' selected' : ''}>判无效</option>
            <option value="suspect"${h.click_delay.treat_faster_than_min_as === 'suspect' ? ' selected' : ''}>判可疑</option>
          </select></div>
        </div>
      </div>
    </fieldset>

    <fieldset><legend>转化窗口</legend>
      <div class="stack" style="gap:8px">
        ${chk2('hard_checks.conversion_delay.enabled', '启用转化延迟检查')}
        <div class="grid grid-2">
          ${f('hard_checks.conversion_delay.max_hours', '归因窗口 (小时)', h.conversion_delay.max_hours)}
          <div class="field"><label for="rf-orphan">缺少点击时</label><select id="rf-orphan" data-rule-path="hard_checks.conversion_delay.orphan_click_policy">
            <option value="invalid"${h.conversion_delay.orphan_click_policy === 'invalid' ? ' selected' : ''}>判无效</option>
            <option value="suspect"${h.conversion_delay.orphan_click_policy === 'suspect' ? ' selected' : ''}>判可疑</option>
          </select></div>
        </div>
      </div>
    </fieldset>

    <fieldset><legend>标识与证据</legend>
      <div class="stack" style="gap:8px">
        ${chk2('hard_checks.bot_ua.enabled', '启用 UA 自动化特征')}
        ${f('hard_checks.bot_ua.tokens', 'UA 特征（逗号分隔）', h.bot_ua.tokens.join(', '), 'text')}
        ${chk2('hard_checks.datacenter_ip.enabled', '启用数据中心 IP 前缀')}
        ${f('hard_checks.datacenter_ip.prefixes', 'IP 前缀（逗号分隔）', (h.datacenter_ip.prefixes || []).join(', '), 'text')}
        ${chk2('hard_checks.device_flag.enabled', '启用设备标记证据')}
        ${chk2('hard_checks.order_reversed.enabled', '启用订单撤销证据')}
        ${chk2('hard_checks.duplicate_order.enabled', '启用重复订单检查')}
      </div>
    </fieldset>

    <fieldset><legend>会话软性检查</legend>
      <div class="stack" style="gap:8px">
        ${chk2('soft_checks.high_velocity.enabled', '启用事件密度检查')}
        ${f('soft_checks.high_velocity.events_per_minute', '事件密度上限（条/分钟）', s.high_velocity.events_per_minute)}
        ${chk2('soft_checks.regular_interval.enabled', '启用间隔均匀度检查')}
        <div class="grid grid-2">
          ${f('soft_checks.regular_interval.cv_threshold', '变异系数阈值', s.regular_interval.cv_threshold, 'number', 'step="0.01" min="0.01" max="0.99"')}
          ${f('soft_checks.regular_interval.min_events', '最少事件数', s.regular_interval.min_events, 'number', 'min="3"')}
        </div>
      </div>
    </fieldset>

    <fieldset><legend>跨日会话</legend>
      <div class="stack" style="gap:8px">
        ${chk2('soft_checks.cross_day_session.enabled', '记录跨日会话贡献')}
        <div class="field"><label for="rf-attribution">归属模式</label><select id="rf-attribution" data-rule-path="cross_day.attribution">
          <option value="attribution-day"${r.cross_day.attribution === 'attribution-day' ? ' selected' : ''}>attribution-day（记在发生日）</option>
          <option value="session-day"${r.cross_day.attribution === 'session-day' ? ' selected' : ''}>session-day（记在会话起始日）</option>
        </select></div>
        ${chk2('cross_day.escalate_to_suspect', '跨日会话升级为可疑')}
      </div>
    </fieldset>

    <fieldset><legend>结算参数</legend>
      <div class="stack" style="gap:8px">
        <div class="grid grid-2">
          ${f('settlement.payout_per_valid_click_cents', '有效点击单价（分）', r.settlement.payout_per_valid_click_cents)}
          ${f('settlement.payout_per_valid_conversion_ratio', '转化分成比例', r.settlement.payout_per_valid_conversion_ratio, 'number', 'step="0.01" min="0"')}
        </div>
        ${chk2('settlement.include_suspect', '可疑事件计入结算')}
      </div>
    </fieldset>
  </div>`;
}

function syncRuleJson() {
  const ta = $('#rule-json');
  if (ta) ta.value = JSON.stringify(ruleDraft, null, 2);
}

function setRulePath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    cur[keys[i]] ??= {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function bindRules() {
  const form = $('#rule-form');
  if (!form) return;
  form.innerHTML = ruleFormHtml(ruleDraft);
  syncRuleJson();

  form.addEventListener('input', (e) => {
    const el = e.target.closest('[data-rule-path]');
    if (!el) return;
    const path = el.dataset.rulePath;
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'number') value = el.value === '' ? 0 : Number(el.value);
    else value = el.value;
    if (path === 'hard_checks.bot_ua.tokens' || path === 'hard_checks.datacenter_ip.prefixes') {
      value = el.value.split(',').map((t) => t.trim()).filter(Boolean);
    }
    const label = $('#rule-label')?.value;
    if (label) ruleDraft.version_label = label;
    setRulePath(ruleDraft, path, value);
    syncRuleJson();
  });

  $('#rule-label').addEventListener('input', (e) => {
    ruleDraft.version_label = e.target.value;
    syncRuleJson();
  });

  $('#rule-json-apply').addEventListener('click', () => {
    try {
      const parsed = JSON.parse($('#rule-json').value);
      ruleDraft = parsed;
      form.innerHTML = ruleFormHtml(ruleDraft);
      syncRuleJson();
      $('#rule-result').innerHTML = '<div class="callout">已应用 JSON，记得校验后再保存。</div>';
    } catch (err) {
      $('#rule-result').innerHTML = `<div class="callout danger">JSON 解析失败：${esc(err.message)}</div>`;
    }
  });

  $('#rule-validate').addEventListener('click', async () => {
    const out = $('#rule-result');
    out.innerHTML = '<div class="loading">校验中…</div>';
    try {
      const res = await api('/api/rules/validate', { method: 'POST', body: { rules: ruleDraft } });
      out.innerHTML = res.valid
        ? `<div class="callout"><strong>校验通过。</strong>摘要 ${esc((await digestOfClient(ruleDraft)).slice(0, 12))}（服务端保存时会再次计算）</div>`
        : `<div class="callout danger"><strong>校验未通过：</strong>${res.problems.map(esc).join('；')}</div>`;
    } catch (err) {
      out.innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
    }
  });

  const save = async (publish) => {
    const out = $('#rule-result');
    const label = $('#rule-label').value.trim();
    if (!label) {
      toast('规则版本必须有名称', true);
      return;
    }
    out.innerHTML = '<div class="loading">保存中…</div>';
    try {
      const created = await api('/api/rules', {
        method: 'POST',
        body: { label, notes: $('#rule-notes').value || null, rules: { ...ruleDraft, version_label: label } },
      });
      if (publish) {
        await api(`/api/rules/${created.id}/publish`, { method: 'POST', body: {} });
        toast(`规则 #${created.id}「${label}」已发布`);
      } else {
        toast(`规则 #${created.id}「${label}」已保存为草稿`);
      }
      await render();
    } catch (err) {
      out.innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
      toast(err.message, true);
    }
  };

  $('#rule-save').addEventListener('click', () => save(false));
  $('#rule-save-publish').addEventListener('click', () => save(true));

  $('#view').addEventListener('click', async (e) => {
    const load = e.target.closest('[data-load-rule]');
    const pub = e.target.closest('[data-publish]');
    const ret = e.target.closest('[data-retire]');
    try {
      if (load) {
        go('rules', load.dataset.loadRule);
      } else if (pub) {
        await api(`/api/rules/${pub.dataset.publish}/publish`, { method: 'POST', body: {} });
        toast('规则版本已发布');
        await render();
      } else if (ret) {
        await api(`/api/rules/${ret.dataset.retire}/retire`, { method: 'POST', body: {} });
        toast('规则版本已退役');
        await render();
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function digestOfClient(obj) {
  const data = new TextEncoder().encode(canonical(obj));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(',')}}`;
}

/* ------------------------------------------------------------------ evidence */

async function viewEvidence() {
  const res = await api('/api/evidence');
  const rows = res.rows || [];
  const kinds = state.meta.evidenceKinds;
  const today = state.meta.today;
  return `
  <div class="split">
    <div class="card flush">
      <div class="card-head" style="padding:16px 18px 0"><div><h3>证据台账</h3><p>追加式、按生效时间区间匹配；新证据不会修改旧记录</p></div><span class="chip">${rows.length} 条</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>类型</th><th>键</th><th>名称</th><th>生效区间</th><th>来源</th><th>记录人</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>
          <td class="num">${r.id}</td>
          <td class="small">${esc(kinds.find((k) => k.key === r.kind)?.label || r.kind)}</td>
          <td class="mono small">${esc(r.key)}</td>
          <td>${esc(r.label)}${r.note ? `<div class="muted small">${esc(r.note)}</div>` : ''}</td>
          <td class="small nowrap">${timeLabel(r.effective_from)}<br /><span class="muted">${r.effective_to ? timeLabel(r.effective_to) : '长期有效'}</span></td>
          <td class="small">${esc(r.source)}</td>
          <td class="small">${esc(r.added_by)}<div class="muted small">${timeLabel(r.added_at)}</div></td>
        </tr>`,
          )
          .join('') || '<tr><td colspan="7" class="empty">还没有证据</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>补录证据</h3><p>只追加，不修改历史；生效时间决定哪些日期的判定会看到它</p></div></div>
      <form class="stack" id="evidence-form" style="gap:12px">
        <div class="field"><label for="ev-kind">类型</label><select id="ev-kind" name="kind">${kinds
          .map((k) => `<option value="${esc(k.key)}">${esc(k.label)}</option>`)
          .join('')}</select></div>
        <div class="field"><label for="ev-key" id="ev-key-label">键</label><input id="ev-key" name="key" type="text" required placeholder="${esc(kinds[0]?.keyLabel || '')}" /></div>
        <div class="field"><label for="ev-label">名称</label><input id="ev-label" name="label" type="text" required placeholder="例如：设备农场标记 2026-11" /></div>
        <div class="grid grid-2">
          <div class="field"><label for="ev-from">生效时间</label><input id="ev-from" name="effectiveFrom" type="datetime-local" value="${today}T00:00" required /></div>
          <div class="field"><label for="ev-to">失效时间（可选）</label><input id="ev-to" name="effectiveTo" type="datetime-local" /></div>
        </div>
        <div class="field"><label for="ev-source">来源</label><input id="ev-source" name="source" type="text" required placeholder="例如：fraud-vendor:batch-42" /></div>
        <div class="field"><label for="ev-note">备注</label><textarea id="ev-note" name="note" rows="2"></textarea></div>
        <div id="ev-result"></div>
        <button class="btn btn-primary" type="submit">写入证据</button>
      </form>
    </div>
  </div>`;
}

function bindEvidence() {
  const form = $('#evidence-form');
  if (!form) return;
  const kindSel = $('#ev-kind');
  kindSel.addEventListener('change', () => {
    const k = state.meta.evidenceKinds.find((x) => x.key === kindSel.value);
    $('#ev-key-label').textContent = k?.keyLabel || '键';
    $('#ev-key').placeholder = k?.keyLabel || '';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const body = {
      kind: data.get('kind'),
      key: data.get('key'),
      label: data.get('label'),
      effectiveFrom: new Date(data.get('effectiveFrom')).toISOString(),
      effectiveTo: data.get('effectiveTo') ? new Date(data.get('effectiveTo')).toISOString() : null,
      source: data.get('source'),
      note: data.get('note') || null,
    };
    $('#ev-result').innerHTML = '';
    try {
      const row = await api('/api/evidence', { method: 'POST', body });
      toast(`证据 #${row.id} 已写入。重建判定后才能看到它的影响。`);
      await render();
    } catch (err) {
      $('#ev-result').innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
    }
  });
}

/* ------------------------------------------------------------------ reports */

async function viewReports(id) {
  const list = await api('/api/reports');
  const reports = list.reports || [];
  if (!reports.length) {
    return `<div class="card"><div class="callout"><strong>还没有差异报告。</strong>在「任务队列」投递 compare（同一快照对比两个规则）或 correction（对照已提交判定与最新证据）任务，由判定进程生成。</div></div>`;
  }
  const current = id ? reports.find((r) => String(r.id) === String(id)) : reports[0];
  return `
  <div class="stack">
    <div class="card">
      <div class="row-between">
        <div><h3>差异报告</h3><p class="muted small" style="margin-top:2px">比较方向固定：基线为已付/旧规则，候选为新规则或补证后的重算。</p></div>
        <div class="row"><label class="small muted" for="report-pick">查看报告</label>
          <select id="report-pick">${reports
            .map((r) => `<option value="${r.id}"${r.id === current.id ? ' selected' : ''}>#${r.id} ${esc(r.kind === 'correction' ? '更正' : '规则对比')} · ${esc(r.scope_from)}~${esc(r.scope_to)} · ${esc(statusLabel(r.status))}</option>`)
            .join('')}</select></div>
      </div>
      <div class="table-wrap" style="margin-top:12px"><table>
        <thead><tr><th>#</th><th>类型</th><th>范围</th><th>状态</th><th class="num">变化事件</th><th class="num">金额差</th><th>生成</th></tr></thead>
        <tbody>${reports
          .map(
            (r) => `<tr class="clickable${r.id === current.id ? ' selected' : ''}" data-report="${r.id}" tabindex="0">
          <td class="num">${r.id}</td>
          <td>${r.kind === 'correction' ? '证据更正' : '规则对比'}</td>
          <td class="small">${esc(r.scope_from)} ～ ${esc(r.scope_to)}</td>
          <td>${badge(r.status)}</td>
          <td class="num">${num(r.summary?.totals?.changedEvents)}</td>
          <td class="num">${signedMoney(r.summary?.totals?.deltaAmount || 0)}</td>
          <td class="small">${timeLabel(r.created_at)}<div class="muted small">${esc(r.created_by || '')}</div></td>
        </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </div>
    ${await reportDetail(current.id)}
  </div>`;
}

async function reportDetail(reportId) {
  const r = await api(`/api/reports/${reportId}`);
  const totals = r.summary?.totals || {};
  const days = r.days || [];
  const sealedDays = days.filter((d) => d.sealed);
  const unsealedChanged = days.filter((d) => !d.sealed && (d.changed_events > 0 || d.new_amount_cents !== d.old_amount_cents));
  const reasons = r.reasons || [];

  const grouped = groupedBarChart({
    categories: days.map((d) => d.local_day),
    series: [
      { label: '基线金额', color: 'var(--series-1)', values: days.map((d) => d.old_amount_cents) },
      { label: '候选金额', color: 'var(--series-2)', values: days.map((d) => d.new_amount_cents) },
    ],
    cents: true,
  });

  return `
  <div class="stack">
    <div class="card">
      <div class="row"><h2>报告 #${r.id}</h2>${badge(r.status)}<span class="chip">${r.kind === 'correction' ? '证据更正' : '规则对比'}</span><span class="chip mono">${esc(r.digest.slice(0, 12))}</span></div>
      <p class="secondary" style="margin-top:4px">${esc(r.title)}</p>
      <p class="muted small">基线：${esc(r.summary?.baseline?.label || '已提交判定')} · 候选：${esc(r.summary?.candidate?.label || '—')} · 范围 ${r.scope_from} ～ ${r.scope_to} · ${timeLabel(r.created_at)} · ${esc(r.created_by || '')}</p>
      <div class="divider"></div>
      <div class="grid grid-4">
        <div class="stat"><span class="stat-label">变化事件</span><span class="stat-value sm">${num(totals.changedEvents)}</span><span class="stat-delta">共 ${num(totals.new?.events ?? r.eventCount)} 条</span></div>
        <div class="stat"><span class="stat-label">金额差</span><span class="stat-value sm">${signedMoney(totals.deltaAmount || 0)}</span><span class="stat-delta">基线 ${money(totals.old?.amount)} → 候选 ${money(totals.new?.amount)}</span></div>
        <div class="stat"><span class="stat-label">有效变化</span><span class="stat-value sm">${totals.deltaValid > 0 ? '+' : ''}${num(totals.deltaValid)}</span><span class="stat-delta">无效 ${totals.deltaInvalid > 0 ? '+' : ''}${num(totals.deltaInvalid)} · 可疑 ${totals.deltaSuspect > 0 ? '+' : ''}${num(totals.deltaSuspect)}</span></div>
        <div class="stat"><span class="stat-label">涉及封存</span><span class="stat-value sm">${sealedDays.length} 天</span><span class="stat-delta">${unsealedChanged.length} 天未封存将重算</span></div>
      </div>
      <div class="callout" style="margin-top:14px">${
        sealedDays.length
          ? `<strong>批准后，封存日只追加调整分录。</strong>${sealedDays.map((d) => d.local_day).join('、')} 的封存金额保持不变，净额 = 封存金额 + 调整。${unsealedChanged.length ? `未封存的 ${unsealedChanged.map((d) => d.local_day).join('、')} 会丢弃旧草稿并标记重算。` : ''}`
          : '<strong>本次差异不涉及已封存日。</strong>批准后只会丢弃受影响的草稿结算，等待重算，不改动任何封存数字。'
      }</div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><div><h3>逐日金额对比</h3><p>同一冻结快照下的基线 vs 候选</p></div></div>
        ${grouped.html}
        ${tableTwin(grouped)}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>变化原因</h3><p>按候选侧的主因归类，金额为候选减基线</p></div></div>
        ${hbarChart({
          rows: reasons.map((x) => ({
            label: `${DIRECTION_LABELS[x.direction] || x.direction} · ${x.rule_label}`,
            value: x.events,
            note: `${signedMoney(x.delta_amount_cents)} 元`,
          })),
          unit: '条事件',
        })}
      </div>
    </div>

    <div class="card flush">
      <div class="card-head" style="padding:16px 18px 0"><div><h3>逐日差异</h3><p>封存日与未封存日的处理方式不同</p></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>日期</th><th>结算状态</th><th class="num">基线有效</th><th class="num">候选有效</th><th class="num">基线无效</th><th class="num">候选无效</th><th class="num">基线金额</th><th class="num">候选金额</th><th class="num">金额差</th><th class="num">变化事件</th></tr></thead>
        <tbody>${days
          .map(
            (d) => `<tr>
          <td class="nowrap">${d.local_day}</td>
          <td>${d.sealed ? badge('sealed') : '<span class="muted small">未封存</span>'}${d.adjustment_applied ? ' <span class="badge badge-info">已调整</span>' : ''}</td>
          <td class="num">${num(d.old_valid)}</td><td class="num">${num(d.new_valid)}</td>
          <td class="num">${num(d.old_invalid)}</td><td class="num">${num(d.new_invalid)}</td>
          <td class="num">${money(d.old_amount_cents)}</td><td class="num">${money(d.new_amount_cents)}</td>
          <td class="num">${signedMoney(d.new_amount_cents - d.old_amount_cents)}</td>
          <td class="num">${num(d.changed_events)}</td>
        </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>变化事件</h3><p>按金额影响排序，点击查看当前判定与逐条检查</p></div><span class="chip">${num(r.eventCount)} 条</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>日期</th><th>事件</th><th>基线判定</th><th>候选判定</th><th>基线理由</th><th>候选理由</th><th class="num">金额差</th></tr></thead>
        <tbody>${(r.events || r.sampleEvents || [])
          .slice(0, 60)
          .map(
            (e) => `<tr class="clickable" data-event="${esc(e.event_id)}" tabindex="0">
          <td class="nowrap small">${e.local_day}</td>
          <td class="mono small">${esc(e.event_id)}</td>
          <td>${badge(e.old_verdict)}</td>
          <td>${badge(e.new_verdict)}</td>
          <td class="small">${esc(e.old_reason || '—')}</td>
          <td class="small">${esc(e.new_reason || '—')}</td>
          <td class="num">${signedMoney(e.delta_amount_cents)}</td>
        </tr>`,
          )
          .join('')}</tbody>
      </table></div>
      ${r.eventCount > 60 ? `<p class="section-note">仅显示金额影响最大的 60 条，共 ${num(r.eventCount)} 条。</p>` : ''}
    </div>

    ${
      r.status === 'draft'
        ? `<div class="card">
      <div class="card-head"><div><h3>审核</h3><p>批准是唯一产生调整分录的动作；驳回后报告冻结为已驳回</p></div></div>
      <div class="stack" style="gap:12px">
        <div class="field"><label for="review-note">审核备注</label><textarea id="review-note" rows="2" placeholder="例如：已核对设备标记来源"></textarea></div>
        <label class="check-row"><input type="checkbox" id="apply-adjustments" checked /> 批准时写入结算调整分录（封存日）</label>
        <label class="check-row"><input type="checkbox" id="review-confirm" /> 我已核对差异明细，理解封存金额不会改变</label>
        <div class="row">
          <button class="btn btn-primary" id="report-approve" type="button" disabled>批准报告</button>
          <button class="btn btn-danger" id="report-reject" type="button">驳回</button>
        </div>
        <div id="review-result"></div>
      </div>
    </div>`
        : `<div class="card"><div class="row-between"><div><h3>审核结果</h3><p class="muted small">${r.status === 'approved' ? '已批准' : '已驳回'} · ${timeLabel(r.reviewed_at)} · ${esc(r.reviewed_by || '')}</p></div>${badge(r.status)}</div>${r.review_note ? `<p class="small" style="margin-top:8px">备注：${esc(r.review_note)}</p>` : ''}</div>`
    }
  </div>`;
}

function bindReports() {
  $('#report-pick')?.addEventListener('change', (e) => go('reports', e.target.value));
  $('#view').addEventListener('click', (e) => {
    const row = e.target.closest('[data-report]');
    if (row) go('reports', row.dataset.report);
  });

  const confirm = $('#review-confirm');
  if (confirm) {
    confirm.addEventListener('change', () => {
      $('#report-approve').disabled = !confirm.checked;
    });
  }

  $('#report-approve')?.addEventListener('click', async () => {
    const id = Number(location.hash.match(/reports\/(\d+)/)?.[1]);
    if (!id) return;
    const out = $('#review-result');
    out.innerHTML = '<div class="loading">批准中…</div>';
    try {
      const res = await api(`/api/reports/${id}/approve`, {
        method: 'POST',
        body: { note: $('#review-note').value || null, applyAdjustments: $('#apply-adjustments').checked },
      });
      const applied = res.applied?.length || 0;
      const restate = res.restate?.length || 0;
      out.innerHTML = `<div class="callout"><strong>已批准。</strong>写入 ${applied} 条调整分录${restate ? `；${restate} 天未封存草稿被丢弃、等待重算` : ''}。</div>`;
      toast(`报告 #${id} 已批准：${applied} 条调整，${restate} 天待重算`);
    } catch (err) {
      out.innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
      toast(err.message, true);
    }
  });

  $('#report-reject')?.addEventListener('click', async () => {
    const id = Number(location.hash.match(/reports\/(\d+)/)?.[1]);
    if (!id) return;
    const out = $('#review-result');
    out.innerHTML = '<div class="loading">驳回中…</div>';
    try {
      await api(`/api/reports/${id}/reject`, { method: 'POST', body: { note: $('#review-note').value || null } });
      toast(`报告 #${id} 已驳回`);
      await render();
    } catch (err) {
      out.innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
      toast(err.message, true);
    }
  });

  $('#view').addEventListener('click', (e) => {
    const tr = e.target.closest('[data-event]');
    if (tr && e.target.closest('[data-report]') === null) openEvent(tr.dataset.event, null);
  });
}

/* ------------------------------------------------------------------ settlements */

async function viewSettlements() {
  const res = await api(`/api/settlements?from=${state.from}&to=${state.to}`);
  const days = res.day || [];
  const sealedTotal = days.reduce((a, d) => a + (d.sealed ? d.sealed.settled_amount_cents : 0), 0);
  const adjTotal = days.reduce((a, d) => a + (d.adjustmentTotal || 0), 0);
  return `
  <div class="stack">
    <div class="card">
      <div class="row-between">
        <div><h3>结算总览</h3><p class="muted small" style="margin-top:2px">封存金额不可改写；证据补录或规则变化只能通过批准的报告追加调整分录。</p></div>
        <div class="row"><span class="chip">封存 ${money(sealedTotal)} 元</span><span class="chip">调整 ${signedMoney(adjTotal)} 元</span><span class="chip">净额 ${money(sealedTotal + adjTotal)} 元</span></div>
      </div>
    </div>
    <div class="card flush">
      <div class="table-wrap"><table>
        <thead><tr><th>日期</th><th>状态</th><th>依据运行</th><th class="num">事件</th><th class="num">有效</th><th class="num">无效</th><th class="num">可疑</th><th class="num">毛额</th><th class="num">封存 / 草稿</th><th class="num">调整</th><th class="num">净额</th><th>操作</th></tr></thead>
        <tbody>${days
          .map((d) => {
            const s = d.sealed;
            const dr = d.draft;
            const base = s || dr;
            return `<tr>
          <td class="nowrap">${d.day}</td>
          <td>${s ? badge('sealed') : dr ? badge('draft') : '<span class="muted small">未结算</span>'}</td>
          <td class="small">${base ? `#${base.basis_run_id} <span class="muted">seq ${base.basis_sequence}</span>` : '—'}</td>
          <td class="num">${base ? num(base.event_count) : '—'}</td>
          <td class="num">${base ? num(base.valid_count) : '—'}</td>
          <td class="num">${base ? num(base.invalid_count) : '—'}</td>
          <td class="num">${base ? num(base.suspect_count) : '—'}</td>
          <td class="num">${base ? money(base.gross_amount_cents) : '—'}</td>
          <td class="num">${base ? money(base.settled_amount_cents) : '—'}</td>
          <td class="num">${s ? signedMoney(d.adjustmentTotal || 0) : '—'}</td>
          <td class="num">${s ? `<strong>${money(d.netSettled)}</strong>` : dr ? money(dr.settled_amount_cents) : '—'}</td>
          <td class="nowrap">
            ${!s && !dr ? `<button class="btn btn-sm" data-draft="${d.day}" type="button">生成草稿</button>` : ''}
            ${dr ? `<button class="btn btn-sm btn-primary" data-seal="${d.day}" type="button">封存</button> <button class="btn btn-sm" data-draft="${d.day}" type="button">重新生成</button>` : ''}
            ${s ? `<button class="btn btn-sm" data-adjustments="${d.day}" type="button">调整分录 (${(d.adjustments || []).length})</button>` : ''}
          </td>
        </tr>`;
          })
          .join('')}</tbody>
      </table></div>
    </div>
    <div class="callout">封存前会核对草稿依据的运行仍是该日当前头。若判定已被更新结果替代，封存会被拒绝并提示重新生成草稿 —— 这样封存的数字始终对应一次可复现的运行。</div>
  </div>`;
}

function bindSettlements() {
  $('#view').addEventListener('click', async (e) => {
    const draft = e.target.closest('[data-draft]');
    const seal = e.target.closest('[data-seal]');
    const adj = e.target.closest('[data-adjustments]');
    try {
      if (draft) {
        await api('/api/settlements/draft', { method: 'POST', body: { day: draft.dataset.draft } });
        toast(`${draft.dataset.draft} 结算草稿已生成`);
        await render();
      } else if (seal) {
        await api('/api/settlements/seal', { method: 'POST', body: { day: seal.dataset.seal } });
        toast(`${seal.dataset.seal} 已封存`);
        await render();
      } else if (adj) {
        showAdjustments(adj.dataset.adjustments);
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function showAdjustments(day) {
  openDrawer(`${day} 调整分录`, '<div class="loading">加载中…</div>');
  try {
    const d = await api(`/api/settlements/${day}`);
    const rows = d.adjustments || [];
    $('#drawer-body').innerHTML = `
      <dl class="kv">
        <dt>封存金额</dt><dd>${money(d.sealed?.settled_amount_cents)} 元（运行 #${d.sealed?.basis_run_id}）</dd>
        <dt>调整合计</dt><dd>${signedMoney(d.adjustmentTotal)} 元</dd>
        <dt>净额</dt><dd><strong>${money(d.netSettled)} 元</strong></dd>
      </dl>
      <div class="divider"></div>
      ${
        rows.length
          ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>报告</th><th class="num">金额</th><th class="num">事件数</th><th>依据运行</th><th>批准</th></tr></thead>
        <tbody>${rows
          .map(
            (a) => `<tr><td class="num">${a.id}</td><td>${a.report_id}</td><td class="num">${signedMoney(a.delta_amount_cents)}</td><td class="num">${a.delta_event_count > 0 ? '+' : ''}${a.delta_event_count}</td><td>#${a.basis_run_id}</td><td class="small">${timeLabel(a.applied_at)}<div class="muted small">${esc(a.applied_by)}</div></td></tr>`,
          )
          .join('')}</tbody></table></div>
        <p class="section-note">每条分录绑定生成它的报告与依据运行，同一报告对同一结算只能写入一次。</p>`
          : '<div class="empty">没有调整分录</div>'
      }`;
  } catch (err) {
    $('#drawer-body').innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ jobs */

async function viewJobs() {
  const [jobsRes, rulesRes] = await Promise.all([api('/api/jobs?limit=40'), api('/api/rules')]);
  const jobs = jobsRes.jobs || [];
  const published = (rulesRes.versions || []).filter((v) => v.status === 'published');
  state.rules = rulesRes.versions || [];
  return `
  <div class="stack">
    <div class="card flush">
      <div class="card-head" style="padding:16px 18px 0"><div><h3>任务队列</h3><p>按优先级与入队序号领取；序号在入队时分配，完成顺序不改变结果归属</p></div><button class="btn btn-sm" id="jobs-refresh" type="button">刷新</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th class="num">seq</th><th>任务</th><th>类型</th><th>状态</th><th>范围</th><th>规则</th><th>处理者</th><th>完成</th></tr></thead>
        <tbody>${jobs
          .map(
            (j) => `<tr class="clickable" data-job="${esc(j.id)}" tabindex="0">
          <td class="num">${j.sequence}</td>
          <td class="mono small nowrap">${esc(j.id)}</td>
          <td class="small nowrap">${esc({ evaluate: '判定', compare: '规则对比', correction: '证据更正', settle: '结算' }[j.kind] || j.kind)}</td>
          <td class="nowrap">${badge(j.status)}</td>
          <td class="small nowrap">${esc(j.scope_from)}${j.scope_to !== j.scope_from ? `～${esc(j.scope_to)}` : ''}</td>
          <td class="small nowrap">${esc(j.rule_label || '—')}</td>
          <td class="small mono nowrap">${esc(j.claimed_by || '—')}</td>
          <td class="small nowrap">${timeLabel(j.finished_at)}</td>
        </tr>`,
          )
          .join('')}</tbody>
      </table></div>
      <p class="section-note" style="padding:0 18px 14px">判定进程：<span class="mono">npm run worker -- --lane decisions</span> · 分析进程：<span class="mono">npm run worker -- --lane analysis</span></p>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>投递任务</h3><p>任务只入队；实际处理发生在独立进程</p></div></div>
      <form class="stack" id="job-form" style="gap:12px;max-width:760px">
        <div class="field"><label for="job-kind">任务类型</label><select id="job-kind" name="kind">
          <option value="evaluate">判定 evaluate（按规则重算指定日期）</option>
          <option value="compare">规则对比 compare（同一快照比较两个规则）</option>
          <option value="correction">证据更正 correction（已提交判定 vs 最新证据）</option>
          <option value="settle">生成结算 settle（按当前头生成草稿）</option>
        </select></div>
        <div class="grid grid-2">
          <div class="field"><label for="job-from">起始日</label><input id="job-from" name="from" type="date" value="${state.from}" required /></div>
          <div class="field"><label for="job-to">结束日</label><input id="job-to" name="to" type="date" value="${state.to}" required /></div>
        </div>
        <div class="field" id="job-rule-field"><label for="job-rule">规则版本</label><select id="job-rule" name="ruleVersionId">${published
          .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}</option>`)
          .join('')}</select></div>
        <div class="grid grid-2" id="job-compare-fields" hidden>
          <div class="field"><label for="job-baseline">基线规则</label><select id="job-baseline" name="baselineRuleId">${published
            .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}</option>`)
            .join('')}</select></div>
          <div class="field"><label for="job-candidate">候选规则</label><select id="job-candidate" name="candidateRuleId">${published
            .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}</option>`)
            .join('')}</select></div>
        </div>
        <div class="grid grid-2">
          <div class="field"><label for="job-priority">优先级</label><input id="job-priority" name="priority" type="number" value="100" min="0" max="999" /></div>
          <div class="field"><label for="job-delay">模拟处理耗时 (ms)</label><input id="job-delay" name="processDelayMs" type="number" value="0" min="0" step="100" /></div>
        </div>
        <label class="check-row"><input type="checkbox" id="job-suspect" name="includeSuspect" /> 结算时把可疑事件计入（settle）</label>
        <div id="job-result"></div>
        <button class="btn btn-primary" type="submit" style="align-self:flex-start">投递任务</button>
        <p class="hint small muted">提示：evaluate 与 compare 由判定进程消费；settle 由分析进程消费。可同时启动两个判定进程观察序号保护。</p>
      </form>
    </div>
  </div>`;
}

function bindJobs() {
  $('#jobs-refresh')?.addEventListener('click', () => render());
  const kind = $('#job-kind');
  const syncKind = () => {
    const k = kind.value;
    $('#job-compare-fields').hidden = !['compare', 'correction'].includes(k);
    $('#job-rule-field').hidden = k === 'settle';
    $('#job-suspect').closest('.check-row').hidden = k !== 'settle';
  };
  kind?.addEventListener('change', syncKind);
  syncKind();

  $('#job-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const k = kind.value;
    const body = {
      kind: k,
      from: f.from.value,
      to: f.to.value,
      priority: Number(f.priority.value || 100),
      processDelayMs: Number(f.processDelayMs.value || 0),
      includeSuspect: f.includeSuspect.checked,
    };
    if (k !== 'settle') body.ruleVersionId = Number(f.ruleVersionId.value);
    if (k === 'compare' || k === 'correction') {
      body.baselineRuleId = Number(f.baselineRuleId.value);
      body.candidateRuleId = Number(f.candidateRuleId.value);
    }
    $('#job-result').innerHTML = '<div class="loading">投递中…</div>';
    try {
      const job = await api('/api/jobs', { method: 'POST', body });
      $('#job-result').innerHTML = `<div class="callout"><strong>已投递 ${esc(job.id)}（seq ${job.sequence}）。</strong>${esc(job.hint)}</div>`;
      toast(`任务已入队（seq ${job.sequence}）`);
      setTimeout(() => render(), 700);
    } catch (err) {
      $('#job-result').innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
    }
  });

  $('#view').addEventListener('click', (e) => {
    const row = e.target.closest('[data-job]');
    if (row) openJob(row.dataset.job);
  });
  $('#view').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('[data-job]');
    if (row) openJob(row.dataset.job);
  });
}

async function openJob(id) {
  openDrawer(`任务 ${id}`, '<div class="loading">加载中…</div>');
  try {
    const j = await api(`/api/jobs/${encodeURIComponent(id)}`);
    $('#drawer-body').innerHTML = `
      <div class="row">${badge(j.status)}<span class="chip">seq ${j.sequence}</span><span class="chip">fence ${j.fence}</span><span class="chip">${esc({ evaluate: '判定', compare: '规则对比', correction: '证据更正', settle: '结算' }[j.kind] || j.kind)}</span></div>
      <dl class="kv" style="margin-top:12px">
        <dt>范围</dt><dd>${esc(j.scope_from)} ～ ${esc(j.scope_to)}</dd>
        <dt>规则</dt><dd>${esc(j.rule_label || j.rule_version_id || '—')}</dd>
        <dt>优先级</dt><dd>${j.priority}</dd>
        <dt>处理者</dt><dd class="mono">${esc(j.claimed_by || '—')}</dd>
        <dt>入队</dt><dd>${timeLabel(j.created_at)} · ${esc(j.created_by)}</dd>
        <dt>开始 / 结束</dt><dd>${timeLabel(j.started_at)} → ${timeLabel(j.finished_at)}</dd>
        <dt>尝试次数</dt><dd>${j.attempts}</dd>
        ${j.error ? `<dt>错误</dt><dd class="small" style="color:var(--critical)">${esc(j.error)}</dd>` : ''}
      </dl>
      <div class="divider"></div>
      <h3>参数</h3>
      <pre class="codeblock">${esc(JSON.stringify(j.params || {}, null, 2))}</pre>
      <div class="divider"></div>
      <h3>结果</h3>
      <pre class="codeblock">${esc(JSON.stringify(j.result ?? null, null, 2))}</pre>
      <div class="divider"></div>
      <h3>任务日志</h3>
      <div class="timeline">${(j.events || [])
        .map(
          (ev) => `<div class="timeline-item"><div class="timeline-rail"><span class="timeline-dot" style="background:${ev.level === 'warn' ? 'var(--warning)' : ev.level === 'error' ? 'var(--critical)' : 'var(--series-1)'}"></span></div>
        <div class="timeline-body"><div>${esc(ev.message)}</div><div class="t">${timeLabel(ev.at)} · ${esc(ev.level)}</div>${
          ev.detail ? `<pre class="codeblock" style="margin-top:4px">${esc(JSON.stringify(ev.detail, null, 2))}</pre>` : ''
        }</div></div>`,
        )
        .join('')}</div>`;
  } catch (err) {
    $('#drawer-body').innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ boot */

const views = {
  overview: viewOverview,
  quality: viewQuality,
  rules: viewRules,
  evidence: viewEvidence,
  reports: viewReports,
  settlements: viewSettlements,
  jobs: viewJobs,
  audit: async () => {
    const res = await api('/api/audit?limit=120');
    return `<div class="card flush"><div class="card-head" style="padding:16px 18px 0"><div><h3>审计日志</h3><p>所有写操作都记录操作者与实体</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>实体</th><th>详情</th></tr></thead>
      <tbody>${(res.rows || [])
        .map(
          (r) => `<tr><td class="small nowrap">${timeLabel(r.at)}</td><td class="mono small">${esc(r.actor)}</td><td class="small">${esc(r.action)}</td><td class="small">${esc(r.entity)}${r.entity_id ? ` #${esc(r.entity_id)}` : ''}</td><td class="mono small">${esc(r.detail_json || '')}</td></tr>`,
        )
        .join('')}</tbody></table></div></div>`;
  },
};

async function boot() {
  try {
    state.meta = await api('/api/meta');
  } catch (err) {
    $('#view').innerHTML = `<div class="card"><div class="callout danger"><strong>无法连接服务：</strong>${esc(err.message)}<p class="small" style="margin-top:6px">先运行 <span class="mono">npm run demo</span> 生成数据，再运行 <span class="mono">npm run web</span>。</p></div></div>`;
    $('#loading')?.remove();
    return;
  }
  const { meta } = state;
  $('#tz-chip').textContent = `时区 ${meta.timezone}`;
  $('#operator-chip').textContent = `操作者 ${meta.operator}`;
  const params = parseHash().params;
  state.from = params.get('from') || meta.defaultFrom;
  state.to = params.get('to') || meta.defaultTo;

  $('#range-apply').addEventListener('click', () => {
    const from = $('#range-from').value;
    const to = $('#range-to').value;
    if (!from || !to) return toast('请选择起止日期', true);
    if (from > to) return toast('起始日晚于结束日', true);
    if (daysBetween(from, to).length > 366) return toast('范围最多 366 天', true);
    setRange(from, to);
    render();
  });
  $$('.presets [data-days]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = Number(btn.dataset.days);
      const to = meta.today ? addDays(meta.today, -1) : state.to;
      const from = addDays(to, -(days - 1));
      setRange(from, to);
      render();
    });
  });

  $('#loading')?.remove();
  window.addEventListener('hashchange', render);
  await render();
}

boot();
