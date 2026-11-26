'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { shortHash } from '../../../lib/portability-model.mjs';

export interface SelectableSpace {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  canApprove: boolean;
}

export interface SelectableWorkspace {
  id: string;
  name: string;
  role: string;
}

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function SelectSpaceClient({
  workspaces,
  spaces,
  initialMode,
}: {
  workspaces: SelectableWorkspace[];
  spaces: SelectableSpace[];
  initialMode?: 'create' | 'import' | null;
}) {
  const router = useRouter();
  const manageableWorkspaces = workspaces.filter((w) => w.role === 'owner' || w.role === 'admin');
  const creatableWorkspaces = workspaces.filter((w) => w.role !== 'viewer' && w.role !== 'contributor');

  const [panel, setPanel] = useState<'none' | 'create' | 'import'>(
    initialMode === 'import' && manageableWorkspaces.length > 0
      ? 'import'
      : initialMode === 'create' && creatableWorkspaces.length > 0
        ? 'create'
        : 'none',
  );
  const [targetWs, setTargetWs] = useState(
    manageableWorkspaces[0]?.id || creatableWorkspaces[0]?.id || '',
  );
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState('');

  // Import state
  const [fileName, setFileName] = useState('');
  const [bundlePayload, setBundlePayload] = useState<string | null>(null);
  const [bundleEncoding, setBundleEncoding] = useState<'gzip-base64' | 'json' | null>(null);
  const [plan, setPlan] = useState<any>(null);
  const [importName, setImportName] = useState('');
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [importErr, setImportErr] = useState('');

  async function onCreateSpace(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !targetWs || creating) return;
    setCreating(true);
    setCreateErr('');
    try {
      const res = await fetch('/api/workspaces/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: targetWs,
          action: 'create-space',
          name: newName.trim(),
          requestId: crypto.randomUUID(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create space');
      router.push(`/space/${data.space.id}/today`);
      router.refresh();
    } catch (err: any) {
      setCreateErr(err?.message || 'Could not create space.');
      setCreating(false);
    }
  }

  async function onPickFile(file: File | undefined) {
    if (!file || !targetWs) return;
    setFileName(file.name);
    setImportErr('');
    setPlan(null);
    setPlanning(true);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const isGz = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
      const payload = isGz ? arrayBufferToBase64(buf) : new TextDecoder().decode(bytes);
      const encoding = isGz ? 'gzip-base64' : 'json';
      setBundlePayload(payload);
      setBundleEncoding(encoding);

      const res = await fetch('/api/workspaces/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: targetWs,
          action: 'import-plan',
          bundle: payload,
          bundleEncoding: encoding,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Bundle verification failed');
      setPlan(data);
      setImportName(String(data.sourceSpaceName || data.sourceSpace || 'Imported space').slice(0, 80));
    } catch (err: any) {
      setImportErr(err?.message || 'Could not inspect bundle.');
    } finally {
      setPlanning(false);
    }
  }

  async function onApplyImport() {
    if (!plan || !bundlePayload || !bundleEncoding || !targetWs || applying) return;
    setApplying(true);
    setImportErr('');
    try {
      const res = await fetch('/api/workspaces/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: targetWs,
          action: 'import-create-space',
          name: importName || plan.sourceSpaceName || 'Imported space',
          bundle: bundlePayload,
          bundleEncoding,
          checksum: plan.checksum,
          approved: true,
          requestId: crypto.randomUUID(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Import failed');
      router.push(`/space/${data.spaceRecord.id}/today`);
      router.refresh();
    } catch (err: any) {
      setImportErr(err?.message || 'Import failed.');
      setApplying(false);
    }
  }

  return (
    <div className="w-full max-w-xl rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-bold text-[var(--brand)]">Select a space</h1>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {spaces.length === 0
              ? 'Create a space or import a portable LogMem bundle to get started.'
              : 'Choose a space to enter, or create / import a new space.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {creatableWorkspaces.length > 0 ? (
            <button
              type="button"
              onClick={() => setPanel((p) => (p === 'create' ? 'none' : 'create'))}
              className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs font-semibold text-[var(--text)] hover:border-[var(--border-strong)] ${FOCUS}`}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>New space</span>
            </button>
          ) : null}
          {manageableWorkspaces.length > 0 ? (
            <button
              type="button"
              onClick={() => setPanel((p) => (p === 'import' ? 'none' : 'import'))}
              className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--brand)] px-3 text-xs font-semibold text-[var(--surface)] hover:opacity-90 ${FOCUS}`}
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Import space</span>
            </button>
          ) : null}
        </div>
      </div>

      {panel === 'create' && creatableWorkspaces.length > 0 ? (
        <form
          onSubmit={onCreateSpace}
          className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4"
        >
          <p className="text-xs font-semibold text-[var(--text)]">Create a blank space</p>
          {creatableWorkspaces.length > 1 ? (
            <select
              value={targetWs}
              onChange={(e) => setTargetWs(e.target.value)}
              aria-label="Workspace"
              className={`min-h-[38px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text)] ${FOCUS}`}
            >
              {creatableWorkspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : null}
          <input
            required
            maxLength={80}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Client Onboarding or Q4 Launch"
            className={`min-h-[40px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text)] ${FOCUS}`}
          />
          {createErr ? (
            <p role="alert" className="text-xs text-[var(--danger)]">
              {createErr}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={creating}
              className={`min-h-[38px] rounded-[var(--radius-md)] bg-[var(--brand)] px-3.5 text-xs font-semibold text-[var(--surface)] disabled:opacity-50 ${FOCUS}`}
            >
              {creating ? 'Creating…' : 'Create space'}
            </button>
            <button
              type="button"
              onClick={() => setPanel('none')}
              className={`min-h-[38px] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text-muted)] ${FOCUS}`}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {panel === 'import' && manageableWorkspaces.length > 0 ? (
        <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-[var(--text)]">Import a portable LogMem bundle</p>
            {plan ? (
              <span className="rounded-[var(--radius-pill)] bg-[var(--success-subtle)] px-2 py-0.5 text-[11px] font-semibold text-[var(--success)]">
                ✓ Verified
              </span>
            ) : null}
          </div>
          {manageableWorkspaces.length > 1 ? (
            <select
              value={targetWs}
              onChange={(e) => setTargetWs(e.target.value)}
              aria-label="Target workspace"
              className={`min-h-[38px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text)] ${FOCUS}`}
            >
              {manageableWorkspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : null}
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onPickFile(e.dataTransfer?.files?.[0]);
            }}
            className="flex min-h-[88px] cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--radius-md)] border border-dashed border-[var(--border-strong)] bg-[var(--surface)] p-4 text-center hover:border-[var(--brand)]"
          >
            <input
              type="file"
              accept=".gz,.json,.logmem.json,.logmem.json.gz"
              className="sr-only"
              onChange={(e) => onPickFile(e.target.files?.[0])}
            />
            <span className="text-xs font-medium text-[var(--text)]">
              {fileName || 'Drop .logmem.json.gz or .json here, or click to select'}
            </span>
            <span className="text-[11px] text-[var(--text-muted)]">
              SHA-256 verified · zero agent keys transferred
            </span>
          </label>
          {planning ? <p className="text-xs text-[var(--text-muted)]">Inspecting bundle…</p> : null}
          {importErr ? (
            <p role="alert" className="text-xs text-[var(--danger)]">
              {importErr}
            </p>
          ) : null}
          {plan ? (
            <div className="space-y-3 border-t border-[var(--border)] pt-3 text-xs">
              <p className="text-[var(--text-muted)]">
                <strong className="text-[var(--text)]">{plan.manifest?.agents || 0} agents</strong> ·{' '}
                {plan.manifest?.plans || 0} plans · {plan.manifest?.jobs || 0} jobs ·{' '}
                {plan.manifest?.traces || 0} traces · <code className="font-mono">{shortHash(plan.checksum, 12)}</code>
              </p>
              <input
                maxLength={80}
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                aria-label="New space name"
                className={`min-h-[38px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text)] ${FOCUS}`}
              />
              {plan.quota && !plan.quota.hasQuota ? (
                <p role="alert" className="text-xs text-[var(--warning)]">
                  Space limit reached ({plan.quota.activeSpaces}/{plan.quota.maxSpaces}).
                </p>
              ) : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={applying || (plan.quota && !plan.quota.hasQuota)}
                  onClick={onApplyImport}
                  className={`min-h-[38px] rounded-[var(--radius-md)] bg-[var(--brand)] px-3.5 text-xs font-semibold text-[var(--surface)] disabled:opacity-50 ${FOCUS}`}
                >
                  {applying ? 'Importing…' : `Create "${importName || 'Imported space'}" & import`}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPlan(null);
                    setFileName('');
                  }}
                  className={`min-h-[38px] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text-muted)] ${FOCUS}`}
                >
                  Reset
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {spaces.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          You are not in a space yet. Ask a workspace admin for an invitation or import a space bundle above.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {spaces.map((s) => (
            <li key={s.id}>
              <Link
                href={`/space/${s.id}/today`}
                className={`flex min-h-[52px] items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3 text-sm transition-colors hover:border-[var(--brand)] ${FOCUS}`}
              >
                <div className="min-w-0">
                  <div className="truncate font-semibold text-[var(--text)]">{s.name}</div>
                  <div className="truncate text-xs text-[var(--text-muted)]">{s.workspaceName}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                    {s.role}
                  </span>
                  {s.canApprove ? (
                    <span className="rounded-[var(--radius-pill)] bg-[var(--brand-subtle)] px-2 py-0.5 text-[10px] font-semibold text-[var(--brand)]">
                      Approver
                    </span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
