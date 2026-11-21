// plans-model.js: the rules behind the Plans page (rows, groups, milestone status, timeline).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOverdue, daysUntil, overdueByPlan, planRows, groupPlanRows, priorityMenu, needsReason, priorityToast, milestoneJobs, milestoneStatus, milestoneTimeline, waitsOn, AT_RISK_DAYS } from '../public/app/plans-model.js';

const TODAY = '2026-11-17';
const NOW = Date.parse(TODAY + 'T12:00:00Z');

test('overdue: past due and not done; days count from today', () => {
  assert.equal(isOverdue({ due: '2026-11-16', stage: 'open' }, TODAY), true);
  assert.equal(isOverdue({ due: '2026-11-16', stage: 'done' }, TODAY), false);
  assert.equal(isOverdue({ due: '2026-11-17', stage: 'open' }, TODAY), false, 'due today is not overdue');
  assert.equal(isOverdue({ due: 'soon', stage: 'open' }, TODAY), false);
  assert.equal(isOverdue({ stage: 'open' }, TODAY), false);
  assert.equal(daysUntil('2026-11-20', TODAY), 3);
  assert.equal(daysUntil('2026-11-15', TODAY), -2);
  assert.equal(daysUntil(null, TODAY), null);
});

test('overdue per plan skips milestone jobs and done jobs', () => {
  const m = overdueByPlan([
    { plan: 'a', due: '2026-11-01', stage: 'open' }, { plan: 'a', due: '2026-11-01', stage: 'blocked' },
    { plan: 'a', due: '2026-11-01', stage: 'done' }, { plan: 'a', due: '2026-11-01', stage: 'open', milestone: true },
    { plan: 'b', due: '2026-12-01', stage: 'open' }, { due: '2026-11-01', stage: 'open' },
  ], TODAY);
  assert.equal(m.get('a'), 2);
  assert.equal(m.has('b'), false);
});

const lanes = [
  { id: 'general', title: 'general', jobs: 4, done: 0, lane: null },
  { id: 'side', title: 'Side', jobs: 2, done: 1, lane: { status: 'parked', why: 'Waiting on sponsor' }, parked_jobs: [], blocked_count: 0 },
  { id: 'none', title: 'Loose', jobs: 1, done: 0, lane: null },
  { id: 'main', title: 'Main', jobs: 5, done: 2, lane: { status: 'p0' }, blocked_count: 2, next_milestone: { id: 'm1', title: 'Draft locked', date: '2026-11-20' } },
  { id: 'act2', title: 'Small', jobs: 1, done: 1, lane: { status: 'active' } },
  { id: 'act1', title: 'Big', jobs: 9, done: 0, lane: { status: 'active' } },
];

test('rows: Top priority, Active, Paused, Not set; bigger plans first; general last and never prioritised', () => {
  const rows = planRows(lanes, [{ plan: 'main', due: '2026-11-10', stage: 'open' }], NOW);
  assert.deepEqual(rows.map((r) => r.id), ['main', 'act1', 'act2', 'side', 'none', 'general']);
  const main = rows[0];
  assert.equal(main.label, 'Top priority');
  assert.equal(main.percent, 40);
  assert.equal(main.blocked, 2);
  assert.equal(main.overdue, 1);
  assert.deepEqual(main.next, { id: 'm1', title: 'Draft locked', date: '2026-11-20' });
  assert.equal(rows.find((r) => r.id === 'side').label, 'Paused');
  assert.equal(rows.find((r) => r.id === 'side').why, 'Waiting on sponsor');
  const g = rows.at(-1);
  assert.equal(g.general, true);
  assert.equal(g.status, null);
  assert.equal(g.title, 'Not in a plan');
  assert.equal(planRows([{ id: 'x', jobs: 0, done: 0 }])[0].percent, 0, 'no jobs is 0%, not NaN');
});

test('groups keep the display order and the parts add up', () => {
  const rows = planRows(lanes, [], NOW);
  const groups = groupPlanRows(rows);
  assert.deepEqual(groups.map((g) => g.label), ['Top priority', 'Active', 'Paused', 'Not set']);
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), rows.length);
});

test('priority menu, reason rule and the confirmation line', () => {
  assert.deepEqual(priorityMenu('p0').map(([s]) => s), ['active', 'parked']);
  assert.deepEqual(priorityMenu(null).map(([, l]) => l), ['Top priority', 'Active', 'Paused']);
  assert.equal(needsReason('parked'), true);
  assert.equal(needsReason('p0'), false);
  assert.equal(priorityToast('Main', 'p0', ['old']), 'Main is now Top priority. old moved to Active.');
  assert.equal(priorityToast('Main', 'parked'), 'Main is now Paused.');
});

test('milestone jobs match by id or the older "id: title" form', () => {
  const items = [{ id: 'a', milestone: 'm1' }, { id: 'b', milestone: 'old' }, { id: 'c', milestone: null }];
  assert.deepEqual(milestoneJobs({ id: 'm1', title: 'Draft' }, items).map((j) => j.id), ['a']);
  assert.deepEqual(milestoneJobs({ id: 'zz', title: 'old: Launch' }, items).map((j) => j.id), ['b']);
  assert.deepEqual(milestoneJobs(null, items), []);
});

test('milestone status: Done, Overdue, At risk, On track', () => {
  const m = (date, stage = 'open') => ({ id: 'm', title: 'M', date, stage });
  assert.equal(milestoneStatus(m('2026-11-01', 'done'), [{ stage: 'open' }], TODAY), 'done', 'the milestone job decides Done');
  assert.equal(milestoneStatus(m('2026-11-16'), [], TODAY), 'overdue');
  assert.equal(milestoneStatus(m('2026-12-30'), [{ stage: 'blocked' }], TODAY), 'at_risk', 'a blocked job puts it at risk');
  assert.equal(milestoneStatus(m('2026-12-30'), [{ stage: 'open', due: '2026-11-10' }], TODAY), 'at_risk', 'an overdue job puts it at risk');
  const soon = '2026-11-' + String(17 + AT_RISK_DAYS);
  assert.equal(milestoneStatus(m(soon), [{ stage: 'active' }], TODAY), 'at_risk', 'close date with open jobs');
  assert.equal(milestoneStatus(m(soon), [{ stage: 'done' }], TODAY), 'on_track', 'close date with every job done');
  assert.equal(milestoneStatus(m('2026-12-30'), [{ stage: 'active' }], TODAY), 'on_track');
  assert.equal(milestoneStatus(m(null), [], TODAY), 'on_track');
});

test('timeline: date order, undated last, every job once, the rest under Not in a milestone', () => {
  const milestones = [{ id: 'late', title: 'Send', date: '2026-11-27', stage: 'open' }, { id: 'nod', title: 'Someday', date: null, stage: 'open' }, { id: 'early', title: 'Draft', date: '2026-11-19', stage: 'open' }];
  const items = [{ id: 'j1', milestone: 'early', stage: 'done' }, { id: 'j2', milestone: 'early', stage: 'active' }, { id: 'j3', milestone: 'late', stage: 'open' }, { id: 'j4', milestone: null, stage: 'open' }, { id: 'j5', milestone: 'gone', stage: 'blocked' }];
  const { steps, loose } = milestoneTimeline(milestones, items, TODAY);
  assert.deepEqual(steps.map((s) => s.milestone.id), ['early', 'late', 'nod']);
  assert.deepEqual([steps[0].done, steps[0].open, steps[0].status, steps[0].days], [1, 1, 'at_risk', 2]);
  assert.equal(steps[1].status, 'on_track');
  assert.deepEqual(loose.map((j) => j.id), ['j4', 'j5']);
  const count = steps.reduce((n, s) => n + s.jobs.length, 0) + loose.length;
  assert.equal(count, items.length);
});

test('waits on, in plain words', () => {
  assert.equal(waitsOn({ stage: 'active' }), '');
  assert.equal(waitsOn({ stage: 'blocked', blocked_on: { type: 'agent', ref: 'atlas' } }, (x) => x.toUpperCase()), 'Waits on ATLAS');
  assert.equal(waitsOn({ stage: 'blocked', blocked_on: { type: 'decision' } }), 'Waits on a decision');
  assert.equal(waitsOn({ stage: 'blocked', blocked_on: { type: 'task' } }), 'Waits on a person');
  assert.equal(waitsOn({ stage: 'blocked', blocked_on: { type: 'external', note: 'x' } }), 'Waits on something outside the team');
  assert.equal(waitsOn({ stage: 'blocked', blocked_on: { parked: true, note: 'later' } }), 'Paused: later');
  assert.equal(waitsOn({ stage: 'blocked' }), 'Waits on: no reason given');
});
