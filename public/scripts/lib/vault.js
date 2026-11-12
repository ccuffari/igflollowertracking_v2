/*
 * Gestione della chiave di cifratura durante la sessione.
 *
 * La DEK (Data Encryption Key) viene tenuta in memoria e, per comodità,
 * memorizzata in IndexedDB come CryptoKey non estraibile legata al dispositivo.
 * Così al ritorno sullo stesso browser non serve reinserire la password, ma
 * nessun script può esportarne il valore grezzo.
 *
 * IndexedDB può non essere disponibile (modalità privata, test, contesti
 * limitati): in quel caso la chiave resta solo in memoria e il segreto viene
 * richiesto a ogni caricamento. Nessuna chiave viene mai inviata al server.
 */
(function () {
  'use strict';

  var Crypto = window.IGFTCrypto;
  var DB_NAME = 'igft-vault';
  var DB_VERSION = 1;
  var STORE_NAME = 'keys';

  var state = {
    uid: null,
    dek: null,
    dedupeKey: null,
    // 'memory' | 'device'
    source: null
  };

  var dbPromise = null;

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        reject(new Error('IndexedDB non disponibile'));
        return;
      }
      var request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB error')); };
    }).catch(function (error) {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  function withStore(mode, operation) {
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(STORE_NAME, mode);
        var store = transaction.objectStore(STORE_NAME);
        var request;
        try {
          request = operation(store);
        } catch (error) {
          reject(error);
          return;
        }
        transaction.oncomplete = function () {
          resolve(request ? request.result : undefined);
        };
        transaction.onerror = function () { reject(transaction.error || new Error('IndexedDB error')); };
        transaction.onabort = function () { reject(transaction.error || new Error('IndexedDB abort')); };
      });
    });
  }

  function readDeviceKeys(uid) {
    return withStore('readonly', function (store) { return store.get(uid); })
      .then(function (value) { return value || null; })
      .catch(function () { return null; });
  }

  function writeDeviceKeys(uid, keys) {
    return withStore('readwrite', function (store) {
      return store.put(keys, uid);
    }).catch(function () { /* cache opzionale */ });
  }

  function deleteDeviceKeys(uid) {
    return withStore('readwrite', function (store) {
      return store.delete(uid);
    }).catch(function () { /* cache opzionale */ });
  }

  async function cacheDek(uid, dek, dedupeKey) {
    if (!uid || typeof crypto === 'undefined' || !crypto.subtle) return;
    try {
      var raw = await crypto.subtle.exportKey('raw', dek);
      var portable = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      await writeDeviceKeys(uid, { dek: portable, dedupeKey: dedupeKey });
    } catch (error) {
      // Solo memoria: il segreto verrà richiesto al prossimo caricamento.
    }
  }

  async function useDek(uid, dek, source) {
    state.uid = uid || state.uid;
    state.dek = dek;
    state.dedupeKey = await Crypto.deriveDedupeKey(dek);
    state.source = source || 'memory';
  }

  // Imposta l'utente corrente e prova a recuperare la chiave dal dispositivo.
  async function setUser(uid) {
    if (!uid) {
      detach();
      return false;
    }
    if (state.uid === uid && state.dek) return true;

    state.uid = uid;
    state.dek = null;
    state.dedupeKey = null;
    state.source = null;

    var cached = await readDeviceKeys(uid);
    if (cached && cached.dek) {
      try {
        state.dek = cached.dek;
        state.dedupeKey = cached.dedupeKey || await Crypto.deriveDedupeKey(cached.dek);
        state.source = 'device';
        return true;
      } catch (error) {
        state.dek = null;
        state.dedupeKey = null;
        state.source = null;
      }
    }
    return false;
  }

  function isUnlocked() {
    return !!state.dek;
  }

  function getKeys() {
    if (!state.dek) return null;
    return { dek: state.dek, dedupeKey: state.dedupeKey };
  }

  function getSource() {
    return state.source;
  }

  function getUid() {
    return state.uid;
  }

  // Crea una nuova cassaforte e memorizza la chiave sul dispositivo.
  async function create(secret) {
    if (!state.uid) throw new Error('Utente non impostato');
    var vault = await Crypto.createVault(secret);
    await useDek(state.uid, vault.dek, 'memory');
    await cacheDek(state.uid, vault.dek, state.dedupeKey);
    return vault.record;
  }

  // Sblocca la cassaforte esistente con il segreto (password o frase).
  async function unlock(record, secret) {
    if (!state.uid) throw new Error('Utente non impostato');
    var dek = await Crypto.unwrapVault(record, secret);
    await useDek(state.uid, dek, 'memory');
    await cacheDek(state.uid, dek, state.dedupeKey);
    return true;
  }

  // Cambia il segreto mantenendo la stessa DEK (i dati restano leggibili) e
  // restituisce il nuovo record da salvare nel profilo.
  async function changeSecret(record, currentSecret, nextSecret) {
    if (!state.uid) throw new Error('Utente non impostato');
    var dek = await Crypto.unwrapVault(record, currentSecret);
    var nextRecord = await Crypto.rewrapVault(dek, nextSecret);
    await useDek(state.uid, dek, 'memory');
    await cacheDek(state.uid, dek, state.dedupeKey);
    return nextRecord;
  }

  // Rimuove la chiave dalla memoria ma lascia l'accesso rapido sul dispositivo
  // (es. logout sullo stesso browser).
  function detach() {
    state.dek = null;
    state.dedupeKey = null;
    state.source = null;
  }

  // Blocca i dati: rimuove memoria e cache del dispositivo. Al prossimo accesso
  // servirà di nuovo la password (o la frase per gli account Google).
  async function lock() {
    var uid = state.uid;
    detach();
    if (uid) await deleteDeviceKeys(uid);
  }

  // Eliminazione definitiva (account cancellato).
  async function forget(uid) {
    detach();
    if (uid) await deleteDeviceKeys(uid);
  }

  window.IGFTVault = {
    supported: function () { return Crypto && Crypto.isSupported(); },
    setUser: setUser,
    isUnlocked: isUnlocked,
    getKeys: getKeys,
    getSource: getSource,
    getUid: getUid,
    create: create,
    unlock: unlock,
    changeSecret: changeSecret,
    detach: detach,
    lock: lock,
    forget: forget
  };
})();
