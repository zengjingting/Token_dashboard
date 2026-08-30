// app.js
// 仪表盘主前端：i18n 切换、SSE 实时连接、统计卡片、token/模型/项目图表、会话列表。
// 依赖 history.js 暴露的 openHistorySession() 函数实现跨标签页跳转。

// ── i18n ──────────────────────────────────────────────────────────────────
const T = {
  zh: {
    title: '▸ Token 用量看板', hTitle: '▸ Token',
    connecting: '连接中...', loading: '加载中...', updated: '更新于',
    reconnecting: '重连中...', parseError: '解析错误',
    pb: { '5h':'5小时', '1d':'今日', '3d':'3天', '7d':'7天', 'custom':'自定义' },
    apply: '应用', applyCustom: '应用',
    lTokens: '总 Token', lCost: '总费用',
    lCache: '缓存命中', lCacheSub: '仅 claude code',
    lModels: '模型数',
    lSeriesCtrl: '可见项',
    lTokenChart5h: '近5小时 Token 分布（按小时）',
    lTokenChart:   '每日 Token 分布',
    lModelChart: '模型成本分布', lSessions: '会话列表', noSessions: '暂无会话',
    thSrc:'来源', thSession:'会话', thTokens:'TOKEN',
    thIn:'输入', thOut:'输出', thCache:'缓存',
    thCost:'费用', thActivity:'最后活动', thModels:'模型',
    dsClaudeIn:'Claude 输入', dsClaudeOut:'Claude 输出', dsClaudeCache:'Claude 缓存',
    dsCodexIn:'Codex 输入', dsCodexOut:'Codex 输出', dsCodexCache:'Codex 缓存',
    inSub:'输入', outSub:'输出',
    tipTokens:  '本周期内 Claude + Codex 消耗的 Token 数量之和，包括输入 + 输出 + 缓存创建 + 缓存读取',
    tipCost:    '本周期内 Claude + Codex 的合计 API 费用',
    tipCache:   '仅 Claude Code 的缓存读取 ÷ (缓存读取 + 缓存创建)',
    tipModels:  '本周期内使用的不同模型数量',
    tipClaudeCacheSeries: '缓存创建 + 缓存读取',
    tipCodexCacheSeries:  '仅缓存读取（Codex 无缓存创建字段）',
    navDashboard: '仪表盘', navHistory: '会话历史',
    lProjectChart: '项目成本分布',
  },
  en: {
    title: '▸ Token Dashboard', hTitle: '▸ Token',
    connecting: 'CONNECTING...', loading: 'LOADING...', updated: 'UPDATED',
    reconnecting: 'RECONNECTING...', parseError: 'PARSE ERROR',
    pb: { '5h':'5H', '1d':'1D', '3d':'3D', '7d':'7D', 'custom':'CUSTOM' },
    apply: 'APPLY', applyCustom: 'APPLY',
    lTokens: 'TOTAL TOKENS', lCost: 'TOTAL COST',
    lCache: 'CACHE HIT', lCacheSub: 'Claude Code only',
    lModels: 'MODELS USED',
    lSeriesCtrl: 'Visible Series',
    lTokenChart5h: 'Last 5h Token Breakdown (hourly)',
    lTokenChart:   'Token Breakdown by Day',
    lModelChart: 'Model Cost Distribution', lSessions: 'SESSIONS', noSessions: 'NO SESSIONS',
    thSrc:'SRC', thSession:'SESSION', thTokens:'TOKENS',
    thIn:'IN', thOut:'OUT', thCache:'CACHE',
    thCost:'COST $', thActivity:'LAST ACTIVITY', thModels:'MODELS',
    dsClaudeIn:'Claude In', dsClaudeOut:'Claude Out', dsClaudeCache:'Claude Cache',
    dsCodexIn:'Codex In', dsCodexOut:'Codex Out', dsCodexCache:'Codex Cache',
    inSub:'in', outSub:'out',
    tipTokens:  'Total Tokens consumed by Claude + Codex in this period (input + output + cache creation + cache read)',
    tipCost:    'Combined Claude + Codex API cost for this period',
    tipCache:   'Claude Code only — cache_read ÷ (cache_read + cache_creation)',
    tipModels:  'Distinct models used in this period',
    tipClaudeCacheSeries: 'cache creation + cache read',
    tipCodexCacheSeries:  'cache read only (Codex has no creation field)',
    navDashboard: 'Dashboard', navHistory: 'History',
    lProjectChart: 'Project Cost Breakdown',
  }
};

let lang = 'zh';
function t(k) { return T[lang][k] ?? k; }

function setLang(l) {
  lang = l;
  document.getElementById('langZh').classList.toggle('active', l === 'zh');
  document.getElementById('langEn').classList.toggle('active', l === 'en');
  applyStaticLabels();
  if (lastReport) renderReport(lastReport);
}

// 将 T[lang] 中的文本批量写入对应 ID 的 DOM 元素。
function applyStaticLabels() {
  const L = T[lang];
  ['hTitle','pb-5h','pb-1d','pb-3d','pb-7d','pb-custom',
   'applyCustom','lTokens','lCost','lCache','lCacheSub',
   'lModels','lSeriesCtrl','lModelChart','lSessions',
   'thSrc','thSession','thTokens','thIn','thOut','thCache','thCost','thActivity','thModels'
  ].forEach(id => {
    const key = id.startsWith('pb-') ? 'pb' : id;
    const el = document.getElementById(id);
    if (!el) return;
    if (id.startsWith('pb-')) el.textContent = L.pb[id.slice(3)];
    else el.textContent = L[id] ?? '';
  });
  // overlay text
  document.getElementById('overlayText').textContent = L.loading;
  // tooltip texts
  document.getElementById('tipTokens').textContent = L.tipTokens;
  document.getElementById('tipCost').textContent   = L.tipCost;
  document.getElementById('tipCache').textContent  = L.tipCache;
  document.getElementById('tipModels').textContent = L.tipModels;
  // chart title depends on current period
  document.getElementById('lTokenChart').textContent =
    currentPeriod === '5h' ? L.lTokenChart5h : L.lTokenChart;
  // sidebar + analytics labels
  if (L.navDashboard) document.getElementById('navLabelDashboard').textContent = L.navDashboard;
  if (L.navHistory)   document.getElementById('navLabelHistory').textContent   = L.navHistory;
  if (L.lProjectChart) { const el = document.getElementById('lProjectChart'); if (el) el.textContent = L.lProjectChart; }
}

// ── State ─────────────────────────────────────────────────────────────────
let currentPeriod = '1d';
let tokenChart = null, modelChart = null;
let es = null, lastReport = null;
let overlayTimer = null;

// 每条记录描述一个 token 图表系列：从 daily 行中取哪个字段、颜色、标签 key、tooltip key。
const TOKEN_SERIES_META = [
  { key: 'claudeIn',    labelKey: 'dsClaudeIn',    color: 'rgba(217,119,87,0.85)', tipKey: null,                   valueOf: r => r.claude?.inputTokens || 0 },
  { key: 'claudeOut',   labelKey: 'dsClaudeOut',   color: 'rgba(180,85,50,0.8)',   tipKey: null,                   valueOf: r => r.claude?.outputTokens || 0 },
  { key: 'claudeCache', labelKey: 'dsClaudeCache', color: 'rgba(217,119,87,0.3)',  tipKey: 'tipClaudeCacheSeries', valueOf: r => (r.claude?.cacheReadTokens || 0) + (r.claude?.cacheCreationTokens || 0) },
  { key: 'codexIn',     labelKey: 'dsCodexIn',     color: 'rgba(59,130,246,0.85)', tipKey: null,                   valueOf: r => r.codex?.inputTokens || 0 },
  { key: 'codexOut',    labelKey: 'dsCodexOut',    color: 'rgba(59,130,246,0.55)', tipKey: null,                   valueOf: r => r.codex?.outputTokens || 0 },
  { key: 'codexCache',  labelKey: 'dsCodexCache',  color: 'rgba(59,130,246,0.25)', tipKey: 'tipCodexCacheSeries',  valueOf: r => r.codex?.cachedInputTokens || 0 }
];
const tokenSeriesVisible = Object.fromEntries(TOKEN_SERIES_META.map(s => [s.key, true]));

function showOverlay() {
  const el = document.getElementById('loadingOverlay');
  el.classList.remove('hiding');
  el.classList.add('visible');
  document.getElementById('overlayText').textContent = t('loading');
}

function hideOverlay() {
  const el = document.getElementById('loadingOverlay');
  if (!el.classList.contains('visible')) return;
  el.classList.remove('visible');
  el.classList.add('hiding');
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => el.classList.remove('hiding'), 250);
}

// ── Chart defaults (light) ────────────────────────────────────────────────
Chart.defaults.color       = '#92817A';
Chart.defaults.borderColor = '#E8E4DE';

// ── Formatters ────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtCost(n) { return n ? '$' + Number(n).toFixed(4) : '$0.0000'; }

// Fix 2: strip 'claude-' prefix instead of taking last N segments
function shortModel(name) {
  if (!name) return '—';
  return name.replace(/^claude-/, '');
}
function shortSession(id) {
  return (id || '').split('/').pop()?.slice(-14) || (id || '').slice(-14) || '—';
}

// HTML 转义，防止拼接 innerHTML 时出现 XSS
function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 从 localStorage 读取用户为 session 设置的自定义名称。
function getStoredSessionTitle(sessionId) {
  if (!sessionId) return '';
  try {
    return localStorage.getItem(`claude-session-name-${sessionId}`) || '';
  } catch {
    return '';
  }
}

// Codex session ID 形如 "subdir/uuid"，取最后一段作为显示/复制用的终端 ID。
function terminalSessionId(sessionId, source) {
  if ((source || 'claude') !== 'codex') return sessionId;
  const tail = String(sessionId || '').split('/').filter(Boolean).pop();
  return tail || sessionId;
}

// 切换到 History 标签页并跳转到指定会话（由仪表盘会话列表中的行触发）。
async function jumpToHistorySession({ id, source, projectDir }) {
  if (!id) return;
  switchView('history');
  if (typeof openHistorySession === 'function') {
    await openHistorySession({ id, source: source || 'claude', projectDir: projectDir || '' });
  }
}

// ── Render stats ──────────────────────────────────────────────────────────
// 填充四个统计卡片（总 token、总费用、缓存命中率、模型数）。
function renderStats(report) {
  const s = report.summary;
  document.getElementById('sTokens').textContent    = fmt(s.totalTokens);
  document.getElementById('sTokensSub').textContent =
    `${t('inSub')}:${fmt(s.inputTokens)} ${t('outSub')}:${fmt(s.outputTokens)}`;

  document.getElementById('sCost').textContent = fmtCost(s.totalCost);
  const codexCostLine = s.codexCost > 0 ? ` · Codex: ${fmtCost(s.codexCost)}` : '';
  document.getElementById('lCostSub').textContent =
    `Claude Code: ${fmtCost(s.claudeCost || 0)}${codexCostLine}`;

  // Claude-only cache hit rate (Codex has no creation tokens; including it skews the ratio)
  const claudeRead   = s.claudeCacheReadTokens || 0;
  const claudeCreate = s.cacheCreationTokens   || 0;  // already Claude-only in summary
  const claudeCacheTotal = claudeRead + claudeCreate;
  document.getElementById('sCache').textContent =
    claudeCacheTotal > 0 ? (claudeRead / claudeCacheTotal * 100).toFixed(1) + '%' : '—';

  document.getElementById('sModels').textContent     = report.models.length;
  document.getElementById('sModelNames').textContent =
    report.models.slice(0, 2).map(m => shortModel(m.name)).join(', ');
}

// ── Render token bar chart ────────────────────────────────────────────────
function calcVisibleMax(datasets) {
  let max = 0;
  for (const ds of datasets) {
    if (ds.hidden) continue;
    for (const v of (ds.data || [])) {
      const n = Number(v) || 0;
      if (n > max) max = n;
    }
  }
  return max;
}

// 切换系列可见性后重新计算 y 轴最大值，防止隐藏大系列后刻度失真。
function applyTokenYAxisScale(chart) {
  const max = calcVisibleMax(chart.data.datasets);
  chart.options.scales.y.max = max > 0 ? Math.ceil(max * 1.1) : 1;
}

// 渲染系列可见性勾选控件，每次图表重建后调用一次。
function renderTokenSeriesControls() {
  const wrap = document.getElementById('tokenSeriesControls');
  if (!wrap || !tokenChart) return;
  wrap.innerHTML = tokenChart.data.datasets.map((ds, idx) => {
    const checked = ds.hidden ? '' : 'checked';
    const meta = TOKEN_SERIES_META[idx];
    const titleAttr = meta?.tipKey ? ` title="${t(meta.tipKey)}"` : '';
    return `<label class="series-toggle"${titleAttr}>
      <input type="checkbox" data-idx="${idx}" ${checked}>
      <span class="series-dot" style="background:${ds.backgroundColor}"></span>
      <span>${ds.label}</span>
    </label>`;
  }).join('');

  wrap.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', e => {
      const idx = Number(e.target.dataset.idx);
      const ds = tokenChart.data.datasets[idx];
      if (!ds) return;
      ds.hidden = !e.target.checked;
      if (ds.seriesKey) tokenSeriesVisible[ds.seriesKey] = !ds.hidden;

      // keep at least one visible series to avoid misleading empty chart
      const anyVisible = tokenChart.data.datasets.some(item => !item.hidden);
      if (!anyVisible) {
        ds.hidden = false;
        if (ds.seriesKey) tokenSeriesVisible[ds.seriesKey] = true;
        e.target.checked = true;
      }

      applyTokenYAxisScale(tokenChart);
      tokenChart.update();
    });
  });
}

// 渲染每日（或 5h 时按小时）token 分布柱状图。
// 每次调用前先销毁旧实例，避免 Chart.js canvas 重用报错。
function renderTokenChart(report) {
  const panel = document.getElementById('tokenChartPanel');
  if (!report.daily?.length) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  // Fix 3: update chart title based on period
  document.getElementById('lTokenChart').textContent =
    report.period === '5h' ? t('lTokenChart5h') : t('lTokenChart');
  const d = report.daily;
  const datasets = TOKEN_SERIES_META.map(s => ({
    seriesKey: s.key,
    label: t(s.labelKey),
    data: d.map(row => s.valueOf(row)),
    backgroundColor: s.color,
    minBarLength: 2,
    hidden: tokenSeriesVisible[s.key] === false
  }));
  const yMax = calcVisibleMax(datasets);
  if (tokenChart) tokenChart.destroy();
  tokenChart = new Chart(document.getElementById('tokenChart'), {
    type: 'bar',
    data: {
      labels: d.map(r => r.date),
      datasets
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: false, grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { stacked: false, min: 0, max: yMax > 0 ? Math.ceil(yMax * 1.1) : 1, ticks: { callback: v => fmt(v), font: { size: 11 } } }
      },
      plugins: { legend: { labels: { font: { size: 11 }, boxWidth: 10, padding: 8 } } }
    }
  });
  renderTokenSeriesControls();
}

// ── Render model doughnut ─────────────────────────────────────────────────
// 渲染模型费用甜甜圈图。cost 为 0 时（Codex 场景）降级使用 totalTokens 作为权重。
function renderModelChart(report) {
  if (!report.models.length) return;
  if (modelChart) modelChart.destroy();
  const COLORS = ['#D97757','#3B82F6','#F59E0B','#EF4444','#8B5CF6','#10B981'];
  modelChart = new Chart(document.getElementById('modelChart'), {
    type: 'doughnut',
    data: {
      labels: report.models.map(m => shortModel(m.name)),
      datasets: [{
        data:            report.models.map(m => m.cost > 0 ? m.cost : m.totalTokens),
        backgroundColor: report.models.map((_, i) => COLORS[i % COLORS.length] + 'CC'),
        borderColor:     report.models.map((_, i) => COLORS[i % COLORS.length]),
        borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 10, padding: 6 } },
        tooltip: { callbacks: {
          label: ctx => ` ${ctx.label}: ${fmtCost(ctx.raw)} (${report.models[ctx.dataIndex]?.pct}%)`
        }}
      }
    }
  });
}

// ── Render session table ──────────────────────────────────────────────────
// 渲染会话列表（最多 50 条）。点击行跳转到 History 标签页对应会话。
function renderSessions(report) {
  const tbody = document.getElementById('sessionBody');
  if (!report.sessions?.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="placeholder">${t('noSessions')}</td></tr>`;
    return;
  }
  tbody.innerHTML = report.sessions.slice(0, 50).map(s => {
    const total = (s.inputTokens||0) + (s.outputTokens||0) + (s.cacheTokens||0);
    const ts = s.lastActivity
      ? new Date(s.lastActivity).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US',
          { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })
      : '—';
    const customTitle = getStoredSessionTitle(s.id);
    const displayTitle = customTitle || shortSession(s.id);
    // Fix 2: strip 'claude-' prefix from model names in session table
    const models = (s.models || []).map(m => m.replace(/^claude-/, '')).join(', ');
    const source = s.source || 'claude';
    const hoverSessionId = terminalSessionId(s.id, source);
    return `<tr>
      <td><span class="badge badge-${source}">${source.toUpperCase()}</span></td>
      <td style="color:var(--text-dim);font-size:10px">
        <button
          class="session-jump-btn"
          data-id="${escHtml(s.id)}"
          data-source="${escHtml(source)}"
          data-project="${escHtml(s.projectDir || '')}"
          title="${escHtml(hoverSessionId)}"
        >${escHtml(displayTitle)}</button>
      </td>
      <td>${fmt(total)}</td>
      <td>${fmt(s.inputTokens)}</td>
      <td>${fmt(s.outputTokens)}</td>
      <td>${fmt(s.cacheTokens)}</td>
      <td>${fmtCost(s.totalCost)}</td>
      <td style="color:var(--text-dim)">${ts}</td>
      <td style="color:var(--text-dim);font-size:10px">${models}</td>
    </tr>`;
  }).join('');

  tbody.onclick = (e) => {
    const btn = e.target.closest('.session-jump-btn[data-id]');
    if (!btn) return;
    jumpToHistorySession({
      id: btn.dataset.id,
      source: btn.dataset.source || 'claude',
      projectDir: btn.dataset.project || ''
    }).catch(() => {});
  };
}

// ── Render full report ────────────────────────────────────────────────────
function renderReport(report) {
  lastReport = report;
  document.getElementById('status').textContent =
    `${t('updated')} ${new Date(report.updatedAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US')}`;
  renderStats(report);
  renderTokenChart(report);
  renderModelChart(report);
  renderSessions(report);
}

// ── SSE ───────────────────────────────────────────────────────────────────
// 打开 SSE 连接，接收服务端每 30 秒推送的 UsageReport 并渲染。
// 切换时间段时先关闭旧连接再重新连接，避免并发推送。
function connect(period, since, until) {
  if (es) { es.close(); es = null; }
  showOverlay();
  document.getElementById('status').textContent = t('loading');
  let url = `/api/stream?period=${period}`;
  if (since) url += `&since=${since}`;
  if (until) url += `&until=${until}`;
  es = new EventSource(url);
  let firstFrame = true;
  es.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if (firstFrame) { hideOverlay(); firstFrame = false; }
      if (data.error) { document.getElementById('status').textContent = data.error; return; }
      renderReport(data);
    } catch { hideOverlay(); document.getElementById('status').textContent = t('parseError'); }
  };
  es.onerror = () => { hideOverlay(); document.getElementById('status').textContent = t('reconnecting'); };
}

// ── Period tabs ───────────────────────────────────────────────────────────
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    document.getElementById('customRange').classList.toggle('visible', currentPeriod === 'custom');
    if (currentPeriod !== 'custom') connect(currentPeriod);
  });
});

document.getElementById('applyCustom').addEventListener('click', () => {
  const since = document.getElementById('sinceInput').value;
  const until = document.getElementById('untilInput').value;
  if (since) connect('custom', since, until || undefined);
});

// ── Boot ──────────────────────────────────────────────────────────────────
applyStaticLabels();
connect('1d');
// Defer until after first paint so the canvas has a computed layout width
requestAnimationFrame(() => loadProjectChart());

// ── Stat-card tooltips: icon-triggered (Wave 1) ───────────────────────────
document.querySelectorAll('.stat-info-icon').forEach(icon => {
  const tipId = icon.dataset.tip;
  const tip = tipId && document.getElementById(tipId);
  if (!tip) return;
  icon.addEventListener('mouseenter', () => {
    const rect = icon.getBoundingClientRect();
    tip.style.top  = (rect.top - 8) + 'px';
    tip.style.left = (rect.left + rect.width / 2) + 'px';
    tip.style.display = 'block';
  });
  icon.addEventListener('mouseleave', () => { tip.style.display = ''; });
});

// ── Sidebar navigation ─────────────────────────────────────────────────────
let currentView = 'dashboard';
// 切换可见的视图面板（dashboard/history），同时更新侧边栏高亮状态。
function switchView(viewName) {
  currentView = viewName;
  document.querySelectorAll('.view-pane').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('contextBarDashboard').classList.toggle('hidden', viewName !== 'dashboard');
  document.getElementById('contextBarHistory').classList.toggle('hidden', viewName !== 'history');

  const viewEl = document.getElementById(`view-${viewName}`);
  if (viewEl) viewEl.classList.add('active');
  const navEl = document.getElementById(`nav${viewName.charAt(0).toUpperCase() + viewName.slice(1)}`);
  if (navEl) navEl.classList.add('active');

  if (viewName === 'history' && typeof loadHistorySessions === 'function') {
    loadHistorySessions();
  }
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// 监听 History 标签页的自定义标题更新事件，同步刷新仪表盘会话列表中的显示名
window.addEventListener('session-title-updated', () => {
  if (lastReport) renderSessions(lastReport);
});

// ── Project cost chart (loaded once; retries if first load produced no chart) ─
let projectChartInst = null;
let projectChartLoading = false;

// 请求项目统计数据并渲染水平柱状图，内置防重入锁避免并发加载。
async function loadProjectChart() {
  if (projectChartInst || projectChartLoading) return;
  projectChartLoading = true;
  try {
    const data = await fetch('/api/analytics/projects').then(r => r.json()).catch(() => ({ projects: [] }));
    renderProjectChart(data.projects || []);
  } finally {
    projectChartLoading = false;
  }
}

function renderProjectChart(projects) {
  if (projectChartInst) { projectChartInst.destroy(); projectChartInst = null; }
  if (!projects.length) return;

  const top = projects.slice(0, 15);
  const COLORS = ['#D97757','#3B82F6','#F59E0B','#EF4444','#8B5CF6','#10B981',
                  '#EC4899','#14B8A6','#F97316','#6366F1','#84CC16','#06B6D4',
                  '#A855F7','#22C55E','#EAB308'];

  const canvas = document.getElementById('projectChart');
  projectChartInst = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: top.map(p => p.name),
      datasets: [{
        label: 'Cost (USD)',
        data: top.map(p => p.totalCost),
        backgroundColor: top.map((_, i) => COLORS[i % COLORS.length] + 'CC'),
        borderColor:     top.map((_, i) => COLORS[i % COLORS.length]),
        borderWidth: 1
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          label: ctx => ` $${Number(ctx.raw).toFixed(4)}`
        }}
      },
      scales: {
        x: { ticks: { callback: v => `$${Number(v).toFixed(3)}`, font: { size: 10 } } },
        y: { ticks: { font: { size: 10 } } }
      }
    }
  });
  // Force resize in case canvas had no computed width when created
  requestAnimationFrame(() => projectChartInst?.resize());
}
