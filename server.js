// server.js
// Express HTTP 服务器，对外暴露 JSON/SSE 接口，并托管 public/ 静态文件。
// 数据流：readers/ 解析原始 JSONL → aggregators/normalize.js 合并成 UsageReport → 接口返回 JSON。
// 所有路由绑定到 127.0.0.1（仅回环地址），阻止局域网访问。
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readClaudeUsageSince } from './readers/claude-reader.js';
import { readCodexUsageSince } from './readers/codex-reader.js';
import { getClaudeDailyData, getClaudeSessionData, getCodexDailyData, getCodexSessionData } from './readers/cli-runner.js';
import { listSessions, readSession, readSessionById, deleteSession, searchSessions, getProjectStats, getDailyActivity } from './readers/chat-reader.js';
import { listCodexSessions, readCodexSession, deleteCodexSession, searchCodexSessions } from './readers/codex-chat-reader.js';
import { buildReportFromCLI, buildReportFromHourly } from './aggregators/normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3333;

app.use(express.static(join(__dirname, 'public')));

const VALID_PERIODS = new Set(['5h', '1d', '3d', '7d', 'custom']);
const ISO_DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;

// Fix 4: SSE connection cap to prevent DoS via runaway CLI spawns
let sseCount = 0;
const SSE_MAX = 5;

// 去除所有非字母字符后转小写，用于模糊匹配项目名（如 "my-project!" → "myproject"）
function lettersOnlyKey(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  return key || '';
}

// 为项目生成稳定的合并 key，确保 Claude 和 Codex 同一项目的条目被合并
function projectMergeKey(project) {
  const byName = lettersOnlyKey(project?.name);
  if (byName) return byName;
  const byDir = lettersOnlyKey(project?.dirName);
  if (byDir) return byDir;
  return `raw:${String(project?.dirName || '').toLowerCase()}`;
}

// 将时间段字符串转为绝对的 { since, until } 日期范围。
// '5h' 返回 null，由 fetchReport 单独处理（用毫秒偏移量而非日期）。
function getDateRange(period, since, until) {
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Fix 5: only accept well-formed ISO dates for custom range
  const sinceDate = since && ISO_DATE_RE.test(since) ? new Date(since) : today;
  const untilDate = until && ISO_DATE_RE.test(until) ? new Date(until) : now;
  switch (period) {
    case '1d':    return { since: today,                              until: now };
    case '3d':    return { since: new Date(+today - 2 * 86_400_000), until: now };
    case '7d':    return { since: new Date(+today - 6 * 86_400_000), until: now };
    case 'custom':return { since: sinceDate, until: untilDate };
    default:      return null; // 5h handled separately
  }
}

// 组装指定时间段的 UsageReport。
// '5h' 直接读 JSONL（亚分钟级新鲜度）；其他时间段调用 ccusage CLI（精确的历史费用）。
async function fetchReport(period, since, until) {
  if (period === '5h') {
    const sinceMs = Date.now() - 5 * 3_600_000;
    const claudeHourly = readClaudeUsageSince(sinceMs);
    const codexHourly = readCodexUsageSince(sinceMs);
    return buildReportFromHourly({ period: '5h', claudeHourly, codexHourly });
  }
  const range = getDateRange(period, since, until);
  const sinceMs = range.since.getTime();
  const untilMs = range.until.getTime();
  // Claude sessions: read JSONL directly so IDs are real session UUIDs (enables
  // History tab jumps and custom-title sync). Daily summary still comes from the
  // ccusage CLI which has accurate per-day cost breakdowns.
  const [claudeDaily, claudeSessions, codexDaily, codexSessions] = await Promise.all([
    Promise.resolve().then(() => getClaudeDailyData(range.since, range.until)),
    Promise.resolve().then(() => readClaudeUsageSince(sinceMs, untilMs).sessions),
    Promise.resolve().then(() => getCodexDailyData(range.since, range.until)),
    Promise.resolve().then(() => getCodexSessionData(range.since, range.until))
  ]);
  return buildReportFromCLI({ period, claudeDaily, codexDaily, claudeSessions, codexSessions });
}

// REST endpoint
app.get('/api/usage', async (req, res) => {
  // Fix 2: validate period
  const period = VALID_PERIODS.has(req.query.period) ? req.query.period : '1d';
  const { since, until } = req.query;
  try {
    res.json(await fetchReport(period, since, until));
  } catch (err) {
    // Fix 3: don't leak internal error details
    console.error('[/api/usage]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// SSE endpoint：推送实时数据更新，每 30 秒刷新一次
app.get('/api/stream', (req, res) => {
  // Fix 4: cap concurrent SSE connections
  if (sseCount >= SSE_MAX) {
    res.status(429).json({ error: 'Too many SSE connections' });
    return;
  }

  // Fix 2: validate period
  const period = VALID_PERIODS.has(req.query.period) ? req.query.period : '1d';
  const { since, until } = req.query;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  sseCount++;

  const push = async () => {
    try {
      const report = await fetchReport(period, since, until);
      res.write(`data: ${JSON.stringify(report)}\n\n`);
    } catch (err) {
      // Fix 3: don't leak internal error details over SSE
      console.error('[/api/stream]', err);
      res.write(`data: ${JSON.stringify({ error: 'Internal error' })}\n\n`);
    }
  };

  push();
  const interval = setInterval(push, 30_000);
  req.on('close', () => { clearInterval(interval); sseCount--; });
});

// 返回合并后的 Claude + Codex 项目/会话树，按最近活动时间排序
app.get('/api/history/sessions', (_req, res) => {
  try {
    const claude = listSessions();
    const codex = listCodexSessions();

    // 以 letters-only key 合并同名项目，避免 Claude/Codex 条目重复出现
    const merged = new Map();
    for (const proj of (claude.projects || [])) {
      merged.set(projectMergeKey(proj), { ...proj, sessions: [...proj.sessions] });
    }
    for (const proj of (codex.projects || [])) {
      const key = projectMergeKey(proj);
      if (merged.has(key)) {
        merged.get(key).sessions.push(...proj.sessions);
      } else {
        merged.set(key, { ...proj, sessions: [...proj.sessions] });
      }
    }

    const projects = [...merged.values()];
    for (const proj of projects) {
      proj.sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    }
    projects.sort((a, b) => {
      const aLast = a.sessions[0]?.lastActivity || '';
      const bLast = b.sessions[0]?.lastActivity || '';
      return bLast.localeCompare(aLast);
    });

    res.json({ projects });
  } catch (err) {
    console.error('[/api/history/sessions]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 返回单个会话的完整消息内容（Claude 或 Codex）
app.get('/api/history/session', (req, res) => {
  const { project, id, source } = req.query;
  if (!id) {
    res.status(400).json({ error: 'Invalid parameters' });
    return;
  }

  try {
    let session;
    if (source === 'codex') {
      session = readCodexSession(id);
    } else {
      if (/[./\\]/.test(id)) {
        res.status(400).json({ error: 'Invalid parameters' });
        return;
      }
      if (project) {
        if (/[./\\]/.test(project)) {
          res.status(400).json({ error: 'Invalid parameters' });
          return;
        }
        session = readSession(project, id);
      } else {
        session = readSessionById(id);
      }
      if (session) session.source = 'claude';
    }

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    console.error('[/api/history/session]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 从磁盘永久删除会话的 JSONL 文件（不可恢复）
app.delete('/api/history/session', (req, res) => {
  const { project, id, source } = req.query;
  if (!id) {
    res.status(400).json({ error: 'Invalid parameters' });
    return;
  }

  try {
    let deleted = false;

    if (source === 'codex') {
      deleted = deleteCodexSession(id);
    } else {
      if (/[./\\]/.test(id)) {
        res.status(400).json({ error: 'Invalid parameters' });
        return;
      }

      let resolvedProject = project;
      if (!resolvedProject) {
        const session = readSessionById(id);
        if (session) resolvedProject = session.projectDir;
      }
      if (!resolvedProject || /[./\\]/.test(resolvedProject)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      deleted = deleteSession(resolvedProject, id);
    }

    if (!deleted) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[/api/history/session DELETE]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 全文搜索 Claude + Codex 会话内容，返回带上下文片段的结果，按最近活动排序
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').slice(0, 200);
  try {
    const claude = searchSessions(q);
    const codex = searchCodexSessions(q);
    const results = [...(claude.results || []), ...(codex.results || [])];
    results.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
    res.json({ query: q, results });
  } catch (err) {
    console.error('[/api/search]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 返回过去 90 天的每日 token + 费用统计，供热力图使用
app.get('/api/analytics/heatmap', (_req, res) => {
  try {
    const sinceMs = Date.now() - 90 * 86_400_000;
    res.json({ days: getDailyActivity(sinceMs) });
  } catch (err) {
    console.error('[/api/analytics/heatmap]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 返回按费用排序的项目级 token + 费用分布
app.get('/api/analytics/projects', (_req, res) => {
  try {
    res.json({ projects: getProjectStats() });
  } catch (err) {
    console.error('[/api/analytics/projects]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Fix 1: bind to loopback only — blocks LAN access
app.listen(PORT, '127.0.0.1', () => console.log(`Token Dashboard → http://localhost:${PORT}`));
