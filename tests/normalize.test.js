import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportFromCLI, buildReportFromHourly } from '../aggregators/normalize.js';

const SAMPLE_CLAUDE_DAILY = {
  daily: [
    {
      date: '2026-04-12',
      inputTokens: 100, outputTokens: 200,
      cacheCreationTokens: 50, cacheReadTokens: 1000,
      totalCost: 1.25,
      modelBreakdowns: [{ modelName: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 200, cacheCreationTokens: 50, cacheReadTokens: 1000, cost: 1.25 }]
    }
  ]
};

const SAMPLE_CODEX_DAILY = {
  daily: [
    {
      date: 'Apr 12, 2026',
      inputTokens: 80, outputTokens: 40,
      cachedInputTokens: 500,
      reasoningOutputTokens: 0,
      costUSD: 0.40,
      models: { 'gpt-5-codex': { totalTokens: 620 } }
    }
  ]
};

test('buildReportFromCLI summary exposes claudeCost, codexCost, claudeCacheReadTokens', () => {
  const report = buildReportFromCLI({
    period: '1d',
    claudeDaily: SAMPLE_CLAUDE_DAILY,
    codexDaily: SAMPLE_CODEX_DAILY,
    claudeSessions: { sessions: [] },
    codexSessions: { sessions: [] }
  });
  assert.equal(report.summary.claudeCost, 1.25);
  assert.equal(report.summary.codexCost, 0.40);
  // 1.25 and 0.40 are both exactly representable in IEEE 754, so their sum is exact
  assert.equal(report.summary.totalCost, 1.65);
  assert.equal(report.summary.claudeCacheReadTokens, 1000);
});

test('buildReportFromHourly summary exposes claudeCost, codexCost, claudeCacheReadTokens', () => {
  const report = buildReportFromHourly({
    period: '5h',
    claudeHourly: {
      summary: { inputTokens: 100, outputTokens: 200, cacheCreationTokens: 50, cacheReadTokens: 1000, totalCost: 1.25 },
      models: [], sessions: [], hourlyBuckets: []
    },
    codexHourly: {
      summary: { inputTokens: 80, outputTokens: 40, cacheReadTokens: 500, totalCost: 0.40 },
      models: [], sessions: [], hourlyBuckets: []
    }
  });
  assert.equal(report.summary.claudeCost, 1.25);
  assert.equal(report.summary.codexCost, 0.40);
  // totalCost is claudeSummary.totalCost + codexSummary.totalCost
  assert.equal(report.summary.totalCost, 1.65); // 1.25 + 0.40, both IEEE 754 exact
  assert.equal(report.summary.claudeCacheReadTokens, 1000);
  assert.equal(report.summary.cacheReadTokens, 1500); // claude 1000 + codex 500
});

test('buildReportFromCLI sessions: Claude IDs derive from UUID sessionId/projectPath; project-dir IDs accepted', () => {
  // ccusage session --json returns project-dir paths as sessionId when it aggregates by project
  // (e.g. "-Users-x-projA"). These rows are now kept so they appear in the dashboard session
  // list — previously they were silently dropped, causing no Claude sessions to show for 1d/3d/7d.
  const report = buildReportFromCLI({
    period: '1d',
    claudeDaily: SAMPLE_CLAUDE_DAILY,
    codexDaily: SAMPLE_CODEX_DAILY,
    claudeSessions: {
      sessions: [
        // project-dir aggregate row -> accepted (shows project-level usage in session list)
        {
          sessionId: '-Users-x-projA',
          projectPath: 'Unknown Project',
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationTokens: 1,
          cacheReadTokens: 2,
          totalCost: 0.1,
          lastActivity: '2026-04-12',
          modelsUsed: ['claude-sonnet-4-6']
        },
        // subagents row -> session id should come from projectPath tail UUID
        {
          sessionId: 'subagents',
          projectPath: '-Users-x-projA/61003f6b-9375-425b-9d58-90b0bb19980e',
          inputTokens: 20,
          outputTokens: 8,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          totalCost: 0.2,
          lastActivity: '2026-04-12',
          modelsUsed: ['claude-sonnet-4-6']
        },
        // direct UUID row -> keep as-is
        {
          sessionId: '8996f841-4ed7-4b99-a036-6db0d79c7fa4',
          projectPath: 'Unknown Project',
          inputTokens: 30,
          outputTokens: 9,
          cacheCreationTokens: 5,
          cacheReadTokens: 6,
          totalCost: 0.3,
          lastActivity: '2026-04-12',
          modelsUsed: ['claude-sonnet-4-6']
        }
      ]
    },
    codexSessions: { sessions: [] }
  });

  const claudeSessions = report.sessions.filter((s) => s.source === 'claude');
  assert.equal(claudeSessions.length, 3, 'all three rows should be kept');
  assert.ok(claudeSessions.some((s) => s.id === '-Users-x-projA'), 'project-dir row kept');
  assert.ok(claudeSessions.some((s) => s.id === '61003f6b-9375-425b-9d58-90b0bb19980e'));
  assert.ok(claudeSessions.some((s) => s.id === '8996f841-4ed7-4b99-a036-6db0d79c7fa4'));
});
