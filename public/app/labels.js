// labels.js: the plain words the app shows. One place for display labels, so every screen says the same thing.
// These are UI words only. API fields, routes that agents use and MCP tool names keep their stored values
// (stage open/active/blocked/done, lane status p0/active/parked).

/** Job stage → what a person reads. */
export const STAGE_LABEL = Object.freeze({ open: 'To do', active: 'In progress', blocked: 'Blocked', done: 'Done' });
export const STAGES = Object.freeze(['open', 'active', 'blocked', 'done']);
export function stageLabel(stage) {
  if (stage == null || stage === '') return STAGE_LABEL.open;
  return STAGE_LABEL[stage] || String(stage);
}

/** Plan priority (the stored lane status) → what a person reads. No status reads Not set. */
export const PRIORITY_LABEL = Object.freeze({ p0: 'Top priority', active: 'Active', parked: 'Paused' });
export const PRIORITY_NONE = 'Not set';
export function priorityLabel(status) { return PRIORITY_LABEL[status] || PRIORITY_NONE; }
/** The choices the priority menu offers, in order. */
export const PRIORITY_CHOICES = Object.freeze([['p0', 'Top priority'], ['active', 'Active'], ['parked', 'Paused']]);
/** Sort rank: Top priority, Active, Paused, Not set. */
export function priorityRank(status) { return { p0: 0, active: 1, parked: 2 }[status] ?? 3; }
/** The stored status for a plan record, or null. */
export const priorityOf = (plan) => (plan && plan.lane && PRIORITY_LABEL[plan.lane.status] ? plan.lane.status : null);

/** Milestone status, worked out from its date and its open jobs (plans-model.js milestoneStatus). */
export const MILESTONE_LABEL = Object.freeze({ done: 'Done', on_track: 'On track', at_risk: 'At risk', overdue: 'Overdue' });
export function milestoneLabel(status) { return MILESTONE_LABEL[status] || MILESTONE_LABEL.on_track; }

/** Page and section names from the approved glossary. */
export const WORDS = Object.freeze({
  plans: 'Plans', inbox: 'Inbox', requests: 'requests', decisions: 'Decisions', activity: 'Activity',
  brief: 'Brief', map: 'Map', list: 'List', notInMilestone: 'Not in a milestone',
});
