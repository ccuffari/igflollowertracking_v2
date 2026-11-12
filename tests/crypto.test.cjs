'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const CRYPTO = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts', 'lib', 'crypto.js'), 'utf8');

function createCrypto() {
  const context = {
    console,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    JSON,
    Math,
    String,
    Number,
    Object,
    Array,
    Promise,
    Error
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(CRYPTO, context);
  return context.IGFTCrypto;
}

const PASSPHRASE = 'frase-di-sicurezza-robusta-123';

test('cifratura: roundtrip AES-GCM di testo e JSON', async () => {
  const Crypto = createCrypto();
  const { dek } = await Crypto.createVault(PASSPHRASE);

  const payload = await Crypto.encryptJson(dek, { usernames: ['alice', 'bob'], n: 2 });
  assert.ok(!payload.includes('alice'), 'il payload non deve contenere il testo in chiaro');

  const decoded = await Crypto.decryptJson(dek, payload);
  assert.deepEqual(Array.from(decoded.usernames), ['alice', 'bob']);
  assert.equal(decoded.n, 2);
});

test('cifratura: ogni valore usa un IV diverso', async () => {
  const Crypto = createCrypto();
  const { dek } = await Crypto.createVault(PASSPHRASE);
  const first = await Crypto.encryptText(dek, 'identico');
  const second = await Crypto.encryptText(dek, 'identico');
  assert.notEqual(first, second);
  assert.equal(await Crypto.decryptText(dek, first), 'identico');
  assert.equal(await Crypto.decryptText(dek, second), 'identico');
});

test('cifratura: la frase giusta sblocca, quella sbagliata no', async () => {
  const Crypto = createCrypto();
  const { dek, record } = await Crypto.createVault(PASSPHRASE);
  const ciphertext = await Crypto.encryptText(dek, 'dato segreto');

  const unlocked = await Crypto.unwrapVault(record, PASSPHRASE);
  assert.equal(await Crypto.decryptText(unlocked, ciphertext), 'dato segreto');

  await assert.rejects(() => Crypto.unwrapVault(record, 'frase-sbagliata-999'));
});

test('cifratura: record salvabile senza chiave in chiaro', async () => {
  const Crypto = createCrypto();
  const { record } = await Crypto.createVault(PASSPHRASE);
  const serialized = JSON.stringify(record);
  assert.deepEqual(
    Object.keys(record).sort(),
    ['iterations', 'iv', 'kdf', 'salt', 'v', 'wrappedKey'].sort()
  );
  assert.ok(!serialized.includes(PASSPHRASE));
  assert.ok(record.iterations >= 100000);
});

test('cifratura: la password di accesso è la chiave predefinita', async () => {
  const Crypto = createCrypto();
  const password = 'Password-di-accesso-2026!';
  const { dek, record } = await Crypto.createVault(password);
  const ciphertext = await Crypto.encryptText(dek, 'storico utente');

  assert.ok(!JSON.stringify(record).includes(password));
  assert.equal(await Crypto.decryptText(await Crypto.unwrapVault(record, password), ciphertext), 'storico utente');
  await assert.rejects(() => Crypto.unwrapVault(record, 'Password-sbagliata-2026!'));
});

test('cifratura: cambio frase mantiene leggibili i dati esistenti', async () => {
  const Crypto = createCrypto();
  const vault = await Crypto.createVault(PASSPHRASE);
  const ciphertext = await Crypto.encryptText(vault.dek, 'storico');
  const nextRecord = await Crypto.rewrapVault(vault.dek, 'nuova-frase-sicurezza-456');

  await assert.rejects(() => Crypto.unwrapVault(nextRecord, PASSPHRASE));
  const reopened = await Crypto.unwrapVault(nextRecord, 'nuova-frase-sicurezza-456');
  assert.equal(await Crypto.decryptText(reopened, ciphertext), 'storico');
});

test('ID disattivati: opachi, deterministici e legati alla chiave', async () => {
  const Crypto = createCrypto();
  const first = await Crypto.createVault(PASSPHRASE);
  const second = await Crypto.createVault(PASSPHRASE);
  const keyA = await Crypto.deriveDedupeKey(first.dek);
  const keyB = await Crypto.deriveDedupeKey(second.dek);

  const idA1 = await Crypto.dedupeId(keyA, 'ghost');
  const idA2 = await Crypto.dedupeId(keyA, 'ghost');
  const idB = await Crypto.dedupeId(keyB, 'ghost');
  const idOther = await Crypto.dedupeId(keyA, 'altro');

  assert.equal(idA1, idA2);
  assert.notEqual(idA1, idB);
  assert.notEqual(idA1, idOther);
  assert.match(idA1, /^[0-9a-f]{64}$/);
  assert.ok(!idA1.includes('ghost'));
});

test('frasi suggerite e robustezza', async () => {
  const Crypto = createCrypto();
  const phrase = Crypto.randomPassphrase();
  assert.match(phrase, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){4}$/);
  assert.equal(Crypto.passphraseStrength('corta'), 'weak');
  assert.equal(Crypto.passphraseStrength('frase-lunga-e-complessa-123'), 'strong');
});
