// apps/dashboard/lib/server/viewer.ts
// TypeScript interface for Next.js App Router Server Components and Route Handlers.

import {
  resolveDashboardViewer as resolveDashboardViewerJs,
  listViewerWorkspaces as listViewerWorkspacesJs
} from './viewer.mjs';

export type DashboardAction =
  | 'read'
  | 'write'
  | 'approve'
  | 'manage-members'
  | 'manage-connections'
  | 'create-space';

export interface DashboardViewerOptions {
  workspaceId: string;
  spaceId: string;
  action?: DashboardAction;
  req?: any;
}

export interface DashboardViewerPermissions {
  canWrite: boolean;
  canApprove: boolean;
  canManageMembers: boolean;
  canManageConnections: boolean;
  canCreateSpace: boolean;
}

export interface DashboardWorkspaceSummary {
  id: string;
  tenantId: string;
  name: string;
  status?: string;
}

export interface DashboardSpaceSummary {
  id: string;
  workspaceId: string;
  namespace: string;
  name: string;
  status?: string;
}

export interface DashboardViewerContext {
  userId: string;
  person: string;
  workspaceId: string;
  spaceId: string;
  namespace: string;
  role: string;
  permissions: DashboardViewerPermissions;
  workspace: DashboardWorkspaceSummary;
  space: DashboardSpaceSummary;
  version: number;
  redis: (cmd: string, ...args: any[]) => Promise<any>;
  revalidate: () => Promise<any>;
}

export interface ViewerDependencies {
  redis?: (cmd: string, ...args: any[]) => Promise<any>;
  session?: (req: any, opts: any) => Promise<any>;
  env?: Record<string, string | undefined>;
  origin?: string;
}

/**
 * Resolves the authenticated viewer context for Next.js dashboard routes.
 * Rejects any caller-supplied Redis credentials or tenant overrides.
 */
export async function resolveDashboardViewer(
  options: DashboardViewerOptions,
  deps: ViewerDependencies = {}
): Promise<DashboardViewerContext> {
  return resolveDashboardViewerJs(options, deps) as Promise<DashboardViewerContext>;
}

export async function listViewerWorkspaces(
  userId: string,
  deps: ViewerDependencies = {}
): Promise<Array<DashboardWorkspaceSummary & { spaces: DashboardSpaceSummary[] }>> {
  return listViewerWorkspacesJs(userId, deps);
}
