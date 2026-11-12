'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts', 'lib', 'analysis-core.js'), 'utf8');
const CRYPTO = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts', 'lib', 'crypto.js'), 'utf8');
const VAULT = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts', 'lib', 'vault.js'), 'utf8');
const STORE = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts', 'store.js'), 'utf8');

const PASSPHRASE = 'frase-di-sicurezza-di-test-123';

function createStore(firebase, options) {
  const opts = options || {};
  const timers = opts.fastTimers
    ? (fn, ms) => setTimeout(fn, Math.min(ms, 25))
    : setTimeout;
  const memory = new Map(Object.entries(opts.seed || {}));
  const localStorage = {
    getItem(key) { return memory.has(key) ? memory.get(key) : null; },
    setItem(key, value) { memory.set(key, String(value)); },
    removeItem(key) { memory.delete(key); }
  };
  const context = {
    console: opts.consoleImpl || console,
    localStorage,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Promise,
    setTimeout: timers,
    clearTimeout
  };
  context.window = context;
  if (firebase) context.IGFTFirebase = firebase;
  vm.createContext(context);
  vm.runInContext(CORE, context);
  vm.runInContext(CRYPTO, context);
  vm.runInContext(VAULT, context);
  vm.runInContext(STORE, context);
  return { store: context.IGFTStore, memory, context };
}

// Attiva la cifratura sull'account di test e attende il primo sync.
async function activateVault(store, context) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await store.setupVault(PASSPHRASE);
  assert.equal(result.ok, true, result.error || 'attivazione cifratura fallita');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.retryCloud();
}

async function decrypt(store, context, payload) {
  return context.IGFTCrypto.decryptJson(context.IGFTVault.getKeys().dek, payload);
}


const report = {
  followingCount: 120,
  followersCount: 100,
  notFollowing: ['alice', 'bob', 'carol'],
  removedDeactivatedCount: 2
};

test('saveAnalysis salva subito lo storico in locale', async () => {
  const { store, memory } = createStore();
  await store.ready;

  const saved = await store.saveAnalysis(report);
  assert.equal(saved.storage, 'local');
  assert.ok(memory.has('igft.analyses.v1'));

  const list = await store.listAnalyses();
  assert.equal(list.length, 1);
  assert.equal(list[0].notFollowingCount, 3);

  const detail = await store.getAnalysis(saved.id);
  assert.deepEqual(Array.from(detail.notFollowing), ['alice', 'bob', 'carol']);
});

test('saveAnalysis resta locale se Firestore non è raggiungibile', async () => {
  const failingDb = {
    collection() {
      return {
        doc() {
          return {
            collection() {
              return {
                get() {
                  return Promise.reject(Object.assign(new Error('offline'), { code: 'unavailable' }));
                }
              };
            }
          };
        }
      };
    }
  };
  const firebase = {
    ready: Promise.resolve(),
    available: true,
    db: failingDb,
    auth: {
      onAuthStateChanged(callback) {
        callback({ uid: 'user-1', email: 'test@example.com' });
      }
    },
    serverTimestamp() { return new Date(); }
  };

  const { store } = createStore(firebase);
  await store.ready;
  await new Promise((resolve) => setTimeout(resolve, 50));

  const status = store.getStatus();
  assert.equal(status.storage, 'local-fallback');

  const saved = await store.saveAnalysis(report);
  assert.ok(saved);
  assert.ok(saved.storage === 'local' || saved.storage === 'local-fallback');

  const list = await store.listAnalyses();
  assert.equal(list.length, 1);
});

test('senza frase di sicurezza il profilo resta cloud e i dati sensibili non vengono toccati', async () => {
  let sensitiveRead = false;

  const analysesQuery = {
    orderBy() { return analysesQuery; },
    limit() { return analysesQuery; },
    get() { sensitiveRead = true; return Promise.resolve({ docs: [] }); }
  };
  const deactivatedQuery = {
    orderBy() { return deactivatedQuery; },
    limit() { return deactivatedQuery; },
    startAfter() { return deactivatedQuery; },
    get() { sensitiveRead = true; return Promise.resolve({ docs: [] }); }
  };
  const userDoc = {
    get() { return Promise.resolve({ exists: false, data: () => ({}) }); },
    set() { return Promise.resolve(); },
    collection(name) {
      return name === 'analyses' ? analysesQuery : deactivatedQuery;
    }
  };
  const firebase = {
    ready: Promise.resolve(),
    available: true,
    db: {
      collection() { return { doc() { return userDoc; } }; },
      batch() {
        return {
          set() {},
          delete() {},
          commit() { return Promise.resolve(); }
        };
      }
    },
    auth: {
      onAuthStateChanged(callback) {
        callback({ uid: 'user-1', email: 'test@example.com' });
      }
    },
    serverTimestamp() { return new Date(); }
  };

  const { store } = createStore(firebase);
  await store.ready;
  await new Promise((resolve) => setTimeout(resolve, 30));

  const status = store.getStatus();
  assert.equal(status.storage, 'cloud');
  assert.equal(status.cloudError, null);
  assert.equal(status.vaultState, 'absent');
  assert.equal(sensitiveRead, false, 'senza chiave non si leggono né scrivono dati sensibili');
});


test('logout e login conservano storico e disattivati quando Firestore non è disponibile', async () => {
  const reject = () => Promise.reject(Object.assign(new Error('offline'), { code: 'unavailable' }));
  function makeQuery() {
    return {
      orderBy() { return this; },
      limit() { return this; },
      startAfter() { return this; },
      get: reject,
      doc() { return makeRef(); }
    };
  }
  function makeRef() {
    return {
      id: 'cloud-doc',
      collection() { return makeQuery(); },
      set: reject,
      delete: reject,
      get: reject
    };
  }
  const firebase = {
    ready: Promise.resolve(),
    available: true,
    db: {
      collection() { return { doc() { return makeRef(); } }; },
      batch() { return { set() {}, delete() {}, commit: reject }; }
    },
    auth: {
      onAuthStateChanged(callback) { firebase.auth.callback = callback; }
    },
    serverTimestamp() { return new Date(); }
  };

  const { store } = createStore(firebase, { fastTimers: true });
  await store.ready;

  await store.markDeactivated('ghost');
  await store.saveAnalysis(report);

  firebase.auth.callback({ uid: 'user-1', email: 'test@example.com' });
  await new Promise((resolve) => setTimeout(resolve, 40));

  await store.markDeactivated('solo_account');
  await store.saveAnalysis(report);

  firebase.auth.callback(null);
  await new Promise((resolve) => setTimeout(resolve, 10));

  firebase.auth.callback({ uid: 'user-1', email: 'test@example.com' });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const analyses = await store.listAnalyses();
  assert.equal(analyses.length, 2);

  const deactivated = new Set(store.listDeactivated().map((item) => item.username));
  assert.ok(deactivated.has('ghost'));
  assert.ok(deactivated.has('solo_account'));
});

test('i timeout cloud restano informativi e non degradano la sessione', async () => {
  const logs = { info: [], warn: [], error: [] };
  const hangingQuery = {
    orderBy() { return hangingQuery; },
    limit() { return hangingQuery; },
    startAfter() { return hangingQuery; },
    get() { return new Promise(() => {}); }
  };
  const userDoc = {
    get() { return new Promise(() => {}); },
    collection() { return hangingQuery; },
    set() { return new Promise(() => {}); }
  };
  const firebase = {
    ready: Promise.resolve(),
    available: true,
    db: {
      collection() { return { doc() { return userDoc; } }; },
      batch() {
        return {
          set() {},
          delete() {},
          commit() { return new Promise(() => {}); }
        };
      }
    },
    auth: {
      onAuthStateChanged(callback) {
        callback({ uid: 'user-1', email: 'test@example.com' });
      }
    },
    serverTimestamp() { return new Date(); }
  };

  const { store } = createStore(firebase, {
    fastTimers: true,
    consoleImpl: {
      info(message) { logs.info.push(String(message)); },
      warn(message) { logs.warn.push(String(message)); },
      error(message) { logs.error.push(String(message)); }
    }
  });

  await store.ready;
  await new Promise((resolve) => setTimeout(resolve, 120));

  const status = store.getStatus();
  assert.equal(status.storage, 'cloud');
  assert.equal(status.cloudError, null);
  assert.equal(logs.warn.length, 0);
  assert.equal(logs.error.length, 0);
  assert.ok(logs.info.some((message) => message.includes('sincronizzazione Firestore in background')));
});

function timeOf(value) {
  if (value && typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

function createFakeFirestore(options) {
  const opts = options || {};
  const collections = new Map();
  const state = { failWrites: !!opts.failWrites, failReads: !!opts.failReads };
  let autoId = 0;

  function unavailable() {
    return Object.assign(new Error('offline'), { code: 'unavailable' });
  }

  function bucket(path) {
    const key = path.join('/');
    if (!collections.has(key)) collections.set(key, new Map());
    return collections.get(key);
  }

  function docRef(path) {
    const id = path[path.length - 1];
    const parent = path.slice(0, -1);
    return {
      id,
      path,
      get() {
        if (state.failReads) return Promise.reject(unavailable());
        const data = bucket(parent).get(id);
        return Promise.resolve({ id, exists: typeof data !== 'undefined', data: () => data });
      },
      set(value, config) {
        if (state.failWrites) return Promise.reject(unavailable());
        const map = bucket(parent);
        const merged = config && config.merge && map.has(id)
          ? Object.assign({}, map.get(id), value)
          : value;
        map.set(id, merged);
        return Promise.resolve();
      },
      delete() {
        if (state.failWrites) return Promise.reject(unavailable());
        bucket(parent).delete(id);
        return Promise.resolve();
      },
      collection(name) {
        return collectionRef(path.concat(name));
      }
    };
  }

  function queryRef(path, field, direction) {
    const query = {
      field,
      direction,
      max: Infinity,
      afterId: null,
      limit(n) { query.max = n; return query; },
      startAfter(doc) { query.afterId = doc && doc.id; return query; },
      orderBy(nextField, nextDirection) {
        query.field = nextField;
        query.direction = nextDirection;
        return query;
      },
      get() {
        if (state.failReads) return Promise.reject(unavailable());
        let docs = Array.from(bucket(path).entries()).map(([id, data]) => ({
          id,
          data: () => data
        }));
        if (query.field === '__name__') {
          docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          if (query.direction === 'desc') docs.reverse();
        } else {
          docs.sort((a, b) => timeOf(a.data()[query.field]) - timeOf(b.data()[query.field]));
          if (query.direction === 'desc') docs.reverse();
        }
        if (query.afterId) {
          const index = docs.findIndex((doc) => doc.id === query.afterId);
          if (index >= 0) docs = docs.slice(index + 1);
        }
        return Promise.resolve({ docs: docs.slice(0, query.max) });
      }
    };
    return query;
  }

  function collectionRef(path) {
    return {
      doc(id) { return docRef(path.concat(id || ('auto-' + (++autoId)))); },
      get() {
        if (state.failReads) return Promise.reject(unavailable());
        const docs = Array.from(bucket(path).entries()).map(([id, data]) => ({
          id,
          data: () => data,
          ref: docRef(path.concat(id))
        }));
        return Promise.resolve({ docs });
      },
      orderBy(field, direction) { return queryRef(path, field, direction); }
    };
  }

  const db = {
    collection(name) { return collectionRef([name]); },
    batch() {
      const operations = [];
      return {
        set(ref, value) { operations.push({ type: 'set', ref, value }); },
        delete(ref) { operations.push({ type: 'delete', ref }); },
        commit() {
          if (state.failWrites) return Promise.reject(unavailable());
          operations.forEach((operation) => {
            if (operation.type === 'set') operation.ref.set(operation.value);
            else operation.ref.delete();
          });
          return Promise.resolve();
        }
      };
    }
  };

  return {
    db,
    state,
    collections,
    seed(path, id, data) { bucket(path).set(id, data); }
  };
}

function fakeFirebase(fake) {
  return {
    ready: Promise.resolve(),
    available: true,
    db: fake.db,
    auth: {
      onAuthStateChanged(callback) {
        callback({ uid: 'user-1', email: 'tester@example.com', displayName: 'Tester' });
      }
    },
    serverTimestamp() { return new Date(); }
  };
}

const CLOUD_SEED = {
  'igft.migrated.user-1': '1',
  'igft.deactivatedMigrated.user-1': '1'
};

const PASSWORD_USER = {
  uid: 'user-1',
  email: 'tester@example.com',
  displayName: 'Tester',
  providerData: [{ providerId: 'password' }]
};

function passwordFirebase(fake) {
  return {
    ready: Promise.resolve(),
    available: true,
    db: fake.db,
    auth: {
      currentUser: PASSWORD_USER,
      onAuthStateChanged(callback) { callback(PASSWORD_USER); }
    },
    serverTimestamp() { return new Date(); }
  };
}

test('la password dell\'account crea e sblocca la cassaforte senza frase aggiuntiva', async () => {
  const fake = createFakeFirestore();
  const firebase = passwordFirebase(fake);

  const first = createStore(firebase, { seed: CLOUD_SEED });
  await first.store.ready;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(first.store.getStatus().vaultSecretKind, 'password');

  const created = await first.store.provideVaultSecret('Password-utente-2026!', { createIfMissing: true });
  assert.equal(created.ok, true, created.error || 'creazione cassaforte fallita');
  assert.equal(first.store.getStatus().vaultState, 'unlocked');

  const profile = fake.collections.get('users').get('user-1');
  assert.ok(profile && profile.keyVault, 'il record keyVault deve essere salvato nel profilo');
  assert.ok(!JSON.stringify(profile.keyVault).includes('Password-utente-2026!'));

  // Nuovo dispositivo: stessa password, cassaforte sbloccata.
  const second = createStore(firebase, { seed: CLOUD_SEED });
  await second.store.ready;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const unlocked = await second.store.provideVaultSecret('Password-utente-2026!', { createIfMissing: true });
  assert.equal(unlocked.ok, true, unlocked.error || 'sblocco con password fallito');
  assert.equal(second.store.getStatus().vaultState, 'unlocked');

  // Password errata: non deve creare una nuova cassaforte né sovrascrivere quella esistente.
  const third = createStore(firebase, { seed: CLOUD_SEED });
  await third.store.ready;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const wrong = await third.store.provideVaultSecret('Password-sbagliata-2026!', { createIfMissing: true });
  assert.equal(wrong.ok, false);
  assert.equal(third.store.getStatus().vaultState, 'locked');
  assert.ok(fake.collections.get('users').get('user-1').keyVault, 'la cassaforte esistente non va sovrascritta');
});

test('Firestore è la fonte di verità per storico e disattivati', async () => {
  const fake = createFakeFirestore();
  fake.seed(['users', 'user-1', 'analyses'], 'a1', {
    createdAt: new Date(),
    followingCount: 10,
    followersCount: 9,
    notFollowingCount: 1,
    removedDeactivatedCount: 0,
    truncated: false,
    chunkCount: 1
  });
  fake.seed(['users', 'user-1', 'analyses', 'a1', 'items'], 'chunk-000', { usernames: ['alice'] });
  fake.seed(['users', 'user-1', 'deactivated'], 'ghost', {
    username: 'ghost',
    markedAt: new Date()
  });

  const seed = Object.assign({}, CLOUD_SEED, {
    'igft.u.user-1.analyses.v1': JSON.stringify([{
      id: 'stale',
      createdAt: new Date().toISOString(),
      notFollowingCount: 99,
      storage: 'local'
    }]),
    'igft.u.user-1.analysis.stale': JSON.stringify({
      id: 'stale',
      createdAt: new Date().toISOString(),
      notFollowingCount: 99,
      notFollowing: ['stale']
    }),
    'igft.u.user-1.deactivated.v1': JSON.stringify([{
      username: 'old',
      markedAt: new Date().toISOString()
    }])
  });

  const { store, context } = createStore(fakeFirebase(fake), { seed });
  await store.ready;
  await activateVault(store, context);

  const analyses = await store.listAnalyses();
  assert.equal(store.getStatus().storage, 'cloud');
  assert.equal(store.getStatus().vaultState, 'unlocked');
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0].id, 'a1');

  const deactivated = store.listDeactivated().map((item) => item.username);
  assert.deepEqual(deactivated, ['ghost']);

  // I documenti legacy in chiaro sono stati migrati: nessuna username visibile.
  const deactivatedBucket = fake.collections.get('users/user-1/deactivated');
  assert.ok(!deactivatedBucket.has('ghost'));
  assert.ok(Array.from(deactivatedBucket.values()).every((doc) => typeof doc.enc === 'string'));
  assert.ok(!JSON.stringify(Array.from(deactivatedBucket.entries())).includes('ghost'));

  const analysisDoc = fake.collections.get('users/user-1/analyses').get('a1');
  assert.equal(typeof analysisDoc.enc, 'string');
  assert.equal(analysisDoc.notFollowingCount, undefined);
  const chunk = fake.collections.get('users/user-1/analyses/a1/items').get('chunk-000');
  assert.equal(typeof chunk.enc, 'string');
  assert.ok(!JSON.stringify(chunk).includes('alice'));
  const decodedChunk = await decrypt(store, context, chunk.enc);
  assert.deepEqual(Array.from(decodedChunk), ['alice']);
});

test('saveAnalysis scrive analisi e username su Firestore in forma cifrata', async () => {
  const fake = createFakeFirestore();
  const { store, context } = createStore(fakeFirebase(fake), { seed: CLOUD_SEED });
  await store.ready;
  await activateVault(store, context);

  const saved = await store.saveAnalysis(report);
  assert.equal(saved.storage, 'cloud');

  const analyses = fake.collections.get('users/user-1/analyses');
  assert.ok(analyses && analyses.has(saved.id));
  assert.equal(typeof analyses.get(saved.id).enc, 'string');

  const summary = await decrypt(store, context, analyses.get(saved.id).enc);
  assert.equal(summary.notFollowingCount, 3);

  const items = fake.collections.get('users/user-1/analyses/' + saved.id + '/items');
  const chunk = items.get('chunk-000');
  assert.equal(typeof chunk.enc, 'string');
  assert.deepEqual(Array.from(await decrypt(store, context, chunk.enc)), ['alice', 'bob', 'carol']);

  const serialized = JSON.stringify([
    Array.from(analyses.entries()),
    Array.from(items.entries())
  ]);
  assert.ok(!serialized.includes('alice'));
  assert.ok(!serialized.includes('bob'));
});

test('i profili disattivati sono cifrati con ID opaco e riletti al retry', async () => {
  const fake = createFakeFirestore();
  const { store, context } = createStore(fakeFirebase(fake), { seed: CLOUD_SEED });
  await store.ready;
  await activateVault(store, context);

  await store.markDeactivated('ghost');

  var bucket = fake.collections.get('users/user-1/deactivated');
  assert.ok(!bucket.has('ghost'), 'la username non deve essere usata come ID');
  var encrypted = Array.from(bucket.entries()).find(([, doc]) => typeof doc.enc === 'string');
  assert.ok(encrypted);
  var decoded = await decrypt(store, context, encrypted[1].enc);
  assert.equal(decoded.username, 'ghost');

  // Dato legacy in chiaro: viene letto e migrato al retry.
  fake.seed(['users', 'user-1', 'deactivated'], 'remote', {
    username: 'remote',
    markedAt: new Date()
  });

  await store.retryCloud();
  const names = store.listDeactivated().map((item) => item.username).sort();
  assert.deepEqual(names, ['ghost', 'remote']);

  bucket = fake.collections.get('users/user-1/deactivated');
  assert.ok(!bucket.has('remote'));
  assert.ok(Array.from(bucket.values()).every((doc) => typeof doc.enc === 'string'));
});

test('le analisi salvate offline vengono inviate a Firestore cifrate al retry', async () => {
  const fake = createFakeFirestore();
  const { store, context } = createStore(fakeFirebase(fake), { seed: CLOUD_SEED });
  await store.ready;
  await activateVault(store, context);

  fake.state.failWrites = true;
  const saved = await store.saveAnalysis(report);
  assert.notEqual(saved.storage, 'cloud');
  assert.equal(store.getStatus().analysesCount, 1);

  fake.state.failWrites = false;
  await store.retryCloud();

  const analyses = fake.collections.get('users/user-1/analyses');
  assert.ok(analyses && analyses.has(saved.id));
  assert.equal(typeof analyses.get(saved.id).enc, 'string');
  const list = await store.listAnalyses();
  assert.equal(list.length, 1);
  assert.equal(list[0].storage, 'cloud');
});

test('senza cifratura attiva non viene scritto nessun dato sensibile in chiaro', async () => {
  const fake = createFakeFirestore();
  const { store } = createStore(fakeFirebase(fake), { seed: CLOUD_SEED });
  await store.ready;
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(store.getStatus().vaultState, 'absent');

  const saved = await store.saveAnalysis(report);
  assert.equal(saved.storage, 'local');
  await store.markDeactivated('ghost');

  const analyses = fake.collections.get('users/user-1/analyses');
  assert.ok(!analyses || analyses.size === 0, 'nessuna analisi scritta senza chiave');

  const deactivated = fake.collections.get('users/user-1/deactivated');
  assert.ok(!deactivated || deactivated.size === 0, 'nessun disattivato scritto senza chiave');

  // I dati restano comunque disponibili sul dispositivo.
  const list = await store.listAnalyses();
  assert.equal(list.length, 1);
  assert.ok(store.listDeactivated().some((item) => item.username === 'ghost'));
});