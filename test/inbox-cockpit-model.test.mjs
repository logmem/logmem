import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanAgent,
  isHumanRecipient,
  formatNeedsBadge,
  sortDecisionsUrgency,
  splitQueueHandoffs,
  splitNeedsItems,
  extractFleetChips,
  extractArchiveEntries,
  filterArchive,
  computeCockpitStats,
  buildAgentComboboxOptions,
  isEditableTarget,
} from '../public/app/inbox-cockpit-model.js';
import {
  isHumanTarget,
  splitHandoffs,
  sortDecisionsUrgency as dashSortDecisions,
  buildFleetChips,
  filterArchiveEntries,
} from '../apps/dashboard/lib/inbox-model.mjs';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const MIN = 60_000;

test('formatNeedsBadge explains the purple Needs-you badge clearly', () => {
  assert.deepEqual(formatNeedsBadge(13), {
    text: '13 need you',
    short: '13 need you',
    aria: '13 items need your attention: decisions, tasks, or reviews',
    zero: false,
  });
  assert.equal(formatNeedsBadge(1).text, '1 needs you');
  assert.equal(formatNeedsBadge(0).short, '0 clear');
  assert.equal(formatNeedsBadge(0).zero, true);
  assert.equal(formatNeedsBadge(null).zero, true);
});

test('sortDecisionsUrgency puts irreversible first, then oldest first', () => {
  const list = [
    { trail: 'rev-old', ts: NOW - 10 * MIN, payload: { reversible: true } },
    { trail: 'irr-new', ts: NOW - 2 * MIN, payload: { reversible: false } },
    { trail: 'irr-old', ts: NOW - 20 * MIN, payload: {} },
    { trail: 'rev-new', ts: NOW - 1 * MIN, payload: { reversible: true } },
  ];
  assert.deepEqual(
    sortDecisionsUrgency(list).map((d) => d.trail),
    ['irr-old', 'irr-new', 'rev-old', 'rev-new'],
  );
  assert.deepEqual(
    dashSortDecisions(list).map((d) => d.trail),
    ['irr-old', 'irr-new', 'rev-old', 'rev-new'],
  );
});

test('splitQueueHandoffs separates human-addressed from agent-to-agent handoffs', () => {
  const items = [
    { id: '1', from: 'agent:polar', to: 'human:mikey', summary: 'Approve deploy' },
    { id: '2', from: 'agent:claude-code', to: 'agent:antigravity', summary: 'Nov 24 sweep' },
    { id: '3', from: 'agent:muse', to: 'person:mikey', summary: 'Review copy' },
  ];
  const { human, agentToAgent } = splitQueueHandoffs(items);
  assert.deepEqual(human.map((i) => i.id), ['1', '3']);
  assert.deepEqual(agentToAgent.map((i) => i.id), ['2']);
  assert.equal(isHumanRecipient('human:mikey'), true);
  assert.equal(isHumanRecipient('agent:codex'), false);
  assert.equal(isHumanTarget('person:mikey'), true);
  assert.deepEqual(splitHandoffs(items).human.map((i) => i.id), ['1', '3']);
});

test('splitNeedsItems buckets decisions, tasks, and reviews', () => {
  const items = [
    { type: 'decision', trail: 'd1' },
    { type: 'task', task: { trail: 't1' } },
    { type: 'suggestion', job: 'j1' },
  ];
  const out = splitNeedsItems(items);
  assert.equal(out.decisions.length, 1);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.reviews.length, 1);
});

test('extractFleetChips orders blocked -> active -> silent heartbeat and counts totals', () => {
  const agents = [
    { id: 'agent:quiet', seen: { state: 'offline', since: '2d' }, last: { ts: NOW - 2 * DAY } },
    { id: 'agent:active', seen: { state: 'active', since: '2m' }, now: { job: 'job:ship' }, last: { ts: NOW - 2 * MIN } },
    { id: 'agent:silent', seen: { state: 'active', since: '25m' }, now: { job: 'job:stuck' }, last: { ts: NOW - 25 * MIN } },
    { id: 'agent:blocked', seen: { state: 'active', since: '5m' }, now: { job: 'job:deploy', blocked: { note: 'needs key' } }, last: { ts: NOW - 5 * MIN } },
  ];
  const fleet = extractFleetChips(agents, NOW);
  assert.equal(fleet.total, 4);
  assert.equal(fleet.blockedCount, 1);
  assert.equal(fleet.activeCount, 3);
  assert.deepEqual(
    fleet.chips.map((c) => [c.name, c.status]),
    [
      ['blocked', 'blocked'],
      ['active', 'active'],
      ['silent', 'silent'],
    ],
  );
  const dashFleet = buildFleetChips(agents, NOW);
  assert.equal(dashFleet.blockedCount, 1);
  assert.equal(dashFleet.chips[0].status, 'blocked');
});

test('extractArchiveEntries + filterArchive filter by query, agent, and date window', () => {
  const entries = extractArchiveEntries(
    [
      { trail: 't1', kind: 'accepted', by: 'agent:antigravity', ts: NOW - 2 * MIN, summary: 'Accepted Polar inbox handoff', where: 'job:inbox' },
      { trail: 't2', kind: 'done', by: 'agent:codex', ts: NOW - 5 * DAY, summary: 'Closed release train', where: 'job:release' },
      { trail: 't3', kind: 'note', by: 'agent:muse', ts: NOW - 1 * MIN, summary: 'Regular note ignored by archive' },
      { trail: 't4', kind: 'decided', by: 'human:mikey', ts: NOW - 20 * DAY, summary: 'Approved domain cutover', where: 'job:dns' },
    ],
    [{ id: 'ack:rev-1', kind: 'done', by: 'you', ts: NOW, summary: 'Acknowledged review: UI polish', where: 'job:ui' }],
  );
  assert.equal(entries.length, 4);
  assert.equal(filterArchive(entries, { query: 'polar' }, NOW).length, 1);
  assert.equal(filterArchive(entries, { agent: 'agent:codex' }, NOW).length, 1);
  assert.equal(filterArchive(entries, { windowDays: '1' }, NOW).length, 2);
  assert.equal(filterArchive(entries, { windowDays: '7' }, NOW).length, 3);
  assert.equal(filterArchiveEntries(entries, { query: 'domain', windowDays: '30' }, NOW).length, 1);
});

test('computeCockpitStats returns all 5 clickable stat tiles with accurate counts', () => {
  const stats = computeCockpitStats({
    decisions: [{ trail: 'd1', payload: { reversible: false } }],
    humanHandoffs: [{ id: 'h1', created_at: NOW - 5 * DAY, deadline: NOW - DAY }],
    humanTasks: [{ type: 'task' }],
    reviews: [{ job: 'j1' }, { job: 'j2' }],
    agentHandoffs: [{ id: 'a1', created_at: NOW - DAY, deadline: NOW + DAY }],
    agents: [{ id: 'agent:a', now: { blocked: true } }, { id: 'agent:b', now: {} }],
    now: NOW,
  });
  assert.deepEqual(
    stats.map((s) => [s.id, s.value]),
    [
      ['decisions', 1],
      ['handoffs', 3],
      ['reviews', 2],
      ['overdue', 1],
      ['blocked', 1],
    ],
  );
});

test('buildAgentComboboxOptions deduplicates and sorts agent names, and isEditableTarget guards inputs', () => {
  const opts = buildAgentComboboxOptions(
    [{ from: 'agent:polar', to: 'agent:antigravity' }],
    [{ id: 'agent:codex' }, { id: 'agent:polar' }],
    [{ by: 'human:mikey' }],
  );
  assert.deepEqual(opts, ['antigravity', 'codex', 'mikey', 'polar']);
  assert.equal(cleanAgent('agent:claude-code'), 'claude-code');
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
});
