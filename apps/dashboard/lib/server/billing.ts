import 'server-only';
import { customerRedis } from '../../../../src/http/jail.mjs';
import { requireAdminAuth } from '../../../../src/http/admin-roles.mjs';
import {
  getUserBillingOverview,
  listAdminBillingWorkspaces,
} from '../../../../src/http/billing-plans.mjs';
import { requireSession, requireSpace } from './auth';

export type BillingOverviewData = NonNullable<
  Awaited<ReturnType<typeof getUserBillingOverview>>['data']
>;

export type AdminBillingData = Awaited<
  ReturnType<typeof listAdminBillingWorkspaces>
>['data'] & {
  actor: { actorId: string; role: string };
};

export async function getSpaceBillingData(space: string): Promise<BillingOverviewData> {
  const viewer = await requireSpace(space, 'read');
  const redis = customerRedis(process.env);
  const res = await getUserBillingOverview({
    userId: viewer.userId,
    workspaceId: viewer.workspaceId,
    deps: { redis },
  } as any);
  return res.data;
}

export async function getAdminBillingData(
  filters: { search?: string; planFilter?: string; statusFilter?: string } = {}
): Promise<AdminBillingData> {
  const { session } = await requireSession('/admin/billing');
  const redis = customerRedis(process.env);
  const auth: any = await requireAdminAuth(session.userId, redis, {
    allowedRoles: ['admin', 'billing'],
  } as any);
  if (!auth?.ok) {
    throw Object.assign(new Error(auth?.error || 'forbidden'), {
      status: auth?.status || 403,
      code: auth?.error || 'forbidden',
    });
  }
  const res = await listAdminBillingWorkspaces({
    redis,
    search: filters.search || '',
    planFilter: filters.planFilter || '',
    statusFilter: filters.statusFilter || '',
  } as any);
  return {
    ...res.data,
    actor: { actorId: session.userId, role: auth.role || 'admin' },
  };
}
