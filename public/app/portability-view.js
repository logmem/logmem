// portability-view.js — Mirrored Export & Handoff, Import 3-step flight check, RBAC cheat sheet, and post-import banner.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { postJSON, toast, ago } from './core.js';
import {
  BUNDLE_MODES,
  RBAC_CHEATSHEET,
  SECURITY_GUARANTEES,
  formatBytes,
  shortHash,
  buildBundleFilename,
  importBannerDismissKey,
  shouldShowImportBanner,
} from './portability-model.js';

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// Persistent tab state per mounted screen
const expState = {
  spaceKey: '',
  mode: 'full',
  clientSafe: false,
  preflight: null,
  loadingPreflight: false,
  exporting: false,
  lastExport: null,
  history: [],
  claims: [],
  claimEmail: '',
  claimTtl: 7,
  claimClientSafe: true,
  creatingClaim: false,
  freshClaim: null,
  claimError: '',
  error: '',
};

const impState = {
  fileName: '',
  bundlePayload: null,
  bundleEncoding: null,
  planning: false,
  applying: false,
  plan: null,
  destination: 'new', // 'new' | 'current'
  newSpaceName: '',
  conflictMode: 'skip', // 'skip' | 'overwrite'
  confirmText: '',
  error: '',
  done: null,
};

function baseBody(ctx) {
  return ctx.customer
    ? { workspaceId: ctx.workspaceId, spaceId: ctx.spaceId }
    : { space: ctx.space };
}

export async function refreshExportPreflight(ctx, redraw) {
  const key = `${ctx.customer ? ctx.workspaceId + ':' + ctx.spaceId : ctx.space}:${expState.mode}:${expState.clientSafe ? 'cs' : 'all'}`;
  expState.spaceKey = key;
  expState.loadingPreflight = true;
  expState.error = '';
  redraw();
  try {
    const reqs = [
      postJSON('/api/space-io', 'space-io', {
        ...baseBody(ctx),
        action: 'export-space',
        version: 2,
        mode: expState.mode,
        clientSafe: expState.clientSafe,
        dryRun: true,
      }),
      postJSON('/api/space-io', 'space-io', {
        ...baseBody(ctx),
        action: 'audit-history',
      }).catch(() => ({ history: [] })),
    ];
    if (ctx.customer && ctx.isOwner) {
      reqs.push(
        fetch(`/api/space-claims?workspaceId=${encodeURIComponent(ctx.workspaceId)}&spaceId=${encodeURIComponent(ctx.spaceId)}`, { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.json() : { claims: [] }))
          .catch(() => ({ claims: [] })),
      );
    }
    const [pre, hist, clm] = await Promise.all(reqs);
    expState.preflight = pre;
    expState.history = Array.isArray(hist?.history) ? hist.history : [];
    if (clm && Array.isArray(clm.claims)) expState.claims = clm.claims;
  } catch (e) {
    if (!e.stale) expState.error = e.message || 'Could not compute export preflight.';
  } finally {
    expState.loadingPreflight = false;
    redraw();
  }
}

async function runExport(ctx, redraw) {
  if (expState.exporting) return;
  expState.exporting = true;
  expState.error = '';
  redraw();
  try {
    const r = await postJSON('/api/space-io', 'space-io', {
      ...baseBody(ctx),
      action: 'export-space',
      version: 2,
      mode: expState.mode,
      clientSafe: expState.clientSafe,
      gzip: true,
      dryRun: false,
      approved: true,
    });
    const filename = buildBundleFilename(ctx.spaceName || ctx.space, expState.mode, Boolean(r.bufferBase64));
    if (r.bufferBase64) {
      triggerDownload(base64ToBlob(r.bufferBase64, 'application/gzip'), filename);
    } else if (r.json) {
      triggerDownload(new Blob([r.json], { type: 'application/json' }), filename);
    }
    expState.lastExport = {
      filename,
      checksum: r.checksum,
      sizeBytes: r.sizeBytes,
      mode: r.mode || expState.mode,
      manifest: r.manifest,
      redaction: r.redaction,
    };
    toast(`Exported ${filename}`);
    await refreshExportPreflight(ctx, redraw);
  } catch (e) {
    if (!e.stale) {
      expState.error = e.message || 'Export failed.';
      toast(expState.error, true);
    }
  } finally {
    expState.exporting = false;
    redraw();
  }
}

async function runCreateClaim(ev, ctx, redraw) {
  ev.preventDefault();
  if (expState.creatingClaim) return;
  expState.creatingClaim = true;
  expState.claimError = '';
  expState.freshClaim = null;
  redraw();
  try {
    const r = await postJSON('/api/space-claims', 'space-claims', {
      action: 'create',
      workspaceId: ctx.workspaceId,
      spaceId: ctx.spaceId,
      mode: expState.mode,
      clientSafe: expState.claimClientSafe,
      recipientEmail: expState.claimEmail.trim(),
      ttlDays: expState.claimTtl,
    });
    expState.freshClaim = { url: r.claimUrl, checksum: r.checksum, expiresAt: r.expiresAt };
    expState.claimEmail = '';
    toast('Claim link created.');
    await refreshExportPreflight(ctx, redraw);
  } catch (e) {
    if (!e.stale) {
      expState.claimError = e.message || 'Could not create claim link.';
      toast(expState.claimError, true);
    }
  } finally {
    expState.creatingClaim = false;
    redraw();
  }
}

async function runRevokeClaim(claimId, ctx, redraw) {
  try {
    await postJSON('/api/space-claims', 'space-claims', {
      action: 'revoke',
      workspaceId: ctx.workspaceId,
      spaceId: ctx.spaceId,
      claimId,
    });
    toast('Claim link revoked.');
    await refreshExportPreflight(ctx, redraw);
  } catch (e) {
    if (!e.stale) toast(e.message || 'Could not revoke claim link.', true);
  }
}

export function exportTabPanel(ctx, redraw) {
  const expectedKey = `${ctx.customer ? ctx.workspaceId + ':' + ctx.spaceId : ctx.space}:${expState.mode}:${expState.clientSafe ? 'cs' : 'all'}`;
  if (expState.spaceKey !== expectedKey && !expState.loadingPreflight) {
    queueMicrotask(() => refreshExportPreflight(ctx, redraw));
  }
  const m = expState.preflight?.manifest;
  return html`<div class="lmx-port-stack">
    <section class="lm-panel lmx-port-card">
      <div class="lmx-port-head">
        <div>
          <span class="lm-eyebrow">STEP 1 · PACKAGE MODE</span>
          <h2>Choose what to include</h2>
        </div>
        <span class="lm-badge lm-badge--brand mono">${ctx.spaceName || ctx.space}</span>
      </div>
      <div class="lmx-mode-grid" role="radiogroup" aria-label="Export bundle mode">
        ${BUNDLE_MODES.map((mode) => html`
          <button type="button" role="radio" aria-checked=${String(expState.mode === mode.id)}
            class=${'lmx-mode-card' + (expState.mode === mode.id ? ' is-selected' : '')}
            @click=${() => { if (expState.mode !== mode.id) { expState.mode = mode.id; expState.lastExport = null; refreshExportPreflight(ctx, redraw); } }}>
            <div class="lmx-mode-card-top">
              <strong>${mode.title}</strong>
              <span class="lm-badge">${mode.badge}</span>
            </div>
            <p>${mode.summary}</p>
            <span class="lmx-meta">Best for: ${mode.bestFor}</span>
          </button>`)}
      </div>
    </section>

    <section class="lm-panel lmx-port-card">
      <div class="lmx-port-head">
        <div>
          <span class="lm-eyebrow">STEP 2 · PREFLIGHT MANIFEST</span>
          <h2>Ready to pack</h2>
        </div>
        <button type="button" class="lm-btn lm-btn--ghost" ?disabled=${expState.loadingPreflight}
          @click=${() => refreshExportPreflight(ctx, redraw)}>Refresh counts</button>
      </div>
      ${expState.loadingPreflight ? html`<p class="lmx-meta">Scanning space keys…</p>` : m ? html`
        <div class="lmx-stat-strip" aria-label="Preflight counts">
          <div class="lmx-stat-pill"><b>${m.agents}</b><span>Agents</span></div>
          <div class="lmx-stat-pill"><b>${m.plans}</b><span>Plans</span></div>
          <div class="lmx-stat-pill"><b>${m.jobs}</b><span>Jobs</span></div>
          <div class="lmx-stat-pill"><b>${m.decisions}</b><span>Decisions</span></div>
          <div class="lmx-stat-pill"><b>${m.traces}</b><span>Log streams</span></div>
          <div class="lmx-stat-pill"><b>${formatBytes(expState.preflight?.estimatedBytes)}</b><span>Est. raw</span></div>
        </div>` : nothing}
      <label class="lmx-radio-pill" style="width:100%">
        <input type="checkbox" .checked=${expState.clientSafe}
          @change=${(e) => { expState.clientSafe = e.currentTarget.checked; refreshExportPreflight(ctx, redraw); }}>
        <span><strong>Client-safe filter:</strong> exclude internal channels (<code>internal-*</code>, <code>ops-*</code>, <code>agency-*</code>) and internal-tagged records</span>
      </label>
      <ul class="lmx-guarantees" aria-label="Security guarantees">
        ${SECURITY_GUARANTEES.map((g) => html`<li><span class="lmx-check" aria-hidden="true">✓</span> ${g}</li>`)}
      </ul>
      ${expState.error ? html`<div class="lm-alert lm-alert--danger" role="alert"><div>${expState.error}</div></div>` : nothing}
      <div class="lmx-account-actions">
        <button type="button" class="lm-btn lm-btn--primary" ?disabled=${expState.exporting || expState.loadingPreflight}
          @click=${() => runExport(ctx, redraw)}>
          ${expState.exporting ? 'Packing redacted bundle…' : `Export ${expState.mode === 'blueprint' ? 'Blueprint' : 'Full + Traces'} (.logmem.json.gz)`}
        </button>
      </div>
      ${expState.lastExport ? html`
        <div class="lmx-receipt-box" role="status">
          <strong>Bundle downloaded: <code>${expState.lastExport.filename}</code></strong>
          <div class="lmx-receipt-meta">
            <span>SHA-256: <code class="mono">${shortHash(expState.lastExport.checksum, 16)}…</code></span>
            <span>Size: ${formatBytes(expState.lastExport.sizeBytes)}</span>
            ${expState.lastExport.redaction?.secretsRedacted ? html`<span>Redacted: ${expState.lastExport.redaction.secretsRedacted} secrets</span>` : nothing}
            <button type="button" class="lm-btn lm-btn--ghost" @click=${async () => {
              try { await navigator.clipboard.writeText(expState.lastExport.checksum); toast('SHA-256 copied.'); }
              catch { toast('Copy failed.', true); }
            }}>Copy SHA-256</button>
          </div>
        </div>` : nothing}
    </section>

    ${ctx.customer && ctx.isOwner ? html`
      <section class="lm-panel lmx-port-card">
        <div class="lmx-port-head">
          <div>
            <span class="lm-eyebrow">CLIENT DELIVERY · OWNER ONLY</span>
            <h2>1-Click Client Claim Link</h2>
          </div>
        </div>
        <p class="lmx-meta">Generate a single-use signed link so a client can import this ${expState.mode === 'blueprint' ? 'Blueprint' : 'Full + Traces'} space directly into their own LogMem workspace.</p>
        <form class="lmx-account-form" @submit=${(ev) => runCreateClaim(ev, ctx, redraw)}>
          <div class="lmx-dest-row">
            <label class="lm-field" style="flex:1 1 220px"><span class="lm-label">Lock to recipient email (optional)</span><input class="lm-input" type="email" placeholder="client@company.com" .value=${expState.claimEmail} @input=${(e) => { expState.claimEmail = e.currentTarget.value; }}></label>
            <label class="lm-field" style="flex:0 0 130px"><span class="lm-label">Expires in</span><select class="lm-select" .value=${String(expState.claimTtl)} @change=${(e) => { expState.claimTtl = Number(e.currentTarget.value); }}><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
          </div>
          <label class="lmx-radio-pill"><input type="checkbox" .checked=${expState.claimClientSafe} @change=${(e) => { expState.claimClientSafe = e.currentTarget.checked; }}><span>Apply client-safe filter (strip internal channels &amp; notes)</span></label>
          ${expState.claimError ? html`<div class="lm-alert lm-alert--danger" role="alert"><div>${expState.claimError}</div></div>` : nothing}
          <button class="lm-btn lm-btn--primary" ?disabled=${expState.creatingClaim}>${expState.creatingClaim ? 'Creating…' : 'Create claim link'}</button>
        </form>
        ${expState.freshClaim ? html`
          <div class="lmx-receipt-box" role="status">
            <strong>Single-use claim link ready (SHA-256 <code>${shortHash(expState.freshClaim.checksum, 12)}</code>). Shown once.</strong>
            <div class="lmx-receipt-meta">
              <input class="lm-input mono" readonly .value=${expState.freshClaim.url} aria-label="Client claim link" style="flex:1;min-width:200px">
              <button type="button" class="lm-btn lm-btn--ghost" @click=${async () => {
                try { await navigator.clipboard.writeText(expState.freshClaim.url); toast('Claim link copied.'); }
                catch { toast('Copy failed.', true); }
              }}>Copy link</button>
            </div>
          </div>` : nothing}
        ${expState.claims.length ? html`
          <div class="lmx-table-wrap"><table class="lm-table">
            <thead><tr><th>Status</th><th>Mode</th><th>Lock</th><th>Checksum</th><th>Action</th></tr></thead>
            <tbody>${expState.claims.map((c) => html`<tr>
              <td class="mono">${c.status}</td>
              <td>${c.mode}${c.clientSafe ? ' · client-safe' : ''}</td>
              <td>${c.recipientEmailMask || 'Any email'}</td>
              <td class="mono">${shortHash(c.checksum, 10)}</td>
              <td>${c.status === 'pending' ? html`<button type="button" class="lm-btn lm-btn--ghost" @click=${() => runRevokeClaim(c.id, ctx, redraw)}>Revoke</button>` : '—'}</td>
            </tr>`)}</tbody>
          </table></div>` : nothing}
      </section>` : nothing}

    <section class="lm-panel lmx-port-card">
      <div class="lmx-port-head">
        <div>
          <span class="lm-eyebrow">AUDIT TRAIL</span>
          <h2>Export &amp; import history</h2>
        </div>
      </div>
      ${expState.history.length ? html`
        <div class="lmx-table-wrap"><table class="lm-table">
          <thead><tr><th>Event</th><th>Mode</th><th>Checksum</th><th>Details</th><th>When</th></tr></thead>
          <tbody>${expState.history.map((h) => html`<tr>
            <td><span class="lm-badge">${h.kind === 'space-exported' ? 'Exported' : 'Imported'}</span></td>
            <td>${h.mode || 'full'}</td>
            <td class="mono">${shortHash(h.checksum, 12)}</td>
            <td>${h.kind === 'space-exported' ? formatBytes(h.sizeBytes) : `${h.created || 0} keys from ${h.sourceSpace || 'bundle'}`}</td>
            <td>${ago(h.at)}</td>
          </tr>`)}</tbody>
        </table></div>` : html`<p class="lmx-meta">No exports or imports recorded for this space yet.</p>`}
    </section>
  </div>`;
}

async function handleBundleFile(file, ctx, redraw) {
  if (!file) return;
  impState.fileName = file.name;
  impState.error = '';
  impState.done = null;
  impState.plan = null;
  impState.planning = true;
  redraw();
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const isGz = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (isGz) {
      impState.bundlePayload = arrayBufferToBase64(buf);
      impState.bundleEncoding = 'gzip-base64';
    } else {
      impState.bundlePayload = new TextDecoder().decode(bytes);
      impState.bundleEncoding = 'json';
    }
    await runImportPlan(ctx, redraw);
  } catch (e) {
    impState.error = e.message || 'Could not read bundle file.';
    impState.planning = false;
    redraw();
  }
}

async function runImportPlan(ctx, redraw) {
  if (!impState.bundlePayload) return;
  impState.planning = true;
  impState.error = '';
  redraw();
  try {
    const targetBody = ctx.customer
      ? (impState.destination === 'new'
          ? { workspaceId: ctx.workspaceId }
          : { workspaceId: ctx.workspaceId, spaceId: ctx.spaceId })
      : { space: ctx.space };
    const plan = await postJSON('/api/space-io', 'space-io', {
      ...targetBody,
      action: 'import-plan',
      bundle: impState.bundlePayload,
      bundleEncoding: impState.bundleEncoding,
      overwrite: impState.conflictMode === 'overwrite',
      skipConflicts: impState.conflictMode === 'skip',
    });
    impState.plan = plan;
    if (!impState.newSpaceName) {
      impState.newSpaceName = String(plan.sourceSpaceName || plan.sourceSpace || 'Imported space').slice(0, 80);
    }
  } catch (e) {
    if (!e.stale) impState.error = e.message || 'Bundle verification failed.';
  } finally {
    impState.planning = false;
    redraw();
  }
}

async function runImportApply(ctx, redraw) {
  if (!impState.plan || impState.applying) return;
  const needsConfirm = impState.destination === 'current' && impState.conflictMode === 'overwrite' && (impState.plan.wouldOverwrite || 0) > 0;
  if (needsConfirm && impState.confirmText.trim() !== shortHash(impState.plan.checksum, 12)) {
    impState.error = `Type ${shortHash(impState.plan.checksum, 12)} to confirm overwriting existing keys.`;
    return redraw();
  }
  impState.applying = true;
  impState.error = '';
  redraw();
  try {
    let result;
    if (ctx.customer && impState.destination === 'new') {
      result = await postJSON('/api/space-io', 'space-io', {
        workspaceId: ctx.workspaceId,
        action: 'import-create-space',
        name: impState.newSpaceName || impState.plan.sourceSpaceName || 'Imported space',
        bundle: impState.bundlePayload,
        bundleEncoding: impState.bundleEncoding,
        checksum: impState.plan.checksum,
        approved: true,
        recordReceipt: true,
        requestId: crypto.randomUUID(),
      });
    } else {
      result = await postJSON('/api/space-io', 'space-io', {
        ...baseBody(ctx),
        action: 'import-apply',
        bundle: impState.bundlePayload,
        bundleEncoding: impState.bundleEncoding,
        approved: true,
        overwrite: impState.conflictMode === 'overwrite',
        skipConflicts: impState.conflictMode === 'skip',
        recordReceipt: true,
      });
    }
    impState.done = result;
    toast('Space imported cleanly.');
    if (ctx.onImportDone) await ctx.onImportDone(result);
  } catch (e) {
    if (!e.stale) {
      impState.error = e.message || 'Import failed.';
      toast(impState.error, true);
    }
  } finally {
    impState.applying = false;
    redraw();
  }
}

export function resetImportState() {
  impState.fileName = '';
  impState.bundlePayload = null;
  impState.bundleEncoding = null;
  impState.plan = null;
  impState.error = '';
  impState.done = null;
  impState.confirmText = '';
}

export function importTabPanel(ctx, redraw) {
  const p = impState.plan;
  const m = p?.manifest;
  const noQuota = ctx.customer && impState.destination === 'new' && p?.quota && !p.quota.hasQuota;
  const needsConfirm = impState.destination === 'current' && impState.conflictMode === 'overwrite' && (p?.wouldOverwrite || 0) > 0;

  return html`<div class="lmx-port-stack">
    <section class="lm-panel lmx-port-card">
      <div class="lmx-port-head">
        <div>
          <span class="lm-eyebrow">STEP 1 · UPLOAD &amp; VERIFY</span>
          <h2>Select a LogMem space bundle</h2>
        </div>
        ${p ? html`<span class="lm-badge lm-badge--success">✓ Checksum verified</span>` : nothing}
      </div>
      <label class="lmx-dropzone" @dragover=${(e) => e.preventDefault()} @drop=${(e) => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f) handleBundleFile(f, ctx, redraw);
      }}>
        <input type="file" accept=".gz,.json,.logmem.json,.logmem.json.gz" @change=${(e) => handleBundleFile(e.currentTarget.files?.[0], ctx, redraw)}>
        <strong>${impState.fileName || 'Drop a .logmem.json.gz or .json bundle here, or click to choose'}</strong>
        <span class="lmx-meta">Supports v1 and v2 bundles up to 15 MB. Verified via SHA-256 before any write.</span>
      </label>
      ${impState.planning ? html`<p class="lmx-meta">Verifying SHA-256 checksum and inspecting bundle…</p>` : nothing}
      ${impState.error ? html`<div class="lm-alert lm-alert--danger" role="alert"><div>${impState.error}</div></div>` : nothing}
    </section>

    ${p ? html`
      <section class="lm-panel lmx-port-card">
        <div class="lmx-port-head">
          <div>
            <span class="lm-eyebrow">STEP 2 · DRY-RUN PREVIEW</span>
            <h2>Inspect before writing</h2>
          </div>
          <span class="lm-badge mono">${p.mode || 'full'} · ${shortHash(p.checksum, 12)}</span>
        </div>

        <p class="lmx-meta">Source: <strong>${p.sourceSpaceName || p.sourceSpace}</strong> · Format: <code>${p.format}</code></p>

        ${m ? html`
          <div class="lmx-stat-strip">
            <div class="lmx-stat-pill"><b>${m.agents}</b><span>Agents</span></div>
            <div class="lmx-stat-pill"><b>${m.plans}</b><span>Plans</span></div>
            <div class="lmx-stat-pill"><b>${m.jobs}</b><span>Jobs</span></div>
            <div class="lmx-stat-pill"><b>${m.decisions}</b><span>Decisions</span></div>
            <div class="lmx-stat-pill"><b>${m.traces}</b><span>Traces</span></div>
          </div>` : nothing}

        ${(m?.sampleAgents?.length || m?.samplePlans?.length) ? html`
          <details class="lmx-peek">
            <summary>Peek inside bundle (${m.sampleAgents?.length || 0} sample agents, ${m.samplePlans?.length || 0} sample plans)</summary>
            <div class="lmx-peek-grid">
              ${m.sampleAgents?.length ? html`<div><h4>Agents</h4><ul>${m.sampleAgents.map((a) => html`<li><code>${a.id}</code> ${a.role ? html`<span class="lmx-meta">— ${a.role}</span>` : nothing}</li>`)}</ul></div>` : nothing}
              ${m.samplePlans?.length ? html`<div><h4>Plans</h4><ul>${m.samplePlans.map((pl) => html`<li><strong>${pl.title}</strong></li>`)}</ul></div>` : nothing}
            </div>
          </details>` : nothing}

        ${ctx.customer ? html`
          <div class="lmx-dest-row">
            <label class="lmx-radio-pill">
              <input type="radio" name="imp-dest" value="new" ?checked=${impState.destination === 'new'}
                @change=${() => { impState.destination = 'new'; runImportPlan(ctx, redraw); }}>
              <span>Create a new space (recommended)</span>
            </label>
            ${ctx.spaceId ? html`
              <label class="lmx-radio-pill">
                <input type="radio" name="imp-dest" value="current" ?checked=${impState.destination === 'current'}
                  @change=${() => { impState.destination = 'current'; runImportPlan(ctx, redraw); }}>
                <span>Merge into ${ctx.spaceName || 'current space'}</span>
              </label>` : nothing}
          </div>
          ${impState.destination === 'new' ? html`
            <label class="lm-field">
              <span class="lm-label">New space name</span>
              <input class="lm-input" maxlength="80" .value=${impState.newSpaceName}
                @input=${(e) => { impState.newSpaceName = e.currentTarget.value; }}>
            </label>
            ${p.quota ? html`<p class="lmx-meta">Workspace space quota: ${p.quota.activeSpaces} / ${p.quota.maxSpaces} active spaces.</p>` : nothing}` : nothing}` : nothing}

        ${(impState.destination === 'current' || !ctx.customer) ? html`
          <div class="lmx-diff-strip">
            <span>Would create: <b>${p.wouldCreate}</b></span>
            <span>Conflicts: <b>${p.conflicts?.length || 0}</b></span>
            <span>Would overwrite: <b>${p.wouldOverwrite || 0}</b></span>
          </div>
          <div class="lmx-dest-row">
            <label class="lmx-radio-pill">
              <input type="radio" name="imp-conflict" value="skip" ?checked=${impState.conflictMode === 'skip'}
                @change=${() => { impState.conflictMode = 'skip'; runImportPlan(ctx, redraw); }}>
              <span>Skip existing keys (safe)</span>
            </label>
            <label class="lmx-radio-pill">
              <input type="radio" name="imp-conflict" value="overwrite" ?checked=${impState.conflictMode === 'overwrite'}
                @change=${() => { impState.conflictMode = 'overwrite'; runImportPlan(ctx, redraw); }}>
              <span>Overwrite existing keys</span>
            </label>
          </div>
          ${needsConfirm ? html`
            <label class="lm-field">
              <span class="lm-label">Type <code class="mono">${shortHash(p.checksum, 12)}</code> to confirm overwrite</span>
              <input class="lm-input mono" .value=${impState.confirmText} @input=${(e) => { impState.confirmText = e.currentTarget.value; }}>
            </label>` : nothing}` : nothing}

        ${noQuota ? html`<div class="lm-alert lm-alert--warning" role="alert"><div>Workspace is at its active space limit (${p.quota.activeSpaces}/${p.quota.maxSpaces}). Archive a space or merge into an existing space.</div></div>` : nothing}

        <div class="lmx-account-actions">
          <button type="button" class="lm-btn lm-btn--primary"
            ?disabled=${impState.applying || impState.planning || noQuota}
            @click=${() => runImportApply(ctx, redraw)}>
            ${impState.applying ? 'Importing space…' : (ctx.customer && impState.destination === 'new' ? `Create "${impState.newSpaceName || 'Imported space'}" & import` : 'Apply import')}
          </button>
          <button type="button" class="lm-btn lm-btn--ghost" ?disabled=${impState.applying}
            @click=${() => { resetImportState(); redraw(); }}>Choose different file</button>
        </div>
      </section>` : nothing}

    ${impState.done ? html`
      <div class="lm-alert lm-alert--success" role="status">
        <div>
          <strong>Import complete.</strong> Created ${impState.done.written?.created || 0} keys${impState.done.written?.overwritten ? `, updated ${impState.done.written.overwritten}` : ''}.
          Agent keys were not transferred — connect fresh keys in <a href="#/access">Agent access</a>.
        </div>
      </div>` : nothing}
  </div>`;
}

export function rbacCheatsheetDetails() {
  const cell = (v) => (v === true ? '✓' : v === false ? '—' : v);
  return html`<details class="lmx-peek">
    <summary>Role permissions matrix (built-in RBAC)</summary>
    <div class="lmx-table-wrap"><table class="lm-table">
      <thead><tr><th>Capability</th><th>Owner</th><th>Admin</th><th>Client Approver</th><th>Team Editor</th><th>Client Viewer</th></tr></thead>
      <tbody>${RBAC_CHEATSHEET.map((row) => html`<tr>
        <th scope="row">${row.capability}</th>
        <td>${cell(row.owner)}</td><td>${cell(row.admin)}</td><td>${cell(row.approver)}</td><td>${cell(row.editor)}</td><td>${cell(row.viewer)}</td>
      </tr>`)}</tbody>
    </table></div>
  </details>`;
}

export function importBannerStrip({ space, receipt, accessHref = '#/access', onDismiss }) {
  const key = importBannerDismissKey(space, receipt?.checksum);
  let dismissed = false;
  try { dismissed = localStorage.getItem(key) === '1'; } catch { /* ignore */ }
  if (!shouldShowImportBanner(receipt, dismissed)) return nothing;
  const dismiss = () => {
    try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
    if (onDismiss) onDismiss();
  };
  return html`<section class="lmx-import-banner" role="status" aria-label="Imported space setup">
    <div>
      <strong>Imported ${receipt.agentCount || 0} agents${receipt.traceCount ? ` &amp; ${receipt.traceCount.toLocaleString()} traces` : ''} from ${receipt.sourceSpaceName || receipt.sourceSpace}.</strong>
      <span> Agent keys were not transferred for security — all agents are ready to connect once you mint workspace keys.</span>
    </div>
    <div class="lmx-import-banner-actions">
      <a class="lm-btn lm-btn--primary" href=${accessHref}>Open Agent access →</a>
      <button type="button" class="lm-btn lm-btn--ghost" @click=${dismiss} aria-label="Dismiss import banner">Dismiss</button>
    </div>
  </section>`;
}
