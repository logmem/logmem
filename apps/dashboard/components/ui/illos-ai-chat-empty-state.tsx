'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';
import { Suggestion, SuggestionList, Suggestions } from './suggestions';

export interface IllosAiChatEmptyStateProps {
  title?: string;
  description?: string;
  suggestions?: string[];
  onSelectSuggestion?: (prompt: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Tokenized "Streaming tokens" illustration inspired by Illos (https://illos.dev),
 * driven strictly by LogMem var(--*) tokens for Light & Dark parity and reduced-motion safety.
 */
export function StreamingTokensArt({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 560 190"
      fill="none"
      role="img"
      aria-label="Streaming tokens from space memory"
      className={cn('h-auto w-full max-w-[400px] select-none', className)}
    >
      {/* Subtle architectural grid */}
      <path
        d="M0 48H560M0 96H560M0 144H560M96 0V190M192 0V190M288 0V190M384 0V190M480 0V190"
        stroke="var(--border)"
        strokeOpacity="0.45"
        strokeWidth="1"
      />

      {/* MODEL node */}
      <g>
        <rect
          x="28"
          y="58"
          width="88"
          height="74"
          rx="6"
          fill="var(--surface)"
          stroke="var(--brand)"
          strokeWidth="1.25"
        />
        <rect x="28" y="58" width="52" height="16" rx="3" fill="var(--brand)" />
        <text
          x="54"
          y="69"
          textAnchor="middle"
          fill="var(--on-brand)"
          fontFamily="var(--font-mono)"
          fontSize="9"
          fontWeight="600"
        >
          SPACE
        </text>
        {[46, 56, 66, 76, 86, 96].map((x, i) => (
          <line
            key={x}
            x1={x}
            y1={86 + (i % 2) * 5}
            x2={x}
            y2={118 - (i % 3) * 4}
            stroke="var(--brand)"
            strokeOpacity={0.35 + (i % 3) * 0.25}
            strokeWidth="3"
            strokeDasharray="6 3"
            strokeLinecap="round"
          />
        ))}
      </g>

      {/* Travelling token ribbon */}
      <g className="motion-safe:animate-pulse">
        <path
          d="M120 95 C164 68, 206 122, 260 95"
          stroke="var(--brand)"
          strokeOpacity="0.4"
          strokeWidth="2"
          strokeDasharray="5 4"
        />
        {[138, 162, 186, 210, 234].map((x, idx) => (
          <rect
            key={x}
            x={x}
            y={86 + Math.sin(idx * 1.1) * 10}
            width="10"
            height="14"
            rx="2"
            fill="var(--brand)"
            fillOpacity={0.35 + idx * 0.14}
          />
        ))}
      </g>

      {/* RESPONSE window */}
      <g>
        <rect
          x="266"
          y="26"
          width="266"
          height="138"
          rx="6"
          fill="var(--surface)"
          stroke="var(--brand)"
          strokeWidth="1.25"
        />
        <rect x="266" y="26" width="76" height="16" rx="3" fill="var(--brand)" />
        <text
          x="304"
          y="37"
          textAnchor="middle"
          fill="var(--on-brand)"
          fontFamily="var(--font-mono)"
          fontSize="9"
          fontWeight="600"
        >
          RESPONSE
        </text>
        {/* Tokenized response lines */}
        <line x1="286" y1="62" x2="508" y2="62" stroke="var(--brand)" strokeOpacity="0.7" strokeWidth="6" strokeDasharray="18 6 34 6 24 6" strokeLinecap="round" />
        <line x1="286" y1="84" x2="492" y2="84" stroke="var(--brand)" strokeOpacity="0.55" strokeWidth="6" strokeDasharray="28 6 16 6 40 6" strokeLinecap="round" />
        <line x1="286" y1="106" x2="502" y2="106" stroke="var(--brand)" strokeOpacity="0.4" strokeWidth="6" strokeDasharray="22 6 32 6 18 6" strokeLinecap="round" />
        <line x1="286" y1="128" x2="410" y2="128" stroke="var(--brand)" strokeOpacity="0.85" strokeWidth="6" strokeDasharray="30 6 22 6" strokeLinecap="round" />
        <rect
          x="420"
          y="121"
          width="6"
          height="14"
          rx="2"
          fill="var(--brand)"
          className="motion-safe:animate-pulse"
        />
      </g>
    </svg>
  );
}

export function IllosAiChatEmptyState({
  title = 'Ask anything about this space',
  description = 'Answers read live LogMem memory and cite real jobs, agents, and trails. Anything irreversible waits for your approval.',
  suggestions = [
    'What needs me?',
    'What is blocked?',
    'What happened recently?',
    'Which agents are active?',
  ],
  onSelectSuggestion,
  disabled = false,
  className,
}: IllosAiChatEmptyStateProps) {
  return (
    <div
      data-slot="chat-empty-state"
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-5 px-4 py-8 text-center',
        className,
      )}
    >
      <StreamingTokensArt />
      <div className="max-w-md space-y-1.5">
        <h2 className="font-heading text-lg font-semibold tracking-tight text-[var(--text)]">{title}</h2>
        <p className="text-sm leading-relaxed text-[var(--text-muted)]">{description}</p>
      </div>
      {suggestions.length > 0 ? (
        <Suggestions onSelect={onSelectSuggestion}>
          <SuggestionList className="max-w-xl justify-center">
            {suggestions.map((s) => (
              <Suggestion key={s} value={s} variant="filled" disabled={disabled}>
                {s}
              </Suggestion>
            ))}
          </SuggestionList>
        </Suggestions>
      ) : null}
    </div>
  );
}

export default IllosAiChatEmptyState;
