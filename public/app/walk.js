// walk.js — walkthroughs: the writer on a job page and the player a person follows.
// Spec: docs/superpowers/specs/2026-10-20-logmem-walkthrough-design.md.
// Writer: #/write/<job> or #/write/<job>/<trail> (edit before the first tick). One save: POST /api/tasks write.
// Player: #/walk/<space>/<trail>, with no admin rail. One step at a time: the count, where to go,
// what to do, what you should see. Ticks are the existing step write; the last screen sends the reply.
// Preview: #/walk/preview plays the writer's draft and saves nothing.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { live as liveDir } from '/vendor/lit-html-3.2.1/directives/live.js';
import { repeat } from '/vendor/lit-html-3.2.1/directives/repeat.js';
import { getJSON, postJSON, toast, state, agentName } from './core.js';
import { icon, emptyState, head, btn } from './ui.js';
import { renderView, renderBare } from './shell.js';
import { closeDrawer, drawerOpen } from './drawer.js';

export const MAX_STEPS = 7;
const LIMITS = { title: 120, go: 300, detail: 1000, cmd: 500, see: 300, field: 300, reply: 1000 };
let okHook = () => true;
export function setWalkOkHook(fn) { okHook = fn; }

// ─── shared ──────────────────────────────────────────────────────────
/** Only http(s) links become links; anything else ("Settings › Keys") stays plain text. */
export function safeHref(go) {
  if (typeof go !== 'string') return null;
  try { const u = new URL(go.trim()); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch (e) { return null; }
}
const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Could not copy. Select the text and copy it.', true));
const playerLink = (space, trail) => `${location.origin}/app#/walk/${encodeURIComponent(space)}/${encodeURIComponent(trail)}`;

// ─── writer ──────────────────────────────────────────────────────────
let uid = 0;
const blankStep = () => ({ k: ++uid, title: '', go: '', detail: '', cmd: '', see: '' });
// The draft belongs to one space, job and trail. Its key includes the space, so switching spaces starts
// a new draft, and the save goes to the draft's own space (codex review of PR 88).
let draft = null; // { key, space, job, trail, to, summary, steps: [...], done_when, reply, saving }
const draftKey = (space, job, trail) => [space || '', job, trail || ''].join('/');

function fromRecord(space, job, rec) {
  const w = rec.walkthrough || {};
  return { key: draftKey(space, job, rec.trail), space, job, trail: rec.trail, to: rec.to, summary: rec.summary || '', done_when: w.done_when || '', reply: w.reply || '',
    steps: (w.steps || []).map((s) => ({ k: ++uid, title: s.title || '', go: s.go || '', detail: s.detail || '', cmd: s.cmd || '', see: s.see || '' })) };
}
/** The walkthrough body the API takes: empty fields left out. */
export function toWalkthrough(d) {
  const keep = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));
  return { steps: d.steps.map((s) => keep({ title: s.title, go: s.go, detail: s.detail, cmd: s.cmd, see: s.see })), ...keep({ done_when: d.done_when, reply: d.reply }) };
}

// Each load gets a number. A reply that arrives after a newer load started is dropped, so a slow
// answer for space A can never render (or write) over a page the person opened later (codex, PR 88).
let writerSeq = 0, playerSeq = 0;
/** Leaving a page drops its pending loads: the router calls this on every route change (codex, PR 88). */
export function cancelWalkLoads() { writerSeq++; playerSeq++; }

export async function writerPage(arg) {
  if (drawerOpen()) closeDrawer();
  const [job, trail] = String(arg || '').split('/');
  if (!job) { location.replace('#/jobs'); return; }
  const seq = ++writerSeq;
  const jobD = await getJSON('/api/view?' + new URLSearchParams({ what: 'job', id: job, space: state.space || '' }));
  if (seq !== writerSeq) return;
  if (!okHook(jobD)) return;
  // On a fresh deep link the space is only known after the first reply, so bind the draft here.
  const space = state.space;
  const key = draftKey(space, job, trail);
  if (!draft || draft.key !== key) {
    if (trail) {
      const t = await getJSON('/api/tasks?' + new URLSearchParams({ space: space || '', trail }));
      if (seq !== writerSeq) return;
      if (!okHook(t)) return;
      draft = fromRecord(space, job, t.blocker);
    } else {
      const me = await getJSON('/api/tasks?' + new URLSearchParams({ space: space || '' }));
      if (seq !== writerSeq) return;
      draft = { key, space, job, trail: null, to: (me && me.person) || '', summary: '', done_when: '', reply: '', steps: [blankStep()] };
    }
  }
  draft.jobTitle = (jobD.who && jobD.who.title) || job;
  drawWriter();
}

function drawWriter() {
  const d = draft;
  const set = (o, f) => (e) => { o[f] = e.target.value; };
  const move = (i, by) => () => { const j = i + by; if (j < 0 || j >= d.steps.length) return; const s = d.steps.splice(i, 1)[0]; d.steps.splice(j, 0, s); drawWriter(); };
  const remove = (i) => () => { d.steps.splice(i, 1); if (!d.steps.length) d.steps.push(blankStep()); drawWriter(); };
  const add = () => { if (d.steps.length < MAX_STEPS) { d.steps.push(blankStep()); drawWriter(); } };
  const field = (label, o, f, max, opts = {}) => html`<label class="lm-field"><span class="lm-label">${label}${opts.req ? ' *' : ''}</span>
    ${opts.area ? html`<textarea class="lm-input" rows=${opts.rows || 2} maxlength=${max} placeholder=${opts.ph || ''} .value=${liveDir(o[f] || '')} @input=${set(o, f)}></textarea>`
      : html`<input class="lm-input" maxlength=${max} placeholder=${opts.ph || ''} .value=${liveDir(o[f] || '')} @input=${set(o, f)} ?required=${!!opts.req} data-f=${opts.data || nothing}>`}
    ${opts.help ? html`<span class="lm-help">${opts.help}</span>` : nothing}</label>`;
  const stepTpl = (s, i) => html`<fieldset class="lm-panel lmw-wstep" data-key=${'wstep:' + s.k}>
    <legend class="lmw-wstep-head"><span class="ob-dot" data-s="cur">${i + 1}</span><b>Step ${i + 1} of ${d.steps.length}</b></legend>
    <div class="lmw-wstep-acts">${btn('Up', 'ghost', move(i, -1), { disabled: i === 0, label: `Move step ${i + 1} up` })}${btn('Down', 'ghost', move(i, 1), { disabled: i === d.steps.length - 1, label: `Move step ${i + 1} down` })}${btn('Remove', 'ghost', remove(i), { label: `Remove step ${i + 1}` })}</div>
    ${field('What to do', s, 'title', LIMITS.title, { req: true, ph: 'Add the npm token to Infisical', data: 'title' })}
    ${field('Where to go', s, 'go', LIMITS.go, { ph: 'https://app.infisical.com or “Vercel › Settings › Environment Variables”', help: 'A link opens in a new tab. Plain words are fine too.' })}
    ${field('More detail', s, 'detail', LIMITS.detail, { area: true })}
    ${field('Command to copy', s, 'cmd', LIMITS.cmd, { ph: 'Optional' })}
    ${field('What you should see', s, 'see', LIMITS.see, { ph: 'A green “Saved” banner, and NPM_TOKEN in the list' })}</fieldset>`;
  renderView('jobs', ['Jobs', d.jobTitle, d.trail ? 'Edit walkthrough' : 'Write a walkthrough'], html`
    ${head(d.trail ? 'Edit walkthrough' : 'Write a walkthrough', html`For job <a href=${'#/job/' + encodeURIComponent(d.job)}>${d.jobTitle}</a>. One step on screen at a time, ${MAX_STEPS} steps at most. Never paste a secret value: say where it lives.`)}
    <form class="lmw-writer" @submit=${(e) => { e.preventDefault(); save(); }}>
      <div class="lmw-grid2">${field('Title', d, 'summary', LIMITS.title, { req: true, ph: 'Set up the npm token', data: 'summary' })}
        ${field('For whom', d, 'to', 64, { req: true, ph: 'human:mikey', help: 'A person, as human:<id>. They find it in Needs you.' })}</div>
      ${repeat(d.steps, (s) => s.k, stepTpl)}
      <div class="lmx-acts">${btn(`Add a step (${d.steps.length} of ${MAX_STEPS})`, 'secondary', add, { disabled: d.steps.length >= MAX_STEPS })}</div>
      <div class="lmw-grid2">${field('Done when', d, 'done_when', LIMITS.field, { ph: 'The token shows in Infisical and the publish job can read it' })}
        ${field('Reply they send back', d, 'reply', LIMITS.reply, { area: true, ph: 'Done: the npm token is in Infisical.', help: 'A starting text. They can change it on the last screen.' })}</div>
      <div class="lmx-acts lmw-savebar">${btn('Preview', 'secondary', preview)}<button class="lm-btn lm-btn--primary" ?disabled=${!!d.saving}>${d.saving ? 'Saving…' : d.trail ? 'Save changes' : 'Save walkthrough'}</button>
        <a class="lm-btn lm-btn--ghost" href=${'#/job/' + encodeURIComponent(d.job)}>Cancel</a></div>
    </form>`);
}

function check(d) {
  if (!d.summary.trim()) return ['Give the walkthrough a title.', 'summary'];
  if (!/^human:[a-z0-9][a-z0-9_.-]{0,63}$/.test(d.to.trim())) return ['Say who it is for, as human:<id>.', null];
  const i = d.steps.findIndex((s) => !s.title.trim());
  if (i >= 0) return [`Step ${i + 1} needs “What to do”.`, 'title', i];
  return null;
}
function preview() {
  const bad = check(draft);
  if (bad) { toast(bad[0], true); return; }
  location.hash = '#/walk/preview';
}
async function save() {
  const d = draft, bad = check(d);
  if (bad) {
    toast(bad[0], true);
    const els = document.querySelectorAll(`[data-f="${bad[1]}"]`);
    const el = els[bad[2] || 0]; if (el) el.focus();
    return;
  }
  if (d.space !== state.space) { toast(`This draft is for space ${d.space}. Switch back to it to save, or open the writer again here.`, true); return; }
  d.saving = true; drawWriter();
  try {
    const j = await postJSON('/api/tasks', 'blockers', { space: d.space, action: 'write', job: d.job, to: d.to.trim(), summary: d.summary.trim(), walkthrough: toWalkthrough(d), ...(d.trail ? { trail: d.trail } : {}) });
    const job = d.job;
    draft = null;
    toast(d.trail ? 'Walkthrough saved.' : `Saved. ${agentName(j.blocker.to)} sees it in Needs you. Copy the player link from the job page.`);
    location.hash = '#/job/' + encodeURIComponent(job);
  } catch (e) { d.saving = false; drawWriter(); toast('Not saved: ' + e.message, true); }
}

// ─── player ──────────────────────────────────────────────────────────
// Player state belongs to one space and trail; its writes go to that space (codex review of PR 88).
let play = null; // { key, space, i, reply, cant, localDone }
const playKey = (space, trail) => `${space || ''}/${trail}`;

export async function playerPage(arg) {
  if (drawerOpen()) closeDrawer();
  const raw = String(arg || '');
  // Every player load takes a number first, preview included, so a held reply can't replace it.
  const seq = ++playerSeq;
  if (raw === 'preview') {
    if (!draft) { renderBare(bare(emptyState('Nothing to preview.', 'Open the writer on a job page, then press Preview.'))); return; }
    if (!play || play.key !== 'preview') play = { key: 'preview', space: state.space, i: 0, localDone: [] };
    const rec = { trail: 'preview', summary: draft.summary, to: draft.to, by: '', walkthrough: toWalkthrough(draft), steps_done: play.localDone, done: false };
    return drawPlayer(rec, true);
  }
  const cut = raw.indexOf('/');
  const space = cut > 0 ? raw.slice(0, cut) : state.space;
  const trail = cut > 0 ? raw.slice(cut + 1) : raw;
  if (space && space !== state.space) state.space = space;
  // The request's own space, captured before the await: the record shown and every write use it.
  const reqSpace = state.space;
  const t = await getJSON('/api/tasks?' + new URLSearchParams({ space: reqSpace || '', trail }));
  if (seq !== playerSeq) return;
  if (t.__status === 404) { renderBare(bare(emptyState('This walkthrough isn’t here.', 'It may be in another space, or it was written for someone else. Ask whoever sent you the link.'))); return; }
  if (!okHook(t)) return;
  const rec = t.blocker;
  const key = playKey(reqSpace, rec.trail);
  if (!play || play.key !== key) play = { key, space: reqSpace, i: firstOpen(rec) };
  drawPlayer(rec, false);
}

/** Progress comes back to the same place: the first step not yet ticked. */
export function firstOpen(rec) {
  const n = ((rec.walkthrough || {}).steps || []).length, done = new Set(rec.steps_done || []);
  for (let i = 0; i < n; i++) if (!done.has(i)) return i;
  return n; // every step ticked: the reply screen
}

function bare(body, count) {
  return html`<div class="lmw">
    <header class="lmw-head"><div class="wrap lmw-head-in"><a href="/" class="lmw-logo"><img class="logo-l" src="/ds/logos/logmem-lockup.svg" alt="LogMem"><img class="logo-d" src="/ds/logos/logmem-lockup-reversed.svg" alt="LogMem"></a>${count ? html`<span class="lmw-count">${count}</span>` : nothing}</div></header>
    <main class="wrap lmw-main" id="main">${body}</main></div>`;
}

function drawPlayer(rec, isPreview) {
  const w = rec.walkthrough || {}, steps = w.steps || [], n = steps.length, done = new Set(rec.steps_done || []);
  const i = Math.min(play.i, n), atEnd = i >= n;
  document.title = `LogMem · ${rec.summary}`;
  if (rec.done) {
    const cant = rec.outcome === 'cant_do';
    return renderBare(bare(html`<section class="lm-panel ob-card lmw-card">
      <div class="lm-eyebrow">${cant ? 'Sent back' : 'Finished'}</div><h1 tabindex="-1">${rec.summary}</h1>
      <p class="ob-lede">${cant ? html`You said you couldn’t finish it: “${rec.reason}”. The agent has your reason.` : html`All done. The job moves on.${rec.note ? html` Your reply: “${rec.note}”` : ''}`}</p></section>`));
  }
  const go = (k) => () => { play.i = k; play.cant = false; drawPlayer(rec, isPreview); focusCard(); };
  const rail = html`<nav class="lmw-rail" aria-label="Steps"><ol class="ob-steps">${steps.map((s, k) => html`<li>
      <button type="button" class="ob-step" aria-current=${k === i ? 'step' : nothing} @click=${go(k)}>
        <span class="ob-dot" data-s=${done.has(k) ? 'done' : k === i ? 'cur' : 'todo'}>${done.has(k) ? '✓' : k + 1}</span>
        <span class="ob-step-text"><span class="ob-step-title">${s.title}</span>${done.has(k) ? html`<span class="ob-step-sub">Done</span>` : nothing}</span></button></li>`)}
      <li><button type="button" class="ob-step" aria-current=${atEnd ? 'step' : nothing} ?disabled=${done.size < n} @click=${go(n)}><span class="ob-dot" data-s=${atEnd ? 'cur' : 'todo'}>${icon('check')}</span><span class="ob-step-text"><span class="ob-step-title">Send your reply</span></span></button></li></ol></nav>`;
  const banner = isPreview ? html`<div class="lm-alert lm-alert--info lmw-preview">${icon('eye')}<div><strong>Preview.</strong> This is what ${agentName(rec.to) || 'they'} will see. Nothing is saved. <a href=${'#/write/' + encodeURIComponent(draft.job) + (draft.trail ? '/' + encodeURIComponent(draft.trail) : '')}>Back to the writer</a></div></div>` : nothing;
  const body = atEnd ? finishCard(rec, isPreview, n) : stepCard(rec, steps[i], i, n, done.has(i), isPreview);
  renderBare(bare(html`${banner}<div class="lmw-layout">${rail}<div class="lmw-col">${body}</div></div>`, atEnd ? `All ${n} steps done` : `Step ${i + 1} of ${n}`));
}
const focusCard = () => requestAnimationFrame(() => { const h = document.querySelector('.lmw-card h1'); if (h) h.focus({ preventScroll: false }); });

function stepCard(rec, s, i, n, ticked, isPreview) {
  const href = safeHref(s.go);
  const next = async (ev) => {
    if (!ticked) {
      if (isPreview) play.localDone = [...new Set([...play.localDone, i])];
      else {
        // lit reuses this button for the next step, so it is always re-enabled (finally).
        const b = ev.currentTarget; b.disabled = true;
        try { await postJSON('/api/tasks', 'blockers', { space: play.space, action: 'step', trail: rec.trail, step: i, checked: true, rev: rec.rev || 0 }); }
        catch (e) { toast('Not saved: ' + e.message, true); return; }
        finally { b.disabled = false; }
      }
    }
    play.i = i + 1;
    return isPreview ? playerPage('preview').then(focusCard) : playerPage(play.space + '/' + rec.trail).then(focusCard);
  };
  const untick = async () => {
    if (isPreview) { play.localDone = play.localDone.filter((x) => x !== i); return playerPage('preview'); }
    try { await postJSON('/api/tasks', 'blockers', { space: play.space, action: 'step', trail: rec.trail, step: i, checked: false, rev: rec.rev || 0 }); playerPage(play.space + '/' + rec.trail); }
    catch (e) { toast('Not saved: ' + e.message, true); }
  };
  return html`<section class="lm-panel ob-card lmw-card" data-key=${'wstep:' + i}>
    <div class="lm-eyebrow">Step ${i + 1} of ${n}${ticked ? ' · done' : ''}</div>
    <h1 tabindex="-1">${s.title}</h1>
    ${s.go ? html`<div class="lmw-part"><span class="lm-label">Where to go</span>${href ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${s.go}</a>` : html`<span>${s.go}</span>`}</div>` : nothing}
    ${s.detail ? html`<p class="ob-lede">${s.detail}</p>` : nothing}
    ${s.cmd ? html`<div class="lmw-part"><span class="lm-label">Command</span><div class="lmx-acts"><code class="lmw-cmd">${s.cmd}</code>${btn('Copy', 'ghost', () => copy(s.cmd))}</div></div>` : nothing}
    ${s.see ? html`<div class="lmw-see"><span class="lm-label">What you should see</span><span>${s.see}</span></div>` : nothing}
    <div class="lmx-acts lmw-nav">${i > 0 ? btn('Back', 'secondary', () => { play.i = i - 1; drawPlayerAgain(rec, isPreview); }) : nothing}
      ${btn(ticked ? (i + 1 < n ? 'Next step' : 'Go to the reply') : i + 1 < n ? 'Done, next step' : 'Done, last step', 'primary', next)}
      ${ticked ? btn('Mark not done', 'ghost', untick) : nothing}</div></section>`;
}
const drawPlayerAgain = (rec, isPreview) => { drawPlayer(rec, isPreview); focusCard(); };

function finishCard(rec, isPreview, n) {
  const w = rec.walkthrough || {};
  if (play.reply == null) play.reply = w.reply || '';
  const send = async (ev) => {
    if (isPreview) { toast('Preview: nothing was sent.'); return; }
    const b = ev.currentTarget; b.disabled = true;
    try {
      await postJSON('/api/tasks', 'blockers', play.cant ? { space: play.space, action: 'cant_do', trail: rec.trail, reason: play.reply.trim() } : { space: play.space, action: 'done', trail: rec.trail, note: play.reply.trim() || undefined });
      toast(play.cant ? 'Sent back with your reason.' : 'Reply sent. The job moves on.');
      play.reply = null;
      playerPage(play.space + '/' + rec.trail);
    } catch (e) { toast('Not sent: ' + e.message, true); } finally { b.disabled = false; }
  };
  const cantMode = () => { play.cant = !play.cant; play.reply = play.cant ? '' : w.reply || ''; drawPlayerAgain(rec, isPreview); };
  return html`<section class="lm-panel ob-card lmw-card">
    <div class="lm-eyebrow">${play.cant ? 'Can’t finish' : `All ${n} steps done`}</div>
    <h1 tabindex="-1">${play.cant ? 'Say what stopped you' : 'Send your reply'}</h1>
    ${w.done_when && !play.cant ? html`<p class="ob-lede"><b>Done when:</b> ${w.done_when}</p>` : nothing}
    <label class="lm-field"><span class="lm-label">${play.cant ? 'Why you can’t finish it (required)' : 'Your reply to the agent'}</span>
      <textarea class="lm-input" rows="4" maxlength="1000" .value=${liveDir(play.reply)} @input=${(e) => { play.reply = e.target.value; }}></textarea></label>
    <div class="lmx-acts lmw-nav">${btn('Back', 'secondary', () => { play.i = n - 1; play.cant = false; drawPlayerAgain(rec, isPreview); })}
      ${btn(play.cant ? 'Send it back' : 'Send reply', play.cant ? 'danger' : 'primary', (e) => { if (play.cant && !play.reply.trim()) { toast('Say why, in one line.', true); return; } send(e); })}
      ${btn(play.cant ? 'I can finish it' : 'I can’t finish this', 'ghost', cantMode)}</div></section>`;
}

// ─── on the job page ────────────────────────────────────────────────
/** The Walkthroughs panel on a job: each open task with its progress, plus Write. */
export function jobWalkthroughs(jobId, tasks) {
  const list = (tasks || []).filter((t) => t.steps > 0);
  return html`<div class="lmx-stack">${list.map((t) => html`<div class="lmx-card" data-key=${'walk:' + t.trail}>
      <div class="lmx-meta">For ${agentName(t.to)} · from ${agentName(t.by)} · ${t.steps_done} of ${t.steps} steps</div><h3>${t.summary}</h3>
      <div class="lmx-acts"><a class="lm-btn lm-btn--secondary" href=${'#/walk/' + encodeURIComponent(state.space || '') + '/' + encodeURIComponent(t.trail)}>Open the player</a>
        ${btn('Copy link', 'ghost', () => copy(playerLink(state.space, t.trail)))}
        ${t.steps_done === 0 && /^human:/.test(t.by || '') ? html`<a class="lm-btn lm-btn--ghost" href=${'#/write/' + encodeURIComponent(jobId) + '/' + encodeURIComponent(t.trail)}>Edit</a>` : nothing}</div></div>`)}
    <div class="lmx-acts"><a class="lm-btn lm-btn--primary" href=${'#/write/' + encodeURIComponent(jobId)}>Write a walkthrough</a></div></div>`;
}
