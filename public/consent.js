// consent.js: LogMem Design System Cookie Consent (cookie-consent-01).
// Google tags load only after explicit analytics consent (window.logmemLoadGoogleTags).
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var STORAGE_KEY = 'lm_cookie_consent';
  var COOKIE_NAME = 'cc_cookie';

  function readConsent() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (typeof parsed.analytics === 'boolean') return parsed;
      }
    } catch (_) {}
    try {
      var match = document.cookie.split('; ').find(function (c) {
        return c.indexOf(COOKIE_NAME + '=') === 0;
      });
      if (match) {
        var val = JSON.parse(decodeURIComponent(match.split('=').slice(1).join('=')));
        if (Array.isArray(val.categories)) {
          return { necessary: true, analytics: val.categories.indexOf('analytics') !== -1 };
        }
      }
    } catch (_) {}
    return null;
  }

  function clearAnalyticsCookies() {
    var names = document.cookie.split('; ').map(function (c) { return c.split('=')[0]; });
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (n === '_gid' || n.indexOf('_ga') === 0) {
        document.cookie = n + '=; Max-Age=0; path=/; SameSite=Lax';
      }
    }
  }

  function writeConsent(analytics) {
    var payload = { necessary: true, analytics: Boolean(analytics), updatedAt: Date.now() };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
    var legacyShape = { categories: analytics ? ['necessary', 'analytics'] : ['necessary'] };
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie =
      COOKIE_NAME +
      '=' +
      encodeURIComponent(JSON.stringify(legacyShape)) +
      '; Max-Age=' +
      182 * 86400 +
      '; path=/; SameSite=Lax' +
      secure;
    if (analytics) {
      if (window.logmemLoadGoogleTags) window.logmemLoadGoogleTags();
    } else {
      clearAnalyticsCookies();
    }
  }

  function showToast(text) {
    var t = document.createElement('div');
    t.className = 'lm-cc-toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    t.textContent = text;
    document.body.appendChild(t);
    window.setTimeout(function () {
      t.remove();
    }, 2600);
  }

  function acceptedAnalytics(state) {
    return Boolean(state && state.analytics === true);
  }

  var existing = readConsent();
  if (acceptedAnalytics(existing) && window.logmemLoadGoogleTags) {
    window.logmemLoadGoogleTags();
    return;
  }
  if (existing) return;

  function mountBanner() {
    if (document.getElementById('lm-cookie-consent')) return;
    var wrap = document.createElement('aside');
    wrap.id = 'lm-cookie-consent';
    wrap.className = 'lm-cc-wrap';
    wrap.setAttribute('aria-label', 'Cookie consent');

    wrap.innerHTML =
      '<div class="lm-cc-card">' +
      '  <div class="lm-cc-prefs" id="lm-cc-prefs">' +
      '    <div class="lm-cc-prefs-head">' +
      '      <strong>Cookie choices</strong>' +
      '      <button type="button" class="lm-cc-btn lm-cc-btn--gear" id="lm-cc-close-prefs" aria-label="Close preferences">✕</button>' +
      '    </div>' +
      '    <div class="lm-cc-prefs-grid">' +
      '      <div class="lm-cc-pref-box">' +
      '        <div class="lm-cc-pref-top"><span>Necessary</span><span class="lm-cc-pref-always">Always on</span></div>' +
      '        <span>Keeps you signed in and remembers this choice.</span>' +
      '      </div>' +
      '      <label class="lm-cc-pref-box" style="cursor:pointer">' +
      '        <div class="lm-cc-pref-top"><span>Analytics</span><input type="checkbox" id="lm-cc-analytics"></div>' +
      '        <span>Google Analytics and Tag Manager. Off until you accept.</span>' +
      '      </label>' +
      '    </div>' +
      '    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
      '      <a href="/privacy" style="font-size:12.5px;color:var(--link,#0e6863)">Privacy policy</a>' +
      '      <button type="button" class="lm-cc-btn lm-cc-btn--accept" id="lm-cc-save">Save choices</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="lm-cc-row">' +
      '    <div class="lm-cc-copy">' +
      '      <span class="lm-cc-icon" aria-hidden="true">' +
      '        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/></svg>' +
      '      </span>' +
      '      <p>By clicking accept, you consent to our use of analytics cookies. <a href="/privacy">Privacy policy</a></p>' +
      '    </div>' +
      '    <div class="lm-cc-actions">' +
      '      <button type="button" class="lm-cc-btn lm-cc-btn--gear" id="lm-cc-gear" aria-label="Cookie settings" aria-expanded="false">' +
      '        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>' +
      '      </button>' +
      '      <button type="button" class="lm-cc-btn lm-cc-btn--reject" id="lm-cc-reject">Reject all</button>' +
      '      <button type="button" class="lm-cc-btn lm-cc-btn--accept" id="lm-cc-accept">Accept</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    document.body.appendChild(wrap);
    window.setTimeout(function () {
      wrap.classList.add('is-visible');
    }, 350);

    var prefsEl = document.getElementById('lm-cc-prefs');
    var gearBtn = document.getElementById('lm-cc-gear');
    var closePrefs = document.getElementById('lm-cc-close-prefs');
    var analyticsChk = document.getElementById('lm-cc-analytics');

    function dismiss(acceptAnalytics, message) {
      writeConsent(acceptAnalytics);
      wrap.classList.remove('is-visible');
      window.setTimeout(function () {
        wrap.remove();
      }, 450);
      showToast(message);
    }

    gearBtn.addEventListener('click', function () {
      var open = prefsEl.classList.toggle('is-open');
      gearBtn.setAttribute('aria-expanded', String(open));
    });
    closePrefs.addEventListener('click', function () {
      prefsEl.classList.remove('is-open');
      gearBtn.setAttribute('aria-expanded', 'false');
    });
    document.getElementById('lm-cc-reject').addEventListener('click', function () {
      dismiss(false, 'Optional cookies rejected.');
    });
    document.getElementById('lm-cc-accept').addEventListener('click', function () {
      dismiss(true, 'Cookies accepted.');
    });
    document.getElementById('lm-cc-save').addEventListener('click', function () {
      dismiss(Boolean(analyticsChk && analyticsChk.checked), 'Cookie preferences saved.');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBanner);
  } else {
    mountBanner();
  }
})();
