// Kit и проектный слой в Node: тот же код, что рендерит Remotion, собирается esbuild в CommonJS.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync, build } = require('esbuild');
const { MOTION_KIT_ALIAS, MOTION_KIT_DIR } = require('./remotion-webpack');

const ENGINE_ROOT = path.join(__dirname, '..');
const CORE_SPECIFIER = `${MOTION_KIT_ALIAS}/core`;
const NODE_BUILTINS = new Set(Module.builtinModules);
// Второй элемент — что подсказать в сообщении о недостающем файле. У words.js своя команда:
// слой создаётся `layer new`, а слова транскрипта отдельно — `layer words`.
const LAYER_FILES = [
  ['layer.json', 'слой создаётся командой automontage layer new'],
  ['src/plan.js', 'слой создаётся командой automontage layer new'],
  ['src/words.js', 'создаётся командой automontage layer words'],
  ['src/sfx-library.js', 'слой создаётся командой automontage layer new'],
];

function bundleOptions(contents, resolveDir, sourcefile, extra) {
  return {
    stdin: { contents, resolveDir, sourcefile, loader: 'js' },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['remotion'],
    alias: { [MOTION_KIT_ALIAS]: MOTION_KIT_DIR },
    logLevel: 'silent',
    ...extra,
  };
}

function bundle(contents, resolveDir, sourcefile, extra = {}) {
  return buildSync(bundleOptions(contents, resolveDir, sourcefile, extra)).outputFiles[0].text;
}

// esbuild не даёт использовать плагины в синхронном API (buildSync/transformSync) — только в
// асинхронном build(). Плагин чистоты плана (plan-purity) нужен только тут, поэтому только сборка
// самого слоя асинхронная; loadKitCore (без плагинов, только сам движок) остаётся синхронным.
async function bundleAsync(contents, resolveDir, sourcefile, extra = {}) {
  const result = await build(bundleOptions(contents, resolveDir, sourcefile, extra));
  return result.outputFiles[0].text;
}

// 'remotion' остаётся внешним и берётся из node_modules движка, где бы ни лежал слой. Без второго
// аргумента (родителя) — иначе Module добавляет каждый скомпилированный слой в module.children
// этого файла навсегда, и процесс, много раз вызывающий layer check, копит утечку.
function evaluate(text, filename) {
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(ENGINE_ROOT);
  compiled._compile(text, filename);
  return compiled.exports;
}

let core = null;
function loadKitCore() {
  if (!core) {
    const file = path.join(MOTION_KIT_DIR, 'core.js');
    core = evaluate(bundle(`export * from ${JSON.stringify(file)};`, MOTION_KIT_DIR, 'kit-core.js'), file);
  }
  return core;
}

// Гейт доверяет манифесту только если plan.js описывает чистые данные — без React, без рантайма
// remotion, без доступа к файлам/процессу через встроенные модули Node. Иначе один и тот же слой
// мог бы дать разный манифест на разных машинах или в разное время суток, а гейт проверял бы не
// то, что реально попадёт в рендер. Ограничение действует только на файлы внутри самой папки слоя
// (plan.js и то, что он импортирует относительно себя) — внутренности kit имеют право на 'remotion'.
function planPurityPlugin(layerDir, name) {
  // esbuild разворачивает симлинки в путях, которые отдаёт onResolve (importer) — на macOS
  // системный каталог временных файлов сам является симлинком на свою каноническую форму.
  // Сравнивать нужно канонический путь с каноническим, иначе importer всегда «снаружи» слоя и
  // проверка молча отключается.
  const layerRoot = fs.realpathSync(layerDir);
  return {
    name: 'plan-purity',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // У синтетического entry (наш собственный код в bundle()) importer не абсолютный путь —
        // это не файл слоя, а сборочный узел, который сам легитимно тянет layer.json/plan.js/…
        if (!args.importer || !path.isAbsolute(args.importer)) return null;
        const rel = path.relative(layerRoot, args.importer);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // импортёр не внутри слоя — сам kit
        const spec = args.path;
        if (spec === CORE_SPECIFIER) return null;
        if (spec.startsWith('.') || spec.startsWith('/')) return null; // относительные модули слоя (включая .json)
        const reason = spec === MOTION_KIT_ALIAS || spec.startsWith(`${MOTION_KIT_ALIAS}/`)
          ? `«${spec}» — это React-компоненты kit, а не чистые данные`
          : /^react(-dom)?(\/|$)/.test(spec)
            ? `«${spec}» — это React, а не чистые данные плана`
            : spec === 'remotion'
              ? '«remotion» — это рантайм рендера, а не чистые данные плана'
              : spec.startsWith('node:') || NODE_BUILTINS.has(spec)
                ? `«${spec}» — встроенный модуль Node, доступ к файлам и процессу из plan.js запрещён`
                : `«${spec}» — недопустимый импорт для plan.js`;
        return {
          errors: [{
            text: `слой ${name}: ${rel.split(path.sep).join('/')} импортирует ${reason} — plan.js должен оставаться чистым, иначе гейт увидит не то, что реально рендерится`,
          }],
        };
      });
    },
  };
}

// Ошибка сборки называет реальный виновный файл слоя (layer.json/words.js/sfx-library.js/plan.js)
// по месту, которое нашёл esbuild (absWorkingDir делает location.file коротким, относительно
// слоя). Отказ плагина чистоты уже полностью готов на русском — оборачивать его дальше не нужно.
function explainBuildError(error, name) {
  const first = error.errors?.[0];
  if (first?.pluginName === 'plan-purity') return new Error(first.text);
  if (!first) return new Error(`слой ${name}: не собирается plan.js — ${error.message}`);
  const loc = first.location;
  if (!loc) return new Error(`слой ${name}: не собирается plan.js — ${first.text}`);
  const blamed = path.basename(loc.file);
  return new Error(`слой ${name}: не собирается ${blamed} — ${loc.file}:${loc.line}:${loc.column}: ${first.text}`);
}

async function buildLayerManifest(layerDir) {
  const dir = path.resolve(layerDir);
  const name = path.basename(dir);
  for (const [file, hint] of LAYER_FILES) {
    if (!fs.existsSync(path.join(dir, file))) {
      throw new Error(`слой ${name}: нет ${file} (${hint})`);
    }
  }
  const at = (file) => JSON.stringify(path.join(dir, file));
  // Entry только загружает файлы слоя и отдаёт buildPlan и ctx отдельно, не вызывая buildPlan
  // внутри бандла: namespace-импорт (а не именованный) не даёт esbuild упасть на build-этапе, если
  // в plan.js вообще нет default export — тогда planModule.default будет undefined, и понятную
  // русскую подсказку даст уже compilePlan в Node, а не сырая ошибка esbuild про "no matching export".
  const entry = [
    `import layer from ${at('layer.json')};`,
    `import words from ${at('src/words.js')};`,
    `import sfxLibrary from ${at('src/sfx-library.js')};`,
    `import * as planModule from ${at('src/plan.js')};`,
    'export const buildPlan = planModule.default;',
    'export const ctx = { ...layer, words, sfxLibrary };',
  ].join('\n');
  let text;
  try {
    text = await bundleAsync(entry, dir, 'layer-manifest.js', {
      absWorkingDir: dir,
      sourcemap: 'inline',
      plugins: [planPurityPlugin(dir, name)],
    });
  } catch (error) {
    throw explainBuildError(error, name);
  }
  const mod = evaluate(text, path.join(dir, 'layer-manifest.js'));
  const kitCore = loadKitCore();
  try {
    return kitCore.buildManifest(kitCore.compilePlan(mod.buildPlan, mod.ctx));
  } catch (error) {
    throw new Error(`слой ${name}: ${error.message}`);
  }
}

module.exports = { buildLayerManifest, loadKitCore };
