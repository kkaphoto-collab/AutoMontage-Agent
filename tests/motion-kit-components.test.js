const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { loadEsm } = require('./helpers/load-esm');
const { remotionStub, render } = require('./helpers/remotion-stub');

const kitAt = (frame, { fps = 25, calls = {} } = {}) => loadEsm('src/motion-kit/index.js', { stubs: { remotion: remotionStub({ frame, fps, calls }) } });
const item = (over = {}) => ({ id: 'title', kind: 'text', from: 10, until: 60, box: { x: 90, y: 300, w: 840, h: 200 },
  rot: 0, enter: { kind: 'fly' }, exit: { frames: 5, dir: 'down' }, life: {}, ...over });

test('KitBox places text at its box, marks it for safe-zone checks and hides outside its window', () => {
  const kit = kitAt(30);
  const html = render(React.createElement(kit.KitBox, { item: item() }, 'Текст'));
  assert.match(html, /data-kit-text="title"/);
  assert.match(html, /left:90px;top:300px;width:840px;height:200px/);
  assert.match(html, /transform:translate\(/);
  assert.equal(render(React.createElement(kitAt(5).KitBox, { item: item() }, 'Текст')), '');
  assert.doesNotMatch(render(React.createElement(kit.KitBox, { item: item({ kind: 'media' }) }, 'x')), /data-kit-text/);
});

test('KitBox hides frames that are inside [from, until) but not yet opaque, using the same rule as the manifest', () => {
  // frame === from: вход ещё не стартовал, opacity animOf у fly/pop равна 0 в самом первом
  // кадре — манифест (itemExtentAt) в этом кадре тоже должен вернуть null, KitBox обязан
  // рисовать то же самое, а не полупрозрачный div с data-kit-text.
  const atFrom = kitAt(10);
  assert.equal(render(React.createElement(atFrom.KitBox, { item: item() }, 'Текст')), '');
  assert.equal(atFrom.itemExtentAt(item(), 10, 25), null);

  // frame === until - 1: последний реально отрисованный кадр, но по расчёту exit прозрачность
  // здесь уже дошла до 0 — манифест в этом же кадре тоже не увидит элемент.
  const atLastFrame = kitAt(59);
  assert.equal(render(React.createElement(atLastFrame.KitBox, { item: item() }, 'Текст')), '');
  assert.equal(atLastFrame.itemExtentAt(item(), 59, 25), null);

  // frame === until: формально уже вне окна показа — тоже ничего не рисуем.
  const atUntil = kitAt(60);
  assert.equal(render(React.createElement(atUntil.KitBox, { item: item() }, 'Текст')), '');
});

test('bleed items stay visible but never get the safe-zone text marker', () => {
  const kit = kitAt(30);
  const html = render(React.createElement(kit.KitBox, { item: item({ bleed: true }) }, 'Текст'));
  assert.doesNotMatch(html, /data-kit-text/);
  assert.notEqual(html, '');
});

test('KitBox refuses a raw plan item: needs compiled from/until frame numbers, not plan seconds', () => {
  const kit = kitAt(30);
  // Форма из plan.js: at/until в секундах монтажного листа. until называется так же, как в
  // скомпилированном виде, но from нет вообще — типичная ошибка «забыли compileLayer/compileItems».
  const planShapedItem = { id: 'title', at: 0.4, until: 2.4 };
  assert.throws(
    () => render(React.createElement(kit.KitBox, { item: planShapedItem }, 'Текст')),
    /KitBox needs a compiled item with frame numbers from compileLayer\/compileItems/
  );
});

// Переводит стиль KitBox (left/top/width/height + translate/scale/rotate вокруг центра) обратно
// в осепараллельный габарит — то же вычисление, что itemExtentAt делает из «сырых» a.dx/a.dy/a.s.
function bboxFromStyle(style) {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\) rotate\(([-\d.]+)deg\)/.exec(style.transform);
  assert.ok(m, `unexpected transform: ${style.transform}`);
  const [, dxStr, dyStr, sStr, rotStr] = m;
  const dx = Number(dxStr);
  const dy = Number(dyStr);
  const s = Number(sStr);
  const rot = Number(rotStr);
  const { left, top, width: w, height: h } = style;
  const th = (Math.abs(rot) * Math.PI) / 180;
  const hw = ((w * Math.abs(Math.cos(th)) + h * Math.abs(Math.sin(th))) / 2) * s;
  const hh = ((w * Math.abs(Math.sin(th)) + h * Math.abs(Math.cos(th))) / 2) * s;
  const cx = left + w / 2 + dx;
  const cy = top + h / 2 + dy;
  return { left: cx - hw, top: cy - hh, right: cx + hw, bottom: cy + hh };
}

test('kitBoxStyle draws exactly the box itemExtentAt measures for the same frame (the gate sees what is drawn)', () => {
  // kitBoxStyle/itemExtentAt — чистые функции с явным (item, frame, fps): один и тот же bundle
  // годится для любого frame/fps, стаб используется только когда нужно смонтировать сам KitBox.
  const kit = kitAt(0);
  const popItem = item({ id: 'pop-item', enter: { kind: 'pop' }, rot: 20, from: 10, until: 100,
    box: { x: 200, y: 400, w: 300, h: 150 } });
  const flyItem = item({ id: 'fly-item', enter: { kind: 'fly', from: [-200, 0] }, rot: 0, from: 10, until: 100,
    box: { x: 500, y: 300, w: 400, h: 200 } });

  for (const fps of [25, 50]) {
    for (const testItem of [popItem, flyItem]) {
      const { from, until } = testItem;
      // Кадры вдоль входа, жизни и выхода: from и until-1 обычно невидимы (проверено отдельно
      // для дефолтного fly выше), остальные покрывают вход, середину жизни и начало выхода.
      const frames = [from, from + 1, from + 3, Math.floor((from + until) / 2), until - 6, until - 1];
      for (const frame of frames) {
        const ext = kit.itemExtentAt(testItem, frame, fps);
        if (ext === null) {
          const kitAtFrame = kitAt(frame, { fps });
          const html = render(React.createElement(kitAtFrame.KitBox, { item: testItem }, 'x'));
          assert.equal(html, '', `${testItem.id} fps=${fps} frame=${frame}: itemExtentAt null, KitBox must render nothing`);
          continue;
        }
        const style = kit.kitBoxStyle(testItem, frame, fps);
        const drawn = bboxFromStyle(style);
        for (const side of ['left', 'top', 'right', 'bottom']) {
          assert.ok(
            Math.abs(drawn[side] - ext[side]) <= 0.05,
            `${testItem.id} fps=${fps} frame=${frame} ${side}: style says ${drawn[side]}, manifest says ${ext[side]}`
          );
        }
      }
    }
  }
});
