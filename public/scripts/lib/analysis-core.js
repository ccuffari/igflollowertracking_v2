/*
 * Logica pura condivisa tra browser e test Node.
 * Nessuna dipendenza da DOM, Firebase o localStorage.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IGFTCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Instagram: lettere, numeri, punto e underscore. Gli username sono case-insensitive.
  var USERNAME_RE = /^[a-z0-9._]{1,50}$/;
  var MAX_USERNAME_LENGTH = 50;

  function normalizeUsername(value) {
    if (!value || typeof value !== 'string') return null;
    var normalized = value.trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > MAX_USERNAME_LENGTH) return null;
    if (!USERNAME_RE.test(normalized)) return null;
    return normalized;
  }

  function uniqueUsernames(list) {
    var seen = new Set();
    var result = [];
    (Array.isArray(list) ? list : []).forEach(function (value) {
      var username = normalizeUsername(value);
      if (username && !seen.has(username)) {
        seen.add(username);
        result.push(username);
      }
    });
    return result;
  }

  /**
   * Rimuove dalla lista i profili marcati come disattivati.
   * @returns {{kept: string[], removed: string[]}}
   */
  function filterDeactivated(list, deactivatedUsernames) {
    var deactivated = deactivatedUsernames instanceof Set
      ? deactivatedUsernames
      : new Set(uniqueUsernames(deactivatedUsernames));

    var kept = [];
    var removed = [];
    (Array.isArray(list) ? list : []).forEach(function (value) {
      var username = normalizeUsername(value);
      if (!username) return;
      if (deactivated.has(username)) {
        removed.push(username);
      } else {
        kept.push(username);
      }
    });
    return { kept: kept, removed: removed };
  }

  function chunkArray(items, size) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError('size must be a positive integer');
    }
    var source = Array.isArray(items) ? items : [];
    var result = [];
    for (var i = 0; i < source.length; i += size) {
      result.push(source.slice(i, i + size));
    }
    return result;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Converte Date, timestamp Firestore, ISO string o millisecondi in data leggibile (it-IT).
   */
  function formatDateIt(value) {
    if (value === null || value === undefined || value === '') return '—';
    var date;
    if (value instanceof Date) {
      date = value;
    } else if (typeof value === 'object' && typeof value.toDate === 'function') {
      date = value.toDate();
    } else {
      date = new Date(value);
    }
    if (isNaN(date.getTime())) return '—';
    try {
      return date.toLocaleString('it-IT', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (error) {
      return date.toISOString();
    }
  }

  function toMillis(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'object' && typeof value.toDate === 'function') {
      return value.toDate().getTime();
    }
    var parsed = new Date(value).getTime();
    return isNaN(parsed) ? 0 : parsed;
  }

  return {
    MAX_USERNAME_LENGTH: MAX_USERNAME_LENGTH,
    normalizeUsername: normalizeUsername,
    uniqueUsernames: uniqueUsernames,
    filterDeactivated: filterDeactivated,
    chunkArray: chunkArray,
    escapeHtml: escapeHtml,
    formatDateIt: formatDateIt,
    toMillis: toMillis
  };
});
