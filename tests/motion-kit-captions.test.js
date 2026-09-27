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

// Ревью: слияние коротких кусков ничем не ограничено — цепочка из многих слов короче minDur
// (0,45 с) с паузами короче hardGap (0,3 с) склеивается в один длинный кусок, который переполняет
// однострочную полосу субтитров (overflow hidden обрежет текст, и гейт G5 не увидит проблему).
// Девять слов по 0,02 с с интервалом 0,03 с — каждое своим предложением («да.», «нет.»…), поэтому
// на исходном (нефиксированном) коде цепочка мержится в один кусок из 9 слов / 40 знаков.
test('merging short chunks stays within maxWords+1 words and maxChars+8 characters', () => {
  const words = ['да.', 'нет.', 'ок.', 'вот.', 'ага.', 'угу.', 'да.', 'нет.', 'ок.']
    .map((t, i) => ({ t, s: i * 0.05, e: i * 0.05 + 0.02 }));
  const chunks = kit.buildChunks(words);
  for (const chunk of chunks) {
    assert.ok(chunk.units.length <= 5, `chunk "${chunk.text}" has ${chunk.units.length} words (limit 5)`);
    assert.ok(chunk.text.length <= 28, `chunk "${chunk.text}" has ${chunk.text.length} chars (limit 28)`);
  }
  // Ни одно слово не потерялось и порядок сохранён.
  assert.equal(chunks.flatMap((c) => c.units.map((u) => u.t)).join('|'), words.map((w) => w.t).join('|'));
});

// Task 18 review: activeChunk теперь живёт здесь (captions.js), построен на captionSpans через
// secToFrame, а не на прямом сравнении секунд. Ассерты из плана Task 18 обязаны продолжать
// выполняться дословно.
test('activeChunk finds the chunk containing a frame derived from sec via secToFrame, and respects hide', () => {
  const chunks = [{ units: [{ t: 'Раз', s: 0, e: 0.3 }, { t: 'два', s: 0.4, e: 0.6 }], s: 0, e: 0.6, show: 1, text: 'Раз два' }];
  assert.equal(kit.activeChunk(chunks, 0.5).text, 'Раз два');
  assert.equal(kit.activeChunk(chunks, 1.2), null);
  assert.equal(kit.activeChunk(chunks, 0.5, [{ from: 0.4, to: 0.9 }]), null);
  // fps явно отличный от дефолта 25 — тот же chunk, но границы считаются иначе.
  assert.equal(kit.activeChunk(chunks, 0.5, [], 30).text, 'Раз два');
  assert.equal(kit.activeChunk(chunks, 1.2, [], 30), null);
});

// Task 18 review: captionSpans — options-объект, секунды переводятся в кадры через secToFrame (тот
// же перевод, что compileInserts), until клэмпится под durationInFrames, и никакие два chunk не
// должны претендовать на один и тот же кадр.
test('captionSpans converts seconds via secToFrame, clamps to durationInFrames and drops a chunk past the end', () => {
  const chunks = [
    { units: [], s: 0, e: 1, show: 2 },
    { units: [], s: 10, e: 10.1, show: 10.2 }, // далеко за durationInFrames ниже
  ];
  const spans = kit.captionSpans(chunks, { fps: 25, durationInFrames: 30 });
  assert.deepEqual(spans, [{ index: 0, from: 0, until: 30 }], 'until клэмпится под durationInFrames, chunk[1] целиком за концом ролика — его нет вовсе');
});

test('captionSpans drops a zero-length chunk (s === show) without throwing', () => {
  const chunks = [{ units: [], s: 1, e: 1, show: 1 }];
  assert.deepEqual(kit.captionSpans(chunks, { fps: 25, durationInFrames: 1000 }), []);
});

test('captionSpans hide windows: unsorted, overlapping, and touching a chunk edge exactly', () => {
  const chunks = [{ units: [], s: 0, e: 1.2, show: 1.2 }]; // [0, 30) кадров при fps=25
  // Overlapping + unsorted: [15,20) и [10,16) объединяются в [10,20).
  const overlap = kit.captionSpans(chunks, { hide: [{ from: 0.6, to: 0.8 }, { from: 0.4, to: 0.64 }], fps: 25, durationInFrames: 1000 });
  assert.deepEqual(overlap, [{ index: 0, from: 0, until: 10 }, { index: 0, from: 20, until: 30 }]);
  // Окно, касающееся ЛЕВОГО края span'а ровно в его начале (from=0..to=0.4=[0,10)) не должно
  // оставить пустой сегмент [0,0) — только правый остаток.
  const touchLeft = kit.captionSpans(chunks, { hide: [{ from: 0, to: 0.4 }], fps: 25, durationInFrames: 1000 });
  assert.deepEqual(touchLeft, [{ index: 0, from: 10, until: 30 }]);
  // Окно, касающееся ПРАВОГО края ровно на его конце — только левый остаток.
  const touchRight = kit.captionSpans(chunks, { hide: [{ from: 0.8, to: 1.2 }], fps: 25, durationInFrames: 1000 });
  assert.deepEqual(touchRight, [{ index: 0, from: 0, until: 20 }]);
});

// Регрессия ревью Task 18 (karaoke.js): buildChunks округляет show через toFixed(3) независимо от
// следующего chunk.s — на некоторых секундах (chunk0 кончается на 0.4506, chunk1 начинается на
// 0.4596) show после округления «перепрыгивает» вперёд следующего from на 1 кадр при fps=25.
// Реальные (не синтетические) последовательные слова — репродукция из ревью, не выдуманный кейс.
test('captionSpans never lets two chunks claim the same frame, even when toFixed(3) rounds show past the next chunk\'s start', () => {
  const words = [{ w: 'а.', t: 'а.', s: 0, e: 0.4506 }, { w: 'б', t: 'б', s: 0.4596, e: 0.7596 }];
  const chunks = kit.buildChunks(words);
  assert.equal(chunks.length, 2, 'период после «а.» обязан разбить слова на два отдельных chunk');
  const spans = kit.captionSpans(chunks, { fps: 25, durationInFrames: 1000 });
  assert.equal(spans.length, 2);
  assert.ok(spans[0].until <= spans[1].from, `chunk0.until=${spans[0].until} не должен быть больше chunk1.from=${spans[1].from}`);
});

// Пряма проверка: hide, заданный теми же секундами, что insert.from/to, обязан дать те же самые
// кадры, что compileInserts даёт этой вставке — оба используют secToFrame.
test('a hide window converts the same seconds to the same frame as compileInserts does for an insert', () => {
  const [insert] = kit.compileInserts([{ kind: 'stock', from: 0.58, to: 1.42, src: 'x.mp4' }], { fps: 30, durationInFrames: 1000 });
  const hideFrame = kit.secToFrame(0.58, 30);
  assert.equal(hideFrame, insert.from);
});

test('captionFontSize keeps base at a roomy lane and only shrinks for a lane too short to hold it', () => {
  // 84/(1.1+12/44) ≈ 61.2 — стандартная полоса 1080x1920 не трогает базовый 44px кегль.
  assert.equal(kit.captionFontSize({ base: 44, laneH: 84 }), 44);
  assert.ok(kit.captionFontSize({ base: 44, laneH: 40 }) < 44, 'тесная полоса обязана сжать кегль');
  // Высокая кастомная полоса не должна РАЗДУВАТЬ кегль сверх base.
  assert.equal(kit.captionFontSize({ base: 44, laneH: 400 }), 44);
});

test('narrowFitBounds halves the binary-search range toward whichever half still fits', () => {
  assert.deepEqual(kit.narrowFitBounds({ low: 10, high: 50, fits: true }), { low: 30, high: 50 });
  assert.deepEqual(kit.narrowFitBounds({ low: 10, high: 50, fits: false }), { low: 10, high: 30 });
});
