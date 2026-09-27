const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');
const segments = [{ words: [
  { w: ' Знаешь,', s: 0, e: 0.28 }, { w: ' CloudCode', s: 0.3, e: 0.9 },
  { w: ' ёлка', s: 1.0, e: 1.3 }, { w: ' знаешь', s: 3.0, e: 3.3 }, { w: ' ', s: 3.4, e: 3.5 },
] }];

test('flattenTranscript trims words, applies spelling and keeps trailing punctuation', () => {
  const words = kit.flattenTranscript(segments, { spelling: { cloudcode: 'Claude Code', 'знаешь': 'Знаешь' } });
  assert.deepEqual(words.map((w) => [w.w, w.t]), [
    ['Знаешь,', 'Знаешь,'], ['CloudCode', 'Claude Code'], ['ёлка', 'ёлка'], ['знаешь', 'Знаешь'],
  ]);
  assert.equal(kit.normWord(' Ёлка!'), 'елка');
});

test('anchors walk forward, honour near, and free anchors do not move the cursor', () => {
  const words = kit.flattenTranscript(segments);
  const a = kit.makeAnchors(words);
  assert.equal(a.at('знаешь', { free: true }), 0);
  assert.equal(a.at('знаешь'), 0);
  assert.equal(a.at('знаешь'), 3.0);
  const b = kit.makeAnchors(words);
  assert.equal(b.at('знаешь', { near: 3.1 }), 3.0);
  assert.throws(() => b.at('ёлка'), /не найден после слова №4/);
  const c = kit.makeAnchors(words);
  assert.equal(c.at('ёлка', { edge: 'end', d: 0.1 }), 1.4);
});

test('missing anchor names the word and the cursor', () => {
  const a = kit.makeAnchors(kit.flattenTranscript(segments));
  a.at('ёлка');
  assert.throws(() => a.at('CloudCode'), /якорь «CloudCode» не найден после слова №3/);
});
