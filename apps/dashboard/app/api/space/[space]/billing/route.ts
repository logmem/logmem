import { NextResponse } from 'next/server';
import { customerRedis } from '../../../../../../../src/http/jail.mjs';
import {
  getUserBillingOverview,
  updateUserBillingSettings,
} from '../../../../../../../src/http/billing-plans.mjs';
import { requireSpace } from '../../../../../lib/server/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(
  _req: Request,
  context: { params: Promise<{ space: string }> }
) {
  try {
    const { space } = await context.params;
    const viewer = await requireSpace(space, 'read');
    const redis = customerRedis(process.env);
    const out = await getUserBillingOverview({
      userId: viewer.userId,
      workspaceId: viewer.workspaceId,
      deps: { redis },
    } as any);
    return NextResponse.json(out, { headers: { 'cache-control': 'no-store' } });
  } catch (e: any) {
    const status = Number.isInteger(e?.status) ? e.status : 500;
    const code = typeof e?.code === 'string' ? e.code : 'internal_error';
    return NextResponse.json({ error: code, message: e?.message }, { status });
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ space: string }> }
) {
  try {
    const { space } = await context.params;
    const viewer = await requireSpace(space, 'manage-members');
    const redis = customerRedis(process.env);
    const body = await req.json().catch(() => ({}));
    const out = await updateUserBillingSettings(
      {
        userId: viewer.userId,
        workspaceId: viewer.workspaceId,
        action: body.action,
        billingEmail: body.billingEmail,
        requestedPlan: body.requestedPlan,
        note: body.note,
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
