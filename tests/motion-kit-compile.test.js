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
