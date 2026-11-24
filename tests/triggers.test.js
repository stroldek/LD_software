import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTrigger, parsePhrases } from '../src/lib/triggers.js';

test('filter modes independently match words and multiword phrases', () => {
  assert.equal(matchTrigger('Ищу поставщика чехлов', { matchMode: 'keywords', keywords: 'куплю\nпоставщик' }), 'поставщик');
  assert.equal(matchTrigger('Ищу поставщика чехлов', { matchMode: 'phrases', phrases: 'ищу поставщика упаковки\nищу поставщика чехлов' }), 'ищу поставщика чехлов');
  assert.equal(matchTrigger('ищу поставщика упаковки', { matchMode: 'phrases', phrases: 'готов купить оптом' }), null);
  assert.equal(matchTrigger('КУПЛЮ Ёлки', { matchMode: 'both', keywords: 'елки', phrases: 'куплю елки' }), 'елки');
  assert.equal(parsePhrases('  Ищу поставщика  ; ищу поставщика').length, 1);
});
