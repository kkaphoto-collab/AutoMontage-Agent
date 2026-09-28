const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildLayerManifest, findPlanViolation, loadKitCore } = require('../scripts/motion-kit-node');

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

test('a layer outside the engine folder compiles to a manifest from its plan', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  const manifest = buildLayerManifest(dir);
  assert.equal(manifest.camera.s.length, 250);
  assert.equal(manifest.texts[0].id, 'caption-1');
});

// Task 19 review item 5: один и тот же compilePlan/buildManifest используется и Node-манифестом,
// и (в задаче 29) Root.jsx слоя — здесь проверяем, что buildLayerManifest не изобретает свой путь
// компиляции, а даёт ровно то, что дал бы прямой вызов loadKitCore().compilePlan/buildManifest.
test('the manifest matches buildManifest(compilePlan(...)) computed directly from the loaded kit core', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  const manifest = buildLayerManifest(dir);
  const kit = loadKitCore();
  const layer = JSON.parse(fs.readFileSync(path.join(dir, 'layer.json'), 'utf8'));
  const words = [{ w: 'Привет', t: 'Привет', s: 0.2, e: 0.6 }];
  const sfxLibrary = { sounds: {} };
  const ctx = { ...layer, words, sfxLibrary };
  const buildPlan = (c) => ({ camera: { face: c.face, shots: kit.autoShots(c.words, { endSec: c.durationInFrames / c.fps }) }, items: [] });
  const expected = kit.buildManifest(kit.compilePlan(buildPlan, ctx));
  assert.deepEqual(manifest, expected);
});

test('a completely empty layer folder names layer.json and hints at layer new', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => buildLayerManifest(dir), /нет layer\.json \(слой создаётся командой automontage layer new\)/);
});

test('a missing src/words.js hints at automontage layer words specifically', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  fs.rmSync(path.join(dir, 'src/words.js'));
  assert.throws(() => buildLayerManifest(dir), /нет src\/words\.js \(создаётся командой automontage layer words\)/);
});

test('a missing src/sfx-library.js is named on its own', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  fs.rmSync(path.join(dir, 'src/sfx-library.js'));
  assert.throws(() => buildLayerManifest(dir), /нет src\/sfx-library\.js/);
});

test('a missing src/plan.js is named on its own', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  fs.rmSync(path.join(dir, 'src/plan.js'));
  assert.throws(() => buildLayerManifest(dir), /нет src\/plan\.js/);
});

test('a broken layer.json blames layer.json with a file:line:column location', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN, { layerJson: '{ "fps": 25, ' });
  assert.throws(() => buildLayerManifest(dir), /не собирается layer\.json — layer\.json:\d+:\d+:/);
});

test('a plan.js syntax error keeps "не собирается plan.js" and reports a line number', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, 'export default function buildPlan( {\n');
  assert.throws(() => buildLayerManifest(dir), /не собирается plan\.js — src\/plan\.js:\d+:\d+:/);
});

test('a broken src/words.js blames words.js, not plan.js', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN, { words: 'export default [ {"w":"a"' });
  assert.throws(() => buildLayerManifest(dir), /не собирается words\.js — src\/words\.js:\d+:\d+:/);
});

test('a throwing buildPlan is wrapped with the layer name instead of a raw stack', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, "export default function buildPlan(){ throw new Error('boom'); }\n");
  const name = path.basename(dir);
  assert.throws(() => buildLayerManifest(dir), new RegExp(`слой ${name}: src/plan\\.js упал при построении плана — boom`));
});

test('a buildPlan that returns undefined gets a clear hint instead of a TypeError deep inside buildManifest', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, 'export default function buildPlan(){ }\n');
  assert.throws(() => buildLayerManifest(dir), /слой .+: buildPlan в src\/plan\.js должен вернуть объект плана/);
});

test('a plan.js with no default export gets the Russian hint instead of a raw esbuild export error', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, 'export function buildPlan(){ return {}; }\n');
  assert.throws(() => buildLayerManifest(dir), /слой .+: plan\.js должен экспортировать default function buildPlan/);
});

test('broken layers explain what is missing or failing', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => buildLayerManifest(dir), /нет layer\.json/);
  writeLayer(dir, 'export default function buildPlan() { return { camera: { shots: [] }, items: [] }; }\n');
  assert.throws(() => buildLayerManifest(dir), /camera\.face/);
  writeLayer(dir, 'export default function buildPlan( {\n');
  assert.throws(() => buildLayerManifest(dir), /не собирается plan\.js/);
});

// Task 19 review item 2: ошибки валидации самого kit (compileCamera/compileItems/...) идут через
// compilePlan без изменений — buildLayerManifest должен лишь добавить «слой X:» спереди, а не
// проглотить или переформулировать текст, иначе следующая задача (layer check CLI) не сможет
// отличить нарушение контракта от прочих ошибок.
test('kit validation errors keep their text and gain the "слой X:" prefix', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, 'export default function buildPlan() { return { camera: { shots: [] }, items: [] }; }\n');
  const name = path.basename(dir);
  assert.throws(() => buildLayerManifest(dir), new RegExp(`слой ${name}: camera\\.face`));
});

// Task 19 review item 4: plan.js — чистые данные для гейта. Если ему разрешить React, remotion,
// сами внутренности kit или системные модули Node, манифест перестаёт быть надёжным описанием
// того, что реально попадёт в рендер (например, доступ к файловой системе или process.env внутри
// buildPlan даёт разный манифест на разных машинах).
test('plan.js cannot import the full @automontage/motion-kit or its other subpaths', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, "import { KitBox } from '@automontage/motion-kit';\n"
    + "export default function buildPlan({face}){ return { camera: { face, shots: [{at:0,preset:'W'}] }, items: [] }; }\n");
  assert.throws(() => buildLayerManifest(dir), /src\/plan\.js импортирует «@automontage\/motion-kit» — из kit разрешён только '@automontage\/motion-kit\/core'/);
  // Чистый подпуть — не React, но всё равно не публичный вход: только core.
  writeLayer(dir, "import { secToFrame } from '@automontage/motion-kit/time.js';\n" + GOOD_PLAN);
  assert.throws(() => buildLayerManifest(dir), /«@automontage\/motion-kit\/time\.js» — из kit разрешён только '@automontage\/motion-kit\/core'/);
});

test('plan.js cannot import react directly', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, "import React from 'react';\n" + GOOD_PLAN);
  assert.throws(() => buildLayerManifest(dir), /React/);
});

test('plan.js cannot import remotion directly', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, "import { useCurrentFrame } from 'remotion';\n" + GOOD_PLAN);
  assert.throws(() => buildLayerManifest(dir), /remotion/);
});

test('plan.js cannot import Node built-ins (bare or node: specifier)', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, "import fs from 'node:fs';\n" + GOOD_PLAN);
  assert.throws(() => buildLayerManifest(dir), /встроенный модуль Node/);

  const dir2 = tmp();
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  writeLayer(dir2, "import cp from 'child_process';\n" + GOOD_PLAN);
  assert.throws(() => buildLayerManifest(dir2), /встроенный модуль Node/);
});

test('plan.js can still use @automontage/motion-kit/core and a relative helper inside the layer', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/helper.js'), "export const shotAt = (at, preset) => ({ at, preset });\n");
  writeLayer(dir, "import { shotAt } from './helper.js';\n"
    + "export default function buildPlan({face}){ return { camera: { face, shots: [shotAt(0,'W')] }, items: [] }; }\n");
  const manifest = buildLayerManifest(dir);
  assert.equal(manifest.camera.s.length, 250);
});

// Task 19 review item 3: new Module(filename, module) добавлял каждый скомпилированный слой в
// module.children этого файла навсегда — процесс, который много раз вызывает layer check (или
// preview), копил бы утечку. new Module(filename) без родителя ничего никуда не добавляет.
test('evaluated layer modules do not leak into motion-kit-node module.children', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  buildLayerManifest(dir); // прогрев: первый вызов также грузит и кеширует core
  const selfModule = require.cache[require.resolve('../scripts/motion-kit-node')];
  const before = selfModule.children.length;
  buildLayerManifest(dir);
  buildLayerManifest(dir);
  buildLayerManifest(dir);
  assert.equal(selfModule.children.length, before);
});

// Task 19 review item 7: относительный путь (как его чаще всего передают из CLI) не должен
// заставлять esbuild собирать импорты вида "src/plan.js" как если бы это было имя npm-пакета.
test('a relative layerDir resolves against the current working directory', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, GOOD_PLAN);
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(path.dirname(dir));
  const manifest = buildLayerManifest(path.basename(dir));
  assert.equal(manifest.camera.s.length, 250);
});

// Task 19, второе ревью. Граница «чистого плана» считается после синхронной сборки по metafile
// esbuild: stdin-entry и сам kit — доверенные, всё остальное — код ролика, где бы он ни лежал.
const ENGINE_ROOT = path.join(__dirname, '..');
const LAYER_FILE_NAMES = ['layer.json', 'src/words.js', 'src/sfx-library.js', 'src/plan.js'];

function cleanTmp(t) {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Спецификатор импорта из src/ слоя на file. esbuild считает относительные импорты от
// канонического пути (на macOS временная папка — симлинк), поэтому и здесь канонические пути. Если
// пути на разных дисках (Windows CI: движок на D:, временные файлы на C:), относительного пути нет —
// тогда импорт абсолютный.
function importSpec(layerDir, file) {
  const rel = path.relative(path.join(fs.realpathSync(layerDir), 'src'), fs.realpathSync(file));
  return path.isAbsolute(rel) ? file : rel.split(path.sep).join('/');
}

// Чистая модель metafile, как его отдаёт esbuild на Windows: ключи и path — относительно
// absWorkingDir через '/', на другом диске — абсолютные; original — как написано в исходнике.
function winMetafile(root, planExtra = [], moreInputs = {}) {
  const env = { path: '<define:process.env>', kind: 'import-statement', external: true };
  const kit = 'D:/a/AutoMontage-Agent/src';
  return { inputs: {
    '<stdin>': { imports: LAYER_FILE_NAMES
      .map((f) => ({ path: f, kind: 'import-statement', original: path.win32.join(root, f) })).concat(env) },
    '<define:process.env>': { imports: [] },
    'layer.json': { imports: [] },
    'src/words.js': { imports: [env] },
    'src/sfx-library.js': { imports: [env] },
    'src/data.json': { imports: [] },
    'src/helper.js': { imports: [env] },
    'src/plan.js': { imports: [
      { path: `${kit}/motion-kit/core.js`, kind: 'import-statement', original: '@automontage/motion-kit/core' },
      { path: 'src/helper.js', kind: 'import-statement', original: './helper.js' },
      { path: 'src/data.json', kind: 'import-statement', original: './data.json' },
      env, ...planExtra] },
    [`${kit}/motion-kit/core.js`]: { imports: [{ path: `${kit}/motion-kit/safe.js`, kind: 'import-statement', original: './safe.js' }, env] },
    [`${kit}/motion-kit/safe.js`]: { imports: [
      { path: `${kit}/scenes/safezone.js`, kind: 'import-statement', original: '../scenes/safezone.js' },
      { path: 'remotion', kind: 'import-statement', external: true }, env] },
    [`${kit}/scenes/safezone.js`]: { imports: [env] },
    ...moreInputs,
  } };
}

function winBoundary(root, kitRoot = 'D:\\a\\AutoMontage-Agent\\src\\motion-kit') {
  const opts = {
    root, kitRoot,
    kitFiles: [path.win32.join(kitRoot, '..', 'scenes', 'safezone.js')],
    layerFiles: LAYER_FILE_NAMES.map((f) => path.win32.join(root, f)),
  };
  return (metafile) => findPlanViolation(metafile, opts, { pathApi: path.win32, canonical: (p) => p });
}

// Прошлый плагин пропускал абсолютные спецификаторы только через startsWith('/'): на Windows
// entry импортирует C:\…\layer.json и любой слой падал. Здесь та же функция границы с path.win32.
test('the plan boundary works with Windows paths: entry and in-layer imports pass, outside ones fail', () => {
  const root = 'C:\\work\\reels\\motion-v01';
  const check = winBoundary(root);
  const imp = (p, original, extra = {}) => ({ path: p, kind: 'import-statement', original, ...extra });
  assert.equal(check(winMetafile(root)), null);
  // Регистр букв на Windows не важен: тот же файл слоя другими буквами — всё ещё внутри.
  assert.equal(check(winMetafile(root, [imp('c:/WORK/Reels/motion-v01/src/Helper.js', './Helper.js')])), null);

  const outside = check(winMetafile(root, [imp('../outside/x.js', '..\\..\\outside\\x.js')]));
  assert.equal(outside.file, 'src/plan.js');
  assert.equal(outside.spec, '..\\..\\outside\\x.js');
  assert.match(outside.reason, /файлы ролика должны лежать внутри слоя/);
  assert.match(check(winMetafile(root, [imp('E:/elsewhere/x.js', 'E:\\elsewhere\\x.js')])).reason, /внутри слоя/);

  const kitIndex = check(winMetafile(root, [imp('D:/a/AutoMontage-Agent/src/motion-kit/index.js', 'D:\\a\\AutoMontage-Agent\\src\\motion-kit\\index.js')]));
  assert.equal(kitIndex.spec, '@automontage/motion-kit/index.js');
  assert.match(kitIndex.reason, /из kit разрешён только '@automontage\/motion-kit\/core'/);
  assert.match(check(winMetafile(root, [{ path: 'node:fs', kind: 'import-statement', external: true }])).reason, /встроенный модуль Node/);

  // Помощник вне слоя, который сам тянет node:fs: называем импорт из файла слоя, а не из помощника.
  const hidden = check(winMetafile(root, [imp('../shared/helper.js', '../../shared/helper.js')], {
    '../shared/helper.js': { imports: [{ path: 'node:fs', kind: 'import-statement', external: true }] },
  }));
  assert.equal(hidden.file, 'src/plan.js');
  assert.match(hidden.reason, /внутри слоя/);

  // Entry — наш собственный код: всё, кроме четырёх файлов слоя, у него — отказ.
  const polluted = winMetafile(root);
  polluted.inputs['<stdin>'].imports.push({ path: 'node:fs', kind: 'import-statement', external: true });
  assert.notEqual(check(polluted), null);
});

// Если канонические пути не сошлись (короткие имена 8.3, junction), проверка должна отказать,
// а не молча выключиться: файлы слоя и kit тогда считаются кодом ролика вне слоя.
test('a path spelling mismatch makes the boundary deny, never silently allow', () => {
  const longRoot = 'C:\\work\\long-folder-name\\motion-v01';
  const shortRoot = 'C:\\work\\LONG-F~1\\motion-v01';
  const abs = { path: 'C:/work/long-folder-name/motion-v01/src/helper.js', kind: 'import-statement', original: './helper.js' };
  assert.equal(winBoundary(longRoot)(winMetafile(longRoot, [abs])), null);
  assert.notEqual(winBoundary(shortRoot)(winMetafile(shortRoot, [abs])), null);
  // kit, записанный другим написанием, перестаёт быть доверенным: его импорт remotion — отказ.
  assert.notEqual(winBoundary(longRoot, 'D:\\A\\AUTOMO~1\\src\\motion-kit')(winMetafile(longRoot)), null);
});

test('a helper outside the layer is rejected, even one that hides a Node built-in', (t) => {
  const dir = cleanTmp(t);
  const out = cleanTmp(t);
  fs.writeFileSync(path.join(out, 'helper.js'), "import fs from 'node:fs';\nexport const shotAt = (at, preset) => ({ at, preset, n: fs.readdirSync('.').length });\n");
  writeLayer(dir, `import { shotAt } from ${JSON.stringify(importSpec(dir, path.join(out, 'helper.js')))};\n`
    + "export default function buildPlan({face}){ return { camera: { face, shots: [shotAt(0,'W')] }, items: [] }; }\n");
  assert.throws(() => buildLayerManifest(dir), /src\/plan\.js импортирует «[^»]*helper\.js» — .*файлы ролика должны лежать внутри слоя/);
});

test('an absolute-path import of a file outside the layer is rejected', (t) => {
  const dir = cleanTmp(t);
  const out = cleanTmp(t);
  fs.writeFileSync(path.join(out, 'data.js'), 'export default 1;\n');
  writeLayer(dir, `import n from ${JSON.stringify(path.join(out, 'data.js'))};\n` + GOOD_PLAN);
  assert.throws(() => buildLayerManifest(dir), /src\/plan\.js импортирует .* — .*файлы ролика должны лежать внутри слоя/);
});

test('a relative import into the engine kit is rejected and named by its kit path', (t) => {
  const dir = cleanTmp(t);
  const kitIndex = path.join(ENGINE_ROOT, 'src', 'motion-kit', 'index.js');
  writeLayer(dir, `import * as kit from ${JSON.stringify(importSpec(dir, kitIndex))};\n` + GOOD_PLAN);
  assert.throws(() => buildLayerManifest(dir), (error) => {
    assert.match(error.message, /«@automontage\/motion-kit\/index\.js» — из kit разрешён только '@automontage\/motion-kit\/core'/);
    assert.ok(!error.message.includes(ENGINE_ROOT), error.message);
    return true;
  });
});

test('a symlink inside the layer that points outside is rejected', (t) => {
  const dir = cleanTmp(t);
  const out = cleanTmp(t);
  fs.writeFileSync(path.join(out, 'shots.js'), 'export const shotAt = (at, preset) => ({ at, preset });\n');
  writeLayer(dir, "import { shotAt } from './shots.js';\n"
    + "export default function buildPlan({face}){ return { camera: { face, shots: [shotAt(0,'W')] }, items: [] }; }\n");
  try {
    fs.symlinkSync(path.join(out, 'shots.js'), path.join(dir, 'src', 'shots.js'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`нет прав на симлинки: ${error.code}`);
    throw error;
  }
  assert.throws(() => buildLayerManifest(dir), /«\.\/shots\.js» — .*файлы ролика должны лежать внутри слоя/);
});

// Рендер слоя идёт с пустым env-файлом — план не должен ветвиться по переменным окружения машины.
test('plan.js sees an empty process.env, like the render', (t) => {
  const dir = cleanTmp(t);
  assert.ok(process.env.PATH, 'в тестовом процессе PATH задан');
  writeLayer(dir, 'export default function buildPlan({face}){\n'
    + "  const empty = JSON.stringify(process.env) === '{}' && process.env.PATH === undefined;\n"
    + "  return { hook: empty ? 'enumeration' : 'speaker', camera: { face, shots: [{at:0,preset:'W'}] }, items: [] };\n}\n");
  assert.equal(buildLayerManifest(dir).hook, 'enumeration');
});

test('a top-level throw in plan.js or words.js is wrapped as a layer loading error', (t) => {
  const dir = cleanTmp(t);
  const name = path.basename(dir);
  writeLayer(dir, "throw new Error('top boom');\n" + GOOD_PLAN);
  assert.throws(() => buildLayerManifest(dir), (error) => {
    assert.match(error.message, new RegExp(`^слой ${name}: ошибка при загрузке файлов слоя — top boom`));
    assert.equal(error.cause?.message, 'top boom');
    return true;
  });
  writeLayer(dir, GOOD_PLAN, { words: "throw new Error('words boom');\nexport default [];\n" });
  assert.throws(() => buildLayerManifest(dir), /ошибка при загрузке файлов слоя — words boom/);
});

test('an async buildPlan is rejected with a clear hint', (t) => {
  const dir = cleanTmp(t);
  const name = path.basename(dir);
  writeLayer(dir, "export default async function buildPlan({face}){ return { camera: { face, shots: [{at:0,preset:'W'}] }, items: [] }; }\n");
  assert.throws(() => buildLayerManifest(dir), new RegExp(`слой ${name}: buildPlan в src/plan\\.js должен быть синхронным`));
});

// CLI слоя (Task 28) включит source maps — тогда ошибка buildPlan называет строку в самом plan.js.
test('with source maps on, a throwing buildPlan points at its line in src/plan.js', (t) => {
  const dir = cleanTmp(t);
  const was = process.sourceMapsEnabled ?? false;
  process.setSourceMapsEnabled(true);
  t.after(() => process.setSourceMapsEnabled(was));
  writeLayer(dir, '// строка 1\n// строка 2\nexport default function buildPlan({ wrds }) {\n'
    + '  return { camera: { shots: wrds.map((w) => w) }, items: [] };\n}\n');
  assert.throws(() => buildLayerManifest(dir), /src\/plan\.js упал при построении плана — .* \(src\/plan\.js:4:\d+\)$/);
});

test('build errors that mention kit files show @automontage/motion-kit/…, not engine paths', (t) => {
  const dir = cleanTmp(t);
  writeLayer(dir, "import Kit from '@automontage/motion-kit';\n" + GOOD_PLAN);
  assert.throws(() => buildLayerManifest(dir), (error) => {
    assert.match(error.message, /не собирается plan\.js — src\/plan\.js:\d+:\d+: .*"@automontage\/motion-kit\/index\.js"/);
    assert.ok(!error.message.includes(ENGINE_ROOT), error.message);
    assert.ok(!/src[\\/]motion-kit/.test(error.message), error.message);
    return true;
  });
});

// Имя entry в metafile не должно совпадать с настоящим файлом слоя: при совпадении esbuild
// оставляет под общим ключом только импорты entry, и импорты файла выпадают из проверки. Заодно
// это первый настоящий (не мокнутый) пример «нарушение не в самом plan.js»: сообщение показывает
// всю цепочку от plan.js до нарушившего файла, а не просто его имя.
test('a real layer-manifest.js in the layer is checked like any other layer file', (t) => {
  const dir = cleanTmp(t);
  writeLayer(dir, "import { n } from '../layer-manifest.js';\n"
    + "export default function buildPlan({face}){ return { hook: n ? 'speaker' : 'enumeration', camera: { face, shots: [{at:0,preset:'W'}] }, items: [] }; }\n");
  fs.writeFileSync(path.join(dir, 'layer-manifest.js'), "import fs from 'node:fs';\nexport const n = fs.readdirSync('.').length;\n");
  assert.throws(() => buildLayerManifest(dir), /src\/plan\.js → layer-manifest\.js импортирует «node:fs» — встроенный модуль Node/);
});

// Ревью Task 19/20: когда нарушивший файл — не сам src/plan.js, а его собственный helper (файл со
// сценами, который сам тянет remotion), автору негде искать причину, если назван только helper.
// Сообщение показывает всю цепочку от plan.js и говорит прямо, что убрать из плана.
test('a forbidden import reached through a layer helper shows the chain from plan.js and names the fix', (t) => {
  const dir = cleanTmp(t);
  writeLayer(dir, "import { TITLE } from './scenes.jsx';\n"
    + "export default function buildPlan({face}){ return { camera: { face, shots: [{at:0,preset:'W'}] }, items: [] }; }\n");
  fs.writeFileSync(path.join(dir, 'src/scenes.jsx'), "import { useCurrentFrame } from 'remotion';\nexport const TITLE = String(useCurrentFrame);\n");
  assert.throws(() => buildLayerManifest(dir),
    /src\/plan\.js → src\/scenes\.jsx импортирует «remotion» — .*чистыми данными.*Уберите импорт src\/scenes\.jsx из плана/s);
});

// Тот же случай, но нарушивший файл лежит глубже: plan.js подключает helper.js, а тот — scenes.jsx
// с remotion. Цепочка называет оба файла по порядку; подсказка чинить — helper.js (первый файл
// после plan.js), а не сам scenes.jsx, потому что именно его импорт стоит убрать из плана.
test('a forbidden import reached through two hops shows the full chain and names the first file after plan.js as the fix', (t) => {
  const dir = cleanTmp(t);
  writeLayer(dir, "import { TITLE } from './helper.js';\n"
    + "export default function buildPlan({face}){ return { camera: { face, shots: [{at:0,preset:'W'}] }, items: [] }; }\n");
  fs.writeFileSync(path.join(dir, 'src/helper.js'), "export { TITLE } from './scenes.jsx';\n");
  fs.writeFileSync(path.join(dir, 'src/scenes.jsx'), "import { useCurrentFrame } from 'remotion';\nexport const TITLE = String(useCurrentFrame);\n");
  assert.throws(() => buildLayerManifest(dir),
    /src\/plan\.js → src\/helper\.js → src\/scenes\.jsx импортирует «remotion».*Уберите импорт src\/helper\.js из плана/s);
});

// esbuild перечисляет metafile.inputs в пост-порядке (зависимости раньше того, кто их подключил),
// поэтому линейный проход в поисках «первого» импортёра нашёл бы src/sfx-library.js (сам файл слоя,
// уже стоящий в четырёх обязательных импортах entry) по helper-у, который его импортировал бы
// глубже — и напрасно приписал бы файлу цепочку. sfx-library.js импортирован entry напрямую, и
// приписки быть не должно, даже если plan.js его тоже импортирует.
test('an entry file that plan.js also imports directly gets no chain suffix', (t) => {
  const dir = cleanTmp(t);
  writeLayer(dir, "import lib from './sfx-library.js';\n"
    + "export default function buildPlan({face}){ return { camera: { face, shots: [{at:0,preset:'W'}] }, items: [] }; }\n",
  { sfxLibrary: "import fs from 'node:fs';\nexport default { sounds: {}, n: fs.existsSync('.') };\n" });
  assert.throws(() => buildLayerManifest(dir), (error) => {
    assert.match(error.message, /слой .+: src\/sfx-library\.js импортирует «node:fs»/);
    assert.ok(!error.message.includes('→'), error.message);
    return true;
  });
});

// Когда и plan.js, и его helper импортируют один и тот же нарушивший файл напрямую, кратчайший
// путь от plan.js — короче и понятнее: BFS должен вернуть именно его, независимо от того, в каком
// порядке plan.js написал свои собственные импорты (helper мог оказаться в metafile раньше или
// позже — это не должно менять найденную цепочку).
test('when both plan.js and a helper import the same offending file, the chain picks the shorter path via plan.js', (t) => {
  for (const order of ['scenes-first', 'helper-first']) {
    const dir = cleanTmp(t);
    const imports = order === 'scenes-first'
      ? "import { T } from './scenes.jsx';\nimport { H } from './helper.js';\n"
      : "import { H } from './helper.js';\nimport { T } from './scenes.jsx';\n";
    writeLayer(dir, `${imports}export default function buildPlan({face}){ return { camera: { face, shots: [{at:0,preset:'W'}] }, items: [] }; }\n`);
    fs.writeFileSync(path.join(dir, 'src/helper.js'), "export { T as H } from './scenes.jsx';\n");
    fs.writeFileSync(path.join(dir, 'src/scenes.jsx'), "import { useCurrentFrame } from 'remotion';\nexport const T = String(useCurrentFrame);\n");
    assert.throws(() => buildLayerManifest(dir), /слой .+: src\/plan\.js → src\/scenes\.jsx импортирует «remotion»/, order);
  }
});

test('a layer file literally named <stdin> cannot hide its imports behind the entry', (t) => {
  const dir = cleanTmp(t);
  writeLayer(dir, "import { n } from '../<stdin>';\n"
    + "export default function buildPlan({face}){ return { hook: n ? 'speaker' : 'enumeration', camera: { face, shots: [{at:0,preset:'W'}] }, items: [] }; }\n");
  try {
    fs.writeFileSync(path.join(dir, '<stdin>'), "import fs from 'node:fs';\nexport const n = fs.readdirSync('.').length;\n");
  } catch (error) {
    return t.skip(`файловая система не допускает такое имя: ${error.code}`);
  }
  assert.throws(() => buildLayerManifest(dir), /src\/plan\.js импортирует «\.\.\/<stdin>» — имя «<stdin>» занято сборкой слоя/);
});
