'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Copy,
  ExternalLink,
  X,
  Network,
  CheckCheck,
  Search,
  AlertTriangle,
} from 'lucide-react';
import {
  buildFleetChips,
  buildPrompt,
  classify,
  filterArchiveEntries,
  filterItems,
  handoffMap,
  paginate,
  relativeTime,
  shortName,
  sortDecisionsUrgency,
  splitHandoffs,
  tabCounts,
} from '../../../../../lib/inbox-model.mjs';
import type {
  InboxAgent,
  InboxArchiveEntry,
  InboxDecision,
  InboxItem,
  InboxReview,
  InboxTask,
} from '../../../../../lib/server/inbox';
import {
  AgeBucketChips,
  AgentCombobox,
  CopyId,
  DecisionApprovalTray,
  HeatMapXL,
  InboxSectionTabs,
  InboxUndoToast,
  KnowledgeGraph,
  StatePanel,
  StatusStrip,
} from '../../../../../components/ui';
import type { HeatMapCell, KnowledgeGraphLink, KnowledgeGraphNode } from '../../../../../components/ui';

type BucketTab = 'all' | 'overdue' | 'awaiting';
type ArchiveWindow = 'all' | '1' | '7' | '30';

const PAGE_SIZE = 10;
const UNDO_MS = 4500;
const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

interface Props {
  space: string;
  items: InboxItem[];
  total: number;
  coverage: string;
  dataErrors: Array<{ type: string; id?: string }>;
  unavailable: boolean;
  decisions: InboxDecision[];
  tasks: InboxTask[];
  reviews: InboxReview[];
  agents: InboxAgent[];
  archive: InboxArchiveEntry[];
  sectionErrors?: {
    decisions?: string;
    fleet?: string;
    archive?: string;
  };
  now: number;
}

const when = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function InboxView({
  space,
  items,
  total,
  coverage,
  dataErrors,
  unavailable,
  decisions,
  tasks,
  reviews,
  agents,
  archive,
  sectionErrors = {},
  now,
}: Props) {
  const [activeSection, setActiveSection] = useState('decisions');
  const [agentFilter, setAgentFilter] = useState('');
  const [tab, setTab] = useState<BucketTab>('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<InboxItem | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapMode, setMapMode] = useState<'network' | 'matrix'>('network');
  const [copied, setCopied] = useState('');

  const [showAllDecisions, setShowAllDecisions] = useState(false);
  const [agentSectionOpen, setAgentSectionOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const [expandedText, setExpandedText] = useState<Set<string>>(new Set());

  // Optimistic review acknowledgement + Undo toast state
  const [selectedReviews, setSelectedReviews] = useState<Set<string>>(new Set());
  const [ackedJobs, setAckedJobs] = useState<Set<string>>(new Set());
  const [localArchive, setLocalArchive] = useState<InboxArchiveEntry[]>([]);
  const [undoState, setUndoState] = useState<{
    open: boolean;
    items: InboxReview[];
    message: string;
    status: 'pending' | 'restored' | 'error';
  }>({ open: false, items: [], message: '', status: 'pending' });
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Archive filters
  const [archiveQuery, setArchiveQuery] = useState('');
  const [archiveAgent, setArchiveAgent] = useState('');
  const [archiveWindow, setArchiveWindow] = useState<ArchiveWindow>('all');

  // Keyboard navigation
  const [kbIndex, setKbIndex] = useState(-1);
  const comboboxInputRef = useRef<HTMLInputElement>(null);

  const agentOptions = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => {
      if (i.to) set.add(shortName(i.to));
      if (i.from) set.add(shortName(i.from));
    });
    agents.forEach((a) => {
      if (a.id) set.add(shortName(a.id));
    });
    archive.forEach((e) => {
      if (e.by) set.add(shortName(e.by));
    });
    return [...set].filter((s) => s && s !== 'unknown').sort((a, b) => a.localeCompare(b));
  }, [items, agents, archive]);

  const agentFilteredItems = useMemo(() => {
    const q = agentFilter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => shortName(i.to).toLowerCase() === q || shortName(i.from).toLowerCase() === q,
    );
  }, [items, agentFilter]);

  const { human: humanQueueAll, agentToAgent: agentQueueAll } = useMemo(
    () => splitHandoffs(agentFilteredItems),
    [agentFilteredItems],
  );

  const counts = useMemo(() => tabCounts(agentFilteredItems, now), [agentFilteredItems, now]);
  const shownHumanQueue = useMemo(() => filterItems(humanQueueAll, tab, now), [humanQueueAll, tab, now]);
  const shownAgentQueue = useMemo(() => filterItems(agentQueueAll, tab, now), [agentQueueAll, tab, now]);
  const pg = useMemo(() => paginate(shownAgentQueue, page, PAGE_SIZE), [shownAgentQueue, page]);
  const map = useMemo(() => handoffMap(items), [items]);
  const requestMapData = useMemo(() => {
    const DAY_MS = 86_400_000;
    const H_MS = 3_600_000;
    const ageBandOf = (ms: number): 'fresh' | 'slow' | 'stale' =>
      ms > 7 * DAY_MS ? 'stale' : ms > DAY_MS ? 'slow' : 'fresh';
    const ageLabelOf = (ms: number): string =>
      ms >= DAY_MS ? `${Math.round(ms / DAY_MS)} d` : `${Math.max(1, Math.round(ms / H_MS))} h`;

    const agentSet = new Set<string>();
    const waitMap = new Map<string, { waiting: number; late: number }>();
    const cells: Record<string, HeatMapCell & { maxAge: number }> = {};
    let delayedCount = 0;
    let oldestAge = 0;

    for (const item of items) {
      const from = shortName(item.from);
      const to = shortName(item.to);
      if (!from || !to || from === to) continue;
      agentSet.add(from);
      agentSet.add(to);
      const age = Math.max(0, now - Number(item.created_at || now));
      const band = ageBandOf(age);
      if (band !== 'fresh') delayedCount += 1;
      if (age > oldestAge) oldestAge = age;

      const w = waitMap.get(to) || { waiting: 0, late: 0 };
      w.waiting += 1;
      if (band !== 'fresh') w.late += 1;
      waitMap.set(to, w);

      const key = `${from}>${to}`;
      const existing = cells[key];
      if (!existing) {
        cells[key] = { from, to, count: 1, band, label: ageLabelOf(age), maxAge: age };
      } else {
        existing.count += 1;
        if (age >= existing.maxAge) {
          existing.maxAge = age;
          existing.band = band;
          existing.label = ageLabelOf(age);
        }
      }
    }

    const agentsList = [...agentSet].sort((a, b) => a.localeCompare(b));
    const nodes: KnowledgeGraphNode[] = agentsList.map((id) => ({
      id,
      label: id,
      waiting: waitMap.get(id)?.waiting ?? 0,
      late: waitMap.get(id)?.late ?? 0,
    }));
    const links: KnowledgeGraphLink[] = Object.values(cells).map((c) => ({
      source: c.from,
      target: c.to,
      count: c.count,
      label: c.label,
      band: c.band,
    }));

    return {
      agents: agentsList,
      cells,
      nodes,
      links,
      delayedCount,
      oldestLabel: oldestAge > 0 ? ageLabelOf(oldestAge) : '0 h',
    };
  }, [items, now]);

  const sortedDecisions = useMemo(() => sortDecisionsUrgency(decisions) as InboxDecision[], [decisions]);
  const visibleDecisions = showAllDecisions ? sortedDecisions : sortedDecisions.slice(0, 3);

  const visibleReviews = useMemo(
    () => reviews.filter((r) => !ackedJobs.has(r.job)),
    [reviews, ackedJobs],
  );

  const fleet = useMemo(() => buildFleetChips(agents, now, 10), [agents, now]);

  const combinedArchive = useMemo(() => {
    const seen = new Set<string>();
    const merged: InboxArchiveEntry[] = [];
    for (const entry of [...localArchive, ...archive]) {
      if (!entry.id || seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push(entry);
    }
    return merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }, [localArchive, archive]);

  const filteredArchive = useMemo(
    () =>
      filterArchiveEntries(
        combinedArchive,
        { query: archiveQuery, agent: archiveAgent, windowDays: archiveWindow },
        now,
      ) as InboxArchiveEntry[],
    [combinedArchive, archiveQuery, archiveAgent, archiveWindow, now],
  );

  const scrollToSection = useCallback((sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (!el) return;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  }, []);

  const toggleExpand = (key: string) =>
    setExpandedText((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const copy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setCopied('Copy blocked by the browser');
    }
    setTimeout(() => setCopied(''), 2500);
  }, []);

  const commitReviews = useCallback(
    async (batch: InboxReview[]) => {
      const failed: InboxReview[] = [];
      for (const item of batch) {
        try {
          const res = await fetch('/api/confirm-done', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-LogMem-Intent': 'work' },
            body: JSON.stringify({ space, job: item.job }),
          });
          if (!res.ok) failed.push(item);
        } catch {
          failed.push(item);
        }
      }
      if (failed.length > 0) {
        const failedIds = new Set(failed.map((f) => f.job));
        setAckedJobs((prev) => {
          const next = new Set(prev);
          failedIds.forEach((id) => next.delete(id));
          return next;
        });
        setLocalArchive((prev) => prev.filter((a) => !failedIds.has(a.where?.replace(/^job:/, '') || '')));
        setUndoState({
          open: true,
          items: [],
          status: 'error',
          message: `Read-only viewer or save error: could not commit ${failed.length} review${failed.length === 1 ? '' : 's'} right now.`,
        });
      }
    },
    [space],
  );

  const startAcknowledge = useCallback(
    (batch: InboxReview[]) => {
      const valid = batch.filter((item) => !ackedJobs.has(item.job));
      if (valid.length === 0) return;
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
      const ts = Date.now();
      setAckedJobs((prev) => {
        const next = new Set(prev);
        valid.forEach((i) => next.add(i.job));
        return next;
      });
      setSelectedReviews((prev) => {
        const next = new Set(prev);
        valid.forEach((i) => next.delete(i.job));
        return next;
      });
      setLocalArchive((prev) => [
        ...valid.map((item) => ({
          id: `ack:${item.job}:${ts}`,
          kind: 'done',
          by: 'you',
          ts,
          summary: `Acknowledged review: ${item.summary}`,
          where: `job:${item.job}`,
        })),
        ...prev,
      ]);
      setUndoState({
        open: true,
        items: valid,
        status: 'pending',
        message: `Acknowledged ${valid.length} review${valid.length === 1 ? '' : 's'}`,
      });
      undoTimerRef.current = setTimeout(() => {
        undoTimerRef.current = null;
        setUndoState((cur) => ({ ...cur, open: false }));
        void commitReviews(valid);
      }, UNDO_MS);
    },
    [ackedJobs, commitReviews],
  );

  const handleUndo = useCallback(() => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    const jobs = new Set(undoState.items.map((i) => i.job));
    setAckedJobs((prev) => {
      const next = new Set(prev);
      jobs.forEach((j) => next.delete(j));
      return next;
    });
    setLocalArchive((prev) =>
      prev.filter((a) => !jobs.has(a.where?.replace(/^job:/, '') || '')),
    );
    setUndoState({ open: false, items: [], message: '', status: 'restored' });
  }, [undoState.items]);

  const handleDismissUndo = useCallback(() => {
    if (undoTimerRef.current && undoState.status === 'pending') {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
      const itemsToCommit = undoState.items;
      setUndoState((cur) => ({ ...cur, open: false }));
      void commitReviews(itemsToCommit);
      return;
    }
    setUndoState((cur) => ({ ...cur, open: false }));
  }, [commitReviews, undoState.items, undoState.status]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    };
  }, []);

  // Keyboard shortcuts: j/k move, a act, c comment, / filter (keep Cmd+K untouched)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (mapOpen) setMapOpen(false);
        return;
      }
      if (isEditableElement(e.target)) return;
      if (e.key === '/') {
        e.preventDefault();
        comboboxInputRef.current?.focus();
        comboboxInputRef.current?.select();
        return;
      }
      const nodes = [...document.querySelectorAll<HTMLElement>('[data-cockpit-item]')];
      if (nodes.length === 0) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        setKbIndex((prev) => {
          const next =
            e.key === 'j'
              ? prev < nodes.length - 1
                ? prev + 1
                : 0
              : prev > 0
                ? prev - 1
                : nodes.length - 1;
          nodes.forEach((n, idx) => {
            if (idx === next) n.setAttribute('data-kb-active', 'true');
            else n.removeAttribute('data-kb-active');
          });
          nodes[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
        return;
      }
      const activeNode = kbIndex >= 0 && kbIndex < nodes.length ? nodes[kbIndex] : nodes[0];
      if (!activeNode) return;
      if (e.key === 'a') {
        const primary = activeNode.querySelector<HTMLButtonElement>('[data-kb-primary]');
        if (primary && !primary.disabled) {
          e.preventDefault();
          primary.click();
        }
      } else if (e.key === 'c') {
        const comment = activeNode.querySelector<HTMLElement>('[data-kb-comment]');
        if (comment) {
          e.preventDefault();
          comment.click();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [kbIndex, mapOpen]);

  const bucketOptions = [
    { id: 'all' as BucketTab, label: 'All', count: counts.all, alwaysEnabled: true },
    { id: 'overdue' as BucketTab, label: 'Overdue', count: counts.overdue },
    { id: 'awaiting' as BucketTab, label: 'Awaiting response', count: counts.awaiting },
  ];

  const humanTotal = shownHumanQueue.length + tasks.length;
  const totalHandoffs = humanTotal + agentQueueAll.length;
  const pageIds = pg.rows.map((r: InboxItem) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id: string) => selected.has(id));
  const toggleSelect = (id: string) =>
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

  const allReviewsSelected =
    visibleReviews.length > 0 && visibleReviews.every((r) => selectedReviews.has(r.job));
  const selectedReviewBatch = visibleReviews.filter((r) => selectedReviews.has(r.job));

  const sectionTabs = [
    { id: 'decisions', label: 'Decisions', count: sortedDecisions.length, tone: 'decision' as const },
    { id: 'handoffs', label: 'Handoffs', count: totalHandoffs, tone: 'brand' as const },
    { id: 'reviews', label: 'Reviews', count: visibleReviews.length, tone: 'warning' as const },
    { id: 'archive', label: 'Archive', count: combinedArchive.length, tone: 'success' as const },
  ];

  const renderExpandable = (key: string, text: string | undefined, limit = 150) => {
    const str = String(text || '').trim();
    if (!str) return null;
    const isOpen = expandedText.has(key);
    if (str.length <= limit) {
      return <p className="text-sm leading-relaxed text-[var(--text-muted)] break-words">{str}</p>;
    }
    return (
      <p className="text-sm leading-relaxed text-[var(--text-muted)] break-words">
        {isOpen ? str : `${str.slice(0, limit).trimEnd()}…`}{' '}
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpand(key);
          }}
          className={`text-xs font-medium text-[var(--link)] underline ${FOCUS}`}
        >
          {isOpen ? 'Show less' : 'Show more'}
        </button>
      </p>
    );
  };

  return (
    <div className="space-y-5 font-sans text-[var(--text)]">
      {/* Header row — no eyebrow above H1 */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="font-heading text-2xl font-bold tracking-tight text-[var(--text)]">
            Inbox
          </h1>
          <span className="hidden items-center gap-1 font-mono text-xs text-[var(--text-subtle)] sm:inline-flex">
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px]">j</kbd>
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px]">k</kbd>
            move ·
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px]">a</kbd>
            act ·
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px]">c</kbd>
            comment ·
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px]">/</kbd>
            filter
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <AgentCombobox
            options={agentOptions}
            value={agentFilter}
            onChange={(val) => {
              setAgentFilter(val);
              setPage(1);
            }}
            inputRef={comboboxInputRef}
          />
          <button
            type="button"
            onClick={() => setMapOpen(true)}
            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--text)] hover:border-[var(--border-strong)] ${FOCUS}`}
          >
            <Network className="h-3.5 w-3.5 text-[var(--brand)]" aria-hidden="true" />
            Request map
          </button>
        </div>
      </header>

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

      {/* Sticky Section Tabs (21st.dev 29425) */}
      <InboxSectionTabs
        tabs={sectionTabs}
        activeId={activeSection}
        onSelect={(id) => {
          setActiveSection(id);
          if (id === 'archive') setArchiveOpen(true);
          if (id === 'handoffs' && humanTotal === 0) setAgentSectionOpen(true);
          scrollToSection(
            id === 'handoffs' && humanTotal === 0 ? 'inbox-agent-handoffs' : `inbox-${id}`,
          );
        }}
      />

      {/* Section 1: At a glance strip + Fleet right now */}
      <section aria-label="At a glance" className="space-y-3">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          <button
            type="button"
            onClick={() => {
              setActiveSection('decisions');
              scrollToSection('inbox-decisions');
            }}
            className={`grid gap-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition-colors hover:border-[var(--border-strong)] ${FOCUS}`}
          >
            <span className="text-xs text-[var(--text-muted)]">Decisions waiting</span>
            <strong
              className={`text-2xl font-semibold tabular-nums ${
                sortedDecisions.length > 0 ? 'text-[var(--decision)]' : 'text-[var(--text-subtle)]'
              }`}
            >
              {sortedDecisions.length}
            </strong>
            <span className="text-xs text-[var(--text-muted)]">
              {sortedDecisions.some((d) => d.payload?.reversible !== true)
                ? 'irreversible first'
                : 'ready to review'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveSection('handoffs');
              if (humanTotal === 0) setAgentSectionOpen(true);
              scrollToSection(humanTotal > 0 ? 'inbox-handoffs' : 'inbox-agent-handoffs');
            }}
            className={`grid gap-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition-colors hover:border-[var(--border-strong)] ${FOCUS}`}
          >
            <span className="text-xs text-[var(--text-muted)]">Handoffs to accept</span>
            <strong
              className={`text-2xl font-semibold tabular-nums ${
                totalHandoffs > 0 ? 'text-[var(--brand)]' : 'text-[var(--text-subtle)]'
              }`}
            >
              {totalHandoffs}
            </strong>
            <span className="text-xs text-[var(--text-muted)]">
              {humanTotal} for you · {agentQueueAll.length} agent
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveSection('reviews');
              scrollToSection('inbox-reviews');
            }}
            className={`grid gap-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition-colors hover:border-[var(--border-strong)] ${FOCUS}`}
          >
            <span className="text-xs text-[var(--text-muted)]">Reviews to acknowledge</span>
            <strong
              className={`text-2xl font-semibold tabular-nums ${
                visibleReviews.length > 0 ? 'text-[var(--warning)]' : 'text-[var(--text-subtle)]'
              }`}
            >
              {visibleReviews.length}
            </strong>
            <span className="text-xs text-[var(--text-muted)]">
              {visibleReviews.length > 0 ? 'bulk acknowledge ready' : 'all clear'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              const next = tab === 'overdue' ? 'all' : 'overdue';
              setTab(next);
              setPage(1);
              if (next === 'overdue') setAgentSectionOpen(true);
              scrollToSection(
                humanQueueAll.some((i) => classify(i, now) === 'overdue')
                  ? 'inbox-handoffs'
                  : 'inbox-agent-handoffs',
              );
            }}
            className={`grid gap-1 rounded-[var(--radius-md)] border p-3 text-left transition-colors ${FOCUS} ${
              tab === 'overdue'
                ? 'border-[var(--danger)] bg-[var(--danger-subtle)]'
                : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)]'
            }`}
          >
            <span className="text-xs text-[var(--text-muted)]">Overdue</span>
            <strong
              className={`text-2xl font-semibold tabular-nums ${
                counts.overdue > 0 ? 'text-[var(--danger)]' : 'text-[var(--text-subtle)]'
              }`}
            >
              {counts.overdue}
            </strong>
            <span className="text-xs text-[var(--text-muted)]">
              {counts.overdue > 0 ? 'past deadline' : 'on schedule'}
            </span>
          </button>

          <Link
            href={`/space/${space}/agents`}
            className={`grid gap-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition-colors hover:border-[var(--border-strong)] ${FOCUS}`}
          >
            <span className="text-xs text-[var(--text-muted)]">Blocked agents</span>
            <strong
              className={`text-2xl font-semibold tabular-nums ${
                fleet.blockedCount > 0 ? 'text-[var(--danger)]' : 'text-[var(--text-subtle)]'
              }`}
            >
              {fleet.blockedCount}
            </strong>
            <span className="text-xs text-[var(--text-muted)]">of {fleet.total} total</span>
          </Link>
        </div>

        {/* Fleet right now */}
        <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-[var(--text)]">Fleet right now</span>
            <span className="text-xs text-[var(--text-muted)]">
              {fleet.activeCount} active
              {fleet.blockedCount > 0 ? ` · ${fleet.blockedCount} blocked` : ''}
            </span>
            <Link
              href={`/space/${space}/agents`}
              className={`ml-auto text-xs font-medium text-[var(--link)] hover:underline ${FOCUS}`}
            >
              View all {fleet.total}
            </Link>
          </div>
          {sectionErrors.fleet ? (
            <p role="alert" className="text-xs text-[var(--danger)]">
              {sectionErrors.fleet}
            </p>
          ) : fleet.chips.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">No agents connected yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {fleet.chips.map((c: any) => (
                <li key={c.id} className="max-w-full">
                  <Link
                    href={`/space/${space}/agents/${encodeURIComponent(c.id)}`}
                    title={`${c.name} — ${c.job} · ${c.lastWrite}`}
                    className={`inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border px-2.5 py-1.5 text-xs transition-colors ${FOCUS} ${
                      c.status === 'blocked'
                        ? 'border-[var(--danger)] bg-[var(--danger-subtle)] text-[var(--text)]'
                        : c.status === 'silent'
                          ? 'border-[var(--warning)] bg-[var(--warning-subtle)] text-[var(--text)]'
                          : 'border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text)] hover:border-[var(--border-strong)]'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        c.status === 'active'
                          ? 'bg-[var(--success)]'
                          : c.status === 'blocked'
                            ? 'bg-[var(--danger)]'
                            : c.status === 'silent'
                              ? 'bg-[var(--warning)]'
                              : 'bg-[var(--text-subtle)]'
                      }`}
                    />
                    <span className="font-semibold">{c.name}</span>
                    <span className="break-words text-[var(--text-muted)]">{c.job}</span>
                    <span className="font-mono text-[11px] text-[var(--text-subtle)]">
                      {c.lastWrite}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Section 2: Decisions (21st.dev 43819 + 36498 + 23792 Tray) */}
      <section id="inbox-decisions" aria-labelledby="inbox-decisions-h" className="scroll-mt-16 space-y-2.5">
        {sectionErrors.decisions ? (
          <>
            <h2 id="inbox-decisions-h" className="font-heading text-base font-semibold">
              Decisions
            </h2>
            <p role="alert" className="rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger-subtle)] px-3.5 py-2.5 text-sm text-[var(--danger)]">
              {sectionErrors.decisions}
            </p>
          </>
        ) : visibleDecisions.length === 0 ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="inbox-decisions-h" className="flex items-center gap-2 font-heading text-base font-semibold">
                <span>Decisions</span>
                <span className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-full bg-[var(--surface-sunken)] px-2 font-mono text-xs font-semibold tabular-nums text-[var(--text-muted)]">
                  0
                </span>
              </h2>
              <Link
                href={`/space/${space}/today`}
                className={`rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)] ${FOCUS}`}
              >
                Brief view
              </Link>
            </div>
            <p className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--text-muted)]">
              All clear — no decisions waiting on you.
            </p>
          </>
        ) : (
          <DecisionApprovalTray
            items={visibleDecisions.map((d) => ({
              trail: d.trail,
              summary: d.summary,
              byLabel: shortName(d.by),
              ageLabel: relativeTime(d.ts, now),
              whereLabel: d.where ? d.where.replace(/^job:/, '') : undefined,
              action: d.payload?.action,
              irreversible: d.payload?.reversible !== true,
              deferred: Boolean(d.deferred),
            }))}
            totalCount={sortedDecisions.length}
            showAll={showAllDecisions}
            onToggleShowAll={() => setShowAllDecisions((v) => !v)}
            boardHref={`/space/${space}/today`}
            commentHref={`/space/${space}/activity`}
            onCopyAction={(act) => copy(act, 'Proposed action copied')}
          />
        )}
      </section>

      {/* Section 3: Human handoffs & tasks */}
      <section id="inbox-handoffs" aria-labelledby="inbox-handoffs-h" className="scroll-mt-16 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="inbox-handoffs-h" className="flex items-center gap-2 font-heading text-base font-semibold">
            <span>Human handoffs &amp; tasks</span>
            <span
              className={`inline-flex h-5 min-w-[22px] items-center justify-center rounded-full px-2 font-mono text-xs font-semibold tabular-nums ${
                humanTotal > 0
                  ? 'bg-[var(--brand-subtle)] text-[var(--brand)]'
                  : 'bg-[var(--surface-sunken)] text-[var(--text-muted)]'
              }`}
            >
              {humanTotal}
            </span>
          </h2>
        </div>

        {humanTotal === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--text-muted)]">
            All clear — no handoffs or tasks addressed directly to you.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
            {shownHumanQueue.map((r: InboxItem) => {
              const kind = classify(r, now);
              return (
                <li
                  key={r.id}
                  data-cockpit-item="true"
                  className="flex flex-wrap items-start gap-3 p-3.5 transition-colors hover:bg-[var(--surface-sunken)] data-[kb-active=true]:bg-[var(--brand-subtle)]"
                >
                  <label className="mt-0.5 flex min-h-[28px] items-center">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleSelect(r.id)}
                      aria-label={`Select handoff from ${shortName(r.from)}`}
                      className="h-4 w-4 accent-[var(--brand)]"
                    />
                  </label>
                  <div className="min-w-0 flex-1 space-y-1">
                    <button
                      type="button"
                      onClick={() => setOpen(r)}
                      className={`block text-left text-sm font-medium text-[var(--text)] hover:text-[var(--link)] ${FOCUS}`}
                    >
                      <span className="mr-2 font-mono text-xs text-[var(--text-muted)]">
                        {shortName(r.from)} → {shortName(r.to)}
                      </span>
                      <span className="break-words">{r.summary}</span>
                    </button>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-medium ${
                          kind === 'overdue'
                            ? 'bg-[var(--danger-subtle)] text-[var(--danger)]'
                            : 'bg-[var(--warning-subtle)] text-[var(--warning)]'
                        }`}
                      >
                        {kind === 'overdue' ? 'Overdue' : 'Due soon'}
                      </span>
                      <span className="font-mono text-[var(--text-subtle)]">
                        opened {relativeTime(r.created_at, now)}
                      </span>
                      {r.where && (
                        <span className="rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-muted)] break-all">
                          {r.where.replace(/^job:/, '')}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      data-kb-primary="true"
                      onClick={() => copy(buildPrompt(r), 'Prompt copied')}
                      className={`inline-flex min-h-[34px] items-center gap-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs font-medium text-[var(--text)] hover:border-[var(--border-strong)] ${FOCUS}`}
                    >
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      Copy prompt
                    </button>
                    <Link
                      data-kb-comment="true"
                      href={`/space/${space}/activity`}
                      className={`inline-flex min-h-[34px] items-center rounded-[var(--radius-md)] px-2.5 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)] ${FOCUS}`}
                    >
                      Comment
                    </Link>
                  </div>
                </li>
              );
            })}
            {tasks.map((t) => (
              <li
                key={t.trail}
                data-cockpit-item="true"
                className="flex flex-wrap items-start justify-between gap-3 p-3.5 data-[kb-active=true]:bg-[var(--brand-subtle)]"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-[var(--brand-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--brand)]">
                      Task
                    </span>
                    <span className="text-sm font-medium text-[var(--text)] break-words">
                      {t.summary}
                    </span>
                    {t.due && (
                      <span className="rounded-full bg-[var(--warning-subtle)] px-2 py-0.5 font-mono text-[11px] font-medium text-[var(--warning)]">
                        due {t.due}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                    <span>from {shortName(t.by)}</span>
                    {t.stepsTotal > 0 && (
                      <span>
                        · {t.stepsDone} of {t.stepsTotal} steps
                      </span>
                    )}
                    {t.job && (
                      <span className="rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-0.5 font-mono text-[11px]">
                        {t.job}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Link
                    data-kb-primary="true"
                    href={`/space/${space}/work`}
                    className={`inline-flex min-h-[34px] items-center rounded-[var(--radius-md)] bg-[var(--brand)] px-3 text-xs font-semibold text-[var(--on-brand)] hover:opacity-90 ${FOCUS}`}
                  >
                    Open task
                  </Link>
                  <Link
                    data-kb-comment="true"
                    href={`/space/${space}/activity`}
                    className={`inline-flex min-h-[34px] items-center rounded-[var(--radius-md)] px-2.5 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] ${FOCUS}`}
                  >
                    Comment
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Section 4: Reviews to acknowledge */}
      <section id="inbox-reviews" aria-labelledby="inbox-reviews-h" className="scroll-mt-16 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="inbox-reviews-h" className="flex items-center gap-2 font-heading text-base font-semibold">
            <span>Reviews to acknowledge</span>
            <span
              className={`inline-flex h-5 min-w-[22px] items-center justify-center rounded-full px-2 font-mono text-xs font-semibold tabular-nums ${
                visibleReviews.length > 0
                  ? 'bg-[var(--warning-subtle)] text-[var(--warning)]'
                  : 'bg-[var(--surface-sunken)] text-[var(--text-muted)]'
              }`}
            >
              {visibleReviews.length}
            </span>
          </h2>
          {visibleReviews.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex min-h-[36px] cursor-pointer items-center gap-1.5 text-xs text-[var(--text-muted)]">
                <input
                  type="checkbox"
                  checked={allReviewsSelected}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedReviews(new Set(visibleReviews.map((r) => r.job)));
                    } else {
                      setSelectedReviews(new Set());
                    }
                  }}
                  className="h-4 w-4 accent-[var(--brand)]"
                />
                Select all
              </label>
              <button
                type="button"
                onClick={() =>
                  startAcknowledge(selectedReviewBatch.length > 0 ? selectedReviewBatch : visibleReviews)
                }
                className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--brand)] px-3 text-xs font-semibold text-[var(--on-brand)] hover:opacity-90 ${FOCUS}`}
              >
                <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                {selectedReviewBatch.length > 0
                  ? `Acknowledge selected (${selectedReviewBatch.length})`
                  : `Acknowledge all (${visibleReviews.length})`}
              </button>
            </div>
          )}
        </div>

        {visibleReviews.length === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--text-muted)]">
            All clear — no reviews waiting to acknowledge.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
            {visibleReviews.map((item) => (
              <li
                key={item.job}
                data-cockpit-item="true"
                className="flex flex-wrap items-start gap-3 p-3.5 data-[kb-active=true]:bg-[var(--brand-subtle)]"
              >
                <label className="mt-0.5 flex min-h-[28px] items-center">
                  <input
                    type="checkbox"
                    checked={selectedReviews.has(item.job)}
                    onChange={(e) => {
                      setSelectedReviews((prev) => {
                        const next = new Set(prev);
                        e.target.checked ? next.add(item.job) : next.delete(item.job);
                        return next;
                      });
                    }}
                    aria-label={`Select review for ${item.summary}`}
                    className="h-4 w-4 accent-[var(--brand)]"
                  />
                </label>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/space/${space}/work`}
                      className="text-sm font-medium text-[var(--text)] hover:text-[var(--link)] hover:underline break-words"
                    >
                      {item.summary}
                    </Link>
                    <span className="rounded-full bg-[var(--warning-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--warning)]">
                      Needs review
                    </span>
                  </div>
                  {renderExpandable(`rev:${item.job}`, item.evidence, 150)}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                    {item.owner && <span>owner {shortName(item.owner)}</span>}
                    {item.plan && (
                      <span className="rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-0.5 font-mono text-[11px]">
                        {item.plan}
                      </span>
                    )}
                    {item.created_at && (
                      <span className="font-mono text-[var(--text-subtle)]">
                        checked {relativeTime(item.created_at, now)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-kb-primary="true"
                    onClick={() => startAcknowledge([item])}
                    className={`inline-flex min-h-[34px] items-center rounded-[var(--radius-md)] bg-[var(--brand)] px-3 text-xs font-semibold text-[var(--on-brand)] hover:opacity-90 ${FOCUS}`}
                  >
                    Acknowledge
                  </button>
                  <Link
                    data-kb-comment="true"
                    href={`/space/${space}/work`}
                    className={`inline-flex min-h-[34px] items-center rounded-[var(--radius-md)] px-2.5 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] ${FOCUS}`}
                  >
                    Open
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Section 5: Agent-to-agent handoffs (collapsed by default with count) */}
      <section
        id="inbox-agent-handoffs"
        className="scroll-mt-16 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]"
      >
        <button
          type="button"
          aria-expanded={agentSectionOpen}
          onClick={() => setAgentSectionOpen((v) => !v)}
          className={`flex min-h-[48px] w-full flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] px-4 py-2 text-left ${FOCUS}`}
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-heading text-sm font-semibold text-[var(--text)]">
              Agent-to-agent handoffs
            </span>
            <span className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-full bg-[var(--surface-sunken)] px-2 font-mono text-xs font-semibold tabular-nums text-[var(--text-muted)]">
              {agentQueueAll.length}
            </span>
            {counts.overdue > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--danger-subtle)] px-2 py-0.5 font-mono text-[11px] font-semibold text-[var(--danger)]">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                {counts.overdue} overdue
              </span>
            )}
          </span>
          <span className="flex items-center gap-1 text-xs font-medium text-[var(--link)]">
            {agentSectionOpen ? 'Hide' : 'Expand'}
            <ChevronDown
              className={`h-4 w-4 transition-transform motion-reduce:transition-none ${agentSectionOpen ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </span>
        </button>

        {agentSectionOpen && (
          <div className="space-y-3 border-t border-[var(--border)] p-4">
            <AgeBucketChips
              options={bucketOptions}
              value={tab}
              onChange={(next) => {
                setTab(next);
                setPage(1);
              }}
              ariaLabel="Agent-to-agent age filters"
            />

            {selected.size > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--brand)] bg-[var(--brand-subtle)] px-3.5 py-2 text-sm text-[var(--brand)]">
                <span className="font-medium tabular-nums">{selected.size} selected</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      copy(
                        items.filter((i) => selected.has(i.id)).map(buildPrompt).join('\n\n---\n\n'),
                        `Copied ${selected.size} prompts`,
                      )
                    }
                    className={`min-h-[34px] rounded-[var(--radius-sm)] px-3 text-xs font-semibold text-[var(--brand)] hover:opacity-80 ${FOCUS}`}
                  >
                    Copy prompts
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className={`min-h-[34px] rounded-[var(--radius-sm)] px-2.5 text-xs font-medium text-[var(--text-muted)] ${FOCUS}`}
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}

            <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
              <div className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-1 text-xs text-[var(--text-subtle)]">
                <label className="flex min-h-[36px] items-center">
                  <input
                    type="checkbox"
                    checked={allOnPage}
                    onChange={togglePage}
                    aria-label="Select all on this page"
                    className="h-4 w-4 accent-[var(--brand)]"
                  />
                </label>
                <span className="tabular-nums">
                  {pg.total === 0 ? 'All clear' : `${pg.total} handoff${pg.total === 1 ? '' : 's'}`}
                </span>
              </div>
              {pg.rows.length === 0 && !unavailable && (
                <p className="p-4 text-sm text-[var(--text-muted)]">
                  All clear — no agent-to-agent handoffs in this bucket.
                </p>
              )}
              <ul className="divide-y divide-[var(--border)]">
                {pg.rows.map((r: InboxItem) => {
                  const kind = classify(r, now);
                  return (
                    <li
                      key={r.id}
                      data-cockpit-item="true"
                      className="flex flex-wrap items-start gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--surface-sunken)] data-[kb-active=true]:bg-[var(--brand-subtle)]"
                    >
                      <label className="mt-1 flex items-center">
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggleSelect(r.id)}
                          aria-label={`Select handoff from ${shortName(r.from)}`}
                          className="h-4 w-4 accent-[var(--brand)]"
                        />
                      </label>
                      <div className="min-w-0 flex-1 space-y-1">
                        <button
                          type="button"
                          onClick={() => setOpen(r)}
                          className={`block w-full rounded-[var(--radius-sm)] text-left text-sm ${FOCUS}`}
                        >
                          <span className="mr-2 font-mono text-xs font-semibold text-[var(--text)]">
                            {shortName(r.from)} → {shortName(r.to)}
                          </span>
                          <span className="break-words text-[var(--text-muted)]">{r.summary}</span>
                        </button>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span
                            className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-medium ${
                              kind === 'overdue'
                                ? 'bg-[var(--danger-subtle)] text-[var(--danger)]'
                                : 'bg-[var(--surface-sunken)] text-[var(--text-muted)]'
                            }`}
                          >
                            {kind === 'overdue' ? 'overdue' : 'awaiting'}
                          </span>
                          <span className="font-mono text-[var(--text-subtle)] tabular-nums">
                            {relativeTime(r.created_at, now)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          data-kb-primary="true"
                          onClick={() => copy(buildPrompt(r), 'Prompt copied')}
                          className={`inline-flex min-h-[32px] items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 text-xs font-medium text-[var(--text)] hover:border-[var(--border-strong)] ${FOCUS}`}
                        >
                          <Copy className="h-3 w-3" aria-hidden="true" />
                          Copy prompt
                        </button>
                        <Link
                          data-kb-comment="true"
                          href={`/space/${space}/activity`}
                          className={`inline-flex min-h-[32px] items-center rounded-[var(--radius-sm)] px-2 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] ${FOCUS}`}
                        >
                          Comment
                        </Link>
                      </div>
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
                  className={`flex min-h-[36px] min-w-[36px] items-center justify-center rounded-[var(--radius-sm)] disabled:opacity-30 ${FOCUS}`}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={pg.page >= pg.pages}
                  onClick={() => setPage(pg.page + 1)}
                  className={`flex min-h-[36px] min-w-[36px] items-center justify-center rounded-[var(--radius-sm)] disabled:opacity-30 ${FOCUS}`}
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
          </div>
        )}
      </section>

      {/* Section 6: Accepted handoffs archive (collapsed by default) */}
      <section
        id="inbox-archive"
        className="scroll-mt-16 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]"
      >
        <button
          type="button"
          aria-expanded={archiveOpen}
          onClick={() => setArchiveOpen((v) => !v)}
          className={`flex min-h-[48px] w-full flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] px-4 py-2 text-left ${FOCUS}`}
        >
          <span className="flex items-center gap-2">
            <span className="font-heading text-sm font-semibold text-[var(--text)]">
              Accepted handoffs archive
            </span>
            <span className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-full bg-[var(--success-subtle)] px-2 font-mono text-xs font-semibold tabular-nums text-[var(--success)]">
              {combinedArchive.length}
            </span>
          </span>
          <span className="flex items-center gap-1 text-xs font-medium text-[var(--link)]">
            {archiveOpen ? 'Hide' : 'Expand'}
            <ChevronDown
              className={`h-4 w-4 transition-transform motion-reduce:transition-none ${archiveOpen ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </span>
        </button>

        {archiveOpen && (
          <div className="space-y-3 border-t border-[var(--border)] p-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-subtle)]"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={archiveQuery}
                  onChange={(e) => setArchiveQuery(e.target.value)}
                  placeholder="Search accepted handoffs & decisions…"
                  aria-label="Search archive"
                  className={`min-h-[36px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg)] pl-8 pr-3 text-sm text-[var(--text)] placeholder:text-[var(--text-subtle)] ${FOCUS}`}
                />
              </div>
              <select
                value={archiveAgent}
                onChange={(e) => setArchiveAgent(e.target.value)}
                aria-label="Filter archive by agent"
                className={`min-h-[36px] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-xs text-[var(--text)] ${FOCUS}`}
              >
                <option value="">All agents</option>
                {agentOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-1" role="group" aria-label="Archive date window">
                {([
                  ['all', 'All'],
                  ['1', 'Today'],
                  ['7', '7d'],
                  ['30', '30d'],
                ] as const).map(([val, lbl]) => (
                  <button
                    key={val}
                    type="button"
                    aria-pressed={archiveWindow === val}
                    onClick={() => setArchiveWindow(val)}
                    className={`min-h-[34px] rounded-full border px-2.5 text-xs font-medium ${FOCUS} ${
                      archiveWindow === val
                        ? 'border-[var(--brand)] bg-[var(--brand-subtle)] text-[var(--brand)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {sectionErrors.archive ? (
              <p role="alert" className="text-xs text-[var(--danger)]">
                {sectionErrors.archive}
              </p>
            ) : filteredArchive.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                No archive entries match these filters.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)]">
                {filteredArchive.slice(0, 40).map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-start gap-2.5 p-3">
                    <span
                      className={`mt-0.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        entry.kind === 'done'
                          ? 'bg-[var(--success-subtle)] text-[var(--success)]'
                          : entry.kind === 'decided'
                            ? 'bg-[var(--decision-subtle)] text-[var(--decision)]'
                            : 'bg-[var(--brand-subtle)] text-[var(--brand)]'
                      }`}
                    >
                      {entry.kind}
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      {renderExpandable(`arc:${entry.id}`, entry.summary, 160)}
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                        <span>
                          by <strong className="text-[var(--text)]">{shortName(entry.by)}</strong>
                        </span>
                        <span className="font-mono text-[var(--text-subtle)]">
                          {relativeTime(entry.ts, now)}
                        </span>
                        {entry.where && (
                          <span className="rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-0.5 font-mono text-[11px] break-all">
                            {entry.where.replace(/^job:/, '')}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <p role="status" className="min-h-[1rem] text-xs font-medium text-[var(--brand)]">
        {copied}
      </p>

      {/* Optimistic Undo Toast (21st.dev 35702) */}
      <InboxUndoToast
        open={undoState.open}
        message={undoState.message}
        status={undoState.status}
        onUndo={handleUndo}
        onDismiss={handleDismissUndo}
      />

      {/* Request Map Modal Dialog (Knowledge Graph + Heat Map XL with LobeHub icons) */}
      {mapOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setMapOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Request map"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[88vh] w-full max-w-4xl overflow-auto rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-3)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
              <div>
                <h2 className="font-heading text-base font-semibold text-[var(--text)]">
                  Request map
                </h2>
                <p className="text-xs text-[var(--text-muted)]">
                  Who sends requests to whom ({items.length} open across {requestMapData.agents.length} agents)
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="inline-flex rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-0.5" role="group" aria-label="Request map view">
                  <button
                    type="button"
                    aria-pressed={mapMode === 'network'}
                    onClick={() => setMapMode('network')}
                    className={`rounded-[6px] px-2.5 py-1 text-xs font-medium ${FOCUS} ${
                      mapMode === 'network'
                        ? 'bg-[var(--surface)] font-semibold text-[var(--text)] shadow-[var(--shadow-1)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                    }`}
                  >
                    Network map
                  </button>
                  <button
                    type="button"
                    aria-pressed={mapMode === 'matrix'}
                    onClick={() => setMapMode('matrix')}
                    className={`rounded-[6px] px-2.5 py-1 text-xs font-medium ${FOCUS} ${
                      mapMode === 'matrix'
                        ? 'bg-[var(--surface)] font-semibold text-[var(--text)] shadow-[var(--shadow-1)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                    }`}
                  >
                    Matrix grid
                  </button>
                </div>
                <button
                  type="button"
                  aria-label="Close request map"
                  onClick={() => setMapOpen(false)}
                  className={`flex min-h-[36px] min-w-[36px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text)] ${FOCUS}`}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="p-4">
              {map.senders.length === 0 ? (
                <p className="text-sm text-[var(--text-subtle)]">No open handoffs to map.</p>
              ) : mapMode === 'network' ? (
                <KnowledgeGraph
                  nodes={requestMapData.nodes}
                  links={requestMapData.links}
                  selectedNodeId={agentFilter}
                  onNodeClick={(nodeId) => {
                    setAgentFilter(nodeId);
                    setAgentSectionOpen(true);
                    setPage(1);
                    setMapOpen(false);
                  }}
                />
              ) : (
                <HeatMapXL
                  agents={requestMapData.agents}
                  cells={requestMapData.cells}
                  totalOpen={items.length}
                  delayedCount={requestMapData.delayedCount}
                  oldestLabel={requestMapData.oldestLabel}
                  onSelectPair={(pair) => {
                    if (pair) {
                      setAgentFilter(pair.to);
                      setAgentSectionOpen(true);
                      setPage(1);
                      setMapOpen(false);
                    }
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}

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
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close handoff details"
        onClick={onClose}
        className="fixed inset-0 bg-black/40"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Handoff details"
        className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-3)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="font-heading text-sm font-bold text-[var(--text)]">
            {shortName(item.from)} → {shortName(item.to)}
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close details"
            onClick={onClose}
            className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text)] ${FOCUS}`}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          <p className="leading-relaxed text-[var(--text)] break-words">{item.summary}</p>
          <div className="flex items-center gap-2 text-xs text-[var(--text-subtle)]">
            <span>Trail</span>
            <CopyId id={trail} />
          </div>
          <dl className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)]">
            {rows.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[96px_1fr] gap-2 px-3 py-2 text-xs">
                <dt className="text-[var(--text-subtle)]">{label}</dt>
                <dd className="break-words font-mono text-[var(--text)]">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] p-4">
          <button
            type="button"
            onClick={() => onCopy(buildPrompt(item))}
            className={`inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--on-brand)] hover:opacity-90 ${FOCUS}`}
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
            Copy prompt
          </button>
          <Link
            href={`/space/${space}/activity`}
            className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] px-3 text-sm font-medium text-[var(--text)] hover:border-[var(--border-strong)] ${FOCUS}`}
          >
            Activity
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </aside>
    </div>
  );
}
