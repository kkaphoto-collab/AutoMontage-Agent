const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');

test('inserts compile to frames, default ids, cover and Ken Burns range', () => {
  const inserts = kit.compileInserts([
    { kind: 'stock', from: 2, to: 4, src: 'stock/a.mp4', sfx: 'whoosh' },
    { kind: 'donor', from: 1.3, to: 3.4, src: 'donor.mp4' },
  ], { fps: 25 });
  assert.deepEqual(inserts.map((i) => [i.id, i.from, i.to, i.cover]), [['stock-1', 50, 100, true], ['donor-2', 33, 85, false]]);
  assert.deepEqual(inserts[0].kb, [1.03, 1.1]);
  assert.equal(inserts[0].sfx, 'whoosh');
});

test('invalid inserts are rejected', () => {
  assert.throws(() => kit.compileInserts([{ kind: 'meme', from: 0, to: 1 }], { fps: 25 }), /inserts\[0\]: kind/);
  assert.throws(() => kit.compileInserts([{ kind: 'stock', from: 2, to: 2 }], { fps: 25 }), /to должен быть больше from/);
});

test('covering inserts send the speaker away and bring it back before the insert ends', () => {
  const aways = kit.awaysFromInserts(kit.compileInserts([
    { kind: 'stock', from: 2, to: 4 }, { kind: 'donor', from: 5, to: 6 },
  ], { fps: 25 }));
  assert.deepEqual(aways, [{ from: 50, to: 90 }]);
});

// Граничные случаи сверх плана: пустой список вставок не должен падать (нет вставок в ролике —
// обычный случай для роликов без стока), и awaysFromInserts должен молча пропускать вставки
// короче окна возврата, а не уходить в отрицательный диапазон.
test('an empty insert list compiles and produces no away windows', () => {
  assert.deepEqual(kit.compileInserts([], { fps: 25 }), []);
  assert.deepEqual(kit.awaysFromInserts([], { fps: 25 }), []);
});

test('a covering insert shorter than the return window never inverts from/to', () => {
  const inserts = kit.compileInserts([{ kind: 'stock', from: 0, to: 0.1 }], { fps: 25 });
  const [away] = kit.awaysFromInserts(inserts, { fps: 25 });
  assert.ok(away.to > away.from, `away.to (${away.to}) must stay after away.from (${away.from})`);
});

// Ревью: вставки не были обрезаны по длительности композиции — донор, начатый до конца ролика,
// но заканчивающийся далеко после него, попадал в манифест с «to» за пределами видео (G11 считал
// бы его длину неправильно), а вставка целиком за концом ролика молча проходила компиляцию.
test('an insert reaching past the composition end is clamped to its duration', () => {
  const [donor] = kit.compileInserts([{ kind: 'donor', from: 18, to: 25 }], { fps: 25, durationInFrames: 500 });
  assert.equal(donor.to, 500);
  assert.equal(donor.from, 450);
  assert.equal((donor.to - donor.from) / 25, 2, 'видимый хвост донора должен остаться 2 с');
});

test('an insert starting at or after the composition end is rejected', () => {
  assert.throws(
    () => kit.compileInserts([{ kind: 'stock', from: 22, to: 24 }], { fps: 25, durationInFrames: 500 }),
    /inserts\[0\] \(stock\): начинается после конца ролика/,
  );
  assert.throws(
    () => kit.compileInserts([{ kind: 'stock', from: 20, to: 24 }], { fps: 25, durationInFrames: 500 }),
    /начинается после конца ролика/,
    'from ровно на конце ролика — тоже поздно, ролик заканчивается на durationInFrames',
  );
});

test('compileInserts keeps its old unclamped behaviour when durationInFrames is omitted', () => {
  // Task 8 вызывает compileInserts(inserts, { fps }) без durationInFrames — эти вызовы не должны
  // ломаться или начать обрезать to, иначе существующие тесты и places, которые ещё не знают
  // длительность композиции, перестанут работать.
  const [insert] = kit.compileInserts([{ kind: 'stock', from: 2, to: 100 }], { fps: 25 });
  assert.equal(insert.to, 2500);
});
