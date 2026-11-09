'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { Inbox, Briefcase, Bot, Activity, KeyRound, Settings, ChevronDown, CalendarDays } from 'lucide-react';

interface NavRailProps {
  space: string;
}

export function NavRail({ space }: NavRailProps) {
  const pathname = usePathname();

  const links = [
    { href: `/${space}/today`, label: 'Today', icon: Inbox, badge: '1', badgeColor: 'bg-[#6B3FA0] text-white' },
    { href: `/${space}/schedule`, label: 'Schedule', icon: CalendarDays, badge: '3', badgeColor: 'bg-[#0E6863] text-white' },
    { href: `/${space}/work`, label: 'Work', icon: Briefcase, badge: '12', badgeColor: 'bg-surface-sunken text-text-subtle' },
    { href: `/${space}/agents`, label: 'Agents', icon: Bot, badge: '5', badgeColor: 'bg-surface-sunken text-text-subtle' },
    { href: `/${space}/activity`, label: 'Activity', icon: Activity },
    { href: `/${space}/access`, label: 'Agent access', icon: KeyRound },
  ];

  return (
    <>
      {/* 232px Desktop Rail */}
      <aside className="hidden md:flex flex-col w-[232px] border-r border-[#D3DAD8] dark:border-[#2B3835] bg-[#FFFFFF] dark:bg-[#121A19] shrink-0 h-screen sticky top-0 font-sans">
        {/* Brand Lockup */}
        <div className="h-14 flex items-center px-4 border-b border-[#D3DAD8] dark:border-[#2B3835] justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="font-['Schibsted_Grotesk'] font-extrabold text-lg tracking-tight text-[#0E6863] dark:text-[#4FC3B8]">
              LogMem
            </span>
            <span className="text-[10px] uppercase font-['IBM_Plex_Mono'] px-1.5 py-0.5 rounded bg-[#DDF1EE] dark:bg-[#0F2D2A] text-[#0E6863] dark:text-[#4FC3B8] font-semibold">
              v0.1.0
            </span>
          </Link>
        </div>

        {/* Space Selector & Telemetry Heartbeat */}
        <div className="p-3 border-b border-[#D3DAD8] dark:border-[#2B3835]">
          <div className="flex items-center justify-between px-2 py-1.5 rounded border border-[#D3DAD8] dark:border-[#2B3835] bg-[#F4F6F5] dark:bg-[#080D0C] text-xs font-['IBM_Plex_Mono']">
            <span className="font-semibold text-[#121A19] dark:text-[#E9EEEC] truncate">space:{space}</span>
            <ChevronDown className="w-3.5 h-3.5 text-[#5C6966]" />
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[#5C6966] dark:text-[#97A4A0] font-['IBM_Plex_Mono']">
            <span className="w-2 h-2 rounded-full bg-[#1E6B35] dark:bg-[#5DC47C] inline-block animate-pulse" />
            <span>Workspace data connected</span>
          </div>
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
          {links.map((link) => {
            const active = pathname?.startsWith(link.href);
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center justify-between px-3 py-2 rounded-md text-xs font-medium transition-colors ${
                  active
                    ? 'bg-[#DDF1EE] dark:bg-[#0F2D2A] text-[#0E6863] dark:text-[#4FC3B8] font-semibold'
                    : 'text-[#46534F] dark:text-[#B3BEBA] hover:bg-[#F4F6F5] dark:hover:bg-[#19231F] hover:text-[#121A19] dark:hover:text-[#E9EEEC]'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className={`w-4 h-4 ${active ? 'text-[#0E6863] dark:text-[#4FC3B8]' : 'text-[#5C6966]'}`} />
                  <span>{link.label}</span>
                </div>
                {link.badge && (
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] font-bold ${link.badgeColor || 'bg-[#EAEEEC] text-[#46534F]'}`}>
                    {link.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-[#D3DAD8] dark:border-[#2B3835] flex items-center justify-between text-xs text-[#5C6966] font-['IBM_Plex_Mono']">
          <span className="truncate">{space}</span>
          <UserButton afterSignOutUrl="/sign-in" />
        </div>
      </aside>

      {/* Mobile Bottom Navigation (<768px, 44px min tap target) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-14 bg-[#FFFFFF] dark:bg-[#121A19] border-t border-[#D3DAD8] dark:border-[#2B3835] flex items-center justify-around z-50 px-2 font-sans">
        {links.map((link) => {
          const active = pathname?.startsWith(link.href);
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex flex-col items-center justify-center min-w-[44px] min-h-[44px] gap-0.5 text-[10px] ${
                active ? 'text-[#0E6863] dark:text-[#4FC3B8] font-semibold' : 'text-[#5C6966]'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{link.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
