'use client';

import { useMemo, useState } from 'react';
import { Search, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import type { AdminBillingData } from '../../../../lib/server/billing';

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

const STATUS_OPTIONS = ['active', 'trialing', 'comped', 'past_due', 'canceled'] as const;

type WorkspaceRow = AdminBillingData['workspaces'][number];

function fmtLimit(val: number | null | undefined): string {
  return val === null || val === undefined ? '∞' : val.toLocaleString();
}

function statusBadge(status: string): string {
  if (status === 'comped' || status === 'active') {
    return 'border-[var(--success)] bg-[var(--success-subtle)] text-[var(--success)]';
  }
  if (status === 'trialing') {
    return 'border-[var(--brand)] bg-[var(--brand-subtle)] text-[var(--brand)]';
  }
  if (status === 'past_due' || status === 'canceled') {
    return 'border-[var(--danger)] bg-[var(--danger-subtle)] text-[var(--danger)]';
  }
  return 'border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-muted)]';
}

export function AdminBillingView({ initial }: { initial: AdminBillingData }) {
  const [data, setData] = useState<AdminBillingData>(initial);
  const [search, setSearch] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<WorkspaceRow | null>(
    initial.workspaces[0] || null
  );

  // Editor state
  const [editPlan, setEditPlan] = useState(selected?.plan || 'free');
  const [editStatus, setEditStatus] = useState(selected?.billingStatus || 'active');
  const [editEmail, setEditEmail] = useState(selected?.billingEmail || '');
  const [editNote, setEditNote] = useState(selected?.billingNote || '');
  const [editExtId, setEditExtId] = useState(selected?.externalCustomerId || '');
  const [ovSpaces, setOvSpaces] = useState(
    selected?.limitOverrides?.spaces !== undefined
      ? String(selected.limitOverrides.spaces ?? 'unlimited')
      : ''
  );
  const [ovAgents, setOvAgents] = useState(
    selected?.limitOverrides?.agents !== undefined
      ? String(selected.limitOverrides.agents ?? 'unlimited')
      : ''
  );
  const [ovAdd, setOvAdd] = useState(
    selected?.limitOverrides?.add !== undefined
      ? String(selected.limitOverrides.add ?? 'unlimited')
      : ''
  );
  const [ovRecall, setOvRecall] = useState(
    selected?.limitOverrides?.recall !== undefined
      ? String(selected.limitOverrides.recall ?? 'unlimited')
      : ''
  );
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  function selectWorkspace(row: WorkspaceRow) {
    setSelected(row);
    setEditPlan(row.plan);
    setEditStatus(row.billingStatus);
    setEditEmail(row.billingEmail || '');
    setEditNote(row.billingNote || '');
    setEditExtId(row.externalCustomerId || '');
    setOvSpaces(
      row.limitOverrides?.spaces !== undefined ? String(row.limitOverrides.spaces ?? 'unlimited') : ''
    );
    setOvAgents(
      row.limitOverrides?.agents !== undefined ? String(row.limitOverrides.agents ?? 'unlimited') : ''
    );
    setOvAdd(
      row.limitOverrides?.add !== undefined ? String(row.limitOverrides.add ?? 'unlimited') : ''
    );
    setOvRecall(
      row.limitOverrides?.recall !== undefined ? String(row.limitOverrides.recall ?? 'unlimited') : ''
    );
    setFeedback(null);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.workspaces.filter((w) => {
      if (planFilter && w.plan !== planFilter) return false;
      if (statusFilter && w.billingStatus !== statusFilter) return false;
      if (!q) return true;
      return (
        w.name.toLowerCase().includes(q) ||
        w.workspaceId.toLowerCase().includes(q) ||
        (w.tenantId && w.tenantId.toLowerCase().includes(q)) ||
        (w.billingEmail && w.billingEmail.toLowerCase().includes(q)) ||
        w.ownerIds.some((id) => id.toLowerCase().includes(q))
      );
    });
  }, [data.workspaces, search, planFilter, statusFilter]);

  function parseOverride(raw: string): number | null | undefined {
    const t = raw.trim().toLowerCase();
    if (!t) return undefined;
    if (t === 'unlimited' || t === 'null' || t === '∞') return null;
    const n = Number(t);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  }

  async function saveChanges(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const limitOverrides: Record<string, number | null | undefined> = {
        spaces: parseOverride(ovSpaces),
        agents: parseOverride(ovAgents),
        add: parseOverride(ovAdd),
        recall: parseOverride(ovRecall),
      };
      const res = await fetch('/api/admin/billing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: selected.workspaceId,
          plan: editPlan,
          billingStatus: editStatus,
          billingEmail: editEmail.trim() || null,
          billingNote: editNote.trim() || null,
          externalCustomerId: editExtId.trim() || null,
          limitOverrides,
          requestId: crypto.randomUUID(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || json.error || 'Failed to update workspace billing');

      const refresh = await fetch('/api/admin/billing', { cache: 'no-store' });
      const refreshed = await refresh.json();
      if (refresh.ok && refreshed.data) {
        setData({ ...refreshed.data, actor: refreshed.actor || data.actor });
        const updated = refreshed.data.workspaces.find(
          (w: WorkspaceRow) => w.workspaceId === selected.workspaceId
        );
        if (updated) selectWorkspace(updated);
      }
      setFeedback({
        kind: 'ok',
        text: `Updated ${selected.name} (${editPlan.toUpperCase()} · ${editStatus}).`,
      });
    } catch (err: any) {
      setFeedback({ kind: 'err', text: err?.message || 'Update failed.' });
    } finally {
      setSaving(false);
    }
  }

  async function clearAllOverrides() {
    if (!selected || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/admin/billing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: selected.workspaceId,
          clearOverrides: true,
          requestId: crypto.randomUUID(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || json.error || 'Failed to clear overrides');
      const refresh = await fetch('/api/admin/billing', { cache: 'no-store' });
      const refreshed = await refresh.json();
      if (refresh.ok && refreshed.data) {
        setData({ ...refreshed.data, actor: refreshed.actor || data.actor });
        const updated = refreshed.data.workspaces.find(
          (w: WorkspaceRow) => w.workspaceId === selected.workspaceId
        );
        if (updated) selectWorkspace(updated);
      }
      setFeedback({ kind: 'ok', text: `Cleared custom quota overrides for ${selected.name}.` });
    } catch (err: any) {
      setFeedback({ kind: 'err', text: err?.message || 'Could not clear overrides.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Total Workspaces</p>
          <p className="mt-1 font-heading text-2xl font-semibold text-[var(--text)]">
            {data.summary.totalWorkspaces}
          </p>
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Paid / Comped</p>
          <p className="mt-1 font-heading text-2xl font-semibold text-[var(--success)]">
            {data.summary.paidOrCompedCount}
          </p>
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Free Tier</p>
          <p className="mt-1 font-heading text-2xl font-semibold text-[var(--text)]">
            {data.summary.freeCount}
          </p>
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Near / Over Limit</p>
          <p className="mt-1 font-heading text-2xl font-semibold text-[var(--warning)]">
            {data.summary.nearOrOverLimitCount}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3.5">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-[var(--text-subtle)]" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search workspace, Clerk user ID, tenant, or billing email…"
            className={`w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] pl-8 pr-3 py-1.5 text-xs text-[var(--text)] ${FOCUS}`}
          />
        </div>
        <select
          aria-label="Filter by plan"
          value={planFilter}
          onChange={(e) => setPlanFilter(e.target.value)}
          className={`rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-1.5 text-xs text-[var(--text)] ${FOCUS}`}
        >
          <option value="">All plans</option>
          {data.catalog.plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by billing status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className={`rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-1.5 text-xs text-[var(--text)] ${FOCUS}`}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        {/* Workspaces Table */}
        <section className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[var(--border)] bg-[var(--surface-sunken)] text-[11px] uppercase tracking-wider text-[var(--text-subtle)]">
              <tr>
                <th className="px-4 py-3">Workspace / Owner</th>
                <th className="px-3 py-3">Plan</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Spaces · Agents</th>
                <th className="px-3 py-3">Adds / mo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filtered.map((w) => {
                const isSel = selected?.workspaceId === w.workspaceId;
                return (
                  <tr
                    key={w.workspaceId}
                    onClick={() => selectWorkspace(w)}
                    className={`cursor-pointer transition-colors ${
                      isSel ? 'bg-[var(--brand-subtle)]' : 'hover:bg-[var(--surface-sunken)]'
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-semibold text-[var(--text)]">{w.name}</div>
                      <div className="font-mono text-[11px] text-[var(--text-subtle)]">
                        {w.workspaceId} · {w.ownerIds[0] || 'no owner'}
                      </div>
                    </td>
                    <td className="px-3 py-3 font-semibold text-[var(--text)]">
                      {w.planName}
                      {Object.keys(w.limitOverrides || {}).length > 0 ? (
                        <span className="ml-1 text-[10px] font-mono text-[var(--brand)]">*</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${statusBadge(w.billingStatus)}`}
                      >
                        {w.billingStatus.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-3 py-3 font-mono text-[var(--text-muted)]">
                      {w.usage.spacesUsed}/{fmtLimit(w.effectiveLimits.spaces)} · {w.usage.agentsUsed}/
                      {fmtLimit(w.effectiveLimits.agents)}
                    </td>
                    <td className="px-3 py-3 font-mono text-[var(--text-muted)]">
                      {w.usage.addsUsed.toLocaleString()}/{fmtLimit(w.effectiveLimits.add)}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-xs text-[var(--text-muted)]">
                    No workspaces match your current filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        {/* Inspector / Editor */}
        <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          {selected ? (
            <form onSubmit={saveChanges} className="space-y-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-subtle)]">
                    MANAGE WORKSPACE
                  </p>
                  <h2 className="font-heading text-base font-semibold text-[var(--text)]">
                    {selected.name}
                  </h2>
                  <p className="font-mono text-[11px] text-[var(--text-muted)]">
                    {selected.workspaceId} · {selected.ownerIds.join(', ') || 'No active owner'}
                  </p>
                </div>
                <ShieldCheck className="h-4 w-4 text-[var(--brand)] shrink-0" aria-hidden="true" />
              </div>

              {feedback ? (
                <div
                  role="status"
                  className={`rounded-[var(--radius-sm)] border px-3 py-2 text-xs ${
                    feedback.kind === 'ok'
                      ? 'border-[var(--success)] bg-[var(--success-subtle)] text-[var(--success)]'
                      : 'border-[var(--danger)] bg-[var(--danger-subtle)] text-[var(--danger)]'
                  }`}
                >
                  {feedback.text}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs">
                  <span className="font-medium text-[var(--text-muted)]">Plan Tier</span>
                  <select
                    value={editPlan}
                    onChange={(e) => setEditPlan(e.target.value)}
                    className={`w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-2 text-xs text-[var(--text)] ${FOCUS}`}
                  >
                    {data.catalog.plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.priceUsdMonth === null ? 'Custom' : `$${p.priceUsdMonth}/mo`})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-medium text-[var(--text-muted)]">Billing Status</span>
                  <select
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value)}
                    className={`w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-2 text-xs text-[var(--text)] ${FOCUS}`}
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block space-y-1 text-xs">
                <span className="font-medium text-[var(--text-muted)]">Billing Email</span>
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  placeholder="owner@company.com"
                  className={`w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-2 text-xs text-[var(--text)] ${FOCUS}`}
                />
              </label>

              <label className="block space-y-1 text-xs">
                <span className="font-medium text-[var(--text-muted)]">External Customer ID (Stripe / Ref)</span>
                <input
                  type="text"
                  value={editExtId}
                  onChange={(e) => setEditExtId(e.target.value)}
                  placeholder="cus_..."
                  className={`w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-2 text-xs text-[var(--text)] ${FOCUS}`}
                />
              </label>

              <label className="block space-y-1 text-xs">
                <span className="font-medium text-[var(--text-muted)]">Admin Note</span>
                <input
                  type="text"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  placeholder="Founder comp, annual invoice, etc."
                  className={`w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-2 text-xs text-[var(--text)] ${FOCUS}`}
                />
              </label>

              <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
                    <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Custom Quota Overrides</span>
                  </span>
                  <button
                    type="button"
                    onClick={clearAllOverrides}
                    className="text-[11px] font-medium text-[var(--text-muted)] underline hover:text-[var(--text)]"
                  >
                    Reset to plan defaults
                  </button>
                </div>
                <p className="text-[11px] text-[var(--text-subtle)]">
                  Leave blank for plan default, or enter a number or &ldquo;unlimited&rdquo;.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-[11px]">
                    <span className="text-[var(--text-muted)]">Spaces</span>
                    <input
                      type="text"
                      value={ovSpaces}
                      onChange={(e) => setOvSpaces(e.target.value)}
                      placeholder="default"
                      className={`w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs text-[var(--text)] ${FOCUS}`}
                    />
                  </label>
                  <label className="space-y-1 text-[11px]">
                    <span className="text-[var(--text-muted)]">Agents</span>
                    <input
                      type="text"
                      value={ovAgents}
                      onChange={(e) => setOvAgents(e.target.value)}
                      placeholder="default"
                      className={`w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs text-[var(--text)] ${FOCUS}`}
                    />
                  </label>
                  <label className="space-y-1 text-[11px]">
                    <span className="text-[var(--text-muted)]">Adds / mo</span>
                    <input
                      type="text"
                      value={ovAdd}
                      onChange={(e) => setOvAdd(e.target.value)}
                      placeholder="default"
                      className={`w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs text-[var(--text)] ${FOCUS}`}
                    />
                  </label>
                  <label className="space-y-1 text-[11px]">
                    <span className="text-[var(--text-muted)]">Recalls / mo</span>
                    <input
                      type="text"
                      value={ovRecall}
                      onChange={(e) => setOvRecall(e.target.value)}
                      placeholder="default"
                      className={`w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs text-[var(--text)] ${FOCUS}`}
                    />
                  </label>
                </div>
              </div>

              <button
                type="submit"
                disabled={saving}
                className={`w-full min-h-[38px] rounded-[var(--radius-sm)] border border-[var(--brand)] bg-[var(--brand)] px-4 text-xs font-semibold text-[var(--surface)] hover:opacity-90 ${FOCUS}`}
              >
                {saving ? 'Saving changes…' : 'Save plan & limits'}
              </button>
            </form>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">
              Select a workspace from the table to manage its plan and limits.
            </p>
          )}
        </section>
      </div>

      {/* Admin Audit Log */}
      {data.auditHistory?.length ? (
        <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-2.5">
          <h3 className="font-heading text-sm font-semibold text-[var(--text)]">
            Admin Billing Audit Log
          </h3>
          <div className="divide-y divide-[var(--border)] text-xs">
            {data.auditHistory.slice(0, 12).map((ev: any, idx: number) => (
              <div key={`${ev.at}-${idx}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="text-[var(--text-muted)]">
                  <strong className="text-[var(--text)]">{ev.workspaceName || ev.workspaceId}</strong>{' '}
                  · {ev.action}
                  {ev.after?.plan ? ` → ${ev.after.plan} (${ev.after.billingStatus})` : ''}
                  {ev.toPlan ? ` → requested ${ev.toPlan}` : ''}
                  {ev.note ? ` · "${ev.note}"` : ''}
                </div>
                <div className="font-mono text-[11px] text-[var(--text-subtle)]">
                  {ev.actor} · {ev.at ? new Date(ev.at).toLocaleString() : ''}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
