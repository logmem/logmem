'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function truncateId(id: string, max = 16): string {
  const s = String(id || '').trim();
  if (s.length <= max) return s;
  const head = Math.max(4, Math.floor((max - 1) * 0.6));
  const tail = Math.max(3, max - 1 - head);
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function CopyId({ id, label }: { id: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked in non-secure context.
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? `Copied ${id}` : `Copy ${id}`}
      aria-label={label || `Copy ID ${id}`}
      className={`lm-copy-id${copied ? ' is-copied' : ''}`}
    >
      <span>{copied ? 'Copied' : truncateId(id)}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
      ) : (
        <Copy className="h-3 w-3 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}
