// portability-model.js — Pure RBAC presets, bundle modes, and formatting helpers shared across vanilla & tests.

export const ROLE_PRESETS = [
  {
    id: 'client_viewer',
    label: 'Client Viewer',
    workspaceRole: 'viewer',
    spaceRole: 'viewer',
    canApprove: false,
    ownerOnly: false,
    description: 'Read Brief, Work, Activity, and Traces. Cannot edit, approve, or export.',
  },
  {
    id: 'client_approver',
    label: 'Client Approver',
    workspaceRole: 'member',
    spaceRole: 'editor',
    canApprove: true,
    ownerOnly: true,
    description: 'Can approve or deny irreversible decisions in the Inbox Cockpit and comment. Cannot invite or export.',
  },
  {
    id: 'team_editor',
    label: 'Team Editor',
    workspaceRole: 'member',
    spaceRole: 'editor',
    canApprove: false,
    ownerOnly: false,
    description: 'Collaborates on jobs, milestones, and notes. Cannot approve irreversible asks or export.',
  },
  {
    id: 'workspace_admin',
    label: 'Workspace Admin',
    workspaceRole: 'admin',
    spaceRole: 'editor',
    canApprove: false,
    ownerOnly: false,
    description: 'Manages members and can export or import spaces. Cannot grant Approver or transfer ownership.',
  },
];

export const RBAC_CHEATSHEET = [
  { capability: 'Read space, jobs & traces', owner: true, admin: true, approver: true, editor: true, viewer: true },
  { capability: 'Edit jobs, milestones & notes', owner: true, admin: true, approver: true, editor: true, viewer: false },
  { capability: 'Approve irreversible decisions', owner: true, admin: 'If granted', approver: true, editor: false, viewer: false },
  { capability: 'Invite members & set roles', owner: true, admin: true, approver: false, editor: false, viewer: false },
  { capability: 'Export / Import space bundles', owner: true, admin: true, approver: false, editor: false, viewer: false },
  { capability: 'Transfer space ownership', owner: true, admin: false, approver: false, editor: false, viewer: false },
];

export const BUNDLE_MODES = [
  {
    id: 'blueprint',
    title: 'Blueprint (Starter Pack)',
    badge: 'Clean setup',
    summary: 'Agents (Who bios & roles), Plans, Milestones, Open Jobs, and Walkthroughs. Drops noisy historical logs.',
    bestFor: 'Handing a client a clean, ready-to-run agent workspace.',
  },
  {
    id: 'full',
    title: 'Full Space + Traces',
    badge: 'Complete history',
    summary: 'Everything in Blueprint plus full Log timelines, Decisions & verdicts, Handoffs, and causal Traces.',
    bestFor: 'Backups, proving live migrations, or delivering a complete project audit trail.',
  },
];

export const SECURITY_GUARANTEES = [
  'Zero agent keys (lmk_*) exported — destination workspace always mints fresh keys',
  'Secret redaction pass applied automatically before checksum signing',
  'SHA-256 integrity checksum embedded and verified before any import write',
];

export function presetById(id) {
  return ROLE_PRESETS.find((p) => p.id === id) || ROLE_PRESETS[0];
}

export function visiblePresets({ isOwner = false } = {}) {
  return ROLE_PRESETS.filter((p) => !p.ownerOnly || isOwner);
}

export function canPortability({ customer = true, role = 'viewer' } = {}) {
  if (!customer) return true;
  return role === 'owner' || role === 'admin';
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function shortHash(hash, len = 12) {
  if (!hash || typeof hash !== 'string') return '—';
  return hash.slice(0, len);
}

export function buildBundleFilename(spaceName, mode = 'full', gzip = true, date = new Date()) {
  const slug = String(spaceName || 'space')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'space';
  const ymd = date.toISOString().slice(0, 10);
  return `${slug}-${mode}-${ymd}.logmem.json${gzip ? '.gz' : ''}`;
}

export function importBannerDismissKey(space, checksum) {
  return `lm-import-banner-dismissed:${space || ''}:${String(checksum || '').slice(0, 16)}`;
}

export function shouldShowImportBanner(receipt, dismissed = false) {
  if (!receipt || typeof receipt !== 'object' || !receipt.checksum) return false;
  return !dismissed;
}
