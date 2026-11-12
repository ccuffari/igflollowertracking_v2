'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../public/scripts/lib/analysis-core.js');

test('normalizeUsername normalizza e valida gli username Instagram', () => {
  assert.equal(Core.normalizeUsername('  Foo.Bar_1 '), 'foo.bar_1');
  assert.equal(Core.normalizeUsername('user_name'), 'user_name');
  assert.equal(Core.normalizeUsername(''), null);
  assert.equal(Core.normalizeUsername(null), null);
  assert.equal(Core.normalizeUsername(undefined), null);
  assert.equal(Core.normalizeUsername('foo bar'), null);
  assert.equal(Core.normalizeUsername('@foo'), null);
  assert.equal(Core.normalizeUsername('ciao!'), null);
  assert.equal(Core.normalizeUsername('a'.repeat(51)), null);
  assert.equal(Core.normalizeUsername('a'.repeat(50)), 'a'.repeat(50));
});

test('uniqueUsernames deduplica e scarta i valori non validi', () => {
  const result = Core.uniqueUsernames(['Foo', 'foo', 'bar', '', 'bad name', null, 'baz_1']);
  assert.deepEqual(result, ['foo', 'bar', 'baz_1']);
});

test('uniqueUsernames gestisce input non array', () => {
  assert.deepEqual(Core.uniqueUsernames(null), []);
  assert.deepEqual(Core.uniqueUsernames('foo'), []);
});

test('filterDeactivated rimuove i profili marcati (case-insensitive)', () => {
  const result = Core.filterDeactivated(
    ['alice', 'Bob', 'carol', 'dave'],
    new Set(['bob', 'dave'])
  );
  assert.deepEqual(result.kept, ['alice', 'carol']);
  assert.deepEqual(result.removed, ['bob', 'dave']);
});

test('filterDeactivated accetta un array di username', () => {
  const result = Core.filterDeactivated(['alice', 'bob'], ['BOB', 'sconosciuto']);
  assert.deepEqual(result.kept, ['alice']);
  assert.deepEqual(result.removed, ['bob']);
});

test('filterDeactivated non modifica la lista originale', () => {
  const input = ['alice', 'bob'];
  Core.filterDeactivated(input, new Set(['alice']));
  assert.deepEqual(input, ['alice', 'bob']);
});

test('filterDeactivated con lista vuota', () => {
  assert.deepEqual(Core.filterDeactivated([], new Set(['alice'])), { kept: [], removed: [] });
});

test('chunkArray divide in blocchi della dimensione richiesta', () => {
  assert.deepEqual(Core.chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(Core.chunkArray([], 10), []);
  assert.deepEqual(Core.chunkArray([1], 10), [[1]]);
});

test('chunkArray rifiuta dimensioni non valide', () => {
  assert.throws(() => Core.chunkArray([1], 0), RangeError);
  assert.throws(() => Core.chunkArray([1], 1.5), RangeError);
});

test('escapeHtml neutralizza i caratteri speciali', () => {
  assert.equal(
    Core.escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
  );
  assert.equal(Core.escapeHtml("O'Reilly & co"), 'O&#39;Reilly &amp; co');
  assert.equal(Core.escapeHtml(null), '');
});

test('toMillis converte Date, stringhe, numeri e Timestamp Firestore', () => {
  const millis = Date.UTC(2026, 0, 2, 3, 4, 5);
  assert.equal(Core.toMillis(new Date(millis)), millis);
  assert.equal(Core.toMillis(millis), millis);
  assert.equal(Core.toMillis(new Date(millis).toISOString()), millis);
  assert.equal(Core.toMillis({ toDate: () => new Date(millis) }), millis);
  assert.equal(Core.toMillis(null), 0);
  assert.equal(Core.toMillis('non-una-data'), 0);
});

test('formatDateIt gestisce valori non validi', () => {
  assert.equal(Core.formatDateIt(null), '—');
  assert.equal(Core.formatDateIt('non-una-data'), '—');
  assert.notEqual(Core.formatDateIt(Date.UTC(2026, 0, 2, 3, 4, 5)), '—');
});
