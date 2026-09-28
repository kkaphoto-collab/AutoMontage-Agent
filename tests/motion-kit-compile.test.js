const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');
const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250,
  words: [{ w: 'Привет', t: 'Привет', s: 0.2, e: 0.6 }, { w: 'мир.', t: 'мир.', s: 0.7, e: 1.1 }],
  sfxLibrary: { sounds: { 'whoosh-in': { file: 'sfx/whoosh-in.wav', lengthSec: 1, peakSec: 0.4 } } } };
const plan = {
  camera: { face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'M' }] },
  items: [{ id: 'title', kind: 'text', at: 0.2, until: 2, box: { x: 90, y: 300, w: 840, h: 200 }, sfx: 'whoosh' }],
  inserts: [{ kind: 'stock', from: 4, to: 6, src: 'stock/a.mp4' }],
};

test('compileLayer turns seconds into frames and wires inserts into the camera', () => {
  const layer = kit.compileLayer(plan, cfg);
  assert.equal(layer.kitVersion, kit.KIT_VERSION);
  assert.deepEqual([layer.items[0].from, layer.items[0].until], [5, 50]);
  // insert to=150f; away.to = 150 − ref25(CLOSE_FRAMES=6) − ref25(exitFrames=10) = 150 − 16 = 134:
  // the speaker's return finishes exactly when the reveal card starts closing, not just by insert.to.
  assert.deepEqual(layer.camera.aways, [{ from: 100, to: 134 }]);
  assert.equal(layer.cues.kept[0].name, 'whoosh-in');
  assert.equal(layer.captions.chunks[0].text, 'Привет мир.');
  assert.equal(layer.hook, 'speaker');
  assert.deepEqual(layer.waivers, []);
});

test('compileItems rejects duplicate ids, missing boxes and empty windows', () => {
  const base = { id: 'a', kind: 'text', at: 0, until: 1, box: { x: 0, y: 0, w: 1, h: 1 } };
  assert.throws(() => kit.compileItems([base, base], cfg), /нужен уникальный id/);
  assert.throws(() => kit.compileItems([{ ...base, box: null }], cfg), /box \{x,y,w,h\}/);
  assert.throws(() => kit.compileItems([{ ...base, until: 0 }], cfg), /until должен быть больше at/);
  assert.throws(() => kit.compileItems([{ ...base, kind: 'emoji' }], cfg), /kind должен быть/);
});

test('captions can be switched off and the hook and waivers pass through', () => {
  const layer = kit.compileLayer({ ...plan, captions: false, hook: 'enumeration', waivers: [{ gate: 'G4', reason: 'правка владельца' }] }, cfg);
  assert.equal(layer.captions, null);
  assert.equal(layer.hook, 'enumeration');
  assert.equal(layer.waivers[0].gate, 'G4');
});

// Task 18 review: captions.hide[i].from/to обязаны быть конечными секундами с from < to — иначе
// опечатка в plan.js (например, «until» вместо «to», давая undefined/NaN, или края задом наперёд)
// молча дала бы NaN-кадры или окно в обратную сторону в captionSpans, без единой ошибки на этапе
// layer check.
test('compileLayer rejects a captions.hide window with a backwards or non-finite from/to', () => {
  assert.throws(
    () => kit.compileLayer({ ...plan, captions: { hide: [{ from: 1, to: 0.5 }] } }, cfg),
    /captions\.hide\[0\]/,
  );
  assert.throws(
    () => kit.compileLayer({ ...plan, captions: { hide: [{ from: NaN, to: 1 }] } }, cfg),
    /captions\.hide\[0\]/,
  );
  assert.throws(
    () => kit.compileLayer({ ...plan, captions: { hide: [{ from: 0, to: undefined }] } }, cfg),
    /captions\.hide\[0\]/,
  );
  // Второе валидное окно после первого невалидного всё равно называет правильный индекс.
  assert.throws(
    () => kit.compileLayer({ ...plan, captions: { hide: [{ from: 0, to: 0.5 }, { from: 2, to: 1 }] } }, cfg),
    /captions\.hide\[1\]/,
  );
});

// Граничные случаи сверх плана: ролик без карточек и вставок (только камера) не должен падать,
// а `until`, заданный далеко за концом композиции, должен обрезаться до durationInFrames, а не
// бросать непонятную ошибку — это обычная ситуация, когда автор plan.js пишет «до конца ролика»
// с запасом.
test('compileLayer accepts a layer with no items or inserts', () => {
  const layer = kit.compileLayer({ ...plan, items: [], inserts: [] }, cfg);
  assert.deepEqual(layer.items, []);
  assert.deepEqual(layer.inserts, []);
  assert.deepEqual(layer.cues.kept, []);
  assert.deepEqual(layer.camera.aways, []);
});

test('an until far past the composition duration is clamped to it, not rejected', () => {
  const longItem = { id: 'tail', kind: 'text', at: 0.2, until: 1000, box: { x: 90, y: 300, w: 840, h: 200 } };
  const layer = kit.compileLayer({ ...plan, items: [longItem] }, cfg);
  assert.equal(layer.items[0].until, cfg.durationInFrames);
});

// Ревью: compileLayer не пробрасывал durationInFrames в compileInserts, поэтому вставка, начатая
// до конца ролика, но заканчивающаяся далеко после него, попадала в манифест необрезанной.
test('compileLayer clamps a tail insert to the composition end and rejects one starting after it', () => {
  const tail = kit.compileLayer({ ...plan, items: [], inserts: [{ kind: 'donor', from: 8, to: 12 }] }, cfg);
  assert.equal(tail.inserts[0].to, cfg.durationInFrames);
  assert.throws(
    () => kit.compileLayer({ ...plan, items: [], inserts: [{ kind: 'stock', from: 11, to: 13 }] }, cfg),
    /начинается после конца ролика/,
  );
});

// Ревью: at < 0 и at на/после конца ролика раньше давали либо отрицательный `from` без ошибки
// (тексты с отрицательным `from` в манифесте), либо невнятное «until должен быть больше at»,
// которое не называет настоящую причину (элемент стартует уже после конца композиции).
test('compileItems rejects a negative at and an at at or after the composition end', () => {
  const base = { id: 'a', kind: 'text', box: { x: 0, y: 0, w: 1, h: 1 } };
  assert.throws(
    () => kit.compileItems([{ ...base, at: -0.5, until: 1 }], cfg),
    /items a: at не может быть отрицательным/,
  );
  // cfg.durationInFrames = 250 = 10 с при 25 fps — at ровно на границе тоже поздно.
  assert.throws(
    () => kit.compileItems([{ ...base, at: 10, until: 11 }], cfg),
    /items a: начинается после конца ролика/,
  );
});

// Task 19 review: единая точка построения плана — Node-манифест (scripts/motion-kit-node.js) и
// будущий Root.jsx (задача 29) вызывают buildPlan через один и тот же compilePlan, чтобы у гейта
// и у рендера были одинаковые правила ошибок и один и тот же скомпилированный слой.
test('compilePlan calls buildPlan with ctx and compiles the result exactly like compileLayer', () => {
  const buildPlan = (ctx) => ({ camera: plan.camera, items: [], hook: ctx.words.length ? 'speaker' : 'enumeration' });
  const compiled = kit.compilePlan(buildPlan, cfg);
  assert.deepEqual(compiled, kit.compileLayer(buildPlan(cfg), cfg));
});

test('compilePlan rejects a non-function buildPlan with a Russian hint', () => {
  assert.throws(() => kit.compilePlan(undefined, cfg), /plan\.js должен экспортировать default function buildPlan/);
  assert.throws(() => kit.compilePlan(null, cfg), /plan\.js должен экспортировать default function buildPlan/);
});

test('compilePlan wraps a throwing buildPlan instead of leaking a raw stack', () => {
  const buildPlan = () => { throw new Error('boom'); };
  assert.throws(() => kit.compilePlan(buildPlan, cfg), /src\/plan\.js упал при построении плана — boom/);
});

test('compilePlan rejects a buildPlan that does not return a plan object', () => {
  assert.throws(() => kit.compilePlan(() => undefined, cfg), /buildPlan в src\/plan\.js должен вернуть объект плана/);
  assert.throws(() => kit.compilePlan(() => [1, 2], cfg), /buildPlan в src\/plan\.js должен вернуть объект плана/);
});

test('compilePlan lets kit validation errors (e.g. a missing camera.face) pass through unprefixed', () => {
  assert.throws(() => kit.compilePlan(() => ({ camera: { shots: [] }, items: [] }), cfg), /camera\.face/);
});

// Task 19, второе ревью: исходная ошибка buildPlan сохраняется в cause (по её стеку Node-манифест
// находит строку в src/plan.js), а async buildPlan отклоняется сразу — иначе Promise дошёл бы до
// compileLayer и дал бы непонятную ошибку про camera.face.
test('compilePlan keeps the original buildPlan error as cause', () => {
  const boom = new Error('boom');
  assert.throws(() => kit.compilePlan(() => { throw boom; }, cfg), (error) => {
    assert.match(error.message, /src\/plan\.js упал при построении плана — boom/);
    assert.equal(error.cause, boom);
    return true;
  });
});

// Ревью Task 20: waivers в plan.js — решение автора ролика, не гейта. Если он опечатался (не тот
// gate, пустая причина, забыл обернуть в массив), это должно упасть уже на layer check понятной
// русской строкой, а не тихо остаться неприменённым (и тем более не уронить applyWaivers
// TypeError'ом где-то дальше в отчёте — там форма входа доверия не заслуживает и просто игнорится).
test('compileLayer rejects a malformed waivers entry with the gate list and its index', () => {
  const bad = (waivers) => () => kit.compileLayer({ ...plan, waivers }, cfg);
  assert.throws(bad({ G1: 'x' }), /waivers должен быть массивом/);
  assert.throws(bad([null]), /waivers\[0\]: исключение возможно только для G1, G4, G11 и только с причиной/);
  assert.throws(bad([{ gate: 'G1', reason: 123 }]), /waivers\[0\]/);
  assert.throws(bad([{ gate: 'G5', reason: 'причина' }]), /waivers\[0\]/);
  // Регистр важен: G1 — да, g1 — нет, это не тот же гейт.
  assert.throws(bad([{ gate: 'g1', reason: 'причина' }]), /waivers\[0\]/);
  assert.throws(bad([{ gate: 'G1', reason: '   ' }]), /waivers\[0\]/);
  // Второй, невалидный элемент называется по своему индексу, а не по первому.
  assert.throws(bad([{ gate: 'G1', reason: 'ok' }, { gate: 'G5', reason: 'x' }]), /waivers\[1\]/);
});

test('compileLayer keeps the same waivable gate list as scripts/qa/profiles.js WAIVABLE', () => {
  const { WAIVABLE } = require('../scripts/qa/profiles');
  assert.deepEqual(kit.WAIVABLE_GATES, [...WAIVABLE]);
});

// Ревью Task 20 (Step 0 задачи 21): один и тот же список гейтов не должен незаметно расшириться —
// ни plan.js, ни applyWaivers не имеют причины его менять.
test('WAIVABLE_GATES is frozen, so nothing can silently widen the waivable gate list', () => {
  assert.ok(Object.isFrozen(kit.WAIVABLE_GATES));
});

// plan.js без исключений часто пишет `waivers: null`, а не опускает поле вовсе (JSON.stringify
// плана, дефолт схемы) — compileWaivers должен принимать null точно так же, как undefined, а не
// падать на Array.isArray(null) === false с невнятным «waivers должен быть массивом».
test('compileLayer treats waivers: null the same as an omitted field, not as a malformed entry', () => {
  const layer = kit.compileLayer({ ...plan, waivers: null }, cfg);
  assert.deepEqual(layer.waivers, []);
});

test('compilePlan rejects an async buildPlan without leaving an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.throws(() => kit.compilePlan(async () => ({ camera: plan.camera, items: [] }), cfg),
      /buildPlan в src\/plan\.js должен быть синхронным/);
    assert.throws(() => kit.compilePlan(async () => { throw new Error('late'); }, cfg),
      /buildPlan в src\/plan\.js должен быть синхронным/);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});
