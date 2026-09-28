const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const React = require('react');
const { buildLayerManifest } = require('../scripts/motion-kit-node');
const { getProfile } = require('../scripts/qa/profiles');
const { safeRect } = require('../scripts/qa/safe-rect');
const { runTimelineGates } = require('../scripts/qa/timeline-gates');
const { ROOT, loadEsm } = require('./helpers/load-esm');
const { remotionStub, render } = require('./helpers/remotion-stub');

const dir = path.join(__dirname, '..', 'templates', 'motion-layer');
const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
const TEMPLATE_FILES = ['src/index.jsx', 'src/Root.jsx', 'src/plan.js', 'src/scenes.jsx', 'README.md'];

test('template imports only the kit, never another reel or an absolute path', () => {
  for (const file of TEMPLATE_FILES) {
    const text = read(file);
    assert.doesNotMatch(text, /\/Users\/|\/home\/|projects\/20\d\d/);
  }
  assert.match(read('src/plan.js'), /from '@automontage\/motion-kit\/core'/);
  assert.doesNotMatch(read('src/plan.js'), /from '@automontage\/motion-kit'[;\n]/);
  const root = read('src/Root.jsx');
  for (const part of ['SpeakerLayer', 'StockInsert', 'FullscreenReveal', 'KitBox', 'ShutterFlash', 'Subtitles', 'SfxTrack', 'FontLoader']) {
    assert.match(root, new RegExp(`<${part}`));
  }
  // FontLoader — гейт: оборачивает весь слой, а не стоит рядом пустым элементом.
  assert.match(root, /<FontLoader faces=\{FONTS\}>[\s\S]*<SpeakerLayer[\s\S]*<Subtitles[\s\S]*<\/FontLoader>/);
  assert.doesNotMatch(root, /<FontLoader[^>]*\/>/);
  // Одна точка сборки с Node-манифестом layer check (Task 19).
  assert.match(root, /compilePlan\(buildPlan/);
  assert.doesNotMatch(root, /compileLayer/);
  // Кегль и скругление заголовка масштабируются вместе с box.
  assert.doesNotMatch(read('src/scenes.jsx'), /fontSize: 64|borderRadius: 28/);
  assert.match(read('src/scenes.jsx'), /BrowserFrame/);
  assert.match(read('src/scenes.jsx'), /scroll=\{/);
  assert.doesNotMatch(read('src/scenes.jsx') + read('src/plan.js'), /maxScroll/);
  assert.match(read('src/plan.js'), /kind: 'stock'/);
});

// --- Смоук: шаблон, скопированный в папку слоя, собирается гейтом и рендерится ---

// Маленькая библиотека звуков: имена как в настоящей библиотеке, роль — отдельным полем (вспышка
// обязана искать затвор по роли, а не по имени). Файлы для SSR не нужны.
const SFX_LIBRARY = {
  sounds: {
    'pop-soft': { file: 'sfx/pop-soft.wav', lengthSec: 0.15, peakSec: 0.01, role: 'pop', notable: false, volume: 0.55, sha256: 'a'.repeat(64) },
    'whoosh-air': { file: 'sfx/whoosh-air.wav', lengthSec: 0.6, peakSec: 0.3, role: 'whoosh', notable: true, volume: 0.7, sha256: 'b'.repeat(64) },
    'shutter-click': { file: 'sfx/shutter-click.wav', lengthSec: 0.2, peakSec: 0.02, role: 'shutter', notable: true, volume: 0.6, sha256: 'c'.repeat(64) },
  },
};

// Слово каждые 0,5 с, как в транскрипте фикстуры layer-project (Task 31).
function fixtureWords(seconds) {
  return Array.from({ length: seconds * 2 - 1 }, (_, i) => {
    const w = i === 0 ? 'Привет,' : `слово${i}`;
    return { w, t: w, s: i * 0.5, e: i * 0.5 + 0.4 };
  });
}

// То, что сделает `layer new` (Task 31): копия шаблона + layer.json, src/words.js, src/sfx-library.js.
function makeLayer(t, { width = 1080, height = 1920, fps = 25, seconds = 8 } = {}) {
  const layerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-template-'));
  t.after(() => fs.rmSync(layerDir, { recursive: true, force: true }));
  for (const file of TEMPLATE_FILES) {
    fs.mkdirSync(path.dirname(path.join(layerDir, file)), { recursive: true });
    fs.copyFileSync(path.join(dir, file), path.join(layerDir, file));
  }
  const durationInFrames = seconds * fps;
  const layer = {
    version: 1, composition: 'Layer', fps, width, height, durationInFrames,
    face: { x: Math.round(width * 0.5), y: Math.round(height * 0.41) },
    profile: 'avatar', sfxMasterDb: -5, speaker: { src: 'speaker.mp4', lastFrame: durationInFrames - 1 },
  };
  fs.writeFileSync(path.join(layerDir, 'layer.json'), JSON.stringify(layer));
  fs.writeFileSync(path.join(layerDir, 'src', 'words.js'), `export default ${JSON.stringify(fixtureWords(seconds))};\n`);
  fs.writeFileSync(path.join(layerDir, 'src', 'sfx-library.js'), `export default ${JSON.stringify(SFX_LIBRARY)};\n`);
  return { layerDir, layer };
}

// Файл слоя через тот же esbuild-загрузчик, что тесты kit; React — из движка (слой лежит во временной
// папке без своих node_modules), remotion — подмена на заданном кадре.
function loadLayerFile(layerDir, file, remotion) {
  return loadEsm(path.relative(ROOT, path.join(layerDir, file)), {
    stubs: { remotion, react: React, 'react/jsx-runtime': require('react/jsx-runtime') },
  });
}

// Правка скопированного plan.js так, как её сделал бы агент ролика; без совпадения тест падает сразу.
function patchPlan(layerDir, search, replacement) {
  const file = path.join(layerDir, 'src', 'plan.js');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(search), `в plan.js нет «${search}»`);
  fs.writeFileSync(file, text.replace(search, replacement));
}

function renderRoot(layerDir, layer, frame) {
  const { fps, width, height, durationInFrames } = layer;
  const { LayerComposition } = loadLayerFile(layerDir, 'src/Root.jsx', remotionStub({ frame, fps, width, height, durationInFrames }));
  return render(React.createElement(LayerComposition));
}

const statuses = (gates) => Object.fromEntries(gates.map((g) => [g.id, g.status]));
const textAt = (manifest, id, frame) => {
  const text = manifest.texts.find((item) => item.id === id);
  return text && text.frames[frame - text.from];
};

test('the copied template builds a manifest through buildLayerManifest with camera, captions and effects', (t) => {
  const { layerDir, layer } = makeLayer(t);
  const manifest = buildLayerManifest(layerDir);
  for (const key of ['s', 'requested', 'base', 'dx', 'dy', 'blur', 'opacity']) {
    assert.equal(manifest.camera[key].length, layer.durationInFrames, key);
  }
  assert.ok(manifest.texts.some((text) => text.id.startsWith('caption-')), 'субтитры есть');
  assert.ok(manifest.texts.some((text) => text.id === 'title'));
  assert.ok(manifest.texts.some((text) => text.id === 'screenshot'));
  assert.deepEqual(manifest.inserts.map((i) => [i.id, i.kind, i.cover, i.src]), [['stock-1', 'stock', true, 'stock/placeholder.mp4']]);
  assert.deepEqual(manifest.cues.kept.map((cue) => cue.name).sort(), ['pop-soft', 'shutter-click', 'whoosh-air']);
  assert.deepEqual(manifest.cues.dropped, []);
  // Субтитры уходят на время стока, и их окно hide совпадает с кадрами вставки.
  const stock = manifest.inserts[0];
  for (const text of manifest.texts.filter((item) => item.static)) {
    assert.ok(text.until <= stock.from || text.from >= stock.to, `${text.id} не под стоком`);
  }
  // Карточка уходит до начала стока: вставка рисуется под элементами.
  const card = manifest.texts.find((text) => text.id === 'screenshot');
  assert.ok(card.from + card.frames.length <= stock.from);
});

test('the neutral template on a neutral fixture fails no timeline gate', (t) => {
  const { layerDir } = makeLayer(t);
  const gates = runTimelineGates(buildLayerManifest(layerDir), getProfile('avatar'));
  assert.deepEqual(gates.map((g) => g.id), ['G1', 'G2', 'G3', 'G4', 'G5', 'G9', 'G10', 'G11']);
  const failed = gates.filter((g) => g.status === 'fail');
  assert.deepEqual(failed.map((g) => `${g.id}: ${g.hint}`), []);
  // Стоп-гейты ритма, масштаба, хука и safe-zone проходят чисто; G10 честно просит второй сток.
  const byId = statuses(gates);
  for (const id of ['G1', 'G3', 'G4', 'G5', 'G9', 'G11']) assert.equal(byId[id], 'pass', id);
  assert.equal(byId.G10, 'warn');
});

test('manifests at 540×960, 1080×1920 and 1920×1080 scale the geometry with k and keep every box inside the safe zone', (t) => {
  const manifests = {};
  for (const [width, height] of [[540, 960], [1080, 1920], [1920, 1080]]) {
    const { layerDir } = makeLayer(t, { width, height });
    const manifest = buildLayerManifest(layerDir);
    manifests[`${width}x${height}`] = manifest;
    const gates = runTimelineGates(manifest, getProfile('avatar'));
    const byId = statuses(gates);
    assert.equal(byId.G5, 'pass', `${width}×${height}: ${gates.find((g) => g.id === 'G5').spans.map((s) => s.note).join('; ')}`);
    assert.deepEqual(gates.filter((g) => g.status === 'fail').map((g) => g.id), [], `${width}×${height}`);
  }
  // Карточки в середине жизни: половинный кадр — половинный box (сдвиги жизни kit заданы в px и в
  // сравнении не участвуют, поэтому сверяем левый и правый край и ширину).
  const frame = 30;
  for (const id of ['title', 'screenshot']) {
    const at = id === 'title' ? frame : 90;
    const full = textAt(manifests['1080x1920'], id, at);
    const half = textAt(manifests['540x960'], id, at);
    assert.ok(Math.abs(half[0] - full[0] / 2) <= 1 && Math.abs(half[2] - full[2] / 2) <= 1, `${id}: ${half} vs ${full}`);
  }
  // 1920×1080: короткая сторона та же 1080 — box того же размера, по центру своей safe-зоны.
  const wide = manifests['1920x1080'];
  const safe = safeRect(1920, 1080);
  for (const [id, at] of [['title', frame], ['screenshot', 90]]) {
    const full = textAt(manifests['1080x1920'], id, at);
    const box = textAt(wide, id, at);
    assert.ok(Math.abs((box[2] - box[0]) - (full[2] - full[0])) <= 1, `${id}: ширина ${box[2] - box[0]}`);
    assert.ok(Math.abs((box[0] + box[2]) / 2 - (safe.left + safe.right) / 2) <= 1, `${id}: центр ${box}`);
  }
});

test('index.jsx registers one composition with the geometry and length from layer.json', (t) => {
  const { layerDir, layer } = makeLayer(t);
  let registered = null;
  const stub = {
    ...remotionStub({ fps: layer.fps, width: layer.width, height: layer.height, durationInFrames: layer.durationInFrames }),
    registerRoot: (component) => { registered = component; },
    Composition: ({ id, durationInFrames, fps, width, height, component }) => React.createElement('div', {
      'data-composition': id, 'data-duration': durationInFrames, 'data-fps': fps, 'data-size': `${width}x${height}`,
      'data-component': component && component.name,
    }),
  };
  loadLayerFile(layerDir, 'src/index.jsx', stub);
  assert.equal(typeof registered, 'function');
  const html = render(React.createElement(registered));
  assert.match(html, /data-composition="Layer"/);
  assert.match(html, /data-duration="200"/);
  assert.match(html, /data-fps="25"/);
  assert.match(html, /data-size="1080x1920"/);
  assert.match(html, /data-component="LayerComposition"/);
});

test('Root renders speaker, title, screenshot card, shutter flash, stock insert, subtitles and effects at their frames', (t) => {
  const { layerDir, layer } = makeLayer(t);
  const manifest = buildLayerManifest(layerDir);
  const stock = manifest.inserts[0];
  const card = manifest.texts.find((text) => text.id === 'screenshot');
  const shutter = manifest.cues.kept.find((cue) => cue.name === 'shutter-click');
  const audios = (html) => (html.match(/<audio /g) || []).length;

  const start = renderRoot(layerDir, layer, 0);
  assert.match(start, /<video src="\/static\/speaker\.mp4"/);
  assert.match(start, /data-kit-text="captions"/);
  assert.match(start, /Привет,/);
  // Субтитры — шрифтом слоя, а не sans-serif по умолчанию.
  assert.match(start, /data-kit-text="captions"[^>]*><span style="font-family:KitOnest/);
  assert.equal(audios(start), 3, 'звуковая дорожка — все оставшиеся звуки');
  assert.doesNotMatch(start, /data-kit-text="title"/);

  const title = renderRoot(layerDir, layer, 30);
  assert.match(title, /data-kit-text="title"/);
  assert.match(title, /ПРИВЕТ, СЛОВО1 СЛОВО2/);
  assert.match(title, /font-size:64px/);
  assert.match(title, /border-radius:28px/);
  // Отступ внутри box, а не сверх него: иначе фон карточки шире того, что видит G5.
  assert.match(title, /box-sizing:border-box/);

  const middle = card.from + Math.floor(card.frames.length / 2);
  const shot = renderRoot(layerDir, layer, middle);
  assert.match(shot, /data-kit-text="screenshot"/);
  assert.match(shot, /<img src="\/static\/shots\/placeholder\.png"/);
  assert.match(shot, /example\.com/);
  // Скриншот прокручивается после входа карточки: до окна прокрутки — верх страницы, в середине — ниже.
  const scrolled = (html) => Number(/object-position:50% ([\d.]+)%/.exec(html)[1]);
  assert.equal(scrolled(renderRoot(layerDir, layer, card.from + 2)), 0);
  assert.ok(scrolled(shot) > 10 && scrolled(shot) < 90, `прокрутка в середине карточки ${scrolled(shot)} %`);

  // Вспышка — на ударе оставшегося звука затвора, после входа карточки (mask — 8 эталонных кадров).
  assert.ok(shutter.hitFrame >= card.from + 8, `затвор ${shutter.hitFrame}, карточка с ${card.from}`);
  const flash = renderRoot(layerDir, layer, shutter.hitFrame);
  assert.match(flash, /background:#ffffff;opacity:0\.6/);
  assert.doesNotMatch(renderRoot(layerDir, layer, shutter.hitFrame - 1), /background:#ffffff;opacity/);

  const inside = Math.floor((stock.from + stock.to) / 2);
  const insert = renderRoot(layerDir, layer, inside);
  assert.match(insert, /data-kit-bleed="stock-1"/);
  assert.match(insert, /<video src="\/static\/stock\/placeholder\.mp4"/);
  assert.doesNotMatch(insert, /\/static\/speaker\.mp4/, 'спикер ушёл под вставку');
  assert.doesNotMatch(insert, /data-kit-text="captions"/, 'субтитры спрятаны на время стока');

  const end = renderRoot(layerDir, layer, layer.durationInFrames - 5);
  assert.match(end, /<video src="\/static\/speaker\.mp4"/);
  assert.doesNotMatch(end, /data-kit-bleed/);
  assert.equal(audios(end), 3);
});

test('on a 540×960 layer the title card scales its font, radius and padding with the same k as its box', (t) => {
  const { layerDir, layer } = makeLayer(t, { width: 540, height: 960 });
  const html = renderRoot(layerDir, layer, 30);
  assert.match(html, /data-kit-text="title"/);
  assert.match(html, /font-size:32px/);
  assert.match(html, /border-radius:14px/);
  assert.match(html, /padding:0 16px/);
  assert.doesNotMatch(html, /font-size:64px|border-radius:28px/);
});

test('InsertContent draws a cover screen as a browser window inside the safe zone and leaves a non-cover overlay to the reel', () => {
  const stub = remotionStub({ frame: 20, fps: 25, width: 1080, height: 1920 });
  const { InsertContent } = loadEsm('templates/motion-layer/src/scenes.jsx', {
    stubs: { remotion: stub, react: React, 'react/jsx-runtime': require('react/jsx-runtime') },
  });
  const insert = (fields) => ({ id: 'x', from: 10, to: 60, src: null, cover: true, kb: [1.03, 1.1], sfx: null, ...fields });
  const screen = render(React.createElement(InsertContent, { insert: insert({ kind: 'screen', src: 'shots/page.png' }) }));
  assert.match(screen, /top:250px;right:130px;bottom:420px;left:70px/);
  assert.match(screen, /<img src="\/static\/shots\/page\.png"/);
  const scene = render(React.createElement(InsertContent, { insert: insert({ kind: 'scene' }) }));
  assert.match(scene, /background-color:#0c1018/);
  // Донор без cover — оверлей поверх спикера: заливка на весь кадр закрыла бы спикера на весь ролик.
  assert.equal(render(React.createElement(InsertContent, { insert: insert({ kind: 'donor', cover: false, src: 'donor/clip.mp4' }) })), '');
});

test('title card at 1920×1080 keeps the 1080 reference size: k is the short side, not the width', (t) => {
  const { layerDir, layer } = makeLayer(t, { width: 1920, height: 1080 });
  const html = renderRoot(layerDir, layer, 30);
  assert.match(html, /data-kit-text="title"/);
  assert.match(html, /font-size:64px/);
  assert.match(html, /border-radius:28px/);
});

test('short sources keep the hook: a 4 s layer starts its stock at 3 s, a 3 s layer has no stock, no gate fails', (t) => {
  for (const [seconds, expected] of [[4, [['stock-1', 75, 100]]], [3, []]]) {
    const { layerDir } = makeLayer(t, { seconds });
    const manifest = buildLayerManifest(layerDir);
    assert.deepEqual(manifest.inserts.map((i) => [i.id, i.from, i.to]), expected, `${seconds} с`);
    const gates = runTimelineGates(manifest, getProfile('avatar'));
    assert.deepEqual(gates.filter((g) => g.status === 'fail').map((g) => g.id), [], `${seconds} с`);
    assert.equal(statuses(gates).G4, 'pass', `${seconds} с: спикер в кадре весь хук`);
  }
});

test('a screen insert an agent adds to plan.js hides captions and is drawn through FullscreenReveal only inside its window', (t) => {
  const { layerDir, layer } = makeLayer(t);
  patchPlan(layerDir, 'const inserts = [];',
    "const inserts = [{ id: 'screen-1', kind: 'screen', from: 1, to: 2, src: 'shots/screen.png' }];");
  const manifest = buildLayerManifest(layerDir);
  const screen = manifest.inserts.find((i) => i.id === 'screen-1');
  assert.deepEqual([screen.from, screen.to, screen.cover], [25, 50, true]);
  // hide собран из вставок: ни один кадр субтитров не попадает под новый экран.
  for (const text of manifest.texts.filter((item) => item.static)) {
    assert.ok(text.until <= screen.from || text.from >= screen.to, `${text.id} [${text.from}, ${text.until}) под экраном`);
  }
  for (const frame of [screen.from - 5, screen.to, screen.to + 5]) {
    const html = renderRoot(layerDir, layer, frame);
    assert.doesNotMatch(html, /data-kit-bleed="screen-1"|shots\/screen\.png/, `кадр ${frame} вне окна вставки`);
  }
  const inside = renderRoot(layerDir, layer, screen.from + 15);
  assert.match(inside, /data-kit-bleed="screen-1"/);
  assert.match(inside, /<img src="\/static\/shots\/screen\.png"/);
  assert.doesNotMatch(inside, /data-kit-text="captions"/);
});

test('BAD CASE: a stock insert with cover: false cannot slip past G4 — the layer does not compile', (t) => {
  const { layerDir } = makeLayer(t);
  patchPlan(layerDir, "kind: 'stock',", "kind: 'stock', cover: false,");
  assert.throws(() => buildLayerManifest(layerDir), /вставка stock всегда закрывает спикера: cover: false допустим только для donor/);
});

test('Root draws each insert by its contract and refuses a kind/cover combination outside it', (t) => {
  const { layerDir, layer } = makeLayer(t);
  const stub = remotionStub({ frame: 20, fps: layer.fps, width: layer.width, height: layer.height, durationInFrames: layer.durationInFrames });
  const { Insert } = loadLayerFile(layerDir, 'src/Root.jsx', stub);
  const insert = (fields) => ({ id: 'x', from: 10, to: 60, src: 'clip.mp4', cover: true, kb: [1.03, 1.1], sfx: null, ...fields });
  const draw = (fields) => render(React.createElement(Insert, { insert: insert(fields) }));
  assert.match(draw({ kind: 'stock' }), /data-kit-bleed="x"[\s\S]*<video src="\/static\/clip\.mp4"/);
  assert.match(draw({ kind: 'screen' }), /data-kit-bleed="x"/);
  assert.match(draw({ kind: 'scene' }), /data-kit-bleed="x"/);
  assert.match(draw({ kind: 'donor' }), /data-kit-bleed="x"/);
  assert.equal(draw({ kind: 'donor', cover: false }), '');
  for (const fields of [{ kind: 'stock', cover: false }, { kind: 'screen', cover: false }, { kind: 'meme' }]) {
    assert.throws(() => draw(fields), /Root\.jsx: вставка x/, JSON.stringify(fields));
  }
});

test('scenes.jsx names an unknown view and plays a full-screen donor muted from its own start', () => {
  const stub = remotionStub({ frame: 20, fps: 25, width: 1080, height: 1920 });
  const { InsertContent, SceneContent } = loadEsm('templates/motion-layer/src/scenes.jsx', {
    stubs: { remotion: stub, react: React, 'react/jsx-runtime': require('react/jsx-runtime') },
  });
  const item = { id: 'chart-1', kind: 'card', from: 0, until: 50, props: { view: 'chart' } };
  assert.throws(() => render(React.createElement(SceneContent, { item })), /неизвестный view «chart» у элемента chart-1/);
  const donor = { id: 'donor-1', kind: 'donor', from: 10, to: 60, src: 'donor/clip.mp4', cover: true, kb: [1.03, 1.1], sfx: null };
  const html = render(React.createElement(InsertContent, { insert: donor }));
  assert.match(html, /data-sequence-from="10" data-sequence-duration="50"/);
  assert.match(html, /<video src="\/static\/donor\/clip\.mp4" muted=""/);
});
