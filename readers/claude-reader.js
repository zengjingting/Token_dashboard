// readers/claude-reader.js
// 直接读取 ~/.claude/projects/**/*.jsonl，统计 Claude Code 的 token 用量与费用。
// 用途：(1) 5h 时间段的小时分桶图表；(2) 给 History 标签页提供真实的 session UUID。
// 费用通过 ccusage 安装包内置的定价文件估算，不发出任何网络请求。
import { readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// ── Pricing: loaded dynamically from ccusage's offline data file ──────────
// ccusage keeps a bundled pricing table that updates when ccusage is upgraded.
// We resolve the symlink for the ccusage binary to find its dist directory,
// then scan for the file containing `input_cost_per_token`.

const CCUSAGE_BIN_CANDIDATES = [
  '/opt/homebrew/bin/ccusage',
  '/usr/local/bin/ccusage',
];

// 从 ccusage dist 目录中的某个 JS bundle 文件提取模型定价表。
// 返回 { "model-name": { i, o, cc, cr } }，若文件不含定价数据则返回 null。
function parsePricingFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  if (!content.includes('input_cost_per_token')) return null;
  const pricing = {};
  // Match flat objects: "model-name": { "field": number, ... }
  const entryRe = /"(claude[^"]+)":\s*\{([^}]+)\}/g;
  const fieldRe = (key) => new RegExp(`"${key}":\\s*([\\d.e+\\-]+)`);
  let m;
  while ((m = entryRe.exec(content)) !== null) {
    const body = m[2];
    const get = (k) => { const r = body.match(fieldRe(k)); return r ? Number(r[1]) : 0; };
    const i = get('input_cost_per_token');
    const o = get('output_cost_per_token');
    if (!i && !o) continue;
    pricing[m[1]] = {
      i,
      o,
      cc: get('cache_creation_input_token_cost'),
      cr: get('cache_read_input_token_cost'),
    };
  }
  return Object.keys(pricing).length > 0 ? pricing : null;
}

// 遍历已知的 ccusage 安装路径，解析符号链接找到 dist 目录，
// 扫描其中含定价数据的 JS 文件。若 ccusage 未安装则返回 null。
function loadCcusagePricing() {
  for (const bin of CCUSAGE_BIN_CANDIDATES) {
    try {
      const distDir = dirname(realpathSync(bin));
      for (const file of readdirSync(distDir)) {
        if (!file.endsWith('.js')) continue;
        try {
          const p = parsePricingFile(join(distDir, file));
          if (p) return p;
        } catch { /* skip unreadable files */ }
      }
    } catch { /* binary not found at this path */ }
  }
  return null;
}

// 定价表每进程只加载一次；null 表示 ccusage 未找到，费用将以 0 返回。
let _pricing = undefined;
function getPricing() {
  if (_pricing === undefined) _pricing = loadCcusagePricing();
  return _pricing;
}

// 根据 ccusage 定价表计算单条消息的 API 费用。
// 依次尝试精确匹配、大小写不敏感匹配、同族最新版本回退（opus/sonnet/haiku）。
function estimateCost(inp, out, cCreate, cRead, model) {
  const pricing = getPricing();
  if (!pricing) return 0;
  const name = String(model || '');
  let p = pricing[name];
  if (!p) {
    // Substring match for aliases / unversioned names (e.g. "claude-sonnet-4-latest")
    const lower = name.toLowerCase();
    for (const [key, val] of Object.entries(pricing)) {
      if (key.toLowerCase() === lower) { p = val; break; }
    }
  }
  if (!p) {
    // Family fallback using most-recent entry for that family in the pricing map
    const lower = name.toLowerCase();
    const family = lower.includes('opus') ? 'opus'
                 : lower.includes('haiku') ? 'haiku'
                 : lower.includes('sonnet') ? 'sonnet'
                 : null;
    if (family) {
      // Pick the entry with the highest version string for that family
      const candidates = Object.entries(pricing)
        .filter(([k]) => k.toLowerCase().includes(family))
        .sort(([a], [b]) => b.localeCompare(a));
      if (candidates.length) p = candidates[0][1];
    }
  }
  if (!p) return 0;
  return inp * p.i + out * p.o + cCreate * p.cc + cRead * p.cr;
}

// 递归查找目录下所有 .jsonl 文件（每个文件对应一个 Claude 会话）。
function getAllJsonlFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(join(entry.parentPath ?? entry.path, entry.name));
      }
    }
  } catch { /* dir not found */ }
  return results;
}

// 解析单行 JSONL，返回包含真实 token 用量的条目，无效行返回 null。
// '<synthetic>' 模型是 Claude Code 内部占位符，没有真实 token，直接跳过。
function parseUsageLine(line) {
  if (!line.trim()) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry.timestamp || !entry.message?.usage) return null;
  if (entry.message?.model === '<synthetic>') return null;  // internal placeholder, no real tokens
  return entry;
}

/**
 * 扫描 ~/.claude/projects/ 下所有 JSONL，聚合 [sinceMs, untilMs] 窗口内的用量。
 * 返回：summary 总计 + 按模型分组 + 按会话分组 + 按小时分桶（用于 5h 图表）。
 * untilMs 默认为 Infinity（无上界）。
 */
export function readClaudeUsageSince(sinceMs, untilMs = Infinity) {
  const files = getAllJsonlFiles(PROJECTS_DIR);
  const models = {};
  const sessions = {};
  const hourly = {};  // key: "YYYY-MM-DDTHH" → token/cost totals
  let inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0, totalCost = 0;

  for (const file of files) {
    // Skip files not modified in the window (+ 1h buffer)
    let stat;
    try { stat = statSync(file); } catch { continue; }
    // Buffer of 1h: JSONL files are append-only, so mtime ≈ time of last write.
    // We add a safety margin to avoid skipping files that were written just before
    // the window but haven't been flushed yet. 1h is conservative for the 5h use-case.
    if (stat.mtimeMs < sinceMs - 3_600_000) continue;

    // projectDir = basename of the directory containing the JSONL file
    // e.g. /…/.claude/projects/-Users-x-proj/session.jsonl → "-Users-x-proj"
    const projectDir = file.split('/').at(-2) ?? '';

    const lines = readFileSync(file, 'utf-8').split('\n');
    for (const line of lines) {
      const entry = parseUsageLine(line);
      if (!entry) continue;
      const ts = new Date(entry.timestamp).getTime();
      if (ts < sinceMs || ts > untilMs) continue;

      const usage = entry.message.usage;
      const inp    = usage.input_tokens || 0;
      const out    = usage.output_tokens || 0;
      const cCreate = usage.cache_creation_input_tokens || 0;
      const cRead   = usage.cache_read_input_tokens || 0;
      const model   = entry.message.model || 'unknown';
      const cost    = entry.costUSD ?? estimateCost(inp, out, cCreate, cRead, model);

      inputTokens          += inp;
      outputTokens         += out;
      cacheCreationTokens  += cCreate;
      cacheReadTokens      += cRead;
      totalCost            += cost;

      if (!models[model]) models[model] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 };
      models[model].inputTokens         += inp;
      models[model].outputTokens        += out;
      models[model].cacheCreationTokens += cCreate;
      models[model].cacheReadTokens     += cRead;
      models[model].cost                += cost;

      // per-hour bucket for 5h bar chart — use local time to avoid timezone shift
      const entryDate = new Date(entry.timestamp);
      const localHour = `${entryDate.getFullYear()}-${String(entryDate.getMonth()+1).padStart(2,'0')}-${String(entryDate.getDate()).padStart(2,'0')}T${String(entryDate.getHours()).padStart(2,'0')}`;
      if (!hourly[localHour]) hourly[localHour] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0 };
      hourly[localHour].inputTokens         += inp;
      hourly[localHour].outputTokens        += out;
      hourly[localHour].cacheCreationTokens += cCreate;
      hourly[localHour].cacheReadTokens     += cRead;
      hourly[localHour].totalCost           += cost;

      const sid = entry.sessionId || file;
      if (!sessions[sid]) {
        sessions[sid] = {
          id: sid, projectDir, source: 'claude',
          inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalCost: 0,
          models: new Set(), lastActivityMs: new Date(entry.timestamp).getTime()
        };
      }
      sessions[sid].inputTokens  += inp;
      sessions[sid].outputTokens += out;
      sessions[sid].cacheTokens  += cCreate + cRead;
      sessions[sid].totalCost    += cost;
      sessions[sid].models.add(model);
      const entryTs = new Date(entry.timestamp).getTime();
      if (entryTs > sessions[sid].lastActivityMs) sessions[sid].lastActivityMs = entryTs;
    }
  }

  const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
  return {
    summary: { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, totalCost },
    models: Object.entries(models).map(([name, v]) => ({
      name,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      cacheCreationTokens: v.cacheCreationTokens,
      cacheReadTokens: v.cacheReadTokens,
      totalTokens: v.inputTokens + v.outputTokens + v.cacheCreationTokens + v.cacheReadTokens,
      cost: v.cost
    })),
    sessions: Object.values(sessions).map(({ lastActivityMs, ...s }) => ({ ...s, lastActivity: new Date(lastActivityMs).toISOString(), models: [...s.models] })),
    hourlyBuckets: Object.entries(hourly)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => ({ label: key.slice(11) + ':00', ...v }))
  };
}
