// readers/codex-reader.js
// 直接读取 ~/.codex/sessions/**/*.jsonl，聚合 Codex token 用量。
// 仅用于 5h 时间段（其他时间段由 cli-runner.js 调用 ccusage-codex CLI）。
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

// 递归查找目录下所有 .jsonl 文件（每个文件对应一个 Codex 会话）。
function getAllJsonlFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(join(entry.parentPath ?? entry.path, entry.name));
      }
    }
  } catch {
    // directory may not exist on fresh setups
  }
  return results;
}

// 将时间戳转为 "YYYY-MM-DDTHH" 格式的小时分桶 key。
function toHourKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}`;
}

// 返回全零的 summary 对象，避免重复字面量。
function makeEmptySummary() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0
  };
}

/**
 * 扫描 ~/.codex/sessions/ 下所有 JSONL，聚合 sinceMs 之后的 token 用量。
 * 数据来源：每条 event_msg(token_count) 事件中的 last_token_usage 字段。
 * 返回：summary 总计 + 按模型分组 + 按会话分组 + 按小时分桶（用于 5h 图表）。
 */
export function readCodexUsageSince(sinceMs) {
  const files = getAllJsonlFiles(SESSIONS_DIR);
  const hourly = {};
  const models = {};
  const sessions = {};
  const summary = makeEmptySummary();

  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    // 跳过修改时间早于窗口的文件（+1h 缓冲，与 claude-reader.js 保持一致）
    if (stat.mtimeMs < sinceMs - 3_600_000) continue;

    const relId = file.replace(`${SESSIONS_DIR}/`, '').replace(/\.jsonl$/, '');
    let sessionModel = 'gpt-5.3-codex';

    const lines = readFileSync(file, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      // turn_context 事件携带本次会话使用的模型名
      if (entry?.type === 'turn_context' && entry?.payload?.model) {
        sessionModel = entry.payload.model;
      }

      // 只处理 token_count 类型的事件，跳过其他所有行
      if (!(entry?.type === 'event_msg' && entry?.payload?.type === 'token_count')) continue;
      const usage = entry?.payload?.info?.last_token_usage;
      if (!usage) continue;

      const ts = new Date(entry.timestamp).getTime();
      if (!Number.isFinite(ts) || ts < sinceMs) continue;

      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cachedInputTokens = usage.cached_input_tokens || 0;

      summary.inputTokens += inputTokens;
      summary.outputTokens += outputTokens;
      summary.cacheReadTokens += cachedInputTokens;
      summary.totalTokens += inputTokens + outputTokens + cachedInputTokens;

      if (!models[sessionModel]) {
        models[sessionModel] = { name: sessionModel, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, cost: 0 };
      }
      models[sessionModel].inputTokens += inputTokens;
      models[sessionModel].outputTokens += outputTokens;
      models[sessionModel].cachedInputTokens += cachedInputTokens;
      models[sessionModel].totalTokens += inputTokens + outputTokens + cachedInputTokens;

      const hourKey = toHourKey(entry.timestamp);
      if (!hourly[hourKey]) {
        hourly[hourKey] = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalCost: 0 };
      }
      hourly[hourKey].inputTokens += inputTokens;
      hourly[hourKey].outputTokens += outputTokens;
      hourly[hourKey].cachedInputTokens += cachedInputTokens;

      if (!sessions[relId]) {
        sessions[relId] = {
          id: relId,
          source: 'codex',
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          totalCost: 0,
          models: new Set(),
          lastActivityMs: ts
        };
      }
      sessions[relId].inputTokens += inputTokens;
      sessions[relId].outputTokens += outputTokens;
      sessions[relId].cacheTokens += cachedInputTokens;
      sessions[relId].models.add(sessionModel);
      if (ts > sessions[relId].lastActivityMs) sessions[relId].lastActivityMs = ts;
    }
  }

  return {
    summary,
    models: Object.values(models).sort((a, b) => b.totalTokens - a.totalTokens),
    sessions: Object.values(sessions).map(({ lastActivityMs, ...s }) => ({
      ...s,
      models: [...s.models],
      lastActivity: new Date(lastActivityMs).toISOString()
    })),
    hourlyBuckets: Object.entries(hourly)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => ({ label: key.slice(11) + ':00', ...v }))
  };
}
