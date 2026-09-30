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
// с непонятной ошибкой (cut – валидный enter.kind, но ветка расчёта для него отсутствует
// в теле if/else if – проверяем, что это не бросает исключение и даёт нейтральную анимацию).
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

// Ревью задачи 23 (minor): на самом первом кадре маски (p=0) clip закрывает 100% ширины – реально
// ничего не нарисовано, хотя o остаётся полным (маска не трогает прозрачность). isShown обязан
// видеть это через reveal, а не только через o – иначе манифест (itemExtentAt) и рендер (KitBox)
// «видят» габарит кадра, которого зритель не видит вовсе.
test('a fully closed mask on its very first frame is not shown (reveal 0), even though opacity stays 1', () => {
  const item = { id: 'm2', kind: 'text', from: 0, until: 20, box, enter: { kind: 'mask' } };
  const a = kit.animOf(item, 0, 25);
  assert.equal(a.o, 1);
  assert.ok(a.reveal <= 0.001, `reveal ${a.reveal} должен быть практически нулевым на самом первом кадре`);
  assert.equal(kit.isShown(a), false);
  assert.equal(kit.itemExtentAt(item, 0, 25), null);
});

// Пружина Remotion пересчитывает физику от кадра 0 на каждый вызов (O(кадр) внутри) – без клэмпа
// кадра (settledFrame) манифест из многих долгоживущих items становится квадратичным по длине
// (ревью задачи 23). measureSpring() определяет момент оседания (within threshold) – после него
// клэмпнутый и настоящий кадр обязаны давать визуально тот же результат (разница ≤ 1e-6 px), а не
// грубое приближение. Step 0 задачи 24 (усиление): раньше проверялись только две точки далеко за
// оседанием на одном fps – теперь сканируем окно в 50 кадров СРАЗУ после самой точки оседания (где
// клэмп и настоящий кадр впервые расходятся, если расходятся вообще) на 25 и 60 fps.
test('the spring clamp used to avoid a quadratic manifest build does not change animOf output for a long-lived item', () => {
  const { spring, measureSpring } = require('remotion');
  const longPop = { id: 'p2', kind: 'text', from: 0, until: 10000000, box, enter: { kind: 'pop' } };
  const longFly = { id: 'f2', kind: 'text', from: 0, until: 10000000, box, enter: { kind: 'fly', from: [-200, 0] } };
  for (const fps of [25, 60]) {
    for (const [item, config] of [[longPop, kit.SPRINGS.pop], [longFly, kit.SPRINGS.fly]]) {
      const expectedS = (sp) => (item === longPop ? 0.5 + 0.5 * sp : 0.92 + 0.08 * sp);
      const settle = measureSpring({ fps, config, threshold: 1e-9 });
      const frames = [];
      for (let frame = settle; frame < settle + 50; frame += 1) frames.push(frame);
      frames.push(settle + 500, settle + 20000);
      for (const frame of frames) {
        const a = kit.animOf(item, frame, fps);
        const sp = spring({ frame, fps, config });
        assert.ok(Math.abs(a.s - expectedS(sp)) < 1e-6,
          `${item.id} fps=${fps} frame ${frame}: s=${a.s} vs unclamped ${expectedS(sp)}`);
      }
    }
  }
});

test('exit frames 0 keeps the element fully visible until the very last frame', () => {
  const item = { id: 'e', kind: 'text', from: 0, until: 20, box, exit: { frames: 0 } };
  assert.equal(kit.animOf(item, 19, 25).o, 1);
});

// Ревью: itemExtentAt считал полуширину/полувысоту как (w*cos+h*sin)/2 без abs – для th>90°
// cos(th) уходит в минус, и хабарит переворачивается (left>right), из-за чего гейт safe-zone (G5)
// молча пропускает элемент, который реально вылезает за кадр. Эталон – та же формула ограничивающего
// прямоугольника повёрнутого прямоугольника, что использует ревью (min/max по 4 повёрнутым углам).
function cssExtent(item, a) {
  const { x, y, w, h } = item.box;
  const cx = x + w / 2; const cy = y + h / 2;
  const th = (a.rot * Math.PI) / 180;
  const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([px, py]) => {
    const rx = px * Math.cos(th) - py * Math.sin(th);
    const ry = px * Math.sin(th) + py * Math.cos(th);
    return [cx + a.dx + a.s * rx, cy + a.dy + a.s * ry];
  });
  return {
    left: Math.min(...pts.map((p) => p[0])), right: Math.max(...pts.map((p) => p[0])),
    top: Math.min(...pts.map((p) => p[1])), bottom: Math.max(...pts.map((p) => p[1])),
  };
}

test('rotations beyond 90 degrees keep left <= right and top <= bottom and match the CSS bbox', () => {
  for (const rot of [95, 120, -150, 180]) {
    const item = { id: 'r', kind: 'text', from: 0, until: 50, box, rot, enter: { kind: 'cut' } };
    const frame = 20;
    const e = kit.itemExtentAt(item, frame, 25);
    const c = cssExtent(item, kit.animOf(item, frame, 25));
    assert.ok(e.left <= e.right && e.top <= e.bottom, `rot ${rot}: inverted box ${JSON.stringify(e)}`);
    assert.ok(Math.abs(e.left - c.left) < 0.01, `rot ${rot} left: ${e.left} vs ${c.left}`);
    assert.ok(Math.abs(e.right - c.right) < 0.01, `rot ${rot} right: ${e.right} vs ${c.right}`);
    assert.ok(Math.abs(e.top - c.top) < 0.01, `rot ${rot} top: ${e.top} vs ${c.top}`);
    assert.ok(Math.abs(e.bottom - c.bottom) < 0.01, `rot ${rot} bottom: ${e.bottom} vs ${c.bottom}`);
  }
});

// Ревью: на последнем видимом кадре (until-1) прозрачность ещё не доходила до 0 (0.36 на 25 fps
// при exit.frames:5) – элемент визуально выключался рывком на кадр раньше конца затухания.
// Интервал затухания должен заканчиваться на until-1 (последний реально отрисованный кадр), не на
// until (кадр, который вообще не рендерится).
test('exit reaches full transparency by the very last visible frame, not one frame later', () => {
  const item = { id: 'e2', kind: 'card', from: 0, until: 60, box, exit: { frames: 5, dir: 'down' } };
  assert.equal(kit.animOf(item, 59, 25).o, 0);
});

test('exit frames of 1 fades out without throwing on a degenerate interpolate range', () => {
  const item = { id: 'e3', kind: 'text', from: 0, until: 60, box, exit: { frames: 1 } };
  assert.doesNotThrow(() => kit.animOf(item, 59, 25));
  assert.ok(kit.animOf(item, 59, 25).o < kit.animOf(item, 55, 25).o);
});
