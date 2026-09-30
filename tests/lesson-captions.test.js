const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCaptionGroups } = require('../scripts/lesson/captions');

test('groups short bursts of words within the timing rule', () => {
  const words = [
    { w: 'Привет,', s: 0.0, e: 0.4 },
    { w: 'мир', s: 0.42, e: 0.7 },
    { w: 'сегодня', s: 0.75, e: 1.1 },
    { w: 'хороший', s: 1.15, e: 1.5 },
    { w: 'день.', s: 1.55, e: 1.9 },
  ];
  const groups = buildCaptionGroups(words);
  // "хороший" would push the 4th word's group duration (0.75->1.5 = 0.75s, still < 1.6s, still < 4 words)
  // so the split happens strictly on the 4-word cap, not on duration here.
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].words.map((w) => w.w), ['Привет,', 'мир', 'сегодня', 'хороший']);
  assert.deepEqual(groups[1].words.map((w) => w.w), ['день.']);
  assert.equal(groups[0].start, 0.0);
  assert.equal(groups[0].end, 1.5);
});

test('closes a group on a pause of 0.45s or more', () => {
  const words = [
    { w: 'Первое', s: 0, e: 0.3 },
    { w: 'слово', s: 0.32, e: 0.6 },
    { w: 'Пауза', s: 1.2, e: 1.5 },
  ];
  const groups = buildCaptionGroups(words);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].words.map((w) => w.w), ['Первое', 'слово']);
  assert.deepEqual(groups[1].words.map((w) => w.w), ['Пауза']);
});

test('closes a group once its duration reaches 1.6s even with short pauses', () => {
  const words = [
    { w: 'Раз', s: 0, e: 0.3 },
    { w: 'два', s: 0.4, e: 0.7 },
    { w: 'три', s: 0.8, e: 1.1 },
    { w: 'четыре', s: 1.3, e: 1.65 },
  ];
  const groups = buildCaptionGroups(words);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].words.map((w) => w.w), ['Раз', 'два', 'три']);
  assert.deepEqual(groups[1].words.map((w) => w.w), ['четыре']);
});

test('skips malformed words and trims whitespace', () => {
  const words = [
    { w: '  привет  ', s: 0, e: 0.3 },
    { w: '', s: 0.4, e: 0.5 },
    { w: 'мир', s: -1, e: 0.9 },
    { w: 'ок', s: 1, e: 0.5 },
  ];
  const groups = buildCaptionGroups(words);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].words.map((w) => w.w), ['привет']);
});

test('empty input yields no groups', () => {
  assert.deepEqual(buildCaptionGroups([]), []);
  assert.deepEqual(buildCaptionGroups(null), []);
});
