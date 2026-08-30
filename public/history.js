// history.js — History 标签页：会话列表、会话查看器、全文搜索、Markdown 导出

let historyLoaded = false;
let historyLoadPromise = null;
let allProjects = [];
let activeSessionId = null;

function lettersOnlyKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z]/g, '');
}

function projectMergeKey(project) {
  const byName = lettersOnlyKey(project?.name);
  if (byName) return byName;
  const byDir = lettersOnlyKey(project?.dirName);
  if (byDir) return byDir;
  return `raw:${String(project?.dirName || '').toLowerCase()}`;
}

// 合并同名项目（服务端合并后仍可能有残余重复），将其 sessions 合入同一组并重新排序。
function mergeProjectsByLetters(projects) {
  const merged = new Map();
  for (const proj of (projects || [])) {
    const key = projectMergeKey(proj);
    if (!merged.has(key)) {
      merged.set(key, { ...proj, sessions: [...(proj.sessions || [])] });
    } else {
      merged.get(key).sessions.push(...(proj.sessions || []));
    }
  }

  const output = [...merged.values()];
  for (const proj of output) {
    proj.sessions.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  }
  output.sort((a, b) => {
    const aLast = a.sessions[0]?.lastActivity || '';
    const bLast = b.sessions[0]?.lastActivity || '';
    return bLast.localeCompare(aLast);
  });
  return output;
}

// ── Custom session title persistence (localStorage) ───────────────────────
function getCustomTitle(id) {
  try { return localStorage.getItem('claude-session-name-' + id) || null; } catch { return null; }
}
function setCustomTitle(id, title) {
  try {
    if (title) localStorage.setItem('claude-session-name-' + id, title);
    else localStorage.removeItem('claude-session-name-' + id);
  } catch {}
}

// ── Load and render session list ──────────────────────────────────────────
async function loadHistorySessions(forceReload = false) {
  if (historyLoadPromise && !forceReload) return historyLoadPromise;
  if (historyLoaded && !forceReload) return;

  if (forceReload) {
    historyLoaded = false;
    historyLoadPromise = null;
  }

  historyLoaded = true;
  renderSessionListLoading();

  historyLoadPromise = (async () => {
    try {
      const data = await fetch('/api/history/sessions').then(r => r.json());
      allProjects = mergeProjectsByLetters(data.projects || []);
      renderProjectList(allProjects);
    } catch {
      document.getElementById('historyList').innerHTML =
        '<div class="placeholder" style="padding:24px">加载失败，请刷新重试</div>';
      historyLoaded = false; // allow retry
    } finally {
      historyLoadPromise = null;
    }
  })();

  return historyLoadPromise;
}

function renderSessionListLoading() {
  document.getElementById('historyList').innerHTML =
    '<div class="placeholder" style="padding:24px">加载中...</div>';
}

// Use encodeURIComponent for ID suffixes — avoids esc() mismatch when dirName
// contains &, <, >, " (esc would encode them but getElementById gets the raw string)
function dirId(dirName) { return encodeURIComponent(dirName); }

function sessionKey(session) {
  return `${session?.source || 'claude'}::${session?.id || ''}`;
}

// Codex session ID 为相对路径（如 "subdir/uuid"），取最后一段作为终端 ID 用于显示/复制。
function terminalSessionId(sessionId, source) {
  if ((source || 'claude') !== 'codex') return sessionId;
  const tail = String(sessionId || '').split('/').filter(Boolean).pop();
  return tail || sessionId;
}

function findSessionMeta(sessionId, source) {
  const targetSource = source || 'claude';
  for (const proj of allProjects) {
    for (const s of (proj.sessions || [])) {
      if (s.id === sessionId && (s.source || 'claude') === targetSource) {
        return { project: proj, session: s };
      }
    }
  }
  return null;
}

// 对搜索结果排序：自定义标题匹配的结果优先浮出，其次按最近活动时间降序。
function sortSearchResults(results, query) {
  const q = query.trim().toLowerCase();
  return [...results].sort((a, b) => {
    const aCustom = getCustomTitle(a.id);
    const bCustom = getCustomTitle(b.id);
    const aMatchCustom = !!(aCustom && aCustom.toLowerCase().includes(q));
    const bMatchCustom = !!(bCustom && bCustom.toLowerCase().includes(q));
    if (aMatchCustom !== bMatchCustom) return aMatchCustom ? -1 : 1;
    return (b.lastActivity || '').localeCompare(a.lastActivity || '');
  });
}

function renderProjectList(projects) {
  const list = document.getElementById('historyList');
  if (!projects.length) {
    list.innerHTML = '<div class="placeholder" style="padding:24px">暂无会话记录</div>';
    return;
  }

  // Use data-dir on each header; click delegation avoids onclick JS-string injection
  list.innerHTML = projects.map(proj => `
    <div class="project-group" data-dir="${esc(proj.dirName)}">
      <div class="project-header" data-toggle-dir="${esc(proj.dirName)}">
        <span>${esc(proj.name)}</span>
        <span>
          <span class="project-count">${proj.sessions.length}</span>
          <span class="project-toggle" id="ptoggle-${dirId(proj.dirName)}">▸</span>
        </span>
      </div>
      <div class="project-sessions" id="psessions-${dirId(proj.dirName)}">
        ${proj.sessions.map(s => renderSessionItem(s)).join('')}
      </div>
    </div>`
  ).join('');

  if (!list.dataset.bound) {
    // Delegated click listener for project headers, copy/delete buttons, and session items
    list.addEventListener('click', async (e) => {
      const header = e.target.closest('[data-toggle-dir]');
      if (header) { toggleProject(header.dataset.toggleDir); return; }

      const copyBtn = e.target.closest('.session-copy-btn[data-copy-id]');
      if (copyBtn) {
        e.stopPropagation();
        const id = copyBtn.dataset.copyId;
        navigator.clipboard.writeText(id).catch(() => {});
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = '⧉'; }, 1400);
        return;
      }

      const delBtn = e.target.closest('.session-delete-btn[data-id]');
      if (delBtn) {
        e.stopPropagation();
        await deleteSessionFromUI(delBtn.dataset);
        return;
      }

      const item = e.target.closest('.session-item[data-id]');
      if (item) selectSession(item.dataset.proj, item.dataset.id, item.dataset.source);
    });
    list.dataset.bound = '1';
  }

  // Auto-open the first project
  if (projects[0]) toggleProject(projects[0].dirName);
}

function renderSessionItem(s) {
  const ts = s.lastActivity
    ? new Date(s.lastActivity).toLocaleString('zh-CN',
        { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  const tokens = (s.inputTokens||0) + (s.outputTokens||0) + (s.cacheTokens||0);
  const displayTitle = getCustomTitle(s.id) || s.title;
  const source = s.source || 'claude';
  const copiedSessionId = terminalSessionId(s.id, source);
  // No onclick — handled by delegated listener in renderProjectList
  return `
    <div class="session-item" data-id="${esc(s.id)}" data-proj="${esc(s.projectDir)}" data-source="${esc(source)}">
      <div class="session-item-main">
        <div class="session-title">
          <span class="session-title-text">${esc(displayTitle)}</span>
        </div>
        <div class="session-meta">
          <span class="badge badge-${esc(source)} badge-mini">${esc(source).toUpperCase()}</span>
          ${fmtOrigin(s.originSource) ? `<span class="origin-label">${esc(fmtOrigin(s.originSource))}</span>` : ''}
          <span>${ts}</span>
          <span>${fmtK(tokens)} tok</span>
          <span>$${(s.totalCost||0).toFixed(4)}</span>
        </div>
      </div>
      <div class="session-item-actions">
        <button
          class="session-delete-btn"
          data-id="${esc(s.id)}"
          data-proj="${esc(s.projectDir)}"
          data-source="${esc(source)}"
          title="删除会话（不可恢复）"
        >🗑</button>
        <button class="session-copy-btn" data-copy-id="${esc(copiedSessionId)}" title="${esc(copiedSessionId)}">⧉</button>
      </div>
    </div>`;
}

function toggleProject(dirName) {
  const el = document.getElementById(`psessions-${dirId(dirName)}`);
  const tog = document.getElementById(`ptoggle-${dirId(dirName)}`);
  if (!el) return;
  const isOpen = el.classList.toggle('open');
  if (tog) tog.textContent = isOpen ? '▾' : '▸';
}

function fmtK(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(0)+'K';
  return String(n);
}

const ORIGIN_LABEL_MAP = {
  'cli': 'CLI', 'codex-tui': 'CLI',
  'claude-vscode': 'VSCode', 'codex_vscode': 'VSCode',
  'claude-desktop': 'Desktop', 'Codex Desktop': 'Desktop',
  'sdk-cli': 'SDK',
};
function fmtOrigin(originSource) {
  return ORIGIN_LABEL_MAP[originSource] || '';
}

// HTML 转义，防止 innerHTML 拼接时的 XSS
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function deleteSessionFromUI({ id, proj, source }) {
  if (!id) return;

  const sourceLabel = source === 'codex' ? 'Codex' : 'Claude Code';
  const confirmText =
    `确定删除该会话吗？\n\n来源: ${sourceLabel}\nSession ID: ${id}\n\n删除后记录不可恢复。`;
  if (!window.confirm(confirmText)) return;

  const params = new URLSearchParams({ id });
  if (source === 'codex') {
    params.set('source', 'codex');
  } else if (proj) {
    params.set('project', proj);
  }

  try {
    const resp = await fetch(`/api/history/session?${params}`, { method: 'DELETE' });
    if (!resp.ok) {
      const payload = await resp.json().catch(() => ({}));
      const message = payload?.error || `HTTP ${resp.status}`;
      throw new Error(message);
    }

    setCustomTitle(id, null);
    window.dispatchEvent(new CustomEvent('session-title-updated', { detail: { id, deleted: true } }));

    if (activeSessionId === id) {
      activeSessionId = null;
      document.getElementById('historyViewer').innerHTML =
        '<div class="placeholder" style="padding:48px;text-align:center">← 从左侧选择一个会话</div>';
    }
    await loadHistorySessions(true);
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('404') || msg.includes('Cannot DELETE')) {
      window.alert('删除失败：接口不可用或会话不存在。请重启服务后重试。');
      return;
    }
    window.alert(`删除失败：${msg || '请稍后重试'}`);
  }
}

// ── Session selection ──────────────────────────────────────────────────────
async function selectSession(projectDir, sessionId, source, opts = {}) {
  document.querySelectorAll('.session-item, .session-search-item').forEach(el =>
    el.classList.remove('active'));
  // Read from data-* attributes via delegated listener — no CSS selector injection risk
  const itemEl = document.querySelector(
    `.session-item[data-id="${CSS.escape(sessionId)}"][data-proj="${CSS.escape(projectDir)}"]`);
  if (itemEl) itemEl.classList.add('active');

  activeSessionId = sessionId;
  renderViewerLoading();

  try {
    const params = new URLSearchParams({ id: sessionId });
    if (source === 'codex') {
      params.set('source', 'codex');
    } else if (projectDir) {
      params.set('project', projectDir);
    } else {
      params.set('source', 'claude');
    }
    const session = await fetch(`/api/history/session?${params}`).then(r => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
    renderViewer(session);
    if (opts.openInSessionQuery) {
      openInSessionSearchWithQuery(opts.openInSessionQuery, true);
    }
  } catch {
    document.getElementById('historyViewer').innerHTML =
      '<div class="placeholder" style="padding:48px;text-align:center">加载失败</div>';
  }
}

// 打开会话内搜索面板并预填 query，可选跳转到第一个匹配位置。
// 从全局搜索结果跳转到某会话时调用，使关键词高亮立即可见。
function openInSessionSearchWithQuery(query, jumpFirstMatch = false) {
  if (!viewerSession) return;
  const q = String(query || '').trim();

  inSessionSearch.open = true;
  inSessionSearch.query = q;
  inSessionSearch.results = computeInSessionSearchResults();

  const wrap = document.getElementById('viewerContentWrap');
  if (wrap) wrap.classList.add('search-open');
  const btn = document.getElementById('toggleInSessionSearchBtn');
  if (btn) btn.classList.add('active');

  renderInSessionSearchPanel();
  renderMessages(viewerSession.messages.slice(0, viewerShown));

  if (jumpFirstMatch && inSessionSearch.results.length > 0) {
    jumpToMessageIndex(inSessionSearch.results[0].index);
  }
}

async function openHistorySession({ id, source = 'claude', projectDir = '' } = {}) {
  if (!id) return;
  await loadHistorySessions();

  if (searchMode) {
    searchMode = false;
    const input = document.getElementById('historySearch');
    const clearBtn = document.getElementById('historyClearBtn');
    if (input) input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    renderProjectList(allProjects);
  }

  const meta = findSessionMeta(id, source);
  const resolvedProject = projectDir || meta?.session?.projectDir || '';
  const targetGroup = meta?.project?.dirName || resolvedProject;
  if (targetGroup) {
    const el = document.getElementById(`psessions-${dirId(targetGroup)}`);
    if (el && !el.classList.contains('open')) toggleProject(targetGroup);
  }

  await selectSession(resolvedProject, id, source);
}

window.openHistorySession = openHistorySession;

function renderViewerLoading() {
  document.getElementById('historyViewer').innerHTML =
    '<div class="placeholder" style="padding:48px;text-align:center">加载中...</div>';
}

// ── Conversation viewer rendering ─────────────────────────────────────────
const MESSAGES_PER_PAGE = 100;
let viewerSession = null;
let viewerShown = 0;
let inSessionSearch = {
  open: false,
  query: '',
  filters: { user: true, assistant: true },
  results: []
};

function resetInSessionSearch() {
  inSessionSearch = {
    open: false,
    query: '',
    filters: { user: true, assistant: true },
    results: []
  };
}

// 将 query 匹配内容包裹在 <mark> 中，text 和 query 都先经 HTML 转义，
// 确保替换后插入 innerHTML 不引入 XSS 风险。
function highlightText(text, query) {
  if (!query) return esc(text);
  const escapedQuery = esc(query);
  const re = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return esc(text).replace(re, '<mark>$1</mark>');
}

function computeInSessionSearchResults() {
  if (!viewerSession) return [];
  const q = inSessionSearch.query.trim().toLowerCase();
  if (!q) return [];

  const results = [];
  for (let i = 0; i < viewerSession.messages.length; i++) {
    const msg = viewerSession.messages[i];
    if (msg.type !== 'text') continue;
    if (msg.role === 'user' && !inSessionSearch.filters.user) continue;
    if (msg.role === 'assistant' && !inSessionSearch.filters.assistant) continue;

    const content = String(msg.content || '');
    const lower = content.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) continue;

    const start = Math.max(0, idx - 40);
    const end = Math.min(content.length, idx + q.length + 40);
    results.push({
      index: i,
      role: msg.role,
      snippet: content.slice(start, end).replace(/\n+/g, ' ')
    });
  }
  return results;
}

function renderInSessionSearchPanel() {
  const panel = document.getElementById('inSessionSearchPanel');
  if (!panel) return;

  const q = inSessionSearch.query.trim();
  panel.innerHTML = `
    <div class="in-session-head">
      <input id="inSessionSearchInput" type="text" placeholder="搜索当前会话..." value="${esc(inSessionSearch.query)}">
      <button id="inSessionSearchRun">搜索</button>
    </div>
    <div class="in-session-filters">
      <label><input type="checkbox" id="inSessionFilterUser" ${inSessionSearch.filters.user ? 'checked' : ''}><span>用户消息</span></label>
      <label><input type="checkbox" id="inSessionFilterAssistant" ${inSessionSearch.filters.assistant ? 'checked' : ''}><span>Assistant 回复</span></label>
    </div>
    <div class="in-session-count">${q ? `找到 ${inSessionSearch.results.length} 条` : '输入关键词后搜索'}</div>
    <div class="in-session-results">
      ${inSessionSearch.results.map(r => `
        <div class="in-session-item" data-index="${r.index}">
          <div class="in-session-item-role">${r.role === 'user' ? 'USER' : 'ASSISTANT'} · #${r.index + 1}</div>
          <div class="in-session-item-snippet">...${highlightText(r.snippet, inSessionSearch.query)}...</div>
        </div>
      `).join('')}
    </div>
  `;

  const input = document.getElementById('inSessionSearchInput');
  const runBtn = document.getElementById('inSessionSearchRun');
  const fUser = document.getElementById('inSessionFilterUser');
  const fAssistant = document.getElementById('inSessionFilterAssistant');
  if (runBtn) runBtn.addEventListener('click', runInSessionSearch);
  if (input) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runInSessionSearch(); });
  }
  if (fUser) {
    fUser.addEventListener('change', () => {
      inSessionSearch.filters.user = fUser.checked;
      runInSessionSearch();
    });
  }
  if (fAssistant) {
    fAssistant.addEventListener('change', () => {
      inSessionSearch.filters.assistant = fAssistant.checked;
      runInSessionSearch();
    });
  }

  const resultsWrap = panel.querySelector('.in-session-results');
  if (resultsWrap) {
    resultsWrap.addEventListener('click', (e) => {
      const item = e.target.closest('.in-session-item[data-index]');
      if (!item) return;
      jumpToMessageIndex(Number(item.dataset.index));
    });
  }
}

function runInSessionSearch() {
  const input = document.getElementById('inSessionSearchInput');
  inSessionSearch.query = input ? input.value : inSessionSearch.query;
  inSessionSearch.results = computeInSessionSearchResults();
  renderInSessionSearchPanel();
  renderMessages(viewerSession?.messages?.slice(0, viewerShown) || []);
}

function updateLoadMoreButton() {
  const loadMore = document.querySelector('.msg-load-more');
  if (!loadMore || !viewerSession) return;
  const remaining = viewerSession.messages.length - viewerShown;
  if (remaining <= 0) {
    loadMore.remove();
    return;
  }
  const btn = loadMore.querySelector('button');
  if (btn) btn.textContent = `加载更多 (${remaining} 条)`;
}

function triggerMessageFlash(target) {
  if (!target) return;
  target.classList.remove('msg-flash');
  void target.offsetWidth;  // 强制重排，使动画可以重新触发
  target.classList.add('msg-flash');
  setTimeout(() => target.classList.remove('msg-flash'), 1200);
}

function getScrollContainer(el) {
  let node = el?.parentElement || null;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

// 等待滚动动画稳定后再触发消息闪烁效果。
// 用 rAF 轮询而非固定 setTimeout，快速滚动时不会提前触发。
function flashAfterScrollSettles(target) {
  const scroller = getScrollContainer(target);
  if (!scroller) {
    setTimeout(() => triggerMessageFlash(target), 120);
    return;
  }

  let lastTop = scroller.scrollTop;
  let stableFrames = 0;
  let rafId = 0;
  let finished = false;
  const startedAt = performance.now();
  const MAX_WAIT_MS = 1600;
  const STABLE_FRAMES = 6;

  const done = () => {
    if (finished) return;
    finished = true;
    if (rafId) cancelAnimationFrame(rafId);
    triggerMessageFlash(target);
  };

  const tick = () => {
    if (finished) return;
    const top = scroller.scrollTop;
    if (Math.abs(top - lastTop) < 1) stableFrames += 1;
    else stableFrames = 0;
    lastTop = top;

    const tr = target.getBoundingClientRect();
    const vr = scroller.getBoundingClientRect();
    const fullyVisible = tr.top >= vr.top && tr.bottom <= vr.bottom;
    const timeout = (performance.now() - startedAt) > MAX_WAIT_MS;
    if ((fullyVisible && stableFrames >= STABLE_FRAMES) || timeout) {
      done();
      return;
    }
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
}

function jumpToMessageIndex(index) {
  if (!viewerSession || !Number.isFinite(index) || index < 0) return;
  if (index >= viewerShown) {
    viewerShown = Math.min(
      viewerSession.messages.length,
      Math.ceil((index + 1) / MESSAGES_PER_PAGE) * MESSAGES_PER_PAGE
    );
    renderMessages(viewerSession.messages.slice(0, viewerShown));
    updateLoadMoreButton();
  }

  const target = document.querySelector(`.message[data-msg-index="${index}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashAfterScrollSettles(target);
}

function renderViewer(session) {
  viewerSession = session;
  viewerShown = Math.min(MESSAGES_PER_PAGE, session.messages.length);
  resetInSessionSearch();

  const totalTok = (session.inputTokens||0)+(session.outputTokens||0)+(session.cacheTokens||0);
  const ts = session.lastActivity
    ? new Date(session.lastActivity).toLocaleString('zh-CN')
    : '';

  const customTitle = getCustomTitle(session.id);
  const displayTitle = customTitle || session.title;
  const toolCount = session.messages.filter(m => m.type === 'tool_use' || m.type === 'tool_result').length;

  const viewer = document.getElementById('historyViewer');
  viewer.innerHTML = `
    <div class="viewer-header">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:flex-start;gap:4px;flex-wrap:wrap">
          <span class="viewer-title" id="viewerTitleText">${esc(displayTitle)}</span>
          <button class="rename-btn" id="renameBtn" title="重命名">✎</button>
        </div>
        <div class="viewer-meta">
          <span class="badge badge-${esc(session.source || 'claude')} badge-mini">${esc(session.source || 'claude').toUpperCase()}</span>
          ${fmtOrigin(session.originSource) ? `<span class="origin-label">${esc(fmtOrigin(session.originSource))}</span>` : ''}
          ${ts} · ${fmtK(totalTok)} tokens · $${(session.totalCost||0).toFixed(4)} ·
          ${(session.models||[]).map(m => esc(m.replace(/^claude-/,''))).join(', ')}
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:flex-start;flex-shrink:0">
        ${toolCount > 0 ? `<button class="toggle-tools-btn" id="toggleToolsBtn">展示工具调用记录 (${toolCount})</button>` : ''}
        <button class="toggle-tools-btn" id="toggleInSessionSearchBtn">🔍 会话内搜索</button>
        <button class="export-btn" id="exportBtn">↓ Markdown</button>
      </div>
    </div>
    <div class="viewer-content-wrap" id="viewerContentWrap">
      <div class="viewer-main-col">
        <div id="messageList"></div>
        ${session.messages.length > MESSAGES_PER_PAGE
          ? `<div class="msg-load-more"><button id="loadMoreBtn">加载更多 (${session.messages.length - viewerShown} 条)</button></div>`
          : ''}
      </div>
      <aside class="in-session-panel" id="inSessionSearchPanel"></aside>
    </div>`;

  document.getElementById('exportBtn').addEventListener('click', exportMarkdown);

  // Tool messages toggle (hidden by default via CSS)
  const toggleToolsBtn = document.getElementById('toggleToolsBtn');
  if (toggleToolsBtn) {
    toggleToolsBtn.addEventListener('click', () => {
      const msgList = document.getElementById('messageList');
      const showing = msgList.classList.toggle('show-tools');
      toggleToolsBtn.classList.toggle('active', showing);
      toggleToolsBtn.textContent = showing ? '隐藏工具调用记录' : `展示工具调用记录 (${toolCount})`;
    });
  }

  const toggleInSessionSearchBtn = document.getElementById('toggleInSessionSearchBtn');
  if (toggleInSessionSearchBtn) {
    toggleInSessionSearchBtn.addEventListener('click', () => {
      inSessionSearch.open = !inSessionSearch.open;
      const wrap = document.getElementById('viewerContentWrap');
      if (wrap) wrap.classList.toggle('search-open', inSessionSearch.open);
      toggleInSessionSearchBtn.classList.toggle('active', inSessionSearch.open);
      if (inSessionSearch.open) {
        renderInSessionSearchPanel();
        const input = document.getElementById('inSessionSearchInput');
        if (input) input.focus();
      }
    });
  }

  // Contenteditable inline rename
  const renameBtn = document.getElementById('renameBtn');
  const titleEl   = document.getElementById('viewerTitleText');
  if (renameBtn && titleEl) {
    renameBtn.addEventListener('click', () => {
      if (titleEl.contentEditable === 'true') return;
      titleEl.contentEditable = 'true';
      titleEl.focus();
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    titleEl.addEventListener('blur', () => {
      if (titleEl.contentEditable !== 'true') return;
      titleEl.contentEditable = 'false';
      const newTitle = titleEl.textContent.trim() || session.title;
      setCustomTitle(session.id, newTitle !== session.title ? newTitle : null);
      window.dispatchEvent(new CustomEvent('session-title-updated', { detail: { id: session.id, title: newTitle } }));
      titleEl.textContent = newTitle;
      const listItem = document.querySelector(`.session-item[data-id="${CSS.escape(session.id)}"]`);
      if (listItem) {
        const t = listItem.querySelector('.session-title-text');
        if (t) t.textContent = newTitle;
      }
    });
    titleEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
      if (e.key === 'Escape') {
        titleEl.textContent = getCustomTitle(session.id) || session.title;
        titleEl.contentEditable = 'false';
      }
    });
  }

  const loadMoreBtn = document.getElementById('loadMoreBtn');
  if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMoreMessages);

  // Attach tool expand/collapse once per session load (not per page)
  const msgList = document.getElementById('messageList');
  if (msgList) {
    msgList.addEventListener('click', e => {
      const label = e.target.closest('.msg-tool .msg-label');
      if (label) {
        const tool = label.closest('.msg-tool');
        if (!tool) return;
        const body = tool.querySelector('.tool-body');
        const tog = tool.querySelector('.tool-toggle');
        if (!body) return;
        const open = body.classList.toggle('open');
        if (tog) tog.textContent = open ? '▾ 折叠' : '▸ 展开';
      }
    });
  }

  renderMessages(session.messages.slice(0, viewerShown));
}

function renderMessages(messages) {
  const list = document.getElementById('messageList');
  if (!list) return;
  list.innerHTML = messages.map((msg, idx) => renderMessage(msg, idx)).join('');
}

function loadMoreMessages() {
  if (!viewerSession) return;
  viewerShown = Math.min(viewerShown + MESSAGES_PER_PAGE, viewerSession.messages.length);
  renderMessages(viewerSession.messages.slice(0, viewerShown));
  updateLoadMoreButton();
}

function renderMessage(msg, idx) {
  const query = inSessionSearch.query.trim();
  const canHighlight =
    inSessionSearch.open &&
    !!query &&
    ((msg.role === 'user' && inSessionSearch.filters.user) ||
     (msg.role === 'assistant' && inSessionSearch.filters.assistant));
  const activeQuery = canHighlight ? query : '';
  if (msg.role === 'user' && msg.type === 'text') {
    return `<div class="message msg-user" data-msg-index="${idx}">
      <div class="msg-label">USER</div>
      <div class="msg-text">${highlightText(msg.content, activeQuery)}</div>
    </div>`;
  }

  if (msg.role === 'assistant' && msg.type === 'text') {
    return `<div class="message msg-assistant" data-msg-index="${idx}">
      <div class="msg-label">ASSISTANT</div>
      <div class="msg-text">${highlightText(msg.content, activeQuery)}</div>
    </div>`;
  }

  if (msg.type === 'tool_use') {
    const inputJson = esc(JSON.stringify(msg.input, null, 2));
    return `<div class="message msg-tool" data-msg-index="${idx}">
      <div class="msg-label">
        <span>⚙ ${esc(msg.name)}</span>
        <span class="tool-toggle">▸ 展开</span>
      </div>
      <div class="tool-body">
        <div class="tool-input-pre">${inputJson}</div>
      </div>
    </div>`;
  }

  if (msg.type === 'tool_result') {
    const preview = esc((msg.content || '').slice(0, 500));
    const truncated = msg.content && msg.content.length > 500;
    return `<div class="message msg-tool" data-msg-index="${idx}">
      <div class="msg-label">
        <span>↩ ${esc(msg.name || 'Result')}</span>
        <span class="tool-toggle">▸ 展开</span>
      </div>
      <div class="tool-body">
        <div class="tool-input-pre">${preview}${truncated ? '\n...(truncated)' : ''}</div>
      </div>
    </div>`;
  }

  return '';
}

// ── Full-text search ───────────────────────────────────────────────────────
let searchMode = false;

function initHistorySearch() {
  const input = document.getElementById('historySearch');
  const searchBtn = document.getElementById('historySearchBtn');
  const clearBtn = document.getElementById('historyClearBtn');
  if (!input || !searchBtn || !clearBtn) return;

  searchBtn.addEventListener('click', () => runSearch(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(input.value); });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.style.display = 'none';
    searchMode = false;
    renderProjectList(allProjects);
  });

  // Delegated listener for search result clicks — attached once, not per search
  const list = document.getElementById('historyList');
  if (list) {
    list.addEventListener('click', e => {
      const item = e.target.closest('.session-search-item[data-id]');
      if (item) {
        selectSession(
          item.dataset.proj,
          item.dataset.id,
          item.dataset.source,
          { openInSessionQuery: item.dataset.query || '' }
        );
      }
    });
  }
}

async function runSearch(query) {
  if (!query.trim()) return;
  searchMode = true;
  document.getElementById('historyClearBtn').style.display = '';
  document.getElementById('historyList').innerHTML =
    '<div class="placeholder" style="padding:24px">搜索中...</div>';

  try {
    const data = await fetch(`/api/search?q=${encodeURIComponent(query)}`).then(r => r.json());
    const serverResults = data.results || [];

    // 服务端搜索消息内容；本地额外搜索自定义标题（服务端不存储自定义名称）
    const serverIds = new Set(serverResults.map(r => `${r.source || 'claude'}::${r.id}`));
    const q = query.toLowerCase();
    const localMatches = [];
    for (const proj of allProjects) {
      for (const s of proj.sessions) {
        if (serverIds.has(sessionKey(s))) continue;
        const custom = getCustomTitle(s.id);
        if (custom && custom.toLowerCase().includes(q)) {
          localMatches.push({
            id: s.id,
            projectDir: s.projectDir,
            source: s.source || 'claude',
            projectName: proj.name,
            title: custom,
            snippets: []
          });
        }
      }
    }

    renderSearchResults(sortSearchResults([...serverResults, ...localMatches], query), query);
  } catch {
    document.getElementById('historyList').innerHTML =
      '<div class="placeholder" style="padding:24px">搜索失败</div>';
  }
}

function renderSearchResults(results, query) {
  const list = document.getElementById('historyList');
  if (!results.length) {
    list.innerHTML = `<div class="placeholder" style="padding:24px">未找到匹配"${esc(query)}"的会话</div>`;
    return;
  }

  // Escape query through esc() so regex matches against already-entity-encoded text
  // and the matched portion is safe to reinsert into innerHTML via <mark>
  function highlight(text) {
    if (!query) return esc(text);
    const escapedQuery = esc(query);
    const re = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return esc(text).replace(re, '<mark>$1</mark>');
  }

  list.innerHTML = `<div style="font-size:10px;color:var(--text-dimmer);padding:6px 14px">找到 ${results.length} 个会话</div>` +
    results.map(r => {
      const displayTitle = getCustomTitle(r.id) || r.title;
      return `
      <div class="session-search-item" data-id="${esc(r.id)}" data-proj="${esc(r.projectDir)}" data-source="${esc(r.source || 'claude')}" data-query="${esc(query)}">
        <div class="search-result-project">${esc(r.projectName)}</div>
        <div class="search-result-title">
          <span class="badge badge-${esc(r.source || 'claude')} badge-mini">${esc(r.source || 'claude').toUpperCase()}</span>
          ${fmtOrigin(r.originSource) ? `<span class="origin-label">${esc(fmtOrigin(r.originSource))}</span>` : ''}
          ${highlight(displayTitle)}
        </div>
        ${r.snippets.map(s =>
          `<div class="search-snippet">...${highlight(s)}...</div>`
        ).join('')}
      </div>`
    }).join('');
  // Click listener is registered once in initHistorySearch() — not repeated here
}

// ── Markdown export ────────────────────────────────────────────────────────
function exportMarkdown() {
  if (!viewerSession) return;
  const s = viewerSession;
  const lines = [];

  lines.push(`# ${s.title.replace(/[\r\n]/g, ' ')}`);
  lines.push('');
  lines.push(`**Session:** \`${s.id}\`  `);
  lines.push(`**Project:** ${s.projectDir}  `);
  lines.push(`**Source:** ${s.source === 'codex' ? 'Codex' : 'Claude Code'}  `);
  lines.push(`**Last Activity:** ${s.lastActivity}  `);
  lines.push(`**Models:** ${(s.models||[]).join(', ')}  `);
  lines.push(`**Tokens:** ${(s.inputTokens||0)+(s.outputTokens||0)+(s.cacheTokens||0)}  `);
  lines.push(`**Cost:** $${(s.totalCost||0).toFixed(4)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of s.messages) {
    if (msg.role === 'user' && msg.type === 'text') {
      lines.push('**User:**');
      lines.push('');
      lines.push(msg.content);
      lines.push('');
    } else if (msg.role === 'assistant' && msg.type === 'text') {
      lines.push('**Assistant:**');
      lines.push('');
      lines.push(msg.content);
      lines.push('');
    } else if (msg.type === 'tool_use') {
      lines.push(`**Tool:** \`${msg.name}\``);
      lines.push('```json');
      lines.push(JSON.stringify(msg.input, null, 2));
      lines.push('```');
      lines.push('');
    } else if (msg.type === 'tool_result') {
      lines.push(`**Result:** \`${msg.name || 'Tool'}\``);
      lines.push('```');
      lines.push((msg.content || '').slice(0, 2000));
      lines.push('```');
      lines.push('');
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${s.id.slice(0, 8)}-${s.title.slice(0, 30).replace(/[\\/:*?"<>|]+/g, '-')}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Initialization ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initHistorySearch();
});
