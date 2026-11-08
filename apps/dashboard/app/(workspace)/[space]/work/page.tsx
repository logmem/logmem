'use client';

import { useState } from 'react';
import { LayoutList, Columns, Copy, Check, AlertTriangle, ShieldCheck, ChevronRight } from 'lucide-react';

interface JobItem {
  id: string;
  title: string;
  plan: string;
  owner: string;
  stage: 'open' | 'active' | 'blocked' | 'done';
  why: string;
  due: string;
  blocker?: string;
  dispatchPrompt?: string;
}

export default function WorkPage({ params }: { params: { space: string } }) {
  const [layout, setLayout] = useState<'list' | 'board'>('list');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [planFilter, setPlanFilter] = useState<string>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const jobs: JobItem[] = [
    {
      id: 'webmaster-aeo-geo-llmstxt',
      title: 'Deploy /llms.txt and /llms-full.txt endpoints for AI search engines',
      plan: 'launch > Distribution',
      owner: 'gemini-app',
      stage: 'active',
      why: 'Architecture finalized. Awaiting layout injection of SoftwareApplication schema.',
      due: 'Today, 18:00 EST',
    },
    {
      id: 'personal-selfhost-bundle',
      title: 'PR 252 one-command self-host bundle (compose, install.sh)',
      plan: 'launch > Footprint and launch',
      owner: 'opencode',
      stage: 'active',
      why: 'Full test suite passing (1272/1272). Awaits review and merge.',
      due: 'Today, 15:00 EST',
    },
    {
      id: 'layer0-safety-floor',
      title: 'PR 238 Layer 0 safety floor & scanner match redaction',
      plan: 'core > Layer 0 safety floor',
      owner: 'antigravity',
      stage: 'blocked',
      why: 'scanText returns matched source lines instead of boolean match.',
      due: 'Overdue by 14h',
      blocker: 'Scanner match leakage',
      dispatchPrompt: 'Fix PR 238 at head 1902a55: ensure scanText returns boolean match without echoing sensitive source text.',
    },
    {
      id: 'admin-secret-handling',
      title: 'PR 239 missing admin secret error mapping to 503',
      plan: 'core > Layer 0 safety floor',
      owner: 'antigravity',
      stage: 'blocked',
      why: 'Missing LOGMEM_ADMIN_SECRET returns 401/500 instead of 503.',
      due: 'Overdue by 12h',
      blocker: 'Missing secret mapping',
      dispatchPrompt: 'Update PR 239 at head 84945dd: map missing admin secret configuration errors explicitly to HTTP 503 Service Unavailable.',
    },
    {
      id: 'webmaster-gtm-ga4-layout',
      title: 'Root layout GTM-LGMEM01 container & JSON-LD schema',
      plan: 'launch > Distribution',
      owner: 'gemini-app',
      stage: 'active',
      why: 'Pending template review before injection into marketing root.',
      due: 'Nov 8, 20:00 EST',
    },
    {
      id: 'dashboard-bundle-qa',
      title: 'Muse single production QA pass on commit 407b953',
      plan: 'launch > Distribution',
      owner: 'muse',
      stage: 'active',
      why: 'Running one pass at 390px and 1440px on /access and Settings.',
      due: 'Nov 8, 14:00 EST',
    },
    {
      id: 'launch-gate-beta',
      title: 'Pass 7-day gate at agreed volume before Nov 16 public beta',
      plan: 'launch > Footprint and launch',
      owner: 'codex',
      stage: 'open',
      why: 'Requires 7 consecutive passing audit receipts and deliverable done.',
      due: 'Nov 15, 23:59 EST',
    },
  ];

  const handleCopyPrompt = (id: string, prompt?: string) => {
    if (!prompt) return;
    navigator.clipboard.writeText(prompt);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const filtered = jobs.filter((j) => {
    if (stageFilter !== 'all' && j.stage !== stageFilter) return false;
    if (planFilter !== 'all' && j.plan !== planFilter) return false;
    return true;
  });

  const blockedCount = jobs.filter((j) => j.stage === 'blocked').length;
  const activeCount = jobs.filter((j) => j.stage === 'active').length;
  const openCount = jobs.filter((j) => j.stage === 'open').length;

  return (
    <div className="space-y-6 font-sans">
      {/* Page Title & View Toggle */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#D3DAD8] dark:border-[#2B3835]">
        <div>
          <h1 className="text-2xl font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
            Work
          </h1>
          <p className="text-sm text-[#46534F] dark:text-[#B3BEBA] mt-1">
            Priorities, owners, and the next step.
          </p>
        </div>

        {/* List / Board Segmented Control */}
        <div className="flex items-center gap-3">
          <div className="flex items-center p-0.5 rounded-md border border-[#D3DAD8] dark:border-[#2B3835] bg-[#F4F6F5] dark:bg-[#19231F] text-xs">
            <button
              onClick={() => setLayout('list')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-medium transition-colors ${
                layout === 'list'
                  ? 'bg-white dark:bg-[#121A19] text-[#121A19] dark:text-[#E9EEEC] shadow-sm font-semibold'
                  : 'text-[#5C6966] hover:text-[#121A19] dark:hover:text-[#E9EEEC]'
              }`}
            >
              <LayoutList className="w-3.5 h-3.5" /> List
            </button>
            <button
              onClick={() => setLayout('board')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-medium transition-colors ${
                layout === 'board'
                  ? 'bg-white dark:bg-[#121A19] text-[#121A19] dark:text-[#E9EEEC] shadow-sm font-semibold'
                  : 'text-[#5C6966] hover:text-[#121A19] dark:hover:text-[#E9EEEC]'
              }`}
            >
              <Columns className="w-3.5 h-3.5" /> Board
            </button>
          </div>
        </div>
      </div>

      {/* Filter Row */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {[['all', 'All'], ['active', `Active (${activeCount})`], ['blocked', `Blocked (${blockedCount})`], ['open', `Open (${openCount})`]].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setStageFilter(k)}
            className={`px-3 py-1.5 rounded-md border font-medium transition-colors ${
              stageFilter === k
                ? 'bg-[#0E6863] dark:bg-[#4FC3B8] text-white dark:text-[#121A19] border-[#0E6863] dark:border-[#4FC3B8] font-semibold'
                : 'bg-white dark:bg-[#121A19] border-[#D3DAD8] dark:border-[#2B3835] text-[#46534F] dark:text-[#B3BEBA] hover:border-[#7A8784]'
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* List Layout */}
      {layout === 'list' ? (
        <div className="border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] rounded-lg divide-y divide-[#D3DAD8] dark:divide-[#2B3835] shadow-sm overflow-hidden">
          {filtered.map((j) => (
            <div key={j.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:bg-[#F4F6F5]/50 dark:hover:bg-[#19231F]/50 transition-colors">
              <div className="space-y-1.5 min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-['IBM_Plex_Mono'] font-bold uppercase ${
                      j.stage === 'blocked'
                        ? 'bg-[#FBE6E3] text-[#B42318] dark:bg-[#341411] dark:text-[#F47A66]'
                        : j.stage === 'active'
                        ? 'bg-[#E2F1E5] text-[#1E6B35] dark:bg-[#0F2618] dark:text-[#5DC47C]'
                        : 'bg-[#EAEEEC] text-[#5C6966]'
                    }`}
                  >
                    {j.stage}
                  </span>
                  <span className="text-xs font-['IBM_Plex_Mono'] text-[#5C6966]">{j.plan}</span>
                  <span className="text-xs font-['IBM_Plex_Mono'] font-semibold text-[#0E6863] dark:text-[#4FC3B8]">
                    @{j.owner}
                  </span>
                </div>
                <h3 className="text-sm font-semibold text-[#121A19] dark:text-[#E9EEEC] leading-snug">
                  {j.title}
                </h3>
                <p className="text-xs text-[#46534F] dark:text-[#B3BEBA]">{j.why}</p>
              </div>

              <div className="flex md:flex-col md:items-end justify-between shrink-0 gap-1.5 pt-2 md:pt-0 border-t md:border-t-0 border-[#D3DAD8]/40">
                <span className={`text-xs font-['IBM_Plex_Mono'] ${j.due.includes('Overdue') ? 'text-[#B42318] dark:text-[#F47A66] font-semibold' : 'text-[#5C6966]'}`}>
                  {j.due}
                </span>
                {j.dispatchPrompt && (
                  <button
                    onClick={() => handleCopyPrompt(j.id, j.dispatchPrompt)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-[#F4F6F5] dark:bg-[#19231F] border border-[#D3DAD8] dark:border-[#2B3835] text-[#46534F] dark:text-[#B3BEBA] hover:text-[#121A19] dark:hover:text-[#E9EEEC]"
                  >
                    {copiedId === j.id ? <Check className="w-3 h-3 text-[#1E6B35]" /> : <Copy className="w-3 h-3" />}
                    {copiedId === j.id ? 'Copied' : 'Copy unblock prompt'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* 3-Column Kanban Board */
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(['open', 'active', 'blocked'] as const).map((col) => {
            const colJobs = filtered.filter((j) => j.stage === col);
            return (
              <div key={col} className="space-y-3 bg-[#F4F6F5] dark:bg-[#121A19]/50 p-3 rounded-lg border border-[#D3DAD8] dark:border-[#2B3835]">
                <div className="flex items-center justify-between pb-2 border-b border-[#D3DAD8] dark:border-[#2B3835]">
                  <h3 className="text-xs font-['IBM_Plex_Mono'] font-bold uppercase tracking-wider text-[#121A19] dark:text-[#E9EEEC]">
                    {col}
                  </h3>
                  <span className="text-xs font-['IBM_Plex_Mono'] text-[#5C6966]">{colJobs.length}</span>
                </div>
                <div className="space-y-2.5">
                  {colJobs.map((j) => (
                    <div key={j.id} className="p-3 bg-white dark:bg-[#121A19] border border-[#D3DAD8] dark:border-[#2B3835] rounded-md shadow-sm space-y-2">
                      <div className="flex items-center justify-between text-[11px] font-['IBM_Plex_Mono']">
                        <span className="text-[#0E6863] dark:text-[#4FC3B8] font-semibold">@{j.owner}</span>
                        <span className={j.due.includes('Overdue') ? 'text-[#B42318] font-semibold' : 'text-[#5C6966]'}>{j.due}</span>
                      </div>
                      <h4 className="text-xs font-medium text-[#121A19] dark:text-[#E9EEEC] leading-snug">{j.title}</h4>
                      <p className="text-[11px] text-[#46534F] dark:text-[#B3BEBA]">{j.why}</p>
                      {j.dispatchPrompt && (
                        <button
                          onClick={() => handleCopyPrompt(j.id, j.dispatchPrompt)}
                          className="w-full mt-1 py-1 text-[11px] border border-[#D3DAD8] dark:border-[#2B3835] rounded bg-[#F4F6F5] dark:bg-[#19231F] text-[#46534F] dark:text-[#B3BEBA] hover:text-[#121A19] flex items-center justify-center gap-1 font-['IBM_Plex_Mono']"
                        >
                          {copiedId === j.id ? <Check className="w-3 h-3 text-[#1E6B35]" /> : <Copy className="w-3 h-3" />}
                          {copiedId === j.id ? 'Copied prompt' : 'Copy prompt'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
