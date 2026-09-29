const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { loadEsm } = require('./helpers/load-esm');
const { remotionStub, render } = require('./helpers/remotion-stub');

const kitAt = (frame, { fps = 25, width, height, calls = {} } = {}) => loadEsm('src/motion-kit/index.js', { stubs: { remotion: remotionStub({ frame, fps, width, height, calls }) } });
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
  // кадре – манифест (itemExtentAt) в этом кадре тоже должен вернуть null, KitBox обязан
  // рисовать то же самое, а не полупрозрачный div с data-kit-text.
  const atFrom = kitAt(10);
  assert.equal(render(React.createElement(atFrom.KitBox, { item: item() }, 'Текст')), '');
  assert.equal(atFrom.itemExtentAt(item(), 10, 25), null);

  // frame === until - 1: последний реально отрисованный кадр, но по расчёту exit прозрачность
  // здесь уже дошла до 0 – манифест в этом же кадре тоже не увидит элемент.
  const atLastFrame = kitAt(59);
  assert.equal(render(React.createElement(atLastFrame.KitBox, { item: item() }, 'Текст')), '');
  assert.equal(atLastFrame.itemExtentAt(item(), 59, 25), null);

  // frame === until: формально уже вне окна показа – тоже ничего не рисуем.
  const atUntil = kitAt(60);
  assert.equal(render(React.createElement(atUntil.KitBox, { item: item() }, 'Текст')), '');
});

// Ревью задачи 23 (minor): на первом кадре маски (p=0) clip закрывает 100% ширины – KitBox
// обязан рисовать ту же пустоту, что видит манифест (itemExtentAt null), а не полупрозрачный
// (на деле – полностью закрытый) div с data-kit-text.
test('KitBox renders nothing on a fully closed mask frame, matching itemExtentAt null', () => {
  const maskItem = item({ enter: { kind: 'mask' } }); // from: 10, until: 60
  const atFrom = kitAt(10);
  assert.equal(render(React.createElement(atFrom.KitBox, { item: maskItem }, 'Текст')), '');
  assert.equal(atFrom.itemExtentAt(maskItem, 10, 25), null);
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
  // скомпилированном виде, но from нет вообще – типичная ошибка «забыли compileLayer/compileItems».
  const planShapedItem = { id: 'title', at: 0.4, until: 2.4 };
  assert.throws(
    () => render(React.createElement(kit.KitBox, { item: planShapedItem }, 'Текст')),
    /KitBox ждёт скомпилированный элемент с кадрами from\/until/
  );
});

// Переводит стиль KitBox (left/top/width/height + translate/scale/rotate вокруг центра) обратно
// в осепараллельный габарит – то же вычисление, что itemExtentAt делает из «сырых» a.dx/a.dy/a.s.
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

// left/top задают положение верхнего левого угла ДО transform – это и есть transform-origin
// «0 0» для scale(), поэтому он остаётся на месте, а правый/нижний угол уезжает на width/height*scale.
function fillBoxFromStyle(style) {
  const m = /scale\(([-\d.]+)\)/.exec(style.transform);
  assert.ok(m, `unexpected fill transform: ${style.transform}`);
  assert.equal(style.transformOrigin, '0 0');
  const s = Number(m[1]);
  const { left, top, width: w, height: h } = style;
  return { left, top, right: left + w * s, bottom: top + h * s };
}

test('speakerFillStyle overscans the frame with a blur-safe margin (>= 3 sigma of the on-screen blur) on every side', () => {
  // Видимый на экране радиус размытия (сигма) равен blurPx * scale, потому что blur(...)
  // применяется ДО scale() в transform: сам фильтр работает в исходных px копии, а масштаб потом
  // растягивает картинку (и вместе с ней радиус размытия) в scale раз.
  const kit = kitAt(0);
  for (const [width, height] of [[1080, 1920], [1920, 1080]]) {
    const style = kit.speakerFillStyle({ width, height });
    const blurMatch = /blur\(([\d.]+)px\)/.exec(style.filter);
    assert.ok(blurMatch, `no blur() in filter: ${style.filter}`);
    const scaleMatch = /scale\(([-\d.]+)\)/.exec(style.transform);
    assert.ok(scaleMatch, `no scale() in transform: ${style.transform}`);
    const minMargin = 3 * Number(blurMatch[1]) * Number(scaleMatch[1]);
    const box = fillBoxFromStyle(style);
    assert.ok(-box.left >= minMargin, `${width}x${height}: left margin ${-box.left} < ${minMargin}`);
    assert.ok(-box.top >= minMargin, `${width}x${height}: top margin ${-box.top} < ${minMargin}`);
    assert.ok(box.right - width >= minMargin, `${width}x${height}: right margin ${box.right - width} < ${minMargin}`);
    assert.ok(box.bottom - height >= minMargin, `${width}x${height}: bottom margin ${box.bottom - height} < ${minMargin}`);
  }
});

test('speakerTransform framing matches what the gates read: face moves by exactly dx/dy and non-fill shots leave no edge gap', () => {
  // Прогон по всем официальным пресетам плюс панч на двух соотношениях сторон – та же проверка,
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
        assert.ok(l <= 0.01, `${width}x${height}@${frame}: left gap ${l}`);
        assert.ok(t <= 0.01, `${width}x${height}@${frame}: top gap ${t}`);
        assert.ok(width - r <= 0.01, `${width}x${height}@${frame}: right gap ${width - r}`);
        assert.ok(height - b <= 0.01, `${width}x${height}@${frame}: bottom gap ${height - b}`);
      }
    }
  }
});

// Проба Task 49: на планах с заливкой (L/R, top, свой пресет с dy) резкая копия обрывалась жёстким
// швом над размытой заливкой. Теперь у резкой копии мягкий край: маска по x на самой копии и по y на
// вложенном блоке, каждая от прозрачного на самом краю копии до непрозрачного через featherPx
// (× короткая сторона / 1080) пикселей кадра. Проверяем на каждом кадре: каждый край, оказавшийся
// внутри кадра, растушёван не меньше чем на featherPx, и маска начинается с прозрачного ровно на краю.
test('fill shots feather every edge of the sharp speaker that lands inside the frame; non-fill shots get no mask', () => {
  const kit = kitAt(0);
  for (const [width, height, face] of [[1080, 1920, { x: 540, y: 787 }], [1920, 1080, { x: 960, y: 443 }]]) {
    const k = Math.min(width, height) / 1080;
    const cfg = { fps: 25, width, height, durationInFrames: 500 };
    const track = kit.compileCamera({
      face, presets: { low: { s: 1.1, dy: -260, fill: true } },
      shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'L' }, { at: 4, preset: 'R', drift: 'out' }, { at: 6, preset: 'top' },
        { at: 8, preset: 'low' }, { at: 10, preset: 'M', dx: 400 }, { at: 12, preset: 'L', drift: 'none' }],
      punches: [{ at: 4.5, until: 5.2 }],
    }, cfg);
    let feathered = 0;
    for (let frame = 0; frame < 500; frame += 1) {
      const state = kit.cameraAt(track, frame);
      const mask = kit.speakerEdgeMask(state, track);
      if (!state.fill) { assert.equal(mask, null, `${width}x${height}@${frame}: маска без заливки`); continue; }
      const px = mask.feather.toFixed(3);
      for (const [axis, to] of [['x', 'right'], ['y', 'bottom']]) {
        const image = mask[axis].maskImage;
        assert.ok(image.startsWith(`linear-gradient(to ${to}, transparent 0px, `), image);
        assert.ok(image.includes(`, #000 ${px}px, #000 calc(100% - ${px}px), `), image);
        assert.ok(image.endsWith(', transparent 100%)'), image);
      }
      // края резкой копии в px кадра (transform: translate(dx, dy) scale(s) вокруг точки лица)
      const inside = {
        left: face.x * (1 - state.s) + state.dx > 0.01,
        right: face.x + state.dx + state.s * (width - face.x) < width - 0.01,
        top: face.y * (1 - state.s) + state.dy > 0.01,
        bottom: face.y + state.dy + state.s * (height - face.y) < height - 0.01,
      };
      if (!Object.values(inside).some(Boolean)) continue;
      feathered += 1;
      // маска масштабируется вместе с копией: ширина в px кадра = локальная ширина × s
      assert.ok(mask.feather * state.s >= kit.CAMERA_DEFAULTS.fill.featherPx * k - 1e-6,
        `${width}x${height}@${frame}: открытый край растушёван только на ${mask.feather * state.s} px`);
    }
    assert.ok(feathered > 100, `${width}x${height}: проверка не увидела ни одного открытого края (${feathered})`);
  }
});

test('SpeakerLayer puts the soft-edge masks only on the sharp copy of a fill shot, never on the fill itself', () => {
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250 };
  const track = kitAt(0).compileCamera({ face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'L' }] }, cfg);
  const side = render(React.createElement(kitAt(60).SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  const styles = [...side.matchAll(/<div style="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(styles.length, 4, side);
  assert.doesNotMatch(styles[1], /mask/, 'заливка не растушёвывается');
  assert.match(styles[2], /transform:translate\(.*mask-image:linear-gradient\(to right, transparent 0px/);
  assert.match(styles[3], /mask-image:linear-gradient\(to bottom, transparent 0px/);
  assert.doesNotMatch(side, /mask-composite/, 'intersect в Chrome оставлял светлую линию на краю копии');
  assert.doesNotMatch(render(React.createElement(kitAt(10).SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 })), /mask/);
});

// Ревью мягкого края: вложенный блок маски обязан всегда растягиваться на весь кадр копии, иначе
// height: 100% видео считается от блока с высотой auto и cover-кадрирование пропадает (исходник
// другой пропорции оставлял чёрную полосу на плане без заливки).
test('SpeakerLayer always stretches the inner mask block over the whole copy, with and without fill', () => {
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250 };
  const track = kitAt(0).compileCamera({ face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'L' }] }, cfg);
  for (const frame of [10, 60]) {
    const html = render(React.createElement(kitAt(frame).SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
    const styles = [...html.matchAll(/<div style="([^"]*)"/g)].map((m) => m[1]);
    const inner = styles.at(-1);
    assert.match(inner, /^position:absolute;inset:0/, `frame ${frame}: ${html}`);
    assert.doesNotMatch(inner, /transform/, `frame ${frame}: последний блок – вложенный, а не сама копия`);
    assert.doesNotMatch(html, /<div>/, `frame ${frame}: блок без стиля ломает cover-кадрирование`);
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
  // Кадр 200 внутри бокового плана L (fill:true) – обе копии смонтированы через Freeze, но ещё
  // не держат кадр (active=false): data-freeze-active="false" доказывает, что обёртка осталась
  // на месте, а не пропала вместе с video, как было бы при условном рендере <Freeze> целиком.
  assert.equal((atLast.match(/data-freeze-active="false"/g) || []).length, 2);
  assert.doesNotMatch(atLast, /data-freeze="/);
  const afterLast = render(React.createElement(kitAt(201).SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  // Кадр 201 внутри того же плана – заморожены обе копии: фон и основной кадр.
  assert.equal((afterLast.match(/data-freeze="200"/g) || []).length, 2);
  assert.equal((afterLast.match(/data-freeze-active="true"/g) || []).length, 2);
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
  const styles = [...html.matchAll(/<div style="([^"]*)"/g)].map((m) => m[1]);
  // Ровно один styled div на каждую копию (fill + main) плюс внешняя группа; Freeze-обёртки стиля
  // не несут. opacity должна стоять только на внешней группе – по копиям делать нечего.
  // У резкой копии всегда есть вложенный блок (на плане с заливкой – с маской по y, speakerEdgeMask).
  assert.equal(styles.length, state.fill ? 4 : 3, `unexpected number of styled divs: ${html}`);
  assert.match(styles[0], /opacity:0\.5/);
  for (const inner of styles.slice(1)) assert.doesNotMatch(inner, /opacity/);
});

test('kitBoxStyle draws exactly the box itemExtentAt measures for the same frame (the gate sees what is drawn)', () => {
  // kitBoxStyle/itemExtentAt – чистые функции с явным (item, frame, fps): один и тот же bundle
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

test('FullscreenReveal opens from a safe-zone card to the full frame and closes before the end', () => {
  const kit = kitAt(0);
  const insert = { id: 'stock-1', kind: 'stock', from: 50, to: 100, src: 'stock/a.mp4', kb: [1.03, 1.1], cover: true };
  assert.equal(kit.revealProgress(49, insert), null);
  assert.equal(kit.revealProgress(50, insert), 0);
  assert.equal(kit.revealProgress(70, insert), 1);
  assert.ok(kit.revealProgress(98, insert) < 1);
  const html = render(React.createElement(kitAt(70).StockInsert, { insert }));
  assert.match(html, /data-kit-bleed="stock-1"/);
  assert.match(html, /data-sequence-from="50"/);
  // Сток проигрывается ровно insert.to - insert.from кадров своей Sequence, а не до конца композиции.
  assert.match(html, /data-sequence-duration="50"/);
  assert.match(html, /<video src="\/static\/stock\/a\.mp4" muted=""/);
  assert.equal(render(React.createElement(kitAt(120).StockInsert, { insert })), '');
});

// CARD не жёсткая константа под 1080x1920 (та давала карточку высотой 240px на 1920x1080) –
// revealCard(width, height) считает инсеты от той же safe-зоны, что и текст, поэтому подходит
// под оба соотношения сторон.
test('revealCard derives its card insets from the safe-zone rect for both aspect ratios', () => {
  const kit = kitAt(0);
  const safe9x16 = kit.safeRect(1080, 1920);
  assert.deepEqual(kit.revealCard(1080, 1920), {
    top: safe9x16.top, right: 1080 - safe9x16.right, bottom: 1920 - safe9x16.bottom, left: safe9x16.left,
  });
  const safe16x9 = kit.safeRect(1920, 1080);
  assert.deepEqual(kit.revealCard(1920, 1080), {
    top: safe16x9.top, right: 1920 - safe16x9.right, bottom: 1080 - safe16x9.bottom, left: safe16x9.left,
  });
});

test('FullscreenReveal clips to nothing (full frame, no rounding) once revealProgress reaches 1', () => {
  const insert = { id: 'stock-1', kind: 'stock', from: 50, to: 100, src: 'stock/a.mp4' };
  const html = render(React.createElement(kitAt(70).FullscreenReveal, { insert }, 'x'));
  assert.match(html, /clip-path:inset\(0\.0px 0\.0px 0\.0px 0\.0px round 0\.0px\)/);
});

// Радиус масштабируется под РЕАЛЬНОЕ разрешение, не только под канонические 1080x1920/1920x1080:
// 28 * 720/1080 ≈ 18.7px на p=0 (начало вставки, карточка ещё не открылась).
test('FullscreenReveal scales its corner radius for a non-standard resolution too (720x1280)', () => {
  const insert = { id: 'stock-1', kind: 'stock', from: 50, to: 100, src: 'stock/a.mp4' };
  const html = render(React.createElement(kitAt(50, { width: 720, height: 1280 }).FullscreenReveal, { insert }, 'x'));
  assert.match(html, /round 18\.7px\)/);
});

// Task 15 fix: revealProgress и insertOpacity читают одно closeWindow – на последнем реально
// отрисованном кадре (to − 1) opacity доходит ровно до 0, и FullscreenReveal обязан рисовать
// пустоту (isShown/VISIBLE_MIN), а не декодировать фактически невидимый кадр стока; в середине
// close, пока opacity ещё дробная, разметка должна нести именно это число.
test('FullscreenReveal renders nothing on the fully-closed last frame and the true fractional opacity mid-close', () => {
  const insert = { id: 'stock-1', kind: 'stock', from: 50, to: 100, src: 'stock/a.mp4' };
  const kit = kitAt(0);
  const lastFrame = insert.to - 1;
  assert.equal(kit.insertOpacity(lastFrame, insert), 0);
  assert.equal(render(React.createElement(kitAt(lastFrame).FullscreenReveal, { insert }, 'x')), '');

  const midClose = 97; // внутри close-окна (closeStart=94..closeEnd=99 при fps 25), но ещё виден
  const expectedOpacity = kit.insertOpacity(midClose, insert);
  assert.ok(expectedOpacity > 0 && expectedOpacity < 1, `ожидали дробную прозрачность в close, получили ${expectedOpacity}`);
  const html = render(React.createElement(kitAt(midClose).FullscreenReveal, { insert }, 'x'));
  assert.match(html, new RegExp(`opacity:${String(expectedOpacity).replace('.', '\\.')}`));
});

// Гарантия из Step 0: не только StockInsert, но и сам FullscreenReveal отказывается рисовать
// «сырую» вставку с секундами вместо скомпилированных кадров – чтобы будущие screen/scene
// вставки, вызывающие FullscreenReveal напрямую, тоже получили эту защиту.
test('FullscreenReveal refuses a raw plan-shaped insert with seconds instead of compiled frames', () => {
  const kit = kitAt(0);
  const planShaped = { id: 'stock-1', kind: 'stock', from: 2, to: 4.4, src: 'stock/a.mp4' };
  assert.throws(
    () => render(React.createElement(kit.FullscreenReveal, { insert: planShaped }, 'x')),
    /FullscreenReveal ждёт скомпилированную вставку с кадрами from\/to/,
  );
});

// Пин точных цифр, которые видит зритель: card insets в inset() посчитаны от safeRect (проверено
// отдельно выше), а сама строка clip-path обязана собирать их в правильном порядке (top right
// bottom left) – перестановка left/right молча ломает форму карточки, не ломая ни одного теста
// на голые числа revealCard.
test('FullscreenReveal draws the exact open-card clip-path for both aspect ratios at the start of the insert', () => {
  const insert = { id: 'stock-1', kind: 'stock', from: 50, to: 100, src: 'stock/a.mp4' };
  const portrait = render(React.createElement(kitAt(50, { width: 1080, height: 1920 }).FullscreenReveal, { insert }, 'x'));
  assert.match(portrait, /clip-path:inset\(250\.0px 130\.0px 420\.0px 70\.0px round 28\.0px\)/);
  const landscape = render(React.createElement(kitAt(50, { width: 1920, height: 1080 }).FullscreenReveal, { insert }, 'x'));
  assert.match(landscape, /clip-path:inset\(60\.0px 80\.0px 60\.0px 80\.0px round 28\.0px\)/);
});

test('StockInsert Ken Burns zoom rises linearly from kb[0] at from to kb[1] near to', () => {
  const insert = { id: 'stock-1', kind: 'stock', from: 50, to: 100, src: 'stock/a.mp4', kb: [1.03, 1.1] };
  const at = (frame) => render(React.createElement(kitAt(frame).StockInsert, { insert }));
  assert.match(at(50), /scale\(1\.0300\)/);
  assert.match(at(75), /scale\(1\.0650\)/);
  // frame 99 (to-1) – не 98: с общим close-окном (Task 15 fix) insertOpacity там уже 0, и
  // FullscreenReveal/StockInsert теперь ничего не рисуют на фактически невидимом кадре.
  assert.match(at(98), /scale\(1\.0972\)/);
});

// kb необязателен в контракте (`kb?: [1.03, 1.1]`) – StockInsert подставляет дефолт сам, а не
// падает на insert.kb[0], если вставка ещё не прошла compileInserts (там дефолт уже есть тоже)
// или её собрали вручную без него.
test('StockInsert defaults kb to [1.03, 1.1] and renders without throwing when it is absent', () => {
  const insert = { id: 'stock-2', kind: 'stock', from: 50, to: 100, src: 'stock/b.mp4' };
  assert.doesNotThrow(() => render(React.createElement(kitAt(70).StockInsert, { insert })));
  const html = render(React.createElement(kitAt(50).StockInsert, { insert }));
  assert.match(html, /scale\(1\.0300\)/);
});

// StockInsert стоит на верхнем уровне композиции, как SpeakerLayer, а не внутри чужой Sequence –
// поэтому он ждёт уже скомпилированную вставку (compileInserts) с кадрами from/to, а не секунды
// плана. Та же ошибка, что ловит KitBox для items.
test('StockInsert refuses a raw plan-shaped insert with seconds instead of compiled frames', () => {
  const kit = kitAt(0);
  const planShaped = { id: 'stock-1', kind: 'stock', from: 2, to: 4.4, src: 'stock/a.mp4' };
  assert.throws(
    () => render(React.createElement(kit.StockInsert, { insert: planShaped })),
    /StockInsert ждёт скомпилированную вставку с кадрами from\/to/,
  );
});

test('revealProgress keeps the same reveal timing in seconds when fps doubles from 25 to 50', () => {
  const kit = kitAt(0);
  const insert = { id: 'stock-3', kind: 'stock', from: 0, to: 1000 };
  const revealFrames50 = 2 * kit.REVEAL_FRAMES;
  assert.ok(kit.revealProgress(revealFrames50 - 1, insert, 50) < 1);
  assert.equal(kit.revealProgress(revealFrames50, insert, 50), 1);
});

// Закрытие обязано доканчиваться ровно на последнем отрисованном кадре (to - 1), как выходы items
// в motion.js, а не на to; и CLOSE_FRAMES обязан пересчитываться под fps так же, как REVEAL_FRAMES.
test('revealProgress and insertOpacity finish the close exactly on the last drawn frame (to-1), and CLOSE_FRAMES scales with fps', () => {
  const kit = kitAt(0);
  for (const fps of [25, 50]) {
    const insert = { id: 'stock-4', kind: 'stock', from: 0, to: 200 };
    const closeStart = insert.to - kit.ref25(kit.CLOSE_FRAMES, fps);
    assert.equal(kit.revealProgress(closeStart - 1, insert, fps), 1, `fps ${fps}: close must not have started yet`);
    assert.ok(kit.revealProgress(closeStart + 1, insert, fps) < 1, `fps ${fps}: close must already be moving`);
    assert.equal(kit.revealProgress(insert.to - 1, insert, fps), 0, `fps ${fps}: card must be fully shrunk on the last drawn frame`);
    assert.equal(kit.insertOpacity(closeStart - 1, insert, fps), 1);
    assert.equal(kit.insertOpacity(insert.to - 1, insert, fps), 0);
  }
});

// Ревью Task 16: pixel maxScroll не может быть верным – plan.js не знает натуральную высоту
// картинки и рисковал проскроллить в белый низ раньше конца окна. scrollShare двигает долю (0..1)
// через objectPosition, а не пиксели: короткий скриншот просто почти не двигается, но никогда не
// уезжает мимо своего низа.
test('scrollShare eases smoothly from 0 at from to the full share at to, through the midpoint', () => {
  const kit = kitAt(0);
  assert.equal(kit.scrollShare(10, 10, 60, 1), 0);
  assert.equal(kit.scrollShare(60, 10, 60, 1), 1);
  assert.equal(kit.scrollShare(35, 10, 60, 1), 0.5, 'midpoint of a symmetric inOut ease must land exactly on 0.5');
});

test('scrollShare shows the ease-in near the start: far below the linear share', () => {
  const kit = kitAt(0);
  // from+5 в окне 50 кадров – линейно было бы 0.1; inOut-кривая на входе куда положе.
  assert.ok(kit.scrollShare(15, 10, 60, 1) < 0.1);
});

test('scrollShare clamps before from and at/after to, and clamps an out-of-range scroll to [0,1]', () => {
  const kit = kitAt(0);
  assert.equal(kit.scrollShare(5, 10, 60, 1), 0, 'before from must stay at 0, never negative');
  assert.equal(kit.scrollShare(70, 10, 60, 1), 1, 'past to must stay at the full share, never overscroll');
  assert.equal(kit.scrollShare(35, 10, 60, 1.5), kit.scrollShare(35, 10, 60, 1), 'scroll > 1 clamps to 1');
  assert.equal(kit.scrollShare(35, 10, 60, -0.3), 0, 'scroll < 0 clamps to 0');
});

test('ScrollShot fills the window via objectPosition (a page share, never a pixel offset that could overscroll)', () => {
  const html = render(React.createElement(kitAt(35).ScrollShot, { src: 'shots/page.png', from: 10, to: 60, scroll: 1 }));
  assert.match(html, /<img src="\/static\/shots\/page\.png"/);
  assert.match(html, /object-position:50% 50\.00%/, 'frame 35 is the exact midpoint of the 10..60 window');
  assert.doesNotMatch(html, /translateY/, 'no more pixel translateY – the old overscroll bug lived here');
  // Пин cover-режима: скриншот обязан заполнять всё окно карточки, а не оставлять поля.
  assert.match(html, /object-fit:cover/);
  assert.match(html, /height:100%/);
});

test('screenshot card renders inside BrowserFrame and shows the URL', () => {
  const html = render(React.createElement(kitAt(35).BrowserFrame, { url: 'example.com/page' },
    React.createElement(kitAt(35).ScrollShot, { src: 'shots/page.png', from: 10, to: 60 })));
  assert.match(html, /example\.com\/page/);
  assert.match(html, /<img src="\/static\/shots\/page\.png"/);
});

test('BrowserFrame chrome scales with the composition resolution (short side / 1080), a scale prop may override it', () => {
  assert.match(render(React.createElement(kitAt(0, { width: 1080, height: 1920 }).BrowserFrame, { url: 'x' }, 'x')), /height:64px/);
  // k = 720/1080 = 0.6667; 64 * k ≈ 42.7 – не 64px, иначе хром окна на нестандартном разрешении
  // рисуется в исходном (для 1080p) масштабе поверх реального кадра.
  assert.match(render(React.createElement(kitAt(0, { width: 720, height: 1280 }).BrowserFrame, { url: 'x' }, 'x')), /height:42\.7px/);
  // Тот же k = min(w,h)/1080 работает и на landscape: 1920x1080 (k=1) и 1280x720 (k≈0.6667) дают
  // те же цифры, что и портретные 1080x1920/720x1280 – доказывает, что масштаб зависит от короткой
  // стороны кадра, а не от того, что width стоит первым в паре.
  assert.match(render(React.createElement(kitAt(0, { width: 1920, height: 1080 }).BrowserFrame, { url: 'x' }, 'x')), /height:64px/);
  assert.match(render(React.createElement(kitAt(0, { width: 1280, height: 720 }).BrowserFrame, { url: 'x' }, 'x')), /height:42\.7px/);
  assert.match(render(React.createElement(kitAt(0, { width: 1080, height: 1920 }).BrowserFrame, { url: 'x', scale: 0.5 }, 'x')), /height:32px/);
});

test('BrowserFrame merges partial colors onto BROWSER_COLORS instead of losing the rest of the palette', () => {
  const kit = kitAt(0);
  // Раньше colors = {...} как дефолт параметра целиком заменялся переданным объектом: {bar:'#000'}
  // терял page/text (undefined background/цвет текста). Теперь дефолты мержатся.
  const html = render(React.createElement(kit.BrowserFrame, { url: 'x', colors: { bar: '#000000' } }, 'x'));
  assert.match(html, /background:#000000/);
  assert.match(html, new RegExp(`background:${kit.BROWSER_COLORS.page}`));
  assert.match(html, new RegExp(`color:${kit.BROWSER_COLORS.text}`));
});

test('BrowserFrame URL pill defaults to a sans-serif font (overridable), ellipsizes overflow via a block layout, and scales with resolution', () => {
  const kit = kitAt(0);
  const html = render(React.createElement(kit.BrowserFrame, { url: 'example.com/very/long/path' }, 'x'));
  assert.match(html, /font-family:sans-serif/);
  assert.match(html, /text-overflow:ellipsis/);
  // text-overflow:ellipsis не работает на анонимном flex-элементе – только display:block реально
  // обрезает длинный URL. Проверяем именно стиль пилюли (span с текстом урла), а не всей разметки:
  // соседние div'ы BrowserFrame остаются display:flex, это ожидаемо.
  const pillMatch = /<span style="([^"]*)">example\.com\/very\/long\/path<\/span>/.exec(html);
  assert.ok(pillMatch, `pill span not found: ${html}`);
  assert.match(pillMatch[1], /display:block/);
  assert.doesNotMatch(pillMatch[1], /display:flex/);
  // lineHeight равен той же px(36), что и height пилюли (при k=1 на 1080x1920 это 36px) – так
  // текст остаётся вертикально отцентрован без display:flex/align-items.
  assert.match(pillMatch[1], /line-height:36px/);
  const custom = render(React.createElement(kit.BrowserFrame, { url: 'x', fontFamily: 'Georgia, serif' }, 'x'));
  assert.match(custom, /font-family:Georgia, serif/);
  // На 720x1280 (k=720/1080≈0.6667) шрифт пилюли и диаметр цветных точек масштабируются тем же k,
  // что и высота бара.
  const small = render(React.createElement(kitAt(0, { width: 720, height: 1280 }).BrowserFrame, { url: 'x' }, 'x'));
  assert.match(small, /font-size:14\.7px/);
  assert.match(small, /width:10\.7px/);
});

test('flashOpacity keeps the plan-asserted values at the default fps 25', () => {
  const kit = kitAt(0);
  assert.equal(kit.flashOpacity(9, 10), 0);
  assert.ok(kit.flashOpacity(10, 10) > kit.flashOpacity(13, 10));
  assert.equal(kit.flashOpacity(16, 10), 0);
});

// Отклонение от плана: frames в ShutterFlash/flashOpacity – эталонные 25fps кадры (как
// REVEAL_FRAMES у вставок), а не кадры композиции. flashOpacity(frame, at, fps, frames) сам
// переводит их через ref25(frames, fps) внутри себя (единый смысл frames везде, компонент просто
// пробрасывает fps из useVideoConfig), поэтому на 50 fps вспышка длится столько же по времени,
// сколько на 25 fps: 6 эталонных кадров = 12 кадров композиции, ещё виден на at+11, погашен на at+12.
test('ShutterFlash keeps the same real-time flash duration at 50fps as at 25fps', () => {
  const at = 10;
  const visible = render(React.createElement(kitAt(at + 11, { fps: 50 }).ShutterFlash, { at }));
  assert.notEqual(visible, '', 'flash should still be visible at at+11 when running at 50fps');
  const gone = render(React.createElement(kitAt(at + 12, { fps: 50 }).ShutterFlash, { at }));
  assert.equal(gone, '', 'flash should be gone at at+12 when running at 50fps');
});

test('SfxTrack plays each kept cue at -5 dB by default and fades its tail', () => {
  const kit = kitAt(0);
  const cue = { id: 'whoosh-in@100', file: 'sfx/whoosh-in.wav', startFrame: 90, durationFrames: 30, vol: 0.7 };
  assert.ok(Math.abs(kit.cueVolume(cue, 0) - 0.7 * 10 ** (-5 / 20)) < 1e-9);
  assert.ok(Math.abs(kit.cueVolume(cue, 29) - 0.7 * 10 ** (-5 / 20) * 0.2) < 1e-9);
  assert.ok(Math.abs(kit.cueVolume(cue, 0, 0) - 0.7) < 1e-9);
  const html = render(React.createElement(kit.SfxTrack, { cues: [cue, { ...cue, id: 'b', startFrame: 200 }] }));
  assert.equal((html.match(/<audio/g) || []).length, 2);
  assert.match(html, /data-sequence-from="90" data-sequence-duration="30"/);
  assert.match(html, /src="\/static\/sfx\/whoosh-in\.wav"/);
});

// Отклонение от плана: fade – не жёсткая константа в 5 кадров, а ref25(5, fps) эталонных кадров,
// иначе на 50fps хвост звука затухал бы вдвое быстрее по времени, чем на 25fps (5 кадров на 50fps
// – это всего 0.1с вместо 0.2с). cueVolume принимает fps четвёртым параметром (по умолчанию 25,
// поэтому все проверки выше при дефолтном fps не меняются); SfxTrack сам берёт fps из
// useVideoConfig() и передаёт его в volume-callback каждой Sequence.
test('cueVolume fades over the same real time at fps 50: a 60-frame cue fades over its last 10 frames', () => {
  const kit = kitAt(0);
  const cue = { id: 'long@0', file: 'sfx/long.wav', startFrame: 0, durationFrames: 60, vol: 0.7 };
  const full = kit.cueVolume(cue, 0, -5, 50);
  assert.ok(Math.abs(kit.cueVolume(cue, 50, -5, 50) - full) < 1e-9, 'local frame 50: fade has not started yet, full volume');
  assert.ok(Math.abs(kit.cueVolume(cue, 55, -5, 50) - full * 0.5) < 1e-9, 'local frame 55: exactly halfway through the 10-frame fade');
  assert.ok(Math.abs(kit.cueVolume(cue, 59, -5, 50) - full * 0.1) < 1e-9, 'local frame 59: one frame before the cue ends, 0.1 of full');
});

// Ревью code-quality к Task 17 (мутационное тестирование): remotion-stub всегда зовёт volume(0),
// поэтому предыдущие тесты SfxTrack проверяли cueVolume только как отдельную чистую функцию –
// сам компонент мог бы молча звать её как cueVolume(cue, f) или cueVolume(cue, f, masterDb),
// потеряв masterDb и/или fps композиции, и ни один существующий тест этого бы не заметил (обе
// «урезанные» сигнатуры дают ровно то же значение на localFrame=0, где стаб всё и проверяет).
// Здесь Audio подменяется так, чтобы captured[0].volume был настоящим callback-ом из SfxTrack, и
// мы зовём его сами на разных локальных кадрах – а не полагаемся на то, что стаб вызовет его.
test('SfxTrack forwards both masterDb and the composition fps into cueVolume, not just cue and frame', () => {
  const captured = [];
  const stub = { ...remotionStub({ frame: 0, fps: 50 }), Audio: (p) => { captured.push(p); return null; } };
  const kit = loadEsm('src/motion-kit/index.js', { stubs: { remotion: stub } });
  const cue = { id: 'a', file: 'sfx/a.wav', startFrame: 0, durationFrames: 60, vol: 0.7 };
  render(React.createElement(kit.SfxTrack, { cues: [cue], masterDb: 0 }));
  assert.equal(captured.length, 1);
  assert.ok(Math.abs(captured[0].volume(0) - 0.7) < 1e-9, `local frame 0: expected full 0.7 (masterDb 0 dB), got ${captured[0].volume(0)}`);
  assert.ok(Math.abs(captured[0].volume(55) - 0.7 * 0.5) < 1e-9, `local frame 55 at fps 50: expected half (10-frame fade), got ${captured[0].volume(55)}`);
});

// Ревью code-quality к Task 17: границы уровня. cue.vol > 1 (кто-то поставил громкость плана
// «на глаз») не должен раздувать итоговую громкость выше исходника – клэмп в [0, 1]. masterDb
// обязан быть конечным числом ≤ 0: null из layer.json (поле sfxMasterDb не заполнено) не должен
// тихо стать 0 дБ – это совсем другая громкость, чем «оставить как есть»; undefined – это и есть
// «оставить как есть», поэтому только он держит дефолт −5.
test('cueVolume clamps cue.vol into [0,1] and rejects a masterDb that is not a finite number <= 0', () => {
  const kit = kitAt(0);
  const hot = { id: 'hot', file: 'sfx/hot.wav', startFrame: 0, durationFrames: 30, vol: 1.5 };
  assert.equal(kit.cueVolume(hot, 0, 0), 1, 'vol 1.5 at masterDb 0 dB, frame 0 (tail 1) must clamp to 1, not 1.5');
  const negative = { ...hot, vol: -0.4 };
  assert.equal(kit.cueVolume(negative, 0, 0), 0, 'a negative vol must clamp to 0, not go negative');
  const normal = { id: 'n', file: 'sfx/n.wav', startFrame: 0, durationFrames: 30, vol: 0.7 };
  assert.ok(Math.abs(kit.cueVolume(normal, 0, undefined) - 0.7 * 10 ** (-5 / 20)) < 1e-9, 'explicit undefined masterDb keeps the -5 default');
  // Отклонение (ревью Task 18): cueVolume и SfxTrack теперь делят одну assertMasterDb (sfx.js) с
  // сообщением "layer.json → sfxMasterDb" – регексп проверяет именно эту (более информативную)
  // формулировку, а не старый внутренний "cueVolume: masterDb …".
  assert.throws(() => kit.cueVolume(normal, 0, null), /sfxMasterDb/, 'null must not silently become 0 dB');
  assert.throws(() => kit.cueVolume(normal, 0, NaN), /sfxMasterDb/);
  assert.throws(() => kit.cueVolume(normal, 0, 3), /sfxMasterDb/, 'a positive masterDb (boosting effects) is rejected');
});

test('assertMasterDb is the single validator shared by cueVolume and SfxTrack', () => {
  const kit = kitAt(0);
  assert.doesNotThrow(() => kit.assertMasterDb(-5));
  assert.doesNotThrow(() => kit.assertMasterDb(0));
  for (const bad of [null, NaN, 3, '−5']) {
    assert.throws(() => kit.assertMasterDb(bad), /layer\.json.*sfxMasterDb/, `bad value: ${String(bad)}`);
  }
});

// Step 0 (перед Task 18): в настоящем Remotion volume() зовётся только пока Sequence конкретного
// звука активна – испорченный layer.json → sfxMasterDb иначе всплыл бы не на кадре 0, а только
// когда рендер дойдёт до первого звука (минуты работы впустую). cues: [] – самый строгий случай:
// проверить вообще нечему, ни один cueVolume не вызовется, значит SfxTrack обязан валидировать
// masterDb сам, а не полагаться на побочный эффект чужого вызова.
test('SfxTrack rejects a bad sfxMasterDb immediately on render, even with no cue playing yet', () => {
  const kit = kitAt(0);
  assert.throws(
    () => render(React.createElement(kit.SfxTrack, { cues: [], masterDb: null })),
    /layer\.json.*sfxMasterDb/,
    'null masterDb with an empty cue list must still fail on render',
  );
  assert.throws(
    () => render(React.createElement(kit.SfxTrack, { cues: [], masterDb: NaN })),
    /layer\.json.*sfxMasterDb/,
  );
  assert.throws(
    () => render(React.createElement(kit.SfxTrack, { cues: [], masterDb: 3 })),
    /layer\.json.*sfxMasterDb/,
    'a positive masterDb (boosting effects) is rejected',
  );
  // undefined – «использовать дефолт −5 дБ», не ошибка.
  assert.doesNotThrow(() => render(React.createElement(kit.SfxTrack, { cues: [] })));
});

test('Subtitles show the active chunk with karaoke dimming and respect hide windows', () => {
  const kit = kitAt(0);
  const chunks = [{ units: [{ t: 'Раз', s: 0, e: 0.3 }, { t: 'два', s: 0.4, e: 0.6 }], s: 0, e: 0.6, show: 1, text: 'Раз два' }];
  // fps=25 явно – отклонение round 2: activeChunk больше не подставляет 25 сам по себе.
  assert.equal(kit.activeChunk(chunks, 0.5, [], 25).text, 'Раз два');
  assert.equal(kit.activeChunk(chunks, 1.2, [], 25), null);
  assert.equal(kit.activeChunk(chunks, 0.5, [{ from: 0.4, to: 0.9 }], 25), null);
  const lane = { x: 70, y: 1398, w: 880, h: 84 };
  const html = render(React.createElement(kitAt(5).Subtitles, { chunks, lane }));
  assert.match(html, /data-kit-text="captions"/);
  assert.match(html, /opacity:1">Раз/);
  assert.match(html, /opacity:0\.45">.*два/);
});

// Отклонение от плана: манифест решает видимость субтитра по кадру (Math.round(s*fps) – как
// buildManifest всегда делал), а не по секундам. Раньше Subtitles сверял sec (frame/fps) с
// chunk.s/chunk.show напрямую – на дробном s*fps это на кадр расходится с манифестом (например,
// s=0.204 при fps=25: round(0.204*25)=5, но frame/25>=0.204 верно только с кадра 6). captionSpans –
// общая чистая функция, которую использует и buildManifest, и сам компонент, поэтому кадр, где
// Subtitles что-то рисует, обязан буквально совпадать с кадрами caption-* в манифесте, включая
// вырезанное окно hide, на обоих fps.
test('Subtitles renders on exactly the frames captionSpans marks visible, at fps 25 and 30, with a hide window cut out', () => {
  // s=0.21 при fps=30 даёт 6.3 – дробный кадр, ключевой случай для этой проверки.
  const chunks = [{ units: [{ t: 'Раз', s: 0.21, e: 0.5 }], s: 0.21, e: 0.5, show: 0.9, text: 'Раз' }];
  const hide = [{ from: 0.5, to: 0.7 }];
  const lane = { x: 70, y: 1398, w: 880, h: 84 };
  for (const fps of [25, 30]) {
    const kit = kitAt(0);
    // Кадры, где по captionSpans субтитр обязан быть виден – то же durationInFrames (100000), что
    // отдаёт remotionStub по умолчанию (kitAt его не пробрасывает), чтобы клэмп не разошёлся.
    const spans = kit.captionSpans(chunks, { hide, fps, durationInFrames: 100000 });
    const manifestFrames = new Set();
    for (const span of spans) for (let f = span.from; f < span.until; f += 1) manifestFrames.add(f);
    assert.ok(manifestFrames.size > 0, `fps ${fps}: ожидали хотя бы один видимый кадр`);
    for (let frame = 0; frame <= 30; frame += 1) {
      const html = render(React.createElement(kitAt(frame, { fps }).Subtitles, { chunks, lane, hide }));
      assert.equal(html !== '', manifestFrames.has(frame), `fps ${fps} frame ${frame}: shown=${html !== ''}, ожидали ${manifestFrames.has(frame)}`);
    }
  }
});

// То же самое, но по полному конвейеру: слова → buildChunks → compileLayer → buildManifest, с
// окном hide, разрезающим единственный chunk пополам. Кадры, на которых Subtitles рисует
// data-kit-text="captions", обязаны совпасть с объединением диапазонов caption-1/caption-1b из
// настоящего манифеста – гейт видит ровно то, что нарисовано (принцип D2), не только на
// синтетических chunks выше.
test('Subtitles frames match the real manifest caption-* ranges end to end, across a hide-window split', () => {
  const words = [
    { w: 'Раз', t: 'Раз', s: 0.1, e: 0.3 },
    { w: 'два', t: 'два', s: 0.4, e: 0.6 },
  ];
  const hide = [{ from: 0.3, to: 0.4 }];
  for (const fps of [25, 30]) {
    const kit = kitAt(0);
    // durationInFrames = 100000 – то же значение, что подставляет remotionStub по умолчанию для
    // Subtitles ниже (kitAt его не пробрасывает), иначе клэмп у buildManifest и у компонента
    // разойдётся не из-за самого кода, а из-за разных входов теста.
    const cfg = { fps, width: 1080, height: 1920, durationInFrames: 100000, words, sfxLibrary: { sounds: {} } };
    const layer = kit.compileLayer({
      camera: { face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }] },
      items: [],
      captions: { hide },
    }, cfg);
    const manifest = kit.buildManifest(layer);
    const ids = manifest.texts.filter((t) => t.id.startsWith('caption-')).map((t) => t.id).sort();
    assert.deepEqual(ids, ['caption-1', 'caption-1b'], `fps ${fps}: hide должен был разрезать единственный chunk на два span`);
    const manifestFrames = new Set();
    for (const t of manifest.texts) if (t.id.startsWith('caption-')) for (let f = t.from; f < t.until; f += 1) manifestFrames.add(f);
    const { chunks, lane } = layer.captions;
    for (let frame = 0; frame <= 30; frame += 1) {
      const html = render(React.createElement(kitAt(frame, { fps }).Subtitles, { chunks, lane, hide }));
      assert.equal(html !== '', manifestFrames.has(frame), `fps ${fps} frame ${frame}`);
    }
  }
});

// Отклонение (ревью Task 18): кегль масштабируется от РАЗРЕШЕНИЯ КОМПОЗИЦИИ (k = width / (portrait
// ? 1080 : 1920), тот же k, что captionLane использует под safe-зону), а не от высоты полосы –
// кастомная (например, высокая) полоса не должна раздувать текст, только тесная обязана его сжать
// (captionFontSize, отдельно протестирован в motion-kit-captions.test.js). Явный fontSize остаётся
// аварийным люком.
test('Subtitles font size and text-shadow scale with the composition resolution, not the lane height', () => {
  const chunks = [{ units: [{ t: 'Раз', s: 0, e: 0.3 }], s: 0, e: 0.3, show: 1, text: 'Раз' }];
  // Полоса captionLane(1080,1920) реальная – h=84, k=1: 44px, тень «0 3px 12px».
  const lane1080 = { x: 70, y: 1398, w: 880, h: 84 };
  const html1080 = render(React.createElement(kitAt(0, { width: 1080, height: 1920 }).Subtitles, { chunks, lane: lane1080 }));
  assert.match(html1080, /font-size:44px/);
  assert.match(html1080, /text-shadow:0 3px 12px rgba\(0,0,0,\.55\)/);

  // 720x1280: k=720/1080=2/3 → 44*2/3≈29.3, тень 3*2/3=2, 12*2/3=8. Полоса captionLane(720,1280).h=56
  // (та же safe-зона, отдельно проверена в motion-kit-captions.test.js) – высотный клэмп при этом
  // laneH её не трогает (56/(1.1+12/44)≈40.8 > 29.3).
  const lane720 = { x: 47, y: 932, w: 587, h: 56 };
  const html720 = render(React.createElement(kitAt(0, { width: 720, height: 1280 }).Subtitles, { chunks, lane: lane720 }));
  assert.match(html720, /font-size:29\.3px/);
  assert.match(html720, /text-shadow:0 2px 8px rgba\(0,0,0,\.55\)/);

  // Кастомная ВЫСОКАЯ полоса на том же 1080x1920 (k=1, base=44) не должна раздуть шрифт сверх 44 –
  // captionFontSize только уменьшает, никогда не увеличивает.
  const tallLane = { x: 70, y: 100, w: 880, h: 400 };
  const htmlTall = render(React.createElement(kitAt(0, { width: 1080, height: 1920 }).Subtitles, { chunks, lane: tallLane }));
  assert.match(htmlTall, /font-size:44px/, 'a tall custom lane must not grow the font past the composition-based base');

  const overridden = render(React.createElement(kitAt(0, { width: 1080, height: 1920 }).Subtitles, { chunks, lane: lane1080, fontSize: 60 }));
  assert.match(overridden, /font-size:60px/);
});

// Важно (ревью Task 18): субтитры никогда не переносятся и не обрезаются внутри полосы. В SSR-тесте
// layout-эффект (бинарный поиск ширины) не выполняется – рендерится непорезанный размер, но
// white-space:nowrap обязан стоять уже в этом первом (до подгонки) рендере, иначе кадр, снятый ДО
// того как эффект успел сработать, показал бы перенос строки.
test('captions are single-line: white-space is nowrap even before the width-fit layout effect runs', () => {
  const chunks = [{ units: [{ t: 'Широкомасштабные' }, { t: 'жжёные' }, { t: 'мыши' }].map((u) => ({ ...u, s: 0, e: 0.1 })),
    s: 0, e: 0.1, show: 1, text: 'Широкомасштабные жжёные мыши' }];
  const lane = { x: 70, y: 1398, w: 880, h: 84 };
  const html = render(React.createElement(kitAt(0).Subtitles, { chunks, lane }));
  assert.match(html, /white-space:nowrap/);
});

// Важно (ревью Task 18): один канон округления секунд→кадры (secToFrame, как compileInserts) и для
// видимости chunk, и для караоке-подсветки слова – иначе первое слово могло на 1 кадр «опаздывать»
// за появлением своего chunk (sec=frame/fps сравнивался с необработанным unit.s, а видимость самого
// chunk считалась через другое округление). На САМОМ ПЕРВОМ видимом кадре chunk первое слово обязано
// быть уже подсвечено (opacity:1), на любом fps.
test('the first word is already lit (opacity 1) on the very first frame its chunk becomes visible, at fps 25 and 30', () => {
  const chunks = [{ units: [{ t: 'Раз', s: 0.21, e: 0.5 }, { t: 'два', s: 0.5, e: 0.8 }], s: 0.21, e: 0.8, show: 1.2, text: 'Раз два' }];
  const lane = { x: 70, y: 1398, w: 880, h: 84 };
  for (const fps of [25, 30]) {
    const kit = kitAt(0);
    const [firstSpan] = kit.captionSpans(chunks, { hide: [], fps, durationInFrames: 100000 });
    const html = render(React.createElement(kitAt(firstSpan.from, { fps }).Subtitles, { chunks, lane }));
    assert.match(html, /opacity:1">Раз/, `fps ${fps} frame ${firstSpan.from}: первое слово должно уже светиться`);
  }
});

// Важно (ревью Task 18): captions.hide и вставки (inserts) оба переводят секунды в кадры через
// secToFrame – hide, заданный ТЕМИ ЖЕ секундами, что insert.from/insert.to, обязан вырезать РОВНО
// кадры этой вставки, кадр в кадр, на любом fps (иначе субтитр мог бы на миг «выглянуть» поверх
// вставки или, наоборот, оставить в вырезе лишний кадр самой вставки без субтитра).
test('a hide window at an insert\'s own from/to seconds cuts exactly the frames compileInserts assigns that insert', () => {
  const kit = kitAt(0);
  for (const fps of [25, 30]) {
    const [insert] = kit.compileInserts([{ kind: 'stock', from: 0.58, to: 1.42, src: 'x.mp4' }], { fps, durationInFrames: 1000 });
    const chunks = [{ units: [{ t: 'Раз', s: 0, e: 0.3 }], s: 0, e: 2, show: 3, text: 'Раз' }];
    const spans = kit.captionSpans(chunks, { hide: [{ from: 0.58, to: 1.42 }], fps, durationInFrames: 1000 });
    assert.equal(spans.length, 2, `fps ${fps}: hide должен разрезать единственный chunk на два span`);
    assert.equal(spans[0].until, insert.from, `fps ${fps}: левая граница выреза обязана совпасть с началом вставки`);
    assert.equal(spans[1].from, insert.to, `fps ${fps}: правая граница выреза обязана совпасть с концом вставки`);
  }
});

// Minor (ревью Task 18): accentWords сравнивается через канонический normWord (words.js) с обеих
// сторон – регистр, «ё», хвостовая пунктуация не должны мешать подсветке; мутация, убирающая accent
// целиком, раньше не ловилась ни одним тестом.
test('accentWords colours a word regardless of case, ё/е and trailing punctuation, and leaves others untouched', () => {
  const chunks = [{ units: [{ t: 'Клод,', s: 0, e: 0.2 }, { t: 'привет', s: 0.2, e: 0.4 }], s: 0, e: 0.4, show: 1, text: 'Клод, привет' }];
  const lane = { x: 70, y: 1398, w: 880, h: 84 };
  const html = render(React.createElement(kitAt(0).Subtitles, {
    chunks, lane, accent: '#ffcc00', accentWords: ['клод'],
  }));
  // Каждое слово – отдельный лист-span (opacity, без вложенных тегов); достаём их по отдельности,
  // а не строкой .*, иначе «color:… раньше в html» ложно совпало бы с любым более поздним словом.
  const unitSpans = [...html.matchAll(/<span style="([^"]*)">([^<]*)<\/span>/g)];
  assert.equal(unitSpans.length, 2);
  assert.match(unitSpans[0][2], /Клод,/);
  assert.match(unitSpans[0][1], /color:#ffcc00/, 'нормализация обязана снять запятую и совпасть с «клод»');
  assert.match(unitSpans[1][2], /привет/);
  assert.doesNotMatch(unitSpans[1][1], /color:/, 'неакцентное слово не должно получить color вообще');
});

test('FontLoader blocks rendering until fonts load', () => {
  const calls = {};
  const kit = kitAt(0, { calls });
  render(React.createElement(kit.FontLoader, { faces: [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }] }));
  assert.equal(calls.delay, 1);
});

// Round 2: FontLoader стал гейтом (children не рисуются, пока шрифты не готовы), но в SSR/тестах
// нет document – измерять всё равно нечего, поэтому дети должны показаться сразу же (иначе каждый
// существующий тест, рендерящий компоненты кита в изоляции, завис бы). calls.delay остаётся 1 –
// плановая проверка не должна была сломаться этим отклонением.
test('FontLoader (as a gate) renders its children immediately when there is no DOM (SSR/tests)', () => {
  const calls = {};
  const kit = kitAt(0, { calls });
  const html = render(React.createElement(kit.FontLoader, { faces: [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }] },
    React.createElement('span', null, 'hi')));
  assert.match(html, /<span>hi<\/span>/);
  assert.equal(calls.delay, 1);
});

test('loadFontFaces adds every face to fontSet and resolves once all of them load', async () => {
  const kit = kitAt(0);
  const added = [];
  class FakeFontFace {
    constructor(family, source, descriptors) { this.family = family; this.source = source; this.descriptors = descriptors; }
    load() { return Promise.resolve(this); }
  }
  const faces = [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }, { family: 'KitMono', file: 'fonts/Mono.ttf', weight: '400' }];
  await kit.loadFontFaces(faces, { FontFaceImpl: FakeFontFace, fontSet: { add: (f) => added.push(f) }, toUrl: (f) => `/static/${f}` });
  assert.equal(added.length, 2);
  assert.equal(added[0].family, 'KitOnest');
  // Minor (ревью Task 18): url() теперь в кавычках – незаэкранированные скобки/пробелы в пути не
  // должны ломать CSS-значение.
  assert.equal(added[0].source, 'url("/static/fonts/Onest.ttf")');
  assert.deepEqual(added[0].descriptors, { weight: '100 900' });
  assert.deepEqual(added[1].descriptors, { weight: '400' });
});

// Minor (ревью Task 18): ошибка конкретного лица оборачивается с его family/file – иначе в логе
// рендера из пяти шрифтов непонятно, какой именно не загрузился.
test('loadFontFaces wraps a failing face\'s rejection with its family and file', async () => {
  const kit = kitAt(0);
  class FailingFontFace {
    load() { return Promise.reject(new Error('network error')); }
  }
  await assert.rejects(
    () => kit.loadFontFaces([{ family: 'KitOnest', file: 'fonts/Onest.ttf' }],
      { FontFaceImpl: FailingFontFace, fontSet: { add: () => {} }, toUrl: (f) => f }),
    /KitOnest.*fonts\/Onest\.ttf.*network error/,
  );
});

test('loadFontFaces resolves immediately with an empty face list, without touching FontFaceImpl', () => {
  const kit = kitAt(0);
  let constructed = false;
  class UnexpectedFontFace { constructor() { constructed = true; } }
  const result = kit.loadFontFaces([], { FontFaceImpl: UnexpectedFontFace, fontSet: { add: () => {} }, toUrl: (f) => f });
  assert.ok(result instanceof Promise);
  return result.then(() => assert.equal(constructed, false));
});

// Minor (ревью Task 18): вся работа идёт внутри Promise.resolve().then(...), поэтому синхронный
// throw из toUrl (например, staticFile на плохом пути) обязан стать отклонением промиса, а не
// необработанным исключением из самого вызова loadFontFaces(...) – иначе .catch() в FontLoader
// его бы не увидел и cancelRender никогда бы не вызвался.
test('loadFontFaces turns a synchronous throw from toUrl into a rejection, not an uncaught exception', async () => {
  const kit = kitAt(0);
  class NeverCalledFontFace {
    constructor() { throw new Error('не должен был вызваться'); }
  }
  let threwSynchronously = false;
  let promise;
  try {
    promise = kit.loadFontFaces(
      [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }],
      { FontFaceImpl: NeverCalledFontFace, fontSet: { add: () => {} }, toUrl: () => { throw new Error('boom'); } },
    );
  } catch {
    threwSynchronously = true;
  }
  assert.equal(threwSynchronously, false, 'loadFontFaces must not throw synchronously');
  await assert.rejects(() => promise, /boom/);
});

// Minor (ревью Task 18): один family дважды без явного weight – статические начертания оба
// заявляют весь диапазон '100 900' и коллидируют в fontSet. Разные явные weight – не коллизия.
test('loadFontFaces rejects a repeated family with no explicit weight, but allows it with distinct weights', async () => {
  const kit = kitAt(0);
  class FakeFontFace { load() { return Promise.resolve(this); } }
  await assert.rejects(
    () => kit.loadFontFaces(
      [{ family: 'KitOnest', file: 'a.ttf' }, { family: 'KitOnest', file: 'b.ttf' }],
      { FontFaceImpl: FakeFontFace, fontSet: { add: () => {} }, toUrl: (f) => f },
    ),
    /KitOnest.*weight/,
  );
  const added = [];
  await kit.loadFontFaces(
    [{ family: 'KitOnest', file: 'a.ttf', weight: '400' }, { family: 'KitOnest', file: 'b.ttf', weight: '700' }],
    { FontFaceImpl: FakeFontFace, fontSet: { add: (f) => added.push(f) }, toUrl: (f) => f },
  );
  assert.equal(added.length, 2, 'distinct explicit weights on the same family must not collide');
});

test('settleOnce runs the first action and silently ignores any later ones', () => {
  const kit = kitAt(0);
  const settle = kit.settleOnce();
  let calls = 0;
  assert.equal(settle(() => { calls += 1; }), true);
  assert.equal(settle(() => { calls += 1; }), false);
  assert.equal(calls, 1);
});

// Round 3 (важно, ревью п.2а): суть исправления – FontFace обязана попасть в fontSet ДО того, как
// её load() успеет разрешиться, а не после. Проверяем это напрямую: load() специально не резолвим
// (держим resolve в замыкании), но fontSet.add уже обязан был случиться к моменту, когда
// registerFontFaces вернула управление.
test('registerFontFaces adds each FontFace to fontSet synchronously, before its load() settles', () => {
  const kit = kitAt(0);
  const added = [];
  let releaseLoad;
  class FakeFontFace {
    constructor(family) { this.family = family; }
    load() { return new Promise((resolve) => { releaseLoad = resolve; }); }
  }
  const registered = kit.registerFontFaces(
    [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }],
    { FontFaceImpl: FakeFontFace, fontSet: { add: (f) => added.push(f) }, toUrl: (f) => f },
  );
  assert.equal(added.length, 1, 'fontSet.add must have already run – load() has not resolved yet');
  assert.equal(added[0].family, 'KitOnest');
  assert.equal(registered.length, 1);
  assert.ok(registered[0].promise instanceof Promise);
  releaseLoad(added[0]); // не блокируем – просто освобождаем висящий промис
});

test('registerFontFaces validates duplicates and returns [] for an empty/missing list, all synchronously', () => {
  const kit = kitAt(0);
  class FakeFontFace { load() { return Promise.resolve(this); } }
  assert.deepEqual(kit.registerFontFaces([], { FontFaceImpl: FakeFontFace, fontSet: { add: () => {} }, toUrl: (f) => f }), []);
  assert.throws(
    () => kit.registerFontFaces(
      [{ family: 'KitOnest', file: 'a.ttf' }, { family: 'KitOnest', file: 'b.ttf' }],
      { FontFaceImpl: FakeFontFace, fontSet: { add: () => {} }, toUrl: (f) => f },
    ),
    /KitOnest.*weight/,
  );
});

test('settleFontFaces awaits every registered load() and wraps a failure with its family/file', async () => {
  const kit = kitAt(0);
  class FailingFontFace { load() { return Promise.reject(new Error('network error')); } }
  const registered = kit.registerFontFaces(
    [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }],
    { FontFaceImpl: FailingFontFace, fontSet: { add: () => {} }, toUrl: (f) => f },
  );
  await assert.rejects(() => kit.settleFontFaces(registered), /KitOnest.*fonts\/Onest\.ttf.*network error/);
});

// Ревью пакета 1: регистрация идёт в инициализаторе useState (фаза рендера), поэтому каждое
// монтирование FontLoader (ремаунт, второй FontLoader с теми же шрифтами) снова зовёт
// registerFontFaces. Уже зарегистрированное в этом fontSet лицо (тот же family+file+weight)
// переиспользуется: второй FontFace в document.fonts не появляется, промис загрузки – тот же.
test('registerFontFaces reuses a face already registered in the same fontSet instead of adding a duplicate', async () => {
  const kit = kitAt(0);
  const added = [];
  let constructed = 0;
  class FakeFontFace {
    constructor(family, source, descriptors) { constructed += 1; this.family = family; this.descriptors = descriptors; }
    load() { return Promise.resolve(this); }
  }
  const fontSet = { add: (f) => added.push(f) };
  const deps = { FontFaceImpl: FakeFontFace, fontSet, toUrl: (f) => f };
  const faces = [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }, { family: 'KitMono', file: 'fonts/Mono.ttf', weight: '400' }];
  const first = kit.registerFontFaces(faces, deps);
  const second = kit.registerFontFaces(faces.map((face) => ({ ...face })), deps);
  assert.equal(added.length, 2, 'повторная регистрация тех же лиц не должна добавлять их в fontSet ещё раз');
  assert.equal(constructed, 2);
  assert.equal(second[0].promise, first[0].promise, 'повторная регистрация ждёт ту же загрузку');
  await kit.settleFontFaces(second);

  // Другой weight того же файла – другое начертание, а другой fontSet (другой документ) –
  // свой реестр: в обоих случаях лицо регистрируется заново.
  kit.registerFontFaces([{ family: 'KitMono', file: 'fonts/Mono.ttf', weight: '700' }], deps);
  assert.equal(added.length, 3);
  const otherSet = [];
  kit.registerFontFaces(faces, { ...deps, fontSet: { add: (f) => otherSet.push(f) } });
  assert.equal(otherSet.length, 2);
});

test('FontLoader mounted twice with the same faces registers them in document.fonts once', () => {
  const kit = kitAt(0);
  const added = [];
  class FakeFontFace {
    constructor(family) { this.family = family; }
    load() { return new Promise(() => {}); }
  }
  const saved = { document: Object.getOwnPropertyDescriptor(global, 'document'), FontFace: Object.getOwnPropertyDescriptor(global, 'FontFace') };
  global.document = { fonts: { add: (f) => added.push(f) } };
  global.FontFace = FakeFontFace;
  try {
    const faces = [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }];
    // renderToStaticMarkup выполняет инициализаторы useState, но не эффекты – ровно та фаза,
    // в которой FontLoader регистрирует шрифты. Шрифт не загружен → гейт закрыт, детей нет.
    assert.equal(render(React.createElement(kit.FontLoader, { faces }, 'x')), '');
    assert.equal(render(React.createElement(kit.FontLoader, { faces }, 'x')), '');
    assert.equal(added.length, 1);
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(global, name, descriptor); else delete global[name];
    }
  }
});

// Ревью пакета 1: эффект монтирования гейта – чистая функция watchFontFaces (эффекты в
// renderToStaticMarkup не выполняются). Если FontLoader размонтирован раньше, чем шрифты
// загрузились, очистка обязана отпустить delayRender-handle – иначе Remotion ждал бы его до
// таймаута; поздняя загрузка или ошибка после размонтирования уже ничего не трогают.
test('watchFontFaces releases the delayRender handle when the gate unmounts before the fonts load', async () => {
  const kit = kitAt(0);
  let releaseLoad;
  class SlowFontFace { load() { return new Promise((resolve) => { releaseLoad = resolve; }); } }
  const registered = kit.registerFontFaces([{ family: 'KitOnest', file: 'fonts/Onest.ttf' }],
    { FontFaceImpl: SlowFontFace, fontSet: { add: () => {} }, toUrl: (f) => f });
  const settle = kit.settleOnce();
  const events = [];
  const cleanup = kit.watchFontFaces(registered, {
    onReady: () => events.push('ready'),
    onError: () => events.push('error'),
    release: () => settle(() => events.push('continue')),
  });
  cleanup();
  assert.deepEqual(events, ['continue'], 'размонтирование до загрузки обязано сразу отпустить handle');
  releaseLoad();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['continue'], 'поздняя загрузка после размонтирования не зовёт onReady');
});

test('watchFontFaces reports ready once the fonts load, and a later unmount does not release the handle twice', async () => {
  const kit = kitAt(0);
  class FastFontFace { load() { return Promise.resolve(this); } }
  const registered = kit.registerFontFaces([{ family: 'KitOnest', file: 'fonts/Onest.ttf' }],
    { FontFaceImpl: FastFontFace, fontSet: { add: () => {} }, toUrl: (f) => f });
  const settle = kit.settleOnce();
  const events = [];
  const release = () => settle(() => events.push('continue'));
  const cleanup = kit.watchFontFaces(registered, {
    onReady: () => { events.push('ready'); release(); },
    onError: () => events.push('error'),
    release,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['ready', 'continue']);
  cleanup();
  assert.deepEqual(events, ['ready', 'continue'], 'handle уже отпущен – повторного continueRender нет');
});

test('watchFontFaces passes a load failure to onError, but not after the gate has unmounted', async () => {
  const kit = kitAt(0);
  class FailingFontFace { load() { return Promise.reject(new Error('network error')); } }
  const deps = { FontFaceImpl: FailingFontFace, fontSet: { add: () => {} }, toUrl: (f) => f };
  const errors = [];
  kit.watchFontFaces(kit.registerFontFaces([{ family: 'KitOnest', file: 'a.ttf' }], deps),
    { onReady: () => {}, onError: (error) => errors.push(error.message), release: () => {} });
  const cleanup = kit.watchFontFaces(kit.registerFontFaces([{ family: 'KitMono', file: 'b.ttf' }], deps),
    { onReady: () => {}, onError: (error) => errors.push(error.message), release: () => {} });
  cleanup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /KitOnest.*a\.ttf.*network error/);
});

// Round 3 (важно, ревью п.2б): FontLoader – гейт, обязан ОБОРАЧИВАТЬ то, что ждёт шрифт, а не
// стоять рядом с ним отдельным элементом (та самая ошибка использования из ревью). В браузере
// (document существует) отсутствие children – однозначная ошибка; в Node/SSR document не
// существует, поэтому проверка возможна только с временно подставленным global.document.
test('FontLoader throws a clear error when children is missing, but only when a real DOM exists', () => {
  const kit = kitAt(0);
  assert.doesNotThrow(() => render(React.createElement(kit.FontLoader, { faces: [] })), 'SSR/tests (no document) must stay silent – many isolated component tests rely on this');
  const hadDocument = Object.hasOwn(global, 'document');
  const previousDocument = global.document;
  global.document = {};
  try {
    assert.throws(
      () => render(React.createElement(kit.FontLoader, { faces: [] })),
      /FontLoader.*children/,
    );
    assert.doesNotThrow(() => render(React.createElement(kit.FontLoader, { faces: [] }, 'x')));
  } finally {
    if (hadDocument) global.document = previousDocument; else delete global.document;
  }
});

test('firstFontFamily extracts and unquotes the first family from a CSS font stack', () => {
  const kit = kitAt(0);
  assert.equal(kit.firstFontFamily('KitOnest, sans-serif'), 'KitOnest');
  assert.equal(kit.firstFontFamily('"KitOnest", sans-serif'), 'KitOnest');
  assert.equal(kit.firstFontFamily("'KitOnest'"), 'KitOnest');
  assert.equal(kit.firstFontFamily('KitOnest'), 'KitOnest');
  assert.equal(kit.firstFontFamily('  KitOnest  , serif'), 'KitOnest');
});
