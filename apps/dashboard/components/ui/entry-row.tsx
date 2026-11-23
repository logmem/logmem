import { CopyId } from './copy-id';
import { KindChip } from './kind-chip';

export function EntryRow({
  timeLabel,
  timeTitle,
  kind,
  actor,
  summary,
  where,
  trail,
  origin,
  via,
}: {
  timeLabel: string;
  timeTitle?: string;
  kind?: string | null;
  actor?: string | null;
  summary: string;
  where?: string | null;
  trail?: string | null;
  origin?: string | null;
  via?: string | null;
}) {
  return (
    <li className="lm-entry-row">
      <time className="lm-entry-time" title={timeTitle}>
        {timeLabel}
      </time>
      <div>
        <KindChip kind={kind} />
      </div>
      <div className="lm-entry-body">
        <div className="lm-entry-line">
          {actor ? <span className="lm-entry-actor">{actor}</span> : null}
          <span>{summary}</span>
        </div>
        {(where || trail || origin || via) ? (
          <div className="lm-entry-prov">
            {where ? <span>{where}</span> : null}
            {trail ? <CopyId id={trail} label={`Copy trail ${trail}`} /> : null}
            {origin ? <span>↳ {origin}</span> : null}
            {via ? <span>via {via}</span> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
