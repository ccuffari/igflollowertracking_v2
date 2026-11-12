/*
 * Persistenza dell'app.
 *
 * - Ospite: localStorage, solo su questo dispositivo.
 * - Utente autenticato: Cloud Firestore (users/{uid}/...), sincronizzato tra dispositivi.
 *   Se Firestore non è raggiungibile si continua a lavorare in locale (fallback) e
 *   l'interfaccia mostra l'avviso.
 *
 * Dati salvati (minimizzazione):
 *   users/{uid}                        -> impostazioni
 *   users/{uid}/deactivated/{username} -> profili marcati come disattivati
 *   users/{uid}/analyses/{id}          -> metadati dell'analisi
 *   users/{uid}/analyses/{id}/items/*  -> chunk degli username "non ti seguono"
 *
 * Il file ZIP e la lista dei follower non vengono mai salvati.
 */
(function () {
  'use strict';

  var Core = window.IGFTCore;

  var KEYS = {
    deactivated: 'igft.deactivated.v1',
    analyses: 'igft.analyses.v1',
    analysisPrefix: 'igft.analysis.',
    settings: 'igft.settings.v1',
    migratedPrefix: 'igft.migrated.'
  };

  var LIMITS = {
    maxLocalAnalyses: 10,
    maxCloudAnalyses: 100,
    chunkSize: 900,
    maxChunks: 400,
    batchSize: 400,
    deactivatedPageSize: 200
  };

  var state = {
    ready: false,
    loading: false,
    user: null,
    storage: 'local', // 'local' | 'cloud' | 'local-fallback'
    deactivated: new Map(),
    analyses: [],
    settings: { autoSave: true },
    error: null,
    cloudError: null
  };

  var listeners = new Set();
  var suppressNotify = false;

  function notify() {
    if (suppressNotify) return;
    listeners.forEach(function (listener) {
      try {
        listener();
      } catch (error) {
        console.error('[IGFT] listener error', error);
      }
    });
  }

  function onStoreChange(listener) {
    if (typeof listener !== 'function') return function () {};
    listeners.add(listener);
    return function () {
      listeners.delete(listener);
    };
  }

  function errorMessage(error) {
    var code = error && error.code ? String(error.code) : '';
    if (code === 'permission-denied') {
      return 'Permessi Firestore negati: verificare le regole di sicurezza del progetto.';
    }
    if (code === 'failed-precondition' || code === 'not-found') {
      return 'Firestore non è configurato per questo progetto Firebase.';
    }
    if (code === 'unavailable' || code === 'deadline-exceeded') {
      return 'Firestore non raggiungibile: riprovare quando la connessione è stabile.';
    }
    if (code === 'resource-exhausted') {
      return 'Quota Firestore esaurita.';
    }
    return (error && error.message) ? error.message : String(error);
  }

  // Evita che un salvataggio cloud bloccato impedisca il salvataggio locale.
  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error(message || 'Operazione cloud scaduta.'));
      }, ms);
      Promise.resolve(promise).then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function firebaseState() {
    return window.IGFTFirebase || null;
  }

  function isCloud() {
    var fb = firebaseState();
    return state.storage === 'cloud' && !!state.user && !!fb && !!fb.db;
  }

  function userDoc() {
    var fb = firebaseState();
    if (!fb || !fb.db || !state.user) return null;
    return fb.db.collection('users').doc(state.user.uid);
  }

  function safeRead(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function safeWrite(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function safeRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // Nothing to do: storage could be disabled.
    }
  }

  function loadSettings() {
    var stored = safeRead(KEYS.settings, null);
    if (stored && typeof stored.autoSave === 'boolean') {
      state.settings.autoSave = stored.autoSave;
    }
  }

  function persistSettings() {
    try {
      safeWrite(KEYS.settings, state.settings);
    } catch (error) {
      console.warn('[IGFT] impossibile salvare le impostazioni', error);
    }
  }

  function localDeactivatedList() {
    var stored = safeRead(KEYS.deactivated, []);
    if (!Array.isArray(stored)) return [];
    return stored
      .map(function (item) {
        var username = Core.normalizeUsername(item && item.username);
        if (!username) return null;
        return {
          username: username,
          markedAt: typeof item.markedAt === 'string' ? item.markedAt : new Date().toISOString()
        };
      })
      .filter(Boolean);
  }

  function toDeactivatedMap(list) {
    var map = new Map();
    list.forEach(function (item) {
      var username = Core.normalizeUsername(item && item.username);
      if (!username) return;
      map.set(username, {
        username: username,
        markedAt: item.markedAt || new Date().toISOString()
      });
    });
    return map;
  }

  function persistLocalDeactivated() {
    try {
      safeWrite(KEYS.deactivated, Array.from(state.deactivated.values()));
    } catch (error) {
      console.warn('[IGFT] impossibile salvare i profili disattivati in locale', error);
    }
  }

  function localAnalysisIndex() {
    var stored = safeRead(KEYS.analyses, []);
    return Array.isArray(stored) ? stored : [];
  }

  function persistLocalAnalysisIndex(index) {
    safeWrite(KEYS.analyses, index.slice(0, LIMITS.maxLocalAnalyses));
  }

  function localAnalysisKey(id) {
    return KEYS.analysisPrefix + id;
  }

  function removeLocalAnalysis(id) {
    safeRemove(localAnalysisKey(id));
  }

  function pruneLocalAnalyses(keepId) {
    var index = localAnalysisIndex();
    while (index.length > LIMITS.maxLocalAnalyses) {
      var evicted = index.pop();
      if (evicted && evicted.id !== keepId) removeLocalAnalysis(evicted.id);
    }
    persistLocalAnalysisIndex(index);
    return index;
  }

  function sortByDateDesc(list) {
    return list.slice().sort(function (a, b) {
      return Core.toMillis(b.createdAt) - Core.toMillis(a.createdAt);
    });
  }

  function loadLocalState() {
    state.deactivated = toDeactivatedMap(localDeactivatedList());
    state.analyses = sortByDateDesc(localAnalysisIndex().map(function (item) {
      return Object.assign({}, item, { storage: 'local' });
    }));
  }

  function newId() {
    var random = Math.random().toString(36).slice(2, 8);
    return 'local-' + Date.now().toString(36) + '-' + random;
  }

  function normalizeReport(report) {
    var source = report || {};
    var usernames = Core.uniqueUsernames(source.notFollowing || []);
    var chunks = Core.chunkArray(usernames, LIMITS.chunkSize);
    var truncated = chunks.length > LIMITS.maxChunks;
    if (truncated) chunks = chunks.slice(0, LIMITS.maxChunks);

    return {
      usernames: usernames,
      chunks: chunks,
      truncated: truncated,
      summary: {
        createdAt: new Date().toISOString(),
        followingCount: Number(source.followingCount) || 0,
        followersCount: Number(source.followersCount) || 0,
        notFollowingCount: usernames.length,
        removedDeactivatedCount: Number(source.removedDeactivatedCount) || 0,
        truncated: truncated
      }
    };
  }

  function saveLocalAnalysis(id, normalized) {
    var record = Object.assign({ id: id }, normalized.summary, {
      notFollowing: normalized.usernames
    });

    var attempts = 0;
    while (attempts < 3) {
      try {
        safeWrite(localAnalysisKey(id), record);
        var index = localAnalysisIndex().filter(function (item) {
          return item && item.id !== id;
        });
        index.unshift(Object.assign({ id: id }, normalized.summary, { storage: 'local' }));
        persistLocalAnalysisIndex(index);
        pruneLocalAnalyses(id);
        state.analyses = sortByDateDesc(index.slice(0, LIMITS.maxLocalAnalyses).map(function (item) {
          return Object.assign({}, item, { storage: 'local' });
        }));
        return { id: id, summary: normalized.summary, storage: 'local' };
      } catch (error) {
        attempts++;
        var trimmed = localAnalysisIndex();
        if (!trimmed.length) {
          console.warn('[IGFT] impossibile salvare l\'analisi in locale', error);
          return null;
        }
        var oldest = trimmed.pop();
        if (oldest && oldest.id !== id) removeLocalAnalysis(oldest.id);
        persistLocalAnalysisIndex(trimmed);
      }
    }
    return null;
  }

  async function saveCloudAnalysis(id, normalized, options) {
    var doc = userDoc();
    if (!doc) throw new Error('Utente non autenticato');
    var analysisRef = id ? doc.collection('analyses').doc(id) : doc.collection('analyses').doc();
    var fb = firebaseState();
    var createdAt = options && options.createdAt ? new Date(options.createdAt) : fb.serverTimestamp();

    var chunks = normalized.chunks;
    var createdChunkIds = [];

    try {
      for (var start = 0; start < chunks.length; start += LIMITS.batchSize) {
        var batch = fb.db.batch();
        var slice = chunks.slice(start, start + LIMITS.batchSize);
        slice.forEach(function (usernames, offset) {
          var index = start + offset;
          var chunkId = 'chunk-' + String(index).padStart(3, '0');
          createdChunkIds.push(chunkId);
          batch.set(analysisRef.collection('items').doc(chunkId), { usernames: usernames });
        });
        await batch.commit();
      }

      await analysisRef.set(Object.assign({}, normalized.summary, {
        createdAt: createdAt,
        chunkCount: chunks.length
      }));

      return {
        id: analysisRef.id,
        summary: normalized.summary,
        storage: 'cloud'
      };
    } catch (error) {
      // Best effort: evita chunk orfani se il salvataggio dei metadati fallisce.
      try {
        if (createdChunkIds.length) {
          var cleanup = fb.db.batch();
          createdChunkIds.forEach(function (chunkId) {
            cleanup.delete(analysisRef.collection('items').doc(chunkId));
          });
          await cleanup.commit();
        }
      } catch (cleanupError) {
        console.warn('[IGFT] cleanup chunk non riuscito', cleanupError);
      }
      throw error;
    }
  }

  async function saveAnalysis(report) {
    var normalized = normalizeReport(report);

    // Salvataggio locale immediato: lo storico non deve mai dipendere dal cloud.
    var local = saveLocalAnalysis(newId(), normalized);
    notify();

    if (isCloud()) {
      try {
        var saved = await withTimeout(
          saveCloudAnalysis(local ? local.id : null, normalized),
          25000,
          'Sincronizzazione cloud troppo lenta.'
        );
        await withTimeout(refreshCloudAnalyses(), 15000, 'Lettura dello storico cloud troppo lenta.');
        state.cloudError = null;
        notify();
        return {
          id: saved.id,
          summary: normalized.summary,
          storage: 'cloud'
        };
      } catch (error) {
        state.cloudError = errorMessage(error);
        console.warn('[IGFT] salvataggio cloud non riuscito, resta la copia locale', error);
        state.storage = 'local-fallback';
        if (state.user) {
          try {
            // Consente di riprovare la migrazione al prossimo login/retry.
            localStorage.removeItem(KEYS.migratedPrefix + state.user.uid);
          } catch (storageError) {
            // Non bloccante.
          }
        }
        notify();
        if (local) return { id: local.id, summary: local.summary, storage: 'local-fallback' };
      }
    }

    return local;
  }

  async function listAnalyses() {
    if (isCloud()) {
      try {
        await withTimeout(refreshCloudAnalyses(), 15000, 'Lettura dello storico cloud troppo lenta.');
      } catch (error) {
        state.cloudError = errorMessage(error);
      }
    }
    return sortByDateDesc(state.analyses);
  }

  async function refreshCloudAnalyses() {
    var doc = userDoc();
    if (!doc) return;
    var snapshot = await doc.collection('analyses')
      .orderBy('createdAt', 'desc')
      .limit(LIMITS.maxCloudAnalyses)
      .get();

    state.analyses = sortByDateDesc(snapshot.docs.map(function (item) {
      var data = item.data() || {};
      return {
        id: item.id,
        createdAt: data.createdAt || null,
        followingCount: Number(data.followingCount) || 0,
        followersCount: Number(data.followersCount) || 0,
        notFollowingCount: Number(data.notFollowingCount) || 0,
        removedDeactivatedCount: Number(data.removedDeactivatedCount) || 0,
        truncated: !!data.truncated,
        storage: 'cloud'
      };
    }));
  }

  async function getAnalysis(id) {
    if (!id) return null;

    if (isCloud()) {
      try {
        var doc = userDoc();
        var ref = doc.collection('analyses').doc(id);
        var snapshot = await ref.get();
        if (!snapshot.exists) return null;
        var data = snapshot.data() || {};
        var items = await ref.collection('items').get();
        var usernames = [];
        items.docs
          .slice()
          .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; })
          .forEach(function (item) {
            var chunk = item.data() || {};
            if (Array.isArray(chunk.usernames)) usernames = usernames.concat(chunk.usernames);
          });
        return {
          id: id,
          createdAt: data.createdAt || null,
          followingCount: Number(data.followingCount) || 0,
          followersCount: Number(data.followersCount) || 0,
          notFollowingCount: Number(data.notFollowingCount) || 0,
          removedDeactivatedCount: Number(data.removedDeactivatedCount) || 0,
          truncated: !!data.truncated,
          storage: 'cloud',
          notFollowing: Core.uniqueUsernames(usernames)
        };
      } catch (error) {
        state.cloudError = errorMessage(error);
        notify();
      }
    }

    var local = safeRead(localAnalysisKey(id), null);
    if (!local) return null;
    return {
      id: local.id || id,
      createdAt: local.createdAt || null,
      followingCount: Number(local.followingCount) || 0,
      followersCount: Number(local.followersCount) || 0,
      notFollowingCount: Number(local.notFollowingCount) || 0,
      removedDeactivatedCount: Number(local.removedDeactivatedCount) || 0,
      truncated: !!local.truncated,
      storage: 'local',
      notFollowing: Core.uniqueUsernames(local.notFollowing || [])
    };
  }

  async function deleteAnalysis(id) {
    if (!id) return;

    if (isCloud()) {
      var doc = userDoc();
      if (doc) {
        try {
          var ref = doc.collection('analyses').doc(id);
          var items = await ref.collection('items').get();
          var fb = firebaseState();
          var batch = fb.db.batch();
          items.docs.forEach(function (item) { batch.delete(item.ref); });
          batch.delete(ref);
          await batch.commit();
        } catch (error) {
          state.cloudError = errorMessage(error);
          notify();
        }
      }
    }

    removeLocalAnalysis(id);
    var index = localAnalysisIndex().filter(function (item) { return item && item.id !== id; });
    persistLocalAnalysisIndex(index);
    state.analyses = sortByDateDesc(state.analyses.filter(function (item) { return item.id !== id; }));
    notify();
  }

  async function clearAnalyses() {
    suppressNotify = true;
    try {
      var current = await listAnalyses();
      for (var i = 0; i < current.length; i++) {
        await deleteAnalysis(current[i].id);
      }
      state.analyses = [];
    } finally {
      suppressNotify = false;
      notify();
    }
  }

  function getDeactivatedUsernames() {
    return new Set(state.deactivated.keys());
  }

  function isDeactivated(username) {
    var normalized = Core.normalizeUsername(username);
    return !!normalized && state.deactivated.has(normalized);
  }

  function listDeactivated() {
    return Array.from(state.deactivated.values()).sort(function (a, b) {
      return Core.toMillis(b.markedAt) - Core.toMillis(a.markedAt);
    });
  }

  async function markDeactivated(username) {
    var normalized = Core.normalizeUsername(username);
    if (!normalized) throw new Error('Username non valido');
    if (state.deactivated.has(normalized)) return { synced: true };

    var markedAt = new Date().toISOString();
    state.deactivated.set(normalized, { username: normalized, markedAt: markedAt });
    persistLocalDeactivated();
    notify();

    if (isCloud()) {
      try {
        await withTimeout(userDoc().collection('deactivated').doc(normalized).set({
          username: normalized,
          markedAt: firebaseState().serverTimestamp()
        }), 8000, 'Sincronizzazione del profilo troppo lenta.');
        return { synced: true };
      } catch (error) {
        state.cloudError = errorMessage(error);
        notify();
        return { synced: false, error: state.cloudError };
      }
    }
    return { synced: true };
  }

  async function unmarkDeactivated(username) {
    var normalized = Core.normalizeUsername(username);
    if (!normalized) return { synced: true };
    state.deactivated.delete(normalized);
    persistLocalDeactivated();
    notify();

    if (isCloud()) {
      try {
        await withTimeout(userDoc().collection('deactivated').doc(normalized).delete(), 8000, 'Sincronizzazione del profilo troppo lenta.');
        return { synced: true };
      } catch (error) {
        state.cloudError = errorMessage(error);
        notify();
        return { synced: false, error: state.cloudError };
      }
    }
    return { synced: true };
  }

  async function toggleDeactivated(username) {
    return isDeactivated(username)
      ? unmarkDeactivated(username)
      : markDeactivated(username);
  }

  // Legge i profili disattivati dal cloud a pagine: con liste grandi una singola
  // get() può superare il timeout e far sembrare Firestore non disponibile.
  async function readCloudDeactivated(doc) {
    var cloudMap = new Map();
    var lastDoc = null;

    while (true) {
      var query = doc.collection('deactivated')
        .orderBy('__name__')
        .limit(LIMITS.deactivatedPageSize);
      if (lastDoc) query = query.startAfter(lastDoc);
      var snapshot = await withTimeout(query.get(), 10000, 'Lettura profili disattivati troppo lenta.');
      if (!snapshot.docs.length) break;

      snapshot.docs.forEach(function (item) {
        var data = item.data() || {};
        var username = Core.normalizeUsername(data.username || item.id);
        if (!username) return;
        var markedAt = data.markedAt;
        cloudMap.set(username, {
          username: username,
          markedAt: markedAt && typeof markedAt.toDate === 'function'
            ? markedAt.toDate().toISOString()
            : (markedAt || new Date().toISOString())
        });
      });

      if (snapshot.docs.length < LIMITS.deactivatedPageSize) break;
      lastDoc = snapshot.docs[snapshot.docs.length - 1];
    }

    return cloudMap;
  }

  async function mergeDeactivatedIntoCloud(uid) {
    var doc = userDoc();
    var fb = firebaseState();
    if (!doc || !fb) return;

    var cloudMap = await readCloudDeactivated(doc);

    var pending = [];
    state.deactivated.forEach(function (item, username) {
      if (!cloudMap.has(username)) pending.push(item);
    });

    for (var start = 0; start < pending.length; start += LIMITS.batchSize) {
      var batch = fb.db.batch();
      pending.slice(start, start + LIMITS.batchSize).forEach(function (item) {
        batch.set(doc.collection('deactivated').doc(item.username), {
          username: item.username,
          markedAt: new Date(item.markedAt)
        });
      });
      await withTimeout(batch.commit(), 10000, 'Scrittura profili disattivati troppo lenta.');
    }

    var merged = new Map(cloudMap);
    state.deactivated.forEach(function (item, username) {
      if (!merged.has(username)) merged.set(username, item);
    });
    state.deactivated = merged;
    persistLocalDeactivated();
    notify();
  }

  async function migrateLocalAnalyses(uid) {
    var migratedKey = KEYS.migratedPrefix + uid;
    try {
      if (localStorage.getItem(migratedKey) === '1') return;
    } catch (error) {
      return;
    }

    var index = localAnalysisIndex();
    for (var i = 0; i < index.length; i++) {
      var entry = index[i];
      if (!entry || !entry.id) continue;
      var local = safeRead(localAnalysisKey(entry.id), null);
      if (!local) continue;
      try {
        await saveCloudAnalysis(entry.id, normalizeReport({
          followingCount: local.followingCount,
          followersCount: local.followersCount,
          removedDeactivatedCount: local.removedDeactivatedCount,
          notFollowing: local.notFollowing || []
        }), { createdAt: local.createdAt });
      } catch (error) {
        console.warn('[IGFT] migrazione analisi locale non riuscita', error);
        return;
      }
    }

    try {
      localStorage.setItem(migratedKey, '1');
    } catch (error) {
      // Non bloccante.
    }
  }

  async function switchToCloud(user, force) {
    if (!force && state.user && state.user.uid === user.uid && state.storage === 'cloud') {
      return;
    }
    state.user = user;
    state.storage = 'cloud';
    state.loading = true;
    state.error = null;
    notify();

    // L'accesso al cloud dipende solo dalla lettura dello storico: l'unione dei
    // profili disattivati e la migrazione sono best-effort e non devono mai
    // degradare l'app a locale se sono semplicemente lente o parziali.
    try {
      await withTimeout(refreshCloudAnalyses(), 15000, 'Lettura dello storico cloud troppo lenta.');
      state.cloudError = null;
    } catch (error) {
      state.cloudError = errorMessage(error);
      state.storage = 'local-fallback';
      console.warn('[IGFT] sincronizzazione cloud non disponibile', error);
    } finally {
      state.loading = false;
      notify();
    }

    if (state.storage !== 'cloud') return;

    syncCloudInBackground(user.uid);
  }

  function syncCloudInBackground(uid) {
    var guard = function () {
      return !!state.user && state.user.uid === uid && state.storage === 'cloud';
    };

    mergeDeactivatedIntoCloud(uid)
      .then(function () {
        if (guard()) state.cloudError = null;
      })
      .catch(function (error) {
        console.warn('[IGFT] unione profili disattivati non completata, verrà ritentata', error);
      })
      .then(function () {
        if (!guard()) return;
        return withTimeout(migrateLocalAnalyses(uid), 30000, 'Migrazione analisi troppo lenta.')
          .catch(function (error) {
            console.warn('[IGFT] migrazione analisi non completata, verrà ritentata', error);
          });
      })
      .then(function () {
        if (guard()) notify();
      });
  }

  function switchToLocal() {
    var wasCloud = !!state.user && state.storage === 'cloud';
    state.user = null;
    state.storage = 'local';
    state.cloudError = null;
    state.loading = false;

    if (wasCloud) {
      // Dopo il logout non lasciare sul dispositivo la copia dei dati dell'account:
      // restano comunque sincronizzati su Firestore.
      localAnalysisIndex().forEach(function (item) {
        if (item && item.id) removeLocalAnalysis(item.id);
      });
      safeRemove(KEYS.analyses);
      safeRemove(KEYS.deactivated);
      state.deactivated = new Map();
      state.analyses = [];
    } else {
      loadLocalState();
    }
    notify();
  }

  async function retryCloud() {
    if (!state.user) return false;
    await switchToCloud(state.user, true);
    return state.storage === 'cloud';
  }

  async function deleteAllData() {
    suppressNotify = true;
    try {
      await deleteAllDataInternal();
    } finally {
      suppressNotify = false;
      notify();
    }
  }

  async function deleteAllDataInternal() {
    var cloudFailed = false;
    var localIds = localAnalysisIndex().map(function (item) {
      return item && item.id;
    }).filter(Boolean);

    state.cloudError = null;

    var analyses = await listAnalyses();
    for (var i = 0; i < analyses.length; i++) {
      await deleteAnalysis(analyses[i].id);
    }

    var usernames = Array.from(state.deactivated.keys());
    if (isCloud()) {
      var doc = userDoc();
      var fb = firebaseState();
      if (doc && fb) {
        try {
          var snapshot = await doc.collection('deactivated').get();
          for (var start = 0; start < snapshot.docs.length; start += LIMITS.batchSize) {
            var batch = fb.db.batch();
            snapshot.docs.slice(start, start + LIMITS.batchSize).forEach(function (item) {
              batch.delete(item.ref);
            });
            await batch.commit();
          }
          await doc.delete();
        } catch (error) {
          cloudFailed = true;
          state.cloudError = errorMessage(error);
        }
      }
    }

    if (state.cloudError) cloudFailed = true;

    usernames.forEach(function (username) { state.deactivated.delete(username); });
    state.analyses = [];
    safeRemove(KEYS.deactivated);
    safeRemove(KEYS.analyses);
    safeRemove(KEYS.settings);

    localIds.forEach(function (id) { removeLocalAnalysis(id); });

    if (state.user) {
      try {
        localStorage.removeItem(KEYS.migratedPrefix + state.user.uid);
      } catch (error) {
        // Non bloccante.
      }
    }

    if (cloudFailed) {
      throw new Error(state.cloudError || 'Eliminazione dei dati sul cloud non riuscita.');
    }
  }

  function setAutoSave(value) {
    state.settings.autoSave = !!value;
    persistSettings();
    if (isCloud()) {
      var doc = userDoc();
      if (doc) {
        doc.set({ settings: { autoSave: state.settings.autoSave } }, { merge: true })
          .catch(function (error) {
            console.warn('[IGFT] impostazioni non sincronizzate', error);
          });
      }
    }
    notify();
  }

  function getStatus() {
    return {
      ready: state.ready,
      loading: state.loading,
      user: state.user,
      storage: state.storage,
      signedIn: !!state.user,
      cloudAvailable: !!(firebaseState() && firebaseState().available),
      error: state.error,
      cloudError: state.cloudError,
      autoSave: state.settings.autoSave,
      deactivatedCount: state.deactivated.size,
      analysesCount: state.analyses.length
    };
  }

  async function init() {
    loadSettings();
    loadLocalState();
    state.ready = true;
    notify();

    var fb = firebaseState();
    if (fb) {
      try {
        await fb.ready;
      } catch (error) {
        console.warn('[IGFT] Firebase init fallita', error);
      }
      if (fb.available && fb.auth) {
        fb.auth.onAuthStateChanged(function (user) {
          if (user) {
            switchToCloud(user, false);
          } else {
            switchToLocal();
          }
        });
      }
    }
  }

  window.IGFTStore = {
    ready: init(),
    onChange: onStoreChange,
    getStatus: getStatus,
    isCloud: isCloud,
    getDeactivatedUsernames: getDeactivatedUsernames,
    isDeactivated: isDeactivated,
    listDeactivated: listDeactivated,
    markDeactivated: markDeactivated,
    unmarkDeactivated: unmarkDeactivated,
    toggleDeactivated: toggleDeactivated,
    saveAnalysis: saveAnalysis,
    listAnalyses: listAnalyses,
    getAnalysis: getAnalysis,
    deleteAnalysis: deleteAnalysis,
    clearAnalyses: clearAnalyses,
    deleteAllData: deleteAllData,
    setAutoSave: setAutoSave,
    retryCloud: retryCloud
  };
})();
