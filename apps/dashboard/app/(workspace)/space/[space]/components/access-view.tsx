'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { ConnectSnippet } from '../../../../../lib/server/access';

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

export function ConnectSnippetPanel({ snippets }: { snippets: ConnectSnippet[] }) {
  const [activeId, setActiveId] = useState(snippets[0]?.id || 'claude-code');
  const [copied, setCopied] = useState(false);

  const current = snippets.find((s) => s.id === activeId) || snippets[0];
  if (!current) return null;

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(current.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked.
    }
  }

  return (
    <section
      aria-labelledby="connect-snippet-h"
      className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="connect-snippet-h" className="font-heading text-base font-semibold text-[var(--text)]">
          Connect an agent
        </h2>
        <div role="tablist" aria-label="Agent clients" className="flex flex-wrap gap-1.5">
          {snippets.map((s) => {
            const active = s.id === current.id;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setActiveId(s.id);
                  setCopied(false);
                }}
                className={`min-h-[36px] rounded-[var(--radius-pill)] border px-3 text-xs font-medium transition-colors ${FOCUS} ${
                  active
                    ? 'border-[var(--brand)] bg-[var(--brand-subtle)] font-semibold text-[var(--brand)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <pre className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3 font-mono text-xs leading-relaxed text-[var(--text)]">
        <code>{current.command}</code>
      </pre>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--text-muted)]">{current.note}</p>
        <button
          type="button"
          onClick={onCopy}
          className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-sunken)] ${FOCUS}`}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-[var(--success)]" aria-hidden="true" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Copy snippet</span>
            </>
          )}
        </button>
      </div>
    </section>
  );
}
