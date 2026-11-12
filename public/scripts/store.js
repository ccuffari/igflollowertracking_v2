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
 *   users/{uid}                          -> profilo (email, nome), impostazioni e
 *                                           record della chiave cifrata (keyVault)
 *   users/{uid}/deactivated/{id-opaco}   -> profili disattivati CIFRATI
 *   users/{uid}/analyses/{id}            -> metadati CIFRATI dell'analisi
 *   users/{uid}/analyses/{id}/items/*    -> chunk di username CIFRATI
 *
 * Zero-knowledge: analisi e profili disattivati sono cifrati nel browser con
 * AES-GCM tramite la chiave derivata dalla password di accesso dell'utente
 * (per gli account Google, che non espongono una password, da una password di
 * cifratura dedicata) (`public/scripts/lib/crypto.js` + `vault.js`). Firestore
 * non contiene mai username in chiaro e la piattaforma non possiede la chiave.
 * Restano in chiaro solo i metadati indispensabili all'ordinamento (timestamp
 * di creazione, ID documento, numero di documenti).
 *
 * Il file ZIP e la lista dei follower non vengono mai salvati.
 */
(function () {
  'use strict';

  var Core = window.IGFTCore;
  var Crypto = window.IGFTCrypto || null;
  var Vault = window.IGFTVault || null;

  var KEYS = {
    settings: 'igft.settings.v1',
    migratedPrefix: 'igft.migrated.',
    deactivatedMigratedPrefix: 'igft.deactivatedMigrated.',
    cryptoMigratedPrefix: 'igft.cryptoMigrated.'
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
    cloudSyncReason: null,
    // Stato della cifratura per l'utente autenticato:
    // 'unsupported' | 'absent' | 'locked' | 'unlocked'
    vaultState: 'absent',
    vaultRecord: null,
    vaultError: null,
    profileLoaded: false
  };

  var listeners = new Set();
  var suppressNotify = false;

  // Segreto (password di accesso o frase Google) fornito al momento del login,
  // tenuto solo in memoria finché il profilo con `keyVault` non è disponibile.
  var pendingSecret = null;

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

  function cryptoSupported() {
    return !!(Crypto && typeof Crypto.isSupported === 'function' && Crypto.isSupported());
  }

  function vaultKeys() {
    return Vault && typeof Vault.getKeys === 'function' ? Vault.getKeys() : null;
  }

  function vaultUnlocked() {
    return !!vaultKeys();
  }

  // I dati sensibili possono essere letti/scritti sul cloud solo con la chiave
  // disponibile. In caso contrario restano nella cache locale (mai in chiaro
  // sul database) e vengono sincronizzati appena l'utente sblocca i dati.
  function sensitiveCloudReady() {
    return hasCloud() && vaultUnlocked();
  }

  function vaultUnsupportedError() {
    return 'La cifratura non è disponibile in questo browser: i dati restano solo su questo dispositivo.';
  }

  // Gli account email/password possono usare direttamente la password di
  // accesso come segreto di cifratura. Gli account Google non espongono una
  // password: per loro serve una password di cifratura dedicata.
  function accountUsesPassword(user) {
    var providers = (user && user.providerData) || [];
    for (var i = 0; i < providers.length; i++) {
      if (providers[i] && providers[i].providerId === 'password') return true;
    }
    return false;
  }

  function vaultSecretKind() {
    return state.user && accountUsesPassword(state.user) ? 'password' : 'passphrase';
  }

  // Verifica la password dell'account prima di usarla come chiave: evita di
  // sbloccare con una password sbagliata o di creare una cassaforte errata.
  async function verifyAccountPassword(password) {
    var fb = firebaseState();
    var user = fb && fb.auth ? fb.auth.currentUser : null;
    if (!user || !user.email || typeof fb.emailCredential !== 'function') {
      return { ok: true };
    }
    try {
      await user.reauthenticateWithCredential(fb.emailCredential(user.email, password));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: 'Password dell\'account non corretta.' };
    }
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
    var keys = vaultKeys();
    if (!keys) {
      var locked = new Error('Dati cifrati: inserisci la password per sincronizzare su Firestore.');
      locked.code = 'igft/vault-locked';
      throw locked;
    }

    var analysisRef = id ? doc.collection('analyses').doc(id) : doc.collection('analyses').doc();
    var fb = firebaseState();
    var createdAt = options && options.createdAt ? new Date(options.createdAt) : fb.serverTimestamp();

    var chunks = normalized.chunks;
    var createdChunkIds = [];
    var encryptedChunks = [];
    var index;

    // Il testo cifrato viene preparato prima delle scritture: nessuna username
    // in chiaro lascia il browser.
    for (index = 0; index < chunks.length; index++) {
      encryptedChunks.push(await Crypto.encryptJson(keys.dek, chunks[index]));
    }

    var encryptedSummary = await Crypto.encryptJson(keys.dek, {
      followingCount: normalized.summary.followingCount,
      followersCount: normalized.summary.followersCount,
      notFollowingCount: normalized.summary.notFollowingCount,
      removedDeactivatedCount: normalized.summary.removedDeactivatedCount,
      truncated: normalized.summary.truncated,
      chunkCount: chunks.length
    });

    try {
      for (var start = 0; start < encryptedChunks.length; start += LIMITS.batchSize) {
        var batch = fb.db.batch();
        var slice = encryptedChunks.slice(start, start + LIMITS.batchSize);
        slice.forEach(function (ciphertext, offset) {
          var chunkIndex = start + offset;
          var chunkId = 'chunk-' + String(chunkIndex).padStart(3, '0');
          createdChunkIds.push(chunkId);
          batch.set(analysisRef.collection('items').doc(chunkId), { enc: ciphertext });
        });
        await batch.commit();
      }

      await analysisRef.set({
        createdAt: createdAt,
        enc: encryptedSummary
      });

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
    }).concat([{ id: id, createdAt: normalized.summary.createdAt, followingCount: normalized.summary.followingCount, followersCount: normalized.summary.followersCount, notFollowingCount: normalized.summary.notFollowingCount, removedDeactivatedCount: normalized.summary.removedDeactivatedCount, truncated: normalized.summary.truncated, storage: sensitiveCloudReady() ? 'local-fallback' : 'local', pending: true }]));
    notify();

    // Senza chiave di cifratura non si scrive nulla in chiaro su Firestore:
    // l'analisi resta sul dispositivo finché l'utente non sblocca i dati.
    if (!sensitiveCloudReady()) {
      state.vaultError = cryptoSupported() ? null : vaultUnsupportedError();
      notify();
      return { id: id, summary: normalized.summary, storage: 'local', pending: true, vaultLocked: true };
    }

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
    if (sensitiveCloudReady() && !cloudBackoffActive()) {
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

  function analysisSummaryFrom(data) {
    return {
      followingCount: Number(data.followingCount) || 0,
      followersCount: Number(data.followersCount) || 0,
      notFollowingCount: Number(data.notFollowingCount) || 0,
      removedDeactivatedCount: Number(data.removedDeactivatedCount) || 0,
      truncated: !!data.truncated,
      chunkCount: Number(data.chunkCount) || 0
    };
  }

  // Legge i metadati di un'analisi: formato cifrato (`enc`) oppure, per i dati
  // creati prima della cifratura, formato in chiaro (da migrare).
  async function decodeAnalysis(data, keys) {
    if (data && typeof data.enc === 'string') {
      return { summary: await Crypto.decryptJson(keys.dek, data.enc), legacy: false };
    }
    return { summary: analysisSummaryFrom(data || {}), legacy: true };
  }

  async function refreshCloudAnalyses() {
    var doc = userDoc();
    if (!doc) return;
    var keys = vaultKeys();
    if (!keys) return;

    var snapshot = await doc.collection('analyses')
      .orderBy('createdAt', 'desc')
      .limit(LIMITS.maxCloudAnalyses)
      .get();

    var byId = new Map();
    for (var i = 0; i < snapshot.docs.length; i++) {
      var item = snapshot.docs[i];
      var data = item.data() || {};
      var decoded = await decodeAnalysis(data, keys);
      byId.set(item.id, {
        id: item.id,
        createdAt: data.createdAt || null,
        followingCount: decoded.summary.followingCount,
        followersCount: decoded.summary.followersCount,
        notFollowingCount: decoded.summary.notFollowingCount,
        removedDeactivatedCount: decoded.summary.removedDeactivatedCount,
        truncated: !!decoded.summary.truncated,
        storage: 'cloud'
      });
    }

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

    if (sensitiveCloudReady() && !cloudBackoffActive()) {
      var keys = vaultKeys();
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
        var decoded = await decodeAnalysis(data, keys);
        var items = await withTimeout(ref.collection('items').get(), 10000, 'Lettura analisi da Firestore troppo lenta.');
        var usernames = [];
        var ordered = items.docs.slice().sort(function (a, b) {
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        for (var i = 0; i < ordered.length; i++) {
          var chunk = ordered[i].data() || {};
          if (typeof chunk.enc === 'string') {
            usernames = usernames.concat(await Crypto.decryptJson(keys.dek, chunk.enc));
          } else if (Array.isArray(chunk.usernames)) {
            // Dati legacy in chiaro: letti per non perdere lo storico e migrati
            // al prossimo sync.
            usernames = usernames.concat(chunk.usernames);
          }
        }
        cloudOk();
        return {
          id: id,
          createdAt: data.createdAt || null,
          followingCount: decoded.summary.followingCount,
          followersCount: decoded.summary.followersCount,
          notFollowingCount: decoded.summary.notFollowingCount,
          removedDeactivatedCount: decoded.summary.removedDeactivatedCount,
          truncated: !!decoded.summary.truncated,
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

  // ID opaco del documento: il database non vede la username, il client sì
  // (stessa username produce sempre lo stesso ID per deduplicare).
  async function deactivatedDocId(username) {
    var keys = vaultKeys();
    if (!keys) throw new Error('Dati cifrati: chiave non disponibile.');
    return Crypto.dedupeId(keys.dedupeKey, Core.normalizeUsername(username));
  }

  async function encryptDeactivated(keys, item) {
    return Crypto.encryptJson(keys.dek, {
      username: item.username,
      markedAt: item.markedAt || new Date().toISOString()
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

    if (!sensitiveCloudReady()) {
      state.vaultError = cryptoSupported() ? null : vaultUnsupportedError();
      notify();
      return { synced: false, pending: true, vaultLocked: true };
    }

    try {
      var keys = vaultKeys();
      var docId = await deactivatedDocId(normalized);
      var enc = await encryptDeactivated(keys, { username: normalized, markedAt: markedAt });
      await withTimeout(userDoc().collection('deactivated').doc(docId).set({ enc: enc }), 8000, 'Sincronizzazione del profilo su Firestore troppo lenta.');
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

    if (!sensitiveCloudReady()) {
      notify();
      return { synced: false, pending: true, vaultLocked: true };
    }

    try {
      var docId = await deactivatedDocId(normalized);
      await withTimeout(userDoc().collection('deactivated').doc(docId).delete(), 8000, 'Sincronizzazione del profilo su Firestore troppo lenta.');
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
  // I documenti sono cifrati; quelli in chiaro sono dati legacy da migrare.
  async function readCloudDeactivated(doc) {
    var keys = vaultKeys();
    var cloudMap = new Map();
    var legacy = [];
    var lastDoc = null;
    if (!keys) return { map: cloudMap, legacy: legacy };

    while (true) {
      var query = doc.collection('deactivated')
        .orderBy('__name__')
        .limit(LIMITS.deactivatedPageSize);
      if (lastDoc) query = query.startAfter(lastDoc);
      var snapshot = await withTimeout(query.get(), 10000, 'Lettura profili disattivati da Firestore troppo lenta.');
      if (!snapshot.docs.length) break;

      for (var i = 0; i < snapshot.docs.length; i++) {
        var item = snapshot.docs[i];
        var data = item.data() || {};
        var payload = null;

        if (typeof data.enc === 'string') {
          try {
            payload = await Crypto.decryptJson(keys.dek, data.enc);
          } catch (error) {
            console.warn('[IGFT] documento cifrato illeggibile ignorato');
            continue;
          }
        } else {
          // Documento legacy in chiaro: lo storico esistente non va perso.
          payload = { username: data.username || item.id, markedAt: data.markedAt };
          legacy.push({ id: item.id, username: Core.normalizeUsername(payload.username), markedAt: payload.markedAt });
        }

        var username = Core.normalizeUsername(payload && payload.username);
        if (!username) continue;
        var markedAt = payload.markedAt;
        cloudMap.set(username, {
          username: username,
          markedAt: markedAt && typeof markedAt.toDate === 'function'
            ? markedAt.toDate().toISOString()
            : (markedAt || new Date().toISOString())
        });
      }

      if (snapshot.docs.length < LIMITS.deactivatedPageSize) break;
      lastDoc = snapshot.docs[snapshot.docs.length - 1];
    }

    return { map: cloudMap, legacy: legacy };
  }

  // Invia a Firestore le modifiche ai disattivati rimaste in coda (offline).
  async function flushPendingDeactivated() {
    var doc = userDoc();
    var fb = firebaseState();
    var keys = vaultKeys();
    if (!doc || !fb || !keys) return;

    var removals = pendingList('deactivatedRemove');
    var adds = pendingList('deactivatedAdd');
    if (!removals.length && !adds.length) return;

    for (var r = 0; r < removals.length; r += LIMITS.batchSize) {
      var removeBatch = fb.db.batch();
      for (var ri = r; ri < Math.min(r + LIMITS.batchSize, removals.length); ri++) {
        var removeId = await deactivatedDocId(removals[ri]);
        removeBatch.delete(doc.collection('deactivated').doc(removeId));
      }
      await withTimeout(removeBatch.commit(), 10000, 'Scrittura profili disattivati su Firestore troppo lenta.');
    }

    for (var a = 0; a < adds.length; a += LIMITS.batchSize) {
      var addBatch = fb.db.batch();
      for (var ai = a; ai < Math.min(a + LIMITS.batchSize, adds.length); ai++) {
        var username = adds[ai];
        var item = state.deactivated.get(username) || { username: username, markedAt: new Date().toISOString() };
        var addId = await deactivatedDocId(username);
        addBatch.set(doc.collection('deactivated').doc(addId), {
          enc: await encryptDeactivated(keys, item)
        });
      }
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
    var keys = vaultKeys();
    var local = localDeactivatedList();
    if (!doc || !fb || !keys || !local.length) {
      try { localStorage.setItem(migratedKey, '1'); } catch (error) { /* non bloccante */ }
      return false;
    }

    var cloudRead = await readCloudDeactivated(doc);
    var cloudMap = cloudRead.map;
    var removals = new Set(pendingList('deactivatedRemove'));
    var pending = local.filter(function (item) {
      return !cloudMap.has(item.username) && !removals.has(item.username);
    });

    for (var start = 0; start < pending.length; start += LIMITS.batchSize) {
      var batch = fb.db.batch();
      var slice = pending.slice(start, start + LIMITS.batchSize);
      for (var i = 0; i < slice.length; i++) {
        var item = slice[i];
        var docId = await deactivatedDocId(item.username);
        batch.set(doc.collection('deactivated').doc(docId), {
          enc: await encryptDeactivated(keys, item)
        });
      }
      await withTimeout(batch.commit(), 10000, 'Migrazione profili disattivati su Firestore troppo lenta.');
    }

    try { localStorage.setItem(migratedKey, '1'); } catch (error) { /* non bloccante */ }
    return pending.length > 0;
  }

  // Rilegge i disattivati da Firestore: il DB è la fonte di verità, la cache
  // locale viene sostituita con quanto presente nel database.
  async function refreshCloudDeactivated() {
    var doc = userDoc();
    if (!doc || !vaultUnlocked()) return;
    await flushPendingDeactivated();
    var cloudRead = await readCloudDeactivated(doc);
    state.deactivated = cloudRead.map;
    persistLocalDeactivated();
    notify();
  }

  // Migrazione una tantum dei documenti scritti in chiaro dalla versione
  // precedente: vengono ri-cifrati e la copia in chiaro viene eliminata.
  async function migrateLegacyCloud(uid) {
    var migratedKey = KEYS.cryptoMigratedPrefix + uid;
    var analysesMigrated = false;
    try {
      analysesMigrated = localStorage.getItem(migratedKey) === '1';
    } catch (error) {
      analysesMigrated = false;
    }

    var doc = userDoc();
    var fb = firebaseState();
    var keys = vaultKeys();
    if (!doc || !fb || !keys) return false;

    var changed = false;

    // 1. Profili disattivati: i documenti legacy hanno l'ID = username.
    //    Il controllo è sempre attivo, così anche un dato scritto da una
    //    versione precedente dopo la migrazione viene cifrato al sync seguente.
    var deactivated = await readCloudDeactivated(doc);
    for (var i = 0; i < deactivated.legacy.length; i++) {
      var legacy = deactivated.legacy[i];
      if (!legacy.username) continue;
      var newId = await deactivatedDocId(legacy.username);
      await withTimeout(doc.collection('deactivated').doc(newId).set({
        enc: await encryptDeactivated(keys, {
          username: legacy.username,
          markedAt: legacy.markedAt && typeof legacy.markedAt.toDate === 'function'
            ? legacy.markedAt.toDate().toISOString()
            : (legacy.markedAt || new Date().toISOString())
        })
      }), 10000, 'Migrazione profili disattivati troppo lenta.');
      await withTimeout(doc.collection('deactivated').doc(legacy.id).delete(), 10000, 'Migrazione profili disattivati troppo lenta.');
      changed = true;
    }

    // 2. Analisi: metadati e chunk scritti in chiaro (scansione una tantum).
    if (!analysesMigrated) {
      var analyses = await doc.collection('analyses').get();
      for (var a = 0; a < analyses.docs.length; a++) {
        var analysisDoc = analyses.docs[a];
        var data = analysisDoc.data() || {};
        if (typeof data.enc === 'string') continue;
        if (!data.createdAt) continue;

        var items = await analysisDoc.ref.collection('items').get();
        for (var c = 0; c < items.docs.length; c++) {
          var chunkDoc = items.docs[c];
          var chunk = chunkDoc.data() || {};
          if (typeof chunk.enc === 'string') continue;
          if (!Array.isArray(chunk.usernames)) continue;
          await withTimeout(chunkDoc.ref.set({
            enc: await Crypto.encryptJson(keys.dek, chunk.usernames)
          }), 10000, 'Migrazione analisi troppo lenta.');
        }

        var summary = analysisSummaryFrom(data);
        await withTimeout(analysisDoc.ref.set({
          createdAt: data.createdAt || null,
          enc: await Crypto.encryptJson(keys.dek, summary)
        }), 10000, 'Migrazione analisi troppo lenta.');
        changed = true;
      }
      try { localStorage.setItem(migratedKey, '1'); } catch (error) { /* non bloccante */ }
    }

    return changed;
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

  function updateVaultState() {
    if (!cryptoSupported()) {
      state.vaultState = 'unsupported';
      return;
    }
    if (vaultUnlocked()) {
      state.vaultState = 'unlocked';
      return;
    }
    state.vaultState = state.vaultRecord ? 'locked' : 'absent';
  }

  // Legge il documento profilo: include il record della chiave cifrata.
  async function readCloudProfile() {
    var doc = userDoc();
    if (!doc) return null;
    var snapshot = await withTimeout(doc.get(), 12000, 'Lettura profilo da Firestore troppo lenta.');
    var data = snapshot && snapshot.exists ? (snapshot.data() || {}) : {};
    // Non sovrascrivere con `null` una cassaforte appena creata in locale: una
    // lettura partita prima della scrittura potrebbe tornare con dati vecchi.
    state.vaultRecord = data.keyVault || state.vaultRecord || null;
    state.profileLoaded = true;
    updateVaultState();
    return data;
  }

  async function switchToCloud(user, force) {
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

    state.vaultRecord = null;
    state.vaultError = null;
    state.profileLoaded = false;
    if (Vault && typeof Vault.setUser === 'function') {
      try {
        await Vault.setUser(user.uid);
      } catch (error) {
        console.warn('[IGFT] impossibile ripristinare la chiave sul dispositivo');
      }
    }
    updateVaultState();

    // Se il login ha fornito la password (o la frase Google), la usiamo subito
    // per aprire la cassaforte senza chiedere nulla in più all'utente.
    await applyPendingVaultSecret();
    updateVaultState();

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
      // 1. Profilo utente e record della chiave di cifratura. È l'unica
      //    operazione che determina lo stato della sessione.
      try {
        await withTimeout(readCloudProfile(), 15000, 'Lettura profilo da Firestore troppo lenta.');
        // La password del login può essere arrivata dopo l'avvio del sync:
        // applicala ora che il record `keyVault` è disponibile.
        await applyPendingVaultSecret();
        if (guard()) {
          state.cloudError = null;
          state.storage = 'cloud';
          cloudOk();
          notify();
        }
      } catch (error) {
        if (isTimeout(error)) {
          cloudSlow('profilo');
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

      // 2. Identità (email e nome) e impostazioni.
      try {
        await ensureProfile();
      } catch (error) {
        if (isTimeout(error)) {
          cloudSlow('profilo');
        } else {
          console.warn('[IGFT] profilo non sincronizzato: ' + errorMessage(error));
        }
      }

      // 3. Dati sensibili: solo con la chiave disponibile. Senza chiave non
      //    viene letto né scritto nulla in chiaro; i dati restano in locale.
      if (vaultUnlocked()) {
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
            notify();
            scheduleCloudRetry(60000);
          }
          return;
        }

        // 4. Migrazione una tantum dei documenti legacy in chiaro.
        try {
          await withTimeout(migrateLegacyCloud(uid), 30000, 'Migrazione dei dati cifrati troppo lenta.');
        } catch (error) {
          if (isTimeout(error)) {
            cloudSlow('migrazione cifratura');
          } else {
            console.warn('[IGFT] migrazione dati in chiaro non riuscita: ' + errorMessage(error));
          }
        }

        // 5. Profili disattivati: coda offline e rilettura.
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

        // 6. Analisi salvate offline e migrazione una tantum della cache locale.
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
    state.vaultRecord = null;
    state.vaultState = 'absent';
    state.vaultError = null;
    state.profileLoaded = false;
    pendingSecret = null;
    if (Vault && typeof Vault.detach === 'function') Vault.detach();
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

  /* ======================= CIFRATURA (ZERO-KNOWLEDGE) ======================= */

  // Fornisce il segreto del login (password dell'account per gli account
  // email/password, password di cifratura per gli account Google). Resta solo
  // in memoria finché il profilo con `keyVault` non è disponibile.
  async function provideVaultSecret(secret, options) {
    var value = String(secret == null ? '' : secret);
    if (!value) return { ok: false, error: 'Inserisci la password.' };
    pendingSecret = {
      secret: value,
      source: options && options.source ? options.source : vaultSecretKind(),
      createIfMissing: !!(options && options.createIfMissing)
    };
    return applyPendingVaultSecret();
  }

  async function applyPendingVaultSecret() {
    var pending = pendingSecret;
    if (!pending || !state.user) return { ok: false, pending: true };
    if (!hasCloud()) return { ok: false, pending: true };
    if (!state.profileLoaded) {
      try {
        await readCloudProfile();
      } catch (error) {
        return { ok: false, pending: true, error: errorMessage(error) };
      }
    }
    if (!state.user || pendingSecret !== pending) return { ok: false, pending: true };

    try {
      if (state.vaultRecord) {
        await Vault.unlock(state.vaultRecord, pending.secret);
      } else if (pending.createIfMissing) {
        var record = await Vault.create(pending.secret);
        await withTimeout(
          userDoc().set({ keyVault: record, updatedAt: firebaseState().serverTimestamp() }, { merge: true }),
          12000,
          'Salvataggio della chiave su Firestore troppo lento.'
        );
        state.vaultRecord = record;
      } else {
        return { ok: false, error: 'La cifratura non è attiva su questo account.' };
      }
      pendingSecret = null;
      state.vaultState = 'unlocked';
      state.vaultError = null;
      notify();
      syncCloudInBackground(state.user.uid, true);
      return { ok: true };
    } catch (error) {
      pendingSecret = null;
      updateVaultState();
      state.vaultError = errorMessage(error);
      notify();
      return {
        ok: false,
        error: pending.source === 'password'
          ? 'La password non corrisponde ai dati cifrati di questo account.'
          : 'Password di cifratura non corretta.'
      };
    }
  }

  // Attiva la cifratura per l'account: crea la chiave e la salva avvolta nel
  // profilo. Da questo momento analisi e disattivati vengono cifrati.
  async function setupVault(secret, options) {
    if (!state.user) return { ok: false, error: 'Accedi per attivare la cifratura.' };
    if (!cryptoSupported()) return { ok: false, error: vaultUnsupportedError() };
    if (state.vaultRecord) return { ok: false, error: 'La cifratura è già attiva su questo account.' };
    if (!hasCloud()) return { ok: false, error: 'Connettiti a Firestore per attivare la cifratura.' };

    var kind = vaultSecretKind();
    var value = String(secret || '');
    if (!value) return { ok: false, error: 'Inserisci la password.' };
    if (kind === 'passphrase' && value.length < 12) {
      return { ok: false, error: 'Usa una password di cifratura di almeno 12 caratteri.' };
    }
    if (kind === 'password' && !(options && options.verified)) {
      var verified = await verifyAccountPassword(value);
      if (!verified.ok) return verified;
    }

    var record;
    try {
      record = await Vault.create(value);
      await withTimeout(
        userDoc().set({ keyVault: record, updatedAt: firebaseState().serverTimestamp() }, { merge: true }),
        12000,
        'Salvataggio della chiave su Firestore troppo lento.'
      );
      state.vaultRecord = record;
      state.vaultState = 'unlocked';
      state.vaultError = null;
      notify();
      syncCloudInBackground(state.user.uid, true);
      return { ok: true };
    } catch (error) {
      // Se la chiave non è stata salvata, non deve restare attiva: altrimenti
      // i dati cifrati non sarebbero più recuperabili dopo un logout.
      if (Vault && typeof Vault.lock === 'function') {
        try { await Vault.lock(); } catch (lockError) { /* non bloccante */ }
      }
      state.vaultRecord = null;
      state.vaultState = cryptoSupported() ? 'absent' : 'unsupported';
      notify();
      return { ok: false, error: errorMessage(error) };
    }
  }

  async function unlockVault(secret, options) {
    if (!state.user) return { ok: false, error: 'Accedi per sbloccare i dati.' };
    if (state.vaultState === 'unsupported') return { ok: false, error: vaultUnsupportedError() };
    if (!state.vaultRecord) return { ok: false, error: 'La cifratura non è ancora attiva su questo account.' };

    var kind = vaultSecretKind();
    var value = String(secret || '');
    if (!value) {
      return { ok: false, error: kind === 'password' ? 'Inserisci la password dell\'account.' : 'Inserisci la password di cifratura.' };
    }
    if (kind === 'password' && !(options && options.verified)) {
      var verified = await verifyAccountPassword(value);
      if (!verified.ok) return verified;
    }

    try {
      await Vault.unlock(state.vaultRecord, value);
      state.vaultState = 'unlocked';
      state.vaultError = null;
      notify();
      syncCloudInBackground(state.user.uid, true);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: kind === 'password'
          ? 'Password dell\'account non corretta.'
          : 'Password di cifratura non corretta.'
      };
    }
  }

  // Blocca i dati su questo dispositivo: rimuove la chiave dalla memoria e
  // dalla cache locale. Per riaprirli servirà di nuovo la password.
  async function lockVault() {
    if (Vault && typeof Vault.lock === 'function') {
      await Vault.lock();
    }
    updateVaultState();
    notify();
    return { ok: true };
  }

  async function changeVaultSecret(currentSecret, nextSecret, options) {
    if (!state.user || !state.vaultRecord) {
      return { ok: false, error: 'La cifratura non è attiva su questo account.' };
    }
    var kind = (options && options.source) || vaultSecretKind();
    if (kind !== 'passphrase') {
      return {
        ok: false,
        error: 'La chiave è legata alla password di accesso: per cambiarla usa le impostazioni dell\'account.'
      };
    }
    if (String(nextSecret || '').length < 12) {
      return { ok: false, error: 'La nuova password di cifratura deve avere almeno 12 caratteri.' };
    }
    try {
      var nextRecord = await Vault.changeSecret(
        state.vaultRecord,
        String(currentSecret || ''),
        String(nextSecret)
      );
      await withTimeout(
        userDoc().set({ keyVault: nextRecord, updatedAt: firebaseState().serverTimestamp() }, { merge: true }),
        12000,
        'Aggiornamento della chiave su Firestore troppo lento.'
      );
      state.vaultRecord = nextRecord;
      notify();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: 'Password di cifratura attuale non corretta.' };
    }
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
          // Elimina tutte le analisi sul cloud, anche quando la chiave è
          // bloccata e lo storico locale non ne conosce gli ID.
          var cloudAnalyses = await withTimeout(
            doc.collection('analyses').get(),
            15000,
            'Eliminazione dati da Firestore troppo lenta.'
          );
          for (var a = 0; a < cloudAnalyses.docs.length; a++) {
            var analysisRef = cloudAnalyses.docs[a].ref;
            var analysisItems = await analysisRef.collection('items').get();
            for (var startItems = 0; startItems < analysisItems.docs.length; startItems += LIMITS.batchSize) {
              var itemsBatch = fb.db.batch();
              analysisItems.docs.slice(startItems, startItems + LIMITS.batchSize).forEach(function (item) {
                itemsBatch.delete(item.ref);
              });
              await itemsBatch.commit();
            }
            await analysisRef.delete();
          }

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
      var uid = state.user.uid;
      try {
        localStorage.removeItem(KEYS.migratedPrefix + uid);
        localStorage.removeItem(KEYS.deactivatedMigratedPrefix + uid);
        localStorage.removeItem(KEYS.cryptoMigratedPrefix + uid);
      } catch (error) {
        // Non bloccante.
      }
      if (Vault && typeof Vault.forget === 'function') {
        try { await Vault.forget(uid); } catch (error) { /* non bloccante */ }
      }
      state.vaultRecord = null;
      state.vaultState = 'absent';
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
      analysesCount: state.analyses.length,
      vaultState: state.vaultState,
      vaultSecretKind: vaultSecretKind(),
      vaultSource: Vault && typeof Vault.getSource === 'function' ? Vault.getSource() : null,
      vaultError: state.vaultError,
      encryption: state.vaultState === 'unlocked' ? 'zero-knowledge' : 'pending'
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
    retryCloud: retryCloud,
    provideVaultSecret: provideVaultSecret,
    setupVault: setupVault,
    unlockVault: unlockVault,
    lockVault: lockVault,
    changeVaultSecret: changeVaultSecret
  };
})();
