const test = require('node:test');
const assert = require('node:assert/strict');
const { getProfile } = require('../scripts/qa/profiles');
const { assertCameraArrays, detectCameraEvents, gateDonor, gateHook, gateRhythm, gateScale, gateStock, gateWeakCuts, speakerPlans } = require('../scripts/qa/timeline-gates');
const { cutsEvery, manifestFixture } = require('./helpers/manifest-fixtures');

const avatar = getProfile('avatar');
const kit = require('../scripts/motion-kit-node').loadKitCore();
const face = { x: 540, y: 787 };

test('BAD CASE: a static 5 s speaker plan stops the layer', () => {
  const m = manifestFixture({ camera: (f) => ({ s: f < 125 ? 1 : (Math.floor((f - 125) / 50) % 2 ? 1 : 1.18) }) });
  const g = gateRhythm(m, avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 5);
  assert.deepEqual([g.spans[0].fromSec, g.spans[0].toSec], [0, 5]);
});

test('a cut every 2 s passes, and slow drift alone is not an event', () => {
  assert.equal(gateRhythm(manifestFixture({ camera: cutsEvery(2) }), avatar).status, 'pass');
  const drift = manifestFixture({ camera: (f) => ({ s: 1 + 0.06 * (f / 250), dx: 22 * Math.sin(f / 38) }) });
  assert.equal(gateRhythm(drift, avatar).value, 10);
});

test('punch-ins, focus changes and speaker away windows split plans', () => {
  const punch = manifestFixture({ seconds: 4, camera: (f) => ({ s: f < 50 ? 1 : 1 + 0.15 * Math.min(1, (f - 50) / 5) }) });
  assert.deepEqual(detectCameraEvents(punch.camera, avatar.camera, 1, 25).events.map((e) => e.kind), ['punch']);
  const blur = manifestFixture({ seconds: 4, camera: (f) => ({ s: 1, blur: f >= 50 && f < 75 ? 20 : 0 }) });
  assert.equal(gateRhythm(blur, avatar).value, 2);
  const away = manifestFixture({ seconds: 6, camera: (f) => ({ s: 1, opacity: f >= 50 && f < 100 ? 0 : 1 }) });
  assert.equal(gateRhythm(away, avatar).value, 2);
});

test('a 2.3 s plan warns, and a 6 % cut is a weak cut that does not reset the plan', () => {
  assert.equal(gateRhythm(manifestFixture({ seconds: 6.9, camera: cutsEvery(2.3) }), avatar).status, 'warn');
  const weak = manifestFixture({ seconds: 4, camera: (f) => ({ s: f < 60 ? 1 : 1.08 }) });
  assert.equal(gateWeakCuts(weak, avatar).status, 'warn');
  assert.equal(gateRhythm(weak, avatar).value, 4);
});

test('the plan after a cover insert starts when the insert begins to close, not at its end', () => {
  const { speakerPlans } = require('../scripts/qa/timeline-gates');
  const kit = require('../scripts/motion-kit-node').loadKitCore();
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 150, words: [], sfxLibrary: { sounds: {} } };
  const m = kit.buildManifest(kit.compileLayer({ captions: false, items: [],
    camera: { face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W', drift: 'none' }] },
    inserts: [{ kind: 'stock', from: 2, to: 4, src: 'stock/a.mp4' }] }, cfg));
  const plans = speakerPlans(m.camera, detectCameraEvents(m.camera, avatar.camera, 1, 25), 25);
  assert.ok(plans.some((plan) => plan.from === 94), JSON.stringify(plans));
});

// --- Ревью пакета 2 (после Task 21) ---

// П.1: одиночная ступенька — рез между двумя shots kit — не панч. Настоящий панч всегда растёт
// несколько кадров подряд; ступенька меняется за один кадр и дальше держит новый уровень.
test('a one-frame step (hard cut between shots) is a weak cut, not a punch, and does not reset the plan', () => {
  const stepUp = manifestFixture({ seconds: 3, camera: (f) => ({ s: f < 50 ? 1 : 1.12 }) });
  const d = detectCameraEvents(stepUp.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events, []);
  assert.equal(d.weak.length, 1);
  assert.equal(d.weak[0].frame, 50);
  assert.equal(gateWeakCuts(stepUp, avatar).status, 'warn');
  assert.equal(gateRhythm(stepUp, avatar).value, 3, 'ступенька 12 % не должна резать план');
});

// Тот самый реальный случай из ревью: W с дрейфом in (полностью «дорос») → M без дрейфа даёт
// мгновенный скачок ~12,4 % на границе shots — раньше это классифицировалось как панч, и G2
// молчал; правильный ответ — слабый джамп-кат, план не режется.
test('a real W(in)->M(none) shot transition is a weak cut, not a punch', () => {
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 200, words: [], sfxLibrary: { sounds: {} } };
  const real = kit.buildManifest(kit.compileLayer({ captions: false, items: [],
    camera: { face, shots: [{ at: 0, preset: 'W', drift: 'in' }, { at: 6, preset: 'M', drift: 'none' }] } }, cfg));
  const d = detectCameraEvents(real.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events.filter((e) => e.frame >= 148 && e.frame <= 152), []);
  assert.ok(d.weak.some((w) => w.frame >= 148 && w.frame <= 152), JSON.stringify(d.weak));
  assert.equal(gateRhythm(real, avatar).value, 8, 'без реза план тянется на всю восьмисекундную композицию');
});

// Настоящие панчи kit (k=1.15 и k=1.25) на нескольких fps остаются ОДНИМ событием, а не
// расщепляются ступенчатой проверкой (регресс на п. 1) и не задваиваются подавлением рядом с
// резом (регресс на п. 3): пружина панча гладкая, у неё нет плоских соседей внутри роста.
test('real kit punches (k 1.15 and 1.25) stay a single punch event across fps', () => {
  for (const fps of [25, 30, 50, 60]) {
    for (const k of [1.15, 1.25]) {
      const cfg = { fps, width: 1080, height: 1920, durationInFrames: Math.round(6 * fps), words: [], sfxLibrary: { sounds: {} } };
      const m = kit.buildManifest(kit.compileLayer({ captions: false, items: [],
        camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }], punches: [{ at: 2, until: 3.5, k }] } }, cfg));
      const d = detectCameraEvents(m.camera, avatar.camera, 1, fps);
      assert.deepEqual(d.events.map((e) => e.kind), ['punch'], `fps=${fps} k=${k}`);
      assert.deepEqual(d.weak, [], `fps=${fps} k=${k}`);
      assert.equal(gateWeakCuts(m, avatar).status, 'pass', `fps=${fps} k=${k}`);
    }
  }
});

// autoShots не тронут этим ревью: обычная речь по-прежнему не даёт ни одного警 предупреждения из-за
// самой раскадровки (округление кадров), как и до правок.
test('autoShots-driven speech still keeps a normal rhythm (unchanged by this review)', () => {
  const words = [];
  let t = 0.4;
  while (t < 20) { words.push({ w: 'w.', t: 'w.', s: t, e: t + 0.3 }); t += 0.3 + 1.9; }
  const shots = kit.autoShots(words, { endSec: 20 });
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 500, words: [], sfxLibrary: { sounds: {} } };
  const real = kit.buildManifest(kit.compileLayer({ captions: false, items: [], camera: { face, shots } }, cfg));
  assert.equal(gateRhythm(real, avatar).status, 'pass');
});

// П.2: пороги закреплены на границах, чтобы их нельзя было незаметно сдвинуть.
test('rhythm thresholds are exact at their boundary, at a non-25 fps', () => {
  const mk = (cutFrame) => manifestFixture({ seconds: 4, fps: 30, camera: (f) => ({ s: f < cutFrame ? 1 : (Math.floor((f - cutFrame) / 40) % 2 ? 1 : 1.18) }) });
  assert.equal(gateRhythm(mk(75), avatar).status, 'warn', '75 кадров при 30 fps = ровно 2,5 с — это ещё не стоп');
  assert.equal(gateRhythm(mk(76), avatar).status, 'fail', '76 кадров уже больше порога');
  assert.equal(gateRhythm(mk(66), avatar).status, 'pass', '66 кадров при 30 fps = ровно 2,2 с — это ещё не предупреждение');
  assert.equal(gateRhythm(mk(67), avatar).status, 'warn', '67 кадров уже больше порога предупреждения');
});

test('a scale jump is exact at the 15 % cut boundary', () => {
  const mk = (s) => manifestFixture({ seconds: 3, camera: (f) => (f < 50 ? { s: 1 } : { s }) });
  assert.deepEqual(detectCameraEvents(mk(1.15).camera, avatar.camera, 1, 25).events.map((e) => e.kind), ['cut']);
  const d = detectCameraEvents(mk(1.149).camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events, []);
  assert.equal(d.weak.length, 1);
});

test('a face shift is exact at the 85 px cut boundary', () => {
  const mk = (dx) => manifestFixture({ seconds: 3, camera: (f) => (f < 50 ? { s: 1 } : { s: 1, dx }) });
  assert.deepEqual(detectCameraEvents(mk(85).camera, avatar.camera, 1, 25).events.map((e) => e.kind), ['cut']);
  const d = detectCameraEvents(mk(84).camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events, []);
  assert.equal(d.weak.length, 1);
});

test('the shift threshold scales with the short side at 4K (2160x3840)', () => {
  const mk = (dx) => manifestFixture({ seconds: 3, width: 2160, height: 3840, camera: (f) => (f < 50 ? { s: 1 } : { s: 1, dx }) });
  const d100 = detectCameraEvents(mk(100).camera, avatar.camera, 2, 25);
  assert.deepEqual(d100.events, [], '100 px ниже масштабированного порога 170 px на 4K');
  assert.equal(d100.weak.length, 1);
  assert.deepEqual(detectCameraEvents(mk(170).camera, avatar.camera, 2, 25).events.map((e) => e.kind), ['cut']);
});

test('punchWindow scales with fps: a real punch at 50 fps is still one event and G2 passes', () => {
  const cfg = { fps: 50, width: 1080, height: 1920, durationInFrames: 300, words: [], sfxLibrary: { sounds: {} } };
  const m = kit.buildManifest(kit.compileLayer({ captions: false, items: [],
    camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }], punches: [{ at: 2, until: 3.5 }] } }, cfg));
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 50);
  assert.deepEqual(d.events.map((e) => e.kind), ['punch']);
  assert.equal(gateWeakCuts(m, avatar).status, 'pass');
});

// nearEvent: первые кадры нарастания пружины (ниже punchScale, но уже выше weakScale) похожи на
// слабый джамп-кат — их отбрасывают как «слишком близко к настоящему событию».
test('the rising edge of a punch spring is not also reported as a weak cut', () => {
  const punch = manifestFixture({ seconds: 4, camera: (f) => ({ s: f < 50 ? 1 : 1 + 0.15 * Math.min(1, (f - 50) / 5) }) });
  const d = detectCameraEvents(punch.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.weak, []);
});

test('the sharp/blur boundary is exact at 6 px', () => {
  const mk = (blur) => manifestFixture({ seconds: 3, camera: (f) => (f < 50 ? { s: 1 } : { s: 1, blur }) });
  assert.deepEqual(detectCameraEvents(mk(6).camera, avatar.camera, 1, 25).events.map((e) => e.kind), ['focus']);
  assert.deepEqual(detectCameraEvents(mk(5.9).camera, avatar.camera, 1, 25).events, []);
});

test('G2 spans are never silently emptied for a real weak cut', () => {
  const weakCase = manifestFixture({ seconds: 3, camera: (f) => (f < 50 ? { s: 1 } : { s: 1.08 }) });
  const spans = gateWeakCuts(weakCase, avatar).spans;
  assert.equal(spans.length, 1);
  assert.match(spans[0].note, /скачок 8 %/);
});

// П.3: рез сразу после панча не должен пропадать в общей схлопке разных видов событий.
test('a cut shortly after a punch is not swallowed by the punch, and the plan ends at the cut', () => {
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 125, words: [], sfxLibrary: { sounds: {} } };
  const m = kit.buildManifest(kit.compileLayer({ captions: false, items: [],
    camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }, { at: 2.36, preset: 'L', drift: 'none' }],
      punches: [{ at: 2, until: 3 }] } }, cfg));
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events.map((e) => e.kind), ['punch', 'cut']);
  const plans = speakerPlans(m.camera, d, 25);
  assert.ok(plans.some((p) => p.to === d.events[1].frame), JSON.stringify(plans));
});

// П.4: панч сдвинут назад к настоящему началу роста (совпадает с punch.at из плана), а не к
// кадру, где прирост впервые перевалил punchScale (обычно на 2–3 кадра позже).
test('a punch event is backdated to the real start of its rise, matching punch.at', () => {
  for (const [fps, k] of [[25, 1.15], [30, 1.15], [50, 1.25], [60, 1.25]]) {
    const cfg = { fps, width: 1080, height: 1920, durationInFrames: Math.round(6 * fps), words: [], sfxLibrary: { sounds: {} } };
    const m = kit.buildManifest(kit.compileLayer({ captions: false, items: [],
      camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }], punches: [{ at: 2, until: 3.5, k }] } }, cfg));
    const d = detectCameraEvents(m.camera, avatar.camera, 1, fps);
    assert.equal(d.events[0].frame, Math.round(2 * fps), `fps=${fps} k=${k}`);
  }
});

// Регресс (ревью пакета 3): на дрейфующем shot ('in') камера растёт почти каждый кадр сама по
// себе, независимо от панча. Наивная «отматываем, пока строго растёт» цеплялась за этот дрейф и
// датировала панч на десятки кадров раньше punch.at (до 0,18 с в 74 из 144 проверенных случаев).
// riseStart должен опираться на прирост САМОГО панча (top в его окне), а не на любой рост вообще.
test('a punch on a drifting ("in") shot is still dated exactly at punch.at, not earlier', () => {
  for (const fps of [25, 30, 50, 60]) {
    for (const shotLen of [1.2, 2.5, 4]) {
      const at = shotLen / 2;
      const cfg = { fps, width: 1080, height: 1920, durationInFrames: Math.round((shotLen + 1) * fps), words: [], sfxLibrary: { sounds: {} } };
      const m = kit.buildManifest(kit.compileLayer({ captions: false, items: [],
        camera: { face, shots: [{ at: 0, preset: 'W', drift: 'in' }, { at: shotLen, preset: 'M', drift: 'out' }],
          punches: [{ at, until: at + 0.3 }] } }, cfg));
      const d = detectCameraEvents(m.camera, avatar.camera, 1, fps);
      const punch = d.events.find((e) => e.kind === 'punch');
      assert.ok(punch, `fps=${fps} shotLen=${shotLen}: no punch detected`);
      assert.equal(punch.frame, Math.round(at * fps), `fps=${fps} shotLen=${shotLen}`);
    }
  }
});

// Граничный случай владельца: план держится статичным (дрейф W(in), без единого реза) до самого
// панча на 2,56 с — план длиной РОВНО 2,56 с обязан провалить G1 (fail), а не только предупредить.
// На старом riseStart панч датировался на кадры раньше 2,5 с, и план измерялся короче порога.
test('a static drift-in plan up to a punch at 2.56 s fails G1, not just warns', () => {
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 125, words: [], sfxLibrary: { sounds: {} } };
  const m = kit.buildManifest(kit.compileLayer({ captions: false, items: [],
    camera: { face, shots: [{ at: 0, preset: 'W', drift: 'in' }], punches: [{ at: 2.56, until: 2.86 }] } }, cfg));
  const g = gateRhythm(m, avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 2.56);
});

// Регресс на «riseStart без границы окна»: рост держится на 1 %/кадр (это ≥ 10 % от собственного
// пика панча в 3 %/кадр, поэтому условие «растёт заметно» никогда естественно не обрывается) 60
// кадров подряд, потом переходит в панч на 3 %/кадр. Без нижней границы `from` отмотка ушла бы к
// самому кадру 0, а не остановилась на границе окна панча (b6 = кадр срабатывания − 6).
test('riseStart never walks back past its own punch window, even on a sustained climb', () => {
  const slowRate = 1.01;
  const fastStart = 60;
  const fastRate = 1.03;
  const m = manifestFixture({ seconds: 4, camera: (f) => (f < fastStart
    ? { s: slowRate ** f }
    : { s: (slowRate ** fastStart) * (fastRate ** (f - fastStart)) }) });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events.map((e) => e.kind), ['punch']);
  assert.equal(d.events[0].frame, 56, 'riseStart должен остановиться на границе окна панча, а не на кадре 0');
});

// П.5: сдвиг лица считается по евклидовому расстоянию — диагональный сдвиг 70×70 px даёт ≈99 px и
// уже режет план, хотя по каждой оси отдельно 70 px ниже порога 85. Плюс отдельная слабая полоса
// сдвига (weakShiftPx=40): 60 px не режет план, но виден зрителю и должен попасть в G2.
test('face shift uses Euclidean distance for the cut rule, with a separate weak-shift band', () => {
  const diag = manifestFixture({ seconds: 3, camera: (f) => (f < 50 ? { s: 1 } : { s: 1, dx: 70, dy: 70 }) });
  assert.deepEqual(detectCameraEvents(diag.camera, avatar.camera, 1, 25).events.map((e) => e.kind), ['cut']);

  const weakShift = manifestFixture({ seconds: 3, camera: (f) => (f < 50 ? { s: 1 } : { s: 1, dx: 60 }) });
  const d = detectCameraEvents(weakShift.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events, []);
  assert.equal(d.weak[0].reason, 'shift');
  const g2 = gateWeakCuts(weakShift, avatar);
  assert.equal(g2.status, 'warn');
  assert.match(g2.spans[0].note, /сдвиг 60 px/);
});

// П.6: слабую смену показываем в G2, только если зритель мог её увидеть — под размытием или
// когда спикер полностью пропал (away/вставка), вибрация масштаба или лица не существует для
// зрителя и не должна попадать в отчёт.
test('a weak change is not reported while the speaker is not sharp (opacity 0 or heavy blur)', () => {
  const invisible = manifestFixture({ seconds: 3, camera: (f) => (f < 50 ? { s: 1, opacity: 0 } : { s: 1.08, opacity: 0 }) });
  assert.deepEqual(detectCameraEvents(invisible.camera, avatar.camera, 1, 25).weak, []);
  const blurred = manifestFixture({ seconds: 3, camera: (f) => (f < 50 ? { s: 1, blur: 20 } : { s: 1.08, blur: 20 }) });
  assert.deepEqual(detectCameraEvents(blurred.camera, avatar.camera, 1, 25).weak, []);
});

// П.7: «съеденный» (упёршийся в maxScale) панч не должен всплывать в G2 как слабый джамп-кат — это
// проблема клэмпа камеры (гейт G3 задачи 22), а не незаметная зрителю мелкая смена. Реалистичная
// 3-шаговая спираль пружины (1,0→1,03→1,06→1,08, убывающий прирост — как у затухающей пружины), а
// не хайлайн-«бамп» в 1,5 % перед резом: тест не зависит от точного порога «плоскости» в 1 %
// (ревью пакета 3 задачи 22).
test('an eaten (clamped) punch is not reported as a weak cut in G2', () => {
  const eaten = manifestFixture({ seconds: 3, camera: (f) => {
    if (f < 50) return { s: 1, requested: 1 };
    if (f === 50) return { s: 1.03, requested: 1.03 };
    if (f === 51) return { s: 1.06, requested: 1.06 };
    return { s: 1.08, requested: 1.25 };
  } });
  const d = detectCameraEvents(eaten.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.weak, [], JSON.stringify(d.weak));
  assert.equal(gateWeakCuts(eaten, avatar).status, 'pass');
});

// П.8: спикер ни разу не был резким и видимым — ритм оценивать не по чему, это не «идеальные 0 с».
test('G1 is skipped, not a false "pass 0 s", when the speaker is never sharp', () => {
  const never = manifestFixture({ seconds: 3, camera: () => ({ s: 1, opacity: 0 }) });
  const g = gateRhythm(never, avatar);
  assert.equal(g.status, 'skipped');
  assert.notEqual(g.value, 0);
  assert.match(g.hint, /спикер не виден/);
});

test('assertCameraArrays throws a clear Russian error on a malformed manifest', () => {
  const ok = { s: [1, 1], requested: [1, 1], base: [1, 1], dx: [0, 0], dy: [0, 0], blur: [0, 0], opacity: [1, 1] };
  assert.throws(() => assertCameraArrays({ camera: { ...ok, opacity: [1] }, durationInFrames: 2 }),
    /манифест повреждён: camera\.opacity должен быть массивом из 2 конечных чисел/);
  assert.throws(() => assertCameraArrays({ camera: { ...ok, s: [1, NaN] }, durationInFrames: 2 }),
    /манифест повреждён: camera\.s должен быть массивом из 2 конечных чисел/);
  assert.throws(() => assertCameraArrays({ camera: { ...ok, base: [1] }, durationInFrames: 2 }),
    /манифест повреждён: camera\.base должен быть массивом из 2 конечных чисел/);
  assert.doesNotThrow(() => assertCameraArrays({ camera: ok, durationInFrames: 2 }));
});

// П.9: текст подсказки и порога показывает отмасштабированный сдвиг, а не всегда «85 px».
test('hint and threshold texts show the shift scaled for the frame size', () => {
  const m4k = manifestFixture({ seconds: 1, width: 2160, height: 3840 });
  assert.match(gateRhythm(m4k, avatar).hint, /сдвиг лица ≥ 170 px/);
  assert.match(gateWeakCuts(m4k, avatar).threshold, /≥ 170 px/);
  const m1080 = manifestFixture({ seconds: 1 });
  assert.match(gateRhythm(m1080, avatar).hint, /сдвиг лица ≥ 85 px/);
  assert.match(gateWeakCuts(m1080, avatar).threshold, /≥ 85 px/);
});

// П.10: scale/fps обязательны (никакого молчаливого дефолта на нестандартном кадре), а
// speakerPlans отдаёт планы в хронологическом порядке — сортировку по длине делает сам гейт.
test('detectCameraEvents requires scale and fps, and speakerPlans returns chronological order', () => {
  const camera = manifestFixture({ seconds: 1 }).camera;
  assert.throws(() => detectCameraEvents(camera, avatar.camera), /нужен scale > 0/);
  assert.throws(() => detectCameraEvents(camera, avatar.camera, 1), /нужен fps > 0/);
  assert.throws(() => detectCameraEvents(camera, avatar.camera, 0, 25), /нужен scale > 0/);

  const cuts = manifestFixture({ seconds: 6, camera: (f) => ({ s: Math.floor(f / 50) % 2 ? 1.18 : 1 }) });
  const plans = speakerPlans(cuts.camera, detectCameraEvents(cuts.camera, avatar.camera, 1, 25), 25);
  assert.deepEqual(plans.map((p) => p.from), [0, 50, 100]);
});

// --- Дожим мутационных выживших (мутатор ревью, отчёт после правок) ---

// punchWindow при 50 fps должен реально расширяться до ~12 кадров (не оставаться константой 6):
// плавный рост 1 %/кадр 11 кадров подряд перегоняет punchScale только внутри окна в 12 кадров —
// с окном 6 такой рост никогда не перевалит порог ни в одном 6-кадровом срезе.
test('punchWindow really scales with fps, not just its collapse/nearEvent radius', () => {
  const m = manifestFixture({ seconds: 4, fps: 50, camera: (f) => {
    if (f < 100) return { s: 1 };
    const n = Math.min(f - 100, 11);
    return { s: 1 + 0.01 * n };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 50);
  assert.deepEqual(d.events.map((e) => e.kind), ['punch'], 'с окном 6 такой плавный рост вообще не виден');
});

// Порог панча ровно на границе 10 %: гладкий 5-кадровый рост до +10 % — уже панч.
test('the punch threshold is exact at 10 % growth over the punch window', () => {
  const mk = (target) => manifestFixture({ seconds: 4, camera: (f) => {
    if (f < 50) return { s: 1 };
    const n = Math.min(f - 50, 5);
    return { s: 1 + (target - 1) * (n / 5) };
  } });
  assert.deepEqual(detectCameraEvents(mk(1.10).camera, avatar.camera, 1, 25).events.map((e) => e.kind), ['punch']);
});

// Схлопка держит РАЗРЫВ > 2, а не > 3: два изолированных фокус-события ровно в 3 кадрах друг от
// друга обязаны остаться двумя разными событиями, а не слиться в одно.
test('collapse keeps events exactly 3 frames apart separate (gap > 2, not > 3)', () => {
  const m = manifestFixture({ seconds: 4, camera: (f) => {
    const blurry = (f >= 50 && f < 55) || (f >= 58 && f < 63);
    return { s: 1, blur: blurry ? 20 : 0 };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events.map((e) => e.frame), [50, 55, 58, 63]);
});

// Окно джамп-ката — 2 кадра, не 1: скачок 8 % за 2 отдельных 4%-кадра не виден построчному
// сравнению «через один кадр», но обязан всплыть в 2-кадровом сравнении.
test('the jump comparison uses a 2-frame window, catching a jump split across two 4 % steps', () => {
  const m = manifestFixture({ seconds: 3, camera: (f) => {
    if (f < 50) return { s: 1 };
    if (f === 50) return { s: 1.04 };
    return { s: 1.08 };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events, []);
  assert.equal(d.weak.length, 1);
  assert.equal(d.weak[0].frame, 51);
});

// Короткая сторона кадра — не всегда width: у горизонтального 1920×1080 короткая сторона это
// height (1080), а не ширина (1920). scale должен считаться от min(width,height).
// Гейты сами считают frameScale (не тест) — вызываем через gateWeakCuts, а не detectCameraEvents
// напрямую с захардкоженным scale, иначе мутант в самом frameScale остался бы невидим тесту.
test('frameScale uses the short side, not width, on a landscape frame', () => {
  const m = manifestFixture({ seconds: 3, width: 1920, height: 1080, camera: (f) => (f < 50 ? { s: 1 } : { s: 1, dx: 100 }) });
  assert.equal(gateWeakCuts(m, avatar).value, 0, '100 px по короткой стороне 1080 (scale=1) — это уже полноценный рез, не слабый');
  const g1 = gateRhythm(m, avatar);
  assert.equal(g1.value, 2, 'рез на 100 px обязан разрезать план на кадре 50 (2 с)');
});

// Спаны G1 показывают все планы длиннее ПРЕДУПРЕЖДЕНИЯ, а не только длиннее СТОПА — иначе
// предупреждающий (не проваленный) отчёт остаётся без единого объяснения, что именно предупредило.
test('G1 spans include a warn-level plan, not only fail-level ones', () => {
  const g = gateRhythm(manifestFixture({ seconds: 6.9, camera: cutsEvery(2.3) }), avatar);
  assert.equal(g.status, 'warn');
  assert.ok(g.spans.length > 0, 'предупреждающий отчёт должен показывать хотя бы один план');
});

// Направление скачка не должно менять знак %: G2 всегда показывает положительную величину смены
// крупности (не «−8 %» для того же самого зума-аута на 8 %, который зритель видит как обычный
// заметный скачок, а не как нечто «отрицательное»).
test('G2 always reports a positive jump percentage, even for a shrinking scale', () => {
  const m = manifestFixture({ seconds: 3, camera: (f) => (f < 50 ? { s: 1.08 } : { s: 1 }) });
  const spans = gateWeakCuts(m, avatar).spans;
  assert.equal(spans.length, 1);
  assert.match(spans[0].note, /скачок 8 %/);
  assert.doesNotMatch(spans[0].note, /-/);
});

// Спаны G1 ограничены пятью худшими планами, даже если провалившихся планов больше.
test('G1 spans are capped at 5, even with more failing plans', () => {
  const g = gateRhythm(manifestFixture({ seconds: 18.2, camera: cutsEvery(2.6) }), avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.spans.length, 5);
});

// weakShiftPx масштабируется вместе с shiftPx: на 4K (scale=2) полоса слабого сдвига — 80 px, а не
// 40 (нетронутый профиль) и не 60 (сдвинутый на фиксированные 10 px).
test('weakShiftPx scales with the frame size like shiftPx', () => {
  const mk = (dx) => manifestFixture({ seconds: 3, width: 2160, height: 3840, camera: (f) => (f < 50 ? { s: 1 } : { s: 1, dx }) });
  const d90 = detectCameraEvents(mk(90).camera, avatar.camera, 2, 25);
  assert.deepEqual(d90.events, []);
  assert.equal(d90.weak.length, 1, '90 px на 4K уже выше отмасштабированного порога 80 px');
  const d70 = detectCameraEvents(mk(70).camera, avatar.camera, 2, 25);
  assert.deepEqual(d70.weak, [], '70 px на 4K ещё ниже отмасштабированного порога 80 px');
});

// Ступенька судится своим порогом (weakScale), а не более мягким: 7 %-й скачок с плоскими
// соседями — ступенька и должен подавить панч внутри своего окна, пока окно не «состарится» мимо
// него; распознанный панч должен остаться привязан к кадру 59 (где ступенька уже вне окна), а не
// проскочить на 54 из-за того, что 7 % ошибочно не считается ступенькой.
test('the step threshold matches weakScale exactly, not a looser value', () => {
  const m = manifestFixture({ seconds: 3, camera: (f) => {
    if (f < 53) return { s: 1.0 };
    if (f < 55) return { s: 1.07 };
    if (f === 55) return { s: 1.10 };
    if (f === 56) return { s: 1.13 };
    if (f === 57) return { s: 1.16 };
    return { s: 1.20 };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events.map((e) => e.frame), [59]);
});

// «Плоские соседи» ступеньки — это <1 % изменения, а не <5 %: у настоящего плавного роста (3–7 %
// за кадр) соседний с ним «скачок» не должен ошибочно сойти за отдельную ступеньку и подавить
// панч, который иначе был бы найден верно.
test('a step\'s "flat neighbour" tolerance is exact at 1 %, not looser', () => {
  const m = manifestFixture({ seconds: 3, camera: (f) => {
    if (f < 50) return { s: 1.0 };
    if (f === 50) return { s: 1.03 };
    if (f === 51) return { s: 1.10 };
    if (f === 52) return { s: 1.13 };
    return { s: 1.18 };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events.map((e) => e.kind), ['punch']);
});

// hardIn — отдельная от stepIn проверка: рез/фокус внутри окна панча подавляет его, даже когда
// это не «ступенька» по камере (например смена фокуса от размытия), — без неё сглаженный рост
// после случайного блюр-пульса всё равно вспыхнул бы ложным панчем.
test('a focus event inside the punch window suppresses it even without a scale step', () => {
  const ramp = { 48: 1.0, 49: 1.025, 50: 1.05, 51: 1.08, 52: 1.11, 53: 1.15 };
  const m = manifestFixture({ seconds: 3, camera: (f) => {
    const s = f < 48 ? 1.0 : (ramp[f] ?? 1.15);
    return { s, blur: f === 50 ? 20 : 0 };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events.map((e) => e.kind), ['focus']);
});

// Видимость слабой смены проверяется в ОБЕИХ опорных точках (f и b2), не только в f: если f уже
// снова резкий, а b2 ещё нет (спикер только что вернулся), сравнение всё ещё пересекает невидимый
// зрителю участок и не должно попасть в G2.
test('weak-change visibility checks both endpoints (f and b2), not just f', () => {
  const m = manifestFixture({ seconds: 3, camera: (f) => {
    const opacity = f < 50 ? 0 : 1;
    const s = f < 51 ? 1 : 1.08;
    return { s, opacity };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.weak, []);
});

// --- Дожим мутационных выживших (пакет 3) ---

// «Плоские соседи» ступеньки требуются НЕЗАВИСИМО с каждой стороны: 1,1 %-й предшественник перед
// самой ступенькой (g−1) уже не плоский (порог — ровно 1 %), и ступенька не должна засчитаться,
// даже если сосед С ДРУГОЙ стороны идеально плоский. Тот же кадр 53 при этом действительно ≥ 6 %
// (иначе сам критерий ступеньки никогда не проверится).
test('a step needs flat(g-1) independently: a 1.1 % precursor before it blocks the step', () => {
  const m = manifestFixture({ seconds: 3, camera: (f) => {
    if (f < 52) return { s: 1.0 };
    if (f === 52) return { s: 1.011 }; // 1,1 % — уже не плоско по порогу 1 %
    if (f === 53) return { s: 1.011 * 1.07 }; // сам скачок ступеньки — 7 %
    if (f === 54) return { s: 1.011 * 1.07 * 1.005 }; // сосед после — плоский (0,5 %)
    if (f <= 56) return { s: 1.011 * 1.07 * 1.005 * (1.03 ** (f - 54)) };
    return { s: 1.011 * 1.07 * 1.005 * 1.03 * 1.03 };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  // Без ложной «ступеньки» окно панча свободно — растущая часть после кадра 53 засчитывается панчем.
  assert.deepEqual(d.events.map((e) => e.kind), ['punch']);
});

// Симметричный случай: сосед ПОСЛЕ ступеньки (g+1) не плоский, сосед ДО — плоский.
test('a step needs flat(g+1) independently: a 1.1 % successor after it blocks the step', () => {
  const m = manifestFixture({ seconds: 3, camera: (f) => {
    if (f < 53) return { s: 1.0 };
    if (f === 53) return { s: 1.07 }; // сам скачок — 7 %, сосед до (52) плоский
    if (f === 54) return { s: 1.07 * 1.011 }; // сосед после — уже не плоский (1,1 %)
    if (f <= 56) return { s: 1.07 * 1.011 * (1.03 ** (f - 54)) };
    return { s: 1.07 * 1.011 * 1.03 * 1.03 };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events.map((e) => e.kind), ['punch']);
});

// speakerPlans хронологичен даже когда длины планов РАЗНЫЕ: сортировка по длине (топ-5 самых
// длинных) — забота гейта, а не speakerPlans; при разных длинах сортировка по убыванию дала бы
// другой порядок [20, 90, 0], а не по времени [0, 20, 90].
test('speakerPlans stays chronological even with unequal plan lengths (not sorted by length)', () => {
  const m = manifestFixture({ seconds: 6, camera: (f) => {
    if (f < 20) return { s: 1 };
    if (f < 90) return { s: 1.18 };
    return { s: 1 };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  const plans = speakerPlans(m.camera, d, 25);
  assert.deepEqual(plans.map((p) => p.from), [0, 20, 90]);
});

// G1 действительно использует manifest.fps внутри своего вызова detectCameraEvents, а не
// зашитые 25: медленный рост 1 %/кадр 11 кадров подряд перегоняет punchScale только в окне,
// отмасштабированном под настоящие 50 fps (~12 кадров) — с окном под 25 fps (6 кадров) панч не
// находится вовсе, и план ошибочно меряется на всю композицию (4 с, provided fail).
test('G1 really uses manifest.fps for its own detectCameraEvents call, not a fixed 25', () => {
  const m = manifestFixture({ seconds: 4, fps: 50, camera: (f) => {
    if (f < 100) return { s: 1 };
    const n = Math.min(f - 100, 11);
    return { s: 1 + 0.01 * n };
  } });
  const g = gateRhythm(m, avatar);
  assert.equal(g.status, 'pass');
  assert.equal(g.value, 2);
});

// G1 обязан провалиться на битом манифесте точно так же, как G2 — assertCameraArrays должна быть
// подключена в обоих гейтах, а не только в одном.
test('gateRhythm throws the same clear error as gateWeakCuts on a malformed manifest', () => {
  const bad = { fps: 25, width: 1080, height: 1920, durationInFrames: 3,
    camera: { s: [1, 1], requested: [1, 1], dx: [0, 0], dy: [0, 0], blur: [0, 0], opacity: [1, 1] } };
  assert.throws(() => gateRhythm(bad, avatar), /манифест повреждён: camera\.s должен быть массивом из 3 конечных чисел/);
});

// Порог «съеденного» панча — ровно профильный eatenPunch (1,05), а не более строгий 1,10:
// requested/s = 1,07 (между 1,05 и 1,10) уже обязан считаться съеденным и не попадать в G2.
// Реалистичная 3-шаговая спираль (1,0→1,03→1,06→1,08) вместо хайлайн-«бампа» — не зависит от
// точного порога «плоскости» в 1 % (ревью пакета 3 задачи 22).
test('the eaten-punch threshold is exact at the profile value (1.05), not a stricter 1.10', () => {
  const m = manifestFixture({ seconds: 3, camera: (f) => {
    if (f < 50) return { s: 1, requested: 1 };
    if (f === 50) return { s: 1.03, requested: 1.03 };
    if (f === 51) return { s: 1.06, requested: 1.06 };
    return { s: 1.08, requested: 1.08 * 1.07 };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.weak, [], 'requested/s = 1,07 ≥ eatenPunch(1,05) должно быть съедено');
});

// Клэмп панча проявляется не в самом кадре f, а на кадр-другой позже (пружина ещё не успела
// упереться в потолок) — «съеденность» нужно смотреть по всему окну панча вперёд от f, иначе
// реальный клэмпнутый панч на пресете s=1,16 всё ещё всплывает в G2 как «скачок 7 %».
test('an eaten punch is caught by looking ahead over the punch window, not only the flagged frame', () => {
  const kit = require('../scripts/motion-kit-node').loadKitCore();
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 125, words: [], sfxLibrary: { sounds: {} } };
  const m = kit.buildManifest(kit.compileLayer({ captions: false, items: [],
    camera: { face, presets: { X: { s: 1.16 } }, shots: [{ at: 0, preset: 'X', drift: 'none' }],
      punches: [{ at: 2, until: 3 }] } }, cfg));
  assert.equal(gateWeakCuts(m, avatar).status, 'pass', JSON.stringify(gateWeakCuts(m, avatar)));
});

// riseStart считает top ТОЛЬКО внутри окна панча [from+1, to], не по всему массиву: посторонний
// огромный рез задолго до панча (здесь — 300 % на кадре 5) не должен задирать порог «заметного
// роста» для настоящего панча далеко после него.
test('riseStart computes top only within its own punch window, not over the whole clip', () => {
  const m = manifestFixture({ seconds: 5, camera: (f) => {
    if (f < 5) return { s: 1.0 };
    if (f < 90) return { s: 4.0 };
    const base = 4.0 * (1.0005 ** Math.min(f - 90, 4));
    if (f < 94) return { s: base };
    return { s: base * (1.03 ** (f - 94)) };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  const punch = d.events.find((e) => e.kind === 'punch');
  assert.ok(punch);
  assert.equal(punch.frame, 94, 'посторонний рез на кадре 5 не должен сдвигать датировку панча');
});

// Окно «съеденности» смотрит от f включительно, а не с f+1: клэмп может проявиться уже В САМОМ
// отмеченном кадре, а не только на следующих. Реалистичная форма вместо хайлайн-«бампа» (ревью
// пакета 3 задачи 22): пружина доходит до 1,07 на кадре 53 (съедено — requested/s=1,06), затем ещё
// чуть доигрывает до 1,095 на кадре 54 (уже не съедено) — та же пружина, что не успела остановиться
// ровно в момент клэмпа, а не искусственный «бамп» перед резом.
test('the eaten-punch lookahead window includes the flagged frame itself, not only later ones', () => {
  const m = manifestFixture({ seconds: 3, camera: (f) => {
    if (f < 53) return { s: 1, requested: 1 };
    if (f === 53) return { s: 1.07, requested: 1.07 * 1.06 }; // съедено ровно в кадре 53
    return { s: 1.095, requested: 1.095 }; // пружина доигрывает, дальше клэмпа уже нет
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.weak.map((w) => w.frame), [54], 'кадр 53 съеден, а 54 — уже нет и должен остаться слабым');
});

// hardIn не должен считать рез РОВНО на границе окна (b6) «резом внутри окна»: значение s[b6] уже
// само отражает состояние ПОСЛЕ реза, поэтому сравнивать с ним панч можно как обычно.
test('a cut exactly at the punch window boundary does not suppress the punch (exclusive bound)', () => {
  const m = manifestFixture({ seconds: 4, camera: (f) => {
    if (f < 50) return { s: 1.0 };
    if (f === 50) return { s: 1.5 };
    const n = Math.min(f - 50, 6);
    return { s: 1.5 * (1.02 ** n) };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events.map((e) => e.kind), ['cut', 'punch']);
});

// gateWeakCuts обязан провалиться на битом манифесте точно так же, как gateRhythm.
test('gateWeakCuts throws the same clear error as gateRhythm on a malformed manifest', () => {
  const bad = { fps: 25, width: 1080, height: 1920, durationInFrames: 3,
    camera: { s: [1, 1], requested: [1, 1], dx: [0, 0], dy: [0, 0], blur: [0, 0], opacity: [1, 1] } };
  assert.throws(() => gateWeakCuts(bad, avatar), /манифест повреждён: camera\.s должен быть массивом из 3 конечных чисел/);
});

// Спаны G2 ограничены пятью худшими слабыми сменами, даже если их больше.
test('G2 spans are capped at 5, even with more weak changes', () => {
  const m = manifestFixture({ seconds: 10, camera: (f) => ({ s: Math.floor(f / 20) % 2 ? 1.07 : 1.0 }) });
  const g2 = gateWeakCuts(m, avatar);
  assert.equal(g2.value, 12);
  assert.equal(g2.spans.length, 5);
});

// --- Step 0 (перед задачей 22): ступенька никогда не «съедена» ---

// Ступенька (жёсткий рез между двумя shots, не спираль панча) в пресет выше предела масштаба
// (1,12 → 1,35, клэмпнуто до 1,25, +11,6 %) — зритель видит этот скачок независимо от того, что
// requested у него тоже перевалил eatenPunch. Раньше eaten(f) подавлял такую ступеньку и G2 молчал.
test('a hard step into a preset above the scale limit is still reported by G2, not swallowed as an eaten punch', () => {
  const m = manifestFixture({ seconds: 3, camera: (f) => (f < 50
    ? { s: 1.12, requested: 1.12 }
    : { s: 1.25, requested: 1.35 }) });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.weak.map((w) => w.frame), [50]);
  assert.equal(gateWeakCuts(m, avatar).status, 'warn');
});

// Пин длины окна «съеденности»: клэмп на f+4 (внутри честного окна f+punchWindow=6) обязан
// подавить слабый скачок; клэмп на f+8 (уже за пределами f+punchWindow) — не обязан. Мутант
// f+2 упустил бы первый случай, мутант f+2·punchWindow (12) ошибочно подавил бы второй.
test('the eaten lookahead window is exactly [f, f+punchWindow], not f+2 or f+2·punchWindow', () => {
  const near = manifestFixture({ seconds: 4, camera: (f) => {
    if (f <= 58) return { s: 1.0 };
    if (f === 59) return { s: 1.04 };
    if (f >= 60 && f < 64) return { s: 1.08 };
    return { s: 1.08, requested: 1.08 * 1.06 };
  } });
  assert.deepEqual(detectCameraEvents(near.camera, avatar.camera, 1, 25).weak, [],
    'клэмп на f+4 (внутри окна панча f+6) обязан считаться съеденным — окно короче f+punchWindow это упустит');

  const far = manifestFixture({ seconds: 4, camera: (f) => {
    if (f <= 58) return { s: 1.0 };
    if (f === 59) return { s: 1.04 };
    if (f >= 60 && f < 68) return { s: 1.08 };
    return { s: 1.08, requested: 1.08 * 1.06 };
  } });
  const d = detectCameraEvents(far.camera, avatar.camera, 1, 25);
  assert.ok(d.weak.some((w) => w.frame === 60),
    'клэмп на f+8 (за пределами окна панча f+6) не должен считаться съеденным — окно длиннее f+punchWindow подавило бы настоящий слабый скачок');
});

// Пин top в riseStart: настоящий пик роста (+8 % на кадре 59) стоит в СЕРЕДИНЕ окна панча, а не на
// самом флагнутом кадре (61, где рост уже погас до +1 %). Если бы top считался только по кадру
// «to», порог отмотки оказался бы в разы меньше и riseStart ушёл бы на кадр раньше настоящего
// начала роста (57 вместо 58 — уже захватив кадр 58 с крохотным 0,5 % разгоном).
test('riseStart computes top over the whole punch window, not only at the flagged frame', () => {
  const m = manifestFixture({ seconds: 4, camera: (f) => {
    if (f <= 57) return { s: 1 };
    if (f === 58) return { s: 1.005 };
    if (f === 59) return { s: 1.005 * 1.08 };
    if (f === 60) return { s: 1.005 * 1.08 * 1.01 };
    return { s: 1.005 * 1.08 * 1.01 * 1.01 };
  } });
  const d = detectCameraEvents(m.camera, avatar.camera, 1, 25);
  assert.deepEqual(d.events.map((e) => e.kind), ['punch']);
  assert.equal(d.events[0].frame, 58,
    'top должен считаться по максимуму окна (кадр 59, +8 %), а не только на флагнутом кадре (61, +1 %)');
});

// --- Задача 22: G3 «Масштаб», G4 «Спикер в первые 3 с», G10 «Сток», G11 «Чужое видео» ---

test('scale above 1.25 stops, a punch eaten by the limit warns', () => {
  assert.equal(gateScale(manifestFixture({ camera: () => ({ s: 1.3 }) }), avatar).status, 'fail');
  assert.equal(gateScale(manifestFixture({ camera: () => ({ s: 1.25, requested: 1.36 }) }), avatar).status, 'warn');
  assert.equal(gateScale(manifestFixture({ camera: cutsEvery(2) }), avatar).status, 'pass');
});

// Граница ревью: 1,26 выше предела 1,25 + допуск (1e-3) — обязан провалить, не просто предупредить.
test('scale exactly 1.26 fails, not just warns', () => {
  assert.equal(gateScale(manifestFixture({ camera: () => ({ s: 1.26 }) }), avatar).status, 'fail');
});

// --- Ревью пакета 2: причина клэмпа решает cameraAt.base, а не форма кривой (ступенька/спираль) ---
// Раньше G3 угадывал причину по «это ступенька или нет» и ошибался в обе стороны: панч, удержанный
// через рез между shots, списывался на пресет; пресет выше предела с кадра 0 или растущий только
// за счёт дрейфа (без единого панча) списывался на панч. base = масштаб пресета×дрейф ДО панча и
// ДО клэмпа — источник истины независимо от формы кривой.

// Панч (0,8–2,2 с) держится через рез W→M на 1,5 с — ни один пресет (W=1,0, M=1,18) сам по себе не
// превышает предел, значит base никогда не выше 1,25: причина обязана остаться «панч».
test('REAL KIT: a punch held across a W->M cut is still blamed on the punch, not the preset', () => {
  const m = kit.buildManifest(kit.compileLayer({ items: [], captions: false,
    camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }, { at: 1.5, preset: 'M', drift: 'none' }],
      punches: [{ at: 0.8, until: 2.2 }] } },
  { fps: 25, width: 1080, height: 1920, durationInFrames: 100, words: [], sfxLibrary: { sounds: {} } }));
  const g = gateScale(m, avatar);
  assert.equal(g.status, 'warn');
  assert.match(g.spans[0].note, /панч-ин упёрся/);
  assert.doesNotMatch(g.spans[0].note, /пресет/);
});

// Пресет XL=1,35 с кадра 0, без единого punch — base=1,35 весь ролик (кит клэмпит видимый s до
// 1,25, но base остаётся выше предела) — обязана быть причина «пресет», не «панч» (панчей нет
// вовсе).
test('REAL KIT: an over-limit preset from frame 0 without any punches is blamed on the preset', () => {
  const m = kit.buildManifest(kit.compileLayer({ items: [], captions: false,
    camera: { face, presets: { XL: { s: 1.35 } }, shots: [{ at: 0, preset: 'XL', drift: 'none' }] } },
  { fps: 25, width: 1080, height: 1920, durationInFrames: 100, words: [], sfxLibrary: { sounds: {} } }));
  const g = gateScale(m, avatar);
  assert.equal(g.status, 'warn');
  assert.match(g.spans[0].note, /пресет/);
  assert.doesNotMatch(g.spans[0].note, /панч-ин упёрся/);
  assert.match(g.hint, /пресет/);
});

// Пресет XL=1,30 с drift:'in' — растёт только за счёт дрейфа (без единого punch), base доходит до
// 1,30×1,05=1,365 к концу дрейфа: причина «пресет», не «панч», хотя кривая растёт плавно, как
// спираль панча.
test('REAL KIT: an over-limit preset growing only via drift-in (no punch) is blamed on the preset', () => {
  const m = kit.buildManifest(kit.compileLayer({ items: [], captions: false,
    camera: { face, presets: { XL: { s: 1.30 } }, shots: [{ at: 0, preset: 'XL', drift: 'in' }] } },
  { fps: 25, width: 1080, height: 1920, durationInFrames: 100, words: [], sfxLibrary: { sounds: {} } }));
  const g = gateScale(m, avatar);
  assert.equal(g.status, 'warn');
  assert.match(g.spans[0].note, /пресет/);
  assert.doesNotMatch(g.spans[0].note, /панч-ин упёрся/);
});

// Fail-случай (camera.maxScale плана выше предела профиля) обязан получить спаны кадров ВЫШЕ
// предела — не пустой список, хотя requested==s (кит сам ничего не «съедает», клэмпит только свой
// собственный maxScale). Подсказка называет camera.maxScale и порог динамически, без хардкода
// «1,25»/«720p» — тот же профиль с другим scale.max должен получить другой текст.
test('the fail case gets spans of the over-limit frames, and the hint names the limit dynamically', () => {
  const m = kit.buildManifest(kit.compileLayer({ items: [], captions: false,
    camera: { face, maxScale: 1.35, presets: { XL: { s: 1.35 } }, shots: [{ at: 0, preset: 'XL', drift: 'none' }] } },
  { fps: 25, width: 1080, height: 1920, durationInFrames: 100, words: [], sfxLibrary: { sounds: {} } }));
  const g = gateScale(m, avatar);
  assert.equal(g.status, 'fail');
  assert.ok(g.spans.length > 0, 'fail обязан показать спаны кадров выше предела');
  assert.match(g.spans[0].note, /выше предела 1,25/);
  assert.match(g.hint, /1,25/);
  assert.doesNotMatch(g.hint, /720p/);
  const strict = { ...avatar, scale: { max: 1.1 } };
  const g2 = gateScale(manifestFixture({ camera: () => ({ s: 1.2 }) }), strict);
  assert.equal(g2.status, 'fail');
  assert.match(g2.hint, /1,1/, 'подсказка обязана называть ПОРОГ ЭТОГО профиля, а не хардкод 1,25');
});

// Спаны G3 ограничены пятью худшими зонами, даже если их больше.
test('G3 spans are capped at 5, even with more clamped zones', () => {
  const m = manifestFixture({ seconds: 10, camera: (f) => ({
    s: Math.floor(f / 20) % 2 ? 1.2 : 1.0, requested: Math.floor(f / 20) % 2 ? 1.3 : 1.0,
  }) });
  const g = gateScale(m, avatar);
  assert.equal(g.status, 'warn');
  assert.equal(g.spans.length, 5);
});

test('gateScale throws the same clear error as the other manifest gates on a malformed manifest', () => {
  const bad = { fps: 25, width: 1080, height: 1920, durationInFrames: 3,
    camera: { s: [1, 1], requested: [1, 1], dx: [0, 0], dy: [0, 0], blur: [0, 0], opacity: [1, 1] } };
  assert.throws(() => gateScale(bad, avatar), /манифест повреждён: camera\.s должен быть массивом из 3 конечных чисел/);
});

// --- G4: правило автора (owner's documented rule) — «в первом кадре и первые 2–3 секунды виден
// спикер». СТОП — скрыт хоть на одном кадре в [0, mustSec=2 с); ПРЕДУПРЕЖДЕНИЕ — скрыт только в
// [mustSec, sec=3 с). Хук-перечисление освобождает от обоих требований. ---

test('hidden at frame 49 of 25 fps (1.96 s, inside mustSec) fails', () => {
  const m = manifestFixture({ camera: (f) => ({ s: 1, opacity: f === 49 ? 0 : 1 }) });
  assert.equal(gateHook(m, avatar).status, 'fail');
});

test('hidden only between 2.0 and 2.9 s (inside sec, outside mustSec) warns', () => {
  const m = manifestFixture({ camera: (f) => ({ s: 1, opacity: (f >= 50 && f < 72) ? 0 : 1 }) });
  const g = gateHook(m, avatar);
  assert.equal(g.status, 'warn');
  assert.deepEqual([g.spans[0].fromSec, g.spans[0].toSec], [2, 2.88]);
});

test('blurred but visible the whole time passes', () => {
  const m = manifestFixture({ camera: () => ({ s: 1, blur: 20, opacity: 1 }) });
  assert.equal(gateHook(m, avatar).status, 'pass');
});

test('a cover insert from 0 s fails: the speaker is hidden inside the critical mustSec window', () => {
  const m = manifestFixture({ inserts: [{ id: 'stock-1', kind: 'stock', from: 0, to: 80, cover: true }] });
  assert.equal(gateHook(m, avatar).status, 'fail');
});

test('at 60 fps the same 1.95 s / 2.0-2.9 s windows fail / warn', () => {
  const failM = manifestFixture({ fps: 60, camera: (f) => ({ s: 1, opacity: f === 117 ? 0 : 1 }) });
  assert.equal(gateHook(failM, avatar).status, 'fail');
  const warnM = manifestFixture({ fps: 60, camera: (f) => ({ s: 1, opacity: (f >= 120 && f < 174) ? 0 : 1 }) });
  assert.equal(gateHook(warnM, avatar).status, 'warn');
});

// Изменённый тест плана (ревью пакета 2): раньше «спикер виден хотя бы на одном кадре из первых
// 3 с» проходило, если он пропадал уже с кадра 10 (0,4 с) и не возвращался. Owner's rule требует
// видимости на КАЖДОМ кадре первых mustSec=2 с — тот же фикстур обязан теперь провалить гейт.
test('CHANGED (plan-derived): visible only on the first 10 frames now fails, not passes', () => {
  const g = gateHook(manifestFixture({ camera: (f) => ({ s: 1, blur: 20, opacity: f < 10 ? 1 : 0 }) }), avatar);
  assert.equal(g.status, 'fail');
});

test('hook: "enumeration" exempts both the stop and the warn window', () => {
  const stopShape = { camera: (f) => ({ s: 1, opacity: f === 49 ? 0 : 1 }), hook: 'enumeration' };
  assert.equal(gateHook(manifestFixture(stopShape), avatar).status, 'pass');
  const warnShape = { camera: (f) => ({ s: 1, opacity: (f >= 50 && f < 72) ? 0 : 1 }), hook: 'enumeration' };
  assert.equal(gateHook(manifestFixture(warnShape), avatar).status, 'pass');
});

test('gateHook throws the same clear error as the other manifest gates on a malformed manifest', () => {
  const bad = { fps: 25, width: 1080, height: 1920, durationInFrames: 3,
    camera: { s: [1, 1], requested: [1, 1], dx: [0, 0], dy: [0, 0], blur: [0, 0], opacity: [1, 1] }, inserts: [] };
  assert.throws(() => gateHook(bad, avatar), /манифест повреждён: camera\.s должен быть массивом из 3 конечных чисел/);
});

// --- G10 «Стоковые вставки» ---

test('stock count warns below the minimum for the video length', () => {
  const stock = (n) => Array.from({ length: n }, (_, i) => ({ id: `stock-${i + 1}`, kind: 'stock', from: i * 100, to: i * 100 + 50 }));
  assert.equal(gateStock(manifestFixture({ seconds: 60, inserts: stock(3) }), avatar).status, 'pass');
  assert.equal(gateStock(manifestFixture({ seconds: 60, inserts: stock(1) }), avatar).status, 'warn');
  assert.equal(gateStock(manifestFixture({ seconds: 30, inserts: stock(2) }), avatar).status, 'pass');
  assert.equal(gateStock(manifestFixture({ seconds: 30, inserts: stock(1) }), avatar).status, 'warn');
});

// Граница shortSec (45 с) пристёгнута с обеих сторон: РОВНО 45 с — это уже НЕ «< 45», значит порог
// min(3), а не minShort(2); чуть короче (44 с) — ещё «< 45», порог minShort(2).
test('the shortSec boundary is pinned on both sides: exactly 45 s needs min, just under needs minShort', () => {
  const stock = (n) => Array.from({ length: n }, (_, i) => ({ id: `stock-${i + 1}`, kind: 'stock', from: i * 10, to: i * 10 + 5 }));
  assert.equal(gateStock(manifestFixture({ seconds: 45, inserts: stock(2) }), avatar).status, 'warn', 'ровно 45 с — это уже min(3), не minShort(2)');
  assert.equal(gateStock(manifestFixture({ seconds: 45, inserts: stock(3) }), avatar).status, 'pass');
  assert.equal(gateStock(manifestFixture({ seconds: 44, inserts: stock(2) }), avatar).status, 'pass', '44 с < 45 — это ещё minShort(2)');
});

// --- G11 «Чужое видео» ---

test('a donor clip longer than 3 s in a row stops the layer', () => {
  const donor = (from, to) => [{ id: 'donor-1', kind: 'donor', from, to }];
  assert.equal(gateDonor(manifestFixture({ inserts: donor(33, 85) }), avatar).status, 'pass');
  const g = gateDonor(manifestFixture({ inserts: donor(33, 133) }), avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 4);
});

// Граница ровно на пороге: 3,00 с проходит, 3,04 с уже нет.
test('a donor run of exactly 3.00 s passes, 3.04 s fails', () => {
  assert.equal(gateDonor(manifestFixture({ inserts: [{ id: 'd', kind: 'donor', from: 0, to: 75 }] }), avatar).status, 'pass');
  const g = gateDonor(manifestFixture({ inserts: [{ id: 'd', kind: 'donor', from: 0, to: 76 }] }), avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 3.04);
});

// Уточнение оркестратора: «подряд» значит последовательно — донорские вставки, разделённые паузой
// ≤ profile.donor.gapSec (0,5 с по умолчанию), сливаются в один прогон ДО измерения. 3 с + 0,3 с
// (в кадре виден спикер) + 3 с = 6,3 с одного эпизода → fail.
test('donor runs separated by a 0.3 s gap (< gapSec) are merged into one 6.3 s run and fail', () => {
  const inserts = [
    { id: 'd1', kind: 'donor', from: 0, to: 3 * 25 },
    { id: 'd2', kind: 'donor', from: 3.3 * 25, to: 6.3 * 25 },
  ];
  const g = gateDonor(manifestFixture({ seconds: 10, inserts }), avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 6.3);
  assert.match(g.spans[0].note, /d1/);
  assert.match(g.spans[0].note, /d2/);
});

// Пауза 0,6 с (> gapSec 0,5 с) — прогоны остаются раздельными, оба по 3 с проходят.
test('a 0.6 s gap (> gapSec) keeps donor runs separate and both pass', () => {
  const inserts = [
    { id: 'd1', kind: 'donor', from: 0, to: 3 * 25 },
    { id: 'd2', kind: 'donor', from: 3.6 * 25, to: 6.6 * 25 },
  ];
  assert.equal(gateDonor(manifestFixture({ seconds: 10, inserts }), avatar).status, 'pass');
});

// Соседний сток (другой kind) не сливается с донором, даже вплотную.
test('an adjacent stock insert of a different kind is not merged with a donor run', () => {
  const inserts = [
    { id: 'd1', kind: 'donor', from: 0, to: 3 * 25 },
    { id: 'st1', kind: 'stock', from: 3 * 25, to: 5 * 25 },
  ];
  const g = gateDonor(manifestFixture({ seconds: 10, inserts }), avatar);
  assert.equal(g.status, 'pass');
  assert.equal(g.value, 3);
});

// Входной порядок вставок не гарантирован — merge сортирует по from сам.
test('unsorted donor input is still merged correctly', () => {
  const inserts = [
    { id: 'd2', kind: 'donor', from: 3.3 * 25, to: 6.3 * 25 },
    { id: 'd1', kind: 'donor', from: 0, to: 3 * 25 },
  ];
  const g = gateDonor(manifestFixture({ seconds: 10, inserts }), avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 6.3);
});

// Вложенный донор (целиком внутри другого) не должен расширить прогон СВОИМ to, если оно раньше
// внешнего to — Math.max(last.to, insert.to) поглощает его правильно.
test('a donor nested entirely inside another donor does not shrink or misextend the run', () => {
  const inserts = [
    { id: 'outer', kind: 'donor', from: 0, to: 10 * 25 },
    { id: 'inner', kind: 'donor', from: 2 * 25, to: 4 * 25 },
  ];
  const g = gateDonor(manifestFixture({ seconds: 12, inserts }), avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 10);
  assert.match(g.spans[0].note, /outer/);
  assert.match(g.spans[0].note, /inner/);
});

// value — самый длинный прогон донора всегда, даже когда гейт проходит (не только на fail).
test('G11 value is the longest donor run even when the gate passes', () => {
  const g = gateDonor(manifestFixture({ inserts: [{ id: 'd', kind: 'donor', from: 0, to: 50 }] }), avatar);
  assert.equal(g.status, 'pass');
  assert.equal(g.value, 2);
});

// Уточнение оркестратора: подсказка G11 называет cover:true для полноэкранного донора И явно
// говорит, что cover не влияет на сам вердикт (решает только видимость спикера).
test('G11 hint tells the author to use cover: true for a full-screen donor and says cover does not change the verdict', () => {
  const g = gateDonor(manifestFixture({ inserts: [{ id: 'donor-1', kind: 'donor', from: 0, to: 100 }] }), avatar);
  assert.match(g.hint, /cover: true/);
  assert.match(g.hint, /не влияет/);
});

// BAD CASE (уточнение после ревью пакета 1, ужесточено ревью пакета 2): cover-вставка с 0 с
// закрывает лицо карточкой сразу, даже пока уход камеры ещё гаснет — G4 обязан считать спикера
// невидимым внутри неё. Частичное закрытие (только первую секунду) теперь ТОЖЕ fail: по правилу
// автора спикер обязан быть виден на КАЖДОМ кадре первых mustSec=2 с, а не хотя бы на одном.
test('BAD CASE: a cover insert from 0 s hides the speaker even while the camera is still fading out', () => {
  const insert = (cover, to = 80) => [{ id: 'stock-1', kind: 'stock', from: 0, to, cover }];
  assert.equal(gateHook(manifestFixture({ inserts: insert(true) }), avatar).status, 'fail');
  assert.equal(gateHook(manifestFixture({ inserts: insert(false) }), avatar).status, 'pass');
  // Изменённый тест плана: раньше «видимо хотя бы на одном кадре из 3 с» проходило при частичном
  // закрытии первой секунды; owner's rule требует видимости на КАЖДОМ кадре первых 2 с — 1 с
  // закрытия внутри mustSec обязана провалить гейт.
  assert.equal(gateHook(manifestFixture({ inserts: insert(true, 25) }), avatar).status, 'fail');
});
