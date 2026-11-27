import { NextResponse } from 'next/server';
import { customerRedis } from '../../../../../../src/http/jail.mjs';
import { requireAdminAuth } from '../../../../../../src/http/admin-roles.mjs';
import {
  listAdminBillingWorkspaces,
  updateAdminWorkspaceBilling,
} from '../../../../../../src/http/billing-plans.mjs';
import { requireSession } from '../../../../lib/server/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: Request) {
  try {
    const { session } = await requireSession('/admin/billing');
    const redis = customerRedis(process.env);
    const auth: any = await requireAdminAuth(session.userId, redis, {
      allowedRoles: ['admin', 'billing'],
    } as any);
    if (!auth?.ok) {
      return NextResponse.json(
        { error: auth?.error || 'forbidden', message: auth?.hint },
        { status: auth?.status || 403 }
      );
    }
    const url = new URL(req.url);
    const out = await listAdminBillingWorkspaces({
      redis,
      search: url.searchParams.get('q') || '',
      planFilter: url.searchParams.get('plan') || '',
      statusFilter: url.searchParams.get('status') || '',
    } as any);
    return NextResponse.json(
      { ...out, actor: { actorId: session.userId, role: auth.role } },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (e: any) {
    const status = Number.isInteger(e?.status) ? e.status : 500;
    const code = typeof e?.code === 'string' ? e.code : 'internal_error';
    return NextResponse.json({ error: code, message: e?.message }, { status });
  }
}

export async function POST(req: Request) {
  try {
    const { session } = await requireSession('/admin/billing');
    const redis = customerRedis(process.env);
    const auth: any = await requireAdminAuth(session.userId, redis, {
      allowedRoles: ['admin', 'billing'],
    } as any);
    if (!auth?.ok) {
      return NextResponse.json(
        { error: auth?.error || 'forbidden', message: auth?.hint },
        { status: auth?.status || 403 }
      );
    }
    const body = await req.json().catch(() => ({}));
    const out = await updateAdminWorkspaceBilling(
      {
        workspaceId: body.workspaceId,
        actorId: session.userId,
        plan: body.plan,
        billingStatus: body.billingStatus,
        billingEmail: body.billingEmail,
        billingNote: body.billingNote,
        externalCustomerId: body.externalCustomerId,
        limitOverrides: body.limitOverrides,
        clearOverrides: Boolean(body.clearOverrides),
        requestId: body.requestId,
      },
      { redis }
    );
    return NextResponse.json(out, { headers: { 'cache-control': 'no-store' } });
  } catch (e: any) {
    const status = Number.isInteger(e?.status) ? e.status : 500;
    const code = typeof e?.code === 'string' ? e.code : 'internal_error';
    return NextResponse.json({ error: code, message: e?.message }, { status });
  }
}
