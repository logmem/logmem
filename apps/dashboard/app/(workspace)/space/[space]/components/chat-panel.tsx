'use client';

import { useRef, useState } from 'react';

type Act = { id: string; label: string; detail: string; state: 'pending' | 'approved' | 'declined' };
type Msg = { id: number; role: 'user' | 'assistant'; text: string; actions: Act[] };

const SUGGEST = ['What needs me?', 'What is blocked?', 'What happened recently?'];
const line = 'border-[#D3DAD8] dark:border-[#2B3835]';
const muted = 'text-[#46534F] dark:text-[#B3BEBA]';
const panel = `rounded border ${line} bg-white dark:bg-[#121A19]`;
const btn = 'min-h-[44px] rounded px-4 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0E6863]';

export function ChatPanel({ space }: { space: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const seq = useRef(0);

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
      if (!res.ok || !res.body || !res.headers.get('content-type')?.includes('ndjson')) throw new Error('bad_response');
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
          if (c.t === 'token') patch((x) => ({ ...x, text: x.text + c.v }));
          if (c.t === 'action') patch((x) => ({ ...x, actions: [...x.actions, { id: c.id, label: c.label, detail: c.detail, state: 'pending' }] }));
        }
      }
    } catch (e) {
      const stopped = (e as Error).name === 'AbortError';
      patch((x) => ({ ...x, text: x.text + (stopped ? ' [stopped]' : 'Chat could not answer. Nothing ran. Reload and try again.') }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  function decide(mid: number, aid: string, verdict: 'approved' | 'declined') {
    setMsgs((m) => m.map((x) => (x.id !== mid ? x : { ...x, actions: x.actions.map((a) => (a.id === aid ? { ...a, state: verdict } : a)) })));
  }

  return (
    <div className={`${panel} flex min-h-[60vh] flex-col`}>
      <div role="log" aria-live="polite" aria-label="Conversation" className="flex-1 space-y-4 overflow-y-auto p-4">
        {msgs.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm">
              <strong>Ask about this space.</strong> Answers come from its memory and are read only. Anything that cannot be undone waits for your approval.
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGEST.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className={`${btn} border ${line} font-medium`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className="space-y-2">
            <div className={`text-xs font-semibold ${muted}`}>{m.role === 'user' ? 'You' : 'LogMem'}</div>
            <p className="whitespace-pre-wrap text-sm">
              {m.text || (busy && m.role === 'assistant' ? <span aria-label="Thinking">…</span> : null)}
            </p>
            {m.actions.map((a) => (
              <div key={a.id} className={`rounded border-2 border-[#B2410E] p-3 text-sm`}>
                <div className="font-semibold">Needs your approval: {a.label}</div>
                <p className="mt-1">{a.detail}</p>
                <p className={`mt-1 text-xs ${muted}`}>Cannot be undone. Nothing runs until you approve.</p>
                {a.state === 'pending' ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => decide(m.id, a.id, 'approved')} className={`${btn} bg-[#0E6863] text-white`}>Approve</button>
                    <button type="button" onClick={() => decide(m.id, a.id, 'declined')} className={`${btn} border ${line}`}>Decline</button>
                  </div>
                ) : (
                  <p className="mt-2 font-medium">
                    {a.state === 'approved' ? 'Approved.' : 'Declined.'} Nothing ran. Chat cannot act yet.
                  </p>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <form
        className={`flex items-end gap-2 border-t ${line} p-3`}
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <label htmlFor="chat-in" className="sr-only">Message</label>
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
          className={`min-h-[44px] flex-1 resize-none rounded border ${line} bg-transparent p-2 text-base md:text-sm`}
        />
        {busy ? (
          <button type="button" onClick={() => abort.current?.abort()} className={`${btn} border ${line}`}>Stop</button>
        ) : (
          <button type="submit" disabled={!input.trim()} className={`${btn} bg-[#0E6863] text-white disabled:opacity-50`}>Send</button>
        )}
      </form>
    </div>
  );
}
