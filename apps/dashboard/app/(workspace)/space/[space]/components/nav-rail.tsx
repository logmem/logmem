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
  ChevronDown,
  Inbox,
  KeyRound,
  Mail,
  MessageSquare,
  MoreHorizontal,
  X,
} from 'lucide-react';

interface NavRailProps {
  space: string;
  spaceName: string;
}

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

export function NavRail({ space, spaceName }: NavRailProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

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
  ];

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

        <div className="border-b border-[var(--border)] p-3">
          <Link
            href="/select-space"
            className={`flex min-h-[36px] items-center justify-between rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-1.5 font-mono text-xs transition-colors hover:border-[var(--border-strong)] ${FOCUS}`}
          >
            <span className="truncate font-semibold text-[var(--text)]">{spaceName}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-subtle)]" aria-hidden="true" />
          </Link>
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
