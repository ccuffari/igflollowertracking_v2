'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts', 'lib', 'analysis-core.js'), 'utf8');
const STORE = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts', 'store.js'), 'utf8');

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
  vm.runInContext(STORE, context);
  return { store: context.IGFTStore, memory };
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

test('switchToCloud resta cloud anche se i disattivati si sincronizzano lentamente', async () => {
  let release;
  const slowDeactivated = new Promise((resolve) => { release = resolve; });

  const analysesQuery = {
    orderBy() { return analysesQuery; },
    limit() { return analysesQuery; },
    get() { return Promise.resolve({ docs: [] }); }
  };
  const deactivatedQuery = {
    orderBy() { return deactivatedQuery; },
    limit() { return deactivatedQuery; },
    startAfter() { return deactivatedQuery; },
    get() { return slowDeactivated.then(() => ({ docs: [] })); }
  };
  const userDoc = {
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

  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
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

  const { store } = createStore(fakeFirebase(fake), { seed });
  await store.ready;
  await new Promise((resolve) => setTimeout(resolve, 80));

  const analyses = await store.listAnalyses();
  assert.equal(store.getStatus().storage, 'cloud');
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0].id, 'a1');

  const deactivated = store.listDeactivated().map((item) => item.username);
  assert.deepEqual(deactivated, ['ghost']);
  assert.ok(fake.collections.get('users/user-1/deactivated').has('ghost'));
  assert.ok(!fake.collections.get('users/user-1/deactivated').has('old'));
});

test('saveAnalysis scrive analisi e username su Firestore', async () => {
  const fake = createFakeFirestore();
  const { store } = createStore(fakeFirebase(fake), { seed: CLOUD_SEED });
  await store.ready;
  await new Promise((resolve) => setTimeout(resolve, 40));

  const saved = await store.saveAnalysis(report);
  assert.equal(saved.storage, 'cloud');

  const analyses = fake.collections.get('users/user-1/analyses');
  assert.ok(analyses && analyses.has(saved.id));
  assert.equal(analyses.get(saved.id).notFollowingCount, 3);

  const items = fake.collections.get('users/user-1/analyses/' + saved.id + '/items');
  assert.deepEqual(Array.from(items.get('chunk-000').usernames), ['alice', 'bob', 'carol']);
});

test('i profili disattivati sono salvati su Firestore e riletti al retry', async () => {
  const fake = createFakeFirestore();
  const { store } = createStore(fakeFirebase(fake), { seed: CLOUD_SEED });
  await store.ready;
  await new Promise((resolve) => setTimeout(resolve, 40));

  await store.markDeactivated('ghost');
  assert.ok(fake.collections.get('users/user-1/deactivated').has('ghost'));

  fake.seed(['users', 'user-1', 'deactivated'], 'remote', {
    username: 'remote',
    markedAt: new Date()
  });

  await store.retryCloud();
  const names = store.listDeactivated().map((item) => item.username).sort();
  assert.deepEqual(names, ['ghost', 'remote']);
});

test('le analisi salvate offline vengono inviate a Firestore al retry', async () => {
  const fake = createFakeFirestore();
  const { store } = createStore(fakeFirebase(fake), { seed: CLOUD_SEED });
  await store.ready;
  await new Promise((resolve) => setTimeout(resolve, 40));

  fake.state.failWrites = true;
  const saved = await store.saveAnalysis(report);
  assert.notEqual(saved.storage, 'cloud');
  assert.equal(store.getStatus().analysesCount, 1);

  fake.state.failWrites = false;
  await store.retryCloud();

  const analyses = fake.collections.get('users/user-1/analyses');
  assert.ok(analyses && analyses.has(saved.id));
  const list = await store.listAnalyses();
  assert.equal(list.length, 1);
  assert.equal(list[0].storage, 'cloud');
});
