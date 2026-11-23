'use client';

import { useEffect, useRef, useState } from 'react';
import { ChatStateOrb } from '../../../../../components/ui';

type Act = { id: string; label: string; detail: string; state: 'pending' | 'approved' | 'declined' };
type Msg = { id: number; role: 'user' | 'assistant'; text: string; actions: Act[]; via?: string; failed?: boolean };

const SUGGEST = ['What needs me?', 'What is blocked?', 'What happened recently?'];

const panel = 'rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]';
const focus =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';
const btn = `inline-flex min-h-[44px] items-center justify-center rounded-[var(--radius-md)] px-4 text-sm font-semibold transition-colors ${focus}`;
const quiet = `${btn} border border-[var(--border)] bg-[var(--surface)] font-medium text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-sunken)]`;
const primary = `${btn} bg-[var(--brand)] text-[var(--on-brand)] hover:bg-[var(--brand-hover)] disabled:cursor-not-allowed disabled:opacity-50`;
const decide = `${btn} bg-[var(--decision)] text-[var(--text-inverse)] hover:opacity-90`;

export function ChatPanel({ space }: { space: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (msgs.length) end.current?.scrollIntoView({ block: 'nearest' });
  }, [msgs]);

  async function send(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    const user: Msg = { id: ++seq.current, role: 'user', text, actions: [] };
    const bot: Msg = { id: ++seq.current, role: 'assistant', text: '', actions: [] };
    const history = [...msgs, user].map(({ role, text: t }) => ({ role, text: t }));
    setMsgs((m) => [...m, user, bot]);
    setInput('');
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    const patch = (f: (x: Msg) => Msg) => setMsgs((m) => m.map((x) => (x.id === bot.id ? f(x) : x)));
    try {
      const res = await fetch(`/api/space/${encodeURIComponent(space)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ history }),
        signal: ac.signal,
      });
      // A redirect to sign-in comes back as HTML, not NDJSON.
      if (!res.ok || !res.body || !res.headers.get('content-type')?.includes('ndjson')) {
        throw new Error('bad_response');
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const row = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!row) continue;
          const c = JSON.parse(row);
          if (c.t === 'meta') {
            patch((x) => ({
              ...x,
              via: c.provider === 'model' ? `model ${c.model}` : c.provider === 'rules' ? 'space data' : undefined,
            }));
          }
          if (c.t === 'token') patch((x) => ({ ...x, text: x.text + c.v }));
          if (c.t === 'action') {
            patch((x) => ({
              ...x,
              actions: [...x.actions, { id: c.id, label: c.label, detail: c.detail, state: 'pending' }],
            }));
          }
        }
      }
    } catch (e) {
      const stopped = (e as Error).name === 'AbortError';
      patch((x) => ({
        ...x,
        failed: !stopped,
        text: x.text + (stopped ? ' [stopped]' : 'Chat could not answer. Nothing ran. Reload the page and try again.'),
      }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  function settle(mid: number, aid: string, verdict: 'approved' | 'declined') {
    setMsgs((m) =>
      m.map((x) =>
        x.id !== mid
          ? x
          : { ...x, actions: x.actions.map((a) => (a.id === aid ? { ...a, state: verdict } : a)) },
      ),
    );
  }

  return (
    <div className={`${panel} flex min-h-[60vh] flex-col`}>
      <div role="log" aria-live="polite" aria-label="Conversation" className="flex-1 space-y-5 overflow-y-auto p-4">
        {msgs.length === 0 && (
          <div className="max-w-prose space-y-3">
            <p className="text-sm text-[var(--text)]">
              <strong className="font-semibold">Ask about this space.</strong> Answers come from its memory and are
              read only. Anything that cannot be undone waits for your approval.
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGEST.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className={quiet}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className="max-w-prose space-y-1.5">
            <div className="text-xs font-semibold text-[var(--text-muted)]">
              {m.role === 'user' ? 'You' : 'LogMem'}
              {m.via ? <span className="font-normal"> · from {m.via}</span> : null}
            </div>
            {m.text ? (
              <p
                role={m.failed ? 'alert' : undefined}
                className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${
                  m.failed ? 'text-[var(--danger)]' : 'text-[var(--text)]'
                }`}
              >
                {m.text}
              </p>
            ) : busy && m.role === 'assistant' ? (
              <ChatStateOrb state="working" label="Reading this space…" />
            ) : null}
            {m.actions.map((a) => (
              <div
                key={a.id}
                className="mt-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3 text-sm"
              >
                <div className="flex items-center gap-2 font-semibold text-[var(--decision)]">
                  <span className="lm-orb" data-state="waiting" aria-hidden="true" />
                  <span>Needs your approval: {a.label}</span>
                </div>
                <p className="mt-1 break-words text-[var(--text)]">{a.detail}</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Cannot be undone. Nothing runs until you approve.
                </p>
                {a.state === 'pending' ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => settle(m.id, a.id, 'approved')} className={decide}>
                      Approve
                    </button>
                    <button type="button" onClick={() => settle(m.id, a.id, 'declined')} className={quiet}>
                      Decline
                    </button>
                  </div>
                ) : (
                  <p role="status" className="mt-2 font-medium text-[var(--text)]">
                    {a.state === 'approved' ? 'Approved.' : 'Declined.'} Nothing ran. Chat cannot act yet.
                  </p>
                )}
              </div>
            ))}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="flex items-end gap-2 border-t border-[var(--border)] p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <label htmlFor="chat-in" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-in"
          rows={2}
          value={input}
          maxLength={2000}
          placeholder="Ask about your inbox, jobs or agents"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          className={`min-h-[44px] flex-1 resize-none rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-2.5 text-base text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:border-[var(--brand)] md:text-sm ${focus}`}
        />
        {busy ? (
          <button type="button" onClick={() => abort.current?.abort()} className={quiet}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()} className={primary}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
