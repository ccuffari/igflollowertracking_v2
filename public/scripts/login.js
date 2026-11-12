(function () {
  'use strict';

  var AUTH_ERRORS = {
    'auth/email-already-in-use': 'Esiste già un account con questa email.',
    'auth/invalid-email': 'Email non valida.',
    'auth/missing-password': 'Inserisci la password.',
    'auth/weak-password': 'La password deve avere almeno 6 caratteri.',
    'auth/user-not-found': 'Nessun account con questa email.',
    'auth/wrong-password': 'Password errata.',
    'auth/invalid-credential': 'Email o password non corretti.',
    'auth/invalid-login-credentials': 'Email o password non corretti.',
    'auth/too-many-requests': 'Troppi tentativi. Riprova tra qualche minuto.',
    'auth/popup-closed-by-user': 'Accesso annullato.',
    'auth/cancelled-popup-request': 'Accesso annullato.',
    'auth/popup-blocked': 'Il browser ha bloccato il popup. Riprova o abilita i popup.',
    'auth/operation-not-allowed': 'Questo metodo di accesso non è abilitato nel progetto Firebase.',
    'auth/unauthorized-domain': 'Dominio non autorizzato in Firebase Authentication.',
    'auth/network-request-failed': 'Errore di rete. Controlla la connessione e riprova.',
    'auth/account-exists-with-different-credential': 'Esiste già un account con questa email usando un altro metodo di accesso.'
  };

  var mode = 'login';

  function $(id) {
    return document.getElementById(id);
  }

  function authError(error) {
    var code = error && error.code ? String(error.code) : '';
    return AUTH_ERRORS[code] || (error && error.message) || 'Operazione non riuscita. Riprova.';
  }

  function showError(el, message) {
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  function setMode(next) {
    mode = next === 'register' ? 'register' : 'login';
    var isLogin = mode === 'login';
    document.querySelectorAll('[data-login-tab]').forEach(function (tab) {
      var active = tab.getAttribute('data-login-tab') === mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('loginConfirmWrap').hidden = isLogin;
    $('loginPasswordConfirm').required = !isLogin;
    $('loginPassword').autocomplete = isLogin ? 'current-password' : 'new-password';
    $('loginPassword').minLength = isLogin ? 6 : 12;
    $('loginPassword').placeholder = isLogin ? 'La tua password' : 'Almeno 12 caratteri';
    $('loginCryptoHint').hidden = isLogin;
    $('loginSubmit').textContent = isLogin ? 'Accedi' : 'Crea account';
    $('loginTitle').textContent = isLogin ? 'Accedi' : 'Crea un account';
    $('loginForgot').hidden = !isLogin;
    showError($('loginError'), '');
  }

  // Prepara la cassaforte zero-knowledge sulla pagina di login, dove la
  // password è disponibile: la DEK viene salvata come CryptoKey non estraibile
  // in IndexedDB, così la pagina dell'app non deve mai vedere la password.
  async function prepareVault(user, password) {
    var Vault = window.IGFTVault;
    var fb = window.IGFTFirebase;
    if (!user || !password || !Vault || !Vault.supported || !Vault.supported()) return;
    if (!fb || !fb.db || typeof fb.serverTimestamp !== 'function') return;
    try {
      await Vault.setUser(user.uid);
      var ref = fb.db.collection('users').doc(user.uid);
      var snapshot = await ref.get();
      var data = snapshot && snapshot.exists ? (snapshot.data() || {}) : {};
      if (data.keyVault) {
        try {
          await Vault.unlock(data.keyVault, password);
        } catch (error) {
          console.warn('[IGFT] i dati cifrati non si aprono con la password di accesso');
        }
      } else {
        var record = await Vault.create(password, 'password');
        await ref.set({ keyVault: record, updatedAt: fb.serverTimestamp() }, { merge: true });
      }
    } catch (error) {
      console.warn('[IGFT] preparazione della cifratura non riuscita', error);
    }
  }

  function showUnavailable() {
    var notice = $('loginNotice');
    notice.innerHTML = '<strong>Accesso non disponibile.</strong> Firebase Authentication non è configurato in questo ambiente. Puoi continuare come ospite.';
    notice.hidden = false;
    $('loginFlow').hidden = true;
    $('loginExisting').hidden = true;
  }

  function showExisting(user) {
    $('loginFlow').hidden = true;
    $('loginExisting').hidden = false;
    $('loginExistingMail').textContent = user.email || 'account';
  }

  function goToApp() {
    window.location.replace('index.html');
  }

  function boot() {
    var fb = window.IGFTFirebase;
    if (!fb) {
      showUnavailable();
      return;
    }

    fb.ready.then(function () {
      if (!fb.available || !fb.auth) {
        showUnavailable();
        return;
      }

      document.querySelectorAll('[data-login-tab]').forEach(function (tab) {
        tab.addEventListener('click', function () { setMode(tab.getAttribute('data-login-tab')); });
      });

      $('loginForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        var email = $('loginEmail').value.trim();
        var password = $('loginPassword').value;
        var submit = $('loginSubmit');

        showError($('loginError'), '');
        if (!email || !password) {
          showError($('loginError'), 'Inserisci email e password.');
          return;
        }
        if (mode === 'register') {
          if (password.length < 12) {
            showError($('loginError'), 'Per proteggere la cifratura dei dati la password deve avere almeno 12 caratteri.');
            return;
          }
          var confirm = $('loginPasswordConfirm').value;
          if (password !== confirm) {
            showError($('loginError'), 'Le due password non coincidono.');
            return;
          }
        }

        submit.disabled = true;
        submit.textContent = mode === 'login' ? 'Accesso...' : 'Creazione...';
        try {
          if (mode === 'login') {
            var signedIn = await fb.auth.signInWithEmailAndPassword(email, password);
            await prepareVault(signedIn.user, password);
          } else {
            var credential = await fb.auth.createUserWithEmailAndPassword(email, password);
            if (credential && credential.user && credential.user.sendEmailVerification) {
              credential.user.sendEmailVerification().catch(function () {});
            }
            await prepareVault(credential.user, password);
          }
          goToApp();
        } catch (error) {
          submit.disabled = false;
          submit.textContent = mode === 'login' ? 'Accedi' : 'Crea account';
          showError($('loginError'), authError(error));
        }
      });

      $('loginGoogle').addEventListener('click', async function () {
        showError($('loginError'), '');
        try {
          await fb.auth.signInWithPopup(fb.googleProvider());
          goToApp();
        } catch (error) {
          if (error && error.code === 'auth/popup-blocked') {
            try {
              await fb.auth.signInWithRedirect(fb.googleProvider());
              return;
            } catch (redirectError) {
              showError($('loginError'), authError(redirectError));
              return;
            }
          }
          showError($('loginError'), authError(error));
        }
      });

      $('loginForgot').addEventListener('click', function () {
        $('loginFlow').hidden = true;
        $('resetForm').hidden = false;
        $('resetEmail').value = $('loginEmail').value.trim();
        $('resetEmail').focus();
      });

      $('resetBack').addEventListener('click', function () {
        $('resetForm').hidden = true;
        $('loginFlow').hidden = false;
        showError($('resetError'), '');
      });

      $('resetForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        var email = $('resetEmail').value.trim();
        if (!email) {
          showError($('resetError'), 'Inserisci la tua email.');
          return;
        }
        var submit = $('resetSubmit');
        submit.disabled = true;
        try {
          await fb.auth.sendPasswordResetEmail(email);
          $('resetForm').hidden = true;
          $('loginFlow').hidden = false;
          $('loginNotice').innerHTML = 'Email di reimpostazione inviata. Controlla la posta.';
          $('loginNotice').className = 'igft-alert igft-alert--info';
          $('loginNotice').hidden = false;
        } catch (error) {
          submit.disabled = false;
          showError($('resetError'), authError(error));
        }
      });

      $('loginSignOut').addEventListener('click', async function () {
        try {
          await fb.auth.signOut();
        } catch (error) {
          showError($('loginNotice'), authError(error));
        }
        $('loginExisting').hidden = true;
        $('loginFlow').hidden = false;
        $('loginNotice').hidden = true;
        setMode('login');
      });

      fb.auth.onAuthStateChanged(function (user) {
        if (user) showExisting(user);
      });

      if (fb.auth.currentUser) {
        showExisting(fb.auth.currentUser);
      }

      setMode('login');
    }).catch(function (error) {
      showUnavailable();
      console.warn('[IGFT] login non disponibile', error);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
