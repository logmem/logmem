'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { UserButton } from '@clerk/nextjs';
import {
  Activity,
  Bot,
  Briefcase,
  CalendarDays,
  Check,
  ChevronDown,
  Inbox,
  KeyRound,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Upload,
  X,
} from 'lucide-react';

export interface SwitcherSpace {
  id: string;
  name: string;
  workspaceName: string;
  role: string;
}

interface NavRailProps {
  space: string;
  spaceName: string;
  spaces?: SwitcherSpace[];
  canCreateSpace?: boolean;
  canImport?: boolean;
}

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

export function NavRail({
  space,
  spaceName,
  spaces = [],
  canCreateSpace = false,
  canImport = false,
}: NavRailProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  useEffect(() => {
    if (!switcherOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSwitcherOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [switcherOpen]);

  const primaryLinks = [
    { href: `/space/${space}/today`, label: 'Brief', icon: Inbox },
    { href: `/space/${space}/inbox`, label: 'Inbox', icon: Mail },
    { href: `/space/${space}/activity`, label: 'Activity', icon: Activity },
    { href: `/space/${space}/chat`, label: 'Chat', icon: MessageSquare },
    { href: `/space/${space}/work`, label: 'Work', icon: Briefcase },
    { href: `/space/${space}/agents`, label: 'Agents', icon: Bot },
  ];

  const secondaryLinks = [
    { href: `/space/${space}/schedule`, label: 'Schedule', icon: CalendarDays },
    { href: `/space/${space}/access`, label: 'Agent access', icon: KeyRound },
    { href: `/space/${space}/settings`, label: 'Space settings', icon: Settings },
  ];

  const mobileTabs = [
    { href: `/space/${space}/today`, label: 'Brief', icon: Inbox },
    { href: `/space/${space}/inbox`, label: 'Inbox', icon: Mail },
    { href: `/space/${space}/chat`, label: 'Chat', icon: MessageSquare },
    { href: `/space/${space}/work`, label: 'Work', icon: Briefcase },
  ];

  const moreLinks = [
    { href: `/space/${space}/activity`, label: 'Activity', icon: Activity },
    { href: `/space/${space}/agents`, label: 'Agents', icon: Bot },
    { href: `/space/${space}/schedule`, label: 'Schedule', icon: CalendarDays },
    { href: `/space/${space}/access`, label: 'Agent access', icon: KeyRound },
    { href: `/space/${space}/settings`, label: 'Space settings', icon: Settings },
  ];

  const q = switcherQuery.trim().toLowerCase();
  const filteredSpaces = q
    ? spaces.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.workspaceName.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q),
      )
    : spaces;

  const isActive = (href: string) => pathname === href || pathname?.startsWith(`${href}/`);
  const inMore = moreLinks.some((l) => isActive(l.href));

  return (
    <>
      <aside
        aria-label="LogMem navigation"
        className="sticky top-0 hidden h-screen w-[var(--rail-width)] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] font-sans md:flex"
      >
        <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4">
          <Link href="/select-space" className={`flex items-center gap-2 rounded-[var(--radius-sm)] ${FOCUS}`}>
            <span className="font-heading text-lg font-extrabold tracking-tight text-[var(--brand)]">
              LogMem
            </span>
          </Link>
        </div>

        <div ref={switcherRef} className="relative border-b border-[var(--border)] p-3">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            onClick={() => setSwitcherOpen((o) => !o)}
            className={`flex min-h-[36px] w-full items-center justify-between rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-1.5 font-mono text-xs transition-colors hover:border-[var(--border-strong)] ${FOCUS}`}
          >
            <span className="truncate font-semibold text-[var(--text)]">{spaceName}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-subtle)]" aria-hidden="true" />
          </button>

          {switcherOpen ? (
            <div
              role="menu"
              aria-label="Switch space"
              className="absolute left-3 right-3 top-14 z-50 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface)] p-2 shadow-lg space-y-2"
            >
              {spaces.length > 1 ? (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[var(--text-subtle)]" aria-hidden="true" />
                  <input
                    type="search"
                    value={switcherQuery}
                    onChange={(e) => setSwitcherQuery(e.target.value)}
                    placeholder="Filter spaces…"
                    aria-label="Filter spaces"
                    className={`min-h-[34px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] pl-8 pr-2 text-xs text-[var(--text)] ${FOCUS}`}
                  />
                </div>
              ) : null}

              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {filteredSpaces.length > 0 ? (
                  filteredSpaces.map((s) => {
                    const current = s.id === space;
                    return (
                      <Link
                        key={s.id}
                        href={`/space/${s.id}/today`}
                        onClick={() => setSwitcherOpen(false)}
                        className={`flex min-h-[36px] items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs transition-colors ${FOCUS} ${
                          current
                            ? 'bg-[var(--brand-subtle)] font-semibold text-[var(--brand)]'
                            : 'text-[var(--text)] hover:bg-[var(--surface-sunken)]'
                        }`}
                      >
                        <span className="truncate">{s.name}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className="font-mono text-[10px] text-[var(--text-subtle)]">{s.role}</span>
                          {current ? <Check className="h-3.5 w-3.5 text-[var(--brand)]" aria-hidden="true" /> : null}
                        </span>
                      </Link>
                    );
                  })
                ) : (
                  <p className="px-2 py-2 text-xs text-[var(--text-muted)]">No matching spaces.</p>
                )}
              </div>

              <div className="space-y-1 border-t border-[var(--border)] pt-2">
                {canCreateSpace ? (
                  <Link
                    href="/select-space?create=1"
                    onClick={() => setSwitcherOpen(false)}
                    className={`flex min-h-[34px] items-center gap-2 rounded-[var(--radius-sm)] px-2.5 text-xs font-medium text-[var(--text)] hover:bg-[var(--surface-sunken)] ${FOCUS}`}
                  >
                    <Plus className="h-3.5 w-3.5 text-[var(--brand)]" aria-hidden="true" />
                    <span>New space</span>
                  </Link>
                ) : null}
                {canImport ? (
                  <Link
                    href={`/space/${space}/settings?tab=import`}
                    onClick={() => setSwitcherOpen(false)}
                    className={`flex min-h-[34px] items-center gap-2 rounded-[var(--radius-sm)] px-2.5 text-xs font-medium text-[var(--text)] hover:bg-[var(--surface-sunken)] ${FOCUS}`}
                  >
                    <Upload className="h-3.5 w-3.5 text-[var(--brand)]" aria-hidden="true" />
                    <span>Import space</span>
                  </Link>
                ) : null}
                <Link
                  href="/select-space"
                  onClick={() => setSwitcherOpen(false)}
                  className={`flex min-h-[34px] items-center rounded-[var(--radius-sm)] px-2.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)] ${FOCUS}`}
                >
                  All spaces
                </Link>
              </div>
            </div>
          ) : null}
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3" aria-label="Workspace">
          {primaryLinks.map((link) => {
            const active = isActive(link.href);
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-[36px] items-center justify-between rounded-[var(--radius-md)] px-3 py-2 text-xs font-medium transition-colors ${FOCUS} ${
                  active
                    ? 'bg-[var(--brand-subtle)] font-semibold text-[var(--brand)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    className={`h-4 w-4 ${active ? 'text-[var(--brand)]' : 'text-[var(--text-subtle)]'}`}
                    aria-hidden="true"
                  />
                  <span>{link.label}</span>
                </span>
              </Link>
            );
          })}

          <div className="my-2 border-t border-[var(--border)]" role="separator" />

          {secondaryLinks.map((link) => {
            const active = isActive(link.href);
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-[36px] items-center justify-between rounded-[var(--radius-md)] px-3 py-2 text-xs font-medium transition-colors ${FOCUS} ${
                  active
                    ? 'bg-[var(--brand-subtle)] font-semibold text-[var(--brand)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    className={`h-4 w-4 ${active ? 'text-[var(--brand)]' : 'text-[var(--text-subtle)]'}`}
                    aria-hidden="true"
                  />
                  <span>{link.label}</span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center justify-between border-t border-[var(--border)] p-3 font-mono text-xs text-[var(--text-subtle)]">
          <span className="truncate">space:{space}</span>
          <UserButton />
        </div>
      </aside>

      {/* Mobile 5-tab bar: Brief · Inbox · Chat · Work · More */}
      <nav
        aria-label="Space menu"
        className="fixed bottom-0 left-0 right-0 z-40 grid h-14 grid-cols-5 border-t border-[var(--border)] bg-[var(--surface)] px-1 font-sans md:hidden"
      >
        {mobileTabs.map((link) => {
          const active = isActive(link.href);
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              className={`flex min-h-[44px] flex-col items-center justify-center gap-0.5 rounded-[var(--radius-sm)] text-[11px] ${FOCUS} ${
                active ? 'font-semibold text-[var(--brand)]' : 'text-[var(--text-muted)]'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{link.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          aria-expanded={moreOpen}
          aria-controls="mobile-more-sheet"
          onClick={() => setMoreOpen((v) => !v)}
          className={`flex min-h-[44px] flex-col items-center justify-center gap-0.5 rounded-[var(--radius-sm)] text-[11px] ${FOCUS} ${
            moreOpen || inMore ? 'font-semibold text-[var(--brand)]' : 'text-[var(--text-muted)]'
          }`}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          <span>More</span>
        </button>
      </nav>

      {/* Accessible More sheet for mobile */}
      {moreOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/40 md:hidden"
          onClick={() => setMoreOpen(false)}
        >
          <div
            id="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More workspace pages"
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded-t-[var(--radius-lg)] border-t border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-3)]"
          >
            <div className="mb-3 flex items-center justify-between border-b border-[var(--border)] pb-3">
              <span className="font-heading text-base font-bold text-[var(--text)]">More</span>
              <button
                ref={closeRef}
                type="button"
                aria-label="Close menu"
                onClick={() => setMoreOpen(false)}
                className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-md)] text-[var(--text-muted)] ${FOCUS}`}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div className="space-y-1">
              {moreLinks.map((link) => {
                const active = isActive(link.href);
                const Icon = link.icon;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setMoreOpen(false)}
                    className={`flex min-h-[44px] items-center gap-3 rounded-[var(--radius-md)] px-3 text-sm font-medium ${FOCUS} ${
                      active
                        ? 'bg-[var(--brand-subtle)] font-semibold text-[var(--brand)]'
                        : 'text-[var(--text)] hover:bg-[var(--surface-sunken)]'
                    }`}
                  >
                    <Icon className="h-4 w-4 text-[var(--text-subtle)]" aria-hidden="true" />
                    <span>{link.label}</span>
                  </Link>
                );
              })}
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-3">
              <Link
                href="/select-space"
                onClick={() => setMoreOpen(false)}
                className={`flex min-h-[44px] items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 font-mono text-xs text-[var(--text)] ${FOCUS}`}
              >
                <span>{spaceName}</span>
                <ChevronDown className="h-3.5 w-3.5 text-[var(--text-subtle)]" aria-hidden="true" />
              </Link>
              <UserButton />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
