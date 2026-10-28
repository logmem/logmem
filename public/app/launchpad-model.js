// Setup completion uses source evidence. Preferences cannot prove network activity.
export function launchpadProgress(data = {}, {solo = false, savedTask = false, userId, spaceId} = {}) {
 const agent = (data.agents || []).some(a => (Number(a.last?.ts) > 0 && Number(a.last?.ts) <= Date.now()) || (['active','idle','offline'].includes(a.seen?.state) && /^\d+[mhd]$/.test(a.seen.since || '')));
 const task = savedTask || (data.plans || []).some(p => Number(p.jobs) > 0) || (data.jobs || []).length > 0;
 const collaborator = (data.members || []).some(m => m.userId && m.userId !== userId && (!spaceId || m.spaces?.[spaceId]));
 const collaboration = collaborator || solo;
 const done = [agent, task, collaboration].filter(Boolean).length;
 return {agent, task, collaborator, collaboration, done, percent: Math.round(done / 3 * 100), complete: done === 3};
}
export function taskDraft(title, id) {
 const clean = String(title || '').trim();
 if (!clean || clean.length > 120) throw new Error('Enter a task with 1 to 120 characters.');
 return {job: id, title: clean};
}
