'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { SECURITY_GUARANTEES, formatBytes, shortHash } from '../../../../lib/portability-model.mjs';

interface ClaimWorkspaceOption {
  id: string;
  name: string;
  role: string;
}

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

export function ClaimSpaceClient({
  token,
  preview,
  workspaces,
  signedInEmail,
}: {
  token: string;
  preview: any;
  workspaces: ClaimWorkspaceOption[];
  signedInEmail: string;
}) {
  const router = useRouter();
  const [targetWorkspaceId, setTargetWorkspaceId] = useState(workspaces[0]?.id || '');
  const [spaceName, setSpaceName] = useState(String(preview.sourceSpaceName || 'Claimed space').slice(0, 80));
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState('');

  async function onClaim(e: React.FormEvent) {
    e.preventDefault();
    if (!targetWorkspaceId || claiming) return;
    setClaiming(true);
    setError('');
    try {
      const res = await fetch('/api/claims', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'accept',
          token,
          targetWorkspaceId,
          spaceName: spaceName.trim() || preview.sourceSpaceName,
          requestId: crypto.randomUUID(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Could not claim space');
      router.push(`/space/${data.spaceRecord.id}/today`);
      router.refresh();
    } catch (err: any) {
      setError(err?.message || 'Could not claim space.');
      setClaiming(false);
    }
  }

  const m = preview.manifest || {};

  return (
    <div className="w-full max-w-xl rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm space-y-5">
      <div className="space-y-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--success-subtle)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--success)]">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>SHA-256 verified · {preview.mode === 'blueprint' ? 'Blueprint' : 'Full Space + Traces'}</span>
        </span>
        <h1 className="font-heading text-xl font-bold text-[var(--text)]">
          {preview.sourceWorkspaceName} prepared a LogMem space for you
        </h1>
        <p className="text-xs text-[var(--text-muted)]">
          Space: <strong className="text-[var(--text)]">{preview.sourceSpaceName}</strong> · Size:{' '}
          {formatBytes(preview.sizeBytes)} · Checksum:{' '}
          <code className="font-mono">{shortHash(preview.checksum, 12)}</code>
          {preview.clientSafe ? ' · Client-safe filtered' : ''}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
        {[
          ['Agents', m.agents || 0],
          ['Plans', m.plans || 0],
          ['Jobs', m.jobs || 0],
          ['Decisions', m.decisions || 0],
          ['Traces', m.traces || 0],
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

      {m.sampleAgents?.length || m.samplePlans?.length ? (
        <details className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3 text-xs">
          <summary className="cursor-pointer font-semibold text-[var(--text)]">
            Peek inside space ({m.sampleAgents?.length || 0} sample agents, {m.samplePlans?.length || 0} sample plans)
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {m.sampleAgents?.length ? (
              <div>
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">Agents</p>
                <ul className="space-y-1">
                  {m.sampleAgents.map((a: any) => (
                    <li key={a.id}>
                      <code className="font-mono">{a.id}</code>
                      {a.role ? <span className="text-[var(--text-muted)]"> — {a.role}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {m.samplePlans?.length ? (
              <div>
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">Plans</p>
                <ul className="space-y-1">
                  {m.samplePlans.map((p: any) => (
                    <li key={p.id} className="font-medium">
                      {p.title}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      <ul className="space-y-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3 text-xs text-[var(--text-muted)]">
        {SECURITY_GUARANTEES.map((g) => (
          <li key={g} className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--success)]" aria-hidden="true" />
            <span>{g}</span>
          </li>
        ))}
      </ul>

      {workspaces.length === 0 ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--warning)] bg-[var(--warning-subtle)] p-3 text-xs text-[var(--text)]">
          You need to be an owner or admin of a LogMem workspace to claim this space.
        </div>
      ) : (
        <form onSubmit={onClaim} className="space-y-3">
          {workspaces.length > 1 ? (
            <label className="block space-y-1 text-xs">
              <span className="font-medium text-[var(--text-muted)]">Target workspace</span>
              <select
                value={targetWorkspaceId}
                onChange={(e) => setTargetWorkspaceId(e.target.value)}
                className={`min-h-[40px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs text-[var(--text)] ${FOCUS}`}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.role})
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="block space-y-1 text-xs">
            <span className="font-medium text-[var(--text-muted)]">Space name in your workspace</span>
            <input
              required
              maxLength={80}
              value={spaceName}
              onChange={(e) => setSpaceName(e.target.value)}
              className={`min-h-[40px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 text-xs text-[var(--text)] ${FOCUS}`}
            />
          </label>

          {error ? (
            <p role="alert" className="rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger-subtle)] px-3 py-2 text-xs text-[var(--danger)]">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={claiming}
              className={`min-h-[42px] rounded-[var(--radius-md)] bg-[var(--brand)] px-4 text-xs font-semibold text-[var(--surface)] hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
            >
              {claiming ? 'Claiming space…' : 'Claim into my workspace'}
            </button>
            <Link
              href="/select-space"
              className={`inline-flex min-h-[42px] items-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)] ${FOCUS}`}
            >
              Not now
            </Link>
          </div>
          {signedInEmail ? (
            <p className="text-[11px] text-[var(--text-subtle)]">Signed in as {signedInEmail}.</p>
          ) : null}
        </form>
      )}
    </div>
  );
}
