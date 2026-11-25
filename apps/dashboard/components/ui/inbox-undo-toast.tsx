'use client';

// Adapted from 21st.dev component 35702 (sltowl — Undo Feedback),
// restyled strictly to LogMem semantic var(--*) tokens (zero raw hex).
import * as React from 'react';
import { CheckCircle2, RotateCcw, X } from 'lucide-react';

export interface InboxUndoToastProps {
  open: boolean;
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  status?: 'pending' | 'restored' | 'error';
}

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

export function InboxUndoToast({
  open,
  message,
  onUndo,
  onDismiss,
  status = 'pending',
}: InboxUndoToastProps) {
  if (!open) return null;

  const isError = status === 'error';
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-5 right-5 z-50 flex max-w-[min(420px,calc(100vw-2rem))] items-center gap-3 rounded-[var(--radius-md)] border px-3.5 py-2.5 text-sm shadow-[var(--shadow-3)] ${
        isError
          ? 'border-[var(--danger)] bg-[var(--danger-subtle)] text-[var(--danger)]'
          : 'border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text)]'
      }`}
    >
      <CheckCircle2
        className={`h-4 w-4 shrink-0 ${isError ? 'text-[var(--danger)]' : 'text-[var(--success)]'}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 font-medium">{message}</span>
      {status === 'pending' && (
        <button
          type="button"
          onClick={onUndo}
          className={`inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 text-xs font-semibold text-[var(--text)] hover:border-[var(--border-strong)] ${FOCUS}`}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Undo
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)] ${FOCUS}`}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
