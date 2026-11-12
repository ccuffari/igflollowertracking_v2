/*
 * Crittografia lato client (zero-knowledge).
 *
 * Tutti i dati sensibili (username delle analisi e profili disattivati) vengono
 * cifrati nel browser prima di essere scritti su Firestore. Il server vede solo
 * testo cifrato: non possiede la chiave e non puo' decifrare nulla.
 *
 * Schema (envelope encryption):
 *   - DEK: chiave AES-GCM 256 casuale, unica per utente.
 *   - KEK: derivata dalla "frase di sicurezza" scelta dall'utente con
 *     PBKDF2-SHA256 (iterazioni elevate, salt casuale).
 *   - La DEK viene "avvolta" (wrapped) con la KEK e il record risultante
 *     (salt, IV, chiave avvolta) resta in users/{uid}.keyVault.
 *   - Ogni valore cifrato usa un IV casuale di 12 byte: AES-GCM non riusa mai
 *     lo stesso IV.
 *   - Gli ID dei documenti dei profili disattivati sono HMAC-SHA256 della
 *     username con una chiave derivata dalla DEK: opachi e deterministici,
 *     così il server non vede le username ma il client può deduplicare.
 *
 * La frase di sicurezza non viene mai inviata al server ne' salvata in chiaro.
 * Se viene persa i dati cifrati non sono recuperabili da nessuno, incluso il
 * gestore della piattaforma.
 */
(function () {
  'use strict';

  var subtle = (typeof crypto !== 'undefined' && crypto && crypto.subtle) ? crypto.subtle : null;
  var PBKDF2_ITERATIONS = 310000;
  var SALT_BYTES = 16;
  var IV_BYTES = 12;

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function supported() {
    return !!subtle &&
      typeof TextEncoder !== 'undefined' &&
      typeof TextDecoder !== 'undefined' &&
      typeof crypto.getRandomValues === 'function';
  }

  function requireCrypto() {
    if (!supported()) {
      var error = new Error('Crittografia non disponibile in questo browser (contesto non sicuro).');
      error.code = 'igft/crypto-unavailable';
      throw error;
    }
    return subtle;
  }

  function utf8(value) {
    return new TextEncoder().encode(String(value));
  }

  function fromUtf8(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function randomBytes(length) {
    var out = new Uint8Array(length);
    crypto.getRandomValues(out);
    return out;
  }

  function toBase64(bytes) {
    var source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var output = '';
    for (var i = 0; i < source.length; i += 3) {
      var b0 = source[i];
      var b1 = i + 1 < source.length ? source[i + 1] : 0;
      var b2 = i + 2 < source.length ? source[i + 2] : 0;
      var triplet = (b0 << 16) | (b1 << 8) | b2;
      output += B64[(triplet >> 18) & 63];
      output += B64[(triplet >> 12) & 63];
      output += i + 1 < source.length ? B64[(triplet >> 6) & 63] : '=';
      output += i + 2 < source.length ? B64[triplet & 63] : '=';
    }
    return output;
  }

  function fromBase64(value) {
    var clean = String(value || '').replace(/[^A-Za-z0-9+/]/g, '');
    var output = [];
    var buffer = 0;
    var bits = 0;
    for (var i = 0; i < clean.length; i++) {
      var index = B64.indexOf(clean.charAt(i));
      if (index < 0) continue;
      buffer = (buffer << 6) | index;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        output.push((buffer >> bits) & 0xff);
      }
    }
    return new Uint8Array(output);
  }

  function toHex(bytes) {
    var output = '';
    for (var i = 0; i < bytes.length; i++) {
      output += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return output;
  }

  async function deriveKek(passphrase, salt, iterations) {
    var webcrypto = requireCrypto();
    var material = await webcrypto.importKey(
      'raw',
      utf8(String(passphrase).normalize('NFKC')),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return webcrypto.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function generateDek() {
    var webcrypto = requireCrypto();
    return webcrypto.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  async function wrapDek(dek, passphrase) {
    var webcrypto = requireCrypto();
    var salt = randomBytes(SALT_BYTES);
    var kek = await deriveKek(passphrase, salt, PBKDF2_ITERATIONS);
    var raw = new Uint8Array(await webcrypto.exportKey('raw', dek));
    var iv = randomBytes(IV_BYTES);
    var wrapped = new Uint8Array(await webcrypto.encrypt({ name: 'AES-GCM', iv: iv }, kek, raw));
    return {
      v: 1,
      kdf: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      salt: toBase64(salt),
      iv: toBase64(iv),
      wrappedKey: toBase64(wrapped)
    };
  }

  // Crea una nuova DEK e il record da salvare nel profilo utente.
  async function createVault(passphrase) {
    var dek = await generateDek();
    var record = await wrapDek(dek, passphrase);
    return { dek: dek, record: record };
  }

  // Riporta una DEK esistente sotto una nuova frase di sicurezza.
  async function rewrapVault(dek, passphrase) {
    return wrapDek(dek, passphrase);
  }

  async function unwrapVault(record, passphrase) {
    var webcrypto = requireCrypto();
    if (!record || !record.wrappedKey || !record.salt || !record.iv) {
      throw new Error('Record di cifratura non valido.');
    }
    var iterations = Number(record.iterations) || PBKDF2_ITERATIONS;
    var kek = await deriveKek(passphrase, fromBase64(record.salt), iterations);
    var raw = await webcrypto.decrypt(
      { name: 'AES-GCM', iv: fromBase64(record.iv) },
      kek,
      fromBase64(record.wrappedKey)
    );
    return webcrypto.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }

  async function encryptText(dek, text) {
    var webcrypto = requireCrypto();
    var iv = randomBytes(IV_BYTES);
    var ciphertext = new Uint8Array(
      await webcrypto.encrypt({ name: 'AES-GCM', iv: iv }, dek, utf8(text))
    );
    return toBase64(iv) + '.' + toBase64(ciphertext);
  }

  async function decryptText(dek, payload) {
    var webcrypto = requireCrypto();
    var parts = String(payload || '').split('.');
    if (parts.length !== 2) throw new Error('Payload cifrato non valido.');
    var plaintext = await webcrypto.decrypt(
      { name: 'AES-GCM', iv: fromBase64(parts[0]) },
      dek,
      fromBase64(parts[1])
    );
    return fromUtf8(plaintext);
  }

  async function encryptJson(dek, value) {
    return encryptText(dek, JSON.stringify(value));
  }

  async function decryptJson(dek, payload) {
    return JSON.parse(await decryptText(dek, payload));
  }

  async function deriveDedupeKey(dek) {
    var webcrypto = requireCrypto();
    var raw = await webcrypto.exportKey('raw', dek);
    var material = await webcrypto.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return webcrypto.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: utf8('igft-e2ee-v1'),
        info: utf8('deactivated-doc-id')
      },
      material,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign']
    );
  }

  // ID opaco e deterministico per un profilo disattivato: il server non può
  // risalire alla username, ma due marcature della stessa username coincidono.
  async function dedupeId(dedupeKey, username) {
    var webcrypto = requireCrypto();
    var signature = await webcrypto.sign('HMAC', dedupeKey, utf8(String(username)));
    return toHex(new Uint8Array(signature));
  }

  function randomPassphrase() {
    requireCrypto();
    var groups = 5;
    var size = 5;
    var output = [];
    for (var g = 0; g < groups; g++) {
      var random = randomBytes(size);
      var group = '';
      for (var i = 0; i < size; i++) {
        group += B32[random[i] % B32.length];
      }
      output.push(group);
    }
    return output.join('-');
  }

  function passphraseStrength(passphrase) {
    var value = String(passphrase || '');
    if (value.length < 12) return 'weak';
    var classes = 0;
    if (/[a-z]/.test(value)) classes++;
    if (/[A-Z]/.test(value) && /[a-z]/.test(value)) classes++;
    if (/[0-9]/.test(value)) classes++;
    if (/[^A-Za-z0-9]/.test(value)) classes++;
    if (value.length >= 20 || classes >= 3) return 'strong';
    return 'medium';
  }

  window.IGFTCrypto = {
    PBKDF2_ITERATIONS: PBKDF2_ITERATIONS,
    isSupported: supported,
    createVault: createVault,
    rewrapVault: rewrapVault,
    unwrapVault: unwrapVault,
    encryptText: encryptText,
    decryptText: decryptText,
    encryptJson: encryptJson,
    decryptJson: decryptJson,
    deriveDedupeKey: deriveDedupeKey,
    dedupeId: dedupeId,
    randomPassphrase: randomPassphrase,
    passphraseStrength: passphraseStrength
  };
})();
