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
  // base — ревью пакета 2 задачи 22: масштаб пресета с дрейфом ДО панча и ДО клэмпа maxScale,
  // читает G3, чтобы отличить пресет крупнее предела от панча, упёршегося в потолок.
  assert.equal(m.camera.base.length, 100);
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

// Task 18: captions.hide режет один chunk на несколько независимых видимых окон. buildManifest
// обязан отдать столько же caption-* записей, сколько отдаёт captionSpans, с детерминированной,
// уникальной схемой id (caption-<n>, caption-<n>b, caption-<n>c…) — иначе гейт G5 (safe-zone по
// текстам) увидит меньше окон, чем реально рисует Subtitles.
test('captions.hide splits a single chunk into caption-N/caption-Nb, and a hide window covering it fully drops it', () => {
  const words = [
    { w: 'Раз', t: 'Раз', s: 0.1, e: 0.3 },
    { w: 'два', t: 'два', s: 0.4, e: 0.6 },
  ]; // пауза 0.1с < hardGap(0.3с) — buildChunks склеит их в один chunk.
  const splitPlan = { ...plan, items: [], captions: { hide: [{ from: 0.3, to: 0.4 }] } };
  const split = kit.buildManifest(kit.compileLayer(splitPlan, { ...cfg, words }));
  const captionIds = split.texts.filter((t) => t.id.startsWith('caption-')).map((t) => t.id);
  assert.deepEqual(captionIds, ['caption-1', 'caption-1b']);
  const [first, second] = split.texts.filter((t) => t.id.startsWith('caption-'));
  assert.ok(first.until <= second.from, 'вырезанное окно hide не должно попасть ни в один span');

  const droppedPlan = { ...plan, items: [], captions: { hide: [{ from: 0, to: 2 }] } };
  const dropped = kit.buildManifest(kit.compileLayer(droppedPlan, { ...cfg, words }));
  assert.equal(dropped.texts.filter((t) => t.id.startsWith('caption-')).length, 0, 'окно hide, целиком накрывающее chunk, не должно оставить ни одной записи');
});

// Задача 22: манифест несёт cover (закрывает ли вставка лицо, читает G4) и src (короткий сток,
// читает предупреждение Task 38) у каждой вставки.
test('manifest inserts carry cover and src for the gates', () => {
  const m = kit.buildManifest(kit.compileLayer({ ...plan, inserts: [
    { kind: 'stock', from: 1, to: 2, src: 'stock/a.mp4' }, { kind: 'donor', from: 2.5, to: 3, src: 'donor.mp4' },
  ] }, cfg));
  assert.deepEqual(m.inserts, [
    { id: 'stock-1', kind: 'stock', from: 25, to: 50, cover: true, src: 'stock/a.mp4' },
    { id: 'donor-2', kind: 'donor', from: 63, to: 75, cover: false, src: 'donor.mp4' },
  ]);
});

// Ревью пакета 2: вставка без src (например screen/scene без файла) отдаёт src: null, а не
// undefined — иначе JSON.stringify молча теряет ключ и сравнение манифеста с сохранённым не
// заметит пропажи поля.
test('an insert without src comes out as src: null, not undefined', () => {
  const m = kit.buildManifest(kit.compileLayer({ ...plan, inserts: [{ kind: 'scene', from: 1, to: 2 }] }, cfg));
  assert.equal(m.inserts[0].src, null);
  assert.ok('src' in JSON.parse(JSON.stringify(m)).inserts[0], 'src обязан остаться в JSON как null, а не пропасть');
});
