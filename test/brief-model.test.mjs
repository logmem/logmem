// Pure helpers behind the Brief, Inbox and Activity screens.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  relTime, shortDate, clock24, fullTime, needsParts, topNeed, presence, updatedLabel, dayLabel, nextMilestone,
  briefTiles, handoffInFlight, inBucket, bucketCounts, sortOldestFirst, queueSummary, dueChip,
  filterActivity, dayGroups, placeLink, BUCKETS, KIND_GROUPS,
} from '../public/app/brief-model.js';

const H = 3600000, D = 24 * H;
const NOW = new Date(2026, 10, 17, 14, 5).getTime();

test('relTime: relative under 7 days, a date after, honest for bad input', () => {
  assert.equal(relTime(NOW - 20000, NOW), 'just now');
  assert.equal(relTime(NOW - 5 * 60000, NOW), '5m ago');
  assert.equal(relTime(NOW - 3 * H, NOW), '3h ago');
  assert.equal(relTime(NOW - 2 * D, NOW), '2d ago');
  assert.equal(relTime(new Date(2026, 10, 2).getTime(), NOW), 'Nov 2');
  assert.equal(relTime(NOW + H, NOW), 'in the future');
  assert.equal(relTime(0, NOW), 'time unknown');
  assert.equal(relTime('x', NOW), 'time unknown');
});
test('shortDate adds the year only when it differs; clocks are 24h', () => {
  assert.equal(shortDate(new Date(2026, 0, 5).getTime(), NOW), 'Jan 5');
  assert.equal(shortDate(new Date(2025, 10, 2).getTime(), NOW), 'Nov 2, 2025');
  assert.equal(clock24(NOW), '14:05');
  assert.equal(clock24('bad'), '--:--');
  assert.equal(fullTime(NOW), '2026-11-17 14:05');
  assert.equal(fullTime(0), 'Time unknown');
});
test('needsParts total is the sum of its parts; topNeed picks the oldest decision first', () => {
  const items = [{ type: 'review', created_at: 1 }, { type: 'task', created_at: 2 }, { type: 'decision', created_at: 9 }, { type: 'decision', created_at: 5 }];
  assert.deepEqual(needsParts(items), { decision: 2, task: 1, review: 1, total: 4 });
  assert.deepEqual(needsParts(null), { decision: 0, task: 0, review: 0, total: 0 });
  assert.equal(topNeed(items).created_at, 5);
  assert.equal(topNeed([]), null);
});
test('presence and updatedLabel follow the record', () => {
  assert.equal(presence({ paused: true, seen: { state: 'active' } }).state, 'paused');
  assert.equal(presence({ seen: { state: 'active' } }).label, 'Active');
  assert.equal(presence({ seen: { state: 'idle' } }).state, 'idle');
  assert.equal(presence({}).state, 'offline');
  assert.equal(updatedLabel({ since: '5m' }), 'updated 5m ago');
  assert.equal(updatedLabel({ since: '0m' }), 'updated just now');
  assert.equal(updatedLabel({ since: 'never' }), 'never wrote');
  assert.equal(updatedLabel(null), 'never wrote');
});
test('dayLabel and nextMilestone: earliest dated milestone wins', () => {
  assert.equal(dayLabel('2026-10-23', NOW), 'Oct 23');
  assert.equal(dayLabel('', NOW), 'No date');
  assert.equal(dayLabel('soon', NOW), 'soon');
  const plans = [{ id: 'b', next_milestone: { title: 'Undated' } }, { id: 'a', next_milestone: { title: 'Late', date: '2026-12-01' } }, { id: 'c', next_milestone: { title: 'Early', date: '2026-11-20' } }, { id: 'd' }];
  assert.deepEqual(nextMilestone(plans), { plan: 'c', title: 'Early', date: '2026-11-20' });
  assert.equal(nextMilestone([]), null);
});
test('briefTiles: four linked tiles, zeros flagged, unknown inbox shown as a dash', () => {
  const queue = { items: [{ id: 'q1', created_at: NOW - 10 * H, deadline: NOW - H }, { id: 'q2', created_at: NOW - H, deadline: NOW + H }] };
  const agents = [{ seen: { state: 'active' } }, { seen: { state: 'idle' } }];
  const plans = [{ id: 'p1', next_milestone: { title: 'Ship', date: '2026-11-20' } }];
  const t = briefTiles({ needs: [{ type: 'decision' }, { type: 'task' }], queue, agents, plans }, NOW);
  assert.deepEqual(t.map((x) => x.id), ['needs', 'overdue', 'agents', 'milestone']);
  assert.equal(t[0].value, 2);
  assert.equal(t[0].sub, '1 decision · 1 task · 0 reviews');
  assert.equal(t[1].value, 1);
  assert.equal(t[1].tone, 'danger');
  assert.equal(t[1].sub, 'of 2 open requests');
  assert.equal(t[2].value, 1);
  assert.equal(t[2].sub, 'of 2 connected');
  assert.equal(t[3].value, 'Nov 20');
  assert.equal(t[3].href, '#/plans/p1');
  const empty = briefTiles({}, NOW);
  assert.equal(empty[0].zero, true);
  assert.equal(empty[1].value, '—');
  assert.equal(empty[1].sub, 'Inbox unavailable');
  assert.equal(empty[3].href, '#/plans');
  assert.equal(briefTiles({ queue: { items: [], nextCursor: 'x' } }, NOW)[1].sub, 'of 0 open requests loaded');
});
test('Inbox buckets: overdue includes over 48h, due soon excludes overdue', () => {
  const late = { id: 'a', created_at: NOW - 80 * H, deadline: NOW - 50 * H };
  const overdue = { id: 'b', created_at: NOW - 10 * H, deadline: NOW - H };
  const soon = { id: 'c', created_at: NOW - H, deadline: NOW + 2 * H };
  const later = { id: 'd', created_at: NOW - H, deadline: NOW + 20 * H };
  const undated = { id: 'e', created_at: NOW - H };
  const items = [late, overdue, soon, later, undated];
  assert.deepEqual(BUCKETS.map((b) => b[0]), ['all', 'soon', 'overdue', 'over48']);
  assert.deepEqual(bucketCounts(items, NOW), { all: 5, soon: 1, overdue: 2, over48: 1 });
  assert.ok(inBucket(late, 'overdue', NOW) && inBucket(late, 'over48', NOW));
  assert.ok(!inBucket(overdue, 'soon', NOW));
  assert.ok(!inBucket(undated, 'soon', NOW));
  assert.equal(inBucket(late, 'nope', NOW), false);
});
test('sortOldestFirst and handoffInFlight: oldest first, unknown times last', () => {
  const items = [{ id: 'x' }, { id: 'b', created_at: 20 }, { id: 'a', created_at: 10 }];
  assert.deepEqual(sortOldestFirst(items).map((i) => i.id), ['a', 'b', 'x']);
  assert.equal(handoffInFlight(items).id, 'a');
  assert.equal(handoffInFlight([]), null);
  assert.equal(items[0].id, 'x', 'input is not mutated');
});
test('queueSummary never says clear while anything is open', () => {
  assert.equal(queueSummary([], NOW), 'No open requests on this page');
  assert.equal(queueSummary([{ created_at: NOW - 5 * H, deadline: NOW - H }, { created_at: NOW - H }], NOW), '1 on time · 1 overdue');
});
test('dueChip text and tone', () => {
  assert.deepEqual(dueChip({}, NOW), { text: 'No deadline', tone: '' });
  assert.deepEqual(dueChip({ created_at: NOW - 5 * H, deadline: NOW - 2 * H }, NOW), { text: 'Overdue · due 2h ago', tone: 'danger' });
  assert.equal(dueChip({ created_at: new Date(2026, 10, 1).getTime(), deadline: new Date(2026, 10, 2).getTime() }, NOW).text, 'Overdue · due Nov 2');
  assert.deepEqual(dueChip({ created_at: NOW - H, deadline: NOW + 3 * H }, NOW), { text: 'Due in 3h', tone: 'warning' });
  assert.deepEqual(dueChip({ created_at: NOW - H, deadline: NOW + 20 * 60000 }, NOW), { text: 'Due in 20m', tone: 'warning' });
  assert.deepEqual(dueChip({ created_at: NOW - H, deadline: NOW + 20 * H }, NOW), { text: 'Due in 20h', tone: '' });
  assert.equal(dueChip({ created_at: NOW - H, deadline: NOW + 3 * D }, NOW).text, 'Due Nov 20');
});
test('filterActivity: newest first, by agent and kind group, drops bad times', () => {
  const e = [{ ts: 1, by: 'agent:a', group: 'work' }, { ts: 3, by: 'agent:b', group: 'handoff' }, { ts: 2, by: 'agent:a' }, { ts: 0, by: 'agent:a' }];
  assert.deepEqual(filterActivity(e).map((x) => x.ts), [3, 2, 1]);
  assert.deepEqual(filterActivity(e, { agent: 'agent:a' }).map((x) => x.ts), [2, 1]);
  assert.deepEqual(filterActivity(e, { kind: 'system' }).map((x) => x.ts), [2]);
  assert.deepEqual(filterActivity(e, { agent: 'b' }, (by) => by.replace('agent:', '')).map((x) => x.ts), [3]);
  assert.ok(KIND_GROUPS.some((g) => g[0] === 'error'));
});
test('dayGroups: Today, Yesterday, then weekday and date', () => {
  const e = [{ ts: NOW - H }, { ts: NOW - 2 * H }, { ts: NOW - D }, { ts: new Date(2026, 10, 10, 9).getTime() }];
  const g = dayGroups(e, NOW);
  assert.deepEqual(g.map((x) => x.label), ['Today', 'Yesterday', 'Tue, Nov 10']);
  assert.equal(g[0].entries.length, 2);
  assert.deepEqual(dayGroups([], NOW), []);
});
test('placeLink: jobs, channels and agents link; anything else does not', () => {
  assert.deepEqual(placeLink('job:i15 photos'), { href: '#/job/i15%20photos', label: 'i15 photos' });
  assert.deepEqual(placeLink('channel:field-notes'), { href: '#/channels/field-notes', label: '#field-notes' });
  assert.deepEqual(placeLink('agent:atlas'), { href: '#/agent/atlas', label: 'atlas' });
  assert.equal(placeLink('space:x'), null);
  assert.equal(placeLink(undefined), null);
});
