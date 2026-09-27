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
    /KitBox ждёт скомпилированный элемент с кадрами from\/until/
  );
});

// Переводит стиль KitBox (left/top/width/height + translate/scale/rotate вокруг центра) обратно
// в осепараллельный габарит — то же вычисление, что itemExtentAt делает из «сырых» a.dx/a.dy/a.s.
function bboxFromStyle(style) {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\) rotate\(([-\d.]+)deg\)/.exec(style.transform);
  assert.ok(m, `unexpected transform: ${style.transform}`);
  assert.equal(style.transformOrigin, 'center center');
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

test('SpeakerLayer renders one muted video with the camera transform, fills side shots and freezes the tail', () => {
  const base = kitAt(10);
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250 };
  const track = base.compileCamera({ face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'L' }] }, cfg);
  const one = render(React.createElement(base.SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  assert.equal((one.match(/<video/g) || []).length, 1);
  assert.match(one, /muted=""/);
  assert.match(one, /transform-origin:540px 787px/);
  const side = render(React.createElement(kitAt(60).SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  assert.equal((side.match(/<video/g) || []).length, 2);
  const tail = render(React.createElement(kitAt(230).SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  assert.match(tail, /data-freeze="200"/);
  const away = base.withAways(track, [{ from: 100, to: 150 }]);
  assert.equal(render(React.createElement(kitAt(120).SpeakerLayer, { src: 'speaker.mp4', track: away, lastFrame: 200 })), '');
});

// left/top задают положение верхнего левого угла ДО transform — это и есть transform-origin
// «0 0» для scale(), поэтому он остаётся на месте, а правый/нижний угол уезжает на width/height*scale.
function fillBoxFromStyle(style) {
  const m = /scale\(([-\d.]+)\)/.exec(style.transform);
  assert.ok(m, `unexpected fill transform: ${style.transform}`);
  assert.equal(style.transformOrigin, '0 0');
  const s = Number(m[1]);
  const { left, top, width: w, height: h } = style;
  return { left, top, right: left + w * s, bottom: top + h * s };
}

test('speakerFillStyle overscans the frame with a blur-safe margin (>= 15px, >= 3 sigma of blur 5px) on every side', () => {
  const kit = kitAt(0);
  for (const [width, height] of [[1080, 1920], [1920, 1080]]) {
    const box = fillBoxFromStyle(kit.speakerFillStyle({ width, height }));
    assert.ok(-box.left >= 15, `${width}x${height}: left margin ${-box.left}`);
    assert.ok(-box.top >= 15, `${width}x${height}: top margin ${-box.top}`);
    assert.ok(box.right - width >= 15, `${width}x${height}: right margin ${box.right - width}`);
    assert.ok(box.bottom - height >= 15, `${width}x${height}: bottom margin ${box.bottom - height}`);
  }
});

test('speakerTransform framing matches what the gates read: face moves by exactly dx/dy and non-fill shots leave no edge gap', () => {
  // Прогон по всем официальным пресетам плюс панч на двух соотношениях сторон — та же проверка,
  // что делают гейты G1/G2 по манифесту камеры. Регэксп жёстко требует порядок «translate() scale()»:
  // если он поменяется на «scale() translate()», exec вернёт null и assert.ok упадёт на первом кадре.
  const kit = kitAt(0);
  for (const [width, height, face] of [[1080, 1920, { x: 540, y: 787 }], [1920, 1080, { x: 960, y: 443 }]]) {
    const cfg = { fps: 25, width, height, durationInFrames: 400 };
    const track = kit.compileCamera({
      face,
      shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'M' }, { at: 4, preset: 'L' }, { at: 6, preset: 'R' }, { at: 8, preset: 'top' }, { at: 10, preset: 'M', dx: 400 }],
      punches: [{ at: 1, until: 1.8 }],
    }, cfg);
    for (let frame = 0; frame < 400; frame += 1) {
      const state = kit.cameraAt(track, frame);
      const style = kit.speakerTransform(state, track);
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(style.transform);
      assert.ok(m, `${width}x${height}@${frame}: unexpected transform ${style.transform}`);
      const [dx, dy, s] = m.slice(1).map(Number);
      const [ox, oy] = style.transformOrigin.split(' ').map((v) => parseFloat(v));
      const map = (x, y) => [ox + dx + s * (x - ox), oy + dy + s * (y - oy)];
      const [fx, fy] = map(face.x, face.y);
      assert.ok(Math.abs(fx - (face.x + state.dx)) <= 0.01, `${width}x${height}@${frame}: face x off by ${fx - (face.x + state.dx)}`);
      assert.ok(Math.abs(fy - (face.y + state.dy)) <= 0.01, `${width}x${height}@${frame}: face y off by ${fy - (face.y + state.dy)}`);
      if (!state.fill) {
        const [l, t] = map(0, 0);
        const [r, b] = map(width, height);
        assert.ok(l <= 0.1, `${width}x${height}@${frame}: left gap ${l}`);
        assert.ok(t <= 0.1, `${width}x${height}@${frame}: top gap ${t}`);
        assert.ok(width - r <= 0.1, `${width}x${height}@${frame}: right gap ${width - r}`);
        assert.ok(height - b <= 0.1, `${width}x${height}@${frame}: bottom gap ${height - b}`);
      }
    }
  }
});

test('speakerTransform stays pure geometry (no opacity) and only adds blur/brightness once they are visually meaningful', () => {
  const kit = kitAt(0);
  const track = { width: 1080, height: 1920, face: { x: 540, y: 787 } };
  const base = { s: 1, dx: 0, dy: 0 };
  assert.equal(kit.speakerTransform({ ...base, blur: 0, dim: 1, opacity: 0.4 }, track).opacity, undefined);
  assert.equal(kit.speakerTransform({ ...base, blur: 0.05, dim: 1 }, track).filter, undefined);
  assert.match(kit.speakerTransform({ ...base, blur: 0.06, dim: 1 }, track).filter, /^blur\(0\.06px\)$/);
  assert.equal(kit.speakerTransform({ ...base, blur: 0, dim: 0.999 }, track).filter, undefined);
  assert.match(kit.speakerTransform({ ...base, blur: 0, dim: 0.998 }, track).filter, /^brightness\(0\.998\)$/);
  assert.match(kit.speakerTransform({ ...base, blur: 10, dim: 0.5 }, track).filter, /^blur\(10\.00px\) brightness\(0\.500\)$/);
});

test('SpeakerLayer forwards trimBefore to the underlying video and omits it when absent', () => {
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250 };
  const kit = kitAt(10);
  const track = kit.compileCamera({ face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }] }, cfg);
  const trimmed = render(React.createElement(kit.SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200, trimBefore: 25 }));
  assert.match(trimmed, /data-trim-before="25"/);
  const untrimmed = render(React.createElement(kit.SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  assert.doesNotMatch(untrimmed, /data-trim-before/);
});

test('SpeakerLayer keeps Freeze mounted and toggles active instead of remounting the video across lastFrame', () => {
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250 };
  const track = kitAt(0).compileCamera({ face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'L' }] }, cfg);
  const atLast = render(React.createElement(kitAt(200).SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  assert.doesNotMatch(atLast, /data-freeze/);
  const afterLast = render(React.createElement(kitAt(201).SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  // Кадр 201 внутри бокового плана L (fill:true) — заморожены обе копии: фон и основной кадр.
  assert.equal((afterLast.match(/data-freeze="200"/g) || []).length, 2);
});

test('SpeakerLayer fades the fill and main copies together via the group opacity, not per-copy geometry', () => {
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250 };
  const compiled = kitAt(0).compileCamera({ face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'L' }] }, cfg);
  const away = kitAt(0).withAways(compiled, [{ from: 100, to: 150 }]);
  const frame = 104; // уход поднялся наполовину (enterFrames=8): opacity строго между 0 и 1
  const kit = kitAt(frame);
  const state = kit.cameraAt(away, frame);
  assert.ok(state.visible && state.opacity > 0.01 && state.opacity < 0.99, `нужен частичный уход, opacity=${state.opacity}`);
  const html = render(React.createElement(kit.SpeakerLayer, { src: 'speaker.mp4', track: away, lastFrame: 200 }));
  const outer = /<div style="([^"]*)"/.exec(html);
  assert.ok(outer, `no styled outer div found: ${html}`);
  assert.match(outer[1], /opacity:0\.5/);
});

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
