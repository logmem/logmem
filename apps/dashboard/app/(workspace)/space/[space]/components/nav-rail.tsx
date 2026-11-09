'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Inbox, Briefcase, Bot, Activity, KeyRound, ChevronDown, CalendarDays } from 'lucide-react';

interface NavRailProps {
  space: string;
  spaceName: string;
}

export function NavRail({ space, spaceName }: NavRailProps) {
  const pathname = usePathname();

  const links = [
    { href: `/space/${space}/today`, label: 'Today', icon: Inbox },
    { href: `/space/${space}/schedule`, label: 'Schedule', icon: CalendarDays },
    { href: `/space/${space}/work`, label: 'Work', icon: Briefcase },
    { href: `/space/${space}/agents`, label: 'Agents', icon: Bot },
    { href: `/space/${space}/activity`, label: 'Activity', icon: Activity },
    { href: `/space/${space}/access`, label: 'Agent access', icon: KeyRound },
  ];

  return (
    <>
      <aside className="hidden md:flex flex-col w-[232px] border-r border-[#D3DAD8] dark:border-[#2B3835] bg-[#FFFFFF] dark:bg-[#121A19] shrink-0 h-screen sticky top-0 font-sans">
        <div className="h-14 flex items-center px-4 border-b border-[#D3DAD8] dark:border-[#2B3835] justify-between">
          <Link href="/select-space" className="flex items-center gap-2">
            <span className="font-['Schibsted_Grotesk'] font-extrabold text-lg tracking-tight text-[#0E6863] dark:text-[#4FC3B8]">
              LogMem
            </span>
          </Link>
        </div>

        <div className="p-3 border-b border-[#D3DAD8] dark:border-[#2B3835]">
          <Link
            href="/select-space"
            className="flex items-center justify-between px-2 py-1.5 rounded border border-[#D3DAD8] dark:border-[#2B3835] bg-[#F4F6F5] dark:bg-[#080D0C] text-xs font-['IBM_Plex_Mono']"
          >
            <span className="font-semibold text-[#121A19] dark:text-[#E9EEEC] truncate">{spaceName}</span>
            <ChevronDown className="w-3.5 h-3.5 text-[#5C6966]" />
          </Link>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
          {links.map((link) => {
            const active = pathname === link.href || pathname?.startsWith(`${link.href}/`);
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
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-[#D3DAD8] dark:border-[#2B3835] flex items-center justify-end text-xs text-[#5C6966] font-['IBM_Plex_Mono']">
          <a href="/api/logout" className="hover:text-[#121A19] dark:hover:text-[#E9EEEC]">Sign out</a>
        </div>
      </aside>

      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-14 bg-[#FFFFFF] dark:bg-[#121A19] border-t border-[#D3DAD8] dark:border-[#2B3835] flex items-center justify-around z-50 px-2 font-sans">
        {links.map((link) => {
          const active = pathname === link.href || pathname?.startsWith(`${link.href}/`);
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
