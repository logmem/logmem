// chat-view.js: #/chat. Ask about this space. Answers come from its memory and are read only.
// The server (api/chat.mjs -> src/http/chat.mjs) answers with a model when one is available,
// otherwise from fixed rules over the home view. A request that cannot be undone comes back
// as an approval card, and approving it in this version runs nothing.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { live } from '/vendor/lit-html-3.2.1/directives/live.js';
import { state, postJSON, onContextReset } from './core.js';
import { head } from './ui.js';
import { renderView } from './shell.js';

const SUGGEST = ['What needs me?', 'What is blocked?', 'What happened recently?'];
const MAX_CHARS = 2000;
let msgs = [], busy = false, draft = '', seq = 0, forSpace = null;

onContextReset(() => { msgs = []; busy = false; draft = ''; forSpace = null; });

function sourceLabel(m) {
  if (m.provider === 'model') return `from ${m.model || 'a model'}`;
  if (m.provider === 'rules') return 'from space data';
  return '';
}

async function send(raw) {
  const text = String(raw || '').trim().slice(0, MAX_CHARS);
  if (!text || busy) return;
  const space = state.space;
  msgs = [...msgs, { id: ++seq, role: 'user', text }];
  const history = msgs.filter((m) => m.role === 'user' || m.text).map(({ role, text: t }) => ({ role, text: t })).slice(-20);
  const bot = { id: ++seq, role: 'assistant', text: '', pending: true };
  msgs = [...msgs, bot];
  busy = true; draft = '';
  draw(true);
  let next;
  try {
    const r = await postJSON('/api/chat', 'chat', { history });
    next = { ...bot, pending: false, text: String(r.text || ''), provider: r.provider, model: r.model, action: r.action ? { ...r.action, state: 'pending' } : null };
  } catch (e) {
    if (e.stale) return;
    next = { ...bot, pending: false, text: 'Chat could not answer. Nothing ran. Try again in a moment.', failed: true };
  } finally {
    busy = false;
  }
  if (space !== state.space) return;
  msgs = msgs.map((m) => (m.id === bot.id ? next : m));
  draw(true);
}

function settle(id, verdict) {
  msgs = msgs.map((m) => (m.id === id && m.action ? { ...m, action: { ...m.action, state: verdict } } : m));
  draw();
}

function message(m) {
  const src = m.role === 'assistant' ? sourceLabel(m) : '';
  return html`<li class="lmx-chat-msg" data-role=${m.role}>
    <div class="lmx-chat-who">${m.role === 'user' ? 'You' : 'LogMem'}${src ? html`<span> · ${src}</span>` : nothing}</div>
    ${m.pending ? html`<p class="lmx-chat-wait" role="status"><span class="lm-orb" data-state="working" aria-hidden="true"></span><span>Reading this space…</span></p>` : html`<p class=${m.failed ? 'lmx-chat-text lmx-chat-err' : 'lmx-chat-text'} role=${m.failed ? 'alert' : nothing}>${m.text}</p>`}
    ${m.action ? html`<div class="lmx-chat-approve">
      <div class="lmx-chat-approve-head"><span class="lm-orb" data-state="waiting" aria-hidden="true"></span><strong>Needs your approval: ${m.action.label}</strong></div>
      <p>${m.action.detail}</p>
      <p class="lmx-chat-meta">Cannot be undone. Nothing runs until you approve.</p>
      ${m.action.state === 'pending'
        ? html`<div class="lmx-chat-btns"><button type="button" class="lmx-chat-decide" @click=${() => settle(m.id, 'approved')}>Approve</button><button type="button" class="lm-btn lm-btn--secondary" @click=${() => settle(m.id, 'declined')}>Decline</button></div>`
        : html`<p role="status" class="lmx-chat-result">${m.action.state === 'approved' ? 'Approved.' : 'Declined.'} Nothing ran. Chat cannot act yet.</p>`}
    </div>` : nothing}
  </li>`;
}

function onKey(ev) {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(ev.currentTarget.value); }
}

function draw(scroll) {
  const body = html`
    ${head('Chat', 'Ask about this space. Answers come from its memory and are read only. Nothing runs without your approval.')}
    <section class="lmx-chat" aria-label="Chat">
      <ol class="lmx-chat-log" role="log" aria-live="polite" aria-label="Conversation">
        ${msgs.length === 0 ? html`<li class="lmx-chat-empty">
          <p><strong>Try a question.</strong> Anything that cannot be undone waits for your approval.</p>
          <div class="lmx-chat-chips">${SUGGEST.map((s) => html`<button type="button" class="lm-btn lm-btn--secondary" ?disabled=${!state.space} @click=${() => send(s)}>${s}</button>`)}</div>
        </li>` : msgs.map(message)}
      </ol>
      <form class="lmx-chat-form" @submit=${(ev) => { ev.preventDefault(); send(ev.currentTarget.elements.message.value); }}>
        <label class="lmx-chat-sr" for="chat-message">Message</label>
        <textarea id="chat-message" name="message" class="lm-input" rows="2" maxlength=${MAX_CHARS} placeholder="Ask about your inbox, jobs or agents" .value=${live(draft)} @input=${(ev) => { draft = ev.currentTarget.value; }} @keydown=${onKey} ?disabled=${!state.space}></textarea>
        <button type="submit" class="lm-btn lm-btn--primary" ?disabled=${busy || !state.space}>${busy ? 'Reading…' : 'Send'}</button>
      </form>
    </section>`;
  renderView('chat', ['Chat'], body);
  if (scroll) requestAnimationFrame(() => document.querySelector('.lmx-chat-log > li:last-child')?.scrollIntoView({ block: 'nearest' }));
}

export function registerChat(pages) {
  pages.chat = async () => {
    if (forSpace !== state.space) { msgs = []; forSpace = state.space; }
    draw();
    return true;
  };
}
