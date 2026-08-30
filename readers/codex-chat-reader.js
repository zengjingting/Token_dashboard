// readers/codex-chat-reader.js
// 解析 Codex JSONL 会话文件，供 History 标签页使用。
// Codex 使用不同于 Claude Code 的事件格式：response_item / event_msg / turn_context。
import { readFileSync, readdirSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { homedir } from 'node:os';
import { decodeDirName } from './chat-reader.js';

const DEFAULT_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
function sessionsDir() { return process.env.CODEX_SESSIONS_DIR || DEFAULT_SESSIONS_DIR; }

// 将工作目录路径（如 "/Users/ting/proj"）转为编码目录名（"-Users-ting-proj"），
// 与 chat-reader.js 的格式对齐，使两侧可以共享项目合并逻辑。
function cwdToEncodedDir(cwd) {
  if (!cwd) return null;
  return '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
}

function parseLine(line) {
  if (!line.trim()) return null;
  try { return JSON.parse(line); } catch { return null; }
}

// 将文件绝对路径转为相对 session ID（去掉 baseDir 前缀和 .jsonl 后缀）。
// Codex 会话可嵌套在子目录中，所以 ID 形如 "subdir/uuid"。
function toSessionId(baseDir, filePath) {
  const rel = relative(baseDir, filePath);
  if (!rel || rel.startsWith('..')) return null;
  return rel.replace(/\.jsonl$/, '').split(sep).join('/');
}

// 将 session ID 还原为绝对文件路径，拒绝含路径穿越字符的 ID（安全防护）。
function toSessionFilePath(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (sessionId.startsWith('/') || sessionId.includes('\\')) return null;

  const parts = sessionId.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  return `${join(sessionsDir(), ...parts)}.jsonl`;
}

// 删除会话文件后，向上逐级清理现在为空的父目录，直到 rootDir 为止。
// 避免 ~/.codex/sessions/ 下因删除会话而遗留空目录。
function cleanupEmptyParents(filePath, rootDir) {
  let current = dirname(filePath);
  while (current && current !== rootDir && current.startsWith(`${rootDir}${sep}`)) {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      break;
    }
    if (entries.length > 0) break;
    try {
      rmdirSync(current);
    } catch {
      break;
    }
    current = dirname(current);
  }
}

// 读取并解析单个 Codex JSONL 会话文件。
// 通过 response_item 事件重建对话，token 统计来自 event_msg(token_count) 事件。
export function parseCodexSessionFile(filePath) {
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const messages = [];
  const toolNameById = {};
  const modelsSet = new Set();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;
  let lastActivity = null;
  let cwd = null;
  let originSource = '';

  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry) continue;

    const ts = entry.timestamp;
    if (ts && (!lastActivity || ts > lastActivity)) {
      lastActivity = ts;
    }

    if (entry.type === 'session_meta') {
      cwd = entry.payload?.cwd || cwd;
      originSource = entry.payload?.originator || originSource;
      continue;
    }

    if (entry.type === 'turn_context') {
      if (entry.payload?.model) modelsSet.add(entry.payload.model);
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
      const usage = entry.payload?.info?.last_token_usage;
      if (usage) {
        inputTokens += usage.input_tokens || 0;
        outputTokens += usage.output_tokens || 0;
        cacheTokens += usage.cached_input_tokens || 0;
      }
      continue;
    }

    if (entry.type === 'response_item') {
      const p = entry.payload;
      if (!p) continue;

      if (p.type === 'reasoning') continue;
      if (p.type === 'message' && p.role === 'developer') continue;

      if (p.type === 'message') {
        const contentBlocks = p.content || [];
        for (const block of contentBlocks) {
          if (p.role === 'user' && block.type === 'input_text') {
            const text = (block.text || '').trim();
            // 跳过空内容和 Codex 注入的环境上下文块
            if (!text || text.startsWith('<environment_context>')) continue;
            messages.push({ role: 'user', type: 'text', content: text });
          } else if (p.role === 'assistant' && block.type === 'output_text') {
            const text = (block.text || '').trim();
            if (text) messages.push({ role: 'assistant', type: 'text', content: text });
          }
        }
      }

      if (p.type === 'function_call') {
        let input = {};
        try { input = JSON.parse(p.arguments || '{}'); } catch { /* keep empty */ }
        toolNameById[p.call_id] = p.name;
        messages.push({
          role: 'assistant',
          type: 'tool_use',
          toolId: p.call_id,
          name: p.name,
          input
        });
      }

      if (p.type === 'function_call_output') {
        messages.push({
          role: 'user',
          type: 'tool_result',
          toolId: p.call_id,
          name: toolNameById[p.call_id] || 'Tool',
          content: p.output || ''
        });
      }

      if (p.type === 'custom_tool_call') {
        toolNameById[p.call_id] = p.name;
        messages.push({
          role: 'assistant',
          type: 'tool_use',
          toolId: p.call_id,
          name: p.name,
          input: p.input || {}
        });
      }

      if (p.type === 'custom_tool_call_output') {
        messages.push({
          role: 'user',
          type: 'tool_result',
          toolId: p.call_id,
          name: toolNameById[p.call_id] || 'Tool',
          content: p.output || ''
        });
      }
    }
  }

  return {
    messages,
    inputTokens,
    outputTokens,
    cacheTokens,
    totalCost: 0,
    models: [...modelsSet],
    lastActivity,
    cwd,
    originSource
  };
}

// 递归查找目录下所有 .jsonl 文件。
function getAllJsonlFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(join(entry.parentPath ?? entry.path, entry.name));
      }
    }
  } catch {
    // directory may not exist
  }
  return results;
}

// 取第一条长度大于 5 的 user 文本消息作为会话标题。
function extractTitle(messages) {
  for (const msg of messages) {
    if (msg.role === 'user' && msg.type === 'text' && msg.content?.trim().length > 5) {
      return msg.content.trim().slice(0, 80);
    }
  }
  return 'Untitled';
}

// 返回所有 Codex 会话，以会话的工作目录为依据分组成项目，按最近活动排序。
export function listCodexSessions() {
  const dir = sessionsDir();
  if (!existsSync(dir)) return { projects: [] };

  const files = getAllJsonlFiles(dir);
  const byProject = new Map();

  for (const file of files) {
    const relId = toSessionId(dir, file);
    if (!relId) continue;
    try {
      const parsed = parseCodexSessionFile(file);
      const encodedDir = cwdToEncodedDir(parsed.cwd) || 'codex';

      if (!byProject.has(encodedDir)) {
        byProject.set(encodedDir, { dirName: encodedDir, name: decodeDirName(encodedDir), sessions: [] });
      }

      byProject.get(encodedDir).sessions.push({
        id: relId,
        projectDir: encodedDir,
        source: 'codex',
        originSource: parsed.originSource || '',
        title: extractTitle(parsed.messages),
        lastActivity: parsed.lastActivity || new Date(0).toISOString(),
        messageCount: parsed.messages.length,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cacheTokens: parsed.cacheTokens,
        totalCost: parsed.totalCost,
        models: parsed.models
      });
    } catch {
      continue;
    }
  }

  const projects = [...byProject.values()];
  for (const proj of projects) {
    proj.sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }
  projects.sort((a, b) => {
    const aLast = a.sessions[0]?.lastActivity || '';
    const bLast = b.sessions[0]?.lastActivity || '';
    return bLast.localeCompare(aLast);
  });

  return { projects };
}

// 通过相对 session ID 读取 Codex 会话的完整消息内容。
export function readCodexSession(sessionId) {
  const filePath = toSessionFilePath(sessionId);
  if (!filePath) return null;
  if (!existsSync(filePath)) return null;

  const parsed = parseCodexSessionFile(filePath);
  return {
    id: sessionId,
    projectDir: cwdToEncodedDir(parsed.cwd) || 'codex',
    source: 'codex',
    originSource: parsed.originSource || '',
    title: extractTitle(parsed.messages),
    messages: parsed.messages,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheTokens: parsed.cacheTokens,
    totalCost: parsed.totalCost,
    models: parsed.models,
    lastActivity: parsed.lastActivity || new Date(0).toISOString()
  };
}

// 永久删除 Codex 会话文件，并清理因此产生的空父目录。
export function deleteCodexSession(sessionId) {
  const filePath = toSessionFilePath(sessionId);
  if (!filePath) return false;
  if (!existsSync(filePath)) return false;

  try {
    unlinkSync(filePath);
    cleanupEmptyParents(filePath, sessionsDir());
    return true;
  } catch {
    return false;
  }
}

// 在所有 Codex 会话消息中全文搜索，返回含上下文片段的匹配结果，按最近活动排序。
export function searchCodexSessions(query) {
  if (!query?.trim()) return { query: query || '', results: [] };
  const dir = sessionsDir();
  if (!existsSync(dir)) return { query, results: [] };

  const q = query.trim().toLowerCase();
  const files = getAllJsonlFiles(dir);
  const results = [];

  for (const file of files) {
    const relId = toSessionId(dir, file);
    if (!relId) continue;
    try {
      const parsed = parseCodexSessionFile(file);
      const snippets = [];

      for (const msg of parsed.messages) {
        if (msg.type !== 'text' || !msg.content) continue;
        const lower = msg.content.toLowerCase();
        const idx = lower.indexOf(q);
        if (idx === -1) continue;

        const start = Math.max(0, idx - 40);
        const end = Math.min(msg.content.length, idx + q.length + 40);
        snippets.push(msg.content.slice(start, end).replace(/\n+/g, ' '));
        if (snippets.length >= 3) break;
      }

      if (snippets.length > 0) {
        const encodedDir = cwdToEncodedDir(parsed.cwd) || 'codex';
        results.push({
          id: relId,
          projectDir: encodedDir,
          source: 'codex',
          originSource: parsed.originSource || '',
          projectName: decodeDirName(encodedDir),
          title: extractTitle(parsed.messages),
          lastActivity: parsed.lastActivity || '',
          snippets
        });
      }
    } catch {
      continue;
    }
  }

  results.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return { query, results };
}
