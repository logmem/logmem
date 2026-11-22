'use client';

import Link from 'next/link';
import { useState } from 'react';
import { X } from 'lucide-react';

export function StatusStrip({
  message,
  tone = 'warning',
  href,
  actionLabel = 'View',
  dismissible = true,
  storageKey,
}: {
  message: string;
  tone?: 'warning' | 'info' | 'danger' | 'success';
  href?: string;
  actionLabel?: string;
  dismissible?: boolean;
  storageKey?: string;
}) {
  const [dismissed, setDismissed] = useState(() => {
    if (!storageKey || typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  function dismiss() {
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, '1');
      } catch {
        // Storage blocked: dismiss for current render only.
      }
    }
    setDismissed(true);
  }

  return (
    <div
      className="lm-status-strip"
      data-tone={tone}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <span className="lm-status-strip-text">{message}</span>
      <div className="lm-status-strip-actions">
        {href ? (
          <Link href={href} className="lm-status-strip-btn">
            {actionLabel}
          </Link>
        ) : null}
        {dismissible ? (
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss notice"
            className="lm-status-strip-btn"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
