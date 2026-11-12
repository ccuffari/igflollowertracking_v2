'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Noise = require('../public/scripts/lib/extension-noise.js');

test('riconosce il messaggio tipico di un content script senza background', () => {
  assert.equal(
    Noise.isExtensionNoise({ message: 'Could not establish connection. Receiving end does not exist.' }, ''),
    true
  );
  assert.equal(Noise.isExtensionNoise('Could not establish connection. Receiving end does not exist.', ''), true);
});

test('riconosce gli errori provenienti da uno script di estensione', () => {
  assert.equal(Noise.isExtensionNoise({ message: 'boom' }, 'https://example.test/web-client-content-script.js'), true);
  assert.equal(Noise.isExtensionNoise({ message: 'boom' }, 'chrome-extension://abc/content.js'), true);
  assert.equal(Noise.isExtensionSource('moz-extension://abc/content.js'), true);
});

test('non considera rumore gli errori dell applicazione', () => {
  assert.equal(Noise.isExtensionNoise(new Error('Errore analisi followers JSON'), 'https://example.test/scripts/app.js'), false);
  assert.equal(Noise.isExtensionNoise({ message: 'Salvataggio analisi non riuscito' }, ''), false);
  assert.equal(Noise.isExtensionNoise({ message: 'offline' }, 'https://example.test/scripts/store.js'), false);
});

test('gestisce valori assenti o inattesi', () => {
  assert.equal(Noise.isExtensionNoise(null, null), false);
  assert.equal(Noise.isExtensionNoise(undefined, undefined), false);
  assert.equal(Noise.isExtensionNoise({}, ''), false);
});
