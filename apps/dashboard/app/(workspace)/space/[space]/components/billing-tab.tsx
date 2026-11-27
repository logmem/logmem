'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowUpRight, Check, CreditCard, ShieldCheck, Sparkles } from 'lucide-react';
import type { BillingOverviewData } from '../../../../../lib/server/billing';

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

function fmtLimit(n: number | null | undefined, unit = ''): string {
  if (n === null || n === undefined) return 'Unlimited';
  return `${n.toLocaleString()}${unit ? ` ${unit}` : ''}`;
}

function fmtPrice(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return 'Custom';
  if (usd === 0) return 'Free';
  return `$${usd}/mo`;
}

function statusTone(status: string): string {
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

function meterBarTone(state: string): string {
  if (state === 'exceeded') return 'bg-[var(--danger)]';
  if (state === 'grace' || state === 'near') return 'bg-[var(--warning)]';
  return 'bg-[var(--brand)]';
}

function UsageMeter({
  label,
  used,
  limit,
  graceLimit,
  state,
}: {
  label: string;
  used: number;
  limit: number | null;
  graceLimit?: number | null;
  state: string;
}) {
  const pct =
    limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3.5 space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-[var(--text)]">{label}</span>
        <span className="font-mono text-[var(--text-muted)]">
          {used.toLocaleString()} / {limit === null ? 'Unlimited' : limit.toLocaleString()}
        </span>
      </div>
      {limit !== null ? (
        <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface)] border border-[var(--border)]">
          <div
            className={`h-full transition-all ${meterBarTone(state)}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : (
        <div className="text-[11px] text-[var(--text-subtle)]">No hard cap on this tier.</div>
      )}
      {state === 'grace' && graceLimit ? (
        <p className="text-[11px] font-medium text-[var(--warning)]">
          In 10% grace buffer (hard stop at {graceLimit.toLocaleString()}).
        </p>
      ) : state === 'exceeded' ? (
        <p className="text-[11px] font-medium text-[var(--danger)]">
          Monthly hard cap reached. Upgrade plan or request a limit increase.
        </p>
      ) : null}
    </div>
  );
}

export function BillingTab({
  space,
  initial,
}: {
  space: string;
  initial: BillingOverviewData;
}) {
  const [data, setData] = useState<BillingOverviewData>(initial);
  const [billingEmail, setBillingEmail] = useState(initial.billing?.email || '');
  const [savingEmail, setSavingEmail] = useState(false);
  const [requestingPlan, setRequestingPlan] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const ws = data.workspace;
  const plan = data.plan;
  const usage = data.usage;
  const billing = data.billing;
  const catalog = data.catalog?.plans || [];
  const canManage = Boolean(ws?.canManageBilling);

  async function saveContact(e: React.FormEvent) {
    e.preventDefault();
    if (!canManage || savingEmail) return;
    setSavingEmail(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/space/${space}/billing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'update_contact',
          billingEmail: billingEmail.trim(),
          requestId: crypto.randomUUID(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || json.error || 'Failed to update billing email');
      setData(json.data);
      setFeedback({ kind: 'ok', text: 'Billing contact email updated.' });
    } catch (err: any) {
      setFeedback({ kind: 'err', text: err?.message || 'Could not update billing email.' });
    } finally {
      setSavingEmail(false);
    }
  }

  async function requestUpgrade(planId: string) {
    if (!canManage || requestingPlan) return;
    setRequestingPlan(planId);
    setFeedback(null);
    try {
      const res = await fetch(`/api/space/${space}/billing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'request_plan',
          requestedPlan: planId,
          requestId: crypto.randomUUID(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || json.error || 'Failed to submit plan request');
      setData(json.data);
      setFeedback({
        kind: 'ok',
        text: `Plan change request (${planId.toUpperCase()}) recorded for admin review.`,
      });
    } catch (err: any) {
      setFeedback({ kind: 'err', text: err?.message || 'Could not submit plan request.' });
    } finally {
      setRequestingPlan(null);
    }
  }

  if (!ws || !plan || !usage || !billing) {
    return (
      <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="font-heading text-sm font-semibold text-[var(--text)]">
            Fleet Admin Space
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            This is a deploy-level Fleet Admin space. Manage customer workspace subscriptions, plans, and limits in the Admin Billing Console.
          </p>
        </div>
        {data.isDeployAdmin ? (
          <Link
            href="/admin/billing"
            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--brand)] bg-[var(--brand-subtle)] px-3.5 text-xs font-semibold text-[var(--brand)] hover:opacity-90 ${FOCUS}`}
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Admin Billing Console</span>
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </section>
    );
  }

  return (
    <div className="space-y-5">
      {/* Current Subscription Summary */}
      <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-subtle)]">
              SUBSCRIPTION &amp; PLAN · {ws.name}
            </p>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="font-heading text-lg font-semibold text-[var(--text)]">
                {plan.name} Plan
              </h2>
              <span className="rounded-full border border-[var(--border-strong)] bg-[var(--surface-sunken)] px-2.5 py-0.5 font-mono text-[11px] font-semibold text-[var(--text)]">
                {fmtPrice(plan.priceUsdMonth)}
              </span>
              <span
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${statusTone(billing.status)}`}
              >
                {billing.status.replace('_', ' ')}
              </span>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              Retention: <strong>{plan.historyDays ? `${plan.historyDays} days` : 'Unlimited'}</strong>
              {plan.legacyAmnesty ? ' · Legacy workspace space allowance active (10 spaces).' : ''}
              {billing.note ? ` · ${billing.note}` : ''}
            </p>
          </div>

          {data.isDeployAdmin ? (
            <Link
              href="/admin/billing"
              className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--brand)] bg-[var(--brand-subtle)] px-3.5 text-xs font-semibold text-[var(--brand)] hover:opacity-90 ${FOCUS}`}
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Admin Billing Console</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </div>

        {/* Live Usage Meters */}
        <div className="grid gap-3 sm:grid-cols-2">
          <UsageMeter
            label="Spaces"
            used={usage.spacesUsed}
            limit={usage.spacesLimit}
            state={usage.spacesState}
          />
          <UsageMeter
            label="Connected Agents"
            used={usage.agentsUsed}
            limit={usage.agentsLimit}
            state={usage.agentsState}
          />
          <UsageMeter
            label={`Monthly Adds (${usage.month})`}
            used={usage.addsUsed}
            limit={usage.addsLimit}
            graceLimit={usage.addsGraceLimit}
            state={usage.addsState}
          />
          <UsageMeter
            label={`Monthly Recalls (${usage.month})`}
            used={usage.recallsUsed}
            limit={usage.recallsLimit}
            graceLimit={usage.recallsGraceLimit}
            state={usage.recallsState}
          />
        </div>
      </section>

      {feedback ? (
        <div
          role="status"
          className={`rounded-[var(--radius-md)] border px-4 py-3 text-xs font-medium ${
            feedback.kind === 'ok'
              ? 'border-[var(--success)] bg-[var(--success-subtle)] text-[var(--success)]'
              : 'border-[var(--danger)] bg-[var(--danger-subtle)] text-[var(--danger)]'
          }`}
        >
          {feedback.text}
        </div>
      ) : null}

      {/* Plan Comparison Grid */}
      <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
        <div>
          <h3 className="font-heading text-base font-semibold text-[var(--text)]">
            Available Plans &amp; Limits
          </h3>
          <p className="text-xs text-[var(--text-muted)]">
            All plans include unlimited reads. Refusing plans include a 10% grace buffer before writes pause.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {catalog.map((tier) => {
            const isCurrent = tier.id === plan.id;
            return (
              <div
                key={tier.id}
                className={`flex flex-col justify-between rounded-[var(--radius-md)] border p-4 space-y-3 ${
                  isCurrent
                    ? 'border-[var(--brand)] bg-[var(--brand-subtle)]'
                    : 'border-[var(--border)] bg-[var(--surface-sunken)]'
                }`}
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-heading text-sm font-semibold text-[var(--text)]">
                      {tier.name}
                    </span>
                    <span className="font-mono text-xs font-semibold text-[var(--text)]">
                      {fmtPrice(tier.priceUsdMonth)}
                    </span>
                  </div>
                  <ul className="space-y-1 text-xs text-[var(--text-muted)]">
                    <li>Spaces: <strong>{fmtLimit(tier.spaces)}</strong></li>
                    <li>Agents: <strong>{fmtLimit(tier.agents)}</strong></li>
                    <li>Adds / mo: <strong>{fmtLimit(tier.limits.add)}</strong></li>
                    <li>Recalls / mo: <strong>{fmtLimit(tier.limits.recall)}</strong></li>
                    <li>History: <strong>{tier.historyDays ? `${tier.historyDays} days` : 'Unlimited'}</strong></li>
                  </ul>
                </div>

                {isCurrent ? (
                  <span className="inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--brand)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--brand)]">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Current plan</span>
                  </span>
                ) : canManage ? (
                  <button
                    type="button"
                    disabled={requestingPlan === tier.id}
                    onClick={() => requestUpgrade(tier.id)}
                    className={`inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--text)] hover:border-[var(--brand)] ${FOCUS}`}
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{requestingPlan === tier.id ? 'Requesting…' : `Request ${tier.name}`}</span>
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* Billing Contact & Audit */}
      {canManage ? (
        <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
            <h3 className="font-heading text-sm font-semibold text-[var(--text)]">
              Billing Contact
            </h3>
          </div>
          <form onSubmit={saveContact} className="flex flex-wrap items-end gap-3">
            <label className="flex-1 min-w-[220px] space-y-1 text-xs">
              <span className="font-medium text-[var(--text-muted)]">Invoice &amp; limit alerts email</span>
              <input
                type="email"
                value={billingEmail}
                onChange={(e) => setBillingEmail(e.target.value)}
                placeholder="billing@company.com"
                className={`w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-xs text-[var(--text)] ${FOCUS}`}
              />
            </label>
            <button
              type="submit"
              disabled={savingEmail}
              className={`min-h-[36px] rounded-[var(--radius-sm)] border border-[var(--brand)] bg-[var(--brand)] px-4 text-xs font-semibold text-[var(--surface)] hover:opacity-90 ${FOCUS}`}
            >
              {savingEmail ? 'Saving…' : 'Save billing email'}
            </button>
          </form>

          {data.auditHistory?.length ? (
            <div className="pt-2 border-t border-[var(--border)] space-y-1.5">
              <p className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-subtle)]">
                Recent Billing Events
              </p>
              <ul className="space-y-1 text-xs text-[var(--text-muted)]">
                {data.auditHistory.slice(0, 5).map((ev: any, idx: number) => (
                  <li key={`${ev.at}-${idx}`} className="flex items-center justify-between gap-2">
                    <span>
                      <strong className="text-[var(--text)]">{ev.action}</strong>
                      {ev.toPlan ? ` → ${ev.toPlan}` : ''}
                      {ev.after?.plan ? ` → ${ev.after.plan} (${ev.after.billingStatus})` : ''}
                      {ev.email ? ` (${ev.email})` : ''}
                    </span>
                    <span className="font-mono text-[11px] text-[var(--text-subtle)]">
                      {ev.at ? new Date(ev.at).toLocaleDateString() : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
