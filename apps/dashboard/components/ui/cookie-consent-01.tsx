'use client';

import { useEffect, useState } from 'react';
import { Check, Cookie, Settings2, X } from 'lucide-react';
import { Button } from './button';
import { cn } from '../../lib/utils';

export interface CookieConsentPreferences {
  necessary: true;
  analytics: boolean;
  updatedAt: number;
}

export interface CookieConsentProps {
  storageKey?: string;
  privacyHref?: string;
  onConsentChange?: (prefs: CookieConsentPreferences) => void;
  className?: string;
}

export function CookieConsent({
  storageKey = 'lm_cookie_consent',
  privacyHref = '/privacy',
  onConsentChange,
  className,
}: CookieConsentProps) {
  const [visible, setVisible] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed?.analytics === 'boolean') {
          setAnalytics(parsed.analytics);
          return;
        }
      }
    } catch {
      // ignore storage errors
    }
    const timer = window.setTimeout(() => setVisible(true), 600);
    return () => window.clearTimeout(timer);
  }, [storageKey]);

  function commit(acceptAnalytics: boolean, message: string) {
    const prefs: CookieConsentPreferences = {
      necessary: true,
      analytics: acceptAnalytics,
      updatedAt: Date.now(),
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(prefs));
    } catch {
      // ignore
    }
    setAnalytics(acceptAnalytics);
    setPrefsOpen(false);
    setVisible(false);
    setToastMsg(message);
    window.setTimeout(() => setToastMsg(''), 2600);
    onConsentChange?.(prefs);
  }

  return (
    <>
      {toastMsg ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 inline-flex items-center gap-2 rounded-[var(--radius-pill)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 py-2 text-xs font-medium text-[var(--text)] shadow-lg"
        >
          <Check className="h-3.5 w-3.5 text-[var(--success)]" aria-hidden="true" />
          <span>{toastMsg}</span>
        </div>
      ) : null}

      <aside
        aria-label="Cookie consent"
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 mx-auto w-full max-w-5xl px-4 pb-5 transition-all duration-500',
          visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full opacity-0',
          className,
        )}
      >
        <div className="rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--surface)] px-5 py-5 shadow-lg md:px-7 md:py-6">
          {prefsOpen ? (
            <div className="mb-4 space-y-3 border-b border-[var(--border)] pb-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-heading text-sm font-semibold text-[var(--text)]">
                  Cookie preferences
                </h2>
                <button
                  type="button"
                  onClick={() => setPrefsOpen(false)}
                  aria-label="Close cookie preferences"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-[var(--text)]">
                    <span>Necessary</span>
                    <span className="font-mono text-[11px] text-[var(--success)]">Always on</span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    Keeps you signed in and remembers this choice.
                  </p>
                </div>
                <label className="flex cursor-pointer flex-col justify-between rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
                  <div className="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--text)]">
                    <span>Analytics</span>
                    <input
                      type="checkbox"
                      checked={analytics}
                      onChange={(e) => setAnalytics(e.target.checked)}
                      className="h-4 w-4 accent-[var(--brand)]"
                    />
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    Google Analytics &amp; Tag Manager. Stays off until you accept.
                  </p>
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <a href={privacyHref} className="text-xs text-[var(--link)] hover:underline">
                  Privacy policy
                </a>
                <Button
                  size="sm"
                  className="rounded-full px-5"
                  onClick={() => commit(analytics, 'Cookie preferences saved.')}
                >
                  Save choices
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-4 md:flex-nowrap md:gap-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--brand)]">
                <Cookie className="h-4 w-4" aria-hidden="true" />
              </div>
              <p className="text-sm text-[var(--text-muted)] md:text-base">
                By clicking accept, you consent to analytics cookies.{' '}
                <a href={privacyHref} className="text-[var(--link)] underline-offset-4 hover:underline">
                  Privacy policy
                </a>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Cookie settings"
                aria-expanded={prefsOpen}
                className="h-10 w-10 rounded-full"
                onClick={() => setPrefsOpen((o) => !o)}
              >
                <Settings2 className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                className="h-10 rounded-full px-5 font-medium"
                onClick={() => commit(false, 'Optional cookies rejected.')}
              >
                Reject all
              </Button>
              <Button
                className="h-10 rounded-full px-6 font-medium"
                onClick={() => commit(true, 'Cookies accepted.')}
              >
                Accept
              </Button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

export default CookieConsent;
