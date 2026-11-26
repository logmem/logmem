// Space portability API for Next.js dashboard (mirrors /api/space-io).
import { customerRedis } from '../../../../../../../src/http/jail.mjs';
import { exportSpace } from '../../../../../../../src/http/space-export.mjs';
import { importSpace } from '../../../../../../../src/http/space-import.mjs';
import {
  recordWorkspaceAudit,
  listWorkspaceAudit,
  WorkspaceError,
} from '../../../../../../../src/http/workspaces.mjs';
import { requireSpace } from '../../../../../lib/server/auth';

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

export async function POST(req: Request, { params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const action = String(body?.action || '');
  const rbacAction =
    action === 'export-space' || action === 'audit-history'
      ? 'export-space'
      : action === 'import-plan' || action === 'import-apply'
        ? 'import-space'
        : null;

  if (!rbacAction) {
    return Response.json({ error: 'invalid_action' }, { status: 400 });
  }

  // Authorize via Clerk + server-side RBAC (redirects on auth error outside try/catch)
  const viewer = await requireSpace(space, rbacAction);
  const redis = customerRedis(process.env);

  try {
    if (action === 'audit-history') {
      const history = await listWorkspaceAudit(redis, viewer.workspaceId, {
        kinds: ['space-exported', 'space-imported'],
        spaceId: viewer.spaceId,
        limit: 20,
      });
      return Response.json({ ok: true, history }, { headers: { 'cache-control': 'no-store' } });
    }

    if (action === 'export-space') {
      const dryRun = body.dryRun !== false;
      const mode = body.mode === 'blueprint' ? 'blueprint' : 'full';
      const resExport: any = await exportSpace(redis, viewer.namespace, {
        dryRun,
        gzip: body.gzip === true,
        version: 2,
        mode,
        redact: body.redact !== false,
        spaceName: viewer.space.name,
        requireApproval: !dryRun,
        approved: body.approved === true,
      });

      if (!dryRun && resExport.ok) {
        await recordWorkspaceAudit(redis, viewer.workspaceId, {
          kind: 'space-exported',
          spaceId: viewer.spaceId,
          spaceName: viewer.space.name,
          mode,
          version: 2,
          checksum: resExport.checksum,
          sizeBytes: resExport.sizeBytes,
          by: viewer.person,
        });
      }

      const payload =
        resExport.compressed && Buffer.isBuffer(resExport.buffer)
          ? (() => {
              const { buffer, ...rest } = resExport;
              return { ...rest, bufferBase64: buffer.toString('base64') };
            })()
          : resExport;

      return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
    }

    if (action === 'import-plan') {
      const input = decodeBundle(body.bundle, body.bundleEncoding);
      const plan = await importSpace(redis, viewer.namespace, input, {
        dryRun: true,
        requireApproval: true,
        approved: false,
        overwrite: body.overwrite === true,
        skipConflicts: body.skipConflicts === true,
      });
      return Response.json(plan, { headers: { 'cache-control': 'no-store' } });
    }

    if (action === 'import-apply') {
      const input = decodeBundle(body.bundle, body.bundleEncoding);
      const applied: any = await importSpace(redis, viewer.namespace, input, {
        dryRun: false,
        requireApproval: true,
        approved: body.approved === true,
        overwrite: body.overwrite === true,
        skipConflicts: body.skipConflicts === true,
        recordReceipt: body.recordReceipt !== false,
        importedBy: viewer.person,
      });
      if (applied.ok) {
        await recordWorkspaceAudit(redis, viewer.workspaceId, {
          kind: 'space-imported',
          spaceId: viewer.spaceId,
          spaceName: viewer.space.name,
          sourceSpace: applied.sourceSpace,
          mode: applied.mode || 'full',
          checksum: applied.checksum,
          created: applied.written?.created || 0,
          overwritten: applied.written?.overwritten || 0,
          by: viewer.person,
        });
      }
      return Response.json(applied, { headers: { 'cache-control': 'no-store' } });
    }

    return Response.json({ error: 'invalid_action' }, { status: 400 });
  } catch (e: any) {
    if (e instanceof WorkspaceError) return Response.json({ error: e.code }, { status: e.status });
    if (e?.name === 'SpaceExportError' || e?.name === 'SpaceImportError') {
      return Response.json({ error: e.code, message: e.message }, { status: e.code === 'approval_required' ? 403 : 400 });
    }
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
