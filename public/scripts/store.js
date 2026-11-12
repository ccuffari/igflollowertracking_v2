/*
 * Persistenza dell'app.
 *
 * - Ospite: localStorage, solo su questo dispositivo.
 * - Utente autenticato: Cloud Firestore (database "(default)") è la fonte di
 *   verità. I dati vengono scritti e riletti dal database; la copia locale
 *   (`igft.u.{uid}.*`) serve solo come cache per l'uso offline e viene
 *   allineata al cloud appena la connessione torna disponibile.
 *
 * Dati salvati:
 *   users/{uid}                        -> profilo (email, nome) e impostazioni
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
    settings: 'igft.settings.v1',
    migratedPrefix: 'igft.migrated.',
    deactivatedMigratedPrefix: 'igft.deactivatedMigrated.'
  };

  // Ogni account ha il proprio spazio locale (`igft.u.{uid}.*`), l'ospite usa
  // lo spazio condiviso (`igft.*`). Così uscire e rientrare non cancella la
  // cache quando Firestore non è raggiungibile e due account sullo stesso
  // dispositivo non si mescolano.
  function scopePrefix() {
    return state.user && state.user.uid ? 'igft.u.' + state.user.uid + '.' : 'igft.';
  }

  function scopedKey(kind) {
    var scope = scopePrefix();
    if (kind === 'deactivated') return scope + 'deactivated.v1';
    if (kind === 'analyses') return scope + 'analyses.v1';
    if (kind === 'analysisPrefix') return scope + 'analysis.';
    return scope + kind;
  }

  // Coda delle modifiche non ancora confermate da Firestore.
  function pendingKey(kind) {
    return scopePrefix() + 'pending.' + kind + '.v1';
  }

  var LIMITS = {
    maxLocalAnalyses: 20,
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
    ownerName: null,
    ownerEmail: null,
    storage: 'local', // 'local' | 'cloud' | 'local-fallback'
    deactivated: new Map(),
    analyses: [],
    settings: { autoSave: true },
    error: null,
    cloudError: null,
    cloudSync: 'idle', // 'idle' | 'ok' | 'pending' | 'slow' | 'error'
    cloudSyncReason: null
  };

  var listeners = new Set();
  var suppressNotify = false;

  // Stato della sincronizzazione in background. Un timeout è un rallentamento,
  // non un errore: si registra una sola riga informativa, si sospendono i
  // tentativi per un po' (backoff) e si riprova da soli, senza stack trace.
  var cloudSync = {
    inFlight: false,
    slowUntil: 0,
    slowLevel: 0,
    slowLogged: false,
    retryTimer: null
  };

  function cloudBackoffActive() {
    return Date.now() < cloudSync.slowUntil;
  }

  function cloudSlow(reason) {
    cloudSync.slowLevel = Math.min(cloudSync.slowLevel + 1, 4);
    var wait = 60000 * Math.pow(2, cloudSync.slowLevel - 1);
    cloudSync.slowUntil = Date.now() + wait;
    state.cloudSync = 'slow';
    state.cloudSyncReason = reason || null;

    if (!cloudSync.slowLogged) {
      cloudSync.slowLogged = true;
      console.info(
        '[IGFT] sincronizzazione Firestore in background' +
        (reason ? ' (' + reason + ')' : '') +
        ': nessuna azione richiesta, i dati restano nella cache locale finché la connessione non torna.'
      );
    }
    scheduleCloudRetry(wait);
  }

  function cloudOk() {
    cloudSync.slowUntil = 0;
    cloudSync.slowLevel = 0;
    cloudSync.slowLogged = false;
    state.cloudSync = 'ok';
    state.cloudSyncReason = null;
  }

  function scheduleCloudRetry(wait) {
    if (cloudSync.retryTimer) clearTimeout(cloudSync.retryTimer);
    cloudSync.retryTimer = setTimeout(function () {
      cloudSync.retryTimer = null;
      if (!hasCloud() || cloudSync.inFlight) return;
      syncCloudInBackground(state.user.uid, false);
    }, Math.max(5000, wait));
    if (cloudSync.retryTimer && typeof cloudSync.retryTimer.unref === 'function') {
      cloudSync.retryTimer.unref();
    }
  }

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
        var error = new Error(message || 'Operazione cloud scaduta.');
        error.code = 'igft/timeout';
        reject(error);
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

  // Un timeout è un rallentamento, non un errore di configurazione: non deve
  // degradare la sessione a locale né mostrare un avviso bloccante all'utente.
  function isTimeout(error) {
    return !!error && error.code === 'igft/timeout';
  }

  function firebaseState() {
    return window.IGFTFirebase || null;
  }

  // Autenticato e con il client Firestore disponibile: si può parlare con il DB
  // anche quando lo stato è `local-fallback` (in quel caso si ritenta).
  function hasCloud() {
    var fb = firebaseState();
    return !!state.user && !!fb && !!fb.db;
  }

  function isCloud() {
    return hasCloud() && state.storage === 'cloud';
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

  function readList(key) {
    var stored = safeRead(key, []);
    return Array.isArray(stored) ? stored : [];
  }

  function writeList(key, list) {
    try {
      safeWrite(key, list);
    } catch (error) {
      // Non bloccante: la coda riproverà al prossimo avvio.
    }
  }

  function pendingList(kind) {
    return readList(pendingKey(kind));
  }

  function addPending(kind, value) {
    var list = pendingList(kind);
    if (list.indexOf(value) < 0) {
      list.push(value);
      writeList(pendingKey(kind), list);
    }
  }

  function removePending(kind, value) {
    var list = pendingList(kind).filter(function (item) {
      return item !== value;
    });
    writeList(pendingKey(kind), list);
  }

  function clearPending(kind) {
    writeList(pendingKey(kind), []);
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
    var stored = safeRead(scopedKey('deactivated'), []);
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
      safeWrite(scopedKey('deactivated'), Array.from(state.deactivated.values()));
    } catch (error) {
      console.warn('[IGFT] impossibile salvare i profili disattivati nella cache locale', error);
    }
  }

  function localAnalysisIndex() {
    var stored = safeRead(scopedKey('analyses'), []);
    return Array.isArray(stored) ? stored : [];
  }

  function persistLocalAnalysisIndex(index) {
    try {
      safeWrite(scopedKey('analyses'), index.slice(0, LIMITS.maxLocalAnalyses));
    } catch (error) {
      // Non bloccante: la coda cloud resta la fonte di verità.
    }
  }

  function localAnalysisKey(id) {
    return scopedKey('analysisPrefix') + id;
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

  function readLocalSnapshot() {
    return {
      deactivated: localDeactivatedList(),
      analyses: localAnalysisIndex().map(function (item) {
        if (!item || !item.id) return null;
        return {
          index: item,
          record: safeRead(localAnalysisKey(item.id), null)
        };
      }).filter(Boolean)
    };
  }

  function hasScopedLocalData() {
    return safeRead(scopedKey('analyses'), null) !== null ||
      safeRead(scopedKey('deactivated'), null) !== null;
  }

  // Al primo accesso su questo dispositivo lo storico e i disattivati creati
  // come ospite diventano il punto di partenza dell'account. La copia ospite
  // resta intatta, così nessun dato viene perso.
  function adoptGuestLocalData(snapshot) {
    if (!snapshot) return;
    try {
      if (snapshot.deactivated.length) {
        safeWrite(scopedKey('deactivated'), snapshot.deactivated);
      }
      var index = [];
      snapshot.analyses.forEach(function (entry) {
        if (!entry.record) return;
        safeWrite(scopedKey('analysisPrefix') + entry.index.id, entry.record);
        index.push(entry.index);
      });
      if (index.length) {
        safeWrite(scopedKey('analyses'), index.slice(0, LIMITS.maxLocalAnalyses));
      }
    } catch (error) {
      console.warn('[IGFT] copia dei dati locali nell\'account non riuscita', error);
    }
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

  // Copia locale dell'analisi: cache di lettura e salvataggio offline. Non è
  // mai l'unica copia quando l'utente è autenticato.
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
        return { id: id, summary: normalized.summary, storage: 'local' };
      } catch (error) {
        attempts++;
        var trimmed = localAnalysisIndex();
        if (!trimmed.length) {
          console.warn('[IGFT] impossibile salvare la copia locale dell\'analisi', error);
          return null;
        }
        var oldest = trimmed.pop();
        if (oldest && oldest.id !== id) removeLocalAnalysis(oldest.id);
        persistLocalAnalysisIndex(trimmed);
      }
    }
    return null;
  }

  function markLocalAnalysisStorage(id, storage) {
    var index = localAnalysisIndex();
    var changed = false;
    index.forEach(function (item) {
      if (item && item.id === id && item.storage !== storage) {
        item.storage = storage;
        changed = true;
      }
    });
    if (changed) persistLocalAnalysisIndex(index);
  }

  function upsertAnalysisSummary(entry) {
    state.analyses = sortByDateDesc(state.analyses.filter(function (item) {
      return item && item.id !== entry.id;
    }).concat([entry]));
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

    // Ospite: nessun account, quindi l'unica destinazione possibile è il browser.
    if (!hasCloud()) {
      var guestId = newId();
      var guestSaved = saveLocalAnalysis(guestId, normalized);
      if (guestSaved) {
        upsertAnalysisSummary(Object.assign({ id: guestSaved.id }, guestSaved.summary, { storage: 'local' }));
      }
      notify();
      return guestSaved;
    }

    // Autenticato: Firestore è la fonte di verità. La copia locale viene
    // scritta prima solo per non perdere il report se la rete cade a metà.
    var id = newId();
    var local = saveLocalAnalysis(id, normalized);
    if (!local) id = null;
    if (!id) {
      var generated = newId();
      local = saveLocalAnalysis(generated, normalized);
      id = local ? local.id : generated;
    }
    addPending('analyses', id);
    state.analyses = sortByDateDesc(state.analyses.filter(function (item) {
      return item && item.id !== id;
    }).concat([{ id: id, createdAt: normalized.summary.createdAt, followingCount: normalized.summary.followingCount, followersCount: normalized.summary.followersCount, notFollowingCount: normalized.summary.notFollowingCount, removedDeactivatedCount: normalized.summary.removedDeactivatedCount, truncated: normalized.summary.truncated, storage: 'local-fallback', pending: true }]));
    notify();

    if (cloudBackoffActive()) {
      state.cloudSync = 'pending';
      return { id: id, summary: normalized.summary, storage: 'local-fallback', pending: true };
    }

    try {
      var saved = await withTimeout(
        saveCloudAnalysis(id, normalized),
        15000,
        'Salvataggio su Firestore troppo lento.'
      );
      removePending('analyses', id);
      markLocalAnalysisStorage(id, 'cloud');
      upsertAnalysisSummary({
        id: saved.id,
        createdAt: normalized.summary.createdAt,
        followingCount: normalized.summary.followingCount,
        followersCount: normalized.summary.followersCount,
        notFollowingCount: normalized.summary.notFollowingCount,
        removedDeactivatedCount: normalized.summary.removedDeactivatedCount,
        truncated: normalized.summary.truncated,
        storage: 'cloud'
      });
      state.cloudError = null;
      state.storage = 'cloud';
      cloudOk();
      notify();
      return { id: saved.id, summary: normalized.summary, storage: 'cloud' };
    } catch (error) {
      if (isTimeout(error)) {
        cloudSlow('salvataggio analisi');
      } else {
        state.cloudError = errorMessage(error);
        state.storage = 'local-fallback';
        state.cloudSync = 'pending';
        console.info('[IGFT] salvataggio su Firestore rimandato: la copia locale verrà sincronizzata automaticamente.');
        scheduleCloudRetry(60000);
      }
      notify();
      return { id: id, summary: normalized.summary, storage: state.storage, pending: true };
    }
  }

  async function listAnalyses() {
    if (hasCloud() && !cloudBackoffActive()) {
      try {
        await withTimeout(refreshCloudAnalyses(), 12000, 'Lettura dello storico da Firestore troppo lenta.');
        state.cloudError = null;
        state.storage = 'cloud';
        cloudOk();
      } catch (error) {
        if (isTimeout(error)) {
          cloudSlow('storico');
        } else {
          state.cloudError = errorMessage(error);
          state.storage = 'local-fallback';
          console.warn('[IGFT] lettura storico da Firestore non riuscita: ' + state.cloudError);
        }
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

    var byId = new Map();
    snapshot.docs.forEach(function (item) {
      var data = item.data() || {};
      byId.set(item.id, {
        id: item.id,
        createdAt: data.createdAt || null,
        followingCount: Number(data.followingCount) || 0,
        followersCount: Number(data.followersCount) || 0,
        notFollowingCount: Number(data.notFollowingCount) || 0,
        removedDeactivatedCount: Number(data.removedDeactivatedCount) || 0,
        truncated: !!data.truncated,
        storage: 'cloud'
      });
    });

    // Solo le analisi davvero non ancora sincronizzate restano visibili dalla
    // cache: tutto il resto arriva esclusivamente da Firestore.
    var localIndex = localAnalysisIndex();
    pendingList('analyses').forEach(function (id) {
      if (byId.has(id)) return;
      var entry = localIndex.find(function (item) { return item && item.id === id; });
      if (entry) byId.set(id, Object.assign({}, entry, { storage: 'local-fallback', pending: true }));
    });

    state.analyses = sortByDateDesc(Array.from(byId.values()));
  }

  async function getAnalysis(id) {
    if (!id) return null;

    if (hasCloud() && !cloudBackoffActive()) {
      try {
        var doc = userDoc();
        var ref = doc.collection('analyses').doc(id);
        var snapshot = await withTimeout(ref.get(), 10000, 'Lettura analisi da Firestore troppo lenta.');
        if (!snapshot.exists) {
          // Non presente nel DB: può essere un salvataggio ancora in coda.
          var pending = safeRead(localAnalysisKey(id), null);
          return pending ? localAnalysisView(pending, id) : null;
        }
        var data = snapshot.data() || {};
        var items = await withTimeout(ref.collection('items').get(), 10000, 'Lettura analisi da Firestore troppo lenta.');
        var usernames = [];
        items.docs
          .slice()
          .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; })
          .forEach(function (item) {
            var chunk = item.data() || {};
            if (Array.isArray(chunk.usernames)) usernames = usernames.concat(chunk.usernames);
          });
        cloudOk();
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
        if (isTimeout(error)) {
          cloudSlow('dettaglio analisi');
        } else {
          state.cloudError = errorMessage(error);
          state.storage = 'local-fallback';
          notify();
        }
      }
    }

    var local = safeRead(localAnalysisKey(id), null);
    return local ? localAnalysisView(local, id) : null;
  }

  function localAnalysisView(local, id) {
    return {
      id: local.id || id,
      createdAt: local.createdAt || null,
      followingCount: Number(local.followingCount) || 0,
      followersCount: Number(local.followersCount) || 0,
      notFollowingCount: Number(local.notFollowingCount) || 0,
      removedDeactivatedCount: Number(local.removedDeactivatedCount) || 0,
      truncated: !!local.truncated,
      storage: 'local-fallback',
      notFollowing: Core.uniqueUsernames(local.notFollowing || [])
    };
  }

  async function deleteAnalysis(id) {
    if (!id) return;

    if (hasCloud() && !cloudBackoffActive()) {
      var doc = userDoc();
      if (doc) {
        try {
          var ref = doc.collection('analyses').doc(id);
          var items = await withTimeout(ref.collection('items').get(), 12000, 'Eliminazione analisi su Firestore troppo lenta.');
          var fb = firebaseState();
          var batch = fb.db.batch();
          items.docs.forEach(function (item) { batch.delete(item.ref); });
          batch.delete(ref);
          await withTimeout(batch.commit(), 12000, 'Eliminazione analisi su Firestore troppo lenta.');
        } catch (error) {
          if (isTimeout(error)) {
            cloudSlow('eliminazione analisi');
          } else {
            state.cloudError = errorMessage(error);
            notify();
          }
        }
      }
    }

    removePending('analyses', id);
    removeLocalAnalysis(id);
    var index = localAnalysisIndex().filter(function (item) { return item && item.id !== id; });
    persistLocalAnalysisIndex(index);
    state.analyses = sortByDateDesc(state.analyses.filter(function (item) { return item && item.id !== id; }));
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

    if (!hasCloud()) return { synced: true };

    removePending('deactivatedRemove', normalized);
    addPending('deactivatedAdd', normalized);

    try {
      await withTimeout(userDoc().collection('deactivated').doc(normalized).set({
        username: normalized,
        markedAt: firebaseState().serverTimestamp()
      }), 8000, 'Sincronizzazione del profilo su Firestore troppo lenta.');
      removePending('deactivatedAdd', normalized);
      state.cloudError = null;
      return { synced: true };
    } catch (error) {
      if (isTimeout(error)) {
        state.cloudSync = 'pending';
        return { synced: true, pending: true };
      }
      state.cloudError = errorMessage(error);
      state.cloudSync = 'pending';
      notify();
      scheduleCloudRetry(60000);
      return { synced: false, error: state.cloudError, pending: true };
    }
  }

  async function unmarkDeactivated(username) {
    var normalized = Core.normalizeUsername(username);
    if (!normalized) return { synced: true };
    state.deactivated.delete(normalized);
    persistLocalDeactivated();
    notify();

    if (!hasCloud()) return { synced: true };

    removePending('deactivatedAdd', normalized);
    addPending('deactivatedRemove', normalized);

    try {
      await withTimeout(userDoc().collection('deactivated').doc(normalized).delete(), 8000, 'Sincronizzazione del profilo su Firestore troppo lenta.');
      removePending('deactivatedRemove', normalized);
      state.cloudError = null;
      return { synced: true };
    } catch (error) {
      if (isTimeout(error)) {
        state.cloudSync = 'pending';
        return { synced: true, pending: true };
      }
      state.cloudError = errorMessage(error);
      state.cloudSync = 'pending';
      notify();
      scheduleCloudRetry(60000);
      return { synced: false, error: state.cloudError, pending: true };
    }
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
      var snapshot = await withTimeout(query.get(), 10000, 'Lettura profili disattivati da Firestore troppo lenta.');
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

  // Invia a Firestore le modifiche ai disattivati rimaste in coda (offline).
  async function flushPendingDeactivated() {
    var doc = userDoc();
    var fb = firebaseState();
    if (!doc || !fb) return;

    var removals = pendingList('deactivatedRemove');
    var adds = pendingList('deactivatedAdd');
    if (!removals.length && !adds.length) return;

    for (var r = 0; r < removals.length; r += LIMITS.batchSize) {
      var removeBatch = fb.db.batch();
      removals.slice(r, r + LIMITS.batchSize).forEach(function (username) {
        removeBatch.delete(doc.collection('deactivated').doc(username));
      });
      await withTimeout(removeBatch.commit(), 10000, 'Scrittura profili disattivati su Firestore troppo lenta.');
    }

    for (var a = 0; a < adds.length; a += LIMITS.batchSize) {
      var addBatch = fb.db.batch();
      adds.slice(a, a + LIMITS.batchSize).forEach(function (username) {
        var item = state.deactivated.get(username) || { username: username, markedAt: new Date().toISOString() };
        addBatch.set(doc.collection('deactivated').doc(username), {
          username: username,
          markedAt: new Date(item.markedAt)
        });
      });
      await withTimeout(addBatch.commit(), 10000, 'Scrittura profili disattivati su Firestore troppo lenta.');
    }

    clearPending('deactivatedRemove');
    clearPending('deactivatedAdd');
  }

  // Importa una sola volta i disattivati che erano già nella cache locale
  // (creati come ospite o prima dell'attivazione di Firestore).
  async function migrateLocalDeactivated(uid) {
    var migratedKey = KEYS.deactivatedMigratedPrefix + uid;
    try {
      if (localStorage.getItem(migratedKey) === '1') return false;
    } catch (error) {
      return false;
    }

    var doc = userDoc();
    var fb = firebaseState();
    var local = localDeactivatedList();
    if (!doc || !fb || !local.length) {
      try { localStorage.setItem(migratedKey, '1'); } catch (error) { /* non bloccante */ }
      return false;
    }

    var cloudMap = await readCloudDeactivated(doc);
    var removals = new Set(pendingList('deactivatedRemove'));
    var pending = local.filter(function (item) {
      return !cloudMap.has(item.username) && !removals.has(item.username);
    });

    for (var start = 0; start < pending.length; start += LIMITS.batchSize) {
      var batch = fb.db.batch();
      pending.slice(start, start + LIMITS.batchSize).forEach(function (item) {
        batch.set(doc.collection('deactivated').doc(item.username), {
          username: item.username,
          markedAt: new Date(item.markedAt)
        });
      });
      await withTimeout(batch.commit(), 10000, 'Migrazione profili disattivati su Firestore troppo lenta.');
    }

    try { localStorage.setItem(migratedKey, '1'); } catch (error) { /* non bloccante */ }
    return pending.length > 0;
  }

  // Rilegge i disattivati da Firestore: il DB è la fonte di verità, la cache
  // locale viene sostituita con quanto presente nel database.
  async function refreshCloudDeactivated() {
    var doc = userDoc();
    if (!doc) return;
    await flushPendingDeactivated();
    var cloudMap = await readCloudDeactivated(doc);
    state.deactivated = cloudMap;
    persistLocalDeactivated();
    notify();
  }

  async function migrateLocalAnalyses(uid) {
    var migratedKey = KEYS.migratedPrefix + uid;
    try {
      if (localStorage.getItem(migratedKey) === '1') return false;
    } catch (error) {
      return false;
    }

    var index = localAnalysisIndex();
    var uploaded = 0;
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
        markLocalAnalysisStorage(entry.id, 'cloud');
        uploaded++;
      } catch (error) {
        console.warn('[IGFT] migrazione analisi locale su Firestore non riuscita: ' + errorMessage(error));
        return uploaded > 0;
      }
    }

    try {
      localStorage.setItem(migratedKey, '1');
    } catch (error) {
      // Non bloccante.
    }
    return uploaded > 0;
  }

  // Invia a Firestore le analisi salvate mentre il DB non era raggiungibile.
  async function flushPendingAnalyses() {
    var ids = pendingList('analyses');
    var uploaded = 0;
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var local = safeRead(localAnalysisKey(id), null);
      if (!local) {
        removePending('analyses', id);
        continue;
      }
      try {
        await saveCloudAnalysis(id, normalizeReport({
          followingCount: local.followingCount,
          followersCount: local.followersCount,
          removedDeactivatedCount: local.removedDeactivatedCount,
          notFollowing: local.notFollowing || []
        }), { createdAt: local.createdAt });
        removePending('analyses', id);
        markLocalAnalysisStorage(id, 'cloud');
        uploaded++;
      } catch (error) {
        console.warn('[IGFT] sincronizzazione analisi in coda non riuscita: ' + errorMessage(error));
        break;
      }
    }
    return uploaded > 0;
  }

  function profileFor(user) {
    var email = (user && user.email) || '';
    var displayName = (user && user.displayName) || (email ? email.split('@')[0] : 'Utente');
    return { email: email, displayName: displayName };
  }

  // Salva in users/{uid} l'identità dell'utente (email e nome) e le impostazioni.
  async function ensureProfile() {
    var doc = userDoc();
    var fb = firebaseState();
    if (!doc || !fb || !state.user) return;
    var profile = profileFor(state.user);
    state.ownerEmail = profile.email;
    state.ownerName = profile.displayName;
    await withTimeout(doc.set({
      email: profile.email,
      displayName: profile.displayName,
      settings: { autoSave: state.settings.autoSave },
      updatedAt: fb.serverTimestamp()
    }, { merge: true }), 10000, 'Aggiornamento profilo su Firestore troppo lento.');
  }

  function switchToCloud(user, force) {
    if (!force && state.user && state.user.uid === user.uid && state.storage === 'cloud') {
      return;
    }
    var guestSnapshot = state.user ? null : readLocalSnapshot();
    state.user = user;
    var profile = profileFor(user);
    state.ownerEmail = profile.email;
    state.ownerName = profile.displayName;

    if (guestSnapshot && !hasScopedLocalData()) {
      adoptGuestLocalData(guestSnapshot);
    }

    state.storage = 'cloud';
    state.loading = false;
    state.error = null;
    state.cloudError = null;
    loadLocalState();
    notify();

    // La sincronizzazione non blocca l'interfaccia: la cache locale è già
    // disponibile, Firestore si allinea in background.
    if (!force && cloudBackoffActive()) return;
    syncCloudInBackground(user.uid, force);
  }

  async function syncCloudInBackground(uid, force) {
    if (cloudSync.inFlight) return;
    if (!force && cloudBackoffActive()) return;

    cloudSync.inFlight = true;
    var guard = function () {
      return !!state.user && state.user.uid === uid;
    };

    try {
      // 1. Storico: lettura dal database, unica operazione che determina lo
      //    stato della sessione.
      try {
        await withTimeout(refreshCloudAnalyses(), 15000, 'Lettura dello storico da Firestore troppo lenta.');
        if (guard()) {
          state.cloudError = null;
          state.storage = 'cloud';
          cloudOk();
          notify();
        }
      } catch (error) {
        if (isTimeout(error)) {
          cloudSlow('storico');
          return;
        }
        if (guard()) {
          state.cloudError = errorMessage(error);
          state.storage = 'local-fallback';
          state.cloudSync = 'pending';
          console.warn('[IGFT] Firestore non disponibile: ' + state.cloudError);
          notify();
          scheduleCloudRetry(60000);
        }
        return;
      }

      // 2. Profilo utente (email e nome) e impostazioni.
      try {
        await ensureProfile();
      } catch (error) {
        if (isTimeout(error)) {
          cloudSlow('profilo');
        } else {
          console.warn('[IGFT] profilo non sincronizzato: ' + errorMessage(error));
        }
      }

      // 3. Profili disattivati: migrazione una tantum, coda offline, rilettura.
      try {
        await withTimeout(migrateLocalDeactivated(uid), 15000, 'Migrazione profili disattivati troppo lenta.');
        await withTimeout(refreshCloudDeactivated(), 15000, 'Lettura profili disattivati da Firestore troppo lenta.');
        if (guard()) notify();
      } catch (error) {
        if (isTimeout(error)) {
          cloudSlow('profili disattivati');
          return;
        }
        console.warn('[IGFT] sincronizzazione profili disattivati non riuscita: ' + errorMessage(error));
      }

      // 4. Analisi salvate offline e migrazione una tantum della cache locale.
      try {
        var flushed = await withTimeout(flushPendingAnalyses(), 20000, 'Sincronizzazione analisi in coda troppo lenta.');
        var migrated = await withTimeout(migrateLocalAnalyses(uid), 20000, 'Migrazione analisi su Firestore troppo lenta.');
        if (flushed || migrated) {
          await withTimeout(refreshCloudAnalyses(), 15000, 'Lettura dello storico da Firestore troppo lenta.');
          if (guard()) notify();
        }
      } catch (error) {
        if (isTimeout(error)) {
          cloudSlow('migrazione');
          return;
        }
        console.warn('[IGFT] sincronizzazione analisi non riuscita: ' + errorMessage(error));
      }

      if (guard()) {
        state.cloudError = null;
        state.storage = 'cloud';
        cloudOk();
        notify();
      }
    } finally {
      cloudSync.inFlight = false;
    }
  }

  function switchToLocal() {
    state.user = null;
    state.ownerName = null;
    state.ownerEmail = null;
    state.storage = 'local';
    state.cloudError = null;
    state.loading = false;
    cloudOk();
    state.cloudSync = 'idle';
    state.cloudSyncReason = null;
    if (cloudSync.retryTimer) {
      clearTimeout(cloudSync.retryTimer);
      cloudSync.retryTimer = null;
    }

    // I dati dell'account restano nella sua area locale (`igft.u.{uid}.*`)
    // come cache: al login successivo la consultazione è immediata e Firestore
    // resta comunque la fonte di verità. La cancellazione avviene solo su
    // richiesta esplicita ("Elimina account e dati").
    loadLocalState();
    notify();
  }

  async function retryCloud() {
    if (!state.user) return false;
    cloudOk();
    state.storage = 'cloud';
    state.cloudError = null;
    notify();
    await syncCloudInBackground(state.user.uid, true);
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
    if (hasCloud()) {
      var doc = userDoc();
      var fb = firebaseState();
      if (doc && fb) {
        try {
          var snapshot = await withTimeout(
            doc.collection('deactivated').get(),
            15000,
            'Eliminazione dati da Firestore troppo lenta.'
          );
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
    safeRemove(scopedKey('deactivated'));
    safeRemove(scopedKey('analyses'));
    safeRemove(KEYS.settings);
    clearPending('analyses');
    clearPending('deactivatedAdd');
    clearPending('deactivatedRemove');

    localIds.forEach(function (id) { removeLocalAnalysis(id); });

    if (state.user) {
      try {
        localStorage.removeItem(KEYS.migratedPrefix + state.user.uid);
        localStorage.removeItem(KEYS.deactivatedMigratedPrefix + state.user.uid);
      } catch (error) {
        // Non bloccante.
      }
    }

    if (cloudFailed) {
      throw new Error(state.cloudError || 'Eliminazione dei dati su Firestore non riuscita.');
    }
  }

  function setAutoSave(value) {
    state.settings.autoSave = !!value;
    persistSettings();
    if (hasCloud()) {
      var doc = userDoc();
      if (doc) {
        doc.set({ settings: { autoSave: state.settings.autoSave } }, { merge: true })
          .catch(function (error) {
            console.warn('[IGFT] impostazioni non sincronizzate: ' + errorMessage(error));
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
      ownerName: state.ownerName,
      ownerEmail: state.ownerEmail,
      storage: state.storage,
      signedIn: !!state.user,
      persistence: hasCloud() ? 'firestore' : 'local',
      cloudAvailable: !!(firebaseState() && firebaseState().available),
      error: state.error,
      cloudError: state.cloudError,
      cloudSync: state.cloudSync,
      cloudSyncReason: state.cloudSyncReason,
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
