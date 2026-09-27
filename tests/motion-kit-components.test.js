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
        assert.ok(l <= 0.01, `${width}x${height}@${frame}: left gap ${l}`);
        assert.ok(t <= 0.01, `${width}x${height}@${frame}: top gap ${t}`);
        assert.ok(width - r <= 0.01, `${width}x${height}@${frame}: right gap ${width - r}`);
        assert.ok(height - b <= 0.01, `${width}x${height}@${frame}: bottom gap ${height - b}`);
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
  // Кадр 200 внутри бокового плана L (fill:true) — обе копии смонтированы через Freeze, но ещё
  // не держат кадр (active=false): data-freeze-active="false" доказывает, что обёртка осталась
  // на месте, а не пропала вместе с video, как было бы при условном рендере <Freeze> целиком.
  assert.equal((atLast.match(/data-freeze-active="false"/g) || []).length, 2);
  assert.doesNotMatch(atLast, /data-freeze="/);
  const afterLast = render(React.createElement(kitAt(201).SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  // Кадр 201 внутри того же плана — заморожены обе копии: фон и основной кадр.
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
  // не несут. opacity должна стоять только на внешней группе — по копиям делать нечего.
  assert.equal(styles.length, state.fill ? 3 : 2, `unexpected number of styled divs: ${html}`);
  assert.match(styles[0], /opacity:0\.5/);
  for (const inner of styles.slice(1)) assert.doesNotMatch(inner, /opacity/);
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

// CARD не жёсткая константа под 1080x1920 (та давала карточку высотой 240px на 1920x1080) —
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

// Task 15 fix: revealProgress и insertOpacity читают одно closeWindow — на последнем реально
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
// «сырую» вставку с секундами вместо скомпилированных кадров — чтобы будущие screen/scene
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
// bottom left) — перестановка left/right молча ломает форму карточки, не ломая ни одного теста
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
  // frame 99 (to-1) — не 98: с общим close-окном (Task 15 fix) insertOpacity там уже 0, и
  // FullscreenReveal/StockInsert теперь ничего не рисуют на фактически невидимом кадре.
  assert.match(at(98), /scale\(1\.0972\)/);
});

// kb необязателен в контракте (`kb?: [1.03, 1.1]`) — StockInsert подставляет дефолт сам, а не
// падает на insert.kb[0], если вставка ещё не прошла compileInserts (там дефолт уже есть тоже)
// или её собрали вручную без него.
test('StockInsert defaults kb to [1.03, 1.1] and renders without throwing when it is absent', () => {
  const insert = { id: 'stock-2', kind: 'stock', from: 50, to: 100, src: 'stock/b.mp4' };
  assert.doesNotThrow(() => render(React.createElement(kitAt(70).StockInsert, { insert })));
  const html = render(React.createElement(kitAt(50).StockInsert, { insert }));
  assert.match(html, /scale\(1\.0300\)/);
});

// StockInsert стоит на верхнем уровне композиции, как SpeakerLayer, а не внутри чужой Sequence —
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

// Ревью Task 16: pixel maxScroll не может быть верным — plan.js не знает натуральную высоту
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
  // from+5 в окне 50 кадров — линейно было бы 0.1; inOut-кривая на входе куда положе.
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
  assert.doesNotMatch(html, /translateY/, 'no more pixel translateY — the old overscroll bug lived here');
});

test('screenshot card renders inside BrowserFrame and shows the URL', () => {
  const html = render(React.createElement(kitAt(35).BrowserFrame, { url: 'example.com/page' },
    React.createElement(kitAt(35).ScrollShot, { src: 'shots/page.png', from: 10, to: 60 })));
  assert.match(html, /example\.com\/page/);
  assert.match(html, /<img src="\/static\/shots\/page\.png"/);
});

test('BrowserFrame chrome scales with the composition resolution (short side / 1080), a scale prop may override it', () => {
  assert.match(render(React.createElement(kitAt(0, { width: 1080, height: 1920 }).BrowserFrame, { url: 'x' }, 'x')), /height:64px/);
  // k = 720/1080 = 0.6667; 64 * k ≈ 42.7 — не 64px, иначе хром окна на нестандартном разрешении
  // рисуется в исходном (для 1080p) масштабе поверх реального кадра.
  assert.match(render(React.createElement(kitAt(0, { width: 720, height: 1280 }).BrowserFrame, { url: 'x' }, 'x')), /height:42\.7px/);
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

test('BrowserFrame URL pill defaults to a sans-serif font (overridable) and ellipsizes overflow', () => {
  const kit = kitAt(0);
  const html = render(React.createElement(kit.BrowserFrame, { url: 'example.com/very/long/path' }, 'x'));
  assert.match(html, /font-family:sans-serif/);
  assert.match(html, /text-overflow:ellipsis/);
  const custom = render(React.createElement(kit.BrowserFrame, { url: 'x', fontFamily: 'Georgia, serif' }, 'x'));
  assert.match(custom, /font-family:Georgia, serif/);
});

test('flashOpacity keeps the plan-asserted values at the default fps 25', () => {
  const kit = kitAt(0);
  assert.equal(kit.flashOpacity(9, 10), 0);
  assert.ok(kit.flashOpacity(10, 10) > kit.flashOpacity(13, 10));
  assert.equal(kit.flashOpacity(16, 10), 0);
});

// Отклонение от плана: frames в ShutterFlash/flashOpacity — эталонные 25fps кадры (как
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
