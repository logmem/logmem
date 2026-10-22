// actions.js — every write the web app makes. Shown at once, rolled back if the server refuses,
// confirmed with a toast. Writes carry an X-LogMem-Intent header and the space.
import { html, render } from '/vendor/lit-html-3.2.1/lit-html.js';
import { postJSON, toast, state } from './core.js';
import { LANE_LABEL } from './ui.js';

let onChanged = () => {};
export function setChangedHook(fn) { onChanged = fn; }

/** The text in a note box next to an action (unbound inputs keep what the person typed). */
export function noteFor(key) { const el = document.querySelector(`[data-note-for="${CSS.escape(key)}"]`); return el ? el.value.trim() : ''; }
function clearNote(key) { const el = document.querySelector(`[data-note-for="${CSS.escape(key)}"]`); if (el) { el.value = ''; el.blur(); } }
function focusNote(key) { const el = document.querySelector(`[data-note-for="${CSS.escape(key)}"]`); if (el) el.focus(); }
const cardOf = (ev) => ev?.currentTarget?.closest?.('.lmx-card');
const busy = (el, on) => { if (el) el.disabled = on; };

// ─── jobs: nudge and unblock ─────────────────────────────────────────
export async function doWork(ev, op, job, agent) {
  const key = `${op}:${job}`, note = noteFor(key), b = ev.currentTarget, card = cardOf(ev);
  if (op === 'unblock' && !note) { toast('Say in one line why the job can move again.', true); focusNote(key); return; }
  busy(b, true);
  if (op === 'unblock' && card) card.style.opacity = '.4';
  try {
    const j = await postJSON('/api/' + op, 'work', { job, note: note || undefined, agent: agent || undefined });
    clearNote(key);
    toast(op === 'nudge' ? `Nudged ${j.to || 'the agent'}.` : 'Unblocked. The owner sees it in their Brief.');
    onChanged();
  } catch (e) {
    toast('Not saved: ' + e.message, true);
  } finally { if (card) card.style.opacity = ''; busy(b, false); }
}

// ─── tasks: tick, done, can't do ─────────────────────────────────────
export async function doStep(ev, trail, step, rev) {
  const c = ev.currentTarget, want = c.checked;
  busy(c, true);
  try {
    await postJSON('/api/tasks', 'blockers', { action: 'step', trail, step, checked: want, ...(Number.isInteger(rev) ? { rev } : {}) });
    toast(want ? 'Step saved. The agent sees your progress.' : 'Step unticked.');
  } catch (e) { c.checked = !want; toast('Not saved: ' + e.message, true); } finally { busy(c, false); }
}
export async function doTask(ev, action, trail) {
  const key = `task:${trail}`, note = noteFor(key), b = ev.currentTarget, card = cardOf(ev);
  if (action === 'cant_do' && !note) { toast('Say why you can’t do it, in the note box.', true); focusNote(key); return; }
  if (card) card.style.opacity = '.4';
  busy(b, true);
  try {
    await postJSON('/api/tasks', 'blockers', action === 'done' ? { action: 'done', trail, note: note || undefined } : { action: 'cant_do', trail, reason: note });
    toast(action === 'done' ? 'Done. The job moves on.' : 'Sent back to the agent with your reason.');
    onChanged();
  } catch (e) { toast('Not saved: ' + e.message, true); } finally { if (card) card.style.opacity = ''; busy(b, false); }
}

// ─── lanes ───────────────────────────────────────────────────────────
export async function doLane(ev, plan, status) {
  const key = `lane:${plan}`, why = noteFor(key), b = ev.currentTarget;
  if (status === 'parked' && !why) { toast('Say in one line why the lane parks.', true); focusNote(key); return; }
  if (status === 'p0' && !window.confirm(`Make ${plan} the P0 lane? The current P0 lane moves to active.`)) return;
  busy(b, true);
  try {
    const j = await postJSON('/api/lane', 'work', { plan, status, why: why || undefined });
    clearNote(key);
    toast(`Lane ${plan}: ${LANE_LABEL[status]}${j.demoted && j.demoted.length ? `. ${j.demoted.join(', ')} moved to active.` : '.'}`);
    onChanged();
  } catch (e) { toast('Not saved: ' + e.message, true); } finally { busy(b, false); }
}

// ─── decisions: one ask, or a batch ──────────────────────────────────
const irreversible = (a) => (a.payload || {}).reversible !== true;

/** Ask for a typed "approve" before anything that can't be undone. Resolves true when confirmed. */
export function confirmIrreversible(asks) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    let typed = false;
    const close = (ok) => { document.removeEventListener('keydown', onKey); render(html``, host); host.remove(); resolve(ok); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    const draw = () => render(html`<div class="lm-scrim" style="position:fixed;inset:0;z-index:var(--z-dialog,510)" @click=${(e) => { if (e.target === e.currentTarget) close(false); }}>
      <div class="lm-dialog" role="dialog" aria-modal="true" aria-labelledby="lm-dlg-t">
        <div class="lm-dialog-head"><h2 class="lm-title-2" id="lm-dlg-t" style="margin:0;font-size:17px">${asks.length === 1 ? 'This can’t be undone' : `${asks.length} actions can’t be undone`}</h2><span style="font-size:13px" class="muted">If you approve, the agents do exactly this:</span></div>
        <div class="lm-dialog-body" style="display:flex;flex-direction:column;gap:12px">
          ${asks.map((a) => html`<div><div class="lmx-meta">${a.summary}</div><pre class="lm-action">${(a.payload || {}).action || '(not given)'}</pre></div>`)}
          <label class="lm-field"><span class="lm-label">Type approve to confirm</span><input class="lm-input" autocomplete="off" spellcheck="false" @input=${(e) => { typed = e.target.value.trim().toLowerCase() === 'approve'; draw(); }} @keydown=${(e) => { if (e.key === 'Enter' && typed) { e.preventDefault(); close(true); } }}></label>
        </div>
        <div class="lm-dialog-foot"><button type="button" class="lm-btn lm-btn--secondary" @click=${() => close(false)}>Cancel</button><button type="button" class="lm-btn lm-btn--primary" ?disabled=${!typed} @click=${() => close(true)}>Approve</button></div>
      </div></div>`, host);
    draw();
    document.addEventListener('keydown', onKey);
    const input = host.querySelector('input'); if (input) input.focus();
  });
}

async function sendOne(a, verdict, note, confirmed) {
  const body = { trail: a.trail, verdict };
  if (note) body.note = note;
  if (confirmed) body.confirm = 'approve';
  return postJSON('/api/decide', 'decide', body);
}

export async function decide(ev, a, verdict) {
  const key = `ask:${a.trail}`, note = noteFor(key).slice(0, 1000), card = ev.currentTarget.closest('.lm-approval');
  let confirmed = false;
  if (verdict === 'approve' && irreversible(a)) { confirmed = await confirmIrreversible([a]); if (!confirmed) return; }
  const btns = card ? card.querySelectorAll('button') : [];
  btns.forEach((b) => { b.disabled = true; });
  try {
    await sendOne(a, verdict, note, confirmed);
    clearNote(key);
    toast(verdict === 'approve' ? 'Approved. The agent sees it in its Brief.' : verdict === 'reject' ? 'Rejected. The agent picks another way.' : 'Deferred. It stays open.');
    onChanged();
  } catch (e) {
    toast(e.status === 409 ? 'Already answered: ' + e.message : 'Not recorded: ' + e.message + '. Nothing was written.', true);
  } finally {
    // lit keeps these nodes when the ask stays on screen (Defer), so they are always enabled again.
    btns.forEach((b) => { b.disabled = false; });
  }
}

/** Approve or reject several decisions at once. Irreversible ones share one typed confirmation. */
export async function decideBatch(asks, verdict) {
  if (!asks.length) return;
  // Each ask keeps the note typed on its own card. Read them before the confirm dialog opens.
  const notes = new Map(asks.map((a) => [a.trail, noteFor(`ask:${a.trail}`).slice(0, 1000)]));
  let confirmed = false;
  if (verdict === 'approve' && asks.some(irreversible)) { confirmed = await confirmIrreversible(asks.filter(irreversible)); if (!confirmed) return; }
  let ok = 0; const failed = [];
  for (const a of asks) {
    try { await sendOne(a, verdict, notes.get(a.trail), confirmed); ok++; clearNote(`ask:${a.trail}`); } catch (e) { failed.push(`${a.summary}: ${e.message}`); }
  }
  toast(`${verdict === 'approve' ? 'Approved' : 'Rejected'} ${ok} of ${asks.length}.${failed.length ? ' Not recorded: ' + failed.join('; ') : ''}`, failed.length > 0);
  onChanged();
}

export async function invite(ev, emails) {
  const b = ev.currentTarget; busy(b, true);
  try { await postJSON('/api/invites', 'invites', { emails }); toast(`Invited ${emails.length}.`); onChanged(); } catch (e) { busy(b, false); toast('Not sent: ' + e.message, true); }
}
export const currentSpace = () => state.space;
