import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSchedule, buildShiftTimeline } from '../apps/dashboard/lib/schedule-model.mjs';
import { buildAgentDetail, buildAgentTrace, validAgentId } from '../apps/dashboard/lib/agent-detail-model.mjs';

const ROOT = join(import.meta.dirname, '..');

test('buildShiftTimeline projects real recorded shifts without synthetic rooms or dates', () => {
  const empty = buildShiftTimeline([]);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.slots, []);

  const base = Date.UTC(2026, 10, 23, 14, 15, 0);
  const { shifts } = buildSchedule(
    [
      {
        id: 'agent:quill',
        shift: { shift: 's-1', ts: base, surface: 'claude-code' },
        last: { ts: base + 90 * 60_000 },
        seen: { state: 'active', label: 'Active' },
        now: { doing: 'Drafting release notes' },
      },
      {
        id: 'agent:atlas',
        shift: { shift: 's-2', ts: base - 120 * 60_000, surface: 'codex' },
        last: { ts: base - 110 * 60_000 },
        seen: { state: 'idle', label: 'Idle' },
        now: {},
      },
    ],
    [],
  );

  const tl = buildShiftTimeline(shifts, base + 120 * 60_000);
  assert.equal(tl.rows.length, 2);
  assert.equal(tl.slots.length, 2);
  assert.equal(tl.slots[0].agent, 'quill');
  assert.equal(tl.slots[0].startTime, '14:15');
  assert.equal(tl.slots[0].duration, 90);
  assert.equal(tl.slots[1].duration, 30); // minimum readable slot width
  assert.ok(tl.config.startHour <= 12);
  assert.ok(tl.config.endHour >= 16);
});

test('validAgentId accepts clean ids and rejects traversal or spaces', () => {
  assert.equal(validAgentId('grok-local'), true);
  assert.equal(validAgentId('claude_code.1'), true);
  assert.equal(validAgentId('../etc/passwd'), false);
  assert.equal(validAgentId('has space'), false);
  assert.equal(validAgentId(''), false);
});

test('buildAgentTrace nests shift entries chronologically and flags error kinds', () => {
  const t0 = Date.UTC(2026, 10, 23, 15, 0, 0);
  const trace = buildAgentTrace(
    'quill',
    [{ shift: 'shift-1', started_at: t0, ended_at: t0 + 10_000, surface: 'antigravity' }],
    [
      { ts: t0 + 1000, kind: 'progress', summary: 'Checked tokens', trail: 'tr-1', shift: 'shift-1', job: 'job:ui' },
      { ts: t0 + 5000, kind: 'stuck', summary: 'Build failed', trail: 'tr-2', shift: 'shift-1', job: 'job:ui' },
      { ts: t0 + 9000, kind: 'done', summary: 'Build green', trail: 'tr-3', shift: 'shift-1', job: 'job:ui' },
    ],
    t0 + 10_000,
  );

  assert.equal(trace.runId, 'shift-1');
  assert.equal(trace.model, 'antigravity');
  assert.equal(trace.spans.length, 4); // 1 parent shift + 3 child spans
  assert.equal(trace.spans[0].kind, 'agent');
  assert.equal(trace.spans[1].parentId, 'shift-1');
  assert.equal(trace.spans[1].kind, 'model');
  assert.equal(trace.spans[2].status, 'error');
  assert.equal(trace.spans[3].kind, 'io');
});

test('buildAgentDetail builds real status tasks from handoffs and owned jobs', () => {
  const now = Date.UTC(2026, 10, 23, 16, 0, 0);
  const detail = buildAgentDetail(
    {
      id: 'agent:quill',
      who: { name: 'Quill', role: 'Writer', skills: ['copy', 'docs'] },
      now: { doing: 'Polishing Schedule', blocked: false, job: 'job:ui' },
      seen: { state: 'active', label: 'Active' },
      follows: ['channel:agent-coordination'],
      shifts: [{ shift: 's-9', started_at: now - 5000, surface: 'antigravity' }],
      log: [{ ts: now - 2000, kind: 'progress', summary: 'Updated schedule', trail: 'tr-9', shift: 's-9' }],
      handoffs: [{ trail: 'h-1', by: 'agent:atlas', summary: 'Review PR #310', ts: now - 3000 }],
    },
    [
      { id: 'ui', title: 'Schedule Timeline', owner: 'agent:quill', stage: 'active' },
      { id: 'old', title: 'Token Spec', owner: 'agent:quill', stage: 'done' },
      { id: 'other', title: 'Other Job', owner: 'agent:atlas', stage: 'active' },
    ],
    now,
  );

  assert.equal(detail.id, 'quill');
  assert.equal(detail.name, 'Quill');
  assert.equal(detail.ownedJobs.length, 2);
  assert.equal(detail.statusTasks.length, 3);
  assert.equal(detail.statusTasks[0].status, 'pending');
  assert.equal(detail.statusTasks[1].status, 'running');
  assert.equal(detail.statusTasks[2].status, 'complete');
  assert.equal(detail.trace.spans.length, 2);
});

test('21st UI primitives contain zero console.log calls, zero raw Tailwind palette classes, and AgentDetailPage enforces requireSpace', () => {
  for (const rel of [
    'apps/dashboard/components/ui/timeline.tsx',
    'apps/dashboard/components/ui/slider.tsx',
    'apps/dashboard/components/ui/agent-trace.tsx',
    'apps/dashboard/components/ui/agent-status.tsx',
    'apps/dashboard/components/ui/chrono-board.tsx',
    'apps/dashboard/components/ui/activity-timeline.tsx',
    'apps/dashboard/components/ui/relative-time.tsx',
    'apps/dashboard/components/ui/daily-timeline-scheduler.tsx',
    'apps/dashboard/components/ui/ai-actions.tsx',
    'apps/dashboard/components/ui/suggestions.tsx',
    'apps/dashboard/components/ui/cited-answer-chat-input.tsx',
    'apps/dashboard/components/ui/generation-stats.tsx',
    'apps/dashboard/components/ui/illos-ai-chat-empty-state.tsx',
    'apps/dashboard/components/ui/agent-roster.tsx',
  ]) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /console\.log\(/, `${rel} must not contain console.log`);
    assert.doesNotMatch(
      src,
      /\b(?:bg|text|border|ring)-(?:slate|blue|green|amber|red|emerald|purple|orange)-\d{2,3}\b/,
      `${rel} must use LogMem var(--*) tokens instead of raw Tailwind color palettes`,
    );
  }

  const pageSrc = readFileSync(
    join(ROOT, 'apps/dashboard/app/(workspace)/space/[space]/agents/[agent]/page.tsx'),
    'utf8',
  );
  assert.match(pageSrc, /await requireSpace\(space,\s*'read'\)/);
  assert.doesNotMatch(pageSrc, /notFound\(/);
});
