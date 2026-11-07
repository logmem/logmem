// account-model.js: row models for the Settings tables (spaces, members, agents, invitations).
// Pure and defensive: a missing field gives a plain default, never a thrown error.
const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x, d = '') => (typeof x === 'string' && x ? x : d);

export const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Editor', viewer: 'Viewer', contributor: 'Contributor' };
export const roleLabel = (role) => ROLE_LABEL[role] || str(role, 'Unknown');

/** One row per space in this workspace. members is null until the member list has loaded. */
export function spaceRows(spaceRecords, workspaceId, members = null) {
  return arr(spaceRecords).filter((s) => s && s.workspaceId === workspaceId).map((s) => ({
    id: str(s.id),
    name: str(s.name, str(s.namespace, 'Space')),
    slug: str(s.namespace, '—'),
    sample: Boolean(s.sampleTemplate),
    members: members == null ? null : arr(members).filter((m) => m?.spaces?.[s.id]).length,
  }));
}

export function spaceAccessSummary(member, totalSpaces) {
  const n = Object.keys(member?.spaces || {}).length;
  if (!totalSpaces) return 'No spaces yet';
  if (n === 0) return 'No spaces';
  return n === totalSpaces ? 'All spaces' : `${n} of ${totalSpaces} spaces`;
}

export function memberRows(members, { userId, owner, totalSpaces }) {
  return arr(members).map((m) => ({
    userId: str(m.userId),
    you: m.userId === userId,
    who: m.userId === userId ? 'You' : str(m.label, 'Member ' + str(m.userId).slice(-6)),
    role: str(m.role, 'member'),
    roleText: roleLabel(m.role),
    access: spaceAccessSummary(m, totalSpaces),
    // Only an owner may change or remove another owner.
    locked: m.role === 'owner' && !owner,
  }));
}

export function agentRows(keys, apps) {
  const key = arr(keys).map((k) => ({ id: str(k.id), fid: '', name: str(k.agent, 'agent'), kind: 'Key', access: k.scope === 'read' ? 'Read only' : 'Read and write', created: str(k.created_at ? new Date(k.created_at).toISOString().slice(0, 10) : '', '—') }));
  const app = arr(apps).map((a) => ({ id: str(a.id), fid: str(a.fid), name: str(a.agent, str(a.app, 'app')), kind: 'App', access: a.scope === 'read' ? 'Read only' : 'Read and write', created: '—' }));
  return [...key, ...app];
}

export function inviteRows(invitations) {
  return arr(invitations).map((i) => ({ id: str(i.id), roleText: roleLabel(i.role) }));
}

/** Why Rename is off. The backend has no rename action yet (admin plan, phase 6). */
export const RENAME_REASON = 'Rename is not available yet. It needs a backend change.';
