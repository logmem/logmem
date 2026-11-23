'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, RefreshCcw, RotateCcw, ThumbsDown, ThumbsUp } from 'lucide-react';
import {
  Action,
  Actions,
  ChatStateOrb,
  CitedAnswerChatInput,
  CitedSourcesBar,
  GenerationStats,
  IllosAiChatEmptyState,
  Suggestion,
  SuggestionList,
  Suggestions,
  extractLogmemSources,
  type CitedSource,
} from '../../../../../components/ui';

type Act = { id: string; label: string; detail: string; state: 'pending' | 'approved' | 'declined' };
type Msg = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  actions: Act[];
  via?: string;
  failed?: boolean;
  stopped?: boolean;
  ttftMs?: number;
  durationMs?: number;
  feedback?: 'up' | 'down' | null;
  sources?: CitedSource[];
};

const SUGGEST = [
  'What needs me?',
  'What is blocked?',
  'What happened recently?',
  'Which agents are active?',
];

const panel = 'rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]';
const focus =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';
const btn = `inline-flex min-h-[36px] items-center justify-center rounded-[var(--radius-md)] px-3.5 text-xs font-semibold transition-colors ${focus}`;
const quiet = `${btn} border border-[var(--border)] bg-[var(--surface)] font-medium text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-sunken)]`;
const decide = `${btn} bg-[var(--decision)] text-[var(--text-inverse)] hover:opacity-90`;

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function ChatPanel({ space }: { space: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (msgs.length) end.current?.scrollIntoView({ block: 'nearest' });
  }, [msgs]);

  async function send(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    const startedAt = performance.now();
    let firstTokenAt: number | null = null;
    const user: Msg = { id: ++seq.current, role: 'user', text, actions: [] };
    const bot: Msg = { id: ++seq.current, role: 'assistant', text: '', actions: [] };
    const history = [...msgs, user].map(({ role, text: t }) => ({ role, text: t }));
    setMsgs((m) => [...m, user, bot]);
    setInput('');
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    const patch = (f: (x: Msg) => Msg) => setMsgs((m) => m.map((x) => (x.id === bot.id ? f(x) : x)));
    let accText = '';
    try {
      const res = await fetch(`/api/space/${encodeURIComponent(space)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ history }),
        signal: ac.signal,
      });
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
              via: c.provider === 'model' ? String(c.model || 'model') : c.provider === 'rules' ? 'space data' : undefined,
            }));
          }
          if (c.t === 'token') {
            if (firstTokenAt === null) firstTokenAt = performance.now();
            accText += c.v;
            const ttftMs = firstTokenAt - startedAt;
            patch((x) => ({ ...x, text: x.text + c.v, ttftMs }));
          }
          if (c.t === 'action') {
            patch((x) => ({
              ...x,
              actions: [...x.actions, { id: c.id, label: c.label, detail: c.detail, state: 'pending' }],
            }));
          }
        }
      }
      const durationMs = performance.now() - startedAt;
      const sources = extractLogmemSources(accText, space);
      patch((x) => ({ ...x, durationMs, sources }));
    } catch (e) {
      const stopped = (e as Error).name === 'AbortError';
      const durationMs = performance.now() - startedAt;
      patch((x) => ({
        ...x,
        failed: !stopped,
        stopped,
        durationMs,
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

  function copyMessage(m: Msg) {
    if (!m.text) return;
    navigator.clipboard?.writeText(m.text).catch(() => {});
    setCopiedId(m.id);
    window.setTimeout(() => setCopiedId((cur) => (cur === m.id ? null : cur)), 1600);
  }

  function retryFrom(assistantId: number) {
    if (busy) return;
    const idx = msgs.findIndex((m) => m.id === assistantId);
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'user') {
        send(msgs[i].text);
        return;
      }
    }
  }

  function toggleFeedback(mid: number, next: 'up' | 'down') {
    setMsgs((m) =>
      m.map((x) => (x.id === mid ? { ...x, feedback: x.feedback === next ? null : next } : x)),
    );
  }

  const lastBotId = [...msgs].reverse().find((m) => m.role === 'assistant')?.id;

  return (
    <div className={`${panel} flex min-h-[68vh] flex-col overflow-hidden`}>
      {msgs.length > 0 ? (
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-2 text-xs">
          <span className="font-mono text-[var(--text-subtle)]">
            space:{space} · {msgs.filter((m) => m.role === 'user').length}{' '}
            {msgs.filter((m) => m.role === 'user').length === 1 ? 'turn' : 'turns'}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => setMsgs([])}
            className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] disabled:opacity-45"
          >
            <RotateCcw aria-hidden="true" className="size-3" />
            New chat
          </button>
        </div>
      ) : null}

      <div
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        className="flex flex-1 flex-col gap-5 overflow-y-auto p-5"
      >
        {msgs.length === 0 ? (
          <IllosAiChatEmptyState suggestions={SUGGEST} onSelectSuggestion={send} disabled={busy} />
        ) : (
          msgs.map((m) => {
            const isStreaming = busy && m.id === lastBotId && m.role === 'assistant';
            if (m.role === 'user') {
              return (
                <div key={m.id} className="ml-auto max-w-[82%]">
                  <div className="rounded-[var(--radius-lg)] rounded-br-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-2.5 text-sm leading-relaxed text-[var(--text)]">
                    <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  </div>
                </div>
              );
            }

            return (
              <div key={m.id} className="max-w-[68ch] space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-muted)]">
                  <span>LogMem</span>
                  {m.via ? <span className="font-mono font-normal text-[var(--text-subtle)]">· {m.via}</span> : null}
                </div>

                {m.text ? (
                  <p
                    role={m.failed ? 'alert' : undefined}
                    className={`whitespace-pre-wrap break-words text-sm leading-6 ${
                      m.failed ? 'text-[var(--danger)]' : 'text-[var(--text)]'
                    }`}
                  >
                    {m.text}
                  </p>
                ) : isStreaming ? (
                  <ChatStateOrb state="working" label="Reading space memory…" />
                ) : null}

                {m.sources && m.sources.length > 0 ? (
                  <CitedSourcesBar
                    sources={m.sources}
                    activeSource={activeSource}
                    onActiveSourceChange={setActiveSource}
                  />
                ) : null}

                {m.actions.map((a) => (
                  <div
                    key={a.id}
                    className="mt-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3.5 text-sm"
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
                      <p role="status" className="mt-2 font-mono text-xs text-[var(--text-muted)]">
                        {a.state === 'approved' ? 'Approved.' : 'Declined.'} Nothing ran. Chat cannot act yet.
                      </p>
                    )}
                  </div>
                ))}

                {(m.text || isStreaming) ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <GenerationStats
                      live={isStreaming}
                      model={m.via}
                      ttftMs={m.ttftMs}
                      durationMs={m.durationMs}
                      wordCount={countWords(m.text)}
                      finishReason={
                        isStreaming
                          ? undefined
                          : m.failed
                            ? 'error'
                            : m.stopped
                              ? 'stopped'
                              : 'stop'
                      }
                    />
                    {!isStreaming && m.text ? (
                      <Actions>
                        <Action label={copiedId === m.id ? 'Copied' : 'Copy'} active={copiedId === m.id} onClick={() => copyMessage(m)}>
                          {copiedId === m.id ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
                          <span>{copiedId === m.id ? 'Copied' : 'Copy'}</span>
                        </Action>
                        <Action label="Retry" onClick={() => retryFrom(m.id)}>
                          <RefreshCcw aria-hidden="true" className="size-3.5" />
                        </Action>
                        <Action label="Helpful" active={m.feedback === 'up'} onClick={() => toggleFeedback(m.id, 'up')}>
                          <ThumbsUp aria-hidden="true" className="size-3.5" />
                        </Action>
                        <Action label="Not helpful" active={m.feedback === 'down'} onClick={() => toggleFeedback(m.id, 'down')}>
                          <ThumbsDown aria-hidden="true" className="size-3.5" />
                        </Action>
                      </Actions>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
        <div ref={end} />
      </div>

      <div className="space-y-2.5 border-t border-[var(--border)] bg-[var(--surface-sunken)] p-4">
        {msgs.length > 0 && !busy ? (
          <Suggestions onSelect={send}>
            <SuggestionList>
              {SUGGEST.slice(0, 3).map((s) => (
                <Suggestion key={s} value={s} variant="outline">
                  {s}
                </Suggestion>
              ))}
            </SuggestionList>
          </Suggestions>
        ) : null}
        <CitedAnswerChatInput
          value={input}
          onValueChange={setInput}
          onSubmit={send}
          onStop={() => abort.current?.abort()}
          busy={busy}
          placeholder={msgs.length === 0 ? 'Ask about your inbox, jobs, or agents…' : 'Ask a follow-up…'}
        />
      </div>
    </div>
  );
}
