/*
 * Inizializzazione Firebase.
 *
 * La configurazione web di Firebase non è un segreto, ma non la hardcodiamo:
 * su Firebase Hosting viene letta da /__/firebase/init.json (riservato da Hosting),
 * così ogni ambiente (produzione, preview channel, emulator) usa i propri valori.
 *
 * Ordine di risoluzione della configurazione:
 *   1. window.IGFT_FIREBASE_CONFIG (override manuale, es. scripts/firebase-config.js locale)
 *   2. /__/firebase/init.json (Firebase Hosting)
 *   3. localStorage["igft.firebaseConfig"] (solo sviluppo locale)
 *
 * Se Firebase non è disponibile l'app resta utilizzabile in modalità ospite.
 */
(function () {
  'use strict';

  var SDK_VERSION = '10.12.5';

  var state = {
    sdkVersion: SDK_VERSION,
    available: false,
    app: null,
    auth: null,
    db: null,
    config: null,
    error: null,
    ready: null
  };

  function readLocalConfig() {
    try {
      var raw = localStorage.getItem('igft.firebaseConfig');
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function isValidConfig(config) {
    return !!config && typeof config === 'object' && !!config.apiKey && !!config.projectId;
  }

  async function resolveConfig() {
    if (isValidConfig(window.IGFT_FIREBASE_CONFIG)) {
      return window.IGFT_FIREBASE_CONFIG;
    }

    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      try {
        var response = await fetch('/__/firebase/init.json', { cache: 'no-store' });
        if (response.ok) {
          var hostingConfig = await response.json();
          if (isValidConfig(hostingConfig)) return hostingConfig;
        }
      } catch (error) {
        // Hosting auto-config non disponibile: si prosegue con i fallback.
      }
    }

    var localConfig = readLocalConfig();
    return isValidConfig(localConfig) ? localConfig : null;
  }

  async function init() {
    if (typeof window.firebase === 'undefined' || !window.firebase.initializeApp) {
      state.error = 'Firebase SDK non caricato';
      return state;
    }

    var config = await resolveConfig();
    if (!config) {
      state.error = 'Configurazione Firebase non disponibile';
      return state;
    }

    try {
      state.config = config;
      state.app = window.firebase.apps && window.firebase.apps.length
        ? window.firebase.app()
        : window.firebase.initializeApp(config);
      state.auth = window.firebase.auth();
      state.db = window.firebase.firestore();
      state.available = true;
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
      console.warn('[IGFT] Firebase non inizializzato:', state.error);
    }

    return state;
  }

  // Funzioni compat usate dai moduli successivi (caricati con defer, in ordine).
  state.googleProvider = function () {
    return new window.firebase.auth.GoogleAuthProvider();
  };
  state.emailCredential = function (email, password) {
    return window.firebase.auth.EmailAuthProvider.credential(email, password);
  };
  state.serverTimestamp = function () {
    return window.firebase.firestore.FieldValue.serverTimestamp();
  };
  state.deleteField = function () {
    return window.firebase.firestore.FieldValue.delete();
  };

  state.ready = init();
  window.IGFTFirebase = state;
})();
