'use client';

import * as React from 'react';
import { Bot, CircleAlert, Cpu, FileText, Pause, Play, Wrench, Zap } from 'lucide-react';
import { cn } from '../../lib/utils';

/** What produced the span. Drives the icon and whether the bar uses the brand accent color. */
export type SpanKind = 'agent' | 'model' | 'tool' | 'io';

/** How the span finished. `cached` means it returned without doing the work. */
export type SpanStatus = 'ok' | 'error' | 'cached';

export interface TraceSpan {
  /** Stable id. Used for React keys and for `parentId` links. */
  id: string;
  /** Tool, model or sub-agent name, e.g. `search_docs`. Rendered in the name gutter. */
  label: string;
  /** Start offset in milliseconds from the beginning of the run. */
  start: number;
  /** End offset in milliseconds. For a span still in flight, pass the current time. */
  end: number;
  /** Defaults to `"tool"`. `agent` and `model` spans are drawn in the theme's brand color. */
  kind?: SpanKind;
  /** Defaults to `"ok"`. `error` draws the bar in the danger color. */
  status?: SpanStatus;
  /** Id of the span this one runs inside. Children are indented under their parent. */
  parentId?: string;
  /** One-line result shown on the right once the span finishes. */
  detail?: string;
  /** Tokens billed to this span. Counts up as the span replays; shown instead of `detail`. */
  tokens?: number;
  /** Attempt number. Anything above 1 renders a `×n` retry chip next to the label. */
  attempt?: number;
}

export interface AgentTraceProps extends React.ComponentProps<'div'> {
  /** The run. Order is derived from `start` and `parentId`, so the array can be in any order. */
  spans: TraceSpan[];
  /** Total run length in milliseconds. Defaults to the largest `end` in `spans`. */
  duration?: number;
  /** Run identifier shown in the header. */
  runId?: string;
  /** Model or agent surface shown next to the run id. */
  model?: string;
  /** Playhead position in milliseconds. Changing it seeks. Reduced motion pins it to the end. */
  defaultTime?: number;
  /** Start replaying on mount. Ignored under `prefers-reduced-motion`. */
  autoPlay?: boolean;
  /** Restart after the run finishes. Off by default. */
  loop?: boolean;
  /** Playback rate. 1 replays the run in real time. */
  speed?: number;
  /** Pause at the end of the run before looping, in milliseconds. */
  holdMs?: number;
  /** Show the time ruler and its gridlines. */
  showRuler?: boolean;
  /** Show the play button, the scrub rail and the clock. */
  showTransport?: boolean;
  /** Show token counts for spans that carry them. */
  showTokens?: boolean;
  /** Width of the name gutter in pixels, used once the card itself is at least 448px wide. */
  labelWidth?: number;
  /** Height of one span row in pixels. */
  rowHeight?: number;
  /** Called when a row is activated. The playhead also seeks to that span's start. */
  onSpanSelect?: (span: TraceSpan) => void;
}

interface LaidSpan extends TraceSpan {
  depth: number;
  dur: number;
}

interface RowHandle {
  el: HTMLElement;
  meta: HTMLElement | null;
  dur: HTMLElement | null;
  status: HTMLElement | null;
  span: LaidSpan;
  lastP: number;
  lastState: string;
  lastMeta: string;
  lastDur: string;
}

const KIND_ICON = { agent: Bot, model: Cpu, tool: Wrench, io: FileText } as const;
const NICE_TICKS = [50, 100, 250, 500, 1000, 2000, 2500, 5000, 10_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const groupDigits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
};

const formatTick = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round((ms / 1000) * 10) / 10}s`;
  return `${Math.round(ms / 60_000)}m`;
};

const metaText = (span: LaidSpan, progress: number, showTokens: boolean) =>
  span.tokens != null && showTokens
    ? `${groupDigits(Math.round(span.tokens * progress))} tk`
    : progress >= 1
      ? (span.detail ?? '')
      : '';

const STATUS_WORD = { queued: 'queued', running: 'running', done: 'succeeded', error: 'failed' } as const;

const statusWord = (span: LaidSpan, state: keyof typeof STATUS_WORD) =>
  state === 'done' && span.status === 'cached' ? 'served from cache' : STATUS_WORD[state];

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

function layout(spans: TraceSpan[]): LaidSpan[] {
  const children = new Map<string, TraceSpan[]>();
  const ids = new Set(spans.map((s) => s.id));
  for (const s of spans) {
    const key = s.parentId && s.parentId !== s.id && ids.has(s.parentId) ? s.parentId : '';
    const list = children.get(key);
    if (list) list.push(s);
    else children.set(key, [s]);
  }
  const out: LaidSpan[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number) => {
    for (const kid of (children.get(parent) ?? []).slice().sort((a, b) => a.start - b.start)) {
      if (seen.has(kid.id)) continue;
      seen.add(kid.id);
      out.push({ ...kid, depth, dur: Math.max(0, kid.end - kid.start) });
      walk(kid.id, depth + 1);
    }
  };
  walk('', 0);
  for (const s of spans) if (!seen.has(s.id)) out.push({ ...s, depth: 0, dur: Math.max(0, s.end - s.start) });
  return out;
}

interface TraceSpanRowProps {
  span: LaidSpan;
  index: number;
  total: number;
  showTokens: boolean;
  selected: boolean;
  onSelect: (span: LaidSpan) => void;
  register: (index: number, handle: RowHandle | null) => void;
}

export const TraceSpanRow = React.memo(function TraceSpanRow({
  span,
  index,
  total,
  showTokens,
  selected,
  onSelect,
  register,
}: TraceSpanRowProps) {
  const Icon = KIND_ICON[span.kind ?? 'tool'];
  const accent = span.kind === 'agent' || span.kind === 'model';
  const settled = span.status === 'error' ? 'error' : 'done';
  const left = `${(span.start / total) * 100}%`;
  const width = `${Math.max(0.5, (span.dur / total) * 100)}%`;

  return (
    <div
      ref={(node) => {
        register(
          index,
          node
            ? {
                el: node,
                meta: node.querySelector<HTMLElement>("[data-part='meta']"),
                dur: node.querySelector<HTMLElement>("[data-part='dur']"),
                status: node.querySelector<HTMLElement>("[data-part='status']"),
                span,
                lastP: 1,
                lastState: settled,
                lastMeta: metaText(span, 1, showTokens),
                lastDur: formatDuration(span.dur),
              }
            : null,
        );
      }}
      data-slot="trace-span"
      data-state={settled}
      data-selected={selected ? 'true' : undefined}
      style={{ '--p': 1 } as React.CSSProperties}
      className={cn(
        'group/row relative flex h-[var(--row)] items-center px-[var(--pad)] transition-colors duration-150',
        'data-[selected=true]:bg-[var(--brand-subtle)] data-[state=running]:bg-[var(--surface-sunken)]',
      )}
    >
      {span.depth > 0 && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-[var(--pad)]">
          {Array.from({ length: span.depth }, (_, d) => (
            <span key={d} className="absolute inset-y-0 w-px bg-[var(--border)]" style={{ left: `${d * 12 + 11}px` }} />
          ))}
        </div>
      )}

      <span data-part="status" className="sr-only">
        {statusWord(span, settled)}
      </span>

      <button
        type="button"
        data-slot="trace-span-label"
        onClick={() => onSelect(span)}
        aria-label={`${span.label}, ${span.kind ?? 'tool'}, ${formatDuration(span.dur)}${
          span.attempt != null && span.attempt > 1 ? `, attempt ${span.attempt}` : ''
        }`}
        className="flex w-[var(--gutter)] shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] py-1 pr-2 text-left outline-none hover:bg-[var(--surface-sunken)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        style={{ paddingLeft: `${span.depth * 12 + 4}px` }}
      >
        <Icon
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-[var(--text-muted)] transition-colors duration-200 group-data-[state=queued]/row:text-[var(--text-subtle)]',
            accent && 'group-data-[state=done]/row:text-[var(--brand)] group-data-[state=running]/row:text-[var(--brand)]',
          )}
        />
        <span className="truncate font-mono text-xs text-[var(--text)] transition-colors duration-200 group-data-[state=queued]/row:text-[var(--text-muted)]">
          {span.label}
        </span>
        {span.attempt != null && span.attempt > 1 && (
          <span className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] px-1 font-mono text-[10px] leading-4 tabular-nums text-[var(--text-muted)]">
            ×{span.attempt}
          </span>
        )}
      </button>

      <div className="relative h-full flex-1">
        <div
          className="absolute top-1/2 h-2 min-w-[4px] -translate-y-1/2 overflow-hidden rounded-[var(--radius-pill)]"
          style={{ left, width }}
        >
          <span aria-hidden="true" className="absolute inset-0 bg-[var(--border)]" />
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-0 origin-left',
              span.status === 'error'
                ? 'bg-[var(--danger)]'
                : accent
                  ? 'bg-[var(--brand)]'
                  : span.status === 'cached'
                    ? 'bg-[var(--text-subtle)]'
                    : 'bg-[var(--text-muted)]',
            )}
            style={{ transform: 'scaleX(var(--p,1))' }}
          />
        </div>
      </div>

      <div className="flex w-[var(--meta)] shrink-0 items-center justify-end gap-1.5 pl-2 transition-opacity duration-200 group-data-[state=queued]/row:opacity-0">
        {span.status === 'error' && <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-[var(--danger)]" />}
        {span.status === 'cached' && <Zap aria-hidden="true" className="size-3.5 shrink-0 text-[var(--text-muted)]" />}
        <span
          data-part="meta"
          className="hidden truncate font-mono text-[11px] tabular-nums text-[var(--text-muted)] @md/trace:inline"
        >
          {metaText(span, 1, showTokens)}
        </span>
        <span
          data-part="dur"
          className={cn(
            'shrink-0 font-mono text-[11px] tabular-nums',
            span.status === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-subtle)]',
          )}
        >
          {formatDuration(span.dur)}
        </span>
      </div>
    </div>
  );
});

export function AgentTrace({
  spans,
  duration,
  runId = 'shift',
  model,
  defaultTime,
  autoPlay = false,
  loop = false,
  speed = 1,
  holdMs = 900,
  showRuler = true,
  showTransport = true,
  showTokens = true,
  labelWidth = 200,
  rowHeight = 34,
  onSpanSelect,
  className,
  style,
  ref,
  ...rest
}: AgentTraceProps) {
  const rows = React.useMemo(() => layout(spans), [spans]);
  const total = React.useMemo(
    () => Math.max(1, duration ?? rows.reduce((max, s) => Math.max(max, s.end), 0)),
    [rows, duration],
  );
  const initialTime = defaultTime ?? total;

  const rootRef = React.useRef<HTMLDivElement>(null);
  const railRef = React.useRef<HTMLDivElement>(null);
  const clockRef = React.useRef<HTMLSpanElement>(null);
  const statusRef = React.useRef<HTMLSpanElement>(null);
  const rowsRef = React.useRef<(RowHandle | null)[]>([]);
  const timeRef = React.useRef(initialTime);
  const playingRef = React.useRef(false);
  const seekRef = React.useRef<(ms: number) => void>(() => {});
  const runRef = React.useRef<() => void>(() => {});
  const haltRef = React.useRef<() => void>(() => {});
  const [playing, setPlaying] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);

  const ticks = React.useMemo(() => {
    const step = NICE_TICKS.find((t) => total / t <= 8) ?? total / 4;
    const out: number[] = [];
    for (let t = step; t < total; t += step) out.push(t);
    return out;
  }, [total]);

  const opts = React.useRef({ loop, speed, holdMs, showTokens, total });
  useIsomorphicLayoutEffect(() => {
    opts.current = { loop, speed, holdMs, showTokens, total };
  });

  const registerRow = React.useCallback((index: number, handle: RowHandle | null) => {
    rowsRef.current[index] = handle;
  }, []);

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0;
    let last = 0;
    let holdUntil = 0;
    let onScreen = true;
    let ariaAt = -1;

    let lastT = '';
    let lastRun = '';
    const paint = () => {
      const t = timeRef.current;
      const o = opts.current;
      const ratio = (t / o.total).toFixed(5);
      if (ratio !== lastT) {
        root.style.setProperty('--t', ratio);
        lastT = ratio;
      }

      for (const row of rowsRef.current) {
        if (!row) continue;
        const { span } = row;
        const p = span.dur > 0 ? clamp((t - span.start) / span.dur, 0, 1) : t >= span.start ? 1 : 0;
        if (p !== row.lastP) {
          row.el.style.setProperty('--p', p.toFixed(4));
          row.lastP = p;
        }
        const state = t < span.start ? 'queued' : p < 1 ? 'running' : span.status === 'error' ? 'error' : 'done';
        if (state !== row.lastState) {
          row.el.dataset.state = state;
          if (row.status) row.status.textContent = statusWord(span, state);
          row.lastState = state;
        }
        const dur = state === 'queued' ? '' : formatDuration(span.dur * p);
        if (row.dur && dur !== row.lastDur) {
          row.dur.textContent = dur;
          row.lastDur = dur;
        }
        const meta = state === 'queued' ? '' : metaText(span, p, o.showTokens);
        if (row.meta && meta !== row.lastMeta) {
          row.meta.textContent = meta;
          row.lastMeta = meta;
        }
      }

      if (clockRef.current) {
        clockRef.current.textContent = `${formatDuration(t)} / ${formatDuration(o.total)}`;
      }
      const runState = t >= o.total ? 'complete' : 'running';
      if (runState !== lastRun) {
        root.dataset.run = runState;
        if (statusRef.current) statusRef.current.textContent = runState === 'complete' ? 'Completed' : 'Replaying';
        lastRun = runState;
      }

      const rail = playingRef.current ? null : railRef.current;
      const decis = Math.round(t / 100);
      if (rail && decis !== ariaAt) {
        ariaAt = decis;
        rail.setAttribute('aria-valuenow', String(Math.round(t)));
        rail.setAttribute('aria-valuetext', `${formatDuration(t)} of ${formatDuration(o.total)}`);
      }
    };

    const frame = (now: number) => {
      raf = 0;
      const o = opts.current;
      const dt = Math.min(now - (last || now), 100);
      last = now;
      if (holdUntil > 0) {
        if (now >= holdUntil) {
          holdUntil = 0;
          timeRef.current = 0;
        }
      } else {
        // Normalize playback so long real-world shifts replay smoothly in ~6 seconds at speed=1.
        const replayScale = o.total > 12_000 ? o.total / 6000 : 1;
        timeRef.current += dt * o.speed * replayScale;
        if (timeRef.current >= o.total) {
          timeRef.current = o.total;
          if (o.loop) holdUntil = now + o.holdMs;
          else {
            playingRef.current = false;
            setPlaying(false);
          }
        }
      }
      paint();
      if (playingRef.current) raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf || !playingRef.current || !onScreen || document.hidden) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const halt = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    runRef.current = start;
    haltRef.current = halt;
    seekRef.current = (ms: number) => {
      timeRef.current = clamp(ms, 0, opts.current.total);
      holdUntil = 0;
      last = 0;
      paint();
    };

    if (media.matches) {
      timeRef.current = opts.current.total;
    } else if (autoPlay) {
      playingRef.current = true;
      setPlaying(true);
    }
    paint();

    const onVisibility = () => (document.hidden ? halt() : start());
    const onMedia = () => {
      if (!media.matches) return;
      playingRef.current = false;
      setPlaying(false);
      halt();
      seekRef.current(opts.current.total);
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry?.isIntersecting ?? true;
        if (onScreen) start();
        else halt();
      },
      { threshold: 0 },
    );

    io.observe(root);
    document.addEventListener('visibilitychange', onVisibility);
    media.addEventListener('change', onMedia);
    start();

    return () => {
      halt();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      media.removeEventListener('change', onMedia);
      runRef.current = () => {};
      haltRef.current = () => {};
      seekRef.current = () => {};
    };
  }, [autoPlay]);

  useIsomorphicLayoutEffect(() => {
    rowsRef.current.length = rows.length;
    seekRef.current(timeRef.current);
  }, [rows, total, showTokens, rowHeight, labelWidth]);

  const appliedDefault = React.useRef(initialTime);
  useIsomorphicLayoutEffect(() => {
    if (appliedDefault.current === initialTime) return;
    appliedDefault.current = initialTime;
    seekRef.current(initialTime);
  }, [initialTime]);

  const togglePlay = () => {
    const next = !playingRef.current;
    if (next && timeRef.current >= total) timeRef.current = 0;
    playingRef.current = next;
    setPlaying(next);
    seekRef.current(timeRef.current);
    if (next) runRef.current();
    else haltRef.current();
  };

  const scrubFrom = (clientX: number, el: HTMLElement) => {
    const inset = Number(el.dataset.inset ?? 0);
    const rect = el.getBoundingClientRect();
    const width = rect.width - inset * 2;
    if (width > 0) seekRef.current(((clientX - rect.left - inset) / width) * total);
  };
  const onScrubDown = (e: React.PointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubFrom(e.clientX, e.currentTarget);
  };
  const onScrubMove = (e: React.PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubFrom(e.clientX, e.currentTarget);
  };
  const onScrubUp = (e: React.PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onRailKeyDown = (e: React.KeyboardEvent) => {
    const step = total / 50;
    const delta: Record<string, number> = {
      ArrowRight: step,
      ArrowUp: step,
      ArrowLeft: -step,
      ArrowDown: -step,
      PageUp: step * 10,
      PageDown: step * -10,
    };
    if (e.key === 'Home') seekRef.current(0);
    else if (e.key === 'End') seekRef.current(total);
    else if (e.key in delta) seekRef.current(timeRef.current + (delta[e.key] ?? 0));
    else return;
    e.preventDefault();
  };

  const onSpanSelectRef = React.useRef(onSpanSelect);
  onSpanSelectRef.current = onSpanSelect;
  const selectSpan = React.useCallback((span: LaidSpan) => {
    setSelected(span.id);
    seekRef.current(span.start);
    onSpanSelectRef.current?.(span);
  }, []);

  const trackBox = 'absolute left-[calc(var(--gutter)+var(--pad))] right-[calc(var(--meta)+var(--pad))]';

  return (
    <div
      ref={(node) => {
        rootRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      data-slot="agent-trace"
      style={
        {
          '--label-w': `${labelWidth}px`,
          '--row': `${rowHeight}px`,
          '--pad': '0.75rem',
          ...style,
        } as React.CSSProperties
      }
      className={cn(
        'group/trace @container/trace w-full overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]',
        className,
      )}
      {...rest}
    >
      <div data-slot="trace-header" className="flex items-center gap-2.5 border-b border-[var(--border)] px-3 py-2.5">
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-[var(--text-subtle)] transition-colors duration-300 group-data-[run=running]/trace:bg-[var(--brand)]"
        />
        <span className="truncate font-mono text-[13px] font-medium leading-none text-[var(--text)]">{runId}</span>
        <span className="hidden truncate text-xs leading-none text-[var(--text-muted)] @sm/trace:inline">
          {model ? `${model} · ` : ''}
          {rows.length} spans
        </span>
        <span
          ref={statusRef}
          className="ml-auto shrink-0 rounded-[var(--radius-pill)] border border-[var(--border)] px-2 py-0.5 font-mono text-[11px] leading-4 text-[var(--text-muted)]"
        >
          Completed
        </span>
      </div>

      <div
        className={cn(
          'relative',
          '[--gutter:96px] [--meta:3.75rem]',
          '@xs/trace:[--gutter:132px] @xs/trace:[--meta:5rem]',
          '@md/trace:[--gutter:var(--label-w)] @md/trace:[--meta:9rem]',
        )}
      >
        {showRuler && (
          <div
            data-slot="trace-ruler"
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubUp}
            className="relative h-7 cursor-ew-resize touch-none select-none border-b border-[var(--border)] @max-sm/trace:hidden"
          >
            <div className={cn(trackBox, 'inset-y-0')}>
              {ticks.map((t) => (
                <span
                  key={t}
                  className="absolute top-2 -translate-x-1/2 font-mono text-[10px] leading-none tabular-nums text-[var(--text-subtle)]"
                  style={{ left: `${(t / total) * 100}%` }}
                >
                  {formatTick(t)}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="relative py-1">
          {showRuler && (
            <div aria-hidden="true" className={cn(trackBox, 'inset-y-0 @max-sm/trace:hidden')}>
              {ticks.map((t) => (
                <span
                  key={t}
                  className="absolute inset-y-0 w-px bg-[var(--border)] opacity-60"
                  style={{ left: `${(t / total) * 100}%` }}
                />
              ))}
            </div>
          )}

          <ol aria-label={`Spans in ${runId}`} className="relative">
            {rows.map((span, i) => (
              <li key={span.id}>
                <TraceSpanRow
                  span={span}
                  index={i}
                  total={total}
                  showTokens={showTokens}
                  selected={selected === span.id}
                  onSelect={selectSpan}
                  register={registerRow}
                />
              </li>
            ))}
          </ol>

          <div aria-hidden="true" className={cn(trackBox, 'pointer-events-none inset-y-0')}>
            <div className="relative h-full w-full" style={{ transform: 'translateX(calc(var(--t,0) * 100%))' }}>
              <span className="absolute inset-y-0 w-px bg-[var(--brand)] opacity-75" />
              <span className="absolute top-0 size-1.5 -translate-x-[2.5px] rotate-45 bg-[var(--brand)]" />
            </div>
          </div>

          <div
            data-slot="trace-scrub"
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubUp}
            className={cn(trackBox, 'inset-y-0 cursor-ew-resize touch-none select-none')}
          />
        </div>
      </div>

      {showTransport && (
        <div className="flex items-center gap-3 border-t border-[var(--border)] px-3 py-2">
          <button
            type="button"
            data-slot="cta-primary"
            onClick={togglePlay}
            aria-label={playing ? 'Pause replay' : 'Play replay'}
            className={cn(
              'relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--brand)] text-[var(--on-brand)]',
              'shadow-sm outline-none transition-[transform,opacity] duration-150 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--focus)] active:scale-[0.98]',
              "before:absolute before:-inset-1 before:content-['']",
            )}
          >
            {playing ? (
              <Pause aria-hidden="true" className="size-3.5 fill-current" />
            ) : (
              <Play aria-hidden="true" className="size-3.5 translate-x-px fill-current" />
            )}
          </button>

          <div
            ref={railRef}
            role="slider"
            tabIndex={0}
            aria-label="Playhead"
            aria-valuemin={0}
            aria-valuemax={Math.round(total)}
            aria-valuenow={Math.round(clamp(initialTime, 0, total))}
            data-inset="6"
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubUp}
            onKeyDown={onRailKeyDown}
            className="relative h-9 flex-1 cursor-ew-resize touch-none select-none rounded-[var(--radius-sm)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
          >
            <div className="absolute inset-x-1.5 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--border)]">
              <div
                aria-hidden="true"
                className="h-full w-full origin-left bg-[var(--brand)]"
                style={{ transform: 'scaleX(var(--t,0))' }}
              />
            </div>
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1.5 right-1.5">
              <div className="relative h-full w-full" style={{ transform: 'translateX(calc(var(--t,0) * 100%))' }}>
                <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--surface)] bg-[var(--brand)] shadow-sm" />
              </div>
            </div>
          </div>

          <span
            ref={clockRef}
            className="w-[7.5rem] shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--text-muted)]"
          />
        </div>
      )}
    </div>
  );
}

export default AgentTrace;
