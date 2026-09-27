const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');

test('chunks break on commas after two words, sentence ends and pauses', () => {
  const words = [
    { t: 'Раз', s: 0, e: 0.3 }, { t: 'два', s: 0.35, e: 0.6 }, { t: 'три,', s: 0.65, e: 0.9 },
    { t: 'четыре', s: 0.95, e: 1.3 }, { t: 'пять.', s: 1.35, e: 1.6 },
    { t: 'шесть', s: 2.5, e: 2.8 }, { t: 'а', s: 2.85, e: 2.9 },
  ];
  const chunks = kit.buildChunks(words);
  assert.deepEqual(chunks.map((c) => c.text), ['Раз два три,', 'четыре пять.', 'шесть а']);
  assert.deepEqual(chunks.map((c) => c.show), [0.95, 2, 3.3]);
});

test('chunks respect the 20-character limit', () => {
  const words = ['интерфейсы', 'нейросетей', 'меняются'].map((t, i) => ({ t, s: i * 0.7, e: i * 0.7 + 0.6 }));
  assert.deepEqual(kit.buildChunks(words).map((c) => c.text), ['интерфейсы', 'нейросетей меняются']);
});

test('too short chunk merges into the next one', () => {
  const words = [{ t: 'Да.', s: 0, e: 0.2 }, { t: 'Именно', s: 0.25, e: 0.6 }, { t: 'так', s: 0.62, e: 0.8 }];
  assert.deepEqual(kit.buildChunks(words).map((c) => c.text), ['Да. Именно так']);
});

test('caption lane sits inside the safe zone above the bottom edge', () => {
  assert.deepEqual(kit.captionLane(1080, 1920), { x: 70, y: 1398, w: 880, h: 84 });
});

// Граничные случаи сверх плана: пустой список слов (ролик без транскрипта в этом куске) не
// должен падать, и полоса субтитров должна оставаться внутри кадра для ландшафтной геометрии,
// не только для портретной 1080x1920 из основного теста.
test('an empty word list produces no chunks', () => {
  assert.deepEqual(kit.buildChunks([]), []);
});

test('caption lane also fits inside a landscape frame', () => {
  const lane = kit.captionLane(1920, 1080);
  assert.ok(lane.x >= 0 && lane.y >= 0 && lane.x + lane.w <= 1920 && lane.y + lane.h <= 1080);
});
