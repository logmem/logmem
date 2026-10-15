// attrib.js: remember where this visit came from, for the waitlist sign-up.
//
// On the first page of a visit it keeps the utm_* values, the referring host
// (host only, empty when it is this site), the landing path and the time, in
// sessionStorage under lm_attr. Nothing else from the URL is kept, and nothing
// is sent from here. onboarding.js reads it with window.lmAttribution() and
// sends it with the sign-up. No cookies. Blocked storage just means null.
(function () {
  'use strict';
  var KEY = 'lm_attr';
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  // Printable ASCII only and cut short, so the sign-up body stays small.
  // The server cleans every value again.
  function cut(v, max) {
    if (typeof v !== 'string') return null;
    var s = v.replace(/[^\x20-\x7e]+/g, '-').slice(0, max);
    return s || null;
  }

  function read() {
    try {
      var raw = sessionStorage.getItem(KEY);
      var v = raw ? JSON.parse(raw) : null;
      return v && typeof v === 'object' ? v : null;
    } catch (e) {
      return null;
    }
  }

  try {
    if (!sessionStorage.getItem(KEY)) {
      var params = new URLSearchParams(location.search || '');
      var a = {};
      for (var i = 0; i < UTM.length; i++) a[UTM[i]] = cut(params.get(UTM[i]), 100);
      var host = null;
      try {
        if (document.referrer) {
          var h = new URL(document.referrer).hostname;
          host = h && h !== location.hostname ? cut(h, 100) : null;
        }
      } catch (e) {
        host = null;
      }
      a.referrer_host = host;
      a.landing_path = cut(location.pathname || '/', 200);
      a.first_seen = Date.now();
      sessionStorage.setItem(KEY, JSON.stringify(a));
    }
  } catch (e) {
    // Storage blocked or full: the sign-up still works, with no source.
  }

  window.lmAttribution = read;
})();
