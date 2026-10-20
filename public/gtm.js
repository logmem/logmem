// gtm.js: Google Tag Manager (GTM-KW8M5T7H) and GA4 (G-7QMYZSXRJ1) loader for
// the public marketing pages (/ and /onboarding). Never loaded on /app, /keys,
// /connections, or /scorecard.
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = window.gtag || gtag;

  gtag('js', new Date());
  gtag('config', 'G-7QMYZSXRJ1');

  window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });

  var head = document.head || document.getElementsByTagName('head')[0];
  if (!head) return;

  var gtmScript = document.createElement('script');
  gtmScript.async = true;
  gtmScript.src = 'https://www.googletagmanager.com/gtm.js?id=GTM-KW8M5T7H';
  head.appendChild(gtmScript);

  var gaScript = document.createElement('script');
  gaScript.async = true;
  gaScript.src = 'https://www.googletagmanager.com/gtag/js?id=G-7QMYZSXRJ1';
  head.appendChild(gaScript);
})();
