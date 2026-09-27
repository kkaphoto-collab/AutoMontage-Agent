const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');
const box = { x: 100, y: 300, w: 400, h: 100 };

test('element is invisible outside its window and fully settled in the middle', () => {
  const item = { id: 't', kind: 'text', from: 10, until: 60, box };
  assert.equal(kit.animOf(item, 9, 25).o, 0);
  assert.equal(kit.animOf(item, 60, 25).o, 0);
  const mid = kit.animOf(item, 35, 25);
  assert.ok(Math.abs(mid.s - 1) < 0.01 && mid.o === 1 && mid.blur < 0.01);
  assert.equal(kit.itemExtentAt(item, 9, 25), null);
});

test('a side fly-in leaves the safe zone on its first visible frames only', () => {
  const item = { id: 't', kind: 'text', from: 10, until: 60, box, enter: { kind: 'fly', from: [-200, 0] } };
  assert.equal(kit.itemExtentAt(item, 10, 25), null);
  assert.ok(kit.itemExtentAt(item, 11, 25).left < 70);
  assert.ok(kit.itemExtentAt(item, 40, 25).left > 95);
});

test('pop overshoots above scale 1, so extents must be measured per frame', () => {
  const item = { id: 'p', kind: 'text', from: 0, until: 50, box, enter: { kind: 'pop' } };
  const peak = Math.max(...Array.from({ length: 20 }, (_, f) => kit.animOf(item, f, 25).s));
  assert.ok(peak > 1.05, `peak ${peak}`);
});

test('exit fades, shrinks and moves in the declared direction', () => {
  const down = { id: 'd', kind: 'card', from: 0, until: 60, box, exit: { frames: 5, dir: 'down' } };
  const up = { ...down, exit: { frames: 5, dir: 'up' } };
  assert.ok(kit.animOf(down, 59, 25).o < 0.5);
  assert.ok(kit.animOf(down, 59, 25).dy > kit.animOf(up, 59, 25).dy + 10);
});

test('unknown enter kind is rejected with the element id', () => {
  assert.throws(() => kit.animOf({ id: 'x', from: 0, until: 10, box, enter: { kind: 'spin' } }, 1, 25), /item x: неизвестный вход «spin»/);
});

test('typed reveals characters monotonically and completes on time', () => {
  const lengths = Array.from({ length: 12 }, (_, f) => kit.typed('Привет, мир', f, 0, 10).length);
  assert.equal(lengths[0], 0);
  assert.equal(lengths[10], 'Привет, мир'.length);
  for (let i = 1; i < lengths.length; i += 1) assert.ok(lengths[i] >= lengths[i - 1]);
  assert.equal(kit.typed('abc', 5, 0, 10), kit.typed('abc', 5, 0, 10));
});

// Граничные случаи сверх плана: цельный элемент без mask-хвоста и cut-вход не должны падать
// с непонятной ошибкой (cut — валидный enter.kind, но ветка расчёта для него отсутствует
// в теле if/else if — проверяем, что это не бросает исключение и даёт нейтральную анимацию).
test('cut enter kind is accepted and yields a neutral (not-animated) transform', () => {
  const item = { id: 'c', kind: 'text', from: 0, until: 20, box, enter: { kind: 'cut' } };
  const a = kit.animOf(item, 5, 25);
  assert.equal(a.o, 1);
  assert.equal(a.s, 1);
  assert.equal(a.dx, 0);
});

test('mask enter kind clips progressively and does not throw', () => {
  const item = { id: 'm', kind: 'text', from: 0, until: 20, box, enter: { kind: 'mask' } };
  const a = kit.animOf(item, 1, 25);
  assert.ok(typeof a.clip === 'string' && a.clip.startsWith('inset('));
});

test('exit frames 0 keeps the element fully visible until the very last frame', () => {
  const item = { id: 'e', kind: 'text', from: 0, until: 20, box, exit: { frames: 0 } };
  assert.equal(kit.animOf(item, 19, 25).o, 1);
});
