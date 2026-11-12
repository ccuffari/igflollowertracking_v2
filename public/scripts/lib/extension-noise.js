(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IGFTExtensionNoise = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MESSAGE_FRAGMENTS = [
    'could not establish connection. receiving end does not exist',
    'receiving end does not exist',
    'extension context invalidated',
    'message port closed before a response was received'
  ];

  var SOURCE_FRAGMENTS = [
    'web-client-content-script.js',
    'chrome-extension://',
    'moz-extension://',
    'safari-web-extension://'
  ];

  function messageOf(reason) {
    if (!reason) return '';
    if (typeof reason === 'string') return reason;
    if (typeof reason.message === 'string') return reason.message;
    return '';
  }

  function containsAny(value, fragments) {
    if (!value) return false;
    var text = String(value).toLowerCase();
    for (var i = 0; i < fragments.length; i++) {
      if (text.indexOf(fragments[i]) !== -1) return true;
    }
    return false;
  }

  function isExtensionSource(source) {
    return containsAny(source, SOURCE_FRAGMENTS);
  }

  function isExtensionNoise(reason, source) {
    if (isExtensionSource(source)) return true;
    return containsAny(messageOf(reason), MESSAGE_FRAGMENTS);
  }

  return {
    MESSAGE_FRAGMENTS: MESSAGE_FRAGMENTS,
    SOURCE_FRAGMENTS: SOURCE_FRAGMENTS,
    isExtensionSource: isExtensionSource,
    isExtensionNoise: isExtensionNoise
  };
});
