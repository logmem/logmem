'use client';

// Adapted from 21st.dev components 43819 (flohoeller/decision-inbox),
// 36498 (syeddhasnainn/approval-card), and 23792 (educalvolpz/ai-approval),
// restyled strictly to LogMem semantic var(--*) tokens (zero raw hex).
import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Check,
  CircleHelp,
  Copy,
  MessageSquare,
} from 'lucide-react';

export interface DecisionTrayItem {
  trail: string;
  summary: string;
  byLabel: string;
  ageLabel: string;
  whereLabel?: string;
  action?: string;
  irreversible: boolean;
  deferred?: boolean;
}

export interface DecisionApprovalTrayProps {
  items: DecisionTrayItem[];
  totalCount: number;
  showAll: boolean;
  onToggleShowAll: () => void;
  boardHref: string;
  commentHref: string;
  onCopyAction?: (action: string) => void;
  onAction?: (item: DecisionTrayItem, verdict: 'approve' | 'reject' | 'defer', note: string) => void;
}

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

export function DecisionApprovalTray({
  items,
  totalCount,
  showAll,
  onToggleShowAll,
  boardHref,
  commentHref,
  onCopyAction,
  onAction,
}: DecisionApprovalTrayProps) {
  const [unfolded, setUnfolded] = React.useState<Set<string>>(new Set());
  const [expandedAction, setExpandedAction] = React.useState<Set<string>>(new Set());
  const [noteMode, setNoteMode] = React.useState<Record<string, '' | 'changes' | 'note'>>({});
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [resolved, setResolved] = React.useState<Record<string, { label: string; tone: 'decision' | 'danger' | 'neutral' }>>({});
  const [feedback, setFeedback] = React.useState<Record<string, string>>({});

  const hasIrreversible = items.some((i) => i.irreversible);

  const toggleAction = (trail: string) =>
    setExpandedAction((prev) => {
      const next = new Set(prev);
      next.has(trail) ? next.delete(trail) : next.add(trail);
      return next;
    });

  const handleVerdict = (item: DecisionTrayItem, verdict: 'approve' | 'reject' | 'defer') => {
    const note = (notes[item.trail] || '').trim();
    if (verdict === 'reject' && !note) {
      setNoteMode((prev) => ({ ...prev, [item.trail]: 'changes' }));
      setFeedback((prev) => ({ ...prev, [item.trail]: 'Add a short note explaining what should change.' }));
      return;
    }
    setFeedback((prev) => ({ ...prev, [item.trail]: '' }));
    setNoteMode((prev) => ({ ...prev, [item.trail]: '' }));
    setResolved((prev) => ({
      ...prev,
      [item.trail]:
        verdict === 'approve'
          ? { label: 'Approved in session', tone: 'decision' }
          : verdict === 'reject'
            ? { label: 'Changes requested', tone: 'danger' }
            : { label: 'Deferred for later', tone: 'neutral' },
    }));
    onAction?.(item, verdict, note);
  };

  return (
    <div className="space-y-1.5 rounded-[16px] border border-[var(--border)] bg-[var(--surface-sunken)] p-1.5">
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-2 w-2 shrink-0 rounded-full ${
              hasIrreversible ? 'bg-[var(--danger)]' : 'bg-[var(--decision)]'
            }`}
          />
          <h2 id="inbox-decisions-h" className="font-heading text-[15px] font-semibold text-[var(--text)]">
            Decisions
          </h2>
          <span className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-full bg-[var(--decision-subtle)] px-2 font-mono text-xs font-semibold tabular-nums text-[var(--decision)]">
            {totalCount}
          </span>
          <span className="text-xs font-medium text-[var(--text-muted)]">
            {totalCount === 1 ? '1 needs your input' : `${totalCount} need your input`}
            {hasIrreversible ? ' · irreversible first' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {totalCount > 3 && (
            <button
              type="button"
              onClick={onToggleShowAll}
              className={`rounded-[var(--radius-sm)] px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)] ${FOCUS}`}
            >
              {showAll ? 'Show top 3' : `See all ${totalCount}`}
            </button>
          )}
          <Link
            href={boardHref}
            className={`rounded-[var(--radius-sm)] px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)] ${FOCUS}`}
          >
            Brief view
          </Link>
        </div>
      </header>

      <div className="divide-y divide-[var(--border)] overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-1)]">
        {items.map((item, idx) => {
          const isFolded = idx >= 2 && !unfolded.has(item.trail);
          const mode = noteMode[item.trail] || '';
          const isActionExpanded = expandedAction.has(item.trail);
          const actionText = (item.action || '').trim();
          const firstLine = actionText.split(/\r?\n/)[0] || '';
          const actionLong = actionText.includes('\n') || actionText.length > 88;
          const settled = resolved[item.trail];

          return (
            <article
              key={item.trail}
              data-cockpit-item="true"
              className={`p-4 transition-colors motion-reduce:transition-none data-[kb-active=true]:bg-[var(--brand-subtle)] data-[kb-active=true]:outline data-[kb-active=true]:outline-2 data-[kb-active=true]:outline-[var(--focus)] ${
                isFolded ? 'py-3' : ''
              }`}
            >
              <div className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-3">
                <span
                  aria-hidden="true"
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${
                    item.irreversible
                      ? 'bg-[var(--danger-subtle)] text-[var(--danger)]'
                      : 'bg-[var(--decision-subtle)] text-[var(--decision)]'
                  }`}
                >
                  {item.irreversible ? (
                    <AlertTriangle className="h-4 w-4" />
                  ) : (
                    <CircleHelp className="h-4 w-4" />
                  )}
                </span>

                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    {isFolded ? (
                      <button
                        type="button"
                        onClick={() => setUnfolded((s) => new Set(s).add(item.trail))}
                        className={`flex-1 text-left text-[15px] font-medium leading-snug text-[var(--text-muted)] hover:text-[var(--text)] break-words ${FOCUS}`}
                      >
                        {item.summary}
                      </button>
                    ) : (
                      <p className="flex-1 text-[15px] font-medium leading-snug tracking-[-0.01em] text-[var(--text)] break-words">
                        {item.summary}
                      </p>
                    )}

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          item.irreversible
                            ? 'bg-[var(--danger-subtle)] text-[var(--danger)]'
                            : 'bg-[var(--surface-sunken)] text-[var(--text-muted)]'
                        }`}
                      >
                        {item.irreversible ? 'Irreversible' : 'Reversible'}
                      </span>
                      {item.deferred && (
                        <span className="rounded-full bg-[var(--warning-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--warning)]">
                          Deferred
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                    <span className="font-medium text-[var(--text)]">{item.byLabel}</span>
                    <span>·</span>
                    <span className="font-mono tabular-nums">{item.ageLabel}</span>
                    {item.whereLabel && (
                      <span className="rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-muted)] break-all">
                        {item.whereLabel}
                      </span>
                    )}
                    {isFolded && (
                      <button
                        type="button"
                        onClick={() => setUnfolded((s) => new Set(s).add(item.trail))}
                        className={`ml-auto text-xs font-medium text-[var(--link)] underline ${FOCUS}`}
                      >
                        Review
                      </button>
                    )}
                  </div>

                  {!isFolded && (
                    <div className="space-y-2.5 pt-0.5">
                      {actionText && (
                        <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface-sunken)]">
                          <div className="flex items-center gap-2 px-2.5 py-1.5">
                            <span className="shrink-0 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                              Action
                            </span>
                            <code
                              title={actionText}
                              className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text)]"
                            >
                              {firstLine}
                            </code>
                            <div className="flex shrink-0 items-center gap-1">
                              {actionLong && (
                                <button
                                  type="button"
                                  aria-expanded={isActionExpanded}
                                  onClick={() => toggleAction(item.trail)}
                                  className={`rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] font-medium text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] ${FOCUS}`}
                                >
                                  {isActionExpanded ? 'Hide' : 'Details'}
                                </button>
                              )}
                              {onCopyAction && (
                                <button
                                  type="button"
                                  onClick={() => onCopyAction(actionText)}
                                  aria-label="Copy proposed action"
                                  className={`inline-flex items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] font-medium text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] ${FOCUS}`}
                                >
                                  <Copy className="h-3 w-3" aria-hidden="true" />
                                  Copy
                                </button>
                              )}
                            </div>
                          </div>
                          {isActionExpanded && (
                            <pre className="max-h-48 overflow-y-auto border-t border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-xs leading-relaxed text-[var(--text)] whitespace-pre-wrap break-words">
                              {actionText}
                            </pre>
                          )}
                        </div>
                      )}

                      {settled ? (
                        <div
                          role="status"
                          className={`flex items-center gap-2 rounded-[9px] px-3 py-2 text-xs font-medium ${
                            settled.tone === 'decision'
                              ? 'bg-[var(--decision-subtle)] text-[var(--decision)]'
                              : settled.tone === 'danger'
                                ? 'bg-[var(--danger-subtle)] text-[var(--danger)]'
                                : 'bg-[var(--surface-sunken)] text-[var(--text-muted)]'
                          }`}
                        >
                          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>{settled.label}</span>
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              data-kb-primary="true"
                              onClick={() => handleVerdict(item, 'approve')}
                              className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-[9px] bg-[var(--decision)] px-3.5 text-xs font-semibold text-[var(--text-inverse)] shadow-[var(--shadow-1)] hover:opacity-90 ${FOCUS}`}
                            >
                              <Check className="h-3.5 w-3.5" aria-hidden="true" />
                              Approve
                            </button>
                            <button
                              type="button"
                              aria-expanded={mode === 'changes'}
                              onClick={() => {
                                if ((notes[item.trail] || '').trim()) {
                                  handleVerdict(item, 'reject');
                                } else {
                                  setNoteMode((prev) => ({ ...prev, [item.trail]: 'changes' }));
                                }
                              }}
                              className={`inline-flex min-h-[34px] items-center rounded-[9px] border border-[var(--danger-subtle)] bg-[var(--danger-subtle)] px-3 text-xs font-medium text-[var(--danger)] hover:border-[var(--danger)] ${FOCUS}`}
                            >
                              Request changes
                            </button>
                            {!item.deferred && (
                              <button
                                type="button"
                                onClick={() => handleVerdict(item, 'defer')}
                                className={`inline-flex min-h-[34px] items-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-medium text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)] ${FOCUS}`}
                              >
                                Decide later
                              </button>
                            )}
                            <span className="flex-1" />
                            <button
                              type="button"
                              aria-expanded={Boolean(mode)}
                              onClick={() =>
                                setNoteMode((prev) => ({
                                  ...prev,
                                  [item.trail]: prev[item.trail] ? '' : 'note',
                                }))
                              }
                              className={`rounded-[7px] px-2 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)] ${FOCUS}`}
                            >
                              {mode ? 'Hide note' : '+ Note'}
                            </button>
                            <Link
                              data-kb-comment="true"
                              href={commentHref}
                              className={`inline-flex items-center gap-1 rounded-[7px] px-2 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)] ${FOCUS}`}
                            >
                              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                              Comment
                            </Link>
                          </div>

                          {feedback[item.trail] && (
                            <p role="status" className="text-xs font-medium text-[var(--danger)]">
                              {feedback[item.trail]}
                            </p>
                          )}

                          {mode && (
                            <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--border)] pt-2">
                              <input
                                type="text"
                                autoFocus
                                value={notes[item.trail] || ''}
                                onChange={(e) =>
                                  setNotes((prev) => ({ ...prev, [item.trail]: e.target.value }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && mode === 'changes') {
                                    e.preventDefault();
                                    handleVerdict(item, 'reject');
                                  } else if (e.key === 'Escape') {
                                    setNoteMode((prev) => ({ ...prev, [item.trail]: '' }));
                                  }
                                }}
                                placeholder={
                                  mode === 'changes'
                                    ? 'Explain what should change (required)…'
                                    : 'Add an optional note for the agent…'
                                }
                                aria-label="Note for decision"
                                className={`min-h-[36px] min-w-[200px] flex-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)] placeholder:text-[var(--text-subtle)] ${FOCUS}`}
                              />
                              {mode === 'changes' && (
                                <button
                                  type="button"
                                  onClick={() => handleVerdict(item, 'reject')}
                                  className={`inline-flex min-h-[36px] items-center rounded-[9px] bg-[var(--danger)] px-3 text-xs font-semibold text-[var(--text-inverse)] hover:opacity-90 ${FOCUS}`}
                                >
                                  Send changes
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => setNoteMode((prev) => ({ ...prev, [item.trail]: '' }))}
                                className={`inline-flex min-h-[36px] items-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] ${FOCUS}`}
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
