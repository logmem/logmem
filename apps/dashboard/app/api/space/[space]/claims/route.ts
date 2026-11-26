// Owner-only Space Claim Links API for Next.js dashboard (mirrors /api/space-claims).
import { customerRedis } from '../../../../../../../src/http/jail.mjs';
import { WorkspaceError } from '../../../../../../../src/http/workspaces.mjs';
import {
  createSpaceClaim,
  listSpaceClaims,
  revokeSpaceClaim,
  SpaceClaimError,
} from '../../../../../../../src/http/space-claims.mjs';
import { requireSpace } from '../../../../../lib/server/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const viewer = await requireSpace(space, 'transfer-space');
  const redis = customerRedis(process.env);

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const action = String(body?.action || '');
  try {
    if (action === 'list') {
      const claims = await listSpaceClaims(
        { actorId: viewer.userId, workspaceId: viewer.workspaceId, spaceId: viewer.spaceId },
        { redis },
      );
      return Response.json({ ok: true, claims }, { headers: { 'cache-control': 'no-store' } });
    }

    if (action === 'create') {
      const r = await createSpaceClaim(
        {
          actorId: viewer.userId,
          workspaceId: viewer.workspaceId,
          spaceId: viewer.spaceId,
          mode: body.mode,
          clientSafe: body.clientSafe !== false,
          recipientEmail: body.recipientEmail || '',
          ttlDays: body.ttlDays,
        },
        { redis },
      );
      const origin = new URL(req.url).origin;
      const claimUrl = new URL(`/claim/${encodeURIComponent(r.token)}`, origin).toString();
      return Response.json({ ...r, claimUrl }, { headers: { 'cache-control': 'no-store' } });
    }

    if (action === 'revoke') {
      const r = await revokeSpaceClaim(
        {
          actorId: viewer.userId,
          workspaceId: viewer.workspaceId,
          spaceId: viewer.spaceId,
          claimId: body.claimId,
        },
        { redis },
      );
      return Response.json(r, { headers: { 'cache-control': 'no-store' } });
    }

    return Response.json({ error: 'invalid_action' }, { status: 400 });
  } catch (e: any) {
    if (e instanceof SpaceClaimError) return Response.json({ error: e.code, message: e.message }, { status: e.status });
    if (e instanceof WorkspaceError) return Response.json({ error: e.code }, { status: e.status });
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
