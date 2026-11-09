'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, Copy, ExternalLink, X, BellRing, Network } from 'lucide-react';
import {
  buildPrompt, classify, filterItems, handoffMap, paginate, relativeTime, shortName, tabCounts,
} from '../../../../lib/inbox-model.mjs';
import type { InboxItem } from '../../../../lib/server/inbox';

type Tab = 'all' | 'overdue' | 'awaiting';
const PAGE_SIZE = 10;

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

  const tabs: Array<{ id: Tab; label: string; n: number }> = [
    { id: 'all', label: 'All', n: counts.all },
    { id: 'overdue', label: 'Overdue', n: counts.overdue },
    { id: 'awaiting', label: 'Awaiting response', n: counts.awaiting },
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
    <div className="font-sans text-[#121A19] dark:text-[#E9EEEC]">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-['Schibsted_Grotesk'] text-xl font-bold">Inbox</h1>
        <span className="text-xs font-['IBM_Plex_Mono'] text-[#5C6966] dark:text-[#97A4A0]">space:{space}</span>
      </header>

      {unavailable && (
        <p role="alert" className="mb-3 rounded border border-[#D3DAD8] bg-[#F4F6F5] p-3 text-sm dark:border-[#2B3835] dark:bg-[#19231F]">
          Handoffs could not be read right now. This is not an empty inbox. Try again in a minute.
        </p>
      )}
      {!unavailable && (coverage !== 'full' || dataErrors.length > 0) && (
        <p className="mb-3 rounded border border-[#D3DAD8] p-2 text-xs text-[#46534F] dark:border-[#2B3835] dark:text-[#B3BEBA]">
          Partial view: {coverage !== 'full' ? 'the index is still backfilling, so some handoffs may be missing. ' : ''}
          {dataErrors.length > 0 ? `${dataErrors.length} record problem${dataErrors.length === 1 ? '' : 's'} reported.` : ''}
        </p>
      )}

      {/* Collapsible handoff map */}
      <section className="mb-3 rounded border border-[#D3DAD8] bg-white dark:border-[#2B3835] dark:bg-[#121A19]">
        <button
          type="button"
          aria-expanded={mapOpen}
          onClick={() => setMapOpen((v) => !v)}
          className="flex min-h-[44px] w-full items-center justify-between px-3 text-left text-sm font-semibold"
        >
          <span className="flex items-center gap-2"><Network className="h-4 w-4 text-[#0E6863] dark:text-[#4FC3B8]" />Handoff map ({items.length} active)</span>
          <ChevronDown className={`h-4 w-4 transition-transform ${mapOpen ? 'rotate-180' : ''}`} />
        </button>
        {mapOpen && (
          <div className="overflow-x-auto border-t border-[#D3DAD8] p-3 dark:border-[#2B3835]">
            {map.senders.length === 0 ? (
              <p className="text-sm text-[#5C6966]">No handoffs to map.</p>
            ) : (
              <table className="text-xs font-['IBM_Plex_Mono']">
                <caption className="sr-only">Open handoffs by sender and receiver</caption>
                <thead>
                  <tr>
                    <th className="px-2 py-1 text-left font-normal text-[#5C6966]">from \ to</th>
                    {map.receivers.map((r: string) => <th key={r} scope="col" className="px-2 py-1 font-semibold">{r}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {map.senders.map((s: string) => (
                    <tr key={s}>
                      <th scope="row" className="px-2 py-1 text-left font-semibold">{s}</th>
                      {map.receivers.map((r: string) => {
                        const n = map.cells[`${s}>${r}`] || 0;
                        return (
                          <td
                            key={r}
                            className="px-2 py-1 text-center"
                            style={n ? { backgroundColor: `rgba(14,104,99,${0.12 + 0.5 * (n / map.max)})` } : undefined}
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

      {/* Filter tabs */}
      <div role="tablist" aria-label="Inbox filters" className="mb-2 flex flex-wrap gap-1 border-b border-[#D3DAD8] dark:border-[#2B3835]">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => { setTab(t.id); setPage(1); }}
            className={`min-h-[44px] px-3 text-sm ${
              tab === t.id
                ? 'border-b-2 border-[#0E6863] font-semibold text-[#0E6863] dark:border-[#4FC3B8] dark:text-[#4FC3B8]'
                : 'text-[#46534F] dark:text-[#B3BEBA]'
            }`}
          >
            {t.label} ({t.n})
          </button>
        ))}
      </div>

      {/* Batch bar: only actions the backend can do today */}
      {selected.size > 0 && (
        <div className="mb-2 flex items-center justify-between rounded bg-[#DDF1EE] px-3 py-2 text-sm dark:bg-[#0F2D2A]">
          <span>{selected.size} selected</span>
          <button
            type="button"
            onClick={() => copy(items.filter((i) => selected.has(i.id)).map(buildPrompt).join('\n\n---\n\n'), `Copied ${selected.size} prompts`)}
            className="min-h-[44px] rounded px-3 font-semibold text-[#0E6863] dark:text-[#4FC3B8]"
          >
            Copy prompts
          </button>
        </div>
      )}

      {/* Rows */}
      <div className="rounded border border-[#D3DAD8] bg-white dark:border-[#2B3835] dark:bg-[#121A19]">
        <div className="flex items-center gap-3 border-b border-[#D3DAD8] px-3 py-1 text-xs text-[#5C6966] dark:border-[#2B3835]">
          <label className="flex min-h-[44px] items-center">
            <input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select all on this page" className="h-4 w-4" />
          </label>
          <span>{pg.total === 0 ? 'Nothing here' : `${pg.total} handoff${pg.total === 1 ? '' : 's'}`}</span>
        </div>
        {pg.rows.length === 0 && !unavailable && (
          <p className="p-4 text-sm text-[#5C6966]">No handoffs in this view.</p>
        )}
        <ul>
          {pg.rows.map((r: InboxItem) => {
            const kind = classify(r, now);
            return (
              <li key={r.id} className="flex items-center gap-3 border-b border-[#EAEEEC] px-3 last:border-b-0 hover:bg-[#F4F6F5] dark:border-[#19231F] dark:hover:bg-[#19231F]">
                <label className="flex min-h-[44px] items-center">
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select handoff from ${shortName(r.from)}`} className="h-4 w-4" />
                </label>
                <button
                  type="button"
                  onClick={() => setOpen(r)}
                  className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 text-left text-sm"
                >
                  <span className="w-40 shrink-0 truncate font-bold sm:w-48">{shortName(r.from)} → {shortName(r.to)}</span>
                  <span className="min-w-0 flex-1 truncate text-[#46534F] dark:text-[#B3BEBA]">{r.summary}</span>
                  {kind === 'overdue' && <span className="hidden shrink-0 rounded bg-[#F6E3E1] px-1.5 text-[10px] font-semibold text-[#8A2A1F] sm:inline">overdue</span>}
                  <span className="w-16 shrink-0 text-right text-xs font-['IBM_Plex_Mono'] text-[#5C6966] dark:text-[#97A4A0]">{relativeTime(r.created_at, now)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center justify-end gap-2 px-3 py-1 text-xs text-[#5C6966] dark:text-[#97A4A0]">
          <span aria-live="polite">{pg.from}–{pg.to} of {pg.total}</span>
          <button type="button" aria-label="Previous page" disabled={pg.page <= 1} onClick={() => setPage(pg.page - 1)} className="flex min-h-[44px] min-w-[44px] items-center justify-center disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" aria-label="Next page" disabled={pg.page >= pg.pages} onClick={() => setPage(pg.page + 1)} className="flex min-h-[44px] min-w-[44px] items-center justify-center disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>
      {total > items.length && (
        <p className="mt-2 text-xs text-[#5C6966]">Showing the first {items.length} of {total}. Older handoffs are not loaded yet.</p>
      )}
      <p role="status" className="mt-2 min-h-[1rem] text-xs text-[#0E6863] dark:text-[#4FC3B8]">{copied}</p>

      {open && <Inspector item={open} space={space} now={now} onClose={() => setOpen(null)} onCopy={(t) => copy(t, 'Prompt copied')} />}
    </div>
  );
}

function Inspector({ item, space, now, onClose, onCopy }: { item: InboxItem; space: string; now: number; onClose: () => void; onCopy: (t: string) => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kind = classify(item, now);
  const rows: Array<[string, string]> = [
    ['From', shortName(item.from)],
    ['To', shortName(item.to)],
    ['Where', item.where || 'not recorded'],
    ['Created', `${when.format(item.created_at)} ET (${relativeTime(item.created_at, now)})`],
    ['Deadline', `${when.format(item.deadline)} ET${kind === 'overdue' ? ', overdue' : ''}`],
    ['Response', item.response || 'open'],
    ['Source', item.source || 'not recorded'],
    ['Trail', item.request_trail || item.id],
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Handoff details"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col border-l border-[#D3DAD8] bg-white shadow-2xl dark:border-[#2B3835] dark:bg-[#121A19]"
      >
        <div className="flex items-center justify-between border-b border-[#D3DAD8] bg-[#F4F6F5] p-3 dark:border-[#2B3835] dark:bg-[#19231F]">
          <h2 className="font-['Schibsted_Grotesk'] text-sm font-bold">{shortName(item.from)} → {shortName(item.to)}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close details" className="flex min-h-[44px] min-w-[44px] items-center justify-center"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 text-sm">
          <p className="mb-4 whitespace-pre-wrap">{item.summary}</p>
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-xs">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-[#5C6966] dark:text-[#97A4A0]">{k}</dt>
                <dd className="break-all font-['IBM_Plex_Mono']">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-[#D3DAD8] p-3 dark:border-[#2B3835]">
          <button type="button" onClick={() => onCopy(buildPrompt(item))} className="flex min-h-[44px] items-center gap-2 rounded bg-[#0E6863] px-3 text-sm font-semibold text-white"><Copy className="h-4 w-4" />Copy prompt</button>
          <Link href={`/${space}/work`} className="flex min-h-[44px] items-center gap-2 rounded border border-[#D3DAD8] px-3 text-sm dark:border-[#2B3835]"><ExternalLink className="h-4 w-4" />Open work</Link>
          <button type="button" disabled title="Planned: the backend has no nudge action yet" className="flex min-h-[44px] items-center gap-2 rounded border border-dashed border-[#D3DAD8] px-3 text-sm opacity-60 dark:border-[#2B3835]"><BellRing className="h-4 w-4" />Nudge (planned)</button>
        </div>
      </aside>
    </div>
  );
}
