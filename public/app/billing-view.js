// billing-view.js — Vanilla User View (#/account/billing) & Admin View (#/admin-billing)
// for Subscription, Billing & Plan Limits. All data escaped by lit-html.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { renderView, renderBare } from './shell.js';
import { getJSON, postJSON, state, toast } from './core.js';

const fmtLimit = (n) => (n === null || n === undefined ? 'Unlimited' : Number(n).toLocaleString());
const fmtPrice = (usd) => (usd === null || usd === undefined ? 'Custom' : usd === 0 ? 'Free' : `$${usd}/mo`);

function meterRow(label, used, limit, stateTag) {
  const pct = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return html`
    <div class="lm-panel" style="padding:12px">
      <div style="display:flex;justify-content:space-between;gap:8px;font-size:13px">
        <strong>${label}</strong>
        <span class="subtle">${Number(used || 0).toLocaleString()} / ${fmtLimit(limit)}</span>
      </div>
      ${limit !== null && limit !== undefined
        ? html`<div style="margin-top:8px;height:6px;border-radius:999px;background:var(--surface-sunken);overflow:hidden;border:1px solid var(--border)">
            <div style="height:100%;width:${pct}%;background:${stateTag === 'exceeded' ? 'var(--danger)' : stateTag === 'grace' || stateTag === 'near' ? 'var(--warning)' : 'var(--brand)'}"></div>
          </div>`
        : html`<p class="subtle" style="margin-top:6px;font-size:12px">Unlimited on this tier</p>`}
    </div>
  `;
}

const billingCache = new Map();

export function billingPanel(ctx) {
  const cacheKey = ctx.workspaceId || '_default';
  let entry = billingCache.get(cacheKey);
  if (!entry) {
    entry = { loaded: false, loading: false, data: null, err: '' };
    billingCache.set(cacheKey, entry);
  }
  let saving = false;

  const load = async () => {
    if (entry.loading) return;
    entry.loading = true;
    try {
      const q = ctx.workspaceId ? `?workspaceId=${encodeURIComponent(ctx.workspaceId)}` : '';
      const res = await getJSON('/api/billing' + q);
      if (res.__status !== 200 || !res.ok) throw new Error(res.message || res.error || 'Could not load billing');
      entry.data = res.data;
      entry.err = '';
    } catch (e) {
      entry.err = e.message || 'Could not load billing';
    } finally {
      entry.loaded = true;
      entry.loading = false;
      ctx.redraw();
    }
  };

  if (!entry.loaded) {
    load();
    return html`<section class="lm-panel lmx-account-form"><p class="subtle">Loading plan &amp; billing…</p></section>`;
  }
  if (entry.err) {
    return html`<section class="lm-panel lmx-account-form"><p role="alert" class="lm-alert lm-alert--danger">${entry.err}</p><button class="lm-btn" @click=${() => { entry.loaded = false; ctx.redraw(); }}>Retry</button></section>`;
  }
  const data = entry.data;
  if (!data?.workspace || !data?.plan) {
    return html`<section class="lm-panel lmx-account-form">
      <h2>Fleet Admin Space</h2>
      <p class="subtle">Manage customer workspace subscriptions, plans, and limits in the Admin Billing Console.</p>
      ${data?.isDeployAdmin ? html`<a class="lm-btn lm-btn--secondary" href="#/admin-billing">Open Admin Billing</a>` : nothing}
    </section>`;
  }

  const { workspace: ws, plan, billing, usage, catalog, isDeployAdmin } = data;
  const canManage = Boolean(ws.canManageBilling);

  const saveEmail = async (e) => {
    e.preventDefault();
    if (saving) return;
    saving = true;
    const email = e.currentTarget.elements.billingEmail.value.trim();
    try {
      const res = await postJSON('/api/billing', 'billing', {
        action: 'update_contact',
        workspaceId: ws.id,
        billingEmail: email,
        requestId: crypto.randomUUID(),
      });
      entry.data = res.data;
      toast('Billing email updated.');
      ctx.redraw();
    } catch (ex) {
      toast(ex.message || 'Failed to update billing email', true);
    } finally {
      saving = false;
    }
  };

  const requestPlan = async (planId) => {
    try {
      const res = await postJSON('/api/billing', 'billing', {
        action: 'request_plan',
        workspaceId: ws.id,
        requestedPlan: planId,
        requestId: crypto.randomUUID(),
      });
      entry.data = res.data;
      toast(`Upgrade request (${planId}) sent to admin.`);
      ctx.redraw();
    } catch (ex) {
      toast(ex.message || 'Request failed', true);
    }
  };

  return html`
    <section class="lm-panel lmx-account-form">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:12px">
        <div>
          <h2>${plan.name} Plan (${fmtPrice(plan.priceUsdMonth)})</h2>
          <p class="subtle">Status: <strong>${billing.status}</strong> · Retention: <strong>${plan.historyDays ? plan.historyDays + ' days' : 'Unlimited'}</strong>${plan.legacyAmnesty ? ' · Legacy 10-space allowance' : ''}</p>
        </div>
        ${isDeployAdmin ? html`<a class="lm-btn lm-btn--secondary" href="#/admin-billing">Open Admin Billing</a>` : nothing}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:12px">
        ${meterRow('Spaces', usage.spacesUsed, usage.spacesLimit, usage.spacesState)}
        ${meterRow('Agents', usage.agentsUsed, usage.agentsLimit, usage.agentsState)}
        ${meterRow(`Adds (${usage.month})`, usage.addsUsed, usage.addsLimit, usage.addsState)}
        ${meterRow(`Recalls (${usage.month})`, usage.recallsUsed, usage.recallsLimit, usage.recallsState)}
      </div>
    </section>

    <section class="lm-panel lmx-account-form">
      <h2>Available Plans</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
        ${(catalog?.plans || []).map((t) => html`
          <div class="lm-panel" style="padding:12px;border-color:${t.id === plan.id ? 'var(--brand)' : 'var(--border)'}">
            <div style="display:flex;justify-content:space-between;gap:6px">
              <strong>${t.name}</strong>
              <span>${fmtPrice(t.priceUsdMonth)}</span>
            </div>
            <p class="subtle" style="font-size:12px;margin:6px 0">
              ${fmtLimit(t.spaces)} spaces · ${fmtLimit(t.agents)} agents<br>
              ${fmtLimit(t.limits.add)} adds/mo · ${fmtLimit(t.limits.recall)} recalls/mo
            </p>
            ${t.id === plan.id
              ? html`<span class="lm-badge">Current</span>`
              : canManage
                ? html`<button type="button" class="lm-btn lm-btn--secondary" @click=${() => requestPlan(t.id)}>Request ${t.name}</button>`
                : nothing}
          </div>
        `)}
      </div>
    </section>

    ${canManage ? html`
      <section class="lm-panel lmx-account-form">
        <h2>Billing Contact</h2>
        <form @submit=${saveEmail} style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
          <label class="lm-field" style="flex:1;min-width:220px"><span class="lm-label">Billing email</span>
            <input class="lm-input" type="email" name="billingEmail" .value=${billing.email || ''} placeholder="billing@company.com">
          </label>
          <button class="lm-btn lm-btn--primary">Save billing email</button>
        </form>
      </section>
    ` : nothing}
  `;
}

export async function showAdminBilling() {
  let data = null;
  let err = '';
  let selectedId = null;
  let search = '';

  const load = async () => {
    try {
      const res = await getJSON('/api/admin-billing');
      if (res.__status !== 200 || !res.ok) throw new Error(res.message || res.error || 'Admin billing access denied');
      data = res.data;
      if (!selectedId && data.workspaces.length) selectedId = data.workspaces[0].workspaceId;
      err = '';
    } catch (e) {
      err = e.message || 'Failed to load admin billing';
    }
    draw();
  };

  const saveWorkspace = async (e) => {
    e.preventDefault();
    const f = e.currentTarget.elements;
    const parseOv = (v) => {
      const t = String(v || '').trim().toLowerCase();
      if (!t) return undefined;
      if (t === 'unlimited' || t === 'null') return null;
      const n = Number(t);
      return Number.isInteger(n) && n >= 0 ? n : undefined;
    };
    try {
      const res = await fetch('/api/admin-billing', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-logmem-intent': 'admin-billing',
        },
        body: JSON.stringify({
          workspaceId: selectedId,
          plan: f.plan.value,
          billingStatus: f.billingStatus.value,
          billingEmail: f.billingEmail.value.trim() || null,
          billingNote: f.billingNote.value.trim() || null,
          limitOverrides: {
            spaces: parseOv(f.ovSpaces.value),
            agents: parseOv(f.ovAgents.value),
            add: parseOv(f.ovAdd.value),
            recall: parseOv(f.ovRecall.value),
          },
          requestId: crypto.randomUUID(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message || json.error || 'Save failed');
      toast('Workspace plan & limits updated.');
      await load();
    } catch (ex) {
      toast(ex.message || 'Save failed', true);
    }
  };

  const draw = () => {
    if (err) {
      return renderView('account', ['Admin Billing'], html`
        <a class="lm-btn lm-btn--secondary" href="#/account/billing">Back to Billing</a>
        <section class="lm-panel lmx-account-form"><p role="alert" class="lm-alert lm-alert--danger">${err}</p></section>
      `);
    }
    if (!data) {
      return renderView('account', ['Admin Billing'], html`<p class="subtle">Loading admin billing…</p>`);
    }
    const q = search.trim().toLowerCase();
    const rows = data.workspaces.filter((w) =>
      !q || w.name.toLowerCase().includes(q) || w.workspaceId.toLowerCase().includes(q) || w.ownerIds.some((id) => id.toLowerCase().includes(q))
    );
    const sel = data.workspaces.find((w) => w.workspaceId === selectedId) || rows[0] || null;

    renderView('account', ['Admin Billing'], html`
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <a class="lm-btn lm-btn--secondary" href="#/account/billing">Back to My Billing</a>
        <input class="lm-input" style="max-width:280px" type="search" placeholder="Filter workspaces…" .value=${search} @input=${(e) => { search = e.currentTarget.value; draw(); }}>
      </div>
      <section class="lm-panel lmx-account-form">
        <h1 class="lm-title-1">Subscription &amp; Billing Admin</h1>
        <p class="subtle">${data.summary.totalWorkspaces} workspaces · ${data.summary.paidOrCompedCount} paid/comped · ${data.summary.freeCount} free</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:12px">
          <div>
            ${rows.map((w) => html`
              <button type="button" class="lm-panel" style="width:100%;text-align:left;padding:10px;margin-bottom:8px;border-color:${sel?.workspaceId === w.workspaceId ? 'var(--brand)' : 'var(--border)'}" @click=${() => { selectedId = w.workspaceId; draw(); }}>
                <div style="display:flex;justify-content:space-between"><strong>${w.name}</strong><span>${w.planName} · ${w.billingStatus}</span></div>
                <div class="subtle" style="font-size:12px">${w.workspaceId} · ${w.usage.spacesUsed}/${fmtLimit(w.effectiveLimits.spaces)} spaces · ${w.usage.addsUsed}/${fmtLimit(w.effectiveLimits.add)} adds</div>
              </button>
            `)}
          </div>
          ${sel ? html`
            <form class="lm-panel" style="padding:14px" @submit=${saveWorkspace}>
              <h2>Manage ${sel.name}</h2>
              <label class="lm-field"><span class="lm-label">Plan</span>
                <select class="lm-select" name="plan" .value=${sel.plan}>
                  ${data.catalog.plans.map((p) => html`<option value=${p.id} ?selected=${p.id === sel.plan}>${p.name}</option>`)}
                </select>
              </label>
              <label class="lm-field"><span class="lm-label">Status</span>
                <select class="lm-select" name="billingStatus" .value=${sel.billingStatus}>
                  ${['active', 'trialing', 'comped', 'past_due', 'canceled'].map((s) => html`<option value=${s} ?selected=${s === sel.billingStatus}>${s}</option>`)}
                </select>
              </label>
              <label class="lm-field"><span class="lm-label">Billing email</span><input class="lm-input" name="billingEmail" .value=${sel.billingEmail || ''}></label>
              <label class="lm-field"><span class="lm-label">Admin note</span><input class="lm-input" name="billingNote" .value=${sel.billingNote || ''}></label>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <label class="lm-field"><span class="lm-label">Spaces override</span><input class="lm-input" name="ovSpaces" .value=${sel.limitOverrides?.spaces !== undefined ? String(sel.limitOverrides.spaces ?? 'unlimited') : ''}></label>
                <label class="lm-field"><span class="lm-label">Agents override</span><input class="lm-input" name="ovAgents" .value=${sel.limitOverrides?.agents !== undefined ? String(sel.limitOverrides.agents ?? 'unlimited') : ''}></label>
                <label class="lm-field"><span class="lm-label">Adds override</span><input class="lm-input" name="ovAdd" .value=${sel.limitOverrides?.add !== undefined ? String(sel.limitOverrides.add ?? 'unlimited') : ''}></label>
                <label class="lm-field"><span class="lm-label">Recalls override</span><input class="lm-input" name="ovRecall" .value=${sel.limitOverrides?.recall !== undefined ? String(sel.limitOverrides.recall ?? 'unlimited') : ''}></label>
              </div>
              <button class="lm-btn lm-btn--primary" style="margin-top:10px">Save plan &amp; limits</button>
            </form>
          ` : nothing}
        </div>
      </section>
    `);
  };

  await load();
}
