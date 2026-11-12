/*
 * Interfaccia account: accesso/registrazione Firebase, menu utente,
 * libreria delle analisi salvate e gestione dei profili disattivati.
 *
 * Se Firebase non è configurato l'accesso resta disabilitato ma l'app
 * continua a funzionare in modalità ospite (dati solo su questo dispositivo).
 */
(function () {
  'use strict';

  var Core = window.IGFTCore;
  var Store = window.IGFTStore;
  var escapeHtml = Core.escapeHtml;

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
    'auth/requires-recent-login': 'Per questa operazione devi effettuare di nuovo l\'accesso.',
    'auth/account-exists-with-different-credential': 'Esiste già un account con questa email usando un altro metodo di accesso.'
  };

  var MAX_LIST_ROWS = 200;
  var libraryRenderToken = 0;
  var pendingConfirm = null;

  var ui = {
    view: null,
    libraryTab: 'analyses',
    detail: null
  };

  var authMode = 'login';

  function authError(error) {
    var code = error && error.code ? String(error.code) : '';
    return AUTH_ERRORS[code] || (error && error.message) || 'Operazione non riuscita. Riprova.';
  }

  function firebaseState() {
    return window.IGFTFirebase || null;
  }

  function firebaseReady() {
    var fb = firebaseState();
    return !!(fb && fb.available && fb.auth);
  }

  function modalRoot() {
    var root = document.getElementById('igftModalRoot');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'igftModalRoot';
    root.className = 'igft-modal';
    root.hidden = true;
    root.innerHTML = [
      '<div class="igft-modal__backdrop" data-igft-close="1"></div>',
      '<div class="igft-modal__panel" role="dialog" aria-modal="true" aria-labelledby="igftModalTitle">',
      '  <button type="button" class="igft-modal__close" data-igft-close="1" aria-label="Chiudi">×</button>',
      '  <div class="igft-modal__body" id="igftModalBody"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(root);

    root.addEventListener('click', function (event) {
      if (event.target && event.target.getAttribute('data-igft-close')) closeModal();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !root.hidden) closeModal();
    });

    return root;
  }

  function openModal(html) {
    var root = modalRoot();
    var body = document.getElementById('igftModalBody');
    if (pendingConfirm) {
      var pending = pendingConfirm;
      pendingConfirm = null;
      pending(null);
    }
    body.innerHTML = html;
    root.hidden = false;
    document.body.classList.add('igft-modal-open');
    var focusable = body.querySelector('input, button.igft-primary, button');
    if (focusable) focusable.focus();
  }

  function setModalBody(html, focus) {
    var root = modalRoot();
    var body = document.getElementById('igftModalBody');
    if (!body) return;
    body.innerHTML = html;
    if (root.hidden) {
      root.hidden = false;
      document.body.classList.add('igft-modal-open');
    }
    if (focus) {
      var target = body.querySelector(focus);
      if (target) target.focus();
    }
    bindLibraryActions();
  }

  function closeModal() {
    var root = document.getElementById('igftModalRoot');
    if (!root) return;
    root.hidden = true;
    document.body.classList.remove('igft-modal-open');
    document.getElementById('igftModalBody').innerHTML = '';
    ui.view = null;
    ui.detail = null;

    if (pendingConfirm) {
      var resolver = pendingConfirm;
      pendingConfirm = null;
      resolver(null);
    }
  }

  function toast(message, kind) {
    var container = document.getElementById('igftToasts');
    if (!container) {
      container = document.createElement('div');
      container.id = 'igftToasts';
      container.className = 'igft-toasts';
      container.setAttribute('role', 'status');
      container.setAttribute('aria-live', 'polite');
      document.body.appendChild(container);
    }
    var item = document.createElement('div');
    item.className = 'igft-toast igft-toast--' + (kind || 'info');
    item.textContent = message;
    container.appendChild(item);
    setTimeout(function () {
      item.classList.add('igft-toast--out');
      setTimeout(function () { item.remove(); }, 250);
    }, 4200);
  }

  function storageLabel() {
    var status = Store.getStatus();
    if (status.storage === 'cloud') return 'Sincronizzate con il tuo account';
    if (status.storage === 'local-fallback') return 'Sincronizzazione non disponibile: dati salvati solo su questo dispositivo';
    return 'Salvate solo su questo dispositivo';
  }

  function accountArea() {
    return document.getElementById('igftAccount');
  }

  function renderAccountArea() {
    var area = accountArea();
    if (!area) return;
    var status = Store.getStatus();

    if (status.signedIn) {
      var email = status.user.email || 'Account';
      var initial = email.charAt(0).toUpperCase();
      area.innerHTML = [
        '<button type="button" class="igft-account-btn igft-account-btn--user" id="igftAccountBtn" title="' + escapeHtml(email) + '">',
        '  <span class="igft-avatar" aria-hidden="true">' + escapeHtml(initial) + '</span>',
        '  <span class="igft-account-mail">' + escapeHtml(email) + '</span>',
        '</button>'
      ].join('');
      var btn = document.getElementById('igftAccountBtn');
      if (btn) btn.addEventListener('click', openAccount);
      return;
    }

    var hasLocalData = status.deactivatedCount > 0 || status.analysesCount > 0;
    area.innerHTML = [
      '<a class="igft-icon-btn" href="login.html" title="Accedi" aria-label="Accedi">',
      '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
      '    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>',
      '    <circle cx="12" cy="7" r="4"></circle>',
      '  </svg>',
      '</a>',
      hasLocalData
        ? '<button type="button" class="igft-icon-btn" id="igftLocalBtn" title="Storico locale" aria-label="Storico locale"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 3v6h6"></path><path d="M12 7v5l3 2"></path></svg></button>'
        : ''
    ].join('');

    var localBtn = document.getElementById('igftLocalBtn');
    if (localBtn) localBtn.addEventListener('click', function () { openLibrary('analyses'); });
  }

  /* ============================ AUTH ============================ */

  function authUnavailableNotice() {
    return [
      '<div class="igft-alert igft-alert--warning">',
      '  <strong>Accesso non disponibile.</strong> Firebase Authentication non è configurato in questo ambiente.',
      '  Puoi continuare a usare l\'app come ospite: i profili disattivati e le analisi restano salvati solo su questo dispositivo.',
      '</div>'
    ].join('');
  }

  async function openAuth(mode) {
    ui.view = 'auth';
    authMode = mode || 'login';

    var fb = firebaseState();
    if (fb && fb.ready) {
      try {
        await fb.ready;
      } catch (error) {
        // Si prosegue: firebaseReady() gestisce il caso non disponibile.
      }
    }

    if (!firebaseReady()) {
      openModal([
        '<h2 class="igft-title" id="igftModalTitle">Accedi o registrati</h2>',
        authUnavailableNotice(),
        '<div class="igft-actions">',
        '  <button type="button" class="btn ghost" id="igftAuthGuestBtn">Continua come ospite</button>',
        '</div>'
      ].join(''));
      var guestBtn = document.getElementById('igftAuthGuestBtn');
      if (guestBtn) guestBtn.addEventListener('click', closeModal);
      return;
    }

    renderAuthForm('');
  }

  function renderAuthForm(error) {
    var isLogin = authMode === 'login';
    var status = Store.getStatus();
    openModal([
      '<h2 class="igft-title" id="igftModalTitle">' + (isLogin ? 'Accedi' : 'Crea un account') + '</h2>',
      '<p class="igft-muted">L\'accesso è facoltativo. Senza account puoi usare l\'app come ospite.</p>',
      '<div class="igft-tabs" role="tablist">',
      '  <button type="button" role="tab" class="igft-tab ' + (isLogin ? 'is-active' : '') + '" data-auth-tab="login" aria-selected="' + (isLogin ? 'true' : 'false') + '">Accedi</button>',
      '  <button type="button" role="tab" class="igft-tab ' + (!isLogin ? 'is-active' : '') + '" data-auth-tab="register" aria-selected="' + (!isLogin ? 'true' : 'false') + '">Registrati</button>',
      '</div>',
      error ? '<div class="igft-alert igft-alert--error">' + escapeHtml(error) + '</div>' : '',
      '<form id="igftAuthForm" novalidate>',
      '  <label class="igft-field">Email',
      '    <input type="email" id="igftEmail" name="email" autocomplete="email" required placeholder="nome@esempio.it">',
      '  </label>',
      '  <label class="igft-field">Password',
      '    <input type="password" id="igftPassword" name="password" autocomplete="' + (isLogin ? 'current-password' : 'new-password') + '" required minlength="6" placeholder="Almeno 6 caratteri">',
      '  </label>',
      !isLogin ? [
        '  <label class="igft-field">Conferma password',
        '    <input type="password" id="igftPasswordConfirm" name="passwordConfirm" autocomplete="new-password" required minlength="6">',
        '  </label>'
      ].join('') : '',
      '  <div id="igftAuthError" class="igft-alert igft-alert--error" hidden></div>',
      '  <button type="submit" class="btn igft-primary" id="igftAuthSubmit">' + (isLogin ? 'Accedi' : 'Crea account') + '</button>',
      '</form>',
      '<div class="igft-separator"><span>oppure</span></div>',
      '<button type="button" class="btn ghost igft-google" id="igftGoogleBtn">',
      '  <span class="igft-google__mark" aria-hidden="true">G</span> Continua con Google',
      '</button>',
      isLogin ? '<button type="button" class="igft-link" id="igftForgotBtn">Password dimenticata?</button>' : '',
      '<div class="igft-auth-footer">',
      '  <button type="button" class="igft-link" id="igftContinueGuest">Continua come ospite</button>',
      status.deactivatedCount > 0 ? '<button type="button" class="igft-link" id="igftAuthDeactivated">Profili disattivati (' + status.deactivatedCount + ')</button>' : '',
      '</div>'
    ].join(''));

    var form = document.getElementById('igftAuthForm');
    document.querySelectorAll('[data-auth-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        authMode = tab.getAttribute('data-auth-tab');
        renderAuthForm('');
      });
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submitAuth(isLogin);
    });

    document.getElementById('igftGoogleBtn').addEventListener('click', signInWithGoogle);
    var forgot = document.getElementById('igftForgotBtn');
    if (forgot) forgot.addEventListener('click', renderResetPassword);

    document.getElementById('igftContinueGuest').addEventListener('click', closeModal);

    var deactivated = document.getElementById('igftAuthDeactivated');
    if (deactivated) {
      deactivated.addEventListener('click', function () { openLibrary('deactivated'); });
    }

    var emailInput = document.getElementById('igftEmail');
    if (emailInput) emailInput.focus();
  }

  function showAuthError(message) {
    var box = document.getElementById('igftAuthError');
    if (box) {
      box.textContent = message;
      box.hidden = false;
    } else {
      toast(message, 'error');
    }
  }

  async function submitAuth(isLogin) {
    var submit = document.getElementById('igftAuthSubmit');
    var email = document.getElementById('igftEmail').value.trim();
    var password = document.getElementById('igftPassword').value;

    if (!email || !password) {
      showAuthError('Inserisci email e password.');
      return;
    }
    if (!isLogin) {
      var confirm = document.getElementById('igftPasswordConfirm').value;
      if (password !== confirm) {
        showAuthError('Le due password non coincidono.');
        return;
      }
    }

    var fb = firebaseState();
    submit.disabled = true;
    submit.textContent = isLogin ? 'Accesso...' : 'Creazione...';

    try {
      if (isLogin) {
        await fb.auth.signInWithEmailAndPassword(email, password);
        closeModal();
        toast('Accesso effettuato.', 'success');
      } else {
        var credential = await fb.auth.createUserWithEmailAndPassword(email, password);
        if (credential && credential.user && credential.user.sendEmailVerification) {
          credential.user.sendEmailVerification().catch(function () {});
        }
        closeModal();
        toast('Account creato. Ti abbiamo inviato un\'email di verifica.', 'success');
      }
    } catch (error) {
      submit.disabled = false;
      submit.textContent = isLogin ? 'Accedi' : 'Crea account';
      showAuthError(authError(error));
    }
  }

  async function signInWithGoogle() {
    var fb = firebaseState();
    try {
      await fb.auth.signInWithPopup(fb.googleProvider());
      closeModal();
      toast('Accesso effettuato.', 'success');
    } catch (error) {
      if (error && error.code === 'auth/popup-blocked') {
        try {
          await fb.auth.signInWithRedirect(fb.googleProvider());
          return;
        } catch (redirectError) {
          showAuthError(authError(redirectError));
          return;
        }
      }
      showAuthError(authError(error));
    }
  }

  function renderResetPassword(error) {
    ui.view = 'auth';
    openModal([
      '<h2 class="igft-title" id="igftModalTitle">Reimposta la password</h2>',
      '<p class="igft-muted">Inserisci l\'email del tuo account: riceverai un link per impostare una nuova password.</p>',
      error ? '<div class="igft-alert igft-alert--error">' + escapeHtml(error) + '</div>' : '',
      '<form id="igftResetForm" novalidate>',
      '  <label class="igft-field">Email',
      '    <input type="email" id="igftResetEmail" autocomplete="email" required placeholder="nome@esempio.it">',
      '  </label>',
      '  <button type="submit" class="btn igft-primary" id="igftResetSubmit">Invia link</button>',
      '</form>',
      '<div class="igft-auth-footer"><button type="button" class="igft-link" id="igftBackToLogin">Torna all\'accesso</button></div>'
    ].join(''));

    document.getElementById('igftBackToLogin').addEventListener('click', function () {
      authMode = 'login';
      renderAuthForm('');
    });

    document.getElementById('igftResetForm').addEventListener('submit', async function (event) {
      event.preventDefault();
      var email = document.getElementById('igftResetEmail').value.trim();
      if (!email) return renderResetPassword('Inserisci la tua email.');
      var submit = document.getElementById('igftResetSubmit');
      submit.disabled = true;
      try {
        await firebaseState().auth.sendPasswordResetEmail(email);
        closeModal();
        toast('Email di reimpostazione inviata.', 'success');
      } catch (resetError) {
        submit.disabled = false;
        renderResetPassword(authError(resetError));
      }
    });

    document.getElementById('igftResetEmail').focus();
  }

  /* ============================ ACCOUNT ============================ */

  function openAccount() {
    var status = Store.getStatus();
    if (!status.signedIn) {
      openAuth('login');
      return;
    }
    ui.view = 'account';
    renderAccountPanel('');
  }

  function renderAccountPanel(notice) {
    var status = Store.getStatus();
    if (!status.signedIn) {
      closeModal();
      return;
    }
    var user = status.user;
    var email = user.email || 'Account';
    var provider = (user.providerData && user.providerData[0] && user.providerData[0].providerId) || '';
    var verified = !!user.emailVerified;

    openModal([
      '<h2 class="igft-title" id="igftModalTitle">Il tuo account</h2>',
      notice ? '<div class="igft-alert igft-alert--info">' + escapeHtml(notice) + '</div>' : '',
      '<div class="igft-account-card">',
      '  <span class="igft-avatar igft-avatar--lg" aria-hidden="true">' + escapeHtml(email.charAt(0).toUpperCase()) + '</span>',
      '  <div class="igft-account-card__info">',
      '    <div class="igft-account-card__mail">' + escapeHtml(email) + '</div>',
      '    <div class="igft-muted">' + (provider === 'google.com' ? 'Accesso con Google' : 'Accesso con email e password') + '</div>',
      '  </div>',
      '</div>',
      verified ? '' : [
        '<div class="igft-alert igft-alert--warning">',
        '  <strong>Email non verificata.</strong> Controlla la posta per confermare l\'indirizzo.',
        '  <button type="button" class="igft-link" id="igftResendVerification">Invia di nuovo</button>',
        '</div>'
      ].join(''),
      status.storage === 'local-fallback' ? [
        '<div class="igft-alert igft-alert--warning">',
        '  ' + escapeHtml(status.cloudError || 'Sincronizzazione non disponibile.') ,
        '  <button type="button" class="igft-link" id="igftRetryCloud">Riprova</button>',
        '</div>'
      ].join('') : '',
      '<div class="igft-menu">',
      '  <button type="button" class="igft-menu__item" id="igftOpenAnalyses">',
      '    <span>Le mie analisi</span><span class="igft-badge">' + status.analysesCount + '</span>',
      '  </button>',
      '  <button type="button" class="igft-menu__item" id="igftOpenDeactivated">',
      '    <span>Profili disattivati</span><span class="igft-badge">' + status.deactivatedCount + '</span>',
      '  </button>',
      '</div>',
      '<label class="igft-switch">',
      '  <input type="checkbox" id="igftAutoSave" ' + (status.autoSave ? 'checked' : '') + '>',
      '  <span>Salva automaticamente le analisi ' + (status.storage === 'cloud' ? 'nel tuo account' : 'su questo dispositivo') + '</span>',
      '</label>',
      '<div class="igft-actions igft-actions--split">',
      '  <button type="button" class="btn ghost" id="igftLogoutBtn">Esci</button>',
      '  <button type="button" class="igft-link igft-danger-link" id="igftDeleteAccountBtn">Elimina account e dati</button>',
      '</div>'
    ].join(''));

    var resend = document.getElementById('igftResendVerification');
    if (resend) {
      resend.addEventListener('click', async function () {
        try {
          await user.sendEmailVerification();
          toast('Email di verifica inviata.', 'success');
        } catch (error) {
          toast(authError(error), 'error');
        }
      });
    }

    var retry = document.getElementById('igftRetryCloud');
    if (retry) {
      retry.addEventListener('click', async function () {
        retry.disabled = true;
        var ok = await Store.retryCloud();
        renderAccountPanel(ok ? 'Sincronizzazione ripristinata.' : 'Sincronizzazione ancora non disponibile.');
      });
    }

    document.getElementById('igftOpenAnalyses').addEventListener('click', function () { openLibrary('analyses'); });
    document.getElementById('igftOpenDeactivated').addEventListener('click', function () { openLibrary('deactivated'); });

    document.getElementById('igftAutoSave').addEventListener('change', function (event) {
      Store.setAutoSave(event.target.checked);
      toast(event.target.checked ? 'Salvataggio automatico attivo.' : 'Salvataggio automatico disattivato.', 'info');
    });

    document.getElementById('igftLogoutBtn').addEventListener('click', async function () {
      try {
        await firebaseState().auth.signOut();
        closeModal();
        toast('Sei uscito dal tuo account.', 'info');
      } catch (error) {
        toast(authError(error), 'error');
      }
    });

    document.getElementById('igftDeleteAccountBtn').addEventListener('click', deleteAccount);
  }

  async function deleteAccount() {
    var fb = firebaseState();
    var user = fb && fb.auth ? fb.auth.currentUser : null;
    if (!user) return;

    if (Store.getStatus().storage !== 'cloud') {
      toast('Sincronizzazione non disponibile: riprova la connessione prima di eliminare l\'account, così possiamo cancellare anche i dati sul cloud.', 'error');
      return;
    }

    var usesPassword = (user.providerData || []).some(function (provider) {
      return provider.providerId === 'password';
    });

    var password = await confirmAction({
      title: 'Eliminare account e dati?',
      message: 'Verranno eliminati definitivamente il tuo account, le analisi salvate e l\'elenco dei profili disattivati. L\'operazione non è reversibile.',
      confirmLabel: 'Elimina tutto',
      danger: true,
      requirePassword: usesPassword
    });

    if (password === null) return;

    try {
      if (usesPassword) {
        var credential = fb.emailCredential(user.email, password);
        await user.reauthenticateWithCredential(credential);
      } else if (typeof user.reauthenticateWithPopup === 'function') {
        await user.reauthenticateWithPopup(fb.googleProvider());
      }

      await Store.deleteAllData();
      await user.delete();
      closeModal();
      toast('Account e dati eliminati.', 'success');
    } catch (error) {
      toast(authError(error), 'error');
    }
  }

  /* ============================ LIBRERIA ============================ */

  function openLibrary(tab) {
    ui.view = 'library';
    ui.libraryTab = tab || 'analyses';
    ui.detail = null;
    renderLibrary();
  }

  function libraryHeader() {
    var status = Store.getStatus();
    var isCloud = status.storage === 'cloud';
    return [
      '<h2 class="igft-title" id="igftModalTitle">I tuoi dati</h2>',
      '<div class="igft-tabs" role="tablist">',
      '  <button type="button" role="tab" class="igft-tab ' + (ui.libraryTab === 'analyses' ? 'is-active' : '') + '" data-library-tab="analyses">Analisi (' + status.analysesCount + ')</button>',
      '  <button type="button" role="tab" class="igft-tab ' + (ui.libraryTab === 'deactivated' ? 'is-active' : '') + '" data-library-tab="deactivated">Disattivati (' + status.deactivatedCount + ')</button>',
      '</div>',
      '<div class="igft-storage-note ' + (isCloud ? 'igft-storage-note--cloud' : '') + '">',
      '  <span class="igft-dot" aria-hidden="true"></span>' + escapeHtml(storageLabel()),
      '</div>',
      status.storage === 'local-fallback'
        ? '<div class="igft-alert igft-alert--warning">' + escapeHtml(status.cloudError || 'Sincronizzazione non disponibile.') + '<button type="button" class="igft-link" id="igftLibRetry">Riprova</button></div>'
        : '',
      !status.signedIn
        ? '<div class="igft-alert igft-alert--info">Modalità ospite: i dati sono salvati solo in questo browser. <button type="button" class="igft-link" id="igftLibLogin">Accedi per sincronizzarli</button></div>'
        : ''
    ].join('');
  }

  async function renderLibrary() {
    if (ui.view !== 'library') return;
    if (ui.detail) return renderAnalysisDetail(ui.detail);

    var token = ++libraryRenderToken;
    var content;
    try {
      content = ui.libraryTab === 'deactivated'
        ? await renderDeactivated()
        : await renderAnalyses();
    } catch (error) {
      console.error('[IGFT] errore caricamento libreria', error);
      content = '<div class="igft-alert igft-alert--error">Impossibile caricare i dati. Riprova.</div>';
    }

    if (token !== libraryRenderToken || ui.view !== 'library' || ui.detail) return;

    var freshStatus = Store.getStatus();
    setModalBody([
      libraryHeader(),
      '<div class="igft-library">' + content + '</div>',
      '<div class="igft-actions igft-actions--split">',
      '  <button type="button" class="btn ghost" id="igftCloseLibrary">Chiudi</button>',
      freshStatus.analysesCount > 0
        ? '<button type="button" class="igft-link igft-danger-link" id="igftClearAnalyses">Elimina tutte le analisi</button>'
        : '',
      '</div>'
    ].join(''));

    document.querySelectorAll('[data-library-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        ui.libraryTab = tab.getAttribute('data-library-tab');
        ui.detail = null;
        renderLibrary();
      });
    });

    document.getElementById('igftCloseLibrary').addEventListener('click', closeModal);

    var clearBtn = document.getElementById('igftClearAnalyses');
    if (clearBtn) {
      clearBtn.addEventListener('click', async function () {
        var confirmed = await confirmAction({
          title: 'Eliminare tutte le analisi?',
          message: 'Le analisi salvate verranno rimosse. I profili disattivati restano memorizzati.',
          confirmLabel: 'Elimina analisi',
          danger: true
        });
        if (confirmed === null) return;
        await Store.clearAnalyses();
        toast('Analisi eliminate.', 'success');
        renderLibrary();
      });
    }

    var retry = document.getElementById('igftLibRetry');
    if (retry) {
      retry.addEventListener('click', async function () {
        retry.disabled = true;
        var ok = await Store.retryCloud();
        toast(ok ? 'Sincronizzazione ripristinata.' : 'Sincronizzazione non disponibile.', ok ? 'success' : 'error');
        renderLibrary();
      });
    }

    var login = document.getElementById('igftLibLogin');
    if (login) login.addEventListener('click', function () { window.location.href = 'login.html'; });
  }

  async function renderAnalyses() {
    var analyses = await Store.listAnalyses();
    if (!analyses.length) {
      return [
        '<div class="igft-empty">',
        '  <div class="igft-empty__icon" aria-hidden="true">📊</div>',
        '  <p><strong>Nessuna analisi salvata.</strong></p>',
        '  <p class="igft-muted">Carica un file ZIP: se il salvataggio automatico è attivo l\'analisi comparirà qui.</p>',
        '</div>'
      ].join('');
    }

    return '<div class="igft-list">' + analyses.map(function (item) {
      return [
        '<div class="igft-row">',
        '  <div class="igft-row__main">',
        '    <div class="igft-row__title">' + escapeHtml(Core.formatDateIt(item.createdAt)) + '</div>',
        '    <div class="igft-row__meta">',
        '      ' + item.notFollowingCount + ' non ti seguono · ' + item.followingCount + ' following · ' + item.followersCount + ' followers',
        item.removedDeactivatedCount > 0 ? ' · ' + item.removedDeactivatedCount + ' disattivati rimossi' : '',
        '    </div>',
        '  </div>',
        '  <div class="igft-row__actions">',
        '    <button type="button" class="btn igft-small" data-open-analysis="' + escapeHtml(item.id) + '">Apri</button>',
        '    <button type="button" class="igft-link igft-danger-link" data-delete-analysis="' + escapeHtml(item.id) + '">Elimina</button>',
        '  </div>',
        '</div>'
      ].join('');
    }).join('') + [
      '<div class="igft-list-note">Mostrate le ultime ' + analyses.length + ' analisi.</div>'
    ].join('') + '</div>';
  }

  async function openAnalysis(id) {
    ui.view = 'library';
    ui.libraryTab = 'analyses';
    ui.detail = { id: id, report: null, shown: 0 };
    renderLibrary();
  }

  async function renderAnalysisDetail(detail) {
    var report = detail.report;
    var requestedId = detail.id;
    if (!report) {
      var loading = [
        '<h2 class="igft-title" id="igftModalTitle">Caricamento analisi…</h2>',
        '<div class="igft-empty"><p>Attendi qualche istante.</p></div>',
        '<div class="igft-actions"><button type="button" class="btn ghost" id="igftDetailBack">Indietro</button></div>'
      ].join('');
      setModalBody(loading);
      var backBtn = document.getElementById('igftDetailBack');
      if (backBtn) backBtn.addEventListener('click', function () { ui.detail = null; renderLibrary(); });

      report = await Store.getAnalysis(detail.id);

      // L'utente potrebbe aver chiuso il dettaglio durante il caricamento.
      if (!ui.detail || ui.detail.id !== requestedId) return;

      detail.report = report;
      if (!report) {
        setModalBody([
          '<h2 class="igft-title" id="igftModalTitle">Analisi non disponibile</h2>',
          '<div class="igft-alert igft-alert--error">Impossibile leggere i dati dell\'analisi. Potrebbe essere stata eliminata da un altro dispositivo.</div>',
          '<div class="igft-actions"><button type="button" class="btn ghost" id="igftDetailBack">Indietro</button></div>'
        ].join(''));
        var back = document.getElementById('igftDetailBack');
        if (back) back.addEventListener('click', function () { ui.detail = null; renderLibrary(); });
        return;
      }
      if (ui.view !== 'library') return;
      return renderAnalysisDetail(detail);
    }

    var notFollowing = report.notFollowing || [];
    var total = notFollowing.length;
    var deactivatedInReport = notFollowing.filter(function (username) {
      return Store.isDeactivated(username);
    }).length;
    if (!detail.shown) detail.shown = Math.min(MAX_LIST_ROWS, total);
    var visible = notFollowing.slice(0, detail.shown);

    var rows = visible.map(function (username) {
      return [
        '<li class="igft-profile">',
        '  <span class="igft-profile__avatar" aria-hidden="true">' + escapeHtml(username.charAt(0).toUpperCase()) + '</span>',
        '  <span class="igft-profile__name">@' + escapeHtml(username) + '</span>',
        Store.isDeactivated(username) ? '<span class="res-deactivated-tag">disattivato</span>' : '',
        '  <a class="igft-link" href="https://instagram.com/' + encodeURIComponent(username) + '" target="_blank" rel="noopener noreferrer nofollow">Apri</a>',
        '</li>'
      ].join('');
    }).join('');

    setModalBody([
      '<h2 class="igft-title" id="igftModalTitle">Analisi del ' + escapeHtml(Core.formatDateIt(report.createdAt)) + '</h2>',
      '<div class="igft-stats">',
      '  <div class="igft-stat"><span class="igft-stat__value">' + report.followingCount + '</span><span class="igft-stat__label">Following</span></div>',
      '  <div class="igft-stat"><span class="igft-stat__value">' + report.followersCount + '</span><span class="igft-stat__label">Followers</span></div>',
      '  <div class="igft-stat igft-stat--danger"><span class="igft-stat__value">' + total + '</span><span class="igft-stat__label">Non ti seguono</span></div>',
      '</div>',
      report.removedDeactivatedCount > 0
        ? '<div class="igft-alert igft-alert--info">' + report.removedDeactivatedCount + ' profili disattivati sono stati rimossi da questa analisi.</div>'
        : '',
      deactivatedInReport > 0
        ? '<div class="igft-alert igft-alert--info">' + deactivatedInReport + ' profili di questa analisi sono ora marcati come disattivati: restano nello storico con l\'etichetta dedicata.</div>'
        : '',
      report.truncated
        ? '<div class="igft-alert igft-alert--warning">Report molto grande: è stata salvata solo una parte della lista.</div>'
        : '',
      total === 0
        ? '<div class="igft-empty"><p>Nessun profilo in questa analisi.</p></div>'
        : '<ul class="igft-profile-list">' + rows + '</ul>',
      detail.shown < total
        ? '<button type="button" class="btn ghost" id="igftShowMore">Mostra altri ' + Math.min(MAX_LIST_ROWS, total - detail.shown) + '</button>'
        : '',
      '<div class="igft-actions igft-actions--split">',
      '  <button type="button" class="btn ghost" id="igftDetailBack">Indietro</button>',
      '  <button type="button" class="igft-link igft-danger-link" id="igftDeleteCurrent">Elimina questa analisi</button>',
      '</div>'
    ].join(''));

    document.getElementById('igftDetailBack').addEventListener('click', function () {
      ui.detail = null;
      renderLibrary();
    });

    var showMore = document.getElementById('igftShowMore');
    if (showMore) {
      showMore.addEventListener('click', function () {
        detail.shown = Math.min(total, detail.shown + MAX_LIST_ROWS);
        renderAnalysisDetail(detail);
      });
    }

    document.getElementById('igftDeleteCurrent').addEventListener('click', async function () {
      var confirmed = await confirmAction({
        title: 'Eliminare questa analisi?',
        message: 'L\'analisi verrà rimossa dallo storico.',
        confirmLabel: 'Elimina',
        danger: true
      });
      if (confirmed === null) return;
      await Store.deleteAnalysis(detail.id);
      ui.detail = null;
      toast('Analisi eliminata.', 'success');
      renderLibrary();
    });
  }

  async function renderDeactivated() {
    var list = Store.listDeactivated();
    if (!list.length) {
      return [
        '<div class="igft-empty">',
        '  <div class="igft-empty__icon" aria-hidden="true">🚫</div>',
        '  <p><strong>Nessun profilo disattivato.</strong></p>',
        '  <p class="igft-muted">Dopo un\'analisi puoi marcare un profilo come disattivato: verrà escluso automaticamente dai report successivi.</p>',
        '</div>'
      ].join('');
    }

    return [
      '<div class="igft-alert igft-alert--info">Questi profili vengono rimossi automaticamente dai report delle prossime analisi. Puoi ripristinarli in qualsiasi momento.</div>',
      list.map(function (item) {
        return [
          '<div class="igft-row">',
          '  <div class="igft-row__main">',
          '    <div class="igft-row__title">@' + escapeHtml(item.username) + '</div>',
          '    <div class="igft-row__meta">Marcato il ' + escapeHtml(Core.formatDateIt(item.markedAt)) + '</div>',
          '  </div>',
          '  <button type="button" class="btn ghost igft-small" data-restore="' + escapeHtml(item.username) + '">Ripristina</button>',
          '</div>'
        ].join('');
      }).join('')
    ].join('');
  }

  /* ============================ CONFIRM ============================ */

  function confirmAction(options) {
    return new Promise(function (resolve) {
      var opts = options || {};
      openModal([
        '<h2 class="igft-title" id="igftModalTitle">' + escapeHtml(opts.title || 'Confermi?') + '</h2>',
        '<p class="igft-muted">' + escapeHtml(opts.message || '') + '</p>',
        opts.requirePassword ? [
          '<label class="igft-field">Password',
          '  <input type="password" id="igftConfirmPassword" autocomplete="current-password" required>',
          '</label>'
        ].join('') : '',
        '<div class="igft-actions igft-actions--split">',
        '  <button type="button" class="btn ghost" id="igftConfirmCancel">Annulla</button>',
        '  <button type="button" class="btn ' + (opts.danger ? 'igft-danger' : 'igft-primary') + '" id="igftConfirmOk">' + escapeHtml(opts.confirmLabel || 'Conferma') + '</button>',
        '</div>'
      ].join(''));

      pendingConfirm = resolve;

      function done(value) {
        document.removeEventListener('keydown', onKey);
        if (pendingConfirm === resolve) pendingConfirm = null;
        resolve(value);
      }

      function onKey(event) {
        if (event.key === 'Escape') done(null);
      }

      document.getElementById('igftConfirmCancel').addEventListener('click', function () { done(null); });
      document.getElementById('igftConfirmOk').addEventListener('click', function () {
        if (opts.requirePassword) {
          var input = document.getElementById('igftConfirmPassword');
          var password = input ? input.value : '';
          if (!password) {
            if (input) input.focus();
            return;
          }
          done(password);
        } else {
          done(true);
        }
      });
      document.addEventListener('keydown', onKey);

      var passwordInput = document.getElementById('igftConfirmPassword');
      if (passwordInput) {
        passwordInput.focus();
        passwordInput.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') {
            event.preventDefault();
            document.getElementById('igftConfirmOk').click();
          }
        });
      }
    });
  }

  /* ============================ EVENTI ============================ */

  function bindLibraryActions() {
    document.querySelectorAll('[data-open-analysis]').forEach(function (button) {
      button.addEventListener('click', function () {
        openAnalysis(button.getAttribute('data-open-analysis'));
      });
    });

    document.querySelectorAll('[data-delete-analysis]').forEach(function (button) {
      button.addEventListener('click', async function () {
        var id = button.getAttribute('data-delete-analysis');
        var confirmed = await confirmAction({
          title: 'Eliminare questa analisi?',
          message: 'L\'analisi verrà rimossa dallo storico.',
          confirmLabel: 'Elimina',
          danger: true
        });
        if (confirmed === null) return;
        await Store.deleteAnalysis(id);
        toast('Analisi eliminata.', 'success');
        renderLibrary();
      });
    });

    document.querySelectorAll('[data-restore]').forEach(function (button) {
      button.addEventListener('click', async function () {
        var username = button.getAttribute('data-restore');
        var result = await Store.unmarkDeactivated(username);
        toast(result && result.synced === false
          ? 'Profilo ripristinato localmente. Sincronizzazione non disponibile.'
          : '@' + username + ' ripristinato.', 'success');
        renderLibrary();
      });
    });
  }

  function boot() {
    if (!Store) {
      console.warn('[IGFT] store non disponibile: interfaccia account disattivata');
      return;
    }

    var header = document.querySelector('.panel > header');
    if (header && !document.getElementById('igftAccount')) {
      var area = document.createElement('div');
      area.id = 'igftAccount';
      area.className = 'igft-account';
      header.appendChild(area);
    }

    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      if (target.closest('[data-igft-open-auth]')) {
        event.preventDefault();
        openAuth('login');
        return;
      }

      if (target.closest('[data-igft-open-account]')) {
        event.preventDefault();
        openAccount();
      }
    });

    Store.onChange(function () {
      var status = Store.getStatus();
      if (status.signedIn && ui.view === 'auth') closeModal();
      renderAccountArea();
      if (ui.view === 'library' && !ui.detail) renderLibrary();
      if (ui.view === 'account') renderAccountPanel('');
    });

    renderAccountArea();
  }

  document.addEventListener('DOMContentLoaded', boot);

  window.IGFTUI = {
    openAuth: openAuth,
    openAccount: openAccount,
    openLibrary: openLibrary,
    openAnalysis: openAnalysis,
    toast: toast,
    closeModal: closeModal
  };
})();
