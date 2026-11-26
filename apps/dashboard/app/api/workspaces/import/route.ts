// Workspace-level space creation and import-into-new-space API for Next.js dashboard.
import { customerRedis } from '../../../../../../src/http/jail.mjs';
import {
  readWorkspace,
  membership,
  createSpace,
  planSpaces,
  recordWorkspaceAudit,
  WorkspaceError,
} from '../../../../../../src/http/workspaces.mjs';
import { importSpace, parseBundle } from '../../../../../../src/http/space-import.mjs';
import { requireSession } from '../../../../lib/server/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function decodeBundle(bundle: unknown, encoding?: string) {
  if (encoding === 'gzip-base64' || encoding === 'base64') {
    if (typeof bundle !== 'string' || !bundle.trim()) {
      throw Object.assign(new Error('invalid_bundle'), { code: 'invalid_bundle', status: 400 });
    }
    return Buffer.from(bundle, 'base64');
  }
  return bundle;
}

export async function POST(req: Request) {
  const { session } = await requireSession('/select-space');
  const redis = customerRedis(process.env);

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const workspaceId = String(body?.workspaceId || '');
  const action = String(body?.action || '');
  if (!workspaceId) return Response.json({ error: 'missing_workspace_id' }, { status: 400 });

  try {
    const { w } = await readWorkspace(redis, workspaceId);
    const m = membership(w, session.userId);
    const activeSpaces = Object.values(w.spaces || {}).filter((s: any) => s.status === 'active').length;
    const maxSpaces = planSpaces(w);
    const hasQuota = activeSpaces < maxSpaces;

    if (action === 'create-space') {
      const res = await createSpace(
        {
          userId: session.userId,
          workspaceId,
          name: body.name,
          requestId: String(body.requestId || `sp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
        },
        { redis },
      );
      return Response.json({ ok: true, space: res.space }, { headers: { 'cache-control': 'no-store' } });
    }

    if (!['owner', 'admin'].includes(m.role)) {
      throw new WorkspaceError('forbidden', 403);
    }

    if (action === 'import-plan') {
      const input = decodeBundle(body.bundle, body.bundleEncoding);
      const bundle = parseBundle(input);
      const plan = await importSpace(redis, 's-000000000000000000000000', bundle, {
        dryRun: true,
        requireApproval: true,
        approved: false,
      });
      return Response.json(
        { ...plan, space: null, quota: { activeSpaces, maxSpaces, hasQuota } },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    if (action === 'import-create-space') {
      if (!hasQuota) throw new WorkspaceError('space_limit', 429);
      if (body.approved !== true) return Response.json({ error: 'approval_required' }, { status: 403 });
      const input = decodeBundle(body.bundle, body.bundleEncoding);
      const bundle = parseBundle(input);
      if (body.checksum && body.checksum !== bundle.checksum) {
        return Response.json({ error: 'checksum_mismatch' }, { status: 400 });
      }
      const targetName = String(body.name || bundle.spaceName || bundle.space || 'Imported space').trim().slice(0, 80);
      const requestId = String(body.requestId || `imp-${bundle.checksum.slice(0, 16)}-${Date.now()}`);
      const created = await createSpace({ userId: session.userId, workspaceId, name: targetName, requestId }, { redis });
      const applied: any = await importSpace(redis, created.space.namespace, bundle, {
        dryRun: false,
        requireApproval: true,
        approved: true,
        recordReceipt: true,
        importedBy: `human:${session.userId}`,
      });
      await recordWorkspaceAudit(redis, workspaceId, {
        kind: 'space-imported',
        spaceId: created.space.id,
        spaceName: created.space.name,
        sourceSpace: applied.sourceSpace,
        mode: applied.mode || 'full',
        checksum: applied.checksum,
        created: applied.written?.created || 0,
        overwritten: 0,
        by: `human:${session.userId}`,
      });
      return Response.json({ ...applied, spaceRecord: created.space }, { headers: { 'cache-control': 'no-store' } });
    }

    return Response.json({ error: 'invalid_action' }, { status: 400 });
  } catch (e: any) {
    if (e instanceof WorkspaceError) return Response.json({ error: e.code }, { status: e.status });
    if (e?.name === 'SpaceImportError') {
      return Response.json({ error: e.code, message: e.message }, { status: e.code === 'approval_required' ? 403 : 400 });
    }
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
