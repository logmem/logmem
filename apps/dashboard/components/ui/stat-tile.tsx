import Link from 'next/link';

export function StatTile({
  label,
  value,
  note,
  href,
  tone,
}: {
  label: string;
  value: number | string;
  note?: string;
  href?: string;
  tone?: 'danger' | 'warning' | 'default';
}) {
  const isZero = value === 0 || value === '0';
  const cls = `lm-stat-tile${isZero ? ' is-zero' : ''}`;
  const valueClass =
    tone === 'danger' && !isZero
      ? 'lm-stat-tile-value text-[var(--danger)]'
      : tone === 'warning' && !isZero
        ? 'lm-stat-tile-value text-[var(--warning)]'
        : 'lm-stat-tile-value';

  const body = (
    <>
      <span className="lm-stat-tile-label">{label}</span>
      <strong className={valueClass}>{value}</strong>
      {note ? <span className="lm-stat-tile-note">{note}</span> : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={cls}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}
