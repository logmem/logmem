'use client';

// Adapted from 21st.dev Knowledge Graph with LobeHub agent icons inside circular nodes,
// interactive zoom/reset/SVG export, drag repositioning, directional curved links with labels,
// hover tooltip, and legend overlay — strictly LogMem var(--*) tokens (zero raw hex).
import * as React from 'react';
import { Download, Minus, Plus, RotateCcw } from 'lucide-react';
import { resolveLobeIconSrc } from './heat-map-xl';

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  waiting: number;
  late: number;
}

export interface KnowledgeGraphLink {
  source: string;
  target: string;
  count: number;
  label: string;
  band: 'fresh' | 'slow' | 'stale';
}

export interface KnowledgeGraphProps {
  nodes: KnowledgeGraphNode[];
  links: KnowledgeGraphLink[];
  selectedNodeId?: string;
  onNodeClick?: (nodeId: string) => void;
}

const W = 640;
const H = 430;
const CX = 320;
const CY = 215;
const R = 152;
const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

function ringPos(count: number, index: number) {
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(count, 1);
  return { x: Math.round(CX + R * Math.cos(angle)), y: Math.round(CY + R * Math.sin(angle)) };
}

function curvedPath(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  hasReverse: boolean,
  pad = 29,
) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  const sx = p1.x + ux * pad;
  const sy = p1.y + uy * pad;
  const ex = p2.x - ux * pad;
  const ey = p2.y - uy * pad;
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  let qx: number;
  let qy: number;
  if (hasReverse) {
    const bend = Math.min(46, Math.max(26, dist * 0.22));
    qx = mx - uy * bend;
    qy = my + ux * bend;
  } else {
    qx = mx + (CX - mx) * 0.24;
    qy = my + (CY - my) * 0.24;
  }
  return {
    d: `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`,
    lx: Math.round((sx + 2 * qx + ex) / 4),
    ly: Math.round((sy + 2 * qy + ey) / 4),
  };
}

export function KnowledgeGraph({
  nodes,
  links,
  selectedNodeId = '',
  onNodeClick,
}: KnowledgeGraphProps) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = React.useState(1);
  const [hoveredId, setHoveredId] = React.useState<string>('');
  const [offsets, setOffsets] = React.useState<Record<string, { dx: number; dy: number }>>({});

  const focusId = hoveredId || selectedNodeId;

  const positions = React.useMemo(() => {
    const map: Record<string, { x: number; y: number }> = {};
    nodes.forEach((n, idx) => {
      const base = ringPos(nodes.length, idx);
      const off = offsets[n.id] || { dx: 0, dy: 0 };
      map[n.id] = { x: base.x + off.dx, y: base.y + off.dy };
    });
    return map;
  }, [nodes, offsets]);

  const exportAsSVG = () => {
    if (!svgRef.current) return;
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    const data = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'logmem-handoff-network.svg';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDragStart = (nodeId: string) => (ev: React.PointerEvent) => {
    if (ev.button !== 0 || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const orig = offsets[nodeId] || { dx: 0, dy: 0 };

    const onMove = (m: PointerEvent) => {
      const sx = W / Math.max(rect.width, 1) / zoom;
      const sy = H / Math.max(rect.height, 1) / zoom;
      const dx = (m.clientX - startX) * sx;
      const dy = (m.clientY - startY) * sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        setOffsets((prev) => ({ ...prev, [nodeId]: { dx: orig.dx + dx, dy: orig.dy + dy } }));
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const isNear = (id: string) =>
    !focusId ||
    id === focusId ||
    links.some((l) => (l.source === focusId && l.target === id) || (l.target === focusId && l.source === id));

  const hoveredNode = nodes.find((n) => n.id === hoveredId) || null;

  const bandStroke = (band: KnowledgeGraphLink['band']) =>
    band === 'stale' ? 'var(--danger)' : band === 'slow' ? 'var(--warning)' : 'var(--brand)';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-1.5" role="toolbar" aria-label="Network controls">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(2, +(z + 0.2).toFixed(2)))}
          className={`inline-flex h-7 items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] ${FOCUS}`}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(2)))}
          className={`inline-flex h-7 items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] ${FOCUS}`}
        >
          <Minus className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setOffsets({});
          }}
          className={`inline-flex h-7 items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] ${FOCUS}`}
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          Reset
        </button>
        <button
          type="button"
          onClick={exportAsSVG}
          className={`inline-flex h-7 items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] ${FOCUS}`}
        >
          <Download className="h-3 w-3" aria-hidden="true" />
          Export SVG
        </button>
      </div>

      <div className="relative overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--surface-sunken)]">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="block max-h-[430px] w-full select-none"
          role="group"
          aria-label={`Network graph with ${nodes.length} agents and ${links.length} handoff routes`}
        >
          <defs>
            {(['fresh', 'slow', 'stale'] as const).map((b) => (
              <marker
                key={b}
                id={`kg-arrow-${b}`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6.5"
                markerHeight="6.5"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 z" fill={bandStroke(b)} />
              </marker>
            ))}
            {nodes.map((n, i) => {
              const p = positions[n.id];
              return (
                <clipPath key={n.id} id={`kg-clip-${i}`}>
                  <circle cx={p.x} cy={p.y} r="17" />
                </clipPath>
              );
            })}
          </defs>

          <g transform={`translate(${CX} ${CY}) scale(${zoom}) translate(${-CX} ${-CY})`}>
            <circle
              cx={CX}
              cy={CY}
              r={R}
              fill="none"
              stroke="var(--border)"
              strokeDasharray="4 6"
              strokeWidth="1.2"
            />

            {links.map((edge) => {
              const p1 = positions[edge.source];
              const p2 = positions[edge.target];
              if (!p1 || !p2) return null;
              const hasReverse = links.some((l) => l.source === edge.target && l.target === edge.source);
              const { d, lx, ly } = curvedPath(p1, p2, hasReverse);
              const lit = !focusId || edge.source === focusId || edge.target === focusId;
              return (
                <g key={`${edge.source}>${edge.target}`} opacity={lit ? 1 : 0.18}>
                  <path
                    d={d}
                    fill="none"
                    stroke={bandStroke(edge.band)}
                    strokeWidth={Math.min(4, 1.8 + edge.count * 0.5)}
                    strokeLinecap="round"
                    markerEnd={`url(#kg-arrow-${edge.band})`}
                  />
                  <g transform={`translate(${lx} ${ly})`}>
                    <rect
                      x="-24"
                      y="-9"
                      width="48"
                      height="18"
                      rx="9"
                      fill="var(--surface)"
                      stroke="var(--border)"
                      strokeWidth="1"
                    />
                    <text
                      textAnchor="middle"
                      dy=".34em"
                      fill="var(--text-muted)"
                      fontSize="9.5"
                      fontFamily="var(--font-mono)"
                    >
                      {edge.count} · {edge.label}
                    </text>
                  </g>
                </g>
              );
            })}

            {nodes.map((node, i) => {
              const p = positions[node.id];
              const active = selectedNodeId === node.id;
              const ringColor = active
                ? 'var(--focus)'
                : node.late > 0
                  ? 'var(--danger)'
                  : node.waiting > 0
                    ? 'var(--brand)'
                    : 'var(--border-strong)';
              return (
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  aria-label={`${node.label}: ${node.waiting} waiting${node.late ? `, ${node.late} delayed` : ''}`}
                  opacity={isNear(node.id) ? 1 : 0.28}
                  className="cursor-grab active:cursor-grabbing"
                  onPointerDown={handleDragStart(node.id)}
                  onClick={() => onNodeClick?.(active ? '' : node.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onNodeClick?.(active ? '' : node.id);
                    }
                  }}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId('')}
                  onFocus={() => setHoveredId(node.id)}
                  onBlur={() => setHoveredId('')}
                >
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r="25"
                    fill="var(--surface)"
                    stroke={ringColor}
                    strokeWidth={active ? 3 : 2}
                  />
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r="20"
                    className="fill-[var(--surface-raised)] dark:fill-[var(--text)]"
                    stroke="var(--border)"
                    strokeWidth="1"
                  />
                  <image
                    href={resolveLobeIconSrc(node.label)}
                    x={p.x - 13}
                    y={p.y - 13}
                    width="26"
                    height="26"
                    clipPath={`url(#kg-clip-${i})`}
                    preserveAspectRatio="xMidYMid meet"
                  />
                  <text
                    x={p.x}
                    y={p.y < CY - 30 ? p.y - 33 : p.y + 40}
                    textAnchor="middle"
                    fill="var(--text)"
                    fontSize="11.5"
                    fontWeight="600"
                    fontFamily="var(--font-sans)"
                  >
                    {node.label}
                  </text>
                  {node.waiting > 0 && (
                    <g>
                      <circle
                        cx={p.x + 19}
                        cy={p.y - 19}
                        r="10"
                        fill={node.late > 0 ? 'var(--danger)' : 'var(--brand)'}
                      />
                      <text
                        x={p.x + 19}
                        y={p.y - 15}
                        textAnchor="middle"
                        fill="var(--text-inverse)"
                        fontSize="10"
                        fontWeight="700"
                        fontFamily="var(--font-mono)"
                      >
                        {node.waiting}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {hoveredNode && (
          <div
            role="status"
            className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-1.5 text-xs text-[var(--text)] shadow-[var(--shadow-2)]"
          >
            <strong>{hoveredNode.label}</strong> ·{' '}
            {hoveredNode.waiting > 0
              ? `${hoveredNode.waiting} waiting${hoveredNode.late ? ` (${hoveredNode.late} delayed)` : ''}`
              : 'sender only'}{' '}
            · click to filter
          </div>
        )}

        <aside
          aria-label="Network wait age legend"
          className="absolute right-3 top-3 z-10 space-y-1 rounded-[10px] border border-[var(--border)] bg-[var(--surface)]/90 px-2.5 py-2 text-[11px] text-[var(--text-muted)] backdrop-blur-sm"
        >
          <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
            Wait age
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-[var(--brand)]" />
            <span>Under 1 day</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-[var(--warning)]" />
            <span>1 to 7 days</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-[var(--danger)]" />
            <span>Over 7 days</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
