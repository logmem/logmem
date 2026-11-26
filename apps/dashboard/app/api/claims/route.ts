// Recipient Claim Link inspect & accept API for Next.js dashboard.
import { customerRedis } from '../../../../../src/http/jail.mjs';
import { WorkspaceError } from '../../../../../src/http/workspaces.mjs';
import {
  inspectSpaceClaim,
  acceptSpaceClaim,
  SpaceClaimError,
} from '../../../../../src/http/space-claims.mjs';
import { requireSession } from '../../../lib/server/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const { session } = await requireSession('/select-space');
  const redis = customerRedis(process.env);

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const action = String(body?.action || '');
  try {
    if (action === 'inspect') {
      const preview = await inspectSpaceClaim(
        { token: body.token, verifiedEmail: session.email || '' },
        { redis },
      );
      return Response.json(preview, { headers: { 'cache-control': 'no-store' } });
    }

    if (action === 'accept') {
      const r = await acceptSpaceClaim(
        {
          userId: session.userId,
          verifiedEmail: session.email || '',
          targetWorkspaceId: body.targetWorkspaceId,
          spaceName: body.spaceName,
          token: body.token,
          requestId: body.requestId,
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
