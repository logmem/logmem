import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="lm-page-header">
      <div className="lm-page-header-main">
        <h1 className="lm-page-header-title">{title}</h1>
        {subtitle ? <p className="lm-page-header-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="lm-page-header-actions">{actions}</div> : null}
    </header>
  );
}
