'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts', 'lib', 'analysis-core.js'), 'utf8');
const STORE = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts', 'store.js'), 'utf8');

function createStore(firebase) {
  const memory = new Map();
  const localStorage = {
    getItem(key) { return memory.has(key) ? memory.get(key) : null; },
    setItem(key, value) { memory.set(key, String(value)); },
    removeItem(key) { memory.delete(key); }
  };
  const context = {
    console,
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
    setTimeout,
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
