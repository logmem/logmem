'use client';

// Adapted from 21st.dev component 46226 (kemiljk — WAI-ARIA 1.2 Combobox),
// restyled strictly to LogMem semantic var(--*) tokens (zero raw hex).
import * as React from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';

export interface AgentComboboxProps {
  id?: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

export function AgentCombobox({
  id = 'inbox-agent-combobox',
  options,
  value,
  onChange,
  placeholder = 'Filter by agent…',
  ariaLabel = 'Filter by recipient agent',
  inputRef,
}: AgentComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState(value);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setQuery(value);
  }, [value]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  React.useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const listboxId = `${id}-listbox`;

  const commit = (next: string) => {
    onChange(next);
    setQuery(next);
    setOpen(false);
    setActiveIndex(-1);
  };

  return (
    <div ref={containerRef} className="relative min-w-[200px] max-w-full">
      <div className="relative flex items-center">
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeIndex >= 0 && filtered[activeIndex]
              ? `${id}-opt-${activeIndex}`
              : undefined
          }
          value={query}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            setOpen(true);
            setActiveIndex(-1);
            if (!next.trim()) onChange('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIndex((i) => Math.max(-1, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (open && activeIndex >= 0 && filtered[activeIndex]) {
                commit(filtered[activeIndex]);
              } else {
                commit(query.trim());
              }
            } else if (e.key === 'Escape') {
              setOpen(false);
              setActiveIndex(-1);
            }
          }}
          className={`min-h-[38px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-3 pr-14 text-sm text-[var(--text)] placeholder:text-[var(--text-subtle)] ${FOCUS}`}
        />
        <div className="absolute right-1.5 flex items-center gap-0.5">
          {value && (
            <button
              type="button"
              onClick={() => commit('')}
              aria-label="Clear agent filter"
              className={`flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)] ${FOCUS}`}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            aria-label="Toggle agent list"
            onClick={() => setOpen((o) => !o)}
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:text-[var(--text)]"
          >
            <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-60 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-raised)] p-1 shadow-[var(--shadow-2)]"
        >
          {filtered.length === 0 ? (
            <li className="px-2.5 py-2 text-xs text-[var(--text-subtle)]">No matching agents</li>
          ) : (
            filtered.slice(0, 14).map((opt, idx) => {
              const selected = opt === value;
              const active = idx === activeIndex;
              return (
                <li
                  key={opt}
                  id={`${id}-opt-${idx}`}
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(opt);
                  }}
                  className={`flex cursor-pointer items-center justify-between rounded-[var(--radius-sm)] px-2.5 py-2 text-sm ${
                    active ? 'bg-[var(--surface-sunken)]' : 'hover:bg-[var(--surface-sunken)]'
                  } ${selected ? 'font-semibold text-[var(--brand)]' : 'text-[var(--text)]'}`}
                >
                  <span>{opt}</span>
                  {selected && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
