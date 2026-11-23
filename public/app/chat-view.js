// chat-view.js: #/chat. Ask about this space. Answers come from its memory and are read only.
// Includes Illos Streaming Tokens empty state, pill Suggestions, Cited Sources bar,
// inline GenerationStats (real latency/source/word count), AI Actions (Copy/Retry/Feedback),
// and elevated CitedAnswerChatInput composer.
import { html, svg, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { live } from '/vendor/lit-html-3.2.1/directives/live.js';
import { state, postJSON, onContextReset } from './core.js';
import { head, textWithIds } from './ui.js';
import { copy } from './cards.js';
import { renderView } from './shell.js';

const SUGGEST = ['What needs me?', 'What is blocked?', 'What happened recently?', 'Which agents are active?'];
const MAX_CHARS = 2000;
const REF_RE = /\b((?:job|agent|channel):[a-zA-Z0-9._-]+|trail:[a-zA-Z0-9._-]+)\b/g;

let msgs = [], busy = false, draft = '', seq = 0, forSpace = null, copiedId = null;

onContextReset(() => { msgs = []; busy = false; draft = ''; forSpace = null; copiedId = null; });

function sourceLabel(m) {
  if (m.provider === 'model') return m.model || 'model';
  if (m.provider === 'rules') return 'space data';
  return '';
}

function fmtMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function extractSources(text) {
  const seen = new Set(), out = [];
  for (const match of String(text || '').matchAll(REF_RE)) {
    const raw = match[1];
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const [kind, ...rest] = raw.split(':');
    const id = rest.join(':');
    const href = kind === 'agent' ? '#/agent/' + encodeURIComponent(id)
      : kind === 'job' ? '#/job/' + encodeURIComponent(id)
      : kind === 'channel' ? '#/channels/' + encodeURIComponent(id)
      : null;
    out.push({ id: raw, kind, href });
    if (out.length >= 6) break;
  }
  return out;
}

function wordCount(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

async function send(raw) {
  const text = String(raw || '').trim().slice(0, MAX_CHARS);
  if (!text || busy) return;
  const space = state.space;
  const t0 = performance.now();
  msgs = [...msgs, { id: ++seq, role: 'user', text }];
  const history = msgs.filter((m) => m.role === 'user' || m.text).map(({ role, text: t }) => ({ role, text: t })).slice(-20);
  const bot = { id: ++seq, role: 'assistant', text: '', pending: true };
  msgs = [...msgs, bot];
  busy = true; draft = '';
  draw(true);
  let next;
  try {
    const r = await postJSON('/api/chat', 'chat', { history });
    const outText = String(r.text || '');
    next = {
      ...bot,
      pending: false,
      text: outText,
      provider: r.provider,
      model: r.model,
      durationMs: performance.now() - t0,
      sources: extractSources(outText),
      feedback: null,
      action: r.action ? { ...r.action, state: 'pending' } : null,
    };
  } catch (e) {
    if (e.stale) return;
    next = {
      ...bot,
      pending: false,
      text: 'Chat could not answer. Nothing ran. Try again in a moment.',
      failed: true,
      durationMs: performance.now() - t0,
      sources: [],
    };
  } finally {
    busy = false;
  }
  if (space !== state.space) return;
  msgs = msgs.map((m) => (m.id === bot.id ? next : m));
  draw(true);
}

function retryFrom(botId) {
  if (busy) return;
  const idx = msgs.findIndex((m) => m.id === botId);
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (msgs[i].role === 'user') { send(msgs[i].text); return; }
  }
}

function settle(id, verdict) {
  msgs = msgs.map((m) => (m.id === id && m.action ? { ...m, action: { ...m.action, state: verdict } } : m));
  draw();
}

function toggleFeedback(id, dir) {
  msgs = msgs.map((m) => (m.id === id ? { ...m, feedback: m.feedback === dir ? null : dir } : m));
  draw();
}

function copyReply(m) {
  if (!m.text) return;
  copy(m.text);
  copiedId = m.id;
  draw();
  window.setTimeout(() => { if (copiedId === m.id) { copiedId = null; draw(); } }, 1600);
}

function streamingTokensSvg() {
  return svg`<svg class="lm-chat-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 190" fill="none" role="img" aria-label="Streaming tokens from space memory">
    <path d="M0 48H560M0 96H560M0 144H560M96 0V190M192 0V190M288 0V190M384 0V190M480 0V190" stroke="var(--border)" stroke-opacity="0.45" stroke-width="1"/>
    <rect x="28" y="58" width="88" height="74" rx="6" fill="var(--surface)" stroke="var(--brand)" stroke-width="1.25"/>
    <rect x="28" y="58" width="52" height="16" rx="3" fill="var(--brand)"/>
    <text x="54" y="69" text-anchor="middle" fill="var(--on-brand)" font-family="var(--font-mono)" font-size="9" font-weight="600">SPACE</text>
    <line x1="46" y1="86" x2="46" y2="118" stroke="var(--brand)" stroke-opacity="0.45" stroke-width="3" stroke-dasharray="6 3" stroke-linecap="round"/>
    <line x1="58" y1="91" x2="58" y2="114" stroke="var(--brand)" stroke-opacity="0.7" stroke-width="3" stroke-dasharray="6 3" stroke-linecap="round"/>
    <line x1="70" y1="86" x2="70" y2="120" stroke="var(--brand)" stroke-opacity="0.9" stroke-width="3" stroke-dasharray="6 3" stroke-linecap="round"/>
    <line x1="82" y1="90" x2="82" y2="115" stroke="var(--brand)" stroke-opacity="0.55" stroke-width="3" stroke-dasharray="6 3" stroke-linecap="round"/>
    <line x1="94" y1="86" x2="94" y2="118" stroke="var(--brand)" stroke-opacity="0.75" stroke-width="3" stroke-dasharray="6 3" stroke-linecap="round"/>
    <path d="M120 95 C164 68, 206 122, 260 95" stroke="var(--brand)" stroke-opacity="0.45" stroke-width="2" stroke-dasharray="5 4"/>
    <rect class="lm-chat-art-pulse" x="142" y="88" width="10" height="14" rx="2" fill="var(--brand)" fill-opacity="0.45"/>
    <rect class="lm-chat-art-pulse" x="174" y="80" width="10" height="14" rx="2" fill="var(--brand)" fill-opacity="0.65"/>
    <rect class="lm-chat-art-pulse" x="206" y="96" width="10" height="14" rx="2" fill="var(--brand)" fill-opacity="0.8"/>
    <rect class="lm-chat-art-pulse" x="236" y="88" width="10" height="14" rx="2" fill="var(--brand)" fill-opacity="0.95"/>
    <rect x="266" y="26" width="266" height="138" rx="6" fill="var(--surface)" stroke="var(--brand)" stroke-width="1.25"/>
    <rect x="266" y="26" width="76" height="16" rx="3" fill="var(--brand)"/>
    <text x="304" y="37" text-anchor="middle" fill="var(--on-brand)" font-family="var(--font-mono)" font-size="9" font-weight="600">RESPONSE</text>
    <line x1="286" y1="62" x2="508" y2="62" stroke="var(--brand)" stroke-opacity="0.7" stroke-width="6" stroke-dasharray="18 6 34 6 24 6" stroke-linecap="round"/>
    <line x1="286" y1="84" x2="492" y2="84" stroke="var(--brand)" stroke-opacity="0.55" stroke-width="6" stroke-dasharray="28 6 16 6 40 6" stroke-linecap="round"/>
    <line x1="286" y1="106" x2="502" y2="106" stroke="var(--brand)" stroke-opacity="0.4" stroke-width="6" stroke-dasharray="22 6 32 6 18 6" stroke-linecap="round"/>
    <line x1="286" y1="128" x2="410" y2="128" stroke="var(--brand)" stroke-opacity="0.85" stroke-width="6" stroke-dasharray="30 6 22 6" stroke-linecap="round"/>
    <rect class="lm-chat-art-pulse" x="420" y="121" width="6" height="14" rx="2" fill="var(--brand)"/>
  </svg>`;
}

function message(m) {
  if (m.role === 'user') {
    return html`<li class="lm-chat-turn" data-role="user"><div class="lm-chat-bubble">${m.text}</div></li>`;
  }
  const src = sourceLabel(m);
  const words = wordCount(m.text);
  return html`<li class="lm-chat-turn" data-role="assistant">
    <div class="lm-chat-who"><strong>LogMem</strong>${src ? html`<span>· ${src}</span>` : nothing}</div>
    ${m.pending
      ? html`<p class="lmx-chat-wait" role="status"><span class="lm-orb" data-state="working" aria-hidden="true"></span><span>Reading space memory…</span></p>`
      : html`<div class=${m.failed ? 'lm-chat-prose is-err' : 'lm-chat-prose'} role=${m.failed ? 'alert' : nothing}>${textWithIds(m.text)}</div>`}

    ${m.sources?.length ? html`<div class="lm-chat-cites">
      <span class="lm-chat-cites-lbl">${m.sources.length} ${m.sources.length === 1 ? 'referenced record' : 'referenced records'}</span>
      <ul class="lm-chat-cite-list">${m.sources.map((s, idx) => html`<li>${s.href
        ? html`<a class="lm-chat-cite" href=${s.href}><b>${idx + 1}</b><span>${s.id}</span></a>`
        : html`<button type="button" class="lm-chat-cite" @click=${() => copy(s.id)}><b>${idx + 1}</b><span>${s.id}</span></button>`}</li>`)}</ul>
    </div>` : nothing}

    ${m.action ? html`<div class="lmx-chat-approve">
      <div class="lmx-chat-approve-head"><span class="lm-orb" data-state="waiting" aria-hidden="true"></span><strong>Needs your approval: ${m.action.label}</strong></div>
      <p>${m.action.detail}</p>
      <p class="lmx-chat-meta">Cannot be undone. Nothing runs until you approve.</p>
      ${m.action.state === 'pending'
        ? html`<div class="lmx-chat-btns"><button type="button" class="lmx-chat-decide" @click=${() => settle(m.id, 'approved')}>Approve</button><button type="button" class="lm-btn lm-btn--secondary" @click=${() => settle(m.id, 'declined')}>Decline</button></div>`
        : html`<p role="status" class="lmx-chat-result">${m.action.state === 'approved' ? 'Approved.' : 'Declined.'} Nothing ran. Chat cannot act yet.</p>`}
    </div>` : nothing}

    ${!m.pending ? html`<div class="lm-chat-meta-row">
      <div class="lm-chat-stats" aria-label="Generation stats">
        ${src ? html`<span>${src}</span>` : nothing}
        ${m.durationMs != null ? html`<span>· ${fmtMs(m.durationMs)}</span>` : nothing}
        ${words ? html`<span>· ${words} ${words === 1 ? 'word' : 'words'}</span>` : nothing}
        <span data-status=${m.failed ? 'error' : 'ok'}>· ${m.failed ? 'Error' : 'Complete'}</span>
      </div>
      <div class="lm-chat-actions" role="toolbar" aria-label="Message actions">
        <button type="button" class="lm-chat-act" data-active=${String(copiedId === m.id)} @click=${() => copyReply(m)}>${copiedId === m.id ? '✓ Copied' : 'Copy'}</button>
        <button type="button" class="lm-chat-act" ?disabled=${busy} @click=${() => retryFrom(m.id)}>Retry</button>
        <button type="button" class="lm-chat-act" aria-label="Helpful" aria-pressed=${String(m.feedback === 'up')} data-active=${String(m.feedback === 'up')} @click=${() => toggleFeedback(m.id, 'up')}>↑</button>
        <button type="button" class="lm-chat-act" aria-label="Not helpful" aria-pressed=${String(m.feedback === 'down')} data-active=${String(m.feedback === 'down')} @click=${() => toggleFeedback(m.id, 'down')}>↓</button>
      </div>
    </div>` : nothing}
  </li>`;
}

function onKey(ev) {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(ev.currentTarget.value); }
}

function draw(scroll) {
  const turns = msgs.filter((m) => m.role === 'user').length;
  const body = html`
    ${head('Chat', 'Ask about this space. Answers come from its memory and are read only.')}
    <section class="lm-chat-shell" aria-label="Chat">
      ${msgs.length ? html`<div class="lm-chat-topbar">
        <span class="mono">space:${state.space || 'none'} · ${turns} ${turns === 1 ? 'turn' : 'turns'}</span>
        <button type="button" class="lm-chat-act" ?disabled=${busy} @click=${() => { msgs = []; draw(); }}>New chat</button>
      </div>` : nothing}

      <ol class="lm-chat-feed" role="log" aria-live="polite" aria-label="Conversation">
        ${msgs.length === 0 ? html`<li class="lm-chat-empty">
          ${streamingTokensSvg()}
          <h2>Ask anything about this space</h2>
          <p>Answers read live LogMem memory and cite real jobs, agents, and trails. Anything irreversible waits for your approval.</p>
          <div class="lm-chat-suggs" role="group" aria-label="Prompt suggestions">
            ${SUGGEST.map((s) => html`<button type="button" class="lm-chat-sugg" ?disabled=${!state.space} @click=${() => send(s)}>${s}</button>`)}
          </div>
        </li>` : msgs.map(message)}
      </ol>

      <div class="lm-chat-dock">
        ${msgs.length && !busy ? html`<div class="lm-chat-suggs lm-chat-suggs--inline" role="group" aria-label="Follow-up suggestions">
          ${SUGGEST.slice(0, 3).map((s) => html`<button type="button" class="lm-chat-sugg" ?disabled=${!state.space} @click=${() => send(s)}>${s}</button>`)}
        </div>` : nothing}

        <form class="lm-chat-composer" @submit=${(ev) => { ev.preventDefault(); send(ev.currentTarget.elements.message.value); }}>
          <label class="lmx-chat-sr" for="chat-message">Message</label>
          <textarea id="chat-message" name="message" rows="2" maxlength=${MAX_CHARS} placeholder=${msgs.length ? 'Ask a follow-up…' : 'Ask about your inbox, jobs, or agents…'} .value=${live(draft)} @input=${(ev) => { draft = ev.currentTarget.value; }} @keydown=${onKey} ?disabled=${!state.space}></textarea>
          <div class="lm-chat-composer-foot">
            <span>Reads space memory · Nothing runs without your approval</span>
            <div class="lm-chat-composer-right">
              <span class="mono">Enter ↵</span>
              <button type="submit" class="lm-chat-send" aria-label="Send message" ?disabled=${busy || !state.space || !draft.trim()}>↑</button>
            </div>
          </div>
        </form>
      </div>
    </section>`;
  renderView('chat', ['Chat'], body);
  if (scroll) requestAnimationFrame(() => document.querySelector('.lm-chat-feed > li:last-child')?.scrollIntoView({ block: 'nearest' }));
}

export function registerChat(pages) {
  pages.chat = async () => {
    if (forSpace !== state.space) { msgs = []; forSpace = state.space; }
    draw();
    return true;
  };
}
