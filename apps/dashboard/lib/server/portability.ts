import 'server-only';
import {
  readWorkspace,
  listWorkspaceAudit,
  planSpaces,
  membership,
} from '../../../../src/http/workspaces.mjs';
import { customerRedis } from '../../../../src/http/jail.mjs';
import { listWorkspaceAgentKeys } from '../../../../src/http/workspace-agent-keys.mjs';
import { listSpaceClaims } from '../../../../src/http/space-claims.mjs';
import { requireSpace } from './auth';

export interface SpaceClaimSummary {
  id: string;
  spaceId: string;
  spaceName: string;
  mode: string;
  clientSafe: boolean;
  checksum: string;
  sizeBytes: number;
  recipientEmailMask: string | null;
  createdAt: number;
  expiresAt: number;
  status: string;
}

export interface SpaceMemberItem {
  userId: string;
  label: string | null;
  role: string;
  spaceRole: 'editor' | 'viewer' | null;
  canApprove: boolean;
}

export interface PendingInviteItem {
  id: string;
  role: string;
  expiresAt: number;
  spaceRole: 'editor' | 'viewer' | null;
  canApprove: boolean;
}

export interface PortabilityAuditRow {
  kind: string;
  spaceId?: string;
  spaceName?: string;
  sourceSpace?: string;
  mode?: string;
  checksum?: string;
  sizeBytes?: number;
  created?: number;
  overwritten?: number;
  by?: string;
  at: number;
}

export interface SpaceSettingsData {
  workspaceId: string;
  workspaceName: string;
  spaceId: string;
  spaceName: string;
  namespace: string;
  viewerUserId: string;
  viewerRole: string;
  permissions: {
    canWrite: boolean;
    canApprove: boolean;
    canManageMembers: boolean;
    canExport: boolean;
    canImport: boolean;
    canShareSnapshot: boolean;
    canTransfer: boolean;
  };
  quota: {
    activeSpaces: number;
    maxSpaces: number;
    hasQuota: boolean;
  };
  members: SpaceMemberItem[];
  invitations: PendingInviteItem[];
  auditHistory: PortabilityAuditRow[];
  claims: SpaceClaimSummary[];
  importReceipt: Record<string, unknown> | null;
  activeKeyCount: number;
}

export async function getSpaceSettingsData(space: string): Promise<SpaceSettingsData> {
  const viewer = await requireSpace(space, 'read');
  const redis = customerRedis(process.env);
  const { w } = await readWorkspace(redis, viewer.workspaceId);
  const now = Date.now();
  const activeSpaces = Object.values(w.spaces || {}).filter((s: any) => s.status === 'active').length;
  const maxSpaces = planSpaces(w);

  const canManage = Boolean(viewer.permissions.canManageMembers);
  let members: SpaceMemberItem[] = [];
  let invitations: PendingInviteItem[] = [];
  let auditHistory: PortabilityAuditRow[] = [];
  let claims: SpaceClaimSummary[] = [];
  let activeKeyCount = 0;

  if (canManage) {
    members = Object.entries(w.members || {})
      .filter(([, m]: [string, any]) => m.status === 'active')
      .map(([userId, m]: [string, any]) => {
        const grant = m.spaces?.[space] || null;
        return {
          userId,
          label: m.label || null,
          role: m.role,
          spaceRole: grant?.role || (['owner', 'admin'].includes(m.role) ? 'editor' : null),
          canApprove: Boolean(grant?.canApprove),
        };
      });
    invitations = Object.values(w.invitations || {})
      .filter((i: any) => i.status === 'pending' && i.expiresAt > now)
      .map((i: any) => ({
        id: i.id,
        role: i.role,
        expiresAt: i.expiresAt,
        spaceRole: i.spaces?.[space]?.role || null,
        canApprove: Boolean(i.spaces?.[space]?.canApprove),
      }));
    auditHistory = (await listWorkspaceAudit(redis, viewer.workspaceId, {
      kinds: ['space-exported', 'space-imported', 'space-claim-created', 'space-claim-accepted'],
      spaceId: space,
      limit: 20,
    })) as PortabilityAuditRow[];
    if (viewer.permissions.canTransfer) {
      try {
        claims = (await listSpaceClaims(
          { actorId: viewer.userId, workspaceId: viewer.workspaceId, spaceId: space },
          { redis },
        )) as SpaceClaimSummary[];
      } catch {
        claims = [];
      }
    }
    try {
      const keys = await listWorkspaceAgentKeys(
        { userId: viewer.userId, workspaceId: viewer.workspaceId, spaceId: space },
        { redis },
      );
      activeKeyCount = Array.isArray(keys) ? keys.length : 0;
    } catch {
      activeKeyCount = 0;
    }
  } else {
    const self = membership(w, viewer.userId);
    const grant = self.spaces?.[space] || null;
    members = [
      {
        userId: viewer.userId,
        label: self.label || null,
        role: self.role,
        spaceRole: grant?.role || null,
        canApprove: Boolean(grant?.canApprove),
      },
    ];
  }

  let importReceipt: Record<string, unknown> | null = null;
  try {
    const raw = await viewer.redis('GET', `lm:${viewer.namespace}:meta:import`);
    if (raw) importReceipt = JSON.parse(raw);
  } catch {
    importReceipt = null;
  }

  return {
    workspaceId: viewer.workspaceId,
    workspaceName: viewer.workspace.name,
    spaceId: viewer.spaceId,
    spaceName: viewer.space.name,
    namespace: viewer.namespace,
    viewerUserId: viewer.userId,
    viewerRole: viewer.role,
    permissions: {
      canWrite: Boolean(viewer.permissions.canWrite),
      canApprove: Boolean(viewer.permissions.canApprove),
      canManageMembers: canManage,
      canExport: Boolean(viewer.permissions.canExport),
      canImport: Boolean(viewer.permissions.canImport),
      canShareSnapshot: Boolean(viewer.permissions.canShareSnapshot),
      canTransfer: Boolean(viewer.permissions.canTransfer),
    },
    quota: {
      activeSpaces,
      maxSpaces,
      hasQuota: activeSpaces < maxSpaces,
    },
    members,
    invitations,
    auditHistory,
    claims,
    importReceipt,
    activeKeyCount,
  };
}
