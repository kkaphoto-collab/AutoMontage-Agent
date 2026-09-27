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
