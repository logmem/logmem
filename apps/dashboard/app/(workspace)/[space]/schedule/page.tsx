'use client';

import { useState } from 'react';
import { CalendarDays, Clock, Play, CheckCircle2, AlertTriangle, Users, ArrowRightLeft, Sparkles, Filter, X, ChevronLeft, ChevronRight } from 'lucide-react';

interface Shift {
  id: string;
  agent: string;
  station: 'Engineering' | 'Review' | 'QA' | 'Webmaster' | 'Ops';
  type: 'coordination-slot' | 'handoff-clearing' | 'deep-drive' | 'roundtable';
  title: string;
  startTime: string;
  endTime: string;
  status: 'scheduled' | 'active' | 'completed' | 'missed';
  budgetCap: string;
  spent?: string;
  receiptId?: string;
  recapNotes?: string;
}

export default function SchedulePage({ params }: { params: { space: string } }) {
  const [selectedShift, setSelectedShift] = useState<Shift | null>(null);
  const [activeStationFilter, setActiveStationFilter] = useState<string>('all');
  const [isClockInModalOpen, setIsClockInModalOpen] = useState(false);

  const shifts: Shift[] = [
    {
      id: 'sh-001',
      agent: 'gemini-app',
      station: 'Webmaster',
      type: 'coordination-slot',
      title: 'Morning Coordination Kickoff & Sync Receipt',
      startTime: '09:00',
      endTime: '09:15',
      status: 'completed',
      budgetCap: '$0.10',
      spent: '$0.02',
      receiptId: 'sync_c5bb020114f3fb6d19dafb26',
      recapNotes: 'Verified pass receipt. Workspace connected. Unblocked local repo status.',
    },
    {
      id: 'sh-002',
      agent: 'gemini-app',
      station: 'Webmaster',
      type: 'deep-drive',
      title: 'Next.js 14 Dashboard Workspace Scaffolding',
      startTime: '09:30',
      endTime: '11:00',
      status: 'active',
      budgetCap: '$0.50',
      spent: '$0.18',
      recapNotes: 'Scaffolded 1:1 NavRail, DecisionDrawer, Today, Access, Work, and Agents screens.',
    },
    {
      id: 'sh-003',
      agent: 'codex',
      station: 'Review',
      type: 'handoff-clearing',
      title: 'Layer 0 Safety Review & PR 238/239 Audit',
      startTime: '09:45',
      endTime: '10:15',
      status: 'completed',
      budgetCap: '$0.20',
      spent: '$0.08',
      receiptId: 'codexShift-1794081625038',
      recapNotes: 'Rechecked PR 238 at 1902a55. Logged scanner text match finding.',
    },
    {
      id: 'sh-004',
      agent: 'muse',
      station: 'QA',
      type: 'deep-drive',
      title: 'Production Phone & Desktop Bundle QA Pass',
      startTime: '11:00',
      endTime: '12:30',
      status: 'active',
      budgetCap: '$0.40',
      spent: '$0.12',
      recapNotes: 'Testing main at 390px mobile and 1440px desktop across #/access and Settings.',
    },
    {
      id: 'sh-005',
      agent: 'claude-code',
      station: 'Engineering',
      type: 'coordination-slot',
      title: 'Midday Cross-Fleet Blocker Check',
      startTime: '13:00',
      endTime: '13:15',
      status: 'scheduled',
      budgetCap: '$0.10',
    },
    {
      id: 'sh-006',
      agent: 'opencode',
      station: 'Ops',
      type: 'deep-drive',
      title: 'Self-Host Bundle Verification & SSH Reconnect',
      startTime: '14:00',
      endTime: '15:30',
      status: 'scheduled',
      budgetCap: '$0.30',
    },
    {
      id: 'sh-007',
      agent: 'gemini-app',
      station: 'Webmaster',
      type: 'roundtable',
      title: 'Cross-Agent Super Bus Architecture Roundtable',
      startTime: '16:00',
      endTime: '17:00',
      status: 'scheduled',
      budgetCap: '$0.50',
    },
    {
      id: 'sh-008',
      agent: 'codex',
      station: 'Review',
      type: 'coordination-slot',
      title: 'Closeout & 7-Day Gate Audit Handover',
      startTime: '17:30',
      endTime: '17:45',
      status: 'scheduled',
      budgetCap: '$0.10',
    },
  ];

  const typeColor = (type: Shift['type']) => {
    switch (type) {
      case 'coordination-slot':
        return 'bg-[#DDF1EE] text-[#0E6863] dark:bg-[#0F2D2A] dark:text-[#4FC3B8] border-[#0E6863]/30';
      case 'handoff-clearing':
        return 'bg-[#E6ECFC] text-[#2453D6] dark:bg-[#121C38] dark:text-[#86A6FF] border-[#2453D6]/30';
      case 'deep-drive':
        return 'bg-[#F1EAF8] text-[#6B3FA0] dark:bg-[#231637] dark:text-[#C6A0F0] border-[#6B3FA0]/30';
      case 'roundtable':
        return 'bg-[#FBEED6] text-[#875100] dark:bg-[#2C1F08] dark:text-[#E8A746] border-[#875100]/30';
    }
  };

  const statusBadge = (status: Shift['status']) => {
    switch (status) {
      case 'completed':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] font-bold bg-[#E2F1E5] text-[#1E6B35] dark:bg-[#0F2618] dark:text-[#5DC47C]"><CheckCircle2 className="w-3 h-3" /> Pass</span>;
      case 'active':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] font-bold bg-[#E2F1E5] text-[#1E6B35] dark:bg-[#0F2618] dark:text-[#5DC47C]"><span className="w-1.5 h-1.5 rounded-full bg-[#1E6B35] animate-ping" /> Clocked In</span>;
      case 'scheduled':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] font-medium bg-[#EAEEEC] text-[#5C6966] dark:bg-[#19231F]">Scheduled</span>;
      case 'missed':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] font-bold bg-[#FBE6E3] text-[#B42318] dark:bg-[#341411] dark:text-[#F47A66]">Missed</span>;
    }
  };

  const filtered = shifts.filter((s) => activeStationFilter === 'all' || s.station.toLowerCase() === activeStationFilter.toLowerCase());

  return (
    <div className="space-y-6 font-sans">
      {/* Page Title & Shift Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#D3DAD8] dark:border-[#2B3835]">
        <div>
          <span className="text-xs font-['IBM_Plex_Mono'] text-[#5C6966] dark:text-[#97A4A0] uppercase tracking-wider block mb-1">
            Workforce Management · Space {params.space}
          </span>
          <h1 className="text-2xl font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
            Agent Shift Scheduler
          </h1>
          <p className="text-sm text-[#46534F] dark:text-[#B3BEBA] mt-1">
            Homebase-style shift planning, coordination cadence, and work sessions for autonomous agents.
          </p>
        </div>

        {/* Supervisor Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsClockInModalOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-[#0E6863] dark:bg-[#4FC3B8] text-white dark:text-[#121A19] text-xs font-semibold rounded-md hover:opacity-90 transition-opacity"
          >
            <Play className="w-3.5 h-3.5 fill-current" /> Clock In Agent
          </button>
        </div>
      </div>

      {/* Daily Coordination Slot Banner (Standard Cadence) */}
      <div className="p-4 rounded-lg border border-[#0E6863]/30 dark:border-[#4FC3B8]/30 bg-[#DDF1EE]/40 dark:bg-[#0F2D2A]/40 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-['IBM_Plex_Mono'] font-bold text-[#0E6863] dark:text-[#4FC3B8] uppercase">
            Today’s Coordination Cadence (America/New_York)
          </span>
          <span className="text-xs text-[#5C6966] font-['IBM_Plex_Mono']">Nov 8, 2026</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="p-3 bg-white dark:bg-[#121A19] rounded-md border border-[#D3DAD8] dark:border-[#2B3835] space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-text">Morning Slot (09:00 EST)</span>
              <span className="text-[10px] font-['IBM_Plex_Mono'] font-bold text-[#1E6B35]">PASS</span>
            </div>
            <p className="text-[11px] text-[#46534F] dark:text-[#B3BEBA]">
              Kickoff & sync receipt logged. Local workspace active and unblocked.
            </p>
          </div>
          <div className="p-3 bg-white dark:bg-[#121A19] rounded-md border border-[#D3DAD8] dark:border-[#2B3835] space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-text">Midday Slot (13:00 EST)</span>
              <span className="text-[10px] font-['IBM_Plex_Mono'] font-medium text-[#5C6966]">UPCOMING</span>
            </div>
            <p className="text-[11px] text-[#46534F] dark:text-[#B3BEBA]">
              Mid-flight blocker triage & PR 252 code review alignment.
            </p>
          </div>
          <div className="p-3 bg-white dark:bg-[#121A19] rounded-md border border-[#D3DAD8] dark:border-[#2B3835] space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-text">Closeout Slot (17:30 EST)</span>
              <span className="text-[10px] font-['IBM_Plex_Mono'] font-medium text-[#5C6966]">UPCOMING</span>
            </div>
            <p className="text-[11px] text-[#46534F] dark:text-[#B3BEBA]">
              Shift recaps, 7-day gate receipt filing, overnight task handovers.
            </p>
          </div>
        </div>
      </div>

      {/* Station Filters */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {['all', 'Engineering', 'Review', 'QA', 'Webmaster', 'Ops'].map((station) => (
          <button
            key={station}
            onClick={() => setActiveStationFilter(station)}
            className={`px-3 py-1.5 rounded-md border font-medium transition-colors ${
              activeStationFilter.toLowerCase() === station.toLowerCase()
                ? 'bg-[#0E6863] dark:bg-[#4FC3B8] text-white dark:text-[#121A19] border-[#0E6863] dark:border-[#4FC3B8] font-semibold'
                : 'bg-white dark:bg-[#121A19] border-[#D3DAD8] dark:border-[#2B3835] text-[#46534F] dark:text-[#B3BEBA] hover:border-[#7A8784]'
            }`}
          >
            {station === 'all' ? 'All Stations' : `Station: ${station}`}
          </button>
        ))}
      </div>

      {/* Shift Roster Table / Schedule Grid */}
      <div className="border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] rounded-lg overflow-hidden shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#F4F6F5] dark:bg-[#19231F] border-b border-[#D3DAD8] dark:border-[#2B3835] text-xs text-[#5C6966] dark:text-[#97A4A0] font-['IBM_Plex_Mono'] uppercase">
            <tr>
              <th className="px-4 py-2.5">Time</th>
              <th className="px-4 py-2.5">Agent</th>
              <th className="px-4 py-2.5">Station & Shift Type</th>
              <th className="px-4 py-2.5">Scheduled Task</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Budget</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#D3DAD8] dark:divide-[#2B3835]">
            {filtered.map((s) => (
              <tr
                key={s.id}
                onClick={() => setSelectedShift(s)}
                className="hover:bg-[#F4F6F5]/60 dark:hover:bg-[#19231F]/60 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3 font-['IBM_Plex_Mono'] text-xs font-semibold text-[#121A19] dark:text-[#E9EEEC] whitespace-nowrap">
                  {s.startTime} – {s.endTime}
                </td>
                <td className="px-4 py-3 font-['IBM_Plex_Mono'] font-bold text-[#0E6863] dark:text-[#4FC3B8] whitespace-nowrap">
                  @{s.agent}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-text">{s.station}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] font-semibold border ${typeColor(s.type)}`}>
                      {s.type}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-[#121A19] dark:text-[#E9EEEC] font-medium max-w-md truncate">
                  {s.title}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {statusBadge(s.status)}
                </td>
                <td className="px-4 py-3 text-right font-['IBM_Plex_Mono'] text-xs text-[#5C6966] whitespace-nowrap">
                  {s.spent ? <span className="text-text font-semibold">{s.spent}</span> : '—'} / {s.budgetCap}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Shift Detail Drawer */}
      {selectedShift && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm animate-in fade-in duration-150 font-sans">
          <div className="w-full max-w-lg bg-white dark:bg-[#121A19] border-l border-[#D3DAD8] dark:border-[#2B3835] h-full flex flex-col shadow-2xl">
            <div className="p-4 border-b border-[#D3DAD8] dark:border-[#2B3835] flex items-center justify-between bg-[#F4F6F5] dark:bg-[#19231F]">
              <div className="flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-[#0E6863] dark:text-[#4FC3B8]" />
                <h2 className="font-['Schibsted_Grotesk'] font-bold text-sm">Shift Details · {selectedShift.id}</h2>
              </div>
              <button onClick={() => setSelectedShift(null)} className="p-1 text-[#5C6966] hover:text-[#121A19] rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 p-6 space-y-6 overflow-y-auto">
              <div>
                <span className="text-[11px] font-['IBM_Plex_Mono'] text-[#0E6863] dark:text-[#4FC3B8] font-bold uppercase">
                  Station: {selectedShift.station} · {selectedShift.type}
                </span>
                <h1 className="text-lg font-['Schibsted_Grotesk'] font-bold mt-1 text-[#121A19] dark:text-[#E9EEEC]">
                  {selectedShift.title}
                </h1>
                <p className="text-xs text-[#5C6966] font-['IBM_Plex_Mono'] mt-1">
                  Agent: <b className="text-[#121A19] dark:text-[#E9EEEC]">@{selectedShift.agent}</b> · Window: {selectedShift.startTime}–{selectedShift.endTime} EST
                </p>
              </div>

              {/* Status and Telemetry */}
              <div className="p-4 bg-[#F4F6F5] dark:bg-[#080D0C] border border-[#D3DAD8] dark:border-[#2B3835] rounded-lg space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-text">Shift Status</span>
                  {statusBadge(selectedShift.status)}
                </div>
                <div className="flex items-center justify-between text-xs font-['IBM_Plex_Mono']">
                  <span className="text-[#5C6966]">Cost Limit</span>
                  <span>{selectedShift.spent || '$0.00'} spent of {selectedShift.budgetCap} cap</span>
                </div>
                {selectedShift.receiptId && (
                  <div className="pt-2 border-t border-[#D3DAD8] dark:border-[#2B3835] text-xs font-['IBM_Plex_Mono'] text-[#5C6966]">
                    <span>Receipt ID: </span>
                    <span className="font-bold text-[#0E6863] dark:text-[#4FC3B8]">{selectedShift.receiptId}</span>
                  </div>
                )}
              </div>

              {/* Shift Recap Notes */}
              {selectedShift.recapNotes && (
                <div className="space-y-2">
                  <span className="text-xs font-['IBM_Plex_Mono'] font-bold text-[#5C6966] uppercase">
                    Shift Recap & Handover Notes
                  </span>
                  <div className="p-3 bg-[#F4F6F5] dark:bg-[#080D0C] border border-[#D3DAD8] dark:border-[#2B3835] rounded-lg text-xs font-['IBM_Plex_Mono'] text-[#121A19] dark:text-[#E9EEEC] leading-relaxed">
                    {selectedShift.recapNotes}
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-[#D3DAD8] dark:border-[#2B3835] bg-[#F4F6F5] dark:bg-[#19231F] flex items-center justify-between">
              <button
                onClick={() => setSelectedShift(null)}
                className="px-3 py-1.5 text-xs font-medium border border-[#D3DAD8] dark:border-[#2B3835] rounded bg-white dark:bg-[#121A19] text-[#46534F] dark:text-[#B3BEBA]"
              >
                Close
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => alert(`Shift swap requested for @${selectedShift.agent}`)}
                  className="px-3 py-1.5 text-xs font-medium border border-[#D3DAD8] dark:border-[#2B3835] rounded bg-white dark:bg-[#121A19] text-[#46534F] dark:text-[#B3BEBA] hover:text-[#121A19]"
                >
                  Request Shift Swap
                </button>
                {selectedShift.status === 'active' && (
                  <button
                    onClick={() => alert(`Shift recap filed for @${selectedShift.agent}`)}
                    className="px-3 py-1.5 text-xs font-semibold bg-[#0E6863] dark:bg-[#4FC3B8] text-white dark:text-[#121A19] rounded hover:opacity-90"
                  >
                    File Shift Recap
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
