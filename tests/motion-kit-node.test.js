const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildLayerManifest, loadKitCore } = require('../scripts/motion-kit-node');

const GOOD_PLAN = `import { autoShots } from '@automontage/motion-kit/core';
export default function buildPlan({ words, face, durationInFrames, fps }) {
  return { camera: { face, shots: autoShots(words, { endSec: durationInFrames / fps }) }, items: [] };
}\n`;

function writeLayer(dir, plan, overrides = {}) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'layer.json'), overrides.layerJson ?? JSON.stringify({ version: 1, composition: 'Layer', fps: 25, width: 1080,
    height: 1920, durationInFrames: 250, face: { x: 540, y: 787 }, profile: 'avatar', sfxMasterDb: -5, speaker: { src: 'speaker.mp4', lastFrame: 249 } }));
  fs.writeFileSync(path.join(dir, 'src/words.js'), overrides.words ?? 'export default [{"w":"Привет","t":"Привет","s":0.2,"e":0.6}];\n');
  fs.writeFileSync(path.join(dir, 'src/sfx-library.js'), overrides.sfxLibrary ?? 'export default {"sounds":{}};\n');
  fs.writeFileSync(path.join(dir, 'src/plan.js'), plan);
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kit-layer-'));

test('kit core resolves the real remotion package when loaded standalone in Node', () => {
  const kit = loadKitCore();
  assert.equal(typeof kit.compileLayer, 'function');
  assert.equal(kit.secToFrame(2, 25), 50);
  // secToFrame — чистая арифметика; compileCamera/cameraAt внутри используют Easing/interpolate/
  // spring из настоящего пакета 'remotion' — если бы esbuild не смог отдать его извне бандла,
  // здесь бросило бы Cannot find module 'remotion', а не в тестах на манифест.
  const camera = kit.compileCamera({ face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }] },
    { fps: 25, width: 1080, height: 1920, durationInFrames: 50 });
  const frame0 = kit.cameraAt(camera, 0);
  assert.equal(typeof frame0.s, 'number');
});

test('a layer outside the engine folder compiles to a manifest from its plan', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  const manifest = await buildLayerManifest(dir);
  assert.equal(manifest.camera.s.length, 250);
  assert.equal(manifest.texts[0].id, 'caption-1');
});

// Task 19 review item 5: один и тот же compilePlan/buildManifest используется и Node-манифестом,
// и (в задаче 29) Root.jsx слоя — здесь проверяем, что buildLayerManifest не изобретает свой путь
// компиляции, а даёт ровно то, что дал бы прямой вызов loadKitCore().compilePlan/buildManifest.
test('the manifest matches buildManifest(compilePlan(...)) computed directly from the loaded kit core', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  const manifest = await buildLayerManifest(dir);
  const kit = loadKitCore();
  const layer = JSON.parse(fs.readFileSync(path.join(dir, 'layer.json'), 'utf8'));
  const words = [{ w: 'Привет', t: 'Привет', s: 0.2, e: 0.6 }];
  const sfxLibrary = { sounds: {} };
  const ctx = { ...layer, words, sfxLibrary };
  const buildPlan = (c) => ({ camera: { face: c.face, shots: kit.autoShots(c.words, { endSec: c.durationInFrames / c.fps }) }, items: [] });
  const expected = kit.buildManifest(kit.compilePlan(buildPlan, ctx));
  assert.deepEqual(manifest, expected);
});

test('a completely empty layer folder names layer.json and hints at layer new', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(buildLayerManifest(dir), /нет layer\.json \(слой создаётся командой automontage layer new\)/);
});

test('a missing src/words.js hints at automontage layer words specifically', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  fs.rmSync(path.join(dir, 'src/words.js'));
  await assert.rejects(buildLayerManifest(dir), /нет src\/words\.js \(создаётся командой automontage layer words\)/);
});

test('a missing src/sfx-library.js is named on its own', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  fs.rmSync(path.join(dir, 'src/sfx-library.js'));
  await assert.rejects(buildLayerManifest(dir), /нет src\/sfx-library\.js/);
});

test('a missing src/plan.js is named on its own', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  fs.rmSync(path.join(dir, 'src/plan.js'));
  await assert.rejects(buildLayerManifest(dir), /нет src\/plan\.js/);
});

test('a broken layer.json blames layer.json with a file:line:column location', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN, { layerJson: '{ "fps": 25, ' });
  await assert.rejects(buildLayerManifest(dir), /не собирается layer\.json — layer\.json:\d+:\d+:/);
});

test('a plan.js syntax error keeps "не собирается plan.js" and reports a line number', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, 'export default function buildPlan( {\n');
  await assert.rejects(buildLayerManifest(dir), /не собирается plan\.js — src\/plan\.js:\d+:\d+:/);
});

test('a broken src/words.js blames words.js, not plan.js', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN, { words: 'export default [ {"w":"a"' });
  await assert.rejects(buildLayerManifest(dir), /не собирается words\.js — src\/words\.js:\d+:\d+:/);
});

test('a throwing buildPlan is wrapped with the layer name instead of a raw stack', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, "export default function buildPlan(){ throw new Error('boom'); }\n");
  const name = path.basename(dir);
  await assert.rejects(buildLayerManifest(dir), new RegExp(`слой ${name}: src/plan\\.js упал при построении плана — boom`));
});

test('a buildPlan that returns undefined gets a clear hint instead of a TypeError deep inside buildManifest', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, 'export default function buildPlan(){ }\n');
  await assert.rejects(buildLayerManifest(dir), /слой .+: buildPlan в src\/plan\.js должен вернуть объект плана/);
});

test('a plan.js with no default export gets the Russian hint instead of a raw esbuild export error', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, 'export function buildPlan(){ return {}; }\n');
  await assert.rejects(buildLayerManifest(dir), /слой .+: plan\.js должен экспортировать default function buildPlan/);
});

test('broken layers explain what is missing or failing', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(buildLayerManifest(dir), /нет layer\.json/);
  writeLayer(dir, 'export default function buildPlan() { return { camera: { shots: [] }, items: [] }; }\n');
  await assert.rejects(buildLayerManifest(dir), /camera\.face/);
  writeLayer(dir, 'export default function buildPlan( {\n');
  await assert.rejects(buildLayerManifest(dir), /не собирается plan\.js/);
});

// Task 19 review item 2: ошибки валидации самого kit (compileCamera/compileItems/...) идут через
// compilePlan без изменений — buildLayerManifest должен лишь добавить «слой X:» спереди, а не
// проглотить или переформулировать текст, иначе следующая задача (layer check CLI) не сможет
// отличить нарушение контракта от прочих ошибок.
test('kit validation errors keep their text and gain the "слой X:" prefix', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, 'export default function buildPlan() { return { camera: { shots: [] }, items: [] }; }\n');
  const name = path.basename(dir);
  await assert.rejects(buildLayerManifest(dir), new RegExp(`слой ${name}: camera\\.face`));
});

// Task 19 review item 4: plan.js — чистые данные для гейта. Если ему разрешить React, remotion,
// сами внутренности kit или системные модули Node, манифест перестаёт быть надёжным описанием
// того, что реально попадёт в рендер (например, доступ к файловой системе или process.env внутри
// buildPlan даёт разный манифест на разных машинах).
test('plan.js cannot import the full @automontage/motion-kit (React components)', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, "import { KitBox } from '@automontage/motion-kit';\n"
    + "export default function buildPlan({face}){ return { camera: { face, shots: [{at:0,preset:'W'}] }, items: [] }; }\n");
  await assert.rejects(buildLayerManifest(dir), /React-компонент/);
});

test('plan.js cannot import react directly', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, "import React from 'react';\n" + GOOD_PLAN);
  await assert.rejects(buildLayerManifest(dir), /React/);
});

test('plan.js cannot import remotion directly', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, "import { useCurrentFrame } from 'remotion';\n" + GOOD_PLAN);
  await assert.rejects(buildLayerManifest(dir), /remotion/);
});

test('plan.js cannot import Node built-ins (bare or node: specifier)', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, "import fs from 'node:fs';\n" + GOOD_PLAN);
  await assert.rejects(buildLayerManifest(dir), /встроенный модуль Node/);

  const dir2 = tmp();
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  writeLayer(dir2, "import cp from 'child_process';\n" + GOOD_PLAN);
  await assert.rejects(buildLayerManifest(dir2), /встроенный модуль Node/);
});

test('plan.js can still use @automontage/motion-kit/core and a relative helper inside the layer', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/helper.js'), "export const shotAt = (at, preset) => ({ at, preset });\n");
  writeLayer(dir, "import { shotAt } from './helper.js';\n"
    + "export default function buildPlan({face}){ return { camera: { face, shots: [shotAt(0,'W')] }, items: [] }; }\n");
  const manifest = await buildLayerManifest(dir);
  assert.equal(manifest.camera.s.length, 250);
});

// Task 19 review item 3: new Module(filename, module) добавлял каждый скомпилированный слой в
// module.children этого файла навсегда — процесс, который много раз вызывает layer check (или
// preview), копил бы утечку. new Module(filename) без родителя ничего никуда не добавляет.
test('evaluated layer modules do not leak into motion-kit-node module.children', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  await buildLayerManifest(dir); // прогрев: первый вызов также грузит и кеширует core
  const selfModule = require.cache[require.resolve('../scripts/motion-kit-node')];
  const before = selfModule.children.length;
  await buildLayerManifest(dir);
  await buildLayerManifest(dir);
  await buildLayerManifest(dir);
  assert.equal(selfModule.children.length, before);
});

// Task 19 review item 7: относительный путь (как его чаще всего передают из CLI) не должен
// заставлять esbuild собирать импорты вида "src/plan.js" как если бы это было имя npm-пакета.
test('a relative layerDir resolves against the current working directory', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(path.dirname(dir));
  const manifest = await buildLayerManifest(path.basename(dir));
  assert.equal(manifest.camera.s.length, 250);
});
