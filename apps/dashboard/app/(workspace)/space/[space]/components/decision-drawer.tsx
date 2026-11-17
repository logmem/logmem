'use client';

import { useState } from 'react';
import { X, ShieldAlert, CheckCircle, Clock, Undo2 } from 'lucide-react';

export interface DecisionItem {
  trail: string;
  summary: string;
  requester: string;
  action: string;
  deadline: string;
  diffPayload?: string;
  reversible: boolean;
}

interface DecisionDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  decision: DecisionItem | null;
}

export function DecisionDrawer({ isOpen, onClose, decision }: DecisionDrawerProps) {
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [settledVerdict, setSettledVerdict] = useState<'approved' | 'rejected' | 'deferred' | null>(null);

  if (!isOpen || !decision) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm animate-in fade-in duration-150 font-sans">
      <div className="w-full max-w-xl bg-[#FFFFFF] dark:bg-[#121A19] border-l border-[#D3DAD8] dark:border-[#2B3835] h-full flex flex-col shadow-2xl">
        {/* Header */}
        <div className="p-4 border-b border-[#D3DAD8] dark:border-[#2B3835] flex items-center justify-between bg-[#F4F6F5] dark:bg-[#19231F]">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#6B3FA0] dark:bg-[#C6A0F0] inline-block" />
            <h2 className="font-['Schibsted_Grotesk'] font-bold text-sm text-[#121A19] dark:text-[#E9EEEC]">
              Review decision
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-[#5C6966] hover:text-[#121A19] dark:hover:text-[#E9EEEC] rounded min-w-[32px] min-h-[32px] flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-6 space-y-6 overflow-y-auto">
          {settledVerdict ? (
            <div className="p-4 rounded-lg bg-[#E2F1E5] dark:bg-[#0F2618] text-[#1E6B35] dark:text-[#5DC47C] text-sm space-y-2 border border-[#1E6B35]/20">
              <p className="font-semibold">Decision saved. Waiting for agent.</p>
              <p className="text-xs text-[#46534F] dark:text-[#B3BEBA]">
                Verdict has been recorded on trail <code className="font-['IBM_Plex_Mono'] font-bold">{decision.trail}</code>. The requesting agent will verify this verdict on its next shift.
              </p>
            </div>
          ) : (
            <>
              {/* Question & Summary */}
              <div>
                <span className="text-[11px] font-['IBM_Plex_Mono'] text-[#6B3FA0] dark:text-[#C6A0F0] font-bold uppercase tracking-wider">
                  Action requires authorization
                </span>
                <h1 className="text-lg font-['Schibsted_Grotesk'] font-bold mt-1 text-[#121A19] dark:text-[#E9EEEC]">
                  {decision.summary}
                </h1>
                <p className="text-xs text-[#5C6966] dark:text-[#97A4A0] mt-1 font-['IBM_Plex_Mono']">
                  Requested by <b className="text-[#121A19] dark:text-[#E9EEEC]">{decision.requester}</b> · Due {decision.deadline}
                </p>
              </div>

              {/* Exact Proposed Action */}
              <div className="p-4 bg-[#F4F6F5] dark:bg-[#080D0C] border border-[#D3DAD8] dark:border-[#2B3835] rounded-lg space-y-2">
                <span className="text-[11px] font-['IBM_Plex_Mono'] text-[#5C6966] dark:text-[#97A4A0] uppercase font-semibold">
                  Proposed Action
                </span>
                <p className="text-sm font-['IBM_Plex_Mono'] text-[#121A19] dark:text-[#E9EEEC] font-medium leading-relaxed">
                  {decision.action}
                </p>
                <div className="pt-2 flex items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded text-[11px] font-['IBM_Plex_Mono'] font-medium ${
                      decision.reversible
                        ? 'bg-[#E6ECFC] text-[#2453D6] dark:bg-[#121C38] dark:text-[#86A6FF]'
                        : 'bg-[#FBE6E3] text-[#B42318] dark:bg-[#341411] dark:text-[#F47A66]'
                    }`}
                  >
                    {decision.reversible ? 'Reversible' : 'Irreversible'}
                  </span>
                </div>
              </div>

              {/* Payload Diff Evidence */}
              {decision.diffPayload && (
                <div className="space-y-1.5">
                  <span className="text-[11px] font-['IBM_Plex_Mono'] text-[#5C6966] dark:text-[#97A4A0] uppercase font-semibold">
                    Evidence & Payload Preview
                  </span>
                  <pre className="p-3 bg-[#F4F6F5] dark:bg-[#080D0C] border border-[#D3DAD8] dark:border-[#2B3835] rounded text-xs font-['IBM_Plex_Mono'] text-[#121A19] dark:text-[#E9EEEC] overflow-x-auto whitespace-pre-wrap">
                    {decision.diffPayload}
                  </pre>
                </div>
              )}

              {/* Request Changes Textarea */}
              {showRejectInput && (
                <div className="space-y-2 pt-2 border-t border-[#D3DAD8] dark:border-[#2B3835]">
                  <label className="text-xs font-['IBM_Plex_Mono'] text-[#46534F] dark:text-[#B3BEBA]">
                    Reason for requesting changes (required by protocol)
                  </label>
                  <textarea
                    rows={3}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="State what the agent must modify before this action can be approved..."
                    className="w-full bg-[#F4F6F5] dark:bg-[#080D0C] border border-[#D3DAD8] dark:border-[#2B3835] rounded p-2.5 text-sm font-sans focus:border-[#0E6863] dark:focus:border-[#4FC3B8] outline-none"
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer Actions */}
        {!settledVerdict && (
          <div className="p-4 border-t border-[#D3DAD8] dark:border-[#2B3835] bg-[#F4F6F5] dark:bg-[#19231F] flex items-center justify-between gap-2">
            <button
              onClick={() => setSettledVerdict('deferred')}
              className="px-3 py-2 text-xs font-medium border border-[#D3DAD8] dark:border-[#2B3835] rounded text-[#46534F] dark:text-[#B3BEBA] hover:text-[#121A19] dark:hover:text-[#E9EEEC] bg-white dark:bg-[#121A19]"
            >
              Decide later
            </button>
            <div className="flex items-center gap-2">
              {showRejectInput ? (
                <button
                  disabled={!rejectReason.trim()}
                  onClick={() => setSettledVerdict('rejected')}
                  className="px-3 py-2 text-xs font-medium bg-[#B42318] dark:bg-[#F47A66] text-white rounded disabled:opacity-50"
                >
                  Confirm changes requested
                </button>
              ) : (
                <button
                  onClick={() => setShowRejectInput(true)}
                  className="px-3 py-2 text-xs font-medium border border-[#B42318]/40 text-[#B42318] dark:text-[#F47A66] rounded hover:bg-[#FBE6E3] dark:hover:bg-[#341411]"
                >
                  Request changes
                </button>
              )}
              <button
                onClick={() => setSettledVerdict('approved')}
                className="px-4 py-2 text-xs font-semibold bg-[#6B3FA0] dark:bg-[#C6A0F0] text-white dark:text-[#121A19] rounded hover:opacity-90 shadow-sm"
              >
                Approve action
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
