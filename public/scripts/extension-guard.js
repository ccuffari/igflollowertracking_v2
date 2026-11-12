(function () {
  'use strict';

  var detector = window.IGFTExtensionNoise;
  if (!detector || typeof window.addEventListener !== 'function') return;

  var INJECTED_SCRIPT_ID = 'web-client-content-script.js';

  function stop(event) {
    try { event.preventDefault(); } catch (error) { /* ignore */ }
  }

  function onUnhandledRejection(event) {
    if (!event) return;
    if (detector.isExtensionNoise(event.reason, '')) {
      if (window.console && typeof window.console.debug === 'function') {
        window.console.debug('[IGFT] Ignorata eccezione di un\'estensione del browser, non dell\'app.');
      }
      stop(event);
    }
  }

  function onError(event) {
    if (!event) return;
    var source = event.filename || (event.target && event.target.src) || '';
    var reason = event.error || event.message || '';
    if (detector.isExtensionNoise(reason, source)) {
      stop(event);
    }
  }

  function isInjectedScript(node) {
    if (!node || node.nodeType !== 1 || node.nodeName !== 'SCRIPT') return false;
    var src = node.getAttribute ? node.getAttribute('src') : '';
    if (!src) return false;
    return String(src).toLowerCase().indexOf(INJECTED_SCRIPT_ID) !== -1;
  }

  function removeInjectedScript(node) {
    if (!node || node.nodeType !== 1) return;
    if (isInjectedScript(node)) {
      if (node.parentNode) node.parentNode.removeChild(node);
      return;
    }
    if (node.querySelectorAll) {
      var scripts = node.querySelectorAll('script[src]');
      for (var i = 0; i < scripts.length; i++) {
        if (isInjectedScript(scripts[i]) && scripts[i].parentNode) {
          scripts[i].parentNode.removeChild(scripts[i]);
        }
      }
    }
  }

  window.addEventListener('unhandledrejection', onUnhandledRejection);
  window.addEventListener('error', onError, true);

  removeInjectedScript(document.documentElement);

  if (typeof MutationObserver === 'function') {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          removeInjectedScript(added[j]);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
