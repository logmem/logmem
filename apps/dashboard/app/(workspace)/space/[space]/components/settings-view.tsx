'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
} from 'lucide-react';
import type { SpaceSettingsData } from '../../../../../lib/server/portability';
import {
  BUNDLE_MODES,
  RBAC_CHEATSHEET,
  SECURITY_GUARANTEES,
  buildBundleFilename,
  formatBytes,
  presetById,
  shortHash,
  visiblePresets,
} from '../../../../../lib/portability-model.mjs';

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

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function formatWhen(ts: number): string {
  if (!ts) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return 'Just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function SpaceSettingsView({ initial }: { initial: SpaceSettingsData }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const canManage = initial.permissions.canManageMembers;
  const canExport = initial.permissions.canExport || canManage;
  const canImport = initial.permissions.canImport || canManage;
  const isOwner = initial.viewerRole === 'owner';
  const paramTab = searchParams?.get('tab');
  const defaultTab =
    paramTab === 'export' && canExport
      ? 'export'
      : paramTab === 'import' && canImport
        ? 'import'
        : 'members';

  const [tab, setTab] = useState<'members' | 'export' | 'import'>(defaultTab);
  const [members, setMembers] = useState(initial.members);
  const [invitations, setInvitations] = useState(initial.invitations);
  const [auditHistory, setAuditHistory] = useState(initial.auditHistory);

  // Invite form state
  const presets = visiblePresets({ isOwner });
  const [inviteEmail, setInviteEmail] = useState('');
  const [invitePreset, setInvitePreset] = useState(presets[0]?.id || 'client_viewer');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ link: string; note: string } | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [copiedLink, setCopiedLink] = useState(false);

  // Export state
  const [exportMode, setExportMode] = useState<'blueprint' | 'full'>('full');
  const [clientSafe, setClientSafe] = useState(false);
  const [preflight, setPreflight] = useState<any>(null);
  const [loadingPreflight, setLoadingPreflight] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [lastExport, setLastExport] = useState<{
    filename: string;
    checksum: string;
    sizeBytes: number;
    secretsRedacted?: number;
    internalFiltered?: number;
  } | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);

  // Claim Link state (owner-only transfer-space)
  const [claims, setClaims] = useState(initial.claims || []);
  const [claimEmail, setClaimEmail] = useState('');
  const [claimTtl, setClaimTtl] = useState(7);
  const [claimClientSafe, setClaimClientSafe] = useState(true);
  const [creatingClaim, setCreatingClaim] = useState(false);
  const [freshClaim, setFreshClaim] = useState<{ url: string; checksum: string; expiresAt: number } | null>(null);
  const [claimError, setClaimError] = useState('');
  const [copiedClaim, setCopiedClaim] = useState(false);

  // Import state
  const [fileName, setFileName] = useState('');
  const [bundlePayload, setBundlePayload] = useState<string | null>(null);
  const [bundleEncoding, setBundleEncoding] = useState<'gzip-base64' | 'json' | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<any>(null);
  const [destination, setDestination] = useState<'new' | 'current'>('new');
  const [newSpaceName, setNewSpaceName] = useState('');
  const [conflictMode, setConflictMode] = useState<'skip' | 'overwrite'>('skip');
  const [confirmHash, setConfirmHash] = useState('');
  const [importError, setImportError] = useState('');
  const [importDone, setImportDone] = useState<any>(null);

  function selectTab(next: 'members' | 'export' | 'import') {
    if (next === 'export' && !canExport) return;
    if (next === 'import' && !canImport) return;
    setTab(next);
    const url = next === 'members' ? `/space/${initial.spaceId}/settings` : `/space/${initial.spaceId}/settings?tab=${next}`;
    window.history.replaceState(null, '', url);
  }

  async function loadPreflight(mode: 'blueprint' | 'full', safe = clientSafe) {
    if (!canExport) return;
    setLoadingPreflight(true);
    setExportError('');
    try {
      const [preRes, histRes] = await Promise.all([
        fetch(`/api/space/${initial.spaceId}/portability`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'export-space', mode, clientSafe: safe, dryRun: true }),
        }),
        fetch(`/api/space/${initial.spaceId}/portability`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'audit-history' }),
        }),
      ]);
      const pre = await preRes.json();
      if (!preRes.ok) throw new Error(pre.message || pre.error || 'Preflight failed');
      setPreflight(pre);
      if (histRes.ok) {
        const h = await histRes.json();
        if (Array.isArray(h.history)) setAuditHistory(h.history);
      }
    } catch (e: any) {
      setExportError(e?.message || 'Could not compute preflight counts.');
    } finally {
      setLoadingPreflight(false);
    }
  }

  useEffect(() => {
    if (tab === 'export' && canExport) {
      loadPreflight(exportMode, clientSafe);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, exportMode, clientSafe]);

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    setExportError('');
    try {
      const res = await fetch(`/api/space/${initial.spaceId}/portability`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'export-space',
          mode: exportMode,
          clientSafe,
          gzip: true,
          dryRun: false,
          approved: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Export failed');
      const filename = buildBundleFilename(initial.spaceName, exportMode, Boolean(data.bufferBase64));
      if (data.bufferBase64) {
        triggerDownload(base64ToBlob(data.bufferBase64, 'application/gzip'), filename);
      } else if (data.json) {
        triggerDownload(new Blob([data.json], { type: 'application/json' }), filename);
      }
      setLastExport({
        filename,
        checksum: data.checksum,
        sizeBytes: data.sizeBytes,
        secretsRedacted: data.redaction?.secretsRedacted,
        internalFiltered: data.redaction?.internalFilteredCount,
      });
      await loadPreflight(exportMode, clientSafe);
    } catch (e: any) {
      setExportError(e?.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  async function handleCreateClaim(e: React.FormEvent) {
    e.preventDefault();
    if (creatingClaim) return;
    setCreatingClaim(true);
    setClaimError('');
    setFreshClaim(null);
    try {
      const res = await fetch(`/api/space/${initial.spaceId}/claims`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          mode: exportMode,
          clientSafe: claimClientSafe,
          recipientEmail: claimEmail.trim(),
          ttlDays: claimTtl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Could not create claim link');
      setFreshClaim({ url: data.claimUrl, checksum: data.checksum, expiresAt: data.expiresAt });
      setClaimEmail('');
      setClaims((prev) => [
        {
          id: data.id,
          spaceId: initial.spaceId,
          spaceName: initial.spaceName,
          mode: data.mode,
          clientSafe: data.clientSafe,
          checksum: data.checksum,
          sizeBytes: data.sizeBytes,
          recipientEmailMask: data.recipientEmailMask,
          createdAt: Date.now(),
          expiresAt: data.expiresAt,
          status: 'pending',
        },
        ...prev,
      ]);
    } catch (err: any) {
      setClaimError(err?.message || 'Could not create claim link.');
    } finally {
      setCreatingClaim(false);
    }
  }

  async function handleRevokeClaim(claimId: string) {
    try {
      const res = await fetch(`/api/space/${initial.spaceId}/claims`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'revoke', claimId }),
      });
      if (res.ok) {
        setClaims((prev) => prev.map((c) => (c.id === claimId ? { ...c, status: 'revoked' } : c)));
      }
    } catch {
      // ignore
    }
  }

  async function runPlan(
    payload: string,
    encoding: 'gzip-base64' | 'json',
    dest: 'new' | 'current',
    cMode: 'skip' | 'overwrite',
  ) {
    setPlanning(true);
    setImportError('');
    try {
      const endpoint =
        dest === 'new'
          ? '/api/workspaces/import'
          : `/api/space/${initial.spaceId}/portability`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: initial.workspaceId,
          action: 'import-plan',
          bundle: payload,
          bundleEncoding: encoding,
          overwrite: cMode === 'overwrite',
          skipConflicts: cMode === 'skip',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Bundle verification failed');
      setPlan(data);
      setNewSpaceName((prev) => prev || String(data.sourceSpaceName || data.sourceSpace || 'Imported space').slice(0, 80));
    } catch (e: any) {
      setPlan(null);
      setImportError(e?.message || 'Could not verify bundle.');
    } finally {
      setPlanning(false);
    }
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setImportDone(null);
    setImportError('');
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
      await runPlan(payload, encoding, destination, conflictMode);
    } catch (e: any) {
      setImportError(e?.message || 'Could not read file.');
      setPlanning(false);
    }
  }

  async function handleImportApply() {
    if (!plan || !bundlePayload || !bundleEncoding || applying) return;
    const needsConfirm =
      destination === 'current' && conflictMode === 'overwrite' && (plan.wouldOverwrite || 0) > 0;
    if (needsConfirm && confirmHash.trim() !== shortHash(plan.checksum, 12)) {
      setImportError(`Type ${shortHash(plan.checksum, 12)} to confirm overwriting existing keys.`);
      return;
    }
    setApplying(true);
    setImportError('');
    try {
      const endpoint =
        destination === 'new'
          ? '/api/workspaces/import'
          : `/api/space/${initial.spaceId}/portability`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          destination === 'new'
            ? {
                workspaceId: initial.workspaceId,
                action: 'import-create-space',
                name: newSpaceName || plan.sourceSpaceName || 'Imported space',
                bundle: bundlePayload,
                bundleEncoding,
                checksum: plan.checksum,
                approved: true,
                requestId: crypto.randomUUID(),
              }
            : {
                action: 'import-apply',
                bundle: bundlePayload,
                bundleEncoding,
                approved: true,
                overwrite: conflictMode === 'overwrite',
                skipConflicts: conflictMode === 'skip',
                recordReceipt: true,
              },
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Import failed');
      setImportDone(data);
      if (data.spaceRecord?.id) {
        router.push(`/space/${data.spaceRecord.id}/today`);
        router.refresh();
      } else {
        router.refresh();
      }
    } catch (e: any) {
      setImportError(e?.message || 'Import failed.');
    } finally {
      setApplying(false);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (inviting || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteError('');
    setInviteResult(null);
    try {
      const preset = presetById(invitePreset);
      const res = await fetch(`/api/space/${initial.spaceId}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'invite',
          email: inviteEmail.trim(),
          role: preset.workspaceRole,
          spaces: {
            [initial.spaceId]: { role: preset.spaceRole, canApprove: preset.canApprove },
          },
          requestId: crypto.randomUUID(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send invitation');
      setInviteEmail('');
      if (data.inviteLink) {
        setInviteResult({
          link: data.inviteLink,
          note: data.emailSent
            ? `Invitation emailed (${preset.label}). Link expires in 7 days.`
            : `Invitation created (${preset.label}). Copy and share this link (expires in 7 days).`,
        });
      }
      if (data.id) {
        setInvitations((prev) => [
          ...prev,
          {
            id: data.id,
            role: preset.workspaceRole,
            expiresAt: data.expiresAt || Date.now() + 7 * 86400e3,
            spaceRole: preset.spaceRole as 'editor' | 'viewer',
            canApprove: preset.canApprove,
          },
        ]);
      }
      router.refresh();
    } catch (err: any) {
      setInviteError(err?.message || 'Could not create invitation.');
    } finally {
      setInviting(false);
    }
  }

  async function handleRevokeInvite(invitationId: string) {
    try {
      const res = await fetch(`/api/space/${initial.spaceId}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'revoke-invitation',
          invitationId,
          requestId: crypto.randomUUID(),
        }),
      });
      if (res.ok) {
        setInvitations((prev) => prev.filter((i) => i.id !== invitationId));
        router.refresh();
      }
    } catch {
      // ignore
    }
  }

  async function handleRemoveMember(userId: string) {
    try {
      const res = await fetch(`/api/space/${initial.spaceId}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'remove',
          userId,
          requestId: crypto.randomUUID(),
        }),
      });
      if (res.ok) {
        setMembers((prev) => prev.filter((m) => m.userId !== userId));
        router.refresh();
      }
    } catch {
      // ignore
    }
  }

  const noQuota = destination === 'new' && plan?.quota && !plan.quota.hasQuota;
  const needsConfirm =
    destination === 'current' && conflictMode === 'overwrite' && (plan?.wouldOverwrite || 0) > 0;

  return (
    <div className="space-y-6 font-sans">
      <div
        role="tablist"
        aria-label="Space settings sections"
        className="flex flex-wrap gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-1.5"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'members'}
          onClick={() => selectTab('members')}
          className={`min-h-[40px] rounded-[var(--radius-sm)] border px-3.5 text-xs font-semibold transition-colors ${FOCUS} ${
            tab === 'members'
              ? 'border-[var(--border-strong)] bg-[var(--surface)] text-[var(--brand)]'
              : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]'
          }`}
        >
          Members &amp; RBAC
        </button>
        {canExport ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'export'}
            onClick={() => selectTab('export')}
            className={`min-h-[40px] rounded-[var(--radius-sm)] border px-3.5 text-xs font-semibold transition-colors ${FOCUS} ${
              tab === 'export'
                ? 'border-[var(--border-strong)] bg-[var(--surface)] text-[var(--brand)]'
                : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]'
            }`}
          >
            Export &amp; Handoff
          </button>
        ) : null}
        {canImport ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'import'}
            onClick={() => selectTab('import')}
            className={`min-h-[40px] rounded-[var(--radius-sm)] border px-3.5 text-xs font-semibold transition-colors ${FOCUS} ${
              tab === 'import'
                ? 'border-[var(--border-strong)] bg-[var(--surface)] text-[var(--brand)]'
                : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]'
            }`}
          >
            Import
          </button>
        ) : null}
      </div>

      {tab === 'members' ? (
        <div className="space-y-4">
          <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-subtle)]">
                  WORKSPACE · {initial.workspaceName}
                </p>
                <h2 className="font-heading text-base font-semibold text-[var(--text)]">
                  Access overview
                </h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/space/${initial.spaceId}/access`}
                  className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs font-semibold text-[var(--text)] hover:border-[var(--border-strong)] ${FOCUS}`}
                >
                  <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Agent access ({initial.activeKeyCount} keys)</span>
                </Link>
                {canExport ? (
                  <button
                    type="button"
                    onClick={() => selectTab('export')}
                    className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--text)] hover:border-[var(--border-strong)] ${FOCUS}`}
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Export space</span>
                  </button>
                ) : null}
              </div>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              Your role: <strong className="text-[var(--text)]">{initial.viewerRole}</strong> · Active spaces:{' '}
              <span className="font-mono">{initial.quota.activeSpaces}/{initial.quota.maxSpaces}</span>
            </p>
          </section>

          {canManage ? (
            <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
              <div>
                <h2 className="font-heading text-base font-semibold text-[var(--text)]">
                  Invite a teammate or client
                </h2>
                <p className="text-xs text-[var(--text-muted)]">
                  They see only the spaces you grant. Pick a plain-English role preset — LogMem emails the invite and gives you a copyable link.
                </p>
              </div>
              <form onSubmit={handleInvite} className="grid gap-3 md:grid-cols-12">
                <label className="space-y-1 md:col-span-5">
                  <span className="block text-xs font-medium text-[var(--text-muted)]">Email</span>
                  <input
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="client@company.com"
                    className={`min-h-[40px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs text-[var(--text)] ${FOCUS}`}
                  />
                </label>
                <label className="space-y-1 md:col-span-5">
                  <span className="block text-xs font-medium text-[var(--text-muted)]">
                    Role preset for {initial.spaceName}
                  </span>
                  <select
                    value={invitePreset}
                    onChange={(e) => setInvitePreset(e.target.value)}
                    className={`min-h-[40px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs text-[var(--text)] ${FOCUS}`}
                  >
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-end md:col-span-2">
                  <button
                    type="submit"
                    disabled={inviting}
                    className={`inline-flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--brand)] px-3 text-xs font-semibold text-[var(--surface)] hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
                  >
                    <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{inviting ? 'Sending…' : 'Invite'}</span>
                  </button>
                </div>
              </form>
              <p className="text-xs text-[var(--text-muted)]">{presetById(invitePreset).description}</p>
              {inviteError ? (
                <p role="alert" className="rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger-subtle)] px-3 py-2 text-xs text-[var(--danger)]">
                  {inviteError}
                </p>
              ) : null}
              {inviteResult ? (
                <div role="status" className="space-y-2 rounded-[var(--radius-md)] border border-[var(--success)] bg-[var(--success-subtle)] p-3 text-xs">
                  <p className="font-medium text-[var(--text)]">{inviteResult.note}</p>
                  <div className="flex flex-wrap gap-2">
                    <input
                      readOnly
                      value={inviteResult.link}
                      aria-label="Invitation link"
                      className="min-h-[36px] flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 font-mono text-xs text-[var(--text)]"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(inviteResult.link);
                          setCopiedLink(true);
                          window.setTimeout(() => setCopiedLink(false), 1800);
                        } catch {
                          // ignore
                        }
                      }}
                      className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 font-semibold text-[var(--text)] ${FOCUS}`}
                    >
                      {copiedLink ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copiedLink ? 'Copied' : 'Copy link'}</span>
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : (
            <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4 text-xs text-[var(--text-muted)]">
              Workspace owners and admins manage invitations, role changes, and space exports.
            </div>
          )}

          <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
            <h2 className="font-heading text-base font-semibold text-[var(--text)]">
              People with access ({members.length})
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-[var(--border)] text-[var(--text-subtle)]">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Person</th>
                    <th className="py-2 pr-3 font-medium">Workspace role</th>
                    <th className="py-2 pr-3 font-medium">Space access</th>
                    <th className="py-2 pr-3 font-medium">Decisions</th>
                    {canManage ? <th className="py-2 text-right font-medium">Actions</th> : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {members.map((m) => (
                    <tr key={m.userId}>
                      <td className="py-2.5 pr-3 font-medium text-[var(--text)]">
                        {m.label || m.userId}
                        {m.userId === initial.viewerUserId ? (
                          <span className="ml-2 rounded-[var(--radius-pill)] bg-[var(--brand-subtle)] px-2 py-0.5 text-[10px] font-semibold text-[var(--brand)]">
                            You
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[var(--text-muted)]">{m.role}</td>
                      <td className="py-2.5 pr-3 text-[var(--text-muted)]">{m.spaceRole || '—'}</td>
                      <td className="py-2.5 pr-3">
                        {m.canApprove ? (
                          <span className="rounded-[var(--radius-pill)] bg-[var(--success-subtle)] px-2 py-0.5 text-[11px] font-semibold text-[var(--success)]">
                            Approver
                          </span>
                        ) : (
                          <span className="text-[var(--text-subtle)]">Read-only</span>
                        )}
                      </td>
                      {canManage ? (
                        <td className="py-2.5 text-right">
                          {m.userId !== initial.viewerUserId && m.role !== 'owner' ? (
                            <button
                              type="button"
                              onClick={() => handleRemoveMember(m.userId)}
                              className={`inline-flex min-h-[32px] items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-muted)] hover:border-[var(--danger)] hover:text-[var(--danger)] ${FOCUS}`}
                            >
                              <Trash2 className="h-3 w-3" aria-hidden="true" />
                              <span>Remove</span>
                            </button>
                          ) : (
                            <span className="text-[var(--text-subtle)]">—</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {canManage && invitations.length > 0 ? (
              <div className="space-y-2 border-t border-[var(--border)] pt-4">
                <h3 className="text-xs font-semibold text-[var(--text)]">
                  Pending invitations ({invitations.length})
                </h3>
                <ul className="space-y-2">
                  {invitations.map((inv) => (
                    <li
                      key={inv.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-xs"
                    >
                      <span className="font-mono text-[var(--text)]">
                        {inv.id.slice(0, 12)} · {inv.role}
                        {inv.canApprove ? ' · Approver' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRevokeInvite(inv.id)}
                        className={`min-h-[32px] rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[11px] font-medium text-[var(--text-muted)] hover:border-[var(--danger)] hover:text-[var(--danger)] ${FOCUS}`}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          <details className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4 text-xs">
            <summary className="cursor-pointer font-semibold text-[var(--text)]">
              Role permissions matrix (built-in RBAC)
            </summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left">
                <thead className="border-b border-[var(--border)] text-[var(--text-subtle)]">
                  <tr>
                    <th className="py-1.5 pr-3">Capability</th>
                    <th className="py-1.5 pr-3">Owner</th>
                    <th className="py-1.5 pr-3">Admin</th>
                    <th className="py-1.5 pr-3">Client Approver</th>
                    <th className="py-1.5 pr-3">Team Editor</th>
                    <th className="py-1.5">Client Viewer</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {RBAC_CHEATSHEET.map((r) => {
                    const fmt = (v: boolean | string) => (v === true ? '✓' : v === false ? '—' : v);
                    return (
                      <tr key={r.capability}>
                        <th scope="row" className="py-2 pr-3 font-medium text-[var(--text)]">
                          {r.capability}
                        </th>
                        <td className="py-2 pr-3">{fmt(r.owner)}</td>
                        <td className="py-2 pr-3">{fmt(r.admin)}</td>
                        <td className="py-2 pr-3">{fmt(r.approver)}</td>
                        <td className="py-2 pr-3">{fmt(r.editor)}</td>
                        <td className="py-2">{fmt(r.viewer)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      ) : null}

      {tab === 'export' && canExport ? (
        <div className="space-y-4">
          <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-subtle)]">
                  STEP 1 · PACKAGE MODE
                </p>
                <h2 className="font-heading text-base font-semibold text-[var(--text)]">
                  Choose what to include
                </h2>
              </div>
              <span className="rounded-[var(--radius-pill)] bg-[var(--brand-subtle)] px-2.5 py-1 font-mono text-xs font-semibold text-[var(--brand)]">
                {initial.spaceName}
              </span>
            </div>

            <div role="radiogroup" aria-label="Export bundle mode" className="grid gap-3 md:grid-cols-2">
              {BUNDLE_MODES.map((m) => {
                const selected = exportMode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => {
                      setExportMode(m.id as 'blueprint' | 'full');
                      setLastExport(null);
                    }}
                    className={`flex flex-col gap-2 rounded-[var(--radius-md)] border p-4 text-left transition-colors ${FOCUS} ${
                      selected
                        ? 'border-[var(--brand)] bg-[var(--brand-subtle)]'
                        : 'border-[var(--border)] bg-[var(--surface-sunken)] hover:border-[var(--border-strong)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[var(--text)]">{m.title}</span>
                      <span className="rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
                        {m.badge}
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed text-[var(--text-muted)]">{m.summary}</p>
                    <span className="text-[11px] text-[var(--text-subtle)]">Best for: {m.bestFor}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-subtle)]">
                  STEP 2 · PREFLIGHT MANIFEST
                </p>
                <h2 className="font-heading text-base font-semibold text-[var(--text)]">Ready to pack</h2>
              </div>
              <button
                type="button"
                disabled={loadingPreflight}
                onClick={() => loadPreflight(exportMode)}
                className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)] ${FOCUS}`}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingPreflight ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>Refresh counts</span>
              </button>
            </div>

            {loadingPreflight ? (
              <p className="text-xs text-[var(--text-muted)]">Scanning space keys…</p>
            ) : preflight?.manifest ? (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-6">
                {[
                  ['Agents', preflight.manifest.agents],
                  ['Plans', preflight.manifest.plans],
                  ['Jobs', preflight.manifest.jobs],
                  ['Decisions', preflight.manifest.decisions],
                  ['Log streams', preflight.manifest.traces],
                  ['Est. raw', formatBytes(preflight.estimatedBytes)],
                ].map(([label, val]) => (
                  <div
                    key={String(label)}
                    className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5"
                  >
                    <div className="font-mono text-base font-bold text-[var(--text)]">{val}</div>
                    <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
                  </div>
                ))}
              </div>
            ) : null}

            <label className="flex min-h-[40px] cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3.5 py-2 text-xs text-[var(--text)]">
              <input
                type="checkbox"
                checked={clientSafe}
                onChange={(e) => setClientSafe(e.target.checked)}
              />
              <span>
                <strong>Client-safe filter:</strong> exclude internal channels (<code>internal-*</code>,{' '}
                <code>ops-*</code>, <code>agency-*</code>) and records marked <code>visibility: internal</code>
              </span>
            </label>

            <ul
              aria-label="Security guarantees"
              className="space-y-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3.5 text-xs text-[var(--text-muted)]"
            >
              {SECURITY_GUARANTEES.map((g) => (
                <li key={g} className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--success)]" aria-hidden="true" />
                  <span>{g}</span>
                </li>
              ))}
            </ul>

            {exportError ? (
              <p role="alert" className="rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger-subtle)] px-3 py-2 text-xs text-[var(--danger)]">
                {exportError}
              </p>
            ) : null}

            <button
              type="button"
              disabled={exporting || loadingPreflight}
              onClick={handleExport}
              className={`inline-flex min-h-[42px] items-center gap-2 rounded-[var(--radius-md)] bg-[var(--brand)] px-4 text-xs font-semibold text-[var(--surface)] hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              <span>
                {exporting
                  ? 'Packing redacted bundle…'
                  : `Export ${exportMode === 'blueprint' ? 'Blueprint' : 'Full + Traces'} (.logmem.json.gz)`}
              </span>
            </button>

            {lastExport ? (
              <div role="status" className="space-y-2 rounded-[var(--radius-md)] border border-[var(--success)] bg-[var(--success-subtle)] p-3.5 text-xs">
                <p className="font-semibold text-[var(--text)]">
                  Bundle downloaded: <code className="font-mono">{lastExport.filename}</code>
                </p>
                <div className="flex flex-wrap items-center gap-3 text-[var(--text-muted)]">
                  <span>
                    SHA-256: <code className="font-mono text-[var(--text)]">{shortHash(lastExport.checksum, 16)}…</code>
                  </span>
                  <span>Size: {formatBytes(lastExport.sizeBytes)}</span>
                  {lastExport.secretsRedacted ? <span>Redacted: {lastExport.secretsRedacted} secrets</span> : null}
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(lastExport.checksum);
                        setCopiedHash(true);
                        window.setTimeout(() => setCopiedHash(false), 1800);
                      } catch {
                        // ignore
                      }
                    }}
                    className={`inline-flex min-h-[32px] items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 font-semibold text-[var(--text)] ${FOCUS}`}
                  >
                    {copiedHash ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>{copiedHash ? 'Copied' : 'Copy SHA-256'}</span>
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          {initial.permissions.canTransfer ? (
            <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-subtle)]">
                  CLIENT DELIVERY · OWNER ONLY
                </p>
                <h2 className="font-heading text-base font-semibold text-[var(--text)]">
                  1-Click Client Claim Link
                </h2>
                <p className="text-xs text-[var(--text-muted)]">
                  Generate a single-use signed link so a client can import this {exportMode === 'blueprint' ? 'Blueprint' : 'Full + Traces'} space directly into their own LogMem workspace with zero file downloads.
                </p>
              </div>
              <form onSubmit={handleCreateClaim} className="grid gap-3 md:grid-cols-12">
                <label className="space-y-1 md:col-span-6">
                  <span className="block text-xs font-medium text-[var(--text-muted)]">
                    Lock to recipient email (optional)
                  </span>
                  <input
                    type="email"
                    value={claimEmail}
                    onChange={(e) => setClaimEmail(e.target.value)}
                    placeholder="client@company.com"
                    className={`min-h-[40px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs text-[var(--text)] ${FOCUS}`}
                  />
                </label>
                <label className="space-y-1 md:col-span-3">
                  <span className="block text-xs font-medium text-[var(--text-muted)]">Expires in</span>
                  <select
                    value={claimTtl}
                    onChange={(e) => setClaimTtl(Number(e.target.value))}
                    className={`min-h-[40px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs text-[var(--text)] ${FOCUS}`}
                  >
                    <option value={7}>7 days</option>
                    <option value={14}>14 days</option>
                    <option value={30}>30 days</option>
                  </select>
                </label>
                <div className="flex items-end md:col-span-3">
                  <button
                    type="submit"
                    disabled={creatingClaim}
                    className={`min-h-[40px] w-full rounded-[var(--radius-md)] bg-[var(--brand)] px-3 text-xs font-semibold text-[var(--surface)] hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
                  >
                    {creatingClaim ? 'Creating…' : 'Create claim link'}
                  </button>
                </div>
              </form>
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--text-muted)]">
                <input
                  type="checkbox"
                  checked={claimClientSafe}
                  onChange={(e) => setClaimClientSafe(e.target.checked)}
                />
                <span>Apply client-safe filter (strip internal channels &amp; notes)</span>
              </label>
              {claimError ? (
                <p role="alert" className="rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger-subtle)] px-3 py-2 text-xs text-[var(--danger)]">
                  {claimError}
                </p>
              ) : null}
              {freshClaim ? (
                <div role="status" className="space-y-2 rounded-[var(--radius-md)] border border-[var(--success)] bg-[var(--success-subtle)] p-3 text-xs">
                  <p className="font-semibold text-[var(--text)]">
                    Claim link created (single-use · SHA-256 <code className="font-mono">{shortHash(freshClaim.checksum, 12)}</code>). Copy now — the raw token is shown once.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <input
                      readOnly
                      value={freshClaim.url}
                      aria-label="Client claim link"
                      className="min-h-[36px] flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 font-mono text-xs text-[var(--text)]"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(freshClaim.url);
                          setCopiedClaim(true);
                          window.setTimeout(() => setCopiedClaim(false), 1800);
                        } catch {
                          // ignore
                        }
                      }}
                      className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 font-semibold text-[var(--text)] ${FOCUS}`}
                    >
                      {copiedClaim ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copiedClaim ? 'Copied' : 'Copy link'}</span>
                    </button>
                  </div>
                </div>
              ) : null}
              {claims.length > 0 ? (
                <div className="overflow-x-auto border-t border-[var(--border)] pt-3">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-[var(--border)] text-[var(--text-subtle)]">
                      <tr>
                        <th className="py-1.5 pr-3">Status</th>
                        <th className="py-1.5 pr-3">Mode</th>
                        <th className="py-1.5 pr-3">Lock</th>
                        <th className="py-1.5 pr-3">Checksum</th>
                        <th className="py-1.5 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {claims.map((c) => (
                        <tr key={c.id}>
                          <td className="py-2 pr-3 font-mono text-[var(--text)]">{c.status}</td>
                          <td className="py-2 pr-3 text-[var(--text-muted)]">
                            {c.mode}{c.clientSafe ? ' · client-safe' : ''}
                          </td>
                          <td className="py-2 pr-3 text-[var(--text-muted)]">{c.recipientEmailMask || 'Any email'}</td>
                          <td className="py-2 pr-3 font-mono text-[var(--text-subtle)]">{shortHash(c.checksum, 10)}</td>
                          <td className="py-2 text-right">
                            {c.status === 'pending' ? (
                              <button
                                type="button"
                                onClick={() => handleRevokeClaim(c.id)}
                                className={`min-h-[30px] rounded-[var(--radius-sm)] border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-muted)] hover:border-[var(--danger)] hover:text-[var(--danger)] ${FOCUS}`}
                              >
                                Revoke
                              </button>
                            ) : (
                              <span className="text-[var(--text-subtle)]">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
            <h2 className="font-heading text-base font-semibold text-[var(--text)]">
              Export &amp; import audit trail
            </h2>
            {auditHistory.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-[var(--border)] text-[var(--text-subtle)]">
                    <tr>
                      <th className="py-2 pr-3">Event</th>
                      <th className="py-2 pr-3">Mode</th>
                      <th className="py-2 pr-3">Checksum</th>
                      <th className="py-2 pr-3">Details</th>
                      <th className="py-2">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {auditHistory.map((row, idx) => (
                      <tr key={`${row.at}-${idx}`}>
                        <td className="py-2 pr-3 font-medium text-[var(--text)]">
                          {row.kind === 'space-exported' ? 'Exported' : 'Imported'}
                        </td>
                        <td className="py-2 pr-3 text-[var(--text-muted)]">{row.mode || 'full'}</td>
                        <td className="py-2 pr-3 font-mono text-[var(--text-muted)]">
                          {shortHash(row.checksum || '', 12)}
                        </td>
                        <td className="py-2 pr-3 text-[var(--text-muted)]">
                          {row.kind === 'space-exported'
                            ? formatBytes(row.sizeBytes || 0)
                            : `${row.created || 0} keys from ${row.sourceSpace || 'bundle'}`}
                        </td>
                        <td className="py-2 text-[var(--text-subtle)]">{formatWhen(row.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">No exports or imports recorded for this space yet.</p>
            )}
          </section>
        </div>
      ) : null}

      {tab === 'import' && canImport ? (
        <div className="space-y-4">
          <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-subtle)]">
                  STEP 1 · UPLOAD &amp; VERIFY
                </p>
                <h2 className="font-heading text-base font-semibold text-[var(--text)]">
                  Select a LogMem space bundle
                </h2>
              </div>
              {plan ? (
                <span className="rounded-[var(--radius-pill)] bg-[var(--success-subtle)] px-2.5 py-1 text-xs font-semibold text-[var(--success)]">
                  ✓ Checksum verified
                </span>
              ) : null}
            </div>

            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                onPickFile(e.dataTransfer?.files?.[0]);
              }}
              className="flex min-h-[112px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)] p-5 text-center transition-colors hover:border-[var(--brand)]"
            >
              <input
                type="file"
                accept=".gz,.json,.logmem.json,.logmem.json.gz"
                className="sr-only"
                onChange={(e) => onPickFile(e.target.files?.[0])}
              />
              <Upload className="h-5 w-5 text-[var(--brand)]" aria-hidden="true" />
              <span className="text-xs font-semibold text-[var(--text)]">
                {fileName || 'Drop a .logmem.json.gz or .json bundle here, or click to browse'}
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                Supports v1 and v2 bundles up to 15 MB. SHA-256 verified before any write.
              </span>
            </label>

            {planning ? <p className="text-xs text-[var(--text-muted)]">Verifying SHA-256 checksum and planning import…</p> : null}
            {importError ? (
              <p role="alert" className="rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger-subtle)] px-3 py-2 text-xs text-[var(--danger)]">
                {importError}
              </p>
            ) : null}
          </section>

          {plan ? (
            <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-subtle)]">
                    STEP 2 · DRY-RUN PREVIEW
                  </p>
                  <h2 className="font-heading text-base font-semibold text-[var(--text)]">
                    Inspect before writing
                  </h2>
                </div>
                <span className="rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-1 font-mono text-xs text-[var(--text-muted)]">
                  {plan.mode || 'full'} · {shortHash(plan.checksum, 12)}
                </span>
              </div>

              <p className="text-xs text-[var(--text-muted)]">
                Source: <strong className="text-[var(--text)]">{plan.sourceSpaceName || plan.sourceSpace}</strong> · Format:{' '}
                <code className="font-mono">{plan.format}</code>
              </p>

              {plan.manifest ? (
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                  {[
                    ['Agents', plan.manifest.agents],
                    ['Plans', plan.manifest.plans],
                    ['Jobs', plan.manifest.jobs],
                    ['Decisions', plan.manifest.decisions],
                    ['Traces', plan.manifest.traces],
                  ].map(([label, val]) => (
                    <div
                      key={String(label)}
                      className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2"
                    >
                      <div className="font-mono text-base font-bold text-[var(--text)]">{val}</div>
                      <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
                    </div>
                  ))}
                </div>
              ) : null}

              {plan.manifest?.sampleAgents?.length || plan.manifest?.samplePlans?.length ? (
                <details className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3 text-xs">
                  <summary className="cursor-pointer font-semibold text-[var(--text)]">
                    Peek inside bundle ({plan.manifest.sampleAgents?.length || 0} sample agents,{' '}
                    {plan.manifest.samplePlans?.length || 0} sample plans)
                  </summary>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    {plan.manifest.sampleAgents?.length ? (
                      <div>
                        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">
                          Agents
                        </p>
                        <ul className="space-y-1">
                          {plan.manifest.sampleAgents.map((a: any) => (
                            <li key={a.id} className="text-[var(--text)]">
                              <code className="font-mono">{a.id}</code>
                              {a.role ? <span className="text-[var(--text-muted)]"> — {a.role}</span> : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {plan.manifest.samplePlans?.length ? (
                      <div>
                        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">
                          Plans
                        </p>
                        <ul className="space-y-1">
                          {plan.manifest.samplePlans.map((pl: any) => (
                            <li key={pl.id} className="font-medium text-[var(--text)]">
                              {pl.title}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <label className="inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs font-medium text-[var(--text)]">
                  <input
                    type="radio"
                    name="dest"
                    checked={destination === 'new'}
                    onChange={() => {
                      setDestination('new');
                      if (bundlePayload && bundleEncoding) runPlan(bundlePayload, bundleEncoding, 'new', conflictMode);
                    }}
                  />
                  <span>Create a new space (recommended)</span>
                </label>
                <label className="inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs font-medium text-[var(--text)]">
                  <input
                    type="radio"
                    name="dest"
                    checked={destination === 'current'}
                    onChange={() => {
                      setDestination('current');
                      if (bundlePayload && bundleEncoding) runPlan(bundlePayload, bundleEncoding, 'current', conflictMode);
                    }}
                  />
                  <span>Merge into {initial.spaceName}</span>
                </label>
              </div>

              {destination === 'new' ? (
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-[var(--text-muted)]" htmlFor="new-space-name">
                    New space name
                  </label>
                  <input
                    id="new-space-name"
                    maxLength={80}
                    value={newSpaceName}
                    onChange={(e) => setNewSpaceName(e.target.value)}
                    className={`min-h-[40px] w-full max-w-md rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs text-[var(--text)] ${FOCUS}`}
                  />
                  {plan.quota ? (
                    <p className="text-[11px] text-[var(--text-muted)]">
                      Workspace space quota: {plan.quota.activeSpaces} / {plan.quota.maxSpaces} active spaces.
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-4 text-xs text-[var(--text-muted)]">
                    <span>
                      Would create: <strong className="font-mono text-[var(--text)]">{plan.wouldCreate}</strong>
                    </span>
                    <span>
                      Conflicts: <strong className="font-mono text-[var(--text)]">{plan.conflicts?.length || 0}</strong>
                    </span>
                    <span>
                      Would overwrite: <strong className="font-mono text-[var(--text)]">{plan.wouldOverwrite || 0}</strong>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs">
                      <input
                        type="radio"
                        name="conflict-mode"
                        checked={conflictMode === 'skip'}
                        onChange={() => {
                          setConflictMode('skip');
                          if (bundlePayload && bundleEncoding) runPlan(bundlePayload, bundleEncoding, 'current', 'skip');
                        }}
                      />
                      <span>Skip existing keys (safe)</span>
                    </label>
                    <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs">
                      <input
                        type="radio"
                        name="conflict-mode"
                        checked={conflictMode === 'overwrite'}
                        onChange={() => {
                          setConflictMode('overwrite');
                          if (bundlePayload && bundleEncoding) runPlan(bundlePayload, bundleEncoding, 'current', 'overwrite');
                        }}
                      />
                      <span>Overwrite existing keys</span>
                    </label>
                  </div>
                  {needsConfirm ? (
                    <label className="block space-y-1 text-xs">
                      <span className="text-[var(--text-muted)]">
                        Type <code className="font-mono text-[var(--text)]">{shortHash(plan.checksum, 12)}</code> to confirm overwrite
                      </span>
                      <input
                        value={confirmHash}
                        onChange={(e) => setConfirmHash(e.target.value)}
                        className={`min-h-[38px] w-full max-w-xs rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 font-mono text-xs text-[var(--text)] ${FOCUS}`}
                      />
                    </label>
                  ) : null}
                </div>
              )}

              {noQuota ? (
                <p role="alert" className="rounded-[var(--radius-md)] border border-[var(--warning)] bg-[var(--warning-subtle)] px-3 py-2 text-xs text-[var(--text)]">
                  Workspace is at its active space limit ({plan.quota.activeSpaces}/{plan.quota.maxSpaces}). Archive a space or merge into an existing space.
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={applying || planning || noQuota}
                  onClick={handleImportApply}
                  className={`inline-flex min-h-[42px] items-center gap-2 rounded-[var(--radius-md)] bg-[var(--brand)] px-4 text-xs font-semibold text-[var(--surface)] hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
                >
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  <span>
                    {applying
                      ? 'Importing space…'
                      : destination === 'new'
                        ? `Create "${newSpaceName || 'Imported space'}" & import`
                        : 'Apply import'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={applying}
                  onClick={() => {
                    setFileName('');
                    setBundlePayload(null);
                    setBundleEncoding(null);
                    setPlan(null);
                    setImportError('');
                    setConfirmHash('');
                  }}
                  className={`inline-flex min-h-[42px] items-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)] ${FOCUS}`}
                >
                  Choose different file
                </button>
              </div>
            </section>
          ) : null}

          {importDone ? (
            <div role="status" className="rounded-[var(--radius-md)] border border-[var(--success)] bg-[var(--success-subtle)] p-4 text-xs text-[var(--text)]">
              <strong>Import complete.</strong> Created {importDone.written?.created || 0} keys
              {importDone.written?.overwritten ? `, updated ${importDone.written.overwritten}` : ''}. Connect fresh agent keys in{' '}
              <Link href={`/space/${importDone.spaceRecord?.id || initial.spaceId}/access`} className="font-semibold underline">
                Agent access
              </Link>
              .
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
