'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, Copy, ExternalLink, X, BellRing, Network } from 'lucide-react';
import {
  buildPrompt, classify, filterItems, handoffMap, paginate, relativeTime, shortName, tabCounts,
} from '../../../../../lib/inbox-model.mjs';
import type { InboxItem } from '../../../../../lib/server/inbox';
import {
  AgeBucketChips, CopyId, PageHeader, StatePanel, StatusStrip,
} from '../../../../../components/ui';

type Tab = 'all' | 'overdue' | 'awaiting';
const PAGE_SIZE = 10;
const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

interface Props {
  space: string;
  items: InboxItem[];
  total: number;
  coverage: string;
  dataErrors: Array<{ type: string; id?: string }>;
  unavailable: boolean;
  now: number;
}

// Fixed zone and locale so the server and the browser print the same text.
const when = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

export function InboxView({ space, items, total, coverage, dataErrors, unavailable, now }: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<InboxItem | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [copied, setCopied] = useState('');

  const counts = useMemo(() => tabCounts(items, now), [items, now]);
  const shown = useMemo(() => filterItems(items, tab, now), [items, tab, now]);
  const pg = useMemo(() => paginate(shown, page, PAGE_SIZE), [shown, page]);
  const map = useMemo(() => handoffMap(items), [items]);

  const bucketOptions = [
    { id: 'all' as Tab, label: 'All', count: counts.all, alwaysEnabled: true },
    { id: 'overdue' as Tab, label: 'Overdue', count: counts.overdue },
    { id: 'awaiting' as Tab, label: 'Awaiting response', count: counts.awaiting },
  ];

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setCopied('Copy blocked by the browser');
    }
    setTimeout(() => setCopied(''), 2500);
  }

  const pageIds = pg.rows.map((r: InboxItem) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id: string) => selected.has(id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const togglePage = () =>
    setSelected((s) => {
      const n = new Set(s);
      allOnPage ? pageIds.forEach((id: string) => n.delete(id)) : pageIds.forEach((id: string) => n.add(id));
      return n;
    });

  return (
    <div className="space-y-4 font-sans text-[var(--text)]">
      <PageHeader
        title="Inbox"
        subtitle={`Open handoffs · oldest first · space:${space}`}
      />

      {unavailable && (
        <StatePanel
          variant="error"
          title="Handoffs could not be read right now."
          detail="This is not an empty inbox. Try again in a minute."
        />
      )}
      {!unavailable && (coverage !== 'full' || dataErrors.length > 0) && (
        <StatusStrip
          tone="warning"
          dismissible={false}
          message={`Partial view: ${coverage !== 'full' ? 'the index is still backfilling, so some handoffs may be missing. ' : ''}${dataErrors.length > 0 ? `${dataErrors.length} record problem${dataErrors.length === 1 ? '' : 's'} reported.` : ''}`}
        />
      )}

      {/* Collapsible handoff map */}
      <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
        <button
          type="button"
          aria-expanded={mapOpen}
          onClick={() => setMapOpen((v) => !v)}
          className={`flex min-h-[44px] w-full items-center justify-between rounded-[var(--radius-md)] px-4 text-left text-sm font-semibold ${FOCUS}`}
        >
          <span className="flex items-center gap-2">
            <Network className="h-4 w-4 text-[var(--brand)]" aria-hidden="true" />
            Handoff map ({items.length} active)
          </span>
          <ChevronDown
            className={`h-4 w-4 text-[var(--text-subtle)] transition-transform ${mapOpen ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
        {mapOpen && (
          <div className="overflow-x-auto border-t border-[var(--border)] p-4">
            {map.senders.length === 0 ? (
              <p className="text-sm text-[var(--text-subtle)]">No handoffs to map.</p>
            ) : (
              <table className="font-mono text-xs">
                <caption className="sr-only">Open handoffs by sender and receiver</caption>
                <thead>
                  <tr>
                    <th className="px-2 py-1 text-left font-normal text-[var(--text-subtle)]">from \ to</th>
                    {map.receivers.map((r: string) => (
                      <th key={r} scope="col" className="px-2 py-1 font-semibold">
                        {r}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {map.senders.map((s: string) => (
                    <tr key={s}>
                      <th scope="row" className="px-2 py-1 text-left font-semibold">
                        {s}
                      </th>
                      {map.receivers.map((r: string) => {
                        const n = map.cells[`${s}>${r}`] || 0;
                        return (
                          <td
                            key={r}
                            className="px-2 py-1 text-center tabular-nums"
                            style={
                              n
                                ? {
                                    backgroundColor: 'var(--brand-subtle)',
                                    color: 'var(--brand)',
                                    fontWeight: 600,
                                  }
                                : undefined
                            }
                          >
                            {n || ''}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      {/* Age bucket chips (empty buckets disabled, never hidden) */}
      <AgeBucketChips
        options={bucketOptions}
        value={tab}
        onChange={(next) => {
          setTab(next);
          setPage(1);
        }}
        ariaLabel="Inbox filters"
      />

      {/* Batch bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--brand)] bg-[var(--brand-subtle)] px-4 py-2 text-sm text-[var(--brand)]">
          <span className="font-medium tabular-nums">{selected.size} selected</span>
          <button
            type="button"
            onClick={() =>
              copy(
                items.filter((i) => selected.has(i.id)).map(buildPrompt).join('\n\n---\n\n'),
                `Copied ${selected.size} prompts`,
              )
            }
            className={`min-h-[36px] rounded-[var(--radius-sm)] px-3 font-semibold text-[var(--brand)] hover:opacity-80 ${FOCUS}`}
          >
            Copy prompts
          </button>
        </div>
      )}

      {/* Rows */}
      <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-1 text-xs text-[var(--text-subtle)]">
          <label className="flex min-h-[44px] items-center">
            <input
              type="checkbox"
              checked={allOnPage}
              onChange={togglePage}
              aria-label="Select all on this page"
              className="h-4 w-4 accent-[var(--brand)]"
            />
          </label>
          <span className="tabular-nums">
            {pg.total === 0 ? 'Nothing here' : `${pg.total} handoff${pg.total === 1 ? '' : 's'}`}
          </span>
        </div>
        {pg.rows.length === 0 && !unavailable && (
          <p className="p-4 text-sm text-[var(--text-muted)]">No handoffs in this view.</p>
        )}
        <ul className="divide-y divide-[var(--border)]">
          {pg.rows.map((r: InboxItem) => {
            const kind = classify(r, now);
            return (
              <li
                key={r.id}
                className="flex items-center gap-3 px-3 transition-colors hover:bg-[var(--surface-sunken)]"
              >
                <label className="flex min-h-[44px] items-center">
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                    aria-label={`Select handoff from ${shortName(r.from)}`}
                    className="h-4 w-4 accent-[var(--brand)]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setOpen(r)}
                  className={`flex min-h-[44px] min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-sm)] text-left text-sm ${FOCUS}`}
                >
                  <span className="w-40 shrink-0 truncate font-semibold text-[var(--text)] sm:w-48">
                    {shortName(r.from)} → {shortName(r.to)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">{r.summary}</span>
                  {kind === 'overdue' && (
                    <span className="hidden shrink-0 rounded-[var(--radius-pill)] bg-[var(--danger-subtle)] px-2 py-0.5 font-mono text-[11px] font-semibold text-[var(--danger)] sm:inline">
                      overdue
                    </span>
                  )}
                  <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-[var(--text-subtle)]">
                    {relativeTime(r.created_at, now)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-3 py-1 text-xs text-[var(--text-subtle)]">
          <span aria-live="polite" className="tabular-nums">
            {pg.from}–{pg.to} of {pg.total}
          </span>
          <button
            type="button"
            aria-label="Previous page"
            disabled={pg.page <= 1}
            onClick={() => setPage(pg.page - 1)}
            className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] disabled:opacity-30 ${FOCUS}`}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next page"
            disabled={pg.page >= pg.pages}
            onClick={() => setPage(pg.page + 1)}
            className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] disabled:opacity-30 ${FOCUS}`}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {total > items.length && (
        <p className="text-xs text-[var(--text-subtle)]">
          Showing the first {items.length} of {total}. Older handoffs are not loaded yet.
        </p>
      )}
      <p role="status" className="min-h-[1rem] text-xs font-medium text-[var(--brand)]">
        {copied}
      </p>

      {open && (
        <Inspector
          item={open}
          space={space}
          now={now}
          onClose={() => setOpen(null)}
          onCopy={(t) => copy(t, 'Prompt copied')}
        />
      )}
    </div>
  );
}

function Inspector({
  item,
  space,
  now,
  onClose,
  onCopy,
}: {
  item: InboxItem;
  space: string;
  now: number;
  onClose: () => void;
  onCopy: (t: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kind = classify(item, now);
  const trail = item.request_trail || item.id;
  const rows: Array<[string, string]> = [
    ['From', shortName(item.from)],
    ['To', shortName(item.to)],
    ['Where', item.where || 'not recorded'],
    ['Created', `${when.format(item.created_at)} ET (${relativeTime(item.created_at, now)})`],
    ['Deadline', `${when.format(item.deadline)} ET${kind === 'overdue' ? ', overdue' : ''}`],
    ['Response', item.response || 'open'],
    ['Source', item.source || 'not recorded'],
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Handoff details"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-3)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3">
          <h2 className="font-heading text-sm font-bold text-[var(--text)]">
            {shortName(item.from)} → {shortName(item.to)}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text)] ${FOCUS}`}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 text-sm">
          <p className="mb-4 whitespace-pre-wrap leading-relaxed text-[var(--text)]">{item.summary}</p>
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2.5 text-xs">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-[var(--text-subtle)]">{k}</dt>
                <dd className="break-all font-mono text-[var(--text)]">{v}</dd>
              </div>
            ))}
            <div className="contents">
              <dt className="text-[var(--text-subtle)]">Trail</dt>
              <dd>
                <CopyId id={trail} label={`Copy trail ${trail}`} />
              </dd>
            </div>
          </dl>
        </div>
        <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-[var(--border)] bg-[var(--surface-sunken)] p-3">
          <button
            type="button"
            onClick={() => onCopy(buildPrompt(item))}
            className={`flex min-h-[44px] items-center gap-2 rounded-[var(--radius-md)] bg-[var(--brand)] px-3 text-sm font-semibold text-[var(--on-brand)] hover:bg-[var(--brand-hover)] ${FOCUS}`}
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
            Copy prompt
          </button>
          <Link
            href={`/space/${space}/work`}
            className={`flex min-h-[44px] items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] hover:border-[var(--border-strong)] ${FOCUS}`}
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Open work
          </Link>
          <button
            type="button"
            disabled
            title="Planned: the backend has no nudge action yet"
            className="flex min-h-[44px] items-center gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--border)] px-3 text-sm text-[var(--text-subtle)] opacity-60 cursor-not-allowed"
          >
            <BellRing className="h-4 w-4" aria-hidden="true" />
            Nudge (planned)
          </button>
        </div>
      </aside>
    </div>
  );
}
