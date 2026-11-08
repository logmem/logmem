'use client';

import { useState } from 'react';
import { Bot, CheckCircle2, Clock, AlertCircle, Copy, Check, Shield } from 'lucide-react';

interface AgentRosterItem {
  id: string;
  name: string;
  role: string;
  status: 'active' | 'quiet' | 'blocked';
  doing: string;
  lastSeen: string;
  slots: {
    morning: 'pass' | 'partial' | 'pending' | 'missed';
    midday: 'pass' | 'partial' | 'pending' | 'missed';
    closeout: 'pass' | 'partial' | 'pending' | 'missed';
  };
  capabilities: string[];
}

export default function AgentsPage({ params }: { params: { space: string } }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const agents: AgentRosterItem[] = [
    {
      id: 'gemini-app',
      name: 'Gemini App',
      role: 'Workspace integration, clean-room testing, and architecture research',
      status: 'active',
      doing: 'Connected folder /Users/michaelshaw/clawd active; executing Next.js dashboard views',
      lastSeen: '1m ago',
      slots: { morning: 'pass', midday: 'pending', closeout: 'pending' },
      capabilities: ['workspace-tools', 'clean-room-testing', 'architecture-research'],
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      role: 'Primary frontend engineer and platform architecture',
      status: 'active',
      doing: 'Standby following PR 250 Agent Access screen merge',
      lastSeen: '12m ago',
      slots: { morning: 'pass', midday: 'pending', closeout: 'pending' },
      capabilities: ['typescript-cli', 'frontend-review', 'pr-authoring'],
    },
    {
      id: 'codex',
      name: 'Codex',
      role: 'Code review, Layer 0 safety enforcement, and test verification',
      status: 'active',
      doing: 'Reviewing PR 238 scanner match redaction and PR 239 admin secret mapping',
      lastSeen: '25m ago',
      slots: { morning: 'pass', midday: 'pending', closeout: 'pending' },
      capabilities: ['static-analysis', 'safety-audit', 'contract-tests'],
    },
    {
      id: 'muse',
      name: 'Muse',
      role: 'QA testing, design direction, and marketing asset orchestration',
      status: 'active',
      doing: 'Executing single production QA pass across 390px and 1440px on main',
      lastSeen: '34m ago',
      slots: { morning: 'pass', midday: 'pending', closeout: 'pending' },
      capabilities: ['mobile-qa', 'asset-production', 'visual-review'],
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      role: 'Self-host bundle distribution and infrastructure operations',
      status: 'active',
      doing: 'PR 252 open (1272 tests passing); awaiting host key confirmation',
      lastSeen: '1h ago',
      slots: { morning: 'pass', midday: 'pending', closeout: 'pending' },
      capabilities: ['docker-compose', 'self-host', 'secrets-loader'],
    },
  ];

  const slotBadge = (status: 'pass' | 'partial' | 'pending' | 'missed') => {
    switch (status) {
      case 'pass':
        return <span className="px-2 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] font-bold bg-[#E2F1E5] text-[#1E6B35] dark:bg-[#0F2618] dark:text-[#5DC47C]">Pass</span>;
      case 'partial':
        return <span className="px-2 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] font-bold bg-[#FBEED6] text-[#875100] dark:bg-[#2C1F08] dark:text-[#E8A746]">Partial</span>;
      case 'pending':
        return <span className="px-2 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] font-medium bg-[#EAEEEC] text-[#5C6966] dark:bg-[#19231F]">Pending</span>;
      case 'missed':
        return <span className="px-2 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] font-bold bg-[#FBE6E3] text-[#B42318] dark:bg-[#341411] dark:text-[#F47A66]">Missed</span>;
    }
  };

  return (
    <div className="space-y-6 font-sans">
      {/* Page Title */}
      <div className="pb-4 border-b border-[#D3DAD8] dark:border-[#2B3835]">
        <h1 className="text-2xl font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
          Agents
        </h1>
        <p className="text-sm text-[#46534F] dark:text-[#B3BEBA] mt-1">
          Who is doing what, and whether they report.
        </p>
      </div>

      {/* Telemetry Caution Notice (ASD-STE100 Principle) */}
      <div className="p-3.5 bg-[#F4F6F5] dark:bg-[#121A19] border border-[#D3DAD8] dark:border-[#2B3835] rounded-lg flex items-center justify-between text-xs font-['IBM_Plex_Mono']">
        <span className="text-[#5C6966] dark:text-[#97A4A0]">
          5 of 5 agents reported in the last 60 minutes. Reporting activity does not prove a running process.
        </span>
        <span className="text-[#0E6863] dark:text-[#4FC3B8] font-semibold">3 daily sync slots</span>
      </div>

      {/* Fleet Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {agents.map((a) => (
          <div
            key={a.id}
            className="p-5 border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] rounded-lg shadow-sm space-y-4"
          >
            {/* Header: Name & Role */}
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-['IBM_Plex_Mono'] font-bold text-sm text-[#0E6863] dark:text-[#4FC3B8]">
                    @{a.id}
                  </span>
                  <span className="w-2 h-2 rounded-full bg-[#1E6B35] inline-block animate-pulse" />
                </div>
                <h3 className="text-xs text-[#5C6966] dark:text-[#97A4A0] mt-0.5">{a.role}</h3>
              </div>
              <span className="text-[11px] font-['IBM_Plex_Mono'] text-[#5C6966]">
                Reported {a.lastSeen}
              </span>
            </div>

            {/* Now: Doing Box */}
            <div className="p-3 bg-[#F4F6F5] dark:bg-[#080D0C] border border-[#D3DAD8] dark:border-[#2B3835] rounded-md space-y-1">
              <span className="text-[10px] font-['IBM_Plex_Mono'] text-[#5C6966] uppercase font-semibold">
                Now State
              </span>
              <p className="text-xs font-['IBM_Plex_Mono'] text-[#121A19] dark:text-[#E9EEEC] leading-relaxed">
                {a.doing}
              </p>
            </div>

            {/* Daily Coordination Slots (Receipts) */}
            <div className="space-y-1.5 pt-1 border-t border-[#D3DAD8]/50 dark:border-[#2B3835]/50">
              <span className="text-[10px] font-['IBM_Plex_Mono'] text-[#5C6966] uppercase font-semibold block">
                Daily Coordination Slots (America/New_York)
              </span>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="p-2 border border-[#D3DAD8] dark:border-[#2B3835] rounded bg-white dark:bg-[#121A19]">
                  <span className="block text-[10px] font-['IBM_Plex_Mono'] text-[#5C6966] mb-1">Morning 09:00</span>
                  {slotBadge(a.slots.morning)}
                </div>
                <div className="p-2 border border-[#D3DAD8] dark:border-[#2B3835] rounded bg-white dark:bg-[#121A19]">
                  <span className="block text-[10px] font-['IBM_Plex_Mono'] text-[#5C6966] mb-1">Midday 13:00</span>
                  {slotBadge(a.slots.midday)}
                </div>
                <div className="p-2 border border-[#D3DAD8] dark:border-[#2B3835] rounded bg-white dark:bg-[#121A19]">
                  <span className="block text-[10px] font-['IBM_Plex_Mono'] text-[#5C6966] mb-1">Closeout 17:30</span>
                  {slotBadge(a.slots.closeout)}
                </div>
              </div>
            </div>

            {/* Capabilities Tags */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {a.capabilities.map((c) => (
                <span
                  key={c}
                  className="px-2 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] bg-[#F4F6F5] dark:bg-[#19231F] text-[#46534F] dark:text-[#B3BEBA] border border-[#D3DAD8]/60 dark:border-[#2B3835]/60"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
