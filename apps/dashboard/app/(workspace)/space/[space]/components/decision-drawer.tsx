'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { CopyId } from '../../../../../components/ui';

export interface DecisionItem {
  trail: string;
  summary: string;
  requester: string;
  action: string;
  deadline: string;
  diffPayload?: string;
  reversible: boolean;
}

interface DecisionDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  decision: DecisionItem | null;
}

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

export function DecisionDrawer({ isOpen, onClose, decision }: DecisionDrawerProps) {
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [settledVerdict, setSettledVerdict] = useState<'approved' | 'rejected' | 'deferred' | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen || !decision) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40 font-sans"
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="decision-drawer-title"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-3)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="lm-orb" data-state="waiting" aria-hidden="true" />
            <h2
              id="decision-drawer-title"
              className="font-heading text-sm font-bold text-[var(--text)]"
            >
              Review decision
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close decision review"
            className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text)] ${FOCUS}`}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {settledVerdict ? (
            <div
              role="status"
              className="space-y-2 rounded-[var(--radius-md)] border border-[var(--success)] bg-[var(--success-subtle)] p-4 text-sm text-[var(--success)]"
            >
              <p className="font-semibold">Decision saved. Waiting for agent.</p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                <span>Recorded on trail</span>
                <CopyId id={decision.trail} />
                <span>The requesting agent will verify this verdict on its next shift.</span>
              </div>
            </div>
          ) : (
            <>
              <div>
                <h3 className="font-heading text-lg font-bold text-[var(--text)]">
                  {decision.summary}
                </h3>
                <p className="mt-1 font-mono text-xs text-[var(--text-subtle)]">
                  Requested by <strong className="text-[var(--text)]">{decision.requester}</strong> · Due{' '}
                  {decision.deadline}
                </p>
              </div>

              <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[var(--text-muted)]">Proposed action</span>
                  <span
                    className={`rounded-[var(--radius-pill)] px-2 py-0.5 font-mono text-[11px] font-medium ${
                      decision.reversible
                        ? 'bg-[var(--info-subtle)] text-[var(--info)]'
                        : 'bg-[var(--danger-subtle)] text-[var(--danger)]'
                    }`}
                  >
                    {decision.reversible ? 'Reversible' : 'Irreversible'}
                  </span>
                </div>
                <p className="font-mono text-sm font-medium leading-relaxed text-[var(--text)]">
                  {decision.action}
                </p>
              </div>

              {decision.diffPayload && (
                <div className="space-y-1.5">
                  <span className="text-xs font-semibold text-[var(--text-muted)]">
                    Evidence and payload preview
                  </span>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3 font-mono text-xs text-[var(--text)]">
                    {decision.diffPayload}
                  </pre>
                </div>
              )}

              {showRejectInput && (
                <div className="space-y-2 border-t border-[var(--border)] pt-3">
                  <label
                    htmlFor="decision-reject-reason"
                    className="block text-xs font-medium text-[var(--text-muted)]"
                  >
                    Reason for requesting changes (required)
                  </label>
                  <textarea
                    id="decision-reject-reason"
                    rows={3}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="State what the agent must modify before this action can be approved..."
                    className={`w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:border-[var(--brand)] ${FOCUS}`}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Sticky Footer (NP3: secondary exits on left, violet Approve primary) */}
        {!settledVerdict && (
          <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--surface-sunken)] p-4">
            <button
              type="button"
              onClick={() => setSettledVerdict('deferred')}
              className={`min-h-[44px] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-medium text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] ${FOCUS}`}
            >
              Decide later
            </button>
            <div className="flex flex-wrap items-center gap-2">
              {showRejectInput ? (
                <button
                  type="button"
                  disabled={!rejectReason.trim()}
                  onClick={() => setSettledVerdict('rejected')}
                  className={`min-h-[44px] rounded-[var(--radius-md)] bg-[var(--danger)] px-3 text-xs font-semibold text-[var(--text-inverse)] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`}
                >
                  Confirm changes requested
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowRejectInput(true)}
                  className={`min-h-[44px] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-medium text-[var(--danger)] hover:bg-[var(--danger-subtle)] ${FOCUS}`}
                >
                  Can&apos;t do / request changes
                </button>
              )}
              <button
                type="button"
                onClick={() => setSettledVerdict('approved')}
                className={`min-h-[44px] rounded-[var(--radius-md)] bg-[var(--decision)] px-4 text-xs font-semibold text-[var(--text-inverse)] shadow-[var(--shadow-1)] hover:opacity-90 ${FOCUS}`}
              >
                Approve action
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
