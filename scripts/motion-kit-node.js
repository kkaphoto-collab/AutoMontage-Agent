// Kit и проектный слой в Node: тот же код, что рендерит Remotion, собирается esbuild в CommonJS.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { MOTION_KIT_ALIAS, MOTION_KIT_DIR } = require('./remotion-webpack');

const ENGINE_ROOT = path.join(__dirname, '..');
const CORE_SPECIFIER = `${MOTION_KIT_ALIAS}/core`;
const NODE_BUILTINS = new Set(Module.builtinModules);
// Entry слоя собирается из stdin без sourcefile — тогда в metafile он называется «<stdin>». С
// sourcefile вида layer-manifest.js его ключ совпал бы с настоящим файлом слоя с тем же именем,
// и импорты этого файла пропали бы из проверки (проверено на esbuild 0.28).
const STDIN = '<stdin>';
// define объектом esbuild оформляет как синтетический модуль, который импортирует каждый файл.
const ENV_DEFINE = '<define:process.env>';
const KIT_ROOT = canonicalPath(MOTION_KIT_DIR);
// Модули вне src/motion-kit, которые kit импортирует сам (без собственных импортов).
const KIT_FILES = [canonicalPath(path.join(ENGINE_ROOT, 'src', 'scenes', 'safezone.js'))];
const PURE = 'план должен оставаться чистыми данными, иначе гейт проверит не то, что реально рендерится';
const REASONS = {
  kit: `из kit разрешён только '${CORE_SPECIFIER}'`,
  react: `это React, а не чистые данные — ${PURE}`,
  remotion: `это рантайм рендера, а не чистые данные — ${PURE}`,
  node: `встроенный модуль Node: доступ к файлам и процессу из плана запрещён — ${PURE}`,
  package: `сторонний пакет: план импортирует только '${CORE_SPECIFIER}' и файлы своего слоя`,
  outside: 'файл вне слоя: файлы ролика должны лежать внутри слоя',
  reserved: `имя «${STDIN}» занято сборкой слоя, переименуйте файл`,
};
// Второй элемент — что подсказать в сообщении о недостающем файле. У words.js своя команда:
// слой создаётся `layer new`, а слова транскрипта отдельно — `layer words`.
const LAYER_FILES = [
  ['layer.json', 'слой создаётся командой automontage layer new'],
  ['src/plan.js', 'слой создаётся командой automontage layer new'],
  ['src/words.js', 'создаётся командой automontage layer words'],
  ['src/sfx-library.js', 'слой создаётся командой automontage layer new'],
];

function bundle(stdin, extra = {}) {
  return buildSync({
    stdin: { loader: 'js', ...stdin },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['remotion'],
    alias: { [MOTION_KIT_ALIAS]: MOTION_KIT_DIR },
    logLevel: 'silent',
    ...extra,
  });
}

// Канонический путь: симлинки развёрнуты, а на Windows раскрыты и короткие имена 8.3 (RUNNER~1) —
// это умеет только native-версия realpath. Несуществующий путь остаётся как есть.
function canonicalPath(file) {
  for (const realpath of [fs.realpathSync.native, fs.realpathSync]) {
    try {
      return realpath(file);
    } catch {
      // следующий способ
    }
  }
  return path.resolve(file);
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
    const stdin = { contents: `export * from ${JSON.stringify(file)};`, resolveDir: MOTION_KIT_DIR, sourcefile: 'kit-core.js' };
    core = evaluate(bundle(stdin).outputFiles[0].text, file);
  }
  return core;
}

// Граница «чистого плана». Гейт доверяет манифесту, только если план — чистые данные: без React и
// рантайма remotion, без файлов, процесса и env машины, без кода вне папки слоя. Иначе один и тот же
// слой давал бы разный манифест на разных машинах, а гейт проверял бы не то, что попадёт в рендер.
//
// Это ограждение от случайностей, а не песочница: динамический require(переменная), eval или
// globalThis.process оно не ловит.
//
// Решение принимается по metafile esbuild после синхронной сборки и закрыто по умолчанию. Доверены
// только stdin-entry (он импортирует ровно четыре файла слоя) и сам kit — файлы, чей канонический
// путь лежит в src/motion-kit, плюс KIT_FILES. Всё остальное — код ролика, где бы он ни лежал: ему
// можно импортировать только '@automontage/motion-kit/core' и файлы внутри слоя (канонические пути,
// поэтому симлинк из слоя наружу — отказ). Если пути не сойдутся по написанию (junction, имена 8.3),
// файлы окажутся «вне слоя» и сборка откажет, а не пропустит молча.
//
// pathApi и canonical подменяются в тестах (path.win32 и тождественная функция); root, kitRoot,
// kitFiles и layerFiles должны быть уже каноническими.
function findPlanViolation(metafile, { root, kitRoot, kitFiles = [], layerFiles = [] },
  { pathApi = path, canonical = canonicalPath } = {}) {
  const p = pathApi;
  const same = (a, b) => p.relative(a, b) === '';
  const within = (dir, file) => {
    const rel = p.relative(dir, file);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
  };
  const slash = (rel) => rel.split(p.sep).join('/');
  const resolve = (file) => canonical(p.resolve(root, file));
  const isKit = (file) => within(kitRoot, file) || kitFiles.some((kitFile) => same(kitFile, file));
  const isEnv = (record) => record.external && record.path === ENV_DEFINE;

  function externalProblem(spec) {
    if (spec.startsWith('.') || p.isAbsolute(spec)) return REASONS.outside;
    if (/^react(-dom)?(\/|$)/.test(spec)) return REASONS.react;
    if (spec === 'remotion' || spec.startsWith('remotion/') || spec.startsWith('@remotion/')) return REASONS.remotion;
    if (spec.startsWith('node:') || NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.split('/')[0])) return REASONS.node;
    return REASONS.package;
  }

  // Что не так с импортом кода ролика: null — можно; иначе причина и то, как назвать импорт.
  function planProblem(record) {
    const spec = record.original ?? record.path;
    if (isEnv(record) || spec === CORE_SPECIFIER) return null;
    if (spec === MOTION_KIT_ALIAS || spec.startsWith(`${MOTION_KIT_ALIAS}/`)) return { spec, reason: REASONS.kit };
    if (record.external) return { spec, reason: externalProblem(spec) };
    if (record.path === STDIN) return { spec, reason: REASONS.reserved };
    const target = resolve(record.path);
    if (isKit(target)) {
      const shown = within(kitRoot, target) ? `${MOTION_KIT_ALIAS}/${slash(p.relative(kitRoot, target))}` : spec;
      return { spec: shown, reason: REASONS.kit };
    }
    return within(root, target) ? null : { spec, reason: REASONS.outside };
  }

  // Entry — наш код: кроме четырёх файлов слоя (и env) он ничего импортировать не может.
  function entryProblem(record) {
    if (isEnv(record) || (!record.external && layerFiles.some((file) => same(file, resolve(record.path))))) return null;
    return { spec: record.original ?? record.path, reason: REASONS.outside };
  }

  const violations = [];
  // ENV_DEFINE — синтетический модуль без импортов, отдельное исключение для него не нужно.
  for (const [key, input] of Object.entries(metafile?.inputs || {})) {
    const entry = key === STDIN;
    const file = entry ? null : resolve(key);
    if (!entry && isKit(file)) continue;
    for (const record of input.imports || []) {
      const problem = entry ? entryProblem(record) : planProblem(record);
      if (problem) {
        violations.push({ ...problem, key: entry ? STDIN : key, file: entry ? 'сборка слоя' : slash(p.relative(root, file)), inLayer: entry || within(root, file) });
      }
    }
  }
  // Первым называем импорт из файла самого слоя: помощник снаружи может нарушать и сам, но
  // исправлять автору нужно строку в своём файле.
  const first = violations.find((v) => v.inLayer) || violations[0];
  if (!first) return null;
  // Файл, где буквально стоит запрещённый импорт, не обязан быть src/plan.js: например, план
  // подключает свой helper со сценами, а тот сам тянет remotion. Тогда одного имени файла мало —
  // автору негде искать причину, если он открывает plan.js и не видит там ничего подозрительного.
  // Кратчайший путь от entry (BFS, не первое совпадение по metafile.inputs — esbuild перечисляет
  // входы в пост-порядке: сначала зависимости, потом того, кто их подключил, поэтому «первое
  // совпадение» было бы самым глубоким импортёром, а не самой понятной и короткой цепочкой от
  // plan.js) показывает, как именно esbuild дошёл до нарушившего файла. Когда файл подключён самим
  // entry напрямую (это и есть четыре файла слоя, включая сам src/plan.js), цепочка не нужна —
  // имя файла уже всё объясняет.
  const chain = first.key && first.key !== STDIN ? shortestImportChain(metafile, first.key) : null;
  const named = chain && chain.length > 2 ? chain.slice(1).map((key) => slash(key)) : null;
  const file = named ? named.join(' → ') : first.file;
  // React/remotion в чужом файле — обычно автор хотел использовать готовый JSX-компонент сцены
  // прямо из плана. Называем, что убрать и откуда: chain[1] — тот файл слоя (необязательно
  // plan.js — им может быть и sfx-library.js), что первым в цепочке подключил chain[2], а через
  // него дошёл до нарушения. Формулировка общая («данные слоя», не «план»): chain[1] не обязан
  // быть именно plan.js.
  const isJsxLeak = named && (first.reason === REASONS.react || first.reason === REASONS.remotion);
  const fixHint = isJsxLeak
    ? `. Уберите импорт ${slash(chain[2])} из ${slash(chain[1])}: React-файлы слоя подключает Root.jsx, данные слоя ссылаются на них по id.`
    : '';
  return { file, spec: first.spec, reason: first.reason, fixHint };
}

// Кратчайший путь по metafile от entry ('<stdin>') до targetKey — BFS по прямым рёбрам импорта.
// esbuild перечисляет metafile.inputs в пост-порядке обхода (зависимости раньше того, кто их
// подключил; entry — последним), поэтому линейный проход в поисках «первого» импортёра называл бы
// самый глубокий из них, а не кратчайший и самый понятный путь от plan.js.
function shortestImportChain(metafile, targetKey) {
  const queue = [[STDIN]];
  const seen = new Set([STDIN]);
  while (queue.length) {
    const chain = queue.shift();
    const last = chain[chain.length - 1];
    if (last === targetKey) return chain;
    for (const record of metafile.inputs[last]?.imports || []) {
      const next = record.path;
      if (!seen.has(next) && metafile.inputs[next]) {
        seen.add(next);
        queue.push([...chain, next]);
      }
    }
  }
  return null;
}

// Пути внутрь kit в сообщениях — в виде импорта '@automontage/motion-kit/…', без домашней папки
// движка. esbuild пишет их относительно рабочей папки слоя, Node — абсолютными.
function hideKitPaths(text, root) {
  const forms = new Set();
  for (const kit of new Set([MOTION_KIT_DIR, KIT_ROOT])) {
    for (const form of [kit, path.relative(root, kit)]) {
      forms.add(`${form}${path.sep}`);
      forms.add(`${form.split(path.sep).join('/')}/`);
    }
  }
  let out = String(text);
  for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join(`${MOTION_KIT_ALIAS}/`);
  return out;
}

// Первый кадр стека в src/plan.js. Он есть, только если в процессе включены source maps (CLI слоя
// включает их сам); без них стек указывает в строки бандла, и место не добавляется.
function planFrame(error) {
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  for (const line of stack.split('\n')) {
    const match = /^\s+at\s.*[\\/]src[\\/]plan\.js:(\d+):(\d+)\)?$/.exec(line);
    if (match) return ` (src/plan.js:${match[1]}:${match[2]})`;
  }
  return '';
}

function layerError(name, root, text, cause, stackOf = cause) {
  return new Error(hideKitPaths(`слой ${name}: ${text}${planFrame(stackOf)}`, root), { cause });
}

// Ошибка сборки называет реальный виновный файл слоя (layer.json/words.js/sfx-library.js/plan.js)
// по месту, которое нашёл esbuild (absWorkingDir делает location.file коротким, относительно слоя).
function explainBuildError(error, name, root) {
  const first = error.errors?.[0];
  const loc = first?.location;
  const text = !first ? `не собирается plan.js — ${error.message}`
    : !loc ? `не собирается plan.js — ${first.text}`
      : `не собирается ${path.basename(loc.file)} — ${loc.file}:${loc.line}:${loc.column}: ${first.text}`;
  return layerError(name, root, text, error, null);
}

function buildLayerManifest(layerDir) {
  const dir = path.resolve(layerDir);
  const name = path.basename(dir);
  for (const [file, hint] of LAYER_FILES) {
    if (!fs.existsSync(path.join(dir, file))) {
      throw new Error(`слой ${name}: нет ${file} (${hint})`);
    }
  }
  // esbuild сам разворачивает симлинки рабочей папки и считает пути metafile от её канонической
  // формы — поэтому сразу даём ему каноническую, и пути metafile разрешаются от того же корня.
  const root = canonicalPath(dir);
  const at = (file) => JSON.stringify(path.join(root, file));
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
  let result;
  try {
    result = bundle({ contents: entry, resolveDir: root }, {
      absWorkingDir: root,
      sourcemap: 'inline',
      metafile: true,
      // Пакеты не собираются, а остаются внешними: так запрещённый импорт называется по имени,
      // даже если пакет не установлен рядом со слоем. Kit подключается alias-ом и собирается.
      packages: 'external',
      // Рендер слоя идёт с пустым env-файлом — план не должен ветвиться по окружению машины.
      define: { 'process.env': '{}' },
    });
  } catch (error) {
    throw explainBuildError(error, name, root);
  }
  const violation = findPlanViolation(result.metafile, {
    root, kitRoot: KIT_ROOT, kitFiles: KIT_FILES,
    layerFiles: LAYER_FILES.map(([file]) => canonicalPath(path.join(root, file))),
  });
  if (violation) {
    throw new Error(hideKitPaths(`слой ${name}: ${violation.file} импортирует «${violation.spec}» — ${violation.reason}${violation.fixHint}`, root));
  }
  let mod;
  try {
    mod = evaluate(result.outputFiles[0].text, path.join(root, 'layer-manifest.js'));
  } catch (error) {
    throw layerError(name, root, `ошибка при загрузке файлов слоя — ${error?.message ?? String(error)}`, error);
  }
  const kitCore = loadKitCore();
  try {
    return kitCore.buildManifest(kitCore.compilePlan(mod.buildPlan, mod.ctx));
  } catch (error) {
    // compilePlan уже оборачивает провал самого buildPlan в понятный Error («src/plan.js упал при
    // построении плана — …»). А геттер в возвращённом объекте плана, который читает дальнейшая
    // компиляция (compileLayer), может бросить что угодно, не только Error, — это уже не «упал при
    // построении», а бросок уже после. Проверяем не instanceof Error, а наличие строкового message:
    // такой текст (у настоящего Error или у брошенного объекта со своим message) понятнее голого
    // значения — иначе отдельная человеческая фраза вместо невнятного «бросил [object Object] …».
    const text = typeof error?.message === 'string' ? error.message : `src/plan.js бросил ${String(error)} при компиляции плана`;
    throw layerError(name, root, text, error, error?.cause);
  }
}

module.exports = { buildLayerManifest, findPlanViolation, loadKitCore };
