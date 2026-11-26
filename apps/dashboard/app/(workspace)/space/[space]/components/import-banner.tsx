'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { importBannerDismissKey } from '../../../../../lib/portability-model.mjs';

export interface ImportReceipt {
  sourceSpace?: string;
  sourceSpaceName?: string;
  mode?: string;
  checksum?: string;
  agentCount?: number;
  traceCount?: number;
}

export function ImportBanner({
  space,
  receipt,
}: {
  space: string;
  receipt: ImportReceipt | null | undefined;
}) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (!receipt?.checksum) {
      setDismissed(true);
      return;
    }
    try {
      const key = importBannerDismissKey(space, receipt.checksum);
      setDismissed(localStorage.getItem(key) === '1');
    } catch {
      setDismissed(false);
    }
  }, [space, receipt?.checksum]);

  if (!receipt?.checksum || dismissed) return null;

  function onDismiss() {
    try {
      localStorage.setItem(importBannerDismissKey(space, receipt!.checksum!), '1');
    } catch {
      // ignore
    }
    setDismissed(true);
  }

  return (
    <section
      role="status"
      aria-label="Imported space setup"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--brand)] bg-[var(--brand-subtle)] px-4 py-3 text-xs text-[var(--text)]"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-semibold">
          Imported {receipt.agentCount || 0} agents
          {receipt.traceCount ? ` & ${receipt.traceCount.toLocaleString()} traces` : ''} from{' '}
          {receipt.sourceSpaceName || receipt.sourceSpace || 'bundle'}.
        </p>
        <p className="text-[var(--text-muted)]">
          Agent keys were not transferred for security — all agents are ready to connect once you mint workspace keys.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/space/${space}/access`}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--brand)] px-3 py-1.5 text-xs font-semibold text-[var(--surface)] transition-opacity hover:opacity-90"
        >
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Open Agent access</span>
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss import banner"
          className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
