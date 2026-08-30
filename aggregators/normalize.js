// aggregators/normalize.js
// 将 ccusage（Claude）和 @ccusage/codex 的原始输出合并成统一的 UsageReport 结构。
// 对外暴露两个入口：
//   buildReportFromCLI     — 1d / 3d / 7d / custom（数据来自 ccusage CLI）
//   buildReportFromHourly  — 5h（数据来自直读 JSONL，使用小时分桶）

/** ccusage 每日条目 → 内部 daily 行（claude 字段） */
function normalizeClaudeDaily(raw) {
  if (!raw?.daily) return [];
  return raw.daily.map(d => ({
    date: d.date,  // already "YYYY-MM-DD"
    claude: {
      inputTokens:         d.inputTokens        || 0,
      outputTokens:        d.outputTokens       || 0,
      cacheCreationTokens: d.cacheCreationTokens || 0,
      cacheReadTokens:     d.cacheReadTokens    || 0,
      totalCost:           d.totalCost          || 0
    }
  }));
}

/** @ccusage/codex 日期字符串 "Apr 08, 2026" → "YYYY-MM-DD" */
function parseCodexDate(str) {
  if (typeof str !== 'string') throw new Error(`parseCodexDate: invalid input "${str}"`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  const m = str.trim().match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) throw new Error(`parseCodexDate: cannot parse "${str}"`);

  const monthMap = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
  };
  const mon = m[1].slice(0, 1).toUpperCase() + m[1].slice(1, 3).toLowerCase();
  const month = monthMap[mon];
  if (!month) throw new Error(`parseCodexDate: unknown month "${m[1]}"`);

  const day = String(Number(m[2])).padStart(2, '0');
  return `${m[3]}-${month}-${day}`;
}

/** codex 每日条目 → 内部 daily 行（codex 字段） */
function normalizeCodexDaily(raw) {
  if (!raw?.daily) return [];
  return raw.daily.map(d => ({
    date: parseCodexDate(d.date),
    codex: {
      inputTokens:           d.inputTokens           || 0,
      outputTokens:          d.outputTokens          || 0,
      cachedInputTokens:     d.cachedInputTokens     || 0,
      reasoningOutputTokens: d.reasoningOutputTokens || 0,
      totalCost:             d.costUSD               || 0
    }
  }));
}

/** 以日期为 key 合并 Claude + Codex 每日数组，某天只有一方数据时另一方为 null */
function mergeDailyArrays(claudeRows, codexRows) {
  const map = new Map();
  for (const r of claudeRows) map.set(r.date, { date: r.date, claude: r.claude, codex: null });
  for (const r of codexRows) {
    if (map.has(r.date)) map.get(r.date).codex = r.codex;
    else map.set(r.date, { date: r.date, claude: null, codex: r.codex });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function sumClaude(a, b) {
  if (!a && !b) return null;
  return {
    inputTokens:         (a?.inputTokens || 0) + (b?.inputTokens || 0),
    outputTokens:        (a?.outputTokens || 0) + (b?.outputTokens || 0),
    cacheCreationTokens: (a?.cacheCreationTokens || 0) + (b?.cacheCreationTokens || 0),
    cacheReadTokens:     (a?.cacheReadTokens || 0) + (b?.cacheReadTokens || 0),
    totalCost:           (a?.totalCost || 0) + (b?.totalCost || 0)
  };
}

function sumCodex(a, b) {
  if (!a && !b) return null;
  return {
    inputTokens:           (a?.inputTokens || 0) + (b?.inputTokens || 0),
    outputTokens:          (a?.outputTokens || 0) + (b?.outputTokens || 0),
    cachedInputTokens:     (a?.cachedInputTokens || 0) + (b?.cachedInputTokens || 0),
    reasoningOutputTokens: (a?.reasoningOutputTokens || 0) + (b?.reasoningOutputTokens || 0),
    totalCost:             (a?.totalCost || 0) + (b?.totalCost || 0)
  };
}

// 对 '1d' 时间段，ccusage 可能因跨午夜返回多行，将它们压缩为一行。
// 日期取最新，数据累加，确保图表只显示一根柱子。
function squashDailyFor1d(daily) {
  if (!Array.isArray(daily) || daily.length <= 1) return daily;
  const latestDate = daily.reduce((max, r) => (r.date > max ? r.date : max), daily[0].date);
  const merged = daily.reduce((acc, r) => ({
    claude: sumClaude(acc.claude, r.claude),
    codex:  sumCodex(acc.codex, r.codex)
  }), { claude: null, codex: null });
  return [{ date: latestDate, claude: merged.claude, codex: merged.codex }];
}

/** 从 ccusage modelBreakdowns + codex models 构建模型列表，按费用降序排列 */
function buildModels(claudeRaw, codexRaw) {
  const map = {};
  for (const day of (claudeRaw?.daily || [])) {
    for (const mb of (day.modelBreakdowns || [])) {
      if (!map[mb.modelName]) map[mb.modelName] = { name: mb.modelName, totalTokens: 0, cost: 0 };
      map[mb.modelName].totalTokens += mb.inputTokens + mb.outputTokens + mb.cacheCreationTokens + mb.cacheReadTokens;
      map[mb.modelName].cost        += mb.cost;
    }
  }
  for (const day of (codexRaw?.daily || [])) {
    for (const [name, m] of Object.entries(day.models || {})) {
      if (!map[name]) map[name] = { name, totalTokens: 0, cost: 0 };
      map[name].totalTokens += m.totalTokens || 0;
    }
    // codex cost lives at day level, assign to first model
    const firstModel = Object.keys(day.models || {})[0];
    if (firstModel && map[firstModel] && day.costUSD) {
      map[firstModel].cost += day.costUSD;
    }
  }
  const models = Object.values(map).sort((a, b) => b.cost - a.cost);
  const totalCost = models.reduce((s, m) => s + m.cost, 0);
  return models.map(m => ({ ...m, pct: totalCost > 0 ? (m.cost / totalCost * 100).toFixed(1) : '0' }));
}

/** 从合并后的每日行汇总全局 token 和费用，分别记录 Claude 和 Codex 贡献 */
function buildSummary(daily) {
  let inputTokens = 0, outputTokens = 0;
  let cacheCreationTokens = 0, cacheReadTokens = 0;
  let claudeCacheReadTokens = 0;
  let claudeCost = 0, codexCost = 0;
  for (const day of daily) {
    if (day.claude) {
      inputTokens           += day.claude.inputTokens;
      outputTokens          += day.claude.outputTokens;
      cacheCreationTokens   += day.claude.cacheCreationTokens;
      cacheReadTokens       += day.claude.cacheReadTokens;
      claudeCacheReadTokens += day.claude.cacheReadTokens;
      claudeCost            += day.claude.totalCost;
    }
    if (day.codex) {
      inputTokens     += day.codex.inputTokens;
      outputTokens    += day.codex.outputTokens;
      cacheReadTokens += day.codex.cachedInputTokens || 0;
      codexCost       += day.codex.totalCost;
    }
  }
  return {
    inputTokens, outputTokens,
    cacheCreationTokens, cacheReadTokens,
    claudeCacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    totalCost: claudeCost + codexCost,
    claudeCost, codexCost
  };
}

/** Normalize ccusage session output */
const CLAUDE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstProjectSegment(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'Unknown Project') return '';
  const first = trimmed.split('/')[0];
  return first.startsWith('-') ? first : '';
}

function lastPathSegment(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === 'Unknown Project') return '';
  const parts = trimmed.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

// 从 ccusage 会话记录推断真实的 session UUID。
// ccusage 有时将 UUID 放在 projectPath 末尾而非 sessionId 字段（按项目聚合时）。
function deriveClaudeSessionId(session) {
  const sid = String(session?.sessionId || '').trim();
  if (CLAUDE_UUID_RE.test(sid)) return sid;
  const tail = lastPathSegment(session?.projectPath);
  if (CLAUDE_UUID_RE.test(tail)) return tail;
  // ccusage session --json returns project-dir paths (e.g. "-Users-ting-Documents-…")
  // as sessionId when it aggregates by project rather than individual session.
  // Accept any non-empty ID so project-level rows still appear in the session list.
  if (sid) return sid;
  return '';
}

// 从 ccusage 会话记录提取编码后的项目目录名（如 "-Users-ting-Documents-proj"）。
function deriveClaudeProjectDir(session, resolvedSessionId) {
  const byPath = firstProjectSegment(session?.projectPath);
  if (byPath) return byPath;

  const direct = firstProjectSegment(session?.projectDir);
  if (direct) return direct;

  // Fallback: if sessionId itself is an encoded dir and this row is not a session UUID.
  const sid = String(session?.sessionId || '');
  if (sid.startsWith('-') && sid !== resolvedSessionId) return sid;
  return '';
}

// 将 ccusage session 输出规范化为内部 session 对象列表。
// 过滤掉无法映射到具体 UUID 的项目聚合行（它们没有对应的 JSONL 文件可跳转）。
function normalizeClaudeSessions(raw) {
  if (!raw?.sessions) return [];
  return raw.sessions
    .map((s) => {
      const id = deriveClaudeSessionId(s);
      return {
        id,
        projectDir: deriveClaudeProjectDir(s, id),
        source: 'claude',
        inputTokens: s.inputTokens || 0,
        outputTokens: s.outputTokens || 0,
        cacheTokens: (s.cacheCreationTokens || 0) + (s.cacheReadTokens || 0),
        totalCost: s.totalCost || 0,
        lastActivity: s.lastActivity,
        models: s.modelsUsed || []
      };
    })
    // Drop project-aggregate rows that cannot map to a concrete session UUID.
    .filter((s) => !!s.id);
}

/** @ccusage/codex session 输出 → 内部 session 对象列表 */
function normalizeCodexSessions(raw) {
  if (!raw?.sessions) return [];
  return raw.sessions.map(s => ({
    id:           s.sessionId,
    projectDir:   firstProjectSegment(s.projectPath),
    source:       'codex',
    inputTokens:  s.inputTokens       || 0,
    outputTokens: s.outputTokens      || 0,
    cacheTokens:  s.cachedInputTokens || 0,
    totalCost:    s.costUSD           || 0,
    lastActivity: s.lastActivity,
    models:       Object.keys(s.models || {})
  }));
}

/**
 * Build UsageReport from ccusage + codex CLI output (1d / 3d / 7d / custom).
 * claudeSessions may be either a raw ccusage object (normalized here) or an
 * already-normalized array (from readClaudeUsageSince — passed through as-is).
 */
export function buildReportFromCLI({ period, claudeDaily, codexDaily, claudeSessions, codexSessions }) {
  const mergedDaily = mergeDailyArrays(normalizeClaudeDaily(claudeDaily), normalizeCodexDaily(codexDaily));
  const daily = period === '1d' ? squashDailyFor1d(mergedDaily) : mergedDaily;
  const claudeList = Array.isArray(claudeSessions)
    ? claudeSessions
    : normalizeClaudeSessions(claudeSessions);
  const sessions = [
    ...claudeList,
    ...normalizeCodexSessions(codexSessions)
  ].sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  return {
    updatedAt: new Date().toISOString(),
    period,
    summary: buildSummary(daily),
    models:   buildModels(claudeDaily, codexDaily),
    daily,
    sessions
  };
}

/**
 * Build UsageReport from direct JSONL read (5h period).
 * claudeHourly is the return value of readClaudeUsageSince().
 */
export function buildReportFromHourly({ period, claudeHourly, codexHourly = { summary: {}, models: [], sessions: [], hourlyBuckets: [] } }) {
  const claudeSummary = claudeHourly?.summary || {};
  const codexSummary = codexHourly?.summary || {};
  const totalCost = (claudeSummary.totalCost || 0) + (codexSummary.totalCost || 0);

  // 合并 Claude 和 Codex 的小时分桶，同一小时的数据合入同一行
  const byLabel = new Map();
  for (const h of (claudeHourly.hourlyBuckets || [])) {
    byLabel.set(h.label, {
      date: h.label,
      claude: {
        inputTokens:         h.inputTokens || 0,
        outputTokens:        h.outputTokens || 0,
        cacheCreationTokens: h.cacheCreationTokens || 0,
        cacheReadTokens:     h.cacheReadTokens || 0,
        totalCost:           h.totalCost || 0
      },
      codex: null
    });
  }
  for (const h of (codexHourly.hourlyBuckets || [])) {
    const codex = {
      inputTokens:           h.inputTokens || 0,
      outputTokens:          h.outputTokens || 0,
      cachedInputTokens:     h.cachedInputTokens || 0,
      reasoningOutputTokens: h.reasoningOutputTokens || 0,
      totalCost:             h.totalCost || 0
    };
    if (byLabel.has(h.label)) byLabel.get(h.label).codex = codex;
    else {
      byLabel.set(h.label, {
        date: h.label,
        claude: null,
        codex
      });
    }
  }
  const daily = [...byLabel.values()].sort((a, b) => a.date.localeCompare(b.date));

  const modelMap = {};
  for (const m of (claudeHourly.models || [])) {
    modelMap[m.name] = {
      name: m.name,
      totalTokens: m.totalTokens || 0,
      cost: m.cost || 0
    };
  }
  for (const m of (codexHourly.models || [])) {
    if (!modelMap[m.name]) modelMap[m.name] = { name: m.name, totalTokens: 0, cost: 0 };
    modelMap[m.name].totalTokens += m.totalTokens || 0;
    modelMap[m.name].cost += m.cost || 0;
  }
  const models = Object.values(modelMap).map(m => ({
    ...m,
    pct: totalCost > 0 ? (m.cost / totalCost * 100).toFixed(1) : '0'
  })).sort((a, b) => (b.cost - a.cost) || (b.totalTokens - a.totalTokens));

  const sessions = [
    ...(claudeHourly.sessions || []),
    ...(codexHourly.sessions || [])
  ].sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  return {
    updatedAt: new Date().toISOString(),
    period,
    summary: {
      inputTokens: (claudeSummary.inputTokens || 0) + (codexSummary.inputTokens || 0),
      outputTokens: (claudeSummary.outputTokens || 0) + (codexSummary.outputTokens || 0),
      cacheCreationTokens: claudeSummary.cacheCreationTokens || 0,
      cacheReadTokens: (claudeSummary.cacheReadTokens || 0) + (codexSummary.cacheReadTokens || 0),
      claudeCacheReadTokens: claudeSummary.cacheReadTokens || 0,
      totalTokens:
        (claudeSummary.inputTokens || 0) + (codexSummary.inputTokens || 0) +
        (claudeSummary.outputTokens || 0) + (codexSummary.outputTokens || 0) +
        (claudeSummary.cacheCreationTokens || 0) +
        (claudeSummary.cacheReadTokens || 0) + (codexSummary.cacheReadTokens || 0),
      totalCost,
      claudeCost: claudeSummary.totalCost || 0,
      codexCost: codexSummary.totalCost || 0
    },
    models,
    daily,
    sessions
  };
}
