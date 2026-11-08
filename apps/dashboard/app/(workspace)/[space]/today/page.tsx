'use client';

import { useState } from 'react';
import { DecisionDrawer, DecisionItem } from '../components/decision-drawer';
import { AlertCircle, Clock, CheckCircle2, ChevronRight, User, ExternalLink } from 'lucide-react';

export default function TodayPage({ params }: { params: { space: string } }) {
  const [selectedDecision, setSelectedDecision] = useState<DecisionItem | null>(null);

  // Real operational sample data grounded in fleet state (commit 407b953)
  const decisions: DecisionItem[] = [
    {
      trail: 'askDeployAdminBundle-20261107',
      summary: 'Approve single production deploy of consolidated dashboard bundle',
      requester: 'agent:muse',
      action: 'Deploy main commit 407b953 (PRs 244, 247, 248, 250) to production logmem.si',
      deadline: 'Nov 8, 12:00 EST',
      diffPayload: `Target: https://logmem.si
Commit: 407b953
Included PRs:
  - PR 244: Secrets loader slice 1 (1263 tests pass)
  - PR 247: Dashboard header & theme tokens
  - PR 248: Space switcher & customer session keepalive
  - PR 250: Consolidated Agent Access screen (#/access)
QA Receipt: Pass (Muse mobile 390px + desktop 1440px pass receipt)`,
      reversible: false,
    },
  ];

  const handoffs = [
    {
      id: 'h1',
      from: 'agent:claude-code',
      to: 'agent:gemini-app',
      task: 'Review Webmaster AEO/GEO architecture (/llms.txt) and directory citations',
      deadline: '18h remaining',
      overdue: false,
    },
    {
      id: 'h2',
      from: 'agent:codex',
      to: 'agent:antigravity',
      task: 'Map missing admin secret to 503 configuration error on PR 239',
      deadline: '6h remaining',
      overdue: false,
    },
  ];

  const updates = [
    { agent: 'gemini-app', time: '10:15', kind: 'progress', text: 'Logged fleet sync pass receipt (sync_c5bb020114f3fb6d19dafb26). Workspace active.' },
    { agent: 'codex', time: '09:44', kind: 'checkup', text: 'Checked PR 238 at 1902a55. Fixed rate-limit and hash exports; scanText text match noted.' },
    { agent: 'opencode', time: '09:12', kind: 'memo', text: 'PR 252 open for personal-selfhost-bundle. Full suite 1272/1272 tests pass.' },
  ];

  const plans = [
    { name: 'launch > Distribution', done: 4, total: 9, status: 'Active' },
    { name: 'launch > Footprint and launch', done: 6, total: 8, status: 'Active' },
    { name: 'core > Layer 0 safety floor', done: 3, total: 4, status: 'Review' },
  ];

  return (
    <div className="space-y-8 font-sans">
      {/* Hero Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-4 border-b border-[#D3DAD8] dark:border-[#2B3835]">
        <div>
          <span className="text-xs font-['IBM_Plex_Mono'] text-[#5C6966] dark:text-[#97A4A0] uppercase tracking-wider block mb-1">
            Your workspace · {params.space}
          </span>
          <h1 className="text-2xl md:text-3xl font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
            Your work, <span className="text-[#0E6863] dark:text-[#4FC3B8]">in view.</span>
          </h1>
          <p className="text-sm text-[#46534F] dark:text-[#B3BEBA] mt-1">
            Decide what needs you. Keep the next step in view.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="#/queue"
            className="px-3.5 py-1.5 text-xs font-medium rounded-md border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] text-[#121A19] dark:text-[#E9EEEC] hover:bg-[#F4F6F5] dark:hover:bg-[#19231F]"
          >
            Open Inbox
          </a>
        </div>
      </div>

      {/* Triage Status Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" role="group" aria-label="Triage status">
        <div className="p-3.5 rounded-lg border border-[#6B3FA0]/30 bg-[#F1EAF8] dark:bg-[#231637] dark:border-[#C6A0F0]/30">
          <span className="text-xl font-bold font-['IBM_Plex_Mono'] text-[#6B3FA0] dark:text-[#C6A0F0] block">1</span>
          <span className="text-xs font-medium text-[#46534F] dark:text-[#B3BEBA]">Needs your decision</span>
        </div>
        <div className="p-3.5 rounded-lg border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19]">
          <span className="text-xl font-bold font-['IBM_Plex_Mono'] text-[#121A19] dark:text-[#E9EEEC] block">2</span>
          <span className="text-xs font-medium text-[#46534F] dark:text-[#B3BEBA]">Waiting on team</span>
        </div>
        <div className="p-3.5 rounded-lg border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19]">
          <span className="text-xl font-bold font-['IBM_Plex_Mono'] text-[#875100] dark:text-[#E8A746] block">2</span>
          <span className="text-xs font-medium text-[#46534F] dark:text-[#B3BEBA]">Active blockers</span>
        </div>
        <div className="p-3.5 rounded-lg border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19]">
          <span className="text-xl font-bold font-['IBM_Plex_Mono'] text-[#1E6B35] dark:text-[#5DC47C] block">13</span>
          <span className="text-xs font-medium text-[#46534F] dark:text-[#B3BEBA]">Done this week</span>
        </div>
      </div>

      {/* Operational Brief Card */}
      <div className="p-4 rounded-lg border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-['IBM_Plex_Mono'] font-semibold text-[#0E6863] dark:text-[#4FC3B8] uppercase">
            Operational Brief · Commit 407b953
          </span>
          <span className="text-[#5C6966] font-['IBM_Plex_Mono']">Live health: Healthy</span>
        </div>
        <p className="text-xs text-[#46534F] dark:text-[#B3BEBA] leading-relaxed">
          Production is running live at commit 407b953 with PRs 244, 247, 248, and 250 merged. PR 252 (personal-selfhost-bundle) is open with 1272/1272 tests passing. OpenCode awaits Elestio console host key confirmation.
        </p>
      </div>

      {/* Main Grid: Decisions, Waits, and Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2 Cols): Decisions & Waits */}
        <div className="lg:col-span-2 space-y-6">
          {/* Needs Decision Queue */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
                Needs your decision <span className="text-xs font-['IBM_Plex_Mono'] text-[#6B3FA0] dark:text-[#C6A0F0] font-semibold">(1)</span>
              </h2>
            </div>
            {decisions.map((d) => (
              <div
                key={d.trail}
                className="p-5 rounded-lg border border-[#6B3FA0]/30 dark:border-[#C6A0F0]/30 bg-white dark:bg-[#121A19] shadow-sm space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="text-[11px] font-['IBM_Plex_Mono'] text-[#6B3FA0] dark:text-[#C6A0F0] font-semibold">
                      {d.requester}
                    </span>
                    <h3 className="text-sm font-bold text-[#121A19] dark:text-[#E9EEEC] mt-0.5">{d.summary}</h3>
                  </div>
                  <span className="text-[11px] font-['IBM_Plex_Mono'] text-[#875100] dark:text-[#E8A746] bg-[#FBEED6] dark:bg-[#2C1F08] px-2 py-0.5 rounded font-medium">
                    Due {d.deadline}
                  </span>
                </div>
                <p className="text-xs font-['IBM_Plex_Mono'] text-[#46534F] dark:text-[#B3BEBA] bg-[#F4F6F5] dark:bg-[#080D0C] p-2.5 rounded border border-[#D3DAD8] dark:border-[#2B3835]">
                  {d.action}
                </p>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-[#5C6966] font-['IBM_Plex_Mono']">
                    trail: …{d.trail.slice(-10)}
                  </span>
                  <button
                    onClick={() => setSelectedDecision(d)}
                    className="px-3 py-1.5 bg-[#6B3FA0] dark:bg-[#C6A0F0] text-white dark:text-[#121A19] text-xs font-semibold rounded hover:opacity-90 transition-opacity"
                  >
                    Inspect & Decide →
                  </button>
                </div>
              </div>
            ))}
          </section>

          {/* Waiting on Team */}
          <section className="space-y-3">
            <h2 className="text-base font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
              Waiting on your team <span className="text-xs font-['IBM_Plex_Mono'] text-[#5C6966]">(2)</span>
            </h2>
            <div className="border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] rounded-lg divide-y divide-[#D3DAD8] dark:divide-[#2B3835]">
              {handoffs.map((h) => (
                <div key={h.id} className="p-3.5 flex items-center justify-between text-xs gap-3">
                  <div className="space-y-0.5">
                    <p className="text-text font-medium">{h.task}</p>
                    <p className="text-[#5C6966] font-['IBM_Plex_Mono'] text-[11px]">
                      From <span className="text-[#121A19] dark:text-[#E9EEEC]">{h.from}</span> → To <span className="text-[#0E6863] dark:text-[#4FC3B8] font-semibold">{h.to}</span>
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-[11px] font-['IBM_Plex_Mono'] text-[#5C6966]">{h.deadline}</span>
                    <button className="block text-[11px] text-[#0E6863] dark:text-[#4FC3B8] hover:underline font-semibold mt-0.5">
                      Nudge
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Right Column: Priorities & Live Activity */}
        <div className="space-y-6">
          {/* Priorities by Plan */}
          <section className="space-y-3">
            <h2 className="text-base font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
              Current priorities
            </h2>
            <div className="space-y-2.5">
              {plans.map((p) => {
                const pct = Math.round((p.done / p.total) * 100);
                return (
                  <div key={p.name} className="p-3.5 rounded-lg border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-text">{p.name}</span>
                      <span className="font-['IBM_Plex_Mono'] text-text-subtle">{pct}%</span>
                    </div>
                    <div className="w-full bg-[#EAEEEC] dark:bg-[#080D0C] h-1.5 rounded-full overflow-hidden">
                      <div className="bg-[#0E6863] dark:bg-[#4FC3B8] h-full" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-text-subtle font-['IBM_Plex_Mono']">
                      <span>{p.done} of {p.total} done</span>
                      <span>{p.status}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Recent Source Activity */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
                Recent job updates
              </h2>
              <a href="#/activity" className="text-xs text-[#0E6863] dark:text-[#4FC3B8] hover:underline">
                View All →
              </a>
            </div>
            <div className="p-3.5 rounded-lg border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] space-y-3">
              {updates.map((u, i) => (
                <div key={i} className="text-xs space-y-1 pb-2 border-b border-[#D3DAD8]/50 dark:border-[#2B3835]/50 last:border-0 last:pb-0">
                  <div className="flex items-center justify-between font-['IBM_Plex_Mono'] text-[11px]">
                    <span className="font-semibold text-[#0E6863] dark:text-[#4FC3B8]">{u.agent}</span>
                    <span className="text-[#5C6966]">{u.time}</span>
                  </div>
                  <p className="text-[#46534F] dark:text-[#B3BEBA] leading-tight">{u.text}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {/* Decision Drawer Component */}
      <DecisionDrawer
        isOpen={Boolean(selectedDecision)}
        onClose={() => setSelectedDecision(null)}
        decision={selectedDecision}
      />
    </div>
  );
}
