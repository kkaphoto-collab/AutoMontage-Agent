const test = require('node:test');
const assert = require('node:assert/strict');
const { getProfile } = require('../scripts/qa/profiles');
const { assertCameraArrays, detectCameraEvents, gateRhythm, gateWeakCuts, speakerPlans } = require('../scripts/qa/timeline-gates');
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
// проблема клэмпа камеры (гейт G3 задачи 22), а не незаметная зрителю мелкая смена.
test('an eaten (clamped) punch is not reported as a weak cut in G2', () => {
  const eaten = manifestFixture({ seconds: 3, camera: (f) => (f < 54 ? { s: 1, requested: 1 } : { s: 1.08, requested: 1.25 }) });
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
  const base = { s: [1, 1], requested: [1, 1], dx: [0, 0], dy: [0, 0], blur: [0, 0], opacity: [1, 1] };
  assert.throws(() => assertCameraArrays({ camera: { ...base, opacity: [1] }, durationInFrames: 2 }),
    /манифест повреждён: camera\.opacity должен быть массивом из 2 конечных чисел/);
  assert.throws(() => assertCameraArrays({ camera: { ...base, s: [1, NaN] }, durationInFrames: 2 }),
    /манифест повреждён: camera\.s должен быть массивом из 2 конечных чисел/);
  assert.doesNotThrow(() => assertCameraArrays({ camera: base, durationInFrames: 2 }));
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
