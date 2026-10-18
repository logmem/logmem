// analytics.js: Initialize Vercel Web Analytics queue
// When Analytics is enabled in the Vercel dashboard, the analytics script
// will use this queue to track page views automatically.
(function () {
  'use strict';
  window.va = window.va || function () {
    (window.vaq = window.vaq || []).push(arguments);
  };
})();
