// consent.js: cookie banner (orestbida/cookieconsent, MIT, vendored in
// /vendor/cookieconsent). Google tags load only after "Accept analytics".
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.CookieConsent) return;

  function sync() {
    if (window.CookieConsent.acceptedCategory('analytics')) {
      if (window.logmemLoadGoogleTags) window.logmemLoadGoogleTags();
    }
  }

  window.CookieConsent.run({
    guiOptions: {
      consentModal: { layout: 'box inline', position: 'bottom left', equalWeightButtons: true, flipButtons: false },
      preferencesModal: { layout: 'box', equalWeightButtons: true }
    },
    categories: {
      necessary: { enabled: true, readOnly: true },
      analytics: {
        autoClear: {
          cookies: [{ name: /^_ga/ }, { name: '_gid' }],
          reloadPage: false
        }
      }
    },
    onConsent: sync,
    onChange: sync,
    language: {
      default: 'en',
      translations: {
        en: {
          consentModal: {
            title: 'Cookies on LogMem',
            description: 'We use Google Analytics to see which pages help. It stays off until you accept. The site works without it.',
            acceptAllBtn: 'Accept analytics',
            acceptNecessaryBtn: 'Reject',
            showPreferencesBtn: 'Choose',
            footer: '<a href="/privacy">Privacy policy</a>'
          },
          preferencesModal: {
            title: 'Cookie choices',
            acceptAllBtn: 'Accept analytics',
            acceptNecessaryBtn: 'Reject',
            savePreferencesBtn: 'Save choices',
            closeIconLabel: 'Close',
            sections: [
              { title: 'Necessary', description: 'Keeps you signed in and remembers this choice. Always on.', linkedCategory: 'necessary' },
              { title: 'Analytics', description: 'Google Analytics and Tag Manager. Counts visits and page use. Off until you accept.', linkedCategory: 'analytics' }
            ]
          }
        }
      }
    }
  });
})();
