// Space members & invitations RBAC API for Next.js dashboard (mirrors /api/memberships).
import { customerRedis } from '../../../../../../../src/http/jail.mjs';
import {
  setMembership,
  removeMembership,
  WorkspaceError,
} from '../../../../../../../src/http/workspaces.mjs';
import {
  createInvitation,
  revokeInvitation,
} from '../../../../../../../src/http/workspace-invites.mjs';
import { sendEmail, workspaceInviteEmail } from '../../../../../../../src/http/resend.mjs';
import { requireSpace } from '../../../../../lib/server/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const viewer = await requireSpace(space, 'manage-members');
  const redis = customerRedis(process.env);

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const action = String(body?.action || '');
  const d = { redis };

  try {
    if (action === 'invite') {
      const r = await createInvitation(
        {
          actorId: viewer.userId,
          workspaceId: viewer.workspaceId,
          email: body.email,
          role: body.role,
          spaces: body.spaces,
          requestId: body.requestId,
        },
        d,
      );
      let emailSent = false;
      let inviteLink: string | null = null;
      if (r.token) {
        const origin = new URL(req.url).origin;
        inviteLink = new URL(`/select-space?invite=${encodeURIComponent(r.token)}`, origin).toString();
        try {
          await sendEmail(
            { ...workspaceInviteEmail(body.email, inviteLink), idempotencyKey: `workspace-invite/${r.id}` },
            { env: process.env },
          );
          emailSent = true;
        } catch {
          emailSent = false;
        }
      }
      return Response.json({ ...r, inviteLink, emailSent }, { headers: { 'cache-control': 'no-store' } });
    }

    if (action === 'revoke-invitation') {
      const r = await revokeInvitation(
        {
          actorId: viewer.userId,
          workspaceId: viewer.workspaceId,
          invitationId: body.invitationId,
          requestId: body.requestId,
        },
        d,
      );
      return Response.json(r, { headers: { 'cache-control': 'no-store' } });
    }

    if (action === 'set') {
      const r = await setMembership(
        {
          actorId: viewer.userId,
          workspaceId: viewer.workspaceId,
          userId: body.userId,
          role: body.role,
          spaces: body.spaces,
          requestId: body.requestId,
        },
        d,
      );
      return Response.json(r, { headers: { 'cache-control': 'no-store' } });
    }

    if (action === 'remove') {
      const r = await removeMembership(
        {
          actorId: viewer.userId,
          workspaceId: viewer.workspaceId,
          userId: body.userId,
          requestId: body.requestId,
        },
        d,
      );
      return Response.json(r, { headers: { 'cache-control': 'no-store' } });
    }

    return Response.json({ error: 'invalid_action' }, { status: 400 });
  } catch (e: any) {
    if (e instanceof WorkspaceError) return Response.json({ error: e.code }, { status: e.status });
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
