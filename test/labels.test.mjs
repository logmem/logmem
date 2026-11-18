// labels.js: the approved plain words come from one module. UI text only; stored values do not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STAGE_LABEL, STAGES, stageLabel, PRIORITY_LABEL, PRIORITY_NONE, priorityLabel, PRIORITY_CHOICES, priorityRank, priorityOf, milestoneLabel, WORDS } from '../public/app/labels.js';

test('job stages read To do / In progress / Blocked / Done', () => {
  assert.deepEqual(STAGES.map(stageLabel), ['To do', 'In progress', 'Blocked', 'Done']);
  assert.equal(stageLabel(undefined), 'To do');
  assert.equal(stageLabel(''), 'To do');
  assert.equal(stageLabel('review'), 'review', 'an unknown stage shows as stored, never hidden');
  assert.ok(Object.isFrozen(STAGE_LABEL));
});

test('plan priority reads Top priority / Active / Paused / Not set, from the stored lane status', () => {
  assert.equal(priorityLabel('p0'), 'Top priority');
  assert.equal(priorityLabel('active'), 'Active');
  assert.equal(priorityLabel('parked'), 'Paused');
  assert.equal(priorityLabel(null), 'Not set');
  assert.equal(priorityLabel('bogus'), PRIORITY_NONE);
  assert.deepEqual(PRIORITY_CHOICES.map(([s]) => s), ['p0', 'active', 'parked'], 'the API values stay p0, active, parked');
  assert.deepEqual(Object.keys(PRIORITY_LABEL), ['p0', 'active', 'parked']);
  assert.deepEqual(['p0', 'active', 'parked', null].map(priorityRank), [0, 1, 2, 3]);
  assert.equal(priorityOf({ lane: { status: 'p0' } }), 'p0');
  assert.equal(priorityOf({ lane: { status: 'weird' } }), null);
  assert.equal(priorityOf({}), null);
});

test('milestone status words', () => {
  assert.deepEqual(['done', 'on_track', 'at_risk', 'overdue'].map(milestoneLabel), ['Done', 'On track', 'At risk', 'Overdue']);
  assert.equal(milestoneLabel(undefined), 'On track');
  assert.equal(WORDS.map, 'Map');
  assert.equal(WORDS.list, 'List');
});

test('old words are gone from the screens that show them', () => {
  const read = (f) => fs.readFileSync(new URL('../public/app/' + f, import.meta.url), 'utf8');
  const ui = read('ui.js');
  assert.match(ui, /from '\.\/labels\.js'/, 'stage and priority badges read labels.js');
  assert.doesNotMatch(ui, /P0'/);
  assert.match(read('map-preference.js'), /> Map<\/button>/);
  assert.match(read('map-preference.js'), /> List<\/button>/);
  const widget = read('assistant-widget.js');
  for (const old of ['Open to measure', 'saved operational snapshots', 'Agent execution: unverified', 'Knowledge decisions', 'Source activity']) assert.ok(!widget.includes(old), old);
  assert.ok(!read('interactions.js').includes('Counts describe'));
  assert.ok(!read('views.js').includes('Coordination queue'));
  assert.ok(!read('views.js').includes('No lane set'));
});
