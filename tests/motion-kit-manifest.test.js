const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');
const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 100,
  words: [{ w: 'Привет', t: 'Привет', s: 0.2, e: 0.6 }], sfxLibrary: { sounds: {} } };
const plan = {
  camera: { face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'M' }] },
  items: [
    { id: 'title', kind: 'text', at: 0.2, until: 2, box: { x: 90, y: 300, w: 840, h: 200 } },
    { id: 'photo', kind: 'media', at: 1, until: 3, box: { x: 0, y: 0, w: 1080, h: 1920 } },
  ],
};

test('manifest carries per-frame camera, per-frame text extents and static caption boxes', () => {
  const m = kit.buildManifest(kit.compileLayer(plan, cfg));
  assert.equal(m.version, 1);
  assert.equal(m.camera.s.length, 100);
  assert.equal(m.maxScale, 1.25);
  const title = m.texts.find((t) => t.id === 'title');
  assert.equal(title.from, 5);
  assert.equal(title.frames.length, 45);
  assert.equal(m.texts.some((t) => t.id === 'photo'), false);
  const caption = m.texts.find((t) => t.id === 'caption-1');
  assert.deepEqual(caption.static, [70, 1398, 950, 1482]);
  assert.equal(JSON.parse(JSON.stringify(m)).texts.length, m.texts.length);
});

// Граничный случай сверх плана: ролик без карточек и без субтитров (только камера) — типичный
// голый хук — не должен падать и обязан отдать пустой texts, а не бросить исключение на
// отсутствующем compiled.captions.
test('a layer with no items and captions off still builds a manifest with empty texts', () => {
  const m = kit.buildManifest(kit.compileLayer({ ...plan, items: [], captions: false }, cfg));
  assert.deepEqual(m.texts, []);
  assert.equal(m.camera.s.length, cfg.durationInFrames);
});
