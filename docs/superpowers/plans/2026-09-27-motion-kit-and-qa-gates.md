# Motion-kit и QA-гейты — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Новый motion-слой ролика собирается из готовых деталей движка (живая камера, карточки,
звуковая дорожка, вставки стока, скриншот-карточки, субтитры), а в пульт попадает только preview,
прошедший автоматические проверки ритма, звука, баланса голоса и музыки, safe-zone и длительности.

**Architecture:** Общая инфраструктура слоя живёт в движке как `src/motion-kit/` (ESM) и
подключается проектным слоем по имени `@automontage/motion-kit` (webpack alias в Remotion и alias
esbuild в Node). Слой описывает режиссуру одним чистым объектом `plan.js`; kit компилирует его в
дорожки по кадрам, по которым одновременно рендерится слой и строится манифест для гейтов. Гейты —
чистые функции в `scripts/qa/`, запускаются в трёх точках: `layer check` (по манифесту, секунды),
`layer render` (длина слоя, голос в звуке слоя) и внутри `preview` (баланс голоса и музыки по
настоящим дорожкам); стоп не даёт опубликовать preview.

**Tech Stack:** Node 20+ (CommonJS в `scripts/`, `node:test`), Remotion 4.0.504, React 19,
esbuild 0.28 (уже в зависимостях Remotion), ffmpeg/ffprobe.

**Исследование:** локальная заметка `knowledge/2026-09-27-motion-kit-research.md` (не в Git).

---

## Решения

Утверждаются владельцем вместе с планом. Рекомендуемый вариант отмечен ★.

| # | Вопрос | ★ Выбрано | Отклонено и почему |
|---|---|---|---|
| D1 | Где живёт kit | ★ `src/motion-kit/` внутри движка: одна версия Remotion, общие тесты, слои уже рендерятся из корня движка | отдельный npm-пакет — релизы и версии ради внутренней библиотеки одного движка |
| D2 | Как слой подключает kit | ★ Гибрид: инфраструктура импортом `@automontage/motion-kit`, а стартовые файлы ролика (`plan.js`, `scenes.jsx`, `Root.jsx`) копирует `layer new`. Гейты доверяют только kit, поэтому камеру и рамки нельзя «подправить» копией | полная копия kit в папку ролика — пять копий снова, исправления не доходят, гейт не может доверять таймлайну |
| D3 | Где работают гейты | ★ Три точки автоматически: `layer check` до рендера (секунды), `layer render` после рендера, `preview` перед публикацией | только внутри `preview` — ошибка ритма находится после 5 минут рендера слоя |
| D4 | Что при провале | ★ Объективные нарушения — стоп: preview не публикуется, прошлый остаётся в пульте. Вкусовые — предупреждение в отчёте. Исключение (`waivers`) только для G1, G4, G11 и только с причиной в плане слоя, видно в отчёте | только предупреждения — слабый preview снова попадает к владельцу |
| D5 | Громкость звуков слоя | ★ `masterDb` в `<SfxTrack>` (по умолчанию −5 dB = утверждённый уровень), схема brief не меняется | поле `brollMedia.audioGainDb` — правки схемы, Review (4 файла) и утверждённых brief |
| D6 | Звук слоя в контракте | Слой kit рендерится со звуком (`audioMode: "mix"`), в нём только эффекты; голос в звуке слоя ловит G7. Записать в DECISIONS, поправить `creative-motion.md` и `qa-checklist.md` (сейчас требуют `mute`) | — |
| D7 | Порог ритма | Стоп > 2,5 с, предупреждение > 2,2 с; джамп-кат засчитывается при скачке масштаба ≥ 15 % или сдвиге лица ≥ 85 px | — |
| D8 | Баланс голоса и музыки | Меряется по настоящим дорожкам внутри `preview` (голос после нормализации + музыка после sidechain), только на участках речи. Коридор профиля `avatar` калибруется по утверждённому эталонному preview (Task 50) | — |

## Глобальные ограничения

- Работа только в отдельном worktree на своей ветке. Основную папку и её ветку не трогать.
- Семь официальных сцен lesson и `src/scenes/*` не менять (кроме импорта констант safe-zone).
- В Git не попадают видео, звуки, музыка, скриншоты, аватары, личные пути, имена клиентских папок,
  ключи. Медиа для тестов генерируются во временной папке через lavfi.
- Каждое новое поведение начинается с падающего теста `node:test`. Перед коммитом:
  `node scripts/check-public-privacy.js --staged` и Gitleaks (pre-commit hook), без `--no-verify`.
- Полный рендер — только когда `layer render` (или внешняя проверка занятости) видит свободную машину.
- Нельзя вызывать API пульта, утверждать ролики, тратить HeyGen/ElevenLabs, запрашивать
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. `PEXELS_API_KEY` необязателен.
- Пути в коде — только относительные к проекту или `ROOT`; внешние процессы — `spawnSync`/`execFileSync`
  с массивом аргументов и `shell: false`.

## Контракт слоя

Один источник истины для рендера и гейтов. Все времена в `plan.js` — секунды исходника (глобальный
таймкод); kit переводит их в кадры.

```text
motion-vNN/
  layer.json          {version:1, composition, fps, width, height, durationInFrames,
                       face:{x,y}, profile:"avatar"|"live", sfxMasterDb:-5,
                       speaker:{src:"speaker.mp4", lastFrame}}
  spelling.json       {"cloudcode": "Claude Code", ...}  — написание для субтитров
  src/index.jsx       registerRoot + <Composition> из layer.json          (шаблон, копия)
  src/Root.jsx        собирает слой из деталей kit                        (шаблон, копия)
  src/plan.js         export default buildPlan(ctx) → LayerPlan           (шаблон, режиссура ролика)
  src/scenes.jsx      содержимое карточек ролика                          (шаблон, дизайн ролика)
  src/words.js        export default [{w,t,s,e}]                          (генерирует layer new/words)
  src/sfx-library.js  export default {sounds:{name:{file,lengthSec,peakSec,role,notable,volume,sha256}}}
  public/             speaker.mp4, fonts/, sfx/, stock/, shots/, SOURCE.md
  out/manifest.json   манифест для гейтов (пишет layer check)
  renders/            layer-NN.mp4 (пишет layer render)
```

```js
// LayerPlan — то, что возвращает buildPlan(ctx). ctx = {...layer.json, words, sfxLibrary}
{
  hook: 'speaker' | 'enumeration',
  camera: {
    face: {x, y},                       // точка лица в кадре исходника, px
    maxScale?: 1.25,
    presets?: {NAME: {s, dx?, dy?, fill?}},
    shots: [{at, preset, drift?: 'in'|'out'|'none', dx?, dy?}],   // первый at = 0; dx/dy — px кадра исходника
                                                                  // (dx/dy пресетов заданы для ширины 1080 и масштабируются)
    punches?: [{at, until, k?: 1.15}],
    blurs?: [{from, to, px?: 20}],      // from = 0 → размыто с первого кадра (хук)
    aways?: [{from, to}],
  },
  items: [{id, kind: 'text'|'card'|'media', at, until, box: {x, y, w, h}, rot?,
           enter?: {kind: 'pop'|'fly'|'mask'|'cut', from?: [dx, dy]},
           exit?: {frames?: 5, dir?: 'down'|'up'}, life?: {parallax?: 8}, bleed?,
           sfx?: string|{name, vol?, leadFrames?}|null,
           type?: {from, to, sfx?}, props?: {...}}],
  inserts?: [{id?, kind: 'stock'|'screen'|'donor'|'scene', from, to, src?, cover?, kb?: [1.03, 1.1], sfx?}],
                                        // cover по умолчанию true (кроме donor); cover-вставка не короче
                                        // close + exit + 1 кадра (0,68 с при 25 fps); kb — пара чисел ≥ 1;
                                        // stock рисует StockInsert, screen/scene — проект через FullscreenReveal
  sfx?: [{at, name, vol?, prio?}],       // звуки вне элементов
  captions?: false | {chunk?: {...}, lane?: {x, y, w, h}, hide?: [{from, to}]},  // hide: конечные from < to, с
  waivers?: [{gate: 'G1'|'G4'|'G11', reason}],
}
```

Манифест (`out/manifest.json`, пишет `buildManifest`):

```js
{version: 1, kitVersion, fps, width, height, durationInFrames, maxScale,
 camera: {s: [], requested: [], dx: [], dy: [], blur: [], opacity: []},   // по кадру
 texts: [{id, from, frames: [[l, t, r, b] | null]}  |  {id, from, until, static: [l, t, r, b]}],
                                        // субтитры: caption-<n>, после окна hide — caption-<n>b, caption-<n>c…
 inserts: [{id, kind, from, to, cover, src}],   // cover и src — с Task 22
 cues: {kept: [{id, name, startFrame, hitFrame, notable, bed}], dropped: [{id, conflictWith, reason}]},
 hook, waivers}
```

Отчёт гейтов (`<проект>/qa/<имя>.json` + `.txt`):

```js
{version: 1, kind: 'layer-check'|'layer-render'|'preview', layer?, profile, createdAt,
 inputs: [{path, sha256}], gates: [{id, title, status: 'pass'|'warn'|'fail'|'waived'|'skipped',
 value, threshold, unit, spans: [{fromSec, toSec, note}], hint}], summary: {status, fail, warn}, error?}
```

Коды выхода команд с гейтами: 0 — пройдено или только предупреждения; 1 — стоп; 2 — оценить нельзя.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `src/motion-kit/time.js` | секунды ↔ кадры |
| `src/motion-kit/words.js` | слова из транскрипта, написание, якоря |
| `src/motion-kit/safe.js` | прямоугольник safe-zone, выход за него |
| `src/motion-kit/camera.js` | пресеты, `compileCamera`, `cameraAt`, `autoShots` |
| `src/motion-kit/motion.js` | вход/жизнь/выход элементов, габариты по кадру, `typed` |
| `src/motion-kit/inserts.js` | вставки и уход аватара под них, карточка и кривые раскрытия/закрытия |
| `src/motion-kit/sfx.js` | звуковые события, выравнивание по пику, прореживание, громкость `cueVolume` |
| `src/motion-kit/captions.js` | нарезка субтитров, полоса, кадры видимости `captionSpans`, подгонка кегля |
| `src/motion-kit/screen.js` | прокрутка скриншота долей страницы, вспышка затвора, цвета окна браузера |
| `src/motion-kit/compile.js` | `compileLayer`, `compileItems`, `KIT_VERSION` |
| `src/motion-kit/manifest.js` | `buildManifest` |
| `src/motion-kit/core.js` | реэкспорт только чистых модулей (для Node и `plan.js`) |
| `src/motion-kit/index.js` | `core` + React-компоненты |
| `src/motion-kit/SpeakerLayer.jsx` | аватар: один `OffthreadVideo muted`, камера, `Freeze`, заливка краёв |
| `src/motion-kit/KitBox.jsx` | позиция и анимация элемента, `data-kit-text` |
| `src/motion-kit/Inserts.jsx` | `FullscreenReveal`, `StockInsert` |
| `src/motion-kit/Screen.jsx` | `BrowserFrame`, `ScrollShot`, `ShutterFlash` |
| `src/motion-kit/SfxTrack.jsx` | звуковая дорожка |
| `src/motion-kit/Subtitles.jsx` | субтитры с караоке в одну строку с подгонкой кегля |
| `src/motion-kit/FontLoader.jsx` | гейт шрифтов: оборачивает слой, держит `delayRender` до загрузки |
| `scripts/remotion-webpack.js` | + alias `@automontage/motion-kit` |
| `scripts/motion-kit-node.js` | загрузка kit и слоя в Node через esbuild |
| `scripts/qa/*.js` | профили, события камеры, гейты, аудио, отчёт |
| `scripts/layer/*.js` | команды `automontage layer …` |
| `scripts/mix-music.js` | + режим `stem: 'music'` для замера |
| `scripts/preview.js` | + гейты перед публикацией |
| `scripts/review/media-import.js` | + `-threads 1` для VP8-прокси |
| `scripts/build-commands.js` | + `remotionLayerRenderCommand` |
| `scripts/cli.js` | + подкоманда `layer` |
| `templates/motion-layer/` | стартовые файлы слоя |
| `docs/MOTION-KIT.md` | как собирать слой из kit, API, гейты |
| `skills/reel-turnkey/references/motion-layer-brief.md` | единое задание субагенту слоя |

## Фаза 0. Рабочее место

### Task 0: Базовая линия worktree

**Files:** нет изменений в Git.

- [ ] **Step 1: Проверить ветку и зависимости**

Run: `git branch --show-current && npm ci`
Expected: ветка задачи, установка без ошибок.

- [ ] **Step 2: Дать Remotion браузер без сети**

Если в `node_modules/.remotion/chrome-headless-shell/` нет `mac-arm64`/`linux64`, скопировать эту папку
из основной установки движка (иначе тест `media-duration-geometry` пытается скачать браузер и падает
по таймауту — это окружение, а не код).

- [ ] **Step 3: Прогнать тесты**

Run: `npm test`
Expected: `fail 0`. Зафиксировать число тестов в журнале задачи.

## Фаза 1. Основа kit

### Task 1: Alias `@automontage/motion-kit` и загрузчик ESM для тестов

**Files:**
- Modify: `scripts/remotion-webpack.js`
- Modify: `remotion.config.js`
- Create: `tests/helpers/load-esm.js`
- Create: `src/motion-kit/time.js`, `src/motion-kit/core.js`, `src/motion-kit/index.js`
- Test: `tests/motion-kit-alias.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-alias.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { withMotionKitAlias, MOTION_KIT_ALIAS } = require('../scripts/remotion-webpack');
const { loadEsm } = require('./helpers/load-esm');

test('webpack config resolves @automontage/motion-kit to the engine kit directory', () => {
  const config = withMotionKitAlias({ resolve: { alias: { react: 'x' } }, module: { rules: [] } });
  assert.equal(MOTION_KIT_ALIAS, '@automontage/motion-kit');
  assert.equal(config.resolve.alias.react, 'x');
  assert.equal(config.resolve.alias[MOTION_KIT_ALIAS], path.join(__dirname, '..', 'src', 'motion-kit'));
});

test('kit core converts seconds to frames on the frame grid', () => {
  const { secToFrame, frameToSec } = loadEsm('src/motion-kit/core.js');
  assert.equal(secToFrame(1.5, 25), 38);
  assert.equal(secToFrame(0.04, 25), 1);
  assert.equal(frameToSec(50, 25), 2);
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test tests/motion-kit-alias.test.js`
Expected: FAIL — `withMotionKitAlias is not a function`, `Cannot find module './helpers/load-esm'`.

- [ ] **Step 3: Реализовать**

```js
// tests/helpers/load-esm.js
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');

// Собирает ESM/JSX-модуль движка в CommonJS и выполняет его. stubs подменяют модули
// (например, 'remotion' с useCurrentFrame), остальное грузится обычным require.
function loadEsm(relativeFile, { stubs = {} } = {}) {
  const filename = path.join(ROOT, relativeFile);
  const text = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server', 'remotion'],
    alias: { '@automontage/motion-kit': path.join(ROOT, 'src', 'motion-kit') },
    logLevel: 'silent',
  }).outputFiles[0].text;
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (Object.hasOwn(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const compiled = new Module(filename, module);
    compiled.filename = filename;
    compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(text, filename);
    return compiled.exports;
  } finally {
    Module._load = originalLoad;
  }
}

module.exports = { ROOT, loadEsm };
```

В `scripts/remotion-webpack.js` добавить перед `module.exports`:

```js
const MOTION_KIT_ALIAS = '@automontage/motion-kit';
const MOTION_KIT_DIR = path.join(__dirname, '..', 'src', 'motion-kit');

// Проектные motion-слои импортируют общие детали по стабильному имени, где бы ни лежал слой.
// Remotion CLI выполняет remotion.config.js из своей папки (там __dirname неверен), поэтому
// конфиг передаёт каталог kit от process.cwd(); MOTION_KIT_DIR — для обычного Node.
function withMotionKitAlias(config, kitDirectory = MOTION_KIT_DIR) {
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: { ...(config.resolve?.alias || {}), [MOTION_KIT_ALIAS]: kitDirectory },
    },
  };
}
```

Регрессионный тест `tests/motion-kit-remotion-alias.test.js`: настоящий `loadConfigFile` Remotion → `bundle`
файла вне `src/`, который импортирует `@automontage/motion-kit` и `@automontage/motion-kit/core`.

и заменить экспорт на `module.exports = { MOTION_KIT_ALIAS, MOTION_KIT_DIR, includeInstalledSource, withMotionKitAlias };`.

В `remotion.config.js`:

```js
const { includeInstalledSource, withMotionKitAlias } = require('./scripts/remotion-webpack');
// ...
Config.overrideWebpackConfig(config => withMotionKitAlias(
  includeInstalledSource(config, sourceDirectory), path.join(sourceDirectory, 'motion-kit'),
));
```

```js
// src/motion-kit/time.js
export const secToFrame = (sec, fps) => Math.round(sec * fps + 1e-6);
export const frameToSec = (frame, fps) => frame / fps;
// Длительность, заданная в кадрах эталонных 25 fps, в кадрах композиции (добавлено при проверке Task 4–6).
export const ref25 = (frames, fps) => Math.max(1, Math.round((frames * fps) / 25));
```

```js
// src/motion-kit/core.js — только чистые модули: без React, можно грузить в Node
export * from './time.js';
```

```js
// src/motion-kit/index.js — всё для Root.jsx слоя
export * from './core.js';
```

- [ ] **Step 4: Запустить тест**

Run: `node --test tests/motion-kit-alias.test.js tests/remotion-package.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add scripts/remotion-webpack.js remotion.config.js tests/helpers/load-esm.js tests/motion-kit-alias.test.js src/motion-kit/
git commit -m "feat: add motion-kit alias for project motion layers"
```

### Task 2: Слова и якоря

**Files:**
- Create: `src/motion-kit/words.js`
- Modify: `src/motion-kit/core.js`
- Test: `tests/motion-kit-words.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-words.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');
const segments = [{ words: [
  { w: ' Знаешь,', s: 0, e: 0.28 }, { w: ' CloudCode', s: 0.3, e: 0.9 },
  { w: ' ёлка', s: 1.0, e: 1.3 }, { w: ' знаешь', s: 3.0, e: 3.3 }, { w: ' ', s: 3.4, e: 3.5 },
] }];

test('flattenTranscript trims words, applies spelling and keeps trailing punctuation', () => {
  const words = kit.flattenTranscript(segments, { spelling: { cloudcode: 'Claude Code', 'знаешь': 'Знаешь' } });
  assert.deepEqual(words.map((w) => [w.w, w.t]), [
    ['Знаешь,', 'Знаешь,'], ['CloudCode', 'Claude Code'], ['ёлка', 'ёлка'], ['знаешь', 'Знаешь'],
  ]);
  assert.equal(kit.normWord(' Ёлка!'), 'елка');
});

test('anchors walk forward, honour near, and free anchors do not move the cursor', () => {
  const words = kit.flattenTranscript(segments);
  const a = kit.makeAnchors(words);
  assert.equal(a.at('знаешь', { free: true }), 0);
  assert.equal(a.at('знаешь'), 0);
  assert.equal(a.at('знаешь'), 3.0);
  const b = kit.makeAnchors(words);
  assert.equal(b.at('знаешь', { near: 3.1 }), 3.0);
  assert.throws(() => b.at('ёлка'), /не найден после слова №4/);
  const c = kit.makeAnchors(words);
  assert.equal(c.at('ёлка', { edge: 'end', d: 0.1 }), 1.4);
});

test('missing anchor names the word and the cursor', () => {
  const a = kit.makeAnchors(kit.flattenTranscript(segments));
  a.at('ёлка');
  assert.throws(() => a.at('CloudCode'), /якорь «CloudCode» не найден после слова №3/);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-words.test.js`
Expected: FAIL — `kit.flattenTranscript is not a function`.

- [ ] **Step 3: Реализовать**

```js
// src/motion-kit/words.js
const TAIL = /[.,!?…:;»"]+$/u;

export function normWord(value) {
  return String(value ?? '').trim().toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}%+#]/gu, '');
}

// transcript/words.json движка: [{start, end, text, words: [{w, s, e}]}] → [{w, t, s, e}]
// w — как услышал Whisper (по нему ищутся якоря), t — написание на экране.
export function flattenTranscript(segments, { spelling = {} } = {}) {
  if (!Array.isArray(segments)) throw new Error('transcript: ожидается массив сегментов');
  const words = [];
  for (const segment of segments) {
    for (const word of segment.words || []) {
      const w = String(word.w ?? '').trim();
      if (!normWord(w) || !Number.isFinite(word.s) || !Number.isFinite(word.e)) continue;
      const key = normWord(w);
      const tail = w.match(TAIL)?.[0] || '';
      const t = Object.hasOwn(spelling, key) ? `${spelling[key]}${tail}` : w;
      words.push({ w, t, s: word.s, e: Math.max(word.s, word.e) });
    }
  }
  return words.sort((a, b) => a.s - b.s);
}

// Один канон якорей: монотонный курсор (переживает повторы слов) + необязательная
// страховка near (слово должно быть в пределах tolerance секунд от подсказки).
export function makeAnchors(words, { tolerance = 1.2 } = {}) {
  let cursor = 0;
  const matches = (word, key) => {
    const n = normWord(word.w);
    // Короткий ключ («это») по началу слова цеплял бы «этот» и сдвигал курсор — только точно.
    return n === key || (key.length >= 4 && n.startsWith(key));
  };
  function locate(spec, near) {
    const key = normWord(spec);
    if (!key) throw new Error(`якорь «${spec}» пустой`);
    for (let i = cursor; i < words.length; i += 1) {
      if (!matches(words[i], key)) continue;
      if (near !== null && Math.abs(words[i].s - near) > tolerance) {
        if (words[i].s > near + tolerance) break;
        continue;
      }
      return i;
    }
    const where = near === null ? '' : ` около ${near} с`;
    throw new Error(`якорь «${spec}» не найден после слова №${cursor}${where}`);
  }
  return {
    at(spec, { near = null, d = 0, edge = 'start', free = false } = {}) {
      const index = locate(spec, near);
      if (!free) cursor = index + 1;
      const word = words[index];
      return Number(((edge === 'end' ? word.e : word.s) + d).toFixed(3));
    },
    index: () => cursor,
    reset(index = 0) { cursor = index; },
  };
}
```

`core.js`: добавить `export * from './words.js';`.

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-words.test.js`
Expected: PASS (3 теста).

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/words.js src/motion-kit/core.js tests/motion-kit-words.test.js
git commit -m "feat: add motion-kit word anchors"
```

### Task 3: Safe-zone kit

**Files:**
- Create: `src/motion-kit/safe.js`
- Create: `scripts/qa/safe-rect.js`
- Modify: `src/motion-kit/core.js`
- Test: `tests/motion-kit-safe.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-safe.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');
const { safeRect: cjsSafeRect, overflow: cjsOverflow } = require('../scripts/qa/safe-rect');

const kit = loadEsm('src/motion-kit/core.js');

test('portrait safe rect equals the owner rule 70/130/250/420 on 1080x1920', () => {
  assert.deepEqual(kit.safeRect(1080, 1920), { left: 70, top: 250, right: 950, bottom: 1500 });
  assert.deepEqual(kit.safeRect(720, 1280), { left: 70 * 720 / 1080, top: 250 * 720 / 1080, right: 720 - 130 * 720 / 1080, bottom: 1280 - 420 * 720 / 1080 });
});

test('node and kit safe rects stay identical', () => {
  for (const [w, h] of [[1080, 1920], [720, 1280], [1920, 1080]]) {
    assert.deepEqual(cjsSafeRect(w, h), kit.safeRect(w, h));
  }
});

test('overflow reports only the sides that leave the safe rect', () => {
  const safe = kit.safeRect(1080, 1920);
  assert.equal(kit.overflow({ left: 90, top: 300, right: 900, bottom: 400 }, safe), null);
  assert.deepEqual(kit.overflow({ left: 40, top: 300, right: 980, bottom: 400 }, safe), { left: 30, right: 30 });
  assert.deepEqual(cjsOverflow({ left: 40, top: 300, right: 980, bottom: 400 }, safe), { left: 30, right: 30 });
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-safe.test.js`
Expected: FAIL — `Cannot find module '../scripts/qa/safe-rect'`.

- [ ] **Step 3: Реализовать**

```js
// src/motion-kit/safe.js
import { SAFE_16x9, SAFE_9x16 } from '../scenes/safezone.js';

// Прямоугольник, внутри которого должен оставаться текст на КАЖДОМ кадре.
export function safeRect(width, height) {
  const portrait = height > width;
  const base = portrait ? SAFE_9x16 : SAFE_16x9;
  const k = width / (portrait ? 1080 : 1920);
  return { left: base.left * k, top: base.top * k, right: width - base.right * k, bottom: height - base.bottom * k };
}

export function overflow(rect, safe, epsilon = 0.5) {
  const sides = {
    left: safe.left - rect.left, top: safe.top - rect.top,
    right: rect.right - safe.right, bottom: rect.bottom - safe.bottom,
  };
  const out = Object.entries(sides).filter(([, value]) => value > epsilon);
  return out.length ? Object.fromEntries(out.map(([side, value]) => [side, Math.round(value)])) : null;
}
```

```js
// scripts/qa/safe-rect.js — те же числа для CommonJS-гейтов; равенство закреплено тестом
const SAFE_9x16 = { top: 250, bottom: 420, left: 70, right: 130 };
const SAFE_16x9 = { top: 60, bottom: 60, left: 80, right: 80 };

function safeRect(width, height) {
  const portrait = height > width;
  const base = portrait ? SAFE_9x16 : SAFE_16x9;
  const k = width / (portrait ? 1080 : 1920);
  return { left: base.left * k, top: base.top * k, right: width - base.right * k, bottom: height - base.bottom * k };
}

function overflow(rect, safe, epsilon = 0.5) {
  const sides = {
    left: safe.left - rect.left, top: safe.top - rect.top,
    right: rect.right - safe.right, bottom: rect.bottom - safe.bottom,
  };
  const out = Object.entries(sides).filter(([, value]) => value > epsilon);
  return out.length ? Object.fromEntries(out.map(([side, value]) => [side, Math.round(value)])) : null;
}

module.exports = { overflow, safeRect };
```

`core.js`: добавить `export * from './safe.js';`.

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-safe.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/safe.js src/motion-kit/core.js scripts/qa/safe-rect.js tests/motion-kit-safe.test.js
git commit -m "feat: add motion-kit safe-zone rectangle"
```

## Фаза 2. Живая камера

Пресеты подобраны так, чтобы любая смена плана была заметной (≥ 15 % масштаба или ≥ 85 px сдвига
лица): W 1,00 (наезд до 1,05), M 1,18 (отъезд с 1,239), L/R 1,12 со сдвигом ±170 px и заливкой краёв.
Панч-ины ставить на общем плане W: на M пределом 1,25 панч «съедается» (G3 предупредит).

### Task 4: Пресеты, планы и дрейф

**Files:**
- Create: `src/motion-kit/camera.js`
- Modify: `src/motion-kit/core.js`
- Test: `tests/motion-kit-camera.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-camera.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');
const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250 };
const face = { x: 540, y: 787 };

test('compileCamera converts shots to frames and closes each shot at the next one', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'M', drift: 'out' }] }, cfg);
  assert.deepEqual(track.shots.map((s) => [s.from, s.to, s.preset, s.drift]), [[0, 50, 'W', 'in'], [50, 250, 'M', 'out']]);
});

test('compileCamera rejects a missing face, an unknown preset and a late first shot', () => {
  assert.throws(() => kit.compileCamera({ shots: [{ at: 0, preset: 'W' }] }, cfg), /camera\.face/);
  assert.throws(() => kit.compileCamera({ face, shots: [{ at: 0, preset: 'XL' }] }, cfg), /неизвестный пресет «XL»/);
  assert.throws(() => kit.compileCamera({ face, shots: [{ at: 1, preset: 'W' }] }, cfg), /первый план/);
});

test('drift grows W slowly and a W→M cut is a visible jump', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'M', drift: 'out' }] }, cfg);
  const start = kit.cameraAt(track, 0);
  const beforeCut = kit.cameraAt(track, 49);
  const afterCut = kit.cameraAt(track, 50);
  assert.equal(start.s, 1);
  assert.ok(beforeCut.s > 1.01 && beforeCut.s <= 1.05 + 1e-9);
  assert.ok(afterCut.s / beforeCut.s >= 1.15, `jump ${afterCut.s / beforeCut.s}`);
  assert.ok(Math.abs(kit.cameraAt(track, 1).s - start.s) < 0.002, 'drift must not jump between frames');
});

test('without fill the speaker never reveals the frame edge', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W', dx: 300 }] }, cfg);
  for (const frame of [0, 40, 120, 249]) {
    const c = kit.cameraAt(track, frame);
    assert.ok(c.dx <= (c.s - 1) * face.x + 1e-9);
    assert.ok(c.dx >= -(c.s - 1) * (1080 - face.x) - 1e-9);
  }
});

test('side presets shift the face by at least 85 px and use a fill layer', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'L' }] }, cfg);
  const w = kit.cameraAt(track, 49);
  const l = kit.cameraAt(track, 50);
  assert.equal(l.fill, true);
  assert.ok(Math.abs(l.dx - w.dx) >= 85);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-camera.test.js`
Expected: FAIL — `kit.compileCamera is not a function`.

- [ ] **Step 3: Реализовать**

```js
// src/motion-kit/camera.js
import { Easing, interpolate, spring } from 'remotion';
import { secToFrame } from './time.js';

export const DEFAULT_PRESETS = Object.freeze({
  W: { s: 1.0 },
  M: { s: 1.18 },
  L: { s: 1.12, dx: -170, fill: true },
  R: { s: 1.12, dx: 170, fill: true },
  top: { s: 1.0, dy: 380, fill: true },
});

export const CAMERA_DEFAULTS = Object.freeze({
  maxScale: 1.25,
  drift: { amp: 0.05, maxFrames: 150 },
  sway: [{ px: 22, period: 38 }, { px: 14, period: 97 }],
  punch: { damping: 14, stiffness: 180, mass: 0.6, releaseFrames: 10, k: 1.15 },
  blur: { px: 20, inFrames: 6, outFrames: 10, dimAt: 24, dim: 0.28 },
  away: { enterFrames: 8, exitFrames: 10, blurPx: 26 },
});

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
const DRIFT = Easing.bezier(0.45, 0, 0.55, 1);
const ramp = (frame, from, len) => (len <= 0 ? (frame >= from ? 1 : 0) : interpolate(frame, [from, from + len], [0, 1], CLAMP));

export function compileCamera(spec, { fps, width, height, durationInFrames }) {
  if (!spec?.face || !Number.isFinite(spec.face.x) || !Number.isFinite(spec.face.y)) {
    throw new Error('camera.face {x, y} обязателен: точка лица в кадре исходника, px');
  }
  // Пресеты и покачивание заданы для кадра шириной 1080 (короткая сторона) — масштабируем под исходник.
  const k = Math.min(width, height) / 1080;
  const presets = Object.fromEntries(Object.entries({ ...DEFAULT_PRESETS, ...(spec.presets || {}) })
    .map(([name, p]) => [name, { ...p, ...(p.dx !== undefined ? { dx: p.dx * k } : {}), ...(p.dy !== undefined ? { dy: p.dy * k } : {}) }]));
  const f = (sec) => secToFrame(sec, fps);
  const shots = [...(spec.shots || [])].sort((a, b) => a.at - b.at).map((shot, index) => {
    if (!presets[shot.preset]) throw new Error(`camera.shots[${index}]: неизвестный пресет «${shot.preset}»`);
    return { index, from: f(shot.at), preset: shot.preset, drift: shot.drift || 'in', dx: shot.dx, dy: shot.dy };
  });
  if (!shots.length || shots[0].from !== 0) throw new Error('camera.shots: первый план должен начинаться с 0 с');
  shots.forEach((shot, i) => { shot.to = i + 1 < shots.length ? shots[i + 1].from : durationInFrames; });
  return {
    fps, width, height, durationInFrames, k,
    face: { ...spec.face },
    maxScale: spec.maxScale ?? CAMERA_DEFAULTS.maxScale,
    presets,
    shots,
    punches: (spec.punches || []).map((p) => ({ from: f(p.at), until: f(p.until ?? p.at + 1), k: p.k ?? CAMERA_DEFAULTS.punch.k })),
    blurs: (spec.blurs || []).map((b) => ({ from: f(b.from), to: f(b.to), px: b.px ?? CAMERA_DEFAULTS.blur.px })),
    aways: (spec.aways || []).map((a) => ({ from: f(a.from), to: f(a.to) })),
  };
}

// Уходы в кадрах (например, из полноэкранных вставок) добавляются к уже скомпилированной камере.
export function withAways(track, aways) {
  return { ...track, aways: [...track.aways, ...aways] };
}

export function cameraAt(track, frame) {
  const cfg = CAMERA_DEFAULTS;
  const shot = track.shots.reduce((current, s) => (s.from <= frame ? s : current), track.shots[0]);
  const preset = track.presets[shot.preset];
  const span = Math.max(1, Math.min(shot.to - shot.from, cfg.drift.maxFrames));
  const p = DRIFT(Math.min(1, Math.max(0, (frame - shot.from) / span)));
  const grow = shot.drift === 'in' ? p : shot.drift === 'out' ? 1 - p : 0;
  let s = preset.s * (1 + cfg.drift.amp * grow);

  for (const punch of track.punches) {
    if (frame < punch.from) continue;
    const on = spring({
      frame: frame - punch.from, fps: track.fps,
      config: { damping: cfg.punch.damping, stiffness: cfg.punch.stiffness, mass: cfg.punch.mass },
    });
    const off = ramp(frame, punch.until, cfg.punch.releaseFrames);
    s *= 1 + (punch.k - 1) * on * (1 - off);
  }

  let blur = 0;
  for (const b of track.blurs) {
    if (frame < b.from) continue;
    const inV = b.from === 0 ? 1 : ramp(frame, b.from, cfg.blur.inFrames);
    const outV = 1 - ramp(frame, b.to, cfg.blur.outFrames);
    blur = Math.max(blur, b.px * Math.min(inV, outV));
  }

  let gone = 0;
  for (const a of track.aways) {
    gone = Math.max(gone, ramp(frame, a.from, cfg.away.enterFrames) * (1 - ramp(frame, a.to, cfg.away.exitFrames)));
  }
  blur = Math.max(blur, cfg.away.blurPx * gone);

  const requested = s;
  s = Math.min(s, track.maxScale);
  const sway = cfg.sway.reduce((sum, w) => sum + w.px * track.k * Math.sin(frame / w.period), 0);
  let dx = (shot.dx ?? preset.dx ?? 0) + sway;
  let dy = shot.dy ?? preset.dy ?? 0;
  if (!preset.fill) {
    dx = Math.min((s - 1) * track.face.x, Math.max(-(s - 1) * (track.width - track.face.x), dx));
    dy = Math.min((s - 1) * track.face.y, Math.max(-(s - 1) * (track.height - track.face.y), dy));
  }
  const dim = 1 - (cfg.blur.dim * Math.min(blur, cfg.blur.dimAt)) / cfg.blur.dimAt;
  const opacity = 1 - gone;
  return { s, requested, dx, dy, blur, dim, opacity, visible: opacity > 0.01, shot: shot.index, fill: Boolean(preset.fill) };
}
```

`core.js`: добавить `export * from './camera.js';`.

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-camera.test.js`
Expected: PASS (5 тестов).

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/camera.js src/motion-kit/core.js tests/motion-kit-camera.test.js
git commit -m "feat: add motion-kit camera shots and drift"
```

### Task 5: Панч-ины, размытие, уход аватара

**Files:**
- Test: `tests/motion-kit-camera.test.js` (дописать)

Код уже есть в Task 4; здесь закрепляем поведение тестами (если тест упадёт — чинить `camera.js`).

- [ ] **Step 1: Дописать тесты**

```js
test('punch rises within six frames, holds until `until`, and never exceeds maxScale', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W', drift: 'none' }],
    punches: [{ at: 1, until: 3, k: 1.15 }] }, cfg);
  assert.equal(kit.cameraAt(track, 24).s, 1);
  assert.ok(kit.cameraAt(track, 31).s >= 1.08);
  assert.ok(Math.abs(kit.cameraAt(track, 70).s - 1.15) < 0.01);
  assert.ok(Math.abs(kit.cameraAt(track, 90).s - 1) < 1e-6);
  const capped = kit.compileCamera({ face, shots: [{ at: 0, preset: 'M', drift: 'none' }], punches: [{ at: 0, until: 5, k: 1.15 }] }, cfg);
  const c = kit.cameraAt(capped, 20);
  assert.equal(c.s, 1.25);
  assert.ok(c.requested > 1.3);
});

test('blur from 0 starts sharp-free, ramps out, and dims the speaker', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }], blurs: [{ from: 0, to: 1, px: 24 }] }, cfg);
  assert.equal(kit.cameraAt(track, 0).blur, 24);
  assert.ok(Math.abs(kit.cameraAt(track, 0).dim - 0.72) < 1e-9);
  assert.equal(kit.cameraAt(track, 40).blur, 0);
});

test('away hides the speaker after the enter ramp and brings it back', () => {
  const track = kit.withAways(kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }] }, cfg), [{ from: 50, to: 100 }]);
  assert.equal(kit.cameraAt(track, 49).visible, true);
  assert.equal(kit.cameraAt(track, 60).visible, false);
  assert.equal(kit.cameraAt(track, 115).visible, true);
  assert.equal(kit.cameraAt(track, 60).s <= 1.25, true);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-camera.test.js`
Expected: PASS (8 тестов).

- [ ] **Step 3: Коммит**

```bash
git add tests/motion-kit-camera.test.js
git commit -m "test: pin motion-kit punches, blur and away behaviour"
```

### Task 6: Автоматическая раскадровка `autoShots`

Стартовая режиссура для любого ролика: смена плана на границе слова, обычно каждые 1,2–2,2 с, по кругу
W → M → W → L → W → R. Агент потом правит планы вручную; гейт G1 проверяет результат.

> **Итог после проверки (коммиты c4a8b81, eb2425b, d501fcb):** код ниже — исходная версия. В
> `src/motion-kit/camera.js` `autoShots` гарантирует план ≤ `maxSec` везде: срочный рез при
> `since ≥ minSec/2`, тишина в начале, паузах и хвосте делится поровну, рез ближе `minSec` к концу не
> ставится, неверные `words`/`maxSec`/`minSec`/`cycle` дают понятную ошибку. Рампы камеры (дрейф 150,
> отпуск панча 10, размытие 6/10, уход 8/10 кадров) и период покачивания заданы для 25 fps и
> пересчитываются через `ref25(frames, fps)` из `time.js`; в ошибке пресета — исходный индекс плана.
> Источник истины — код и `tests/motion-kit-camera.test.js`.

**Files:**
- Modify: `src/motion-kit/camera.js`
- Test: `tests/motion-kit-camera.test.js` (дописать)

- [ ] **Step 1: Дописать тест**

```js
test('autoShots cuts on word ends, keeps every shot within 2.2 s and alternates presets', () => {
  const words = Array.from({ length: 40 }, (_, i) => ({ w: `слово${i}`, t: i % 7 === 6 ? `слово${i}.` : `слово${i}`, s: i * 0.5, e: i * 0.5 + 0.4 }));
  const shots = kit.autoShots(words, { endSec: 20.8 });
  assert.equal(shots[0].at, 0);
  const bounds = [...shots.map((s) => s.at), 20.8];
  for (let i = 1; i < bounds.length; i += 1) assert.ok(bounds[i] - bounds[i - 1] <= 2.2 + 1e-9, `shot ${i} ${bounds[i] - bounds[i - 1]}`);
  for (const shot of shots.slice(1)) assert.ok(words.some((w) => Math.abs(w.e - shot.at) < 1e-9));
  assert.deepEqual(shots.slice(0, 6).map((s) => s.preset), ['W', 'M', 'W', 'L', 'W', 'R']);
  assert.ok(shots.every((s) => s.drift === (s.preset === 'W' ? 'in' : 'out')));
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-camera.test.js`
Expected: FAIL — `kit.autoShots is not a function`.

- [ ] **Step 3: Реализовать (в конец `camera.js`)**

```js
const PUNCT = /[.,!?…:;]$/u;

// Раскадровка по словам: план не длиннее maxSec, режем по концу слова, по возможности на знаке препинания.
export function autoShots(words, { endSec, maxSec = 2.2, minSec = 1.2, cycle = ['W', 'M', 'W', 'L', 'W', 'R'] } = {}) {
  const drift = (preset) => (preset === 'W' ? 'in' : 'out');
  const shots = [{ at: 0, preset: cycle[0], drift: drift(cycle[0]) }];
  let last = 0;
  let k = 1;
  const end = Number.isFinite(endSec) ? endSec : (words.at(-1)?.e ?? 0);
  for (let i = 0; i < words.length; i += 1) {
    const cut = words[i].e;
    const next = i + 1 < words.length ? words[i + 1].e : end;
    const since = cut - last;
    if (since >= minSec && (PUNCT.test(words[i].t ?? words[i].w) || next - last > maxSec)) {
      const preset = cycle[k % cycle.length];
      shots.push({ at: Number(cut.toFixed(3)), preset, drift: drift(preset) });
      last = cut;
      k += 1;
    }
  }
  return shots;
}
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-camera.test.js`
Expected: PASS (9 тестов).

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/camera.js tests/motion-kit-camera.test.js
git commit -m "feat: add word-based auto shots to motion-kit camera"
```

## Фаза 3. Элементы, вставки, звук, субтитры (чистые функции)

### Task 7: Вход, жизнь, выход элемента и его габарит на каждом кадре

Габарит считается той же функцией `animOf`, по которой рисует `KitBox`, поэтому гейт safe-zone видит
ровно то, что будет в кадре, включая перелёт пружины и влёт со стороны.

**Files:**
- Create: `src/motion-kit/motion.js`
- Modify: `src/motion-kit/core.js`
- Test: `tests/motion-kit-motion.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-motion.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');
const box = { x: 100, y: 300, w: 400, h: 100 };

test('element is invisible outside its window and fully settled in the middle', () => {
  const item = { id: 't', kind: 'text', from: 10, until: 60, box };
  assert.equal(kit.animOf(item, 9, 25).o, 0);
  assert.equal(kit.animOf(item, 60, 25).o, 0);
  const mid = kit.animOf(item, 35, 25);
  assert.ok(Math.abs(mid.s - 1) < 0.01 && mid.o === 1 && mid.blur < 0.01);
  assert.equal(kit.itemExtentAt(item, 9, 25), null);
});

test('a side fly-in leaves the safe zone on its first visible frames only', () => {
  const item = { id: 't', kind: 'text', from: 10, until: 60, box, enter: { kind: 'fly', from: [-200, 0] } };
  assert.equal(kit.itemExtentAt(item, 10, 25), null);
  assert.ok(kit.itemExtentAt(item, 11, 25).left < 70);
  assert.ok(kit.itemExtentAt(item, 40, 25).left > 95);
});

test('pop overshoots above scale 1, so extents must be measured per frame', () => {
  const item = { id: 'p', kind: 'text', from: 0, until: 50, box, enter: { kind: 'pop' } };
  const peak = Math.max(...Array.from({ length: 20 }, (_, f) => kit.animOf(item, f, 25).s));
  assert.ok(peak > 1.05, `peak ${peak}`);
});

test('exit fades, shrinks and moves in the declared direction', () => {
  const down = { id: 'd', kind: 'card', from: 0, until: 60, box, exit: { frames: 5, dir: 'down' } };
  const up = { ...down, exit: { frames: 5, dir: 'up' } };
  assert.ok(kit.animOf(down, 59, 25).o < 0.5);
  assert.ok(kit.animOf(down, 59, 25).dy > kit.animOf(up, 59, 25).dy + 10);
});

test('unknown enter kind is rejected with the element id', () => {
  assert.throws(() => kit.animOf({ id: 'x', from: 0, until: 10, box, enter: { kind: 'spin' } }, 1, 25), /item x: неизвестный вход «spin»/);
});

test('typed reveals characters monotonically and completes on time', () => {
  const lengths = Array.from({ length: 12 }, (_, f) => kit.typed('Привет, мир', f, 0, 10).length);
  assert.equal(lengths[0], 0);
  assert.equal(lengths[10], 'Привет, мир'.length);
  for (let i = 1; i < lengths.length; i += 1) assert.ok(lengths[i] >= lengths[i - 1]);
  assert.equal(kit.typed('abc', 5, 0, 10), kit.typed('abc', 5, 0, 10));
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-motion.test.js`
Expected: FAIL — `kit.animOf is not a function`.

- [ ] **Step 3: Реализовать**

```js
// src/motion-kit/motion.js
import { Easing, interpolate, spring } from 'remotion';
import { ref25 } from './time.js';

export const EASE = Object.freeze({ out: Easing.bezier(0.16, 1, 0.3, 1), inOut: Easing.bezier(0.65, 0, 0.35, 1) });
const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
export const prog = (frame, at, len, easing = EASE.out) => (
  len <= 0 ? (frame >= at ? 1 : 0) : interpolate(frame, [at, at + len], [0, 1], { ...CLAMP, easing })
);
export const SPRINGS = Object.freeze({
  pop: { damping: 12, stiffness: 200, mass: 0.7 },
  fly: { damping: 16, stiffness: 160, mass: 0.8 },
});

// Состояние элемента в кадре: прозрачность, масштаб, сдвиг, поворот, размытие, маска.
export function animOf(item, frame, fps) {
  const out = { o: 1, s: 1, dx: 0, dy: 0, rot: item.rot || 0, blur: 0, clip: null };
  const enter = item.enter || { kind: 'fly' };
  if (!['pop', 'fly', 'mask', 'cut'].includes(enter.kind)) {
    throw new Error(`item ${item.id}: неизвестный вход «${enter.kind}»`);
  }
  if (frame < item.from || frame >= item.until) return { ...out, o: 0 };
  const f = frame - item.from;
  const len = item.until - item.from;
  // Длительности заданы в кадрах эталонных 25 fps и пересчитываются под fps композиции.
  const r = (frames) => ref25(frames, fps);
  if (enter.kind === 'pop') {
    const sp = spring({ frame: f, fps, config: SPRINGS.pop });
    out.s = 0.5 + 0.5 * sp;
    out.rot += -10 * (1 - sp);
    out.blur = interpolate(f, [0, r(5)], [8, 0], CLAMP);
    out.o = interpolate(f, [0, r(3)], [0, 1], CLAMP);
  } else if (enter.kind === 'fly') {
    const sp = spring({ frame: f, fps, config: SPRINGS.fly });
    const [fx, fy] = enter.from || [0, 60];
    out.s = 0.92 + 0.08 * sp;
    out.dx = fx * (1 - sp);
    out.dy = fy * (1 - sp);
    out.o = interpolate(f, [0, r(4)], [0, 1], CLAMP);
    out.blur = interpolate(f, [0, r(6)], [14, 0], CLAMP);
  } else if (enter.kind === 'mask') {
    const p = prog(f, 0, r(8));
    out.clip = `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0 round 24px)`;
    out.dy = 24 * (1 - p);
    out.blur = interpolate(f, [0, r(6)], [6, 0], CLAMP);
  }
  if (enter.kind !== 'cut' && item.life?.parallax !== 0) {
    out.dy += (item.life?.parallax ?? 8) * interpolate(f, [0, len], [0, 1], CLAMP);
  }
  const exit = item.exit || { frames: 5, dir: 'down' };
  if (exit.frames > 0) {
    const exitFrames = r(exit.frames);
    const q = interpolate(frame, [item.until - exitFrames, item.until], [0, 1], { ...CLAMP, easing: Easing.in(Easing.quad) });
    if (q > 0) {
      out.o *= 1 - q;
      out.s *= 1 - 0.06 * q;
      out.dy += (exit.dir === 'up' ? -12 : 12) * q;
      out.blur += 8 * q;
    }
  }
  return out;
}

// Габарит элемента в кадре с учётом масштаба, поворота и сдвига. null — элемент не виден.
export function itemExtentAt(item, frame, fps) {
  const a = animOf(item, frame, fps);
  if (a.o <= 0.01) return null;
  const { x, y, w, h } = item.box;
  const th = (Math.abs(a.rot) * Math.PI) / 180;
  const hw = ((w * Math.cos(th) + h * Math.sin(th)) / 2) * a.s;
  const hh = ((w * Math.sin(th) + h * Math.cos(th)) / 2) * a.s;
  const cx = x + w / 2 + a.dx;
  const cy = y + h / 2 + a.dy;
  return { left: cx - hw, top: cy - hh, right: cx + hw, bottom: cy + hh };
}

const rand = (seed) => {
  const v = Math.sin(seed * 12.9898) * 43758.5453;
  return v - Math.floor(v);
};

// Набор текста с живым неровным ритмом, детерминированный между кадрами.
export function typed(text, frame, fromFrame, toFrame) {
  const chars = [...text];
  if (frame < fromFrame) return '';
  if (frame >= toFrame) return text;
  const weights = chars.map((_, i) => 0.6 + 0.8 * rand(i * 3.1 + chars.length));
  const total = weights.reduce((sum, v) => sum + v, 0);
  const target = ((frame - fromFrame) / (toFrame - fromFrame)) * total;
  let acc = 0;
  let k = 0;
  while (k < chars.length && acc + weights[k] <= target) {
    acc += weights[k];
    k += 1;
  }
  return chars.slice(0, k).join('');
}
```

`core.js`: добавить `export * from './motion.js';`.

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-motion.test.js`
Expected: PASS (6 тестов).

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/motion.js src/motion-kit/core.js tests/motion-kit-motion.test.js
git commit -m "feat: add motion-kit element animation and per-frame extents"
```

### Task 8: Вставки и уход аватара под них

**Files:**
- Create: `src/motion-kit/inserts.js`
- Modify: `src/motion-kit/core.js`
- Test: `tests/motion-kit-inserts.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-inserts.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');

test('inserts compile to frames, default ids, cover and Ken Burns range', () => {
  const inserts = kit.compileInserts([
    { kind: 'stock', from: 2, to: 4, src: 'stock/a.mp4', sfx: 'whoosh' },
    { kind: 'donor', from: 1.3, to: 3.4, src: 'donor.mp4' },
  ], { fps: 25 });
  assert.deepEqual(inserts.map((i) => [i.id, i.from, i.to, i.cover]), [['stock-1', 50, 100, true], ['donor-2', 33, 85, false]]);
  assert.deepEqual(inserts[0].kb, [1.03, 1.1]);
  assert.equal(inserts[0].sfx, 'whoosh');
});

test('invalid inserts are rejected', () => {
  assert.throws(() => kit.compileInserts([{ kind: 'meme', from: 0, to: 1 }], { fps: 25 }), /inserts\[0\]: kind/);
  assert.throws(() => kit.compileInserts([{ kind: 'stock', from: 2, to: 2 }], { fps: 25 }), /to должен быть больше from/);
});

test('covering inserts send the speaker away and bring it back before the insert ends', () => {
  const aways = kit.awaysFromInserts(kit.compileInserts([
    { kind: 'stock', from: 2, to: 4 }, { kind: 'donor', from: 5, to: 6 },
  ], { fps: 25 }));
  assert.deepEqual(aways, [{ from: 50, to: 90 }]);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-inserts.test.js`
Expected: FAIL — `kit.compileInserts is not a function`.

- [ ] **Step 3: Реализовать**

```js
// src/motion-kit/inserts.js
import { ref25, secToFrame } from './time.js';

export const INSERT_KINDS = Object.freeze(['stock', 'screen', 'donor', 'scene']);
const RETURN_FRAMES = 10;

export function compileInserts(inserts = [], { fps }) {
  return inserts.map((insert, i) => {
    if (!INSERT_KINDS.includes(insert.kind)) {
      throw new Error(`inserts[${i}]: kind должен быть ${INSERT_KINDS.join('|')}`);
    }
    const from = secToFrame(insert.from, fps);
    const to = secToFrame(insert.to, fps);
    if (!(to > from)) throw new Error(`inserts[${i}] (${insert.id || insert.kind}): to должен быть больше from`);
    return {
      id: insert.id || `${insert.kind}-${i + 1}`,
      kind: insert.kind,
      from,
      to,
      src: insert.src ?? null,
      cover: insert.cover ?? insert.kind !== 'donor',
      kb: insert.kb || [1.03, 1.1],
      sfx: insert.sfx ?? null,
    };
  });
}

// Полноэкранная вставка закрывает спикера: он уходит на входе и возвращается к её концу.
export function awaysFromInserts(inserts, { fps = 25 } = {}) {
  const back = ref25(RETURN_FRAMES, fps);
  return inserts.filter((insert) => insert.cover)
    .map((insert) => ({ from: insert.from, to: Math.max(insert.from + 1, insert.to - back) }));
}
```

`core.js`: добавить `export * from './inserts.js';`.

**Состояние после пакета 1** (Task 15): `RETURN_FRAMES` удалён — спикер возвращается к началу закрытия,
`away.to = to − ref25(CLOSE_FRAMES) − ref25(CAMERA_DEFAULTS.away.exitFrames)` (сток 2–4 с при 25 fps →
`{from: 50, to: 84}`); `compileInserts(inserts, {fps, durationInFrames})` отклоняет cover-вставку короче
`close + exit + 1` кадра и `kb`, который не пара чисел ≥ 1 (`KB_DEFAULT = [1.03, 1.1]`). Кривые раскрытия
и закрытия (`revealCard`, `closeWindow`, `revealProgress`, `insertOpacity`) живут в этом же модуле.

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-inserts.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/inserts.js src/motion-kit/core.js tests/motion-kit-inserts.test.js
git commit -m "feat: add motion-kit inserts with speaker away windows"
```

### Task 9: Звуковые события, выравнивание по пику, прореживание

**Files:**
- Create: `src/motion-kit/sfx.js`
- Modify: `src/motion-kit/core.js`
- Test: `tests/motion-kit-sfx.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-sfx.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');
const library = { sounds: {
  'whoosh-in': { file: 'sfx/whoosh-in.wav', lengthSec: 1.2, peakSec: 0.4 },
  'pop-cluster': { file: 'sfx/pop-cluster.wav', lengthSec: 0.5, peakSec: 0.02 },
  typing: { file: 'sfx/typing.wav', lengthSec: 2.8, peakSec: 0.05 },
  'typing-long': { file: 'sfx/typing-long.wav', lengthSec: 12, peakSec: 0.05 },
  'click-soft': { file: 'sfx/click-soft.wav', lengthSec: 0.2, peakSec: 0.01, volume: 0.8 },
} };
const opts = { fps: 25, library, durationInFrames: 500 };

test('a whoosh starts early so its peak lands on the element entrance', () => {
  const [cue] = kit.sfxFromItems([{ from: 100, sfx: 'whoosh-in' }], [], opts);
  assert.deepEqual([cue.startFrame, cue.hitFrame, cue.notable, cue.role], [90, 100, true, 'whoosh']);
});

test('roles resolve to library files and volumes follow spec > library > role', () => {
  const cues = kit.sfxFromItems([
    { from: 10, sfx: 'pop' }, { from: 40, sfx: { name: 'click-soft' } }, { from: 80, sfx: { name: 'click-soft', vol: 0.4 } },
  ], [], opts);
  assert.equal(cues[0].name, 'pop-cluster');
  assert.equal(cues[0].vol, 0.55);
  assert.equal(cues[1].vol, 0.8);
  assert.equal(cues[2].vol, 0.4);
  assert.throws(() => kit.sfxFromItems([{ from: 1, sfx: 'boom' }], [], opts), /звук «boom» не найден/);
});

test('typing is a bed that lasts as long as the text types and picks the long loop when needed', () => {
  const [cue] = kit.sfxFromItems([{ from: 50, typeFrom: 50, typeTo: 150 }], [], opts);
  assert.deepEqual([cue.name, cue.durationFrames, cue.bed], ['typing-long', 100, true]);
});

test('thinning keeps one notable sound per second and 0.3 s between any sounds', () => {
  const cues = kit.sfxFromItems([
    { from: 100, sfx: 'whoosh-in' }, { from: 110, sfx: 'whoosh-in' }, { from: 104, sfx: 'pop' },
    { from: 100, typeFrom: 100, typeTo: 140 },
  ], [], opts);
  const { kept, dropped } = kit.thinCues(cues, { fps: 25 });
  assert.deepEqual(kept.map((c) => c.name).sort(), ['typing', 'whoosh-in']);
  assert.deepEqual(dropped.map((d) => d.reason).sort(), ['min-gap', 'notable-gap']);
});

test('pickSound returns a role only when the library has it', () => {
  assert.equal(kit.pickSound(library, 'whoosh'), 'whoosh');
  assert.equal(kit.pickSound({ sounds: {} }, 'whoosh'), null);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-sfx.test.js`
Expected: FAIL — `kit.sfxFromItems is not a function`.

- [ ] **Step 3: Реализовать**

```js
// src/motion-kit/sfx.js
import { secToFrame } from './time.js';

export const NOTABLE_ROLES = Object.freeze(['whoosh', 'swoosh', 'impact', 'riser', 'shutter']);
export const ROLE_VOLUME = Object.freeze({
  whoosh: 0.7, swoosh: 0.7, impact: 0.7, riser: 0.5, shutter: 0.6,
  pop: 0.55, click: 0.55, swish: 0.5, ui: 0.5, typing: 0.4,
});
const ROLE_PRIO = { impact: 3, riser: 3, whoosh: 2, swoosh: 2, shutter: 2 };
export const roleOf = (name) => String(name).split('-')[0];

export function resolveSound(library, spec) {
  const name = typeof spec === 'string' ? spec : spec?.name;
  const sounds = library?.sounds || {};
  if (sounds[name]) return { name, ...sounds[name] };
  const byRole = Object.entries(sounds).find(([soundName, sound]) => (sound.role || roleOf(soundName)) === name);
  if (!byRole) throw new Error(`звук «${name}» не найден в библиотеке слоя (public/sfx)`);
  return { name: byRole[0], ...byRole[1] };
}

export function pickSound(library, role) {
  const sounds = library?.sounds || {};
  if (sounds[role]) return role;
  return Object.entries(sounds).some(([name, sound]) => (sound.role || roleOf(name)) === role) ? role : null;
}

// Звуки из элементов (sfx на входе, typing на наборе) и из списка extra [{at, name, vol, prio}].
export function sfxFromItems(items, extra, { fps, library, durationInFrames }) {
  const cues = [];
  const push = (spec, hitFrame, { bedFrames = null, prio } = {}) => {
    const sound = resolveSound(library, spec);
    const role = sound.role || roleOf(sound.name);
    const own = typeof spec === 'object' ? spec.vol : undefined;
    const vol = own ?? sound.volume ?? ROLE_VOLUME[role] ?? 0.5;
    const lead = typeof spec === 'object' && Number.isFinite(spec.leadFrames)
      ? spec.leadFrames : Math.round((sound.peakSec || 0) * fps);
    const startFrame = Math.max(0, hitFrame - lead);
    const natural = Math.max(1, Math.round(sound.lengthSec * fps));
    const durationFrames = Math.max(1, Math.min(bedFrames ?? natural, natural, durationInFrames - startFrame));
    cues.push({
      id: `${sound.name}@${hitFrame}`, name: sound.name, file: sound.file, startFrame, hitFrame, durationFrames,
      vol, role, notable: NOTABLE_ROLES.includes(role), bed: bedFrames !== null, prio: prio ?? ROLE_PRIO[role] ?? 1,
    });
  };
  for (const item of items) {
    if (item.sfx) push(item.sfx, item.from);
    if (item.typeFrom !== undefined && item.typeTo > item.typeFrom && item.typeSfx !== null) {
      const span = item.typeTo - item.typeFrom;
      const short = library?.sounds?.typing;
      const spec = item.typeSfx
        || (library?.sounds?.['typing-long'] && short && span > short.lengthSec * fps ? 'typing-long' : 'typing');
      push(spec, item.typeFrom, { bedFrames: span, prio: 0 });
    }
  }
  for (const entry of extra || []) push(entry, secToFrame(entry.at, fps), { prio: entry.prio });
  return cues.filter((cue) => cue.startFrame < durationInFrames);
}

// Не больше одного заметного звука в секунду и не ближе 0,3 с между любыми; набор текста — подложка.
export function thinCues(cues, { fps, minGapSec = 0.3, notableGapSec = 1.0 } = {}) {
  const kept = [];
  const dropped = [];
  const minGap = minGapSec * fps;
  const notableGap = notableGapSec * fps;
  const ordered = [...cues].sort((a, b) => b.prio - a.prio || a.hitFrame - b.hitFrame);
  for (const cue of ordered) {
    if (cue.bed) {
      kept.push(cue);
      continue;
    }
    const clash = kept.find((k) => !k.bed && (
      Math.abs(k.hitFrame - cue.hitFrame) < minGap
      || (k.notable && cue.notable && Math.abs(k.hitFrame - cue.hitFrame) < notableGap)));
    if (clash) {
      const reason = clash.notable && cue.notable && Math.abs(clash.hitFrame - cue.hitFrame) >= minGap ? 'notable-gap' : 'min-gap';
      dropped.push({ cue, conflictWith: clash.id, reason });
    } else {
      kept.push(cue);
    }
  }
  kept.sort((a, b) => a.startFrame - b.startFrame);
  return { kept, dropped };
}
```

`core.js`: добавить `export * from './sfx.js';`.

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-sfx.test.js`
Expected: PASS (5 тестов).

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/sfx.js src/motion-kit/core.js tests/motion-kit-sfx.test.js
git commit -m "feat: add motion-kit sound cues with peak alignment and thinning"
```

### Task 10: Субтитры — нарезка и полоса

**Files:**
- Create: `src/motion-kit/captions.js`
- Modify: `src/motion-kit/core.js`
- Test: `tests/motion-kit-captions.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-captions.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');

test('chunks break on commas after two words, sentence ends and pauses', () => {
  const words = [
    { t: 'Раз', s: 0, e: 0.3 }, { t: 'два', s: 0.35, e: 0.6 }, { t: 'три,', s: 0.65, e: 0.9 },
    { t: 'четыре', s: 0.95, e: 1.3 }, { t: 'пять.', s: 1.35, e: 1.6 },
    { t: 'шесть', s: 2.5, e: 2.8 }, { t: 'а', s: 2.85, e: 2.9 },
  ];
  const chunks = kit.buildChunks(words);
  assert.deepEqual(chunks.map((c) => c.text), ['Раз два три,', 'четыре пять.', 'шесть а']);
  assert.deepEqual(chunks.map((c) => c.show), [0.95, 2, 3.3]);
});

test('chunks respect the 20-character limit', () => {
  const words = ['интерфейсы', 'нейросетей', 'меняются'].map((t, i) => ({ t, s: i * 0.7, e: i * 0.7 + 0.6 }));
  assert.deepEqual(kit.buildChunks(words).map((c) => c.text), ['интерфейсы', 'нейросетей меняются']);
});

test('too short chunk merges into the next one', () => {
  const words = [{ t: 'Да.', s: 0, e: 0.2 }, { t: 'Именно', s: 0.25, e: 0.6 }, { t: 'так', s: 0.62, e: 0.8 }];
  assert.deepEqual(kit.buildChunks(words).map((c) => c.text), ['Да. Именно так']);
});

test('caption lane sits inside the safe zone above the bottom edge', () => {
  assert.deepEqual(kit.captionLane(1080, 1920), { x: 70, y: 1398, w: 880, h: 84 });
});
```

«интерфейсы нейросетей» — 21 знак, поэтому первое слово уходит отдельным куском.

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-captions.test.js`
Expected: FAIL — `kit.buildChunks is not a function`.

- [ ] **Step 3: Реализовать**

```js
// src/motion-kit/captions.js
import { safeRect } from './safe.js';

const END = /[.!?…]$/u;
const COMMA = /[,;:]$/u;

// 1–4 слова, до 20 знаков, разрыв на паузе, конце фразы и запятой (если в куске уже 2+ слова);
// кусок короче minDur приклеивается к следующему. show — до какого момента кусок на экране.
export function buildChunks(words, { maxWords = 4, maxChars = 20, hardGap = 0.3, minDur = 0.45, hold = 0.4 } = {}) {
  const chunks = [];
  let current = null;
  for (const word of words) {
    const text = word.t ?? word.w;
    if (current) {
      const prev = current.units[current.units.length - 1];
      const chars = current.units.reduce((n, u) => n + u.t.length + 1, 0) + text.length;
      if (current.units.length >= maxWords || chars > maxChars || word.s - prev.e > hardGap
        || END.test(prev.t) || (COMMA.test(prev.t) && current.units.length >= 2)) {
        chunks.push(current);
        current = null;
      }
    }
    if (!current) current = { units: [], s: word.s, e: word.e };
    current.units.push({ t: text, s: word.s, e: word.e });
    current.e = word.e;
  }
  if (current) chunks.push(current);
  for (let i = 0; i < chunks.length - 1; i += 1) {
    if (chunks[i].e - chunks[i].s < minDur && chunks[i + 1].s - chunks[i].e <= hardGap) {
      chunks[i + 1] = { units: [...chunks[i].units, ...chunks[i + 1].units], s: chunks[i].s, e: chunks[i + 1].e };
      chunks.splice(i, 1);
      i -= 1;
    }
  }
  return chunks.map((chunk, i) => ({
    ...chunk,
    text: chunk.units.map((u) => u.t).join(' '),
    show: Number(Math.min(chunks[i + 1]?.s ?? Infinity, chunk.e + hold).toFixed(3)),
  }));
}

export function captionLane(width, height) {
  const safe = safeRect(width, height);
  const k = width / (height > width ? 1080 : 1920);
  return { x: safe.left, y: safe.bottom - 102 * k, w: safe.right - safe.left, h: 84 * k };
}
```

`core.js`: добавить `export * from './captions.js';`.

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-captions.test.js`
Expected: PASS (4 теста).

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/captions.js src/motion-kit/core.js tests/motion-kit-captions.test.js
git commit -m "feat: add motion-kit caption chunking and lane"
```

### Task 11: Компиляция слоя

**Files:**
- Create: `src/motion-kit/compile.js`
- Modify: `src/motion-kit/core.js`
- Test: `tests/motion-kit-compile.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-compile.test.js
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
  assert.deepEqual(layer.camera.aways, [{ from: 100, to: 140 }]);
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
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-compile.test.js`
Expected: FAIL — `kit.compileLayer is not a function`.

- [ ] **Step 3: Реализовать**

```js
// src/motion-kit/compile.js
import { compileCamera, withAways } from './camera.js';
import { buildChunks, captionLane } from './captions.js';
import { awaysFromInserts, compileInserts } from './inserts.js';
import { sfxFromItems, thinCues } from './sfx.js';
import { secToFrame } from './time.js';

export const KIT_VERSION = 1;
const ITEM_KINDS = ['text', 'card', 'media'];

export function compileItems(items = [], { fps, durationInFrames }) {
  const ids = new Set();
  return items.map((item, i) => {
    if (!item.id || ids.has(item.id)) throw new Error(`items[${i}]: нужен уникальный id`);
    ids.add(item.id);
    if (!ITEM_KINDS.includes(item.kind)) throw new Error(`items ${item.id}: kind должен быть ${ITEM_KINDS.join('|')}`);
    const b = item.box;
    if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite)) throw new Error(`items ${item.id}: нужен box {x,y,w,h}`);
    const from = secToFrame(item.at, fps);
    const until = Math.min(durationInFrames, secToFrame(item.until, fps));
    if (!(until > from)) throw new Error(`items ${item.id}: until должен быть больше at`);
    return {
      id: item.id, kind: item.kind, from, until, box: { ...b }, rot: item.rot || 0,
      enter: item.enter || { kind: 'fly' }, exit: item.exit || { frames: 5, dir: 'down' }, life: item.life || {},
      bleed: Boolean(item.bleed), sfx: item.sfx ?? null,
      typeFrom: item.type ? secToFrame(item.type.from, fps) : undefined,
      typeTo: item.type ? secToFrame(item.type.to, fps) : undefined,
      typeSfx: item.type ? item.type.sfx : undefined,
      props: item.props || {},
    };
  });
}

// Один вход для рендера (Root.jsx) и для гейтов (buildManifest): всё в кадрах композиции.
export function compileLayer(plan, { fps, width, height, durationInFrames, words = [], sfxLibrary = { sounds: {} } }) {
  const inserts = compileInserts(plan.inserts, { fps });
  const camera = withAways(compileCamera(plan.camera, { fps, width, height, durationInFrames }), awaysFromInserts(inserts, { fps }));
  const items = compileItems(plan.items, { fps, durationInFrames });
  const cues = thinCues(sfxFromItems([...items, ...inserts], plan.sfx, { fps, library: sfxLibrary, durationInFrames }), { fps });
  const captions = plan.captions === false ? null : {
    chunks: buildChunks(words, plan.captions?.chunk),
    lane: plan.captions?.lane || captionLane(width, height),
    hide: (plan.captions?.hide || []).map((h) => ({ from: h.from, to: h.to })),
  };
  return {
    kitVersion: KIT_VERSION, fps, width, height, durationInFrames,
    camera, items, inserts, cues, captions,
    hook: plan.hook || 'speaker',
    waivers: plan.waivers || [],
  };
}
```

`core.js`: добавить `export * from './compile.js';`.

**Состояние после пакета 1:** окно ухода стока 4–6 с — `camera.aways = [{from: 100, to: 134}]` (Task 15);
каждое окно `captions.hide` проверяется — конечные `from < to` в секундах, иначе ошибка `captions.hide[i]`
(Task 18).

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-compile.test.js`
Expected: PASS (3 теста).

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/compile.js src/motion-kit/core.js tests/motion-kit-compile.test.js
git commit -m "feat: compile motion layers from one plan object"
```

### Task 12: Манифест для гейтов

**Files:**
- Create: `src/motion-kit/manifest.js`
- Modify: `src/motion-kit/core.js`
- Test: `tests/motion-kit-manifest.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-manifest.test.js
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
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-manifest.test.js`
Expected: FAIL — `kit.buildManifest is not a function`.

- [ ] **Step 3: Реализовать**

```js
// src/motion-kit/manifest.js
import { cameraAt } from './camera.js';
import { itemExtentAt } from './motion.js';

const r3 = (value) => Math.round(value * 1000) / 1000;

// Сериализуемый снимок слоя: камера и габариты текста по кадрам, вставки, звуки, хук, исключения.
export function buildManifest(compiled) {
  const { fps, width, height, durationInFrames } = compiled;
  const camera = { s: [], requested: [], dx: [], dy: [], blur: [], opacity: [] };
  for (let frame = 0; frame < durationInFrames; frame += 1) {
    const c = cameraAt(compiled.camera, frame);
    camera.s.push(r3(c.s));
    camera.requested.push(r3(c.requested));
    camera.dx.push(r3(c.dx));
    camera.dy.push(r3(c.dy));
    camera.blur.push(r3(c.blur));
    camera.opacity.push(r3(c.opacity));
  }
  const texts = compiled.items.filter((item) => item.kind !== 'media' && !item.bleed).map((item) => {
    const frames = [];
    for (let frame = item.from; frame < item.until; frame += 1) {
      const r = itemExtentAt(item, frame, fps);
      frames.push(r ? [r3(r.left), r3(r.top), r3(r.right), r3(r.bottom)] : null);
    }
    return { id: item.id, from: item.from, frames };
  });
  if (compiled.captions) {
    const { lane, chunks } = compiled.captions;
    chunks.forEach((chunk, i) => {
      const from = Math.round(chunk.s * fps);
      const until = Math.min(durationInFrames, Math.round(chunk.show * fps));
      if (until > from) {
        texts.push({ id: `caption-${i + 1}`, from, until, static: [r3(lane.x), r3(lane.y), r3(lane.x + lane.w), r3(lane.y + lane.h)] });
      }
    });
  }
  return {
    version: 1, kitVersion: compiled.kitVersion, fps, width, height, durationInFrames,
    maxScale: compiled.camera.maxScale,
    camera,
    texts,
    inserts: compiled.inserts.map((insert) => ({ id: insert.id, kind: insert.kind, from: insert.from, to: insert.to })),
    cues: {
      kept: compiled.cues.kept.map((cue) => ({ id: cue.id, name: cue.name, startFrame: cue.startFrame, hitFrame: cue.hitFrame, notable: cue.notable, bed: cue.bed })),
      dropped: compiled.cues.dropped.map((entry) => ({ id: entry.cue.id, conflictWith: entry.conflictWith, reason: entry.reason })),
    },
    hook: compiled.hook,
    waivers: compiled.waivers,
  };
}
```

`core.js`: добавить `export * from './manifest.js';`.

**Состояние после пакета 1** (Task 18): кадры субтитров считает `captionSpans(chunks, {hide, fps,
durationInFrames})` — те же, что рисует `Subtitles`, с вырезанными окнами `hide`; первый кусок chunk —
`caption-<n>`, следующие после окна `hide` — `caption-<n>b`, `caption-<n>c`…

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-manifest.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/manifest.js src/motion-kit/core.js tests/motion-kit-manifest.test.js
git commit -m "feat: build motion-kit gate manifest"
```

## Фаза 4. Компоненты kit (React)

Компоненты тонкие: всё решение о кадре принимают чистые функции — из фаз 2–3 и из чистых модулей,
которые эта фаза дописывает (`inserts.js`, `screen.js`, `sfx.js`, `captions.js`): их же читает
`buildManifest`, поэтому гейт видит ровно то, что нарисовано. Тесты рендерят разметку через
`react-dom/server` с подменой хуков Remotion; эффекты там не выполняются, поэтому поведение в
настоящем браузере (шрифты, подгонка субтитров) закрепляет отдельный тест по флагу
`tests/motion-kit-render.test.js` (Task 18).

Фрагменты ниже описывают код после ревью пакета 1 (исправления шли отдельными `fix:`-коммитами).
Короткие файлы приведены целиком, длинные — сигнатурами и ключевым поведением; источник истины —
код в `src/motion-kit/`.

### Task 13: Подмена Remotion для тестов и `KitBox`

**Files:**
- Create: `tests/helpers/remotion-stub.js`
- Create: `src/motion-kit/KitBox.jsx`
- Modify: `src/motion-kit/motion.js` (общий порог видимости `VISIBLE_MIN`/`isShown`), `src/motion-kit/index.js`
- Test: `tests/motion-kit-components.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/helpers/remotion-stub.js
const React = require('react');
const real = require('remotion');

// Реальные spring/interpolate/Easing + подмена хуков и медиа-компонентов на простую разметку.
// Ограничения: Sequence не сдвигает useCurrentFrame и не прячет детей; Freeze учитывает `active`
// (boolean или функция кадра), но кадр детей не замораживает; renderToStaticMarkup не выполняет
// эффекты — continueRender/cancelRender недостижимы, считаются только вызовы delayRender.
function remotionStub({ frame = 0, fps = 25, width = 1080, height = 1920, durationInFrames = 100000, calls = {} } = {}) {
  const box = (tag) => ({ children, style, ...rest }) => React.createElement(tag, { style, ...rest }, children);
  return {
    ...real,
    useCurrentFrame: () => frame,
    useVideoConfig: () => ({ fps, width, height, durationInFrames }),
    AbsoluteFill: box('div'),
    Sequence: ({ children, from, durationInFrames }) => React.createElement('div', { 'data-sequence-from': from, 'data-sequence-duration': durationInFrames }, children),
    Freeze: ({ children, frame: at, active = true }) => {
      const isActive = typeof active === 'function' ? active(frame) : active;
      const attrs = { 'data-freeze-active': isActive ? 'true' : 'false' };
      if (isActive) attrs['data-freeze'] = at;
      return React.createElement('div', attrs, children);
    },
    OffthreadVideo: (props) => React.createElement('video', { src: props.src, muted: props.muted, 'data-trim-before': props.trimBefore }),
    Audio: (props) => React.createElement('audio', { src: props.src, 'data-volume': typeof props.volume === 'function' ? props.volume(0).toFixed(4) : props.volume }),
    Img: (props) => React.createElement('img', { src: props.src, style: props.style }),
    staticFile: (src) => `/static/${src}`,
    delayRender: () => { calls.delay = (calls.delay || 0) + 1; return 7; },
    continueRender: () => { calls.continue = (calls.continue || 0) + 1; },
    cancelRender: (error) => { calls.cancel = error; },
  };
}

const render = (element) => require('react-dom/server').renderToStaticMarkup(element);

module.exports = { remotionStub, render };
```

```js
// tests/motion-kit-components.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { loadEsm } = require('./helpers/load-esm');
const { remotionStub, render } = require('./helpers/remotion-stub');

const kitAt = (frame, { fps = 25, width, height, calls = {} } = {}) => loadEsm('src/motion-kit/index.js', { stubs: { remotion: remotionStub({ frame, fps, width, height, calls }) } });
const item = (over = {}) => ({ id: 'title', kind: 'text', from: 10, until: 60, box: { x: 90, y: 300, w: 840, h: 200 },
  rot: 0, enter: { kind: 'fly' }, exit: { frames: 5, dir: 'down' }, life: {}, ...over });

test('KitBox places text at its box, marks it for safe-zone checks and hides outside its window', () => {
  const kit = kitAt(30);
  const html = render(React.createElement(kit.KitBox, { item: item() }, 'Текст'));
  assert.match(html, /data-kit-text="title"/);
  assert.match(html, /left:90px;top:300px;width:840px;height:200px/);
  assert.match(html, /transform:translate\(/);
  assert.equal(render(React.createElement(kitAt(5).KitBox, { item: item() }, 'Текст')), '');
  assert.doesNotMatch(render(React.createElement(kit.KitBox, { item: item({ kind: 'media' }) }, 'x')), /data-kit-text/);
});

test('KitBox hides frames that are inside [from, until) but not yet opaque, using the same rule as the manifest', () => {
  const atFrom = kitAt(10);
  assert.equal(render(React.createElement(atFrom.KitBox, { item: item() }, 'Текст')), '');
  assert.equal(atFrom.itemExtentAt(item(), 10, 25), null);
  const atLastFrame = kitAt(59);
  assert.equal(render(React.createElement(atLastFrame.KitBox, { item: item() }, 'Текст')), '');
  assert.equal(atLastFrame.itemExtentAt(item(), 59, 25), null);
});

test('KitBox refuses a raw plan item: needs compiled from/until frame numbers, not plan seconds', () => {
  assert.throws(() => render(React.createElement(kitAt(30).KitBox, { item: { id: 'title', at: 0.4, until: 2.4 } }, 'Текст')),
    /KitBox ждёт скомпилированный элемент с кадрами from\/until/);
});
```

Рядом — `bleed`-элемент виден без маркера `data-kit-text`, `transformOrigin: 'center center'` закреплён, а
`kitBoxStyle` рисует ровно тот габарит, который для того же кадра меряет `itemExtentAt`.

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-components.test.js`
Expected: FAIL — `kit.KitBox` is undefined (React: element type is invalid).

- [ ] **Step 3: Реализовать**

`motion.js` — один порог видимости для рендера и манифеста:

```js
export const VISIBLE_MIN = 0.01;
export function isShown(anim) {
  return anim.o > VISIBLE_MIN;
}
// itemExtentAt: `if (!isShown(a)) return null;` вместо собственного `a.o <= 0.01`.
```

```jsx
// src/motion-kit/KitBox.jsx
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { animOf, isShown } from './motion.js';

export function kitBoxStyle(item, frame, fps) {
  const a = animOf(item, frame, fps);
  return {
    position: 'absolute', left: item.box.x, top: item.box.y, width: item.box.w, height: item.box.h,
    opacity: a.o,
    transform: `translate(${a.dx.toFixed(2)}px, ${a.dy.toFixed(2)}px) scale(${a.s.toFixed(4)}) rotate(${a.rot.toFixed(2)}deg)`,
    transformOrigin: 'center center',
    filter: a.blur > 0.05 ? `blur(${a.blur.toFixed(2)}px)` : undefined,
    clipPath: a.clip || undefined,
  };
}

// Содержимое должно помещаться внутри item.box: гейт safe-zone (G5) видит именно этот
// прямоугольник, а не то, что текст реально нарисовал внутри.
export function KitBox({ item, children }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!Number.isFinite(item.from) || !Number.isFinite(item.until)) {
    throw new Error(`KitBox ждёт скомпилированный элемент с кадрами from/until (compileLayer/compileItems), а получил секунды плана? (item.id=${item.id}, from=${item.from}, until=${item.until})`);
  }
  // animOf сам возвращает o:0 вне [from, until); isShown — та же проверка, что у манифеста.
  const a = animOf(item, frame, fps);
  if (!isShown(a)) return null;
  const marker = item.kind === 'media' || item.bleed ? {} : { 'data-kit-text': item.id };
  return <div {...marker} style={kitBoxStyle(item, frame, fps)}>{children}</div>;
}
```

`index.js`: добавить `export { KitBox, kitBoxStyle } from './KitBox.jsx';`.

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-components.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add tests/helpers/remotion-stub.js src/motion-kit/KitBox.jsx src/motion-kit/motion.js src/motion-kit/index.js tests/motion-kit-components.test.js
git commit -m "feat: add motion-kit KitBox"
```

### Task 14: `SpeakerLayer`

**Files:**
- Create: `src/motion-kit/SpeakerLayer.jsx`
- Modify: `src/motion-kit/index.js`
- Test: `tests/motion-kit-components.test.js` (дописать)

- [ ] **Step 1: Дописать тест**

```js
test('SpeakerLayer renders one muted video with the camera transform, fills side shots and freezes the tail', () => {
  const base = kitAt(10);
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250 };
  const track = base.compileCamera({ face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'L' }] }, cfg);
  const one = render(React.createElement(base.SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  assert.equal((one.match(/<video/g) || []).length, 1);
  assert.match(one, /muted=""/);
  assert.match(one, /transform-origin:540px 787px/);
  const side = render(React.createElement(kitAt(60).SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  assert.equal((side.match(/<video/g) || []).length, 2);
  const tail = render(React.createElement(kitAt(230).SpeakerLayer, { src: 'speaker.mp4', track, lastFrame: 200 }));
  assert.match(tail, /data-freeze="200"/);
  const away = base.withAways(track, [{ from: 100, to: 150 }]);
  assert.equal(render(React.createElement(kitAt(120).SpeakerLayer, { src: 'speaker.mp4', track: away, lastFrame: 200 })), '');
});
```

Дополнительно закрепить: `speakerFillStyle` перекрывает кадр с запасом ≥ 3σ размытия с каждой стороны;
точка лица сдвигается ровно на `dx/dy` (то, что читают G1/G2), а планы без заливки не оставляют полосы у
края; `speakerTransform` — чистая геометрия без `opacity`, `blur`/`brightness` только когда заметны;
`trimBefore` пробрасывается в видео; `Freeze` смонтирован всегда (переключается `active`, видео не
перемонтируется на `lastFrame`); прозрачность ухода — одна групповая `opacity` на обе копии.

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-components.test.js`
Expected: FAIL — `SpeakerLayer` undefined.

- [ ] **Step 3: Реализовать**

```jsx
// src/motion-kit/SpeakerLayer.jsx
import { AbsoluteFill, Freeze, OffthreadVideo, staticFile, useCurrentFrame } from 'remotion';
import { cameraAt } from './camera.js';

export function speakerTransform(state, track) {
  const filters = [];
  if (state.blur > 0.05) filters.push(`blur(${state.blur.toFixed(2)}px)`);
  if (state.dim < 0.999) filters.push(`brightness(${state.dim.toFixed(3)})`);
  return {
    position: 'absolute', left: 0, top: 0, width: track.width, height: track.height,
    transformOrigin: `${track.face.x}px ${track.face.y}px`,
    // translate() ДО scale(): сдвиг точки лица равен ровно dx/dy — то, что читают гейты из манифеста.
    transform: `translate(${state.dx.toFixed(3)}px, ${state.dy.toFixed(3)}px) scale(${state.s.toFixed(6)})`,
    filter: filters.length ? filters.join(' ') : undefined,
  };
}

// Заливка краёв боковых планов: центрированный оверскан (по 10 % запаса с каждой стороны), иначе
// blur(5px) съедает края и оставляет тёмную полосу на R- и top-планах.
export function speakerFillStyle(track) {
  const { width: w, height: h } = track;
  return {
    position: 'absolute', left: -0.1 * w, top: -0.1 * h, width: w / 4, height: h / 4,
    transform: 'scale(4.8)', transformOrigin: '0 0',
    filter: 'blur(5px) brightness(0.7)',
  };
}

// Аватар — один OffthreadVideo muted по глобальному таймкоду (голос идёт из мастер-видео).
// SpeakerLayer стоит на верхнем уровне композиции, не внутри <Sequence>.
export function SpeakerLayer({ src, track, lastFrame, trimBefore = 0 }) {
  const frame = useCurrentFrame();
  const state = cameraAt(track, frame);
  if (!state.visible) return null;
  const video = (
    <OffthreadVideo src={staticFile(src)} muted trimBefore={trimBefore || undefined}
      style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  );
  // lastFrame — кадр композиции (для клипа из N кадров с trimBefore = T это N − 1 − T). Freeze
  // смонтирован всегда, когда lastFrame конечен; переключается только active.
  const held = Number.isFinite(lastFrame)
    ? <Freeze frame={lastFrame} active={frame > lastFrame}>{video}</Freeze>
    : video;
  return (
    <AbsoluteFill style={{ opacity: state.opacity }}>
      {state.fill ? <div style={speakerFillStyle(track)}>{held}</div> : null}
      <div style={speakerTransform(state, track)}>{held}</div>
    </AbsoluteFill>
  );
}
```

`index.js`: добавить `export { SpeakerLayer, speakerTransform, speakerFillStyle } from './SpeakerLayer.jsx';`.

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-components.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/SpeakerLayer.jsx src/motion-kit/index.js tests/motion-kit-components.test.js
git commit -m "feat: add motion-kit SpeakerLayer with live camera"
```

### Task 15: Полноэкранная вставка и сток с Ken Burns

Тайминг вставки — чистые функции в `inserts.js` (их же видит манифест и камера), компонент только
рисует. Стартовая карточка раскрытия — safe-зона кадра (`revealCard`), а не константа под 1080×1920:
для 9:16 это инсеты `{top: 250, right: 130, bottom: 420, left: 70}`, для 16:9 — `{60, 80, 60, 80}`.
Спикер полностью возвращается (резкий и непрозрачный) к началу закрытия вставки, чтобы сворачивающаяся
карточка не открывала размытое лицо.

**Files:**
- Create: `src/motion-kit/Inserts.jsx`
- Modify: `src/motion-kit/inserts.js`, `src/motion-kit/index.js`
- Test: `tests/motion-kit-components.test.js`, `tests/motion-kit-inserts.test.js` (дописать)

- [ ] **Step 1: Дописать тест**

```js
test('FullscreenReveal opens from a safe-zone card to the full frame and closes before the end', () => {
  const kit = kitAt(0);
  const insert = { id: 'stock-1', kind: 'stock', from: 50, to: 100, src: 'stock/a.mp4', kb: [1.03, 1.1], cover: true };
  assert.equal(kit.revealProgress(49, insert), null);
  assert.equal(kit.revealProgress(50, insert), 0);
  assert.equal(kit.revealProgress(70, insert), 1);
  assert.ok(kit.revealProgress(98, insert) < 1);
  const html = render(React.createElement(kitAt(70).StockInsert, { insert }));
  assert.match(html, /data-kit-bleed="stock-1"/);
  assert.match(html, /data-sequence-from="50"/);
  assert.match(html, /data-sequence-duration="50"/);
  assert.match(html, /<video src="\/static\/stock\/a\.mp4" muted=""/);
  assert.equal(render(React.createElement(kitAt(120).StockInsert, { insert })), '');
});

test('revealCard derives its card insets from the safe-zone rect for both aspect ratios', () => {
  const kit = kitAt(0);
  const safe = kit.safeRect(1080, 1920);
  assert.deepEqual(kit.revealCard(1080, 1920), { top: safe.top, right: 1080 - safe.right, bottom: 1920 - safe.bottom, left: safe.left });
});
```

```js
// tests/motion-kit-inserts.test.js (дописать)
test('covering inserts send the speaker away and bring it back before the insert closes', () => {
  const aways = kit.awaysFromInserts(kit.compileInserts([
    { kind: 'stock', from: 2, to: 4 }, { kind: 'donor', from: 5, to: 6 },
  ], { fps: 25 }));
  assert.deepEqual(aways, [{ from: 50, to: 84 }]);
});
```

Дополнительно закрепить: на 25/30/50 fps спикер резкий и непрозрачный на всём close и не гаснет, пока
виден зазор карточки; cover-вставка короче `close + exit + 1` кадра отклоняется с минимумом в кадрах и
секундах (и пометкой, если её обрезал конец ролика), donor под это правило не попадает; `kb` не пара
чисел ≥ 1 — ошибка с id вставки; close заканчивается на последнем отрисованном кадре (`to − 1`), где
`FullscreenReveal` уже ничего не рисует; радиус карточки масштабируется с разрешением; сырой insert из
`plan.js` (секунды) — явная ошибка компонента.

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-components.test.js tests/motion-kit-inserts.test.js`
Expected: FAIL — `kit.revealProgress is not a function`.

- [ ] **Step 3: Реализовать**

`inserts.js` — константы, проверки и кривые (кадры — эталонных 25 fps, `ref25` переводит под fps):

```js
export const REVEAL_FRAMES = 9;
export const CLOSE_FRAMES = 6;
export const KB_DEFAULT = Object.freeze([1.03, 1.1]);

// compileInserts(inserts, {fps, durationInFrames}) дополнительно:
//  - kb = insert.kb ?? KB_DEFAULT, иначе ошибка «inserts[i] (id): kb должен быть парой чисел ≥ 1»;
//  - cover = insert.cover ?? kind !== 'donor'; cover-вставка короче
//    ref25(CLOSE_FRAMES) + ref25(CAMERA_DEFAULTS.away.exitFrames) + 1 кадров (17 кадров = 0,68 с при 25 fps)
//    — ошибка: камера не успеет вернуть спикера в фокус до начала закрытия.

// Спикер уходит на входе и полностью возвращается к началу close.
export function awaysFromInserts(inserts, { fps = 25 } = {}) {
  const close = ref25(CLOSE_FRAMES, fps);
  const exit = ref25(CAMERA_DEFAULTS.away.exitFrames, fps);
  return inserts.filter((insert) => insert.cover)
    .map((insert) => ({ from: insert.from, to: Math.max(insert.from + 1, insert.to - close - exit) }));
}

// Инсеты карточки от той же safe-зоны, что и текст (подходят и 9:16, и 16:9).
export function revealCard(width, height) {
  const safe = safeRect(width, height);
  return { top: safe.top, right: width - safe.right, bottom: height - safe.bottom, left: safe.left };
}

// Одно close-окно на revealProgress и insertOpacity; close заканчивается на to − 1.
export function closeWindow(insert, fps = 25) {
  const end = insert.to - 1;
  const start = Math.min(insert.to - ref25(CLOSE_FRAMES, fps), end - 1);
  return { start, end };
}

// 0 — карточка внутри safe-зоны, 1 — весь кадр; null — вставки нет.
export function revealProgress(frame, insert, fps = 25) {
  if (frame < insert.from || frame >= insert.to) return null;
  const reveal = ref25(REVEAL_FRAMES, fps);
  const { start, end } = closeWindow(insert, fps);
  return prog(frame, insert.from, reveal) * (1 - prog(frame, start, end - start, EASE.inOut));
}

// Угасание вставки: 1 до начала close, 0 на последнем кадре (to − 1).
export function insertOpacity(frame, insert, fps = 25) {
  if (frame < insert.from || frame >= insert.to) return null;
  const { start, end } = closeWindow(insert, fps);
  return 1 - prog(frame, start, end - start, EASE.inOut);
}

// Для всех компонентов вставок: from/to — целые кадры compileInserts, а не секунды plan.js.
export function assertCompiledInsert(insert, component) { /* иначе Error «<component> ждёт скомпилированную вставку…» */ }
```

`RETURN_FRAMES` удалён: окно возврата теперь выводится из `CLOSE_FRAMES` и `CAMERA_DEFAULTS.away.exitFrames`.

```jsx
// src/motion-kit/Inserts.jsx
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { assertCompiledInsert, insertOpacity, KB_DEFAULT, revealCard, revealProgress } from './inserts.js';
import { isShown } from './motion.js';

export function FullscreenReveal({ insert, children }) {
  assertCompiledInsert(insert, 'FullscreenReveal');
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const p = revealProgress(frame, insert, fps);
  if (p === null) return null;
  const opacity = insertOpacity(frame, insert, fps);
  if (!isShown({ o: opacity })) return null; // тот же порог, что у KitBox
  const card = revealCard(width, height);
  const inset = (value) => (value * (1 - p)).toFixed(1);
  const radius = 28 * (width / (height > width ? 1080 : 1920));
  const clipPath = `inset(${inset(card.top)}px ${inset(card.right)}px ${inset(card.bottom)}px ${inset(card.left)}px round ${(radius * (1 - p)).toFixed(1)}px)`;
  return <AbsoluteFill data-kit-bleed={insert.id} style={{ clipPath, opacity }}>{children}</AbsoluteFill>;
}

// Скомпилированная вставка, компонент на верхнем уровне композиции (глобальный кадр для Ken Burns и
// revealProgress). Внутренняя Sequence нужна только видео стока: оно играет с собственного нуля.
export function StockInsert({ insert, children = null }) {
  assertCompiledInsert(insert, 'StockInsert');
  const frame = useCurrentFrame();
  const kb = insert.kb || KB_DEFAULT;
  const t = Math.min(1, Math.max(0, (frame - insert.from) / Math.max(1, insert.to - insert.from)));
  const zoom = kb[0] + (kb[1] - kb[0]) * t;
  return (
    <FullscreenReveal insert={insert}>
      <AbsoluteFill style={{ transform: `scale(${zoom.toFixed(4)})` }}>
        <Sequence from={insert.from} durationInFrames={insert.to - insert.from} layout="none">
          <OffthreadVideo src={staticFile(insert.src)} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </Sequence>
      </AbsoluteFill>
      {children}
    </FullscreenReveal>
  );
}
```

Полноэкранные вставки `screen`/`scene` (тоже `cover`) проект рисует сам: `<FullscreenReveal insert={insert}>`
со своим содержимым — иначе спикер уходит под вставку, а кадр остаётся чёрным (шаблон, Task 29).

`index.js`: добавить `export { FullscreenReveal, StockInsert } from './Inserts.jsx';` (чистые
`revealProgress`, `revealCard`, `closeWindow`, `insertOpacity`, `REVEAL_FRAMES`, `CLOSE_FRAMES`, `KB_DEFAULT`
приходят через `core.js`).

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-components.test.js tests/motion-kit-inserts.test.js tests/motion-kit-compile.test.js`
Expected: PASS (в `motion-kit-compile.test.js` окно ухода стока 4–6 с теперь `{from: 100, to: 134}`).

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/Inserts.jsx src/motion-kit/inserts.js src/motion-kit/index.js tests/motion-kit-components.test.js tests/motion-kit-inserts.test.js tests/motion-kit-compile.test.js
git commit -m "feat: add motion-kit fullscreen reveal and stock insert"
```

### Task 16: Скриншот-карточка: окно браузера, прокрутка, вспышка

Прокрутка задаётся долей страницы (`scroll` 0..1), а не пикселями: `plan.js` не знает натуральную высоту
скриншота, и фиксированный `maxScroll` упирался в белый низ картинки. Длительность вспышки — эталонные
кадры 25 fps, одинаковое время на любом fps.

**Files:**
- Create: `src/motion-kit/screen.js` (чистая математика), `src/motion-kit/Screen.jsx`
- Modify: `src/motion-kit/core.js` (`export * from './screen.js';`), `src/motion-kit/index.js`
- Test: `tests/motion-kit-components.test.js` (дописать)

- [ ] **Step 1: Дописать тест**

```js
test('scrollShare eases smoothly from 0 at from to the full share at to, and clamps', () => {
  const kit = kitAt(0);
  assert.equal(kit.scrollShare(10, 10, 60, 1), 0);
  assert.equal(kit.scrollShare(60, 10, 60, 1), 1);
  assert.equal(kit.scrollShare(35, 10, 60, 1), 0.5);
  assert.equal(kit.scrollShare(70, 10, 60, 1), 1);
  assert.equal(kit.scrollShare(35, 10, 60, 1.5), kit.scrollShare(35, 10, 60, 1));
});

test('ScrollShot fills the window via objectPosition, and the card shows the URL', () => {
  const html = render(React.createElement(kitAt(35).BrowserFrame, { url: 'example.com/page' },
    React.createElement(kitAt(35).ScrollShot, { src: 'shots/page.png', from: 10, to: 60, scroll: 1 })));
  assert.match(html, /example\.com\/page/);
  assert.match(html, /<img src="\/static\/shots\/page\.png"/);
  assert.match(html, /object-position:50% 50\.00%/);
  assert.match(html, /object-fit:cover/);
  assert.doesNotMatch(html, /translateY/);
});

test('flashOpacity keeps its values at 25 fps and ShutterFlash lasts the same time at 50 fps', () => {
  const kit = kitAt(0);
  assert.equal(kit.flashOpacity(9, 10), 0);
  assert.ok(kit.flashOpacity(10, 10) > kit.flashOpacity(13, 10));
  assert.equal(kit.flashOpacity(16, 10), 0);
  assert.notEqual(render(React.createElement(kitAt(21, { fps: 50 }).ShutterFlash, { at: 10 })), '');
  assert.equal(render(React.createElement(kitAt(22, { fps: 50 }).ShutterFlash, { at: 10 })), '');
});
```

Дополнительно закрепить: хром `BrowserFrame` масштабируется с `k = короткая сторона / 1080` (`scale`
переопределяет), частичные `colors` сливаются с `BROWSER_COLORS`, адрес в «таблетке» — `sans-serif` по
умолчанию и обрезается многоточием (`display: block`).

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-components.test.js`
Expected: FAIL — `kit.scrollShare is not a function`.

- [ ] **Step 3: Реализовать**

```js
// src/motion-kit/screen.js
import { EASE, prog } from './motion.js';
import { ref25 } from './time.js';

export const BROWSER_COLORS = Object.freeze({ bar: '#1f2328', text: '#c9d1d9', page: '#ffffff' });
export const FLASH_FRAMES = 6; // эталонные кадры 25 fps

// Доля страницы 0..1 к концу окна [from, to]; scroll клэмпится в [0, 1].
export function scrollShare(frame, from, to, scroll = 1) {
  const share = Math.min(1, Math.max(0, scroll));
  return share * prog(frame, from, Math.max(1, to - from), EASE.inOut);
}

// frame/at — кадры композиции; frames — эталонные кадры 25 fps, переводятся через fps здесь же.
export function flashOpacity(frame, at, fps = 25, frames = FLASH_FRAMES) {
  const span = ref25(frames, fps);
  if (frame < at || frame >= at + span) return 0;
  return 0.6 * (1 - (frame - at) / span);
}
```

```jsx
// src/motion-kit/Screen.jsx
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { BROWSER_COLORS, FLASH_FRAMES, flashOpacity, scrollShare } from './screen.js';

const DOTS = ['#ff5f57', '#febc2e', '#28c840'];

// Нейтральное окно браузера для настоящих скриншотов. Размеры хрома (radius, полоса, точки, адрес)
// заданы в px эталона 1080 и умножаются на k = короткая сторона / 1080; scale — явный override.
export function BrowserFrame({ url, children, colors = {}, radius = 22, scale, fontFamily = 'sans-serif' }) {
  const { width, height } = useVideoConfig();
  const k = scale ?? Math.min(width, height) / 1080;
  const c = { ...BROWSER_COLORS, ...colors };
  const px = (value) => Math.round(value * k * 10) / 10;
  return (
    <div style={{ width: '100%', height: '100%', borderRadius: px(radius), overflow: 'hidden', background: c.page,
      boxShadow: `0 ${px(24)}px ${px(60)}px rgba(0,0,0,.35)`, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: px(64), flexShrink: 0, background: c.bar, display: 'flex', alignItems: 'center', gap: px(12), padding: `0 ${px(20)}px` }}>
        {DOTS.map((color) => <span key={color} style={{ width: px(16), height: px(16), borderRadius: px(8), background: color }} />)}
        <span style={{ marginLeft: px(16), flex: 1, height: px(36), borderRadius: px(18), background: 'rgba(255,255,255,.08)', color: c.text,
          fontFamily, fontSize: px(22), display: 'block', lineHeight: `${px(36)}px`, padding: `0 ${px(18)}px`,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{url}</span>
      </div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

// Скриншот заполняет окно (cover) и едет долей страницы через objectPosition — физически не может
// уехать мимо своего низа. Широкий скриншот по вертикали не прокручивается, а обрезается по бокам.
export function ScrollShot({ src, from, to, scroll = 1 }) {
  const frame = useCurrentFrame();
  const p = scrollShare(frame, from, to, scroll);
  return (
    <Img src={staticFile(src)} style={{
      position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
      objectPosition: `50% ${(100 * p).toFixed(2)}%`,
    }} />
  );
}

// at — кадр композиции; в слое это hitFrame звука затвора (см. шаблон, Task 29).
export function ShutterFlash({ at, frames = FLASH_FRAMES }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = flashOpacity(frame, at, fps, frames);
  return opacity > 0 ? <AbsoluteFill style={{ background: '#ffffff', opacity }} /> : null;
}
```

`core.js`: добавить `export * from './screen.js';`. `index.js`: добавить
`export { BrowserFrame, ScrollShot, ShutterFlash } from './Screen.jsx';`.

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-components.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/screen.js src/motion-kit/Screen.jsx src/motion-kit/core.js src/motion-kit/index.js tests/motion-kit-components.test.js
git commit -m "feat: add motion-kit screenshot card parts"
```

### Task 17: Звуковая дорожка `SfxTrack`

Громкость — чистая функция в `sfx.js`: хвост затухает одно и то же время на любом fps, `cue.vol` не
поднимает уровень выше самого звука, неверный `sfxMasterDb` останавливает рендер на кадре 0, а не на
первом звуке.

**Files:**
- Create: `src/motion-kit/SfxTrack.jsx`
- Modify: `src/motion-kit/sfx.js` (`dbToGain`, `cueVolume`, `assertMasterDb`), `src/motion-kit/index.js`
- Test: `tests/motion-kit-components.test.js`, `tests/motion-kit-sfx.test.js` (дописать)

- [ ] **Step 1: Дописать тест**

```js
test('SfxTrack plays each kept cue at -5 dB by default and fades its tail', () => {
  const kit = kitAt(0);
  const cue = { id: 'whoosh-in@100', file: 'sfx/whoosh-in.wav', startFrame: 90, durationFrames: 30, vol: 0.7 };
  assert.ok(Math.abs(kit.cueVolume(cue, 0) - 0.7 * 10 ** (-5 / 20)) < 1e-9);
  assert.ok(Math.abs(kit.cueVolume(cue, 29) - 0.7 * 10 ** (-5 / 20) * 0.2) < 1e-9);
  assert.ok(Math.abs(kit.cueVolume(cue, 0, 0) - 0.7) < 1e-9);
  const html = render(React.createElement(kit.SfxTrack, { cues: [cue, { ...cue, id: 'b', startFrame: 200 }] }));
  assert.equal((html.match(/<audio/g) || []).length, 2);
  assert.match(html, /data-sequence-from="90" data-sequence-duration="30"/);
  assert.match(html, /src="\/static\/sfx\/whoosh-in\.wav"/);
});

test('cueVolume clamps cue.vol, rejects a bad masterDb, and SfxTrack fails on render before any cue plays', () => {
  const kit = kitAt(0);
  const cue = { id: 'x@0', file: 'sfx/x.wav', startFrame: 0, durationFrames: 30, vol: 1.8 };
  assert.ok(Math.abs(kit.cueVolume(cue, 0, 0) - 1) < 1e-9);
  for (const bad of [3, null, NaN]) assert.throws(() => kit.cueVolume(cue, 0, bad), /layer\.json → sfxMasterDb/);
  assert.throws(() => render(React.createElement(kit.SfxTrack, { cues: [], masterDb: 3 })), /sfxMasterDb/);
});
```

Дополнительно закрепить: на 50 fps хвост 60-кадрового звука затухает за последние 10 кадров (то же
время, что 5 кадров на 25 fps); `SfxTrack` передаёт в `cueVolume` и `masterDb`, и fps композиции.

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-components.test.js tests/motion-kit-sfx.test.js`
Expected: FAIL — `kit.cueVolume is not a function`.

- [ ] **Step 3: Реализовать**

```js
// src/motion-kit/sfx.js (дописать)
export const dbToGain = (db) => 10 ** (db / 20);

// masterDb −5 — утверждённый уровень эффектов; движок затем подмешивает звук слоя ещё на −18 dB
// (audioMode "mix", D5/D6). undefined держит дефолт −5; null и всё, что не конечное число ≤ 0, — ошибка.
export function assertMasterDb(masterDb) {
  if (!(Number.isFinite(masterDb) && masterDb <= 0)) {
    throw new Error(`layer.json → sfxMasterDb должен быть конечным числом ≤ 0 (по умолчанию −5 дБ) — получено ${String(masterDb)}`);
  }
}

// fade — ref25(5, fps) эталонных кадров: одинаковое время затухания на любом fps.
export function cueVolume(cue, localFrame, masterDb = -5, fps = 25) {
  assertMasterDb(masterDb);
  const vol = Math.min(1, Math.max(0, cue.vol));
  const fade = Math.max(1, Math.min(ref25(5, fps), Math.floor(cue.durationFrames / 3)));
  const tail = Math.min(1, Math.max(0, (cue.durationFrames - localFrame) / fade));
  return vol * dbToGain(masterDb) * tail;
}
```

```jsx
// src/motion-kit/SfxTrack.jsx
import { Audio, Sequence, staticFile, useVideoConfig } from 'remotion';
import { assertMasterDb, cueVolume } from './sfx.js';

// Одна Sequence на каждый звук из compiled.cues.kept. masterDb проверяется сразу: в Remotion volume()
// зовётся только пока Sequence звука активна, и ошибка иначе всплыла бы через минуты рендера.
export function SfxTrack({ cues, masterDb = -5 }) {
  assertMasterDb(masterDb);
  const { fps } = useVideoConfig();
  return (
    <>
      {cues.map((cue) => (
        <Sequence key={cue.id} from={cue.startFrame} durationInFrames={cue.durationFrames} layout="none">
          <Audio src={staticFile(cue.file)} volume={(f) => cueVolume(cue, f, masterDb, fps)} />
        </Sequence>
      ))}
    </>
  );
}
```

`index.js`: добавить `export { SfxTrack } from './SfxTrack.jsx';` (`cueVolume`, `dbToGain`,
`assertMasterDb` — через `core.js`).

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-components.test.js tests/motion-kit-sfx.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/SfxTrack.jsx src/motion-kit/sfx.js src/motion-kit/index.js tests/motion-kit-components.test.js tests/motion-kit-sfx.test.js
git commit -m "feat: add motion-kit SfxTrack"
```

### Task 18: Субтитры и загрузка шрифтов

Видимость субтитра — по кадру, одной чистой функцией `captionSpans` для `Subtitles` и `buildManifest`:
гейт видит ровно те кадры, где текст нарисован, включая вырезанные окна `hide`. Строка всегда одна
(`nowrap`), кегль подгоняется по ширине полосы только после загрузки шрифта. `FontLoader` — гейт: он
оборачивает весь слой и не пускает детей в кадр, пока шрифты не загрузились.

**Files:**
- Create: `src/motion-kit/Subtitles.jsx`, `src/motion-kit/FontLoader.jsx`, `tests/motion-kit-render.test.js` (по флагу)
- Modify: `src/motion-kit/captions.js`, `src/motion-kit/manifest.js`, `src/motion-kit/compile.js`, `src/motion-kit/index.js`
- Test: `tests/motion-kit-components.test.js`, `tests/motion-kit-captions.test.js`, `tests/motion-kit-manifest.test.js`, `tests/motion-kit-compile.test.js` (дописать)

- [ ] **Step 1: Дописать тест**

```js
test('Subtitles show the active chunk with karaoke dimming and respect hide windows', () => {
  const kit = kitAt(0);
  const chunks = [{ units: [{ t: 'Раз', s: 0, e: 0.3 }, { t: 'два', s: 0.4, e: 0.6 }], s: 0, e: 0.6, show: 1, text: 'Раз два' }];
  assert.equal(kit.activeChunk(chunks, 0.5, [], 25).text, 'Раз два');
  assert.equal(kit.activeChunk(chunks, 1.2, [], 25), null);
  assert.equal(kit.activeChunk(chunks, 0.5, [{ from: 0.4, to: 0.9 }], 25), null);
  assert.throws(() => kit.activeChunk(chunks, 0.5), /activeChunk: fps/);
  const lane = { x: 70, y: 1398, w: 880, h: 84 };
  const html = render(React.createElement(kitAt(5).Subtitles, { chunks, lane }));
  assert.match(html, /data-kit-text="captions"/);
  assert.match(html, /white-space:nowrap/);
  assert.match(html, /opacity:1">Раз/);
  assert.match(html, /opacity:0\.45">.*два/);
});

test('FontLoader delays the render and, without a DOM (SSR/tests), renders its children at once', () => {
  const calls = {};
  const html = render(React.createElement(kitAt(0, { calls }).FontLoader, { faces: [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }] },
    React.createElement('span', null, 'hi')));
  assert.equal(calls.delay, 1);
  assert.match(html, /<span>hi<\/span>/);
});
```

```js
// tests/motion-kit-manifest.test.js (дописать; cfg и plan — из теста Task 12)
test('captions.hide splits a single chunk into caption-N/caption-Nb, and a hide window covering it fully drops it', () => {
  const words = [{ w: 'Раз', t: 'Раз', s: 0.1, e: 0.3 }, { w: 'два', t: 'два', s: 0.4, e: 0.6 }]; // один chunk
  const captionsOf = (hide) => kit.buildManifest(kit.compileLayer({ ...plan, items: [], captions: { hide } }, { ...cfg, words }))
    .texts.filter((t) => t.id.startsWith('caption-'));
  const [first, second] = captionsOf([{ from: 0.3, to: 0.4 }]);
  assert.deepEqual([first.id, second.id], ['caption-1', 'caption-1b']);
  assert.ok(first.until <= second.from);
  assert.equal(captionsOf([{ from: 0, to: 2 }]).length, 0);
});
```

Дополнительно закрепить: `captionSpans(chunks, {hide, fps, durationInFrames})` — `secToFrame`, клэмп
концом ролика, два chunk никогда не делят кадр, окно `hide` в секундах вставки вырезает ровно её кадры,
без fps/durationInFrames — явная ошибка; кадры `Subtitles` совпадают с `caption-*` манифеста на 25 и
30 fps; первое слово горит с первого видимого кадра; кегль и тень — от разрешения (`44·k`), а не от
высоты полосы; `accentWords` сравниваются через `normWord`; `compileLayer` отклоняет `captions.hide` с
`from ≥ to` или нечисловыми границами; `FontLoader` без детей в браузере бросает ошибку, регистрирует
`FontFace` в `document.fonts` синхронно (до `load()`), не добавляет одинаковое лицо повторно при
ремаунте и отпускает `delayRender`, если размонтирован до загрузки шрифтов.

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-components.test.js tests/motion-kit-captions.test.js tests/motion-kit-manifest.test.js`
Expected: FAIL — `kit.Subtitles` не определён.

- [ ] **Step 3: Реализовать**

`captions.js` — чистые функции (Node, `plan.js`, манифест):

```js
// Кадры видимости: [{index, from, until}] — индекс chunk и его кусок после вырезания hide.
// fps — положительное конечное число, durationInFrames — конечное число или Infinity, иначе Error.
export function captionSpans(chunks, { hide = [], fps, durationInFrames } = {}) { /* … */ }

// Секунды → тот же кадр, что видит captionSpans. fps обязателен (без дефолта 25).
export function activeChunk(chunks, sec, hide = [], fps) { /* … */ }

// Только уменьшает base под тесную полосу: lineHeight 1,1 + запас под тень 12/44.
export function captionFontSize({ base, laneH }) { /* Math.min(base, laneH / (1.1 + 12 / 44)) */ }

// Ширина одной строки: base влезает — base без лишних замеров; иначе бинарный поиск от 60 % base
// (round1) до base с шагом 0,25 и результат floor(low·4)/4; даже 60 % не влезает — Error с текстом chunk.
export function fitCaptionWidth({ base, available, text, measure }) { /* … */ }
export function narrowFitBounds({ low, high, fits }) { /* один шаг поиска */ }
export const round1 = (value) => Math.round(value * 10) / 10;
```

`manifest.js` — субтитры из `captionSpans(chunks, {hide, fps, durationInFrames})`: первый кусок chunk
получает `caption-<n>`, следующие после окна `hide` — `caption-<n>b`, `caption-<n>c`…; у всех один
`static` — прямоугольник полосы. `compile.js` — каждое окно `captions.hide[i]` обязано иметь конечные
`from < to` в секундах, иначе `Error('captions.hide[i]: нужны конечные from < to в секундах …')`.

`src/motion-kit/Subtitles.jsx` — `Subtitles({ chunks, lane, hide = [], fontFamily = 'sans-serif', fontSize,
color = '#ffffff', dimOpacity = 0.45, accent = null, accentWords = [] })` и `firstFontFamily(fontFamily)`:

- стоит на верхнем уровне композиции (не внутри чужой `<Sequence>`): кадр и `durationInFrames` — глобальные;
- видимый chunk — `captionSpans(chunks, {hide, fps, durationInFrames})` по текущему кадру; слово горит с
  кадра `secToFrame(unit.s, fps)`, ещё не сказанные — с `dimOpacity`;
- `k = width / (height > width ? 1080 : 1920)`, `base = fontSize ?? 44 * k`,
  `size = round1(captionFontSize({ base, laneH: lane.h }))`, тень `0 size·3/44 size·12/44`;
- полоса `data-kit-text="captions"` с `overflow: hidden`, текст `whiteSpace: 'nowrap'`, `fontWeight: 800`;
- `useLayoutEffect` по `[chunk?.text, lane.w, size, shadowBlur, fontFamily]`: синхронно сбрасывает кегль к
  `size`, берёт `delayRender`, ждёт `document.fonts.load('800 <size>px "<первое семейство>"')`, затем
  `fitCaptionWidth` с `available = lane.w − 2·shadowBlur`; ошибка — `cancelRender`, `continueRender` в
  `finally` и в очистке эффекта;
- `accentWords` сравниваются через `normWord` (регистр, «ё», хвостовая пунктуация).

`src/motion-kit/FontLoader.jsx`:

```jsx
// Гейт шрифтов: оборачивает всё, что ждёт шрифт. Дети не рисуются, пока faces не загрузились; всё это
// время Remotion держит кадр через delayRender. Без document (SSR/тесты) дети рисуются сразу.
// faces — модульная константа: регистрация и загрузка — один раз на монтирование.
export function FontLoader({ faces, children }) { /* в браузере без children — Error «FontLoader: не передан children…» */ }

// Синхронно: каждый FontFace сразу в fontSet (до load()), затем load() — из инициализатора useState, до
// любого layout-эффекта в дереве. Реестр по fontSet (ключ family+file+weight) отдаёт уже
// зарегистрированное лицо: ремаунт не добавляет дубликат. Один family без явного weight дважды — Error.
export function registerFontFaces(faces, { FontFaceImpl, fontSet, toUrl }) { /* → [{face, promise}] */ }
export function settleFontFaces(registered) { /* ждёт все load(), ошибка — с family и file */ }
export function loadFontFaces(faces, deps) { /* register + settle одним промисом */ }
// Эффект монтирования: готово → onReady, сбой → onError; очистка отменяет оба и зовёт release —
// размонтированный до загрузки гейт отпускает delayRender.
export function watchFontFaces(registered, { onReady, onError, release }) { /* → cleanup */ }
export function settleOnce() { /* continueRender на один handle — только один раз */ }
```

Использование в слое — `<FontLoader faces={FONTS}>…весь слой…</FontLoader>`, где
`const FONTS = [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }, …]` объявлен на уровне модуля.

`tests/motion-kit-render.test.js` — настоящий бандл и headless Chromium, включается
`AUTOMONTAGE_TEST_MOTION_RENDER=1` (по умолчанию `skipped`): concurrent-рендер 40 кадров с chunk от кадра 2
для заглавной фразы и для строчной при `fontSize: 60` — кегль одинаков на каждом кадре, текст не обрезан,
а кегль совпадает с независимым эталонным поиском в пределах 0,1 px; `FontLoader` рядом с `Subtitles`
(без детей) валит настоящий рендер явной ошибкой.

`index.js`: добавить `export { Subtitles, firstFontFamily } from './Subtitles.jsx';` и
`export { FontLoader, loadFontFaces, registerFontFaces, settleFontFaces, settleOnce, watchFontFaces } from './FontLoader.jsx';`
(`captionSpans`, `activeChunk`, `fitCaptionWidth`, `captionFontSize` — через `core.js`).

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-*.test.js`, затем `AUTOMONTAGE_TEST_MOTION_RENDER=1 node --test tests/motion-kit-render.test.js`
Expected: PASS; тест по флагу — 3 теста примерно за 10 с.

- [ ] **Step 5: Коммит**

```bash
git add src/motion-kit/Subtitles.jsx src/motion-kit/FontLoader.jsx src/motion-kit/captions.js src/motion-kit/manifest.js src/motion-kit/compile.js src/motion-kit/index.js tests/motion-kit-components.test.js tests/motion-kit-captions.test.js tests/motion-kit-manifest.test.js tests/motion-kit-compile.test.js tests/motion-kit-render.test.js
git commit -m "feat: add motion-kit subtitles and font loader"
```

## Фаза 5. Kit и слой в Node

### Task 19: Загрузка kit и манифест слоя без рендера

**Files:**
- Create: `scripts/motion-kit-node.js`
- Test: `tests/motion-kit-node.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-node.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildLayerManifest, loadKitCore } = require('../scripts/motion-kit-node');

function writeLayer(dir, plan) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'layer.json'), JSON.stringify({ version: 1, composition: 'Layer', fps: 25, width: 1080,
    height: 1920, durationInFrames: 250, face: { x: 540, y: 787 }, profile: 'avatar', sfxMasterDb: -5, speaker: { src: 'speaker.mp4', lastFrame: 249 } }));
  fs.writeFileSync(path.join(dir, 'src/words.js'), 'export default [{"w":"Привет","t":"Привет","s":0.2,"e":0.6}];\n');
  fs.writeFileSync(path.join(dir, 'src/sfx-library.js'), 'export default {"sounds":{}};\n');
  fs.writeFileSync(path.join(dir, 'src/plan.js'), plan);
}

test('kit core loads in Node with the real Remotion math', () => {
  const kit = loadKitCore();
  assert.equal(typeof kit.compileLayer, 'function');
  assert.equal(kit.secToFrame(2, 25), 50);
});

test('a layer outside the engine folder compiles to a manifest from its plan', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-layer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, `import { autoShots } from '@automontage/motion-kit/core';
export default function buildPlan({ words, face, durationInFrames, fps }) {
  return { camera: { face, shots: autoShots(words, { endSec: durationInFrames / fps }) }, items: [] };
}\n`);
  const manifest = buildLayerManifest(dir);
  assert.equal(manifest.camera.s.length, 250);
  assert.equal(manifest.texts[0].id, 'caption-1');
});

test('broken layers explain what is missing or failing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-layer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => buildLayerManifest(dir), /нет layer\.json/);
  writeLayer(dir, 'export default function buildPlan() { return { camera: { shots: [] }, items: [] }; }\n');
  assert.throws(() => buildLayerManifest(dir), /camera\.face/);
  writeLayer(dir, 'export default function buildPlan( {\n');
  assert.throws(() => buildLayerManifest(dir), /не собирается plan\.js/);
});
```

Субтитры манифеста считает `captionSpans` (Task 18): единственный кусок фикстуры (слово 0,2–0,6 с, без
`hide`) даёт ровно `caption-1` на кадрах 5–25, поэтому `texts[0].id === 'caption-1'` (карточек нет).

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-node.test.js`
Expected: FAIL — `Cannot find module '../scripts/motion-kit-node'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/motion-kit-node.js
// Kit и проектный слой в Node: тот же код, что рендерит Remotion, собирается esbuild в CommonJS.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { MOTION_KIT_ALIAS, MOTION_KIT_DIR } = require('./remotion-webpack');

const ENGINE_ROOT = path.join(__dirname, '..');
const LAYER_FILES = ['layer.json', 'src/plan.js', 'src/words.js', 'src/sfx-library.js'];

function bundle(contents, resolveDir, sourcefile) {
  return buildSync({
    stdin: { contents, resolveDir, sourcefile, loader: 'js' },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['remotion'],
    alias: { [MOTION_KIT_ALIAS]: MOTION_KIT_DIR },
    logLevel: 'silent',
  }).outputFiles[0].text;
}

// 'remotion' остаётся внешним и берётся из node_modules движка, где бы ни лежал слой.
function evaluate(text, filename) {
  const compiled = new Module(filename, module);
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

function buildLayerManifest(layerDir) {
  const name = path.basename(layerDir);
  for (const file of LAYER_FILES) {
    if (!fs.existsSync(path.join(layerDir, file))) {
      throw new Error(`слой ${name}: нет ${file} (слой создаётся командой automontage layer new)`);
    }
  }
  const at = (file) => JSON.stringify(path.join(layerDir, file));
  const entry = [
    `import layer from ${at('layer.json')};`,
    `import words from ${at('src/words.js')};`,
    `import sfxLibrary from ${at('src/sfx-library.js')};`,
    `import buildPlan from ${at('src/plan.js')};`,
    `import { buildManifest, compileLayer } from '${MOTION_KIT_ALIAS}/core';`,
    'export function manifest() {',
    '  const ctx = { ...layer, words, sfxLibrary };',
    '  return buildManifest(compileLayer(buildPlan(ctx), ctx));',
    '}',
  ].join('\n');
  let text;
  try {
    text = bundle(entry, layerDir, 'layer-manifest.js');
  } catch (error) {
    throw new Error(`слой ${name}: не собирается plan.js — ${error.errors?.[0]?.text || error.message}`);
  }
  return evaluate(text, path.join(layerDir, 'src', 'plan.js')).manifest();
}

module.exports = { buildLayerManifest, loadKitCore };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-node.test.js`
Expected: PASS (3 теста).

- [ ] **Step 5: Коммит**

```bash
git add scripts/motion-kit-node.js tests/motion-kit-node.test.js
git commit -m "feat: load motion layers and build gate manifests in Node"
```

## Фаза 6. QA-гейты

### Task 20: Профили порогов и отчёт

**Files:**
- Create: `scripts/qa/profiles.js`, `scripts/qa/report.js`
- Test: `tests/qa-report.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/qa-report.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getProfile, WAIVABLE } = require('../scripts/qa/profiles');
const { applyWaivers, buildReport, exitCodeFor, formatReport, gate, writeReport } = require('../scripts/qa/report');

test('profiles keep ordered voice-music corridors and share the rhythm rule', () => {
  for (const name of ['avatar', 'live']) {
    const v = getProfile(name).voiceMusic;
    assert.ok(v.stopLow < v.warnLow && v.warnLow < v.target && v.target < v.warnHigh && v.warnHigh < v.stopHigh, name);
    assert.deepEqual(getProfile(name).rhythm, { stopSec: 2.5, warnSec: 2.2 });
  }
  assert.throws(() => getProfile('tiktok'), /неизвестный профиль проверок «tiktok»/);
  assert.deepEqual([...WAIVABLE], ['G1', 'G4', 'G11']);
});

test('waivers need a reason and only soften waivable gates', () => {
  const gates = [gate('G1', 'Ритм спикера', { status: 'fail' }), gate('G5', 'Safe-zone текста', { status: 'fail' }), gate('G4', 'Спикер в первые 3 с', { status: 'fail' })];
  const out = applyWaivers(gates, [{ gate: 'G1', reason: 'правка владельца: пауза на эмоции' }, { gate: 'G5', reason: 'хочу' }, { gate: 'G4', reason: ' ' }]);
  assert.deepEqual(out.map((g) => g.status), ['waived', 'fail', 'fail']);
  assert.match(out[0].hint, /исключение: правка владельца/);
});

test('report summary, exit codes and the Russian text', () => {
  const report = buildReport({ kind: 'layer-check', profile: 'avatar', now: new Date('2026-01-01T00:00:00Z'), gates: [
    gate('G1', 'Ритм спикера', { status: 'fail', value: 5, unit: 'с', threshold: '≤ 2,5 с', spans: [{ fromSec: 0, toSec: 5, note: 'план 5 с без события' }], hint: 'разбейте план' }),
    gate('G9', 'Плотность звуков', { status: 'warn' }),
  ] });
  assert.deepEqual(report.summary, { status: 'fail', fail: 1, warn: 1 });
  assert.equal(exitCodeFor(report), 1);
  assert.equal(exitCodeFor({ ...report, error: 'нет файла' }), 2);
  assert.equal(exitCodeFor(buildReport({ kind: 'x', profile: 'avatar', gates: [gate('G9', 'x', { status: 'warn' })] })), 0);
  const text = formatReport(report);
  assert.match(text, /СТОП/);
  assert.match(text, /❌ G1 Ритм спикера: 5 с \(порог ≤ 2,5 с\)/);
  assert.match(text, /0:00,00–0:05,00 план 5 с без события/);
  assert.match(text, /→ разбейте план/);
});

test('reports land in <project>/qa and reject unsafe names', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [] });
  const paths = writeReport(dir, 'layer-motion-v01-check', report);
  assert.equal(JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8')).kind, 'layer-check');
  assert.ok(fs.readFileSync(paths.textPath, 'utf8').includes('всё хорошо'));
  assert.throws(() => writeReport(dir, '../escape', report), /имя отчёта/);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/qa-report.test.js`
Expected: FAIL — `Cannot find module '../scripts/qa/profiles'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/qa/profiles.js
// Пороги гейтов. avatar — голос HeyGen/ElevenLabs и слой kit; live — живая запись с микрофона.
// Коридор avatar.voiceMusic калибруется по утверждённому эталонному preview (см. DECISIONS).
const BASE = Object.freeze({
  rhythm: { stopSec: 2.5, warnSec: 2.2 },
  camera: { jumpScale: 0.15, shiftPx: 85, punchScale: 0.1, weakScale: 0.06, sharpBlurPx: 6, eatenPunch: 1.05 },
  scale: { max: 1.25 },
  hook: { sec: 3 },
  donor: { maxSec: 3 },
  stock: { min: 3, minShort: 2, shortSec: 45 },
  sfx: { minGapSec: 0.3, notableGapSec: 1.0, sceneFadeSec: 0.12 },
  leak: { stop: 0.6, windowWarn: 0.8, windowSec: 5, silentDb: -60 },
  duration: { toleranceFrames: 1 },
});

const PROFILES = Object.freeze({
  avatar: { ...BASE, voiceMusic: { stopLow: 3, warnLow: 9, target: 12, warnHigh: 15, stopHigh: 20 } },
  live: { ...BASE, voiceMusic: { stopLow: 6, warnLow: 12, target: 15, warnHigh: 18, stopHigh: 24 } },
});

const WAIVABLE = Object.freeze(['G1', 'G4', 'G11']);

function getProfile(name = 'avatar') {
  if (!Object.hasOwn(PROFILES, name)) throw new Error(`неизвестный профиль проверок «${name}»: используй avatar или live`);
  return PROFILES[name];
}

module.exports = { PROFILES, WAIVABLE, getProfile };
```

```js
// scripts/qa/report.js
const fs = require('node:fs');
const path = require('node:path');
const { WAIVABLE } = require('./profiles');

const ICONS = { pass: '✅', warn: '⚠️', fail: '❌', waived: '☑️', skipped: '⏭️' };
const KIND_TITLES = { 'layer-check': 'план слоя', 'layer-render': 'рендер слоя', preview: 'preview' };
const REPORT_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/u;

function gate(id, title, fields = {}) {
  return { id, title, status: 'pass', value: null, threshold: null, unit: '', spans: [], hint: '', ...fields };
}

function summarize(gates) {
  const fail = gates.filter((g) => g.status === 'fail').length;
  const warn = gates.filter((g) => g.status === 'warn').length;
  return { status: fail ? 'fail' : warn ? 'warn' : 'pass', fail, warn };
}

function applyWaivers(gates, waivers = [], waivable = WAIVABLE) {
  return gates.map((g) => {
    const waiver = waivers.find((w) => w.gate === g.id && String(w.reason || '').trim());
    if (g.status !== 'fail' || !waivable.includes(g.id) || !waiver) return g;
    return { ...g, status: 'waived', hint: `исключение: ${waiver.reason.trim()}` };
  });
}

function buildReport({ kind, profile, gates, inputs = [], layer = null, now = new Date(), error = null }) {
  return { version: 1, kind, layer, profile, createdAt: now.toISOString(), inputs, gates, summary: summarize(gates), error };
}

function exitCodeFor(report) {
  if (report.error) return 2;
  return report.summary.status === 'fail' ? 1 : 0;
}

const number = (value) => (typeof value === 'number' ? String(Number(value.toFixed(2))).replace('.', ',') : String(value));
const clock = (sec) => {
  const minutes = Math.floor(sec / 60);
  return `${minutes}:${(sec - minutes * 60).toFixed(2).padStart(5, '0').replace('.', ',')}`;
};

function formatReport(report) {
  const verdict = report.summary.status === 'fail' ? 'СТОП' : report.summary.status === 'warn' ? 'есть предупреждения' : 'всё хорошо';
  const lines = [`Проверки (${KIND_TITLES[report.kind] || report.kind}): ${verdict}`];
  if (report.error) lines.push(`❌ Оценить нельзя: ${report.error}`);
  for (const g of report.gates) {
    const value = g.value === null || g.value === undefined ? '' : `: ${number(g.value)}${g.unit ? ` ${g.unit}` : ''}`;
    const threshold = g.threshold ? ` (порог ${g.threshold})` : '';
    lines.push(`${ICONS[g.status]} ${g.id} ${g.title}${value}${threshold}`);
    for (const span of g.spans.slice(0, 3)) lines.push(`   ${clock(span.fromSec)}–${clock(span.toSec)} ${span.note || ''}`.trimEnd());
    if (g.hint && g.status !== 'pass') lines.push(`   → ${g.hint}`);
  }
  return lines.join('\n');
}

function writeAtomic(file, text, fileSystem) {
  const temporary = `${file}.${process.pid}.tmp`;
  fileSystem.writeFileSync(temporary, text);
  fileSystem.renameSync(temporary, file);
}

function writeReport(projectDir, name, report, fileSystem = fs) {
  if (!REPORT_NAME.test(name)) throw new Error(`имя отчёта «${name}» недопустимо`);
  const dir = path.join(projectDir, 'qa');
  fileSystem.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${name}.json`);
  const textPath = path.join(dir, `${name}.txt`);
  writeAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`, fileSystem);
  writeAtomic(textPath, `${formatReport(report)}\n`, fileSystem);
  return { jsonPath, textPath };
}

module.exports = { applyWaivers, buildReport, exitCodeFor, formatReport, gate, summarize, writeReport };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/qa-report.test.js`
Expected: PASS (4 теста).

- [ ] **Step 5: Коммит**

```bash
git add scripts/qa/profiles.js scripts/qa/report.js tests/qa-report.test.js
git commit -m "feat: add QA gate profiles and reports"
```

### Task 21: G1 «Ритм спикера» и G2 «Слабые джамп-каты» — плохой случай «статичный план 5 с»

Событие камеры ищется по фактическому состоянию в каждом кадре, а не по объявленным планам:
джамп-кат — скачок масштаба ≥ 15 % или сдвиг лица ≥ 85 px × (короткая сторона / 1080) за 2 кадра;
панч-ин — рост масштаба ≥ 10 % за ≈ 0,24 с (6 кадров при 25 fps, `punchWindow`); смена резкости —
размытие пересекло 6 px или спикер ушёл/вернулся. Дрейф событием не считается. Слабый джамп-кат
(скачок 6–15 % за 2 кадра) — только предупреждение; первые кадры пружины панч-ина на него похожи,
поэтому слабые срабатывания ближе `punchWindow` к настоящему событию отбрасываются.
План — непрерывный отрезок резкого видимого спикера между событиями.

**Уточнения после ревью пакета 1:**
- Под cover-вставкой спикер возвращается резким и непрозрачным уже к началу её закрытия (Task 15): в
  манифесте kit `opacity = 1`, `blur = 0` с кадра `to − ref25(CLOSE_FRAMES)` (сток 2–4 с при 25 fps — с
  кадра 94, а не 100). Поэтому план после вставки начинается за 0,24 с до её конца и в G1 до 0,24 с
  длиннее, чем «от конца вставки». Это верно — лицо уже видно под сворачивающейся карточкой; эти кадры
  из плана не вычитать.
- Закрепить тестом на настоящем манифесте kit (`loadKitCore` из Task 19, тест ниже): сток 2–4 с, один
  статичный план — `speakerPlans` начинает план после вставки с кадра 94.
- При калибровке порогов 2,2/2,5 с (пробный слой, Task 49) учитывать эту добавку: план после вставки,
  упёршийся в порог, чинится событием (джамп-кат, панч-ин), а не порогом.

**Files:**
- Create: `scripts/qa/timeline-gates.js`
- Create: `tests/helpers/manifest-fixtures.js`
- Test: `tests/qa-timeline-gates.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/helpers/manifest-fixtures.js
// Синтетический манифест слоя: camera(f) → {s, dx, dy, blur, opacity, requested}.
function manifestFixture({ seconds = 10, fps = 25, camera = () => ({ s: 1 }), texts = [], inserts = [],
  cues = { kept: [], dropped: [] }, hook = 'speaker', waivers = [] } = {}) {
  const n = Math.round(seconds * fps);
  const cam = { s: [], requested: [], dx: [], dy: [], blur: [], opacity: [] };
  for (let f = 0; f < n; f += 1) {
    const c = { dx: 0, dy: 0, blur: 0, opacity: 1, ...camera(f) };
    cam.s.push(c.s); cam.requested.push(c.requested ?? c.s); cam.dx.push(c.dx); cam.dy.push(c.dy);
    cam.blur.push(c.blur); cam.opacity.push(c.opacity);
  }
  return { version: 1, kitVersion: 1, fps, width: 1080, height: 1920, durationInFrames: n, maxScale: 1.25,
    camera: cam, texts, inserts, cues, hook, waivers };
}

// Смена крупности W (1,00) ↔ M (1,18) каждые everySec секунд.
const cutsEvery = (everySec, fps = 25) => (f) => ({ s: Math.floor(f / (everySec * fps)) % 2 ? 1.18 : 1 });

module.exports = { cutsEvery, manifestFixture };
```

```js
// tests/qa-timeline-gates.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { getProfile } = require('../scripts/qa/profiles');
const { detectCameraEvents, gateRhythm, gateWeakCuts } = require('../scripts/qa/timeline-gates');
const { cutsEvery, manifestFixture } = require('./helpers/manifest-fixtures');

const avatar = getProfile('avatar');

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
  assert.deepEqual(detectCameraEvents(punch.camera, avatar.camera).events.map((e) => e.kind), ['punch']);
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
  const plans = speakerPlans(m.camera, detectCameraEvents(m.camera, avatar.camera), 25);
  assert.ok(plans.some((plan) => plan.from === 94), JSON.stringify(plans));
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/qa-timeline-gates.test.js`
Expected: FAIL — `Cannot find module '../scripts/qa/timeline-gates'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/qa/timeline-gates.js
// Гейты по манифесту слоя: считаются до рендера, за доли секунды.
const { gate } = require('./report');

const r2 = (value) => Math.round(value * 100) / 100;
const fmt = (value) => String(r2(value)).replace('.', ',');
const span = (fromFrame, toFrame, fps, note) => ({ fromSec: r2(fromFrame / fps), toSec: r2(toFrame / fps), note });
const factor = (a, b) => (a > b ? a / b : b / a);

// scale — короткая сторона кадра / 1080: порог сдвига лица 85 px задан для кадра 1080×1920.
// fps — окно панч-ина 6 кадров задано для 25 fps (пружина kit живёт в секундах).
function detectCameraEvents(camera, t, scale = 1, fps = 25) {
  const n = camera.s.length;
  const shiftPx = t.shiftPx * scale;
  const punchWindow = Math.max(1, Math.round((6 * fps) / 25));
  const sharp = (f) => camera.opacity[f] >= 0.99 && camera.blur[f] < t.sharpBlurPx;
  const events = [];
  const weak = [];
  for (let f = 1; f < n; f += 1) {
    const b2 = Math.max(0, f - 2);
    const b6 = Math.max(0, f - punchWindow);
    const jump = factor(camera.s[f], camera.s[b2]);
    const shift = Math.max(Math.abs(camera.dx[f] - camera.dx[b2]), Math.abs(camera.dy[f] - camera.dy[b2]));
    if (sharp(f) !== sharp(f - 1)) events.push({ frame: f, kind: 'focus' });
    else if (jump >= 1 + t.jumpScale || shift >= shiftPx) events.push({ frame: f, kind: 'cut' });
    else if (camera.s[f] / camera.s[b6] >= 1 + t.punchScale) events.push({ frame: f, kind: 'punch' });
    else if (jump >= 1 + t.weakScale) weak.push({ frame: f, ratio: camera.s[f] / camera.s[b2] });
  }
  const collapse = (list) => list.filter((e, i) => i === 0 || e.frame - list[i - 1].frame > 2);
  const kept = collapse(events);
  const nearEvent = (w) => events.some((e) => Math.abs(e.frame - w.frame) <= punchWindow);
  return { events: kept, weak: collapse(weak.filter((w) => !nearEvent(w))), sharp };
}

function speakerPlans(camera, detected, fps) {
  const cuts = new Set(detected.events.map((e) => e.frame));
  const plans = [];
  let start = null;
  for (let f = 0; f <= camera.s.length; f += 1) {
    const isSharp = f < camera.s.length && detected.sharp(f);
    if (start !== null && (!isSharp || cuts.has(f))) {
      plans.push({ from: start, to: f, sec: (f - start) / fps });
      start = null;
    }
    if (isSharp && start === null) start = f;
  }
  return plans.sort((a, b) => b.sec - a.sec);
}

const frameScale = (manifest) => Math.min(manifest.width, manifest.height) / 1080;

function gateRhythm(manifest, profile) {
  const { fps } = manifest;
  const plans = speakerPlans(manifest.camera, detectCameraEvents(manifest.camera, profile.camera, frameScale(manifest), manifest.fps), fps);
  const longest = plans[0]?.sec ?? 0;
  const { stopSec, warnSec } = profile.rhythm;
  const status = longest > stopSec + 1e-9 ? 'fail' : longest > warnSec + 1e-9 ? 'warn' : 'pass';
  return gate('G1', 'Ритм спикера', {
    status, value: r2(longest), unit: 'с', threshold: `≤ ${fmt(stopSec)} с`,
    spans: plans.filter((p) => p.sec > warnSec + 1e-9).slice(0, 5).map((p) => span(p.from, p.to, fps, `план ${fmt(p.sec)} с без события`)),
    hint: 'разбейте план: джамп-кат (≥ 15 % масштаба или сдвиг лица ≥ 85 px), панч-ин на общем плане, размытие под графикой или уход под вставку',
  });
}

function gateWeakCuts(manifest, profile) {
  const { weak } = detectCameraEvents(manifest.camera, profile.camera, frameScale(manifest), manifest.fps);
  return gate('G2', 'Слабые джамп-каты', {
    status: weak.length ? 'warn' : 'pass', value: weak.length, unit: 'шт.', threshold: '≥ 15 % или ≥ 85 px',
    spans: weak.slice(0, 5).map((w) => span(w.frame, w.frame + 1, manifest.fps, `скачок ${Math.round((factor(w.ratio, 1) - 1) * 100)} %`)),
    hint: 'такую смену зритель не видит: увеличьте разницу крупности или сдвиньте лицо в треть кадра',
  });
}

module.exports = { detectCameraEvents, gateRhythm, gateWeakCuts, speakerPlans };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/qa-timeline-gates.test.js`
Expected: PASS (5 тестов).

- [ ] **Step 5: Коммит**

```bash
git add scripts/qa/timeline-gates.js tests/helpers/manifest-fixtures.js tests/qa-timeline-gates.test.js
git commit -m "feat: add speaker rhythm and weak cut gates"
```

### Task 22: G3 «Масштаб», G4 «Спикер в первые 3 с», G10 «Сток», G11 «Чужое видео»

**Уточнения после ревью пакета 1:**
- Cover-вставка с 0 с закрывает лицо карточкой, а G4 без правки проходит: уход камеры гаснет не мгновенно
  (`CAMERA_DEFAULTS.away.enterFrames` = 8 кадров), и `opacity > 0.01` первых кадров засчитывается как
  «спикер виден». Правило: кадр внутри `[from, to)` вставки с `cover: true` — «спикер не виден», какой бы ни
  была `camera.opacity`.
- Для этого манифест несёт `cover` у вставок, а заодно `src` (его читает предупреждение о коротком стоке в
  Task 38): одно изменение `buildManifest` и контракта манифеста.

**Files:**
- Modify: `scripts/qa/timeline-gates.js`
- Modify: `src/motion-kit/manifest.js` (`cover` и `src` у вставок)
- Test: `tests/qa-timeline-gates.test.js` (дописать), `tests/motion-kit-manifest.test.js` (дописать)

- [ ] **Step 1: Дописать тест**

```js
const { gateDonor, gateHook, gateScale, gateStock } = require('../scripts/qa/timeline-gates');

test('scale above 1.25 stops, a punch eaten by the limit warns', () => {
  assert.equal(gateScale(manifestFixture({ camera: () => ({ s: 1.3 }) }), avatar).status, 'fail');
  assert.equal(gateScale(manifestFixture({ camera: () => ({ s: 1.25, requested: 1.36 }) }), avatar).status, 'warn');
  assert.equal(gateScale(manifestFixture({ camera: cutsEvery(2) }), avatar).status, 'pass');
});

test('speaker must be seen in the first 3 s unless the hook is an enumeration', () => {
  const hidden = { camera: (f) => ({ s: 1, opacity: f < 100 ? 0 : 1 }) };
  assert.equal(gateHook(manifestFixture(hidden), avatar).status, 'fail');
  assert.equal(gateHook(manifestFixture({ ...hidden, hook: 'enumeration' }), avatar).status, 'pass');
  assert.equal(gateHook(manifestFixture({ camera: (f) => ({ s: 1, blur: 20, opacity: f < 10 ? 1 : 0 }) }), avatar).status, 'pass');
});

test('stock count warns below the minimum for the video length', () => {
  const stock = (n) => Array.from({ length: n }, (_, i) => ({ id: `stock-${i + 1}`, kind: 'stock', from: i * 100, to: i * 100 + 50 }));
  assert.equal(gateStock(manifestFixture({ seconds: 60, inserts: stock(3) }), avatar).status, 'pass');
  assert.equal(gateStock(manifestFixture({ seconds: 60, inserts: stock(1) }), avatar).status, 'warn');
  assert.equal(gateStock(manifestFixture({ seconds: 30, inserts: stock(2) }), avatar).status, 'pass');
});

test('a donor clip longer than 3 s in a row stops the layer', () => {
  const donor = (from, to) => [{ id: 'donor-1', kind: 'donor', from, to }];
  assert.equal(gateDonor(manifestFixture({ inserts: donor(33, 85) }), avatar).status, 'pass');
  const g = gateDonor(manifestFixture({ inserts: donor(33, 133) }), avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 4);
});

test('BAD CASE: a cover insert from 0 s hides the speaker even while the camera is still fading out', () => {
  const insert = (cover, to = 80) => [{ id: 'stock-1', kind: 'stock', from: 0, to, cover }];
  assert.equal(gateHook(manifestFixture({ inserts: insert(true) }), avatar).status, 'fail');
  assert.equal(gateHook(manifestFixture({ inserts: insert(false) }), avatar).status, 'pass');
  assert.equal(gateHook(manifestFixture({ inserts: insert(true, 25) }), avatar).status, 'pass');
});
```

```js
// tests/motion-kit-manifest.test.js (дописать)
test('manifest inserts carry cover and src for the gates', () => {
  const m = kit.buildManifest(kit.compileLayer({ ...plan, inserts: [
    { kind: 'stock', from: 1, to: 2, src: 'stock/a.mp4' }, { kind: 'donor', from: 2.5, to: 3, src: 'donor.mp4' },
  ] }, cfg));
  assert.deepEqual(m.inserts, [
    { id: 'stock-1', kind: 'stock', from: 25, to: 50, cover: true, src: 'stock/a.mp4' },
    { id: 'donor-2', kind: 'donor', from: 63, to: 75, cover: false, src: 'donor.mp4' },
  ]);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/qa-timeline-gates.test.js tests/motion-kit-manifest.test.js`
Expected: FAIL — `gateScale is not a function`; в манифесте у вставок нет `cover`/`src`.

- [ ] **Step 3: Реализовать (дописать в `timeline-gates.js` и в `module.exports`)**

`src/motion-kit/manifest.js` — вставки в манифесте:

```js
inserts: compiled.inserts.map((insert) => ({ id: insert.id, kind: insert.kind, from: insert.from, to: insert.to, cover: insert.cover, src: insert.src })),
```

`timeline-gates.js`:

```js
function gateScale(manifest, profile) {
  const { s, requested } = manifest.camera;
  const max = s.reduce((m, v) => Math.max(m, v), 0);
  const eaten = [];
  requested.forEach((req, f) => { if (req / s[f] > profile.camera.eatenPunch) eaten.push(f); });
  const status = max > profile.scale.max + 1e-3 ? 'fail' : eaten.length ? 'warn' : 'pass';
  return gate('G3', 'Масштаб аватара', {
    status, value: Math.round(max * 1000) / 1000, threshold: `≤ ${fmt(profile.scale.max)}`,
    spans: eaten.length ? [span(eaten[0], eaten[eaten.length - 1] + 1, manifest.fps, 'панч-ин упёрся в предел')] : [],
    hint: status === 'fail' ? 'исходник аватара растянут из 720p: крупнее 1,25 будет мыло' : 'ставьте панч-ин на общем плане W',
  });
}

function gateHook(manifest, profile) {
  const frames = Math.min(manifest.durationInFrames, Math.round(profile.hook.sec * manifest.fps));
  const threshold = `спикер виден до ${fmt(profile.hook.sec)} с`;
  // Под cover-вставкой лицо закрыто карточкой, даже пока уход камеры ещё гаснет.
  const covered = (f) => manifest.inserts.some((i) => i.cover && f >= i.from && f < i.to);
  if (manifest.camera.opacity.slice(0, frames).some((o, f) => o > 0.01 && !covered(f))) return gate('G4', 'Спикер в первые 3 с', { threshold });
  if (manifest.hook === 'enumeration') {
    return gate('G4', 'Спикер в первые 3 с', { threshold, hint: 'хук-перечисление: спикер появляется после объектов' });
  }
  return gate('G4', 'Спикер в первые 3 с', {
    status: 'fail', threshold, spans: [span(0, frames, manifest.fps, 'спикера нет в кадре')],
    hint: 'покажите спикера хотя бы частью первых 3 с (можно размытым) или объявите hook: "enumeration"',
  });
}

function gateStock(manifest, profile) {
  const count = manifest.inserts.filter((i) => i.kind === 'stock').length;
  const seconds = manifest.durationInFrames / manifest.fps;
  const min = seconds < profile.stock.shortSec ? profile.stock.minShort : profile.stock.min;
  return gate('G10', 'Стоковые вставки', {
    status: count >= min ? 'pass' : 'warn', value: count, unit: 'шт.', threshold: `≥ ${min}`,
    hint: 'заполните пустые участки B-roll по смыслу фраз: automontage layer stock',
  });
}

function gateDonor(manifest, profile) {
  const { fps } = manifest;
  const long = manifest.inserts.filter((i) => i.kind === 'donor' && (i.to - i.from) / fps > profile.donor.maxSec + 1e-9);
  return gate('G11', 'Чужое видео', {
    status: long.length ? 'fail' : 'pass',
    value: long.length ? r2(Math.max(...long.map((i) => (i.to - i.from) / fps))) : 0, unit: 'с',
    threshold: `≤ ${fmt(profile.donor.maxSec)} с подряд`,
    spans: long.map((i) => span(i.from, i.to, fps, i.id)),
    hint: 'чужой ролик — только 2–3 с для контекста, дальше собственные анимации по смыслу',
  });
}
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/qa-timeline-gates.test.js tests/motion-kit-manifest.test.js`
Expected: PASS (10 тестов в `qa-timeline-gates.test.js`).

- [ ] **Step 5: Коммит**

```bash
git add scripts/qa/timeline-gates.js src/motion-kit/manifest.js tests/qa-timeline-gates.test.js tests/motion-kit-manifest.test.js
git commit -m "feat: add scale, hook, stock and donor gates"
```

### Task 23: G5 «Safe-zone текста» — плохой случай «текст за safe-zone»

**Files:**
- Modify: `scripts/qa/timeline-gates.js`
- Test: `tests/qa-timeline-gates.test.js` (дописать)

- [ ] **Step 1: Дописать тест**

```js
const { loadKitCore } = require('../scripts/motion-kit-node');
const { gateSafeZone } = require('../scripts/qa/timeline-gates');

test('BAD CASE: text at x=40 stops the layer and names the side', () => {
  const m = manifestFixture({ texts: [{ id: 'title', from: 0, frames: [[40, 300, 440, 400]] }] });
  const g = gateSafeZone(m);
  assert.equal(g.status, 'fail');
  assert.match(g.spans[0].note, /title: слева \+30 px/);
});

test('BAD CASE: an element inside at rest that flies in from the side is caught on entry frames', () => {
  const kit = loadKitCore();
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 100, words: [], sfxLibrary: { sounds: {} } };
  const plan = (from) => ({ captions: false, camera: { face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }] },
    items: [{ id: 'card', kind: 'card', at: 1, until: 3, box: { x: 100, y: 300, w: 400, h: 100 }, enter: { kind: 'fly', from } }] });
  const bad = gateSafeZone(kit.buildManifest(kit.compileLayer(plan([-200, 0]), cfg)));
  assert.equal(bad.status, 'fail');
  assert.equal(bad.spans[0].fromSec, 1.04);
  assert.equal(gateSafeZone(kit.buildManifest(kit.compileLayer(plan([0, 60]), cfg))).status, 'pass');
});

test('static caption lanes are checked once and pass inside the safe zone', () => {
  const m = manifestFixture({ texts: [{ id: 'caption-1', from: 0, until: 50, static: [70, 1398, 950, 1482] }] });
  assert.equal(gateSafeZone(m).status, 'pass');
});
```

Субтитры в манифесте — `caption-<n>`, а кусок после окна `hide` — `caption-<n>b`, `caption-<n>c`… (Task 18):
у каждого свой `from/until` и тот же `static`; гейт проверяет их одинаково и называет в `spans` по id.

- [ ] **Step 2: Запустить**

Run: `node --test tests/qa-timeline-gates.test.js`
Expected: FAIL — `gateSafeZone is not a function`.

- [ ] **Step 3: Реализовать (дописать и экспортировать)**

```js
const { overflow, safeRect } = require('./safe-rect');

const SIDES = { left: 'слева', right: 'справа', top: 'сверху', bottom: 'снизу' };

function gateSafeZone(manifest) {
  const safe = safeRect(manifest.width, manifest.height);
  const found = [];
  for (const text of manifest.texts) {
    const boxes = text.static ? [text.static] : text.frames;
    for (let i = 0; i < boxes.length; i += 1) {
      const b = boxes[i];
      if (!b) continue;
      const out = overflow({ left: b[0], top: b[1], right: b[2], bottom: b[3] }, safe);
      if (out) {
        found.push({ id: text.id, frame: text.from + i, out });
        break;
      }
    }
  }
  const note = (v) => `${v.id}: ${Object.entries(v.out).map(([side, px]) => `${SIDES[side]} +${px} px`).join(', ')}`;
  return gate('G5', 'Safe-zone текста', {
    status: found.length ? 'fail' : 'pass', value: found.length, unit: 'элем.', threshold: '70/130/250/420 px на каждом кадре',
    spans: found.slice(0, 5).map((v) => span(v.frame, v.frame + 1, manifest.fps, note(v))),
    hint: 'держите влёт, перелёт и выход внутри safe-зоны: уменьшите сдвиг входа или переставьте box',
  });
}
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/qa-timeline-gates.test.js`
Expected: PASS (13 тестов). Первый видимый кадр влёта — 26-й (1,04 с): на 25-м прозрачность 0.

- [ ] **Step 5: Коммит**

```bash
git add scripts/qa/timeline-gates.js tests/qa-timeline-gates.test.js
git commit -m "feat: add per-frame text safe-zone gate"
```

### Task 24: G9 «Плотность звуков» и общий прогон гейтов по манифесту

**Files:**
- Modify: `scripts/qa/timeline-gates.js`
- Test: `tests/qa-timeline-gates.test.js` (дописать)

- [ ] **Step 1: Дописать тест**

```js
const { gateSfxDensity, runTimelineGates } = require('../scripts/qa/timeline-gates');

test('sound density warns on crowded or scene-start sounds', () => {
  const cue = (hitFrame, notable = false, name = 'pop') => ({ id: `${name}@${hitFrame}`, name, startFrame: hitFrame, hitFrame, notable, bed: false });
  assert.equal(gateSfxDensity(manifestFixture({ cues: { kept: [cue(10), cue(40), cue(90, true, 'whoosh'), cue(140, true, 'whoosh')], dropped: [] } }), avatar).status, 'pass');
  assert.equal(gateSfxDensity(manifestFixture({ cues: { kept: [cue(10), cue(14)], dropped: [] } }), avatar).status, 'warn');
  assert.equal(gateSfxDensity(manifestFixture({ cues: { kept: [cue(40, true, 'whoosh'), cue(60, true, 'whoosh')], dropped: [] } }), avatar).status, 'warn');
  assert.equal(gateSfxDensity(manifestFixture({ cues: { kept: [cue(1)], dropped: [] } }), avatar).status, 'warn');
});

test('runTimelineGates returns G1–G5, G9–G11 in order and applies waivers', () => {
  const m = manifestFixture({ camera: (f) => ({ s: f < 125 ? 1 : 1.18 }), waivers: [{ gate: 'G1', reason: 'длинная пауза по правке владельца' }] });
  const gates = runTimelineGates(m, avatar);
  assert.deepEqual(gates.map((g) => g.id), ['G1', 'G2', 'G3', 'G4', 'G5', 'G9', 'G10', 'G11']);
  assert.equal(gates[0].status, 'waived');
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/qa-timeline-gates.test.js`
Expected: FAIL — `gateSfxDensity is not a function`.

- [ ] **Step 3: Реализовать (дописать и экспортировать)**

```js
const { applyWaivers } = require('./report');

function gateSfxDensity(manifest, profile) {
  const { fps } = manifest;
  const t = profile.sfx;
  const kept = manifest.cues.kept.filter((c) => !c.bed).sort((a, b) => a.hitFrame - b.hitFrame);
  const issues = [];
  for (let i = 1; i < kept.length; i += 1) {
    const gap = (kept[i].hitFrame - kept[i - 1].hitFrame) / fps;
    if (gap < t.minGapSec - 1e-9) issues.push(span(kept[i - 1].hitFrame, kept[i].hitFrame, fps, `звуки через ${fmt(gap)} с`));
  }
  const notable = kept.filter((c) => c.notable);
  for (let i = 1; i < notable.length; i += 1) {
    const gap = (notable[i].hitFrame - notable[i - 1].hitFrame) / fps;
    if (gap < t.notableGapSec - 1e-9) issues.push(span(notable[i - 1].hitFrame, notable[i].hitFrame, fps, `заметные звуки через ${fmt(gap)} с`));
  }
  for (const c of kept.filter((cue) => cue.startFrame < t.sceneFadeSec * fps)) {
    issues.push(span(c.startFrame, c.startFrame + 1, fps, `${c.name} в первые ${fmt(t.sceneFadeSec)} с движок приглушит нарастанием`));
  }
  const dropped = manifest.cues.dropped.length;
  return gate('G9', 'Плотность звуков', {
    status: issues.length ? 'warn' : 'pass', value: kept.length, unit: 'звук.', threshold: 'любые ≥ 0,3 с, заметные ≥ 1 с',
    spans: issues.slice(0, 5),
    hint: dropped ? `kit убрал ${dropped} звук. из-за тесноты; проверьте, что важные остались` : 'разнесите звуки по времени',
  });
}

function runTimelineGates(manifest, profile) {
  return applyWaivers([
    gateRhythm(manifest, profile), gateWeakCuts(manifest, profile), gateScale(manifest, profile), gateHook(manifest, profile),
    gateSafeZone(manifest), gateSfxDensity(manifest, profile), gateStock(manifest, profile), gateDonor(manifest, profile),
  ], manifest.waivers || []);
}
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/qa-timeline-gates.test.js`
Expected: PASS (15 тестов).

- [ ] **Step 5: Коммит**

```bash
git add scripts/qa/timeline-gates.js tests/qa-timeline-gates.test.js
git commit -m "feat: add sound density gate and timeline gate runner"
```

### Task 25: Звук в Node: PCM, огибающая, корреляция

**Files:**
- Create: `scripts/qa/audio.js`
- Test: `tests/qa-audio.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/qa-audio.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { blockDb, envelopeDb, pcmFromFfmpeg, pearson, windowedMax } = require('../scripts/qa/audio');

test('envelope is -90 dBFS on silence and ~-3 dBFS on a full-scale sine', () => {
  const silence = new Int16Array(800);
  const sine = Int16Array.from({ length: 800 }, (_, i) => Math.round(32767 * Math.sin((2 * Math.PI * 220 * i) / 8000)));
  assert.deepEqual([...envelopeDb(silence)], [-90, -90]);
  assert.ok(Math.abs(blockDb(sine, 0, 800) + 3.01) < 0.1);
});

test('pearson is 1 for scaled copies, null for flat input, windowedMax finds the loud window', () => {
  const a = Float64Array.from([1, 2, 3, 4]);
  assert.ok(Math.abs(pearson(a, Float64Array.from([2, 4, 6, 8])) - 1) < 1e-12);
  assert.equal(pearson(a, Float64Array.from([5, 5, 5, 5])), null);
  const x = Float64Array.from([-90, -90, -90, -90, -20, -30, -20, -30]);
  const y = Float64Array.from([-40, -41, -39, -40, -20, -30, -20, -30]);
  assert.equal(windowedMax(x, y, 4).startBlock, 4);
});

test('ffmpeg failures are errors, never a silent pass', () => {
  const failing = () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('No such file') });
  assert.throws(() => pcmFromFfmpeg(['-i', 'missing.wav'], { spawnImpl: failing }), /ffmpeg не смог отдать звук: No such file/);
  const ok = () => ({ status: 0, stdout: Buffer.from([1, 0, 255, 255]), stderr: Buffer.alloc(0) });
  assert.deepEqual([...pcmFromFfmpeg([], { spawnImpl: ok })], [1, -1]);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/qa-audio.test.js`
Expected: FAIL — `Cannot find module '../scripts/qa/audio'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/qa/audio.js
// Звук для гейтов: моно 8 кГц s16le из ffmpeg, огибающая по 50 мс в dBFS, корреляция Пирсона.
const { spawnSync } = require('node:child_process');

const SAMPLE_RATE = 8000;
const BLOCK = 400;
const FLOOR_DB = -90;

function pcmFromFfmpeg(inputArgs, { maxBuffer = 256 * 1024 * 1024, spawnImpl = spawnSync } = {}) {
  const result = spawnImpl('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', ...inputArgs,
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', '-',
  ], { encoding: 'buffer', maxBuffer, shell: false });
  if (result.error || result.status !== 0) {
    const reason = String(result.stderr || result.error?.message || '').trim().slice(0, 300);
    throw new Error(`ffmpeg не смог отдать звук: ${reason}`);
  }
  const bytes = result.stdout;
  const samples = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(i * 2);
  return samples;
}

function decodeAudio(file, { fromSec = 0, durationSec = null, spawnImpl } = {}) {
  return pcmFromFfmpeg([
    '-ss', String(fromSec), ...(durationSec ? ['-t', String(durationSec)] : []), '-i', file, '-map', '0:a:0', '-vn',
  ], { spawnImpl });
}

function blockDb(samples, start, end) {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, end - start)) / 32768;
  return Math.max(FLOOR_DB, 20 * Math.log10(rms + 1e-12));
}

function envelopeDb(samples, block = BLOCK) {
  const n = Math.floor(samples.length / block);
  const out = new Float64Array(n);
  for (let b = 0; b < n; b += 1) out[b] = blockDb(samples, b * block, (b + 1) * block);
  return out;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; }
  ma /= n;
  mb /= n;
  let num = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    va += x * x;
    vb += y * y;
  }
  if (va === 0 || vb === 0) return null;
  return num / Math.sqrt(va * vb);
}

// Самое похожее окно, где звук первого сигнала вообще есть (короткая утечка голоса).
function windowedMax(a, b, windowBlocks, { minDbA = -60 } = {}) {
  let best = null;
  const n = Math.min(a.length, b.length);
  for (let start = 0; start + windowBlocks <= n; start += windowBlocks) {
    const wa = a.subarray(start, start + windowBlocks);
    const mean = wa.reduce((sum, v) => sum + v, 0) / windowBlocks;
    if (mean < minDbA) continue;
    const r = pearson(wa, b.subarray(start, start + windowBlocks));
    if (r !== null && (best === null || r > best.r)) best = { r, startBlock: start };
  }
  return best;
}

module.exports = { BLOCK, FLOOR_DB, SAMPLE_RATE, blockDb, decodeAudio, envelopeDb, pcmFromFfmpeg, pearson, windowedMax };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/qa-audio.test.js`
Expected: PASS (3 теста).

- [ ] **Step 5: Коммит**

```bash
git add scripts/qa/audio.js tests/qa-audio.test.js
git commit -m "feat: add PCM envelope and correlation helpers for QA gates"
```

### Task 26: G6 «Длина слоя» и G7 «Голос в звуке слоя» — два плохих случая на настоящих файлах

**Files:**
- Create: `scripts/qa/media-gates.js`
- Test: `tests/qa-media-gates.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/qa-media-gates.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { probeVideo } = require('../scripts/media-probe');
const { decodeAudio, envelopeDb } = require('../scripts/qa/audio');
const { gateLayerDuration, gateVoiceLeak } = require('../scripts/qa/media-gates');
const { getProfile } = require('../scripts/qa/profiles');

const avatar = getProfile('avatar');
const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const VOICE = "aevalsrc='0.4*sin(2*PI*220*t)*gt(sin(2*PI*1.3*t)+0.3*sin(2*PI*3.7*t),0)':s=48000:d=10";

function work(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const video = (file, seconds) => runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
  `testsrc2=s=108x192:r=25:d=${seconds}`, '-pix_fmt', 'yuv420p', file]);
const audio = (file, lavfi) => runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', lavfi, file]);

test('BAD CASE: a layer 0.2 s longer than the source stops; one frame of difference passes', { skip: !hasFfmpeg }, (t) => {
  const dir = work(t);
  video(path.join(dir, 'source.mp4'), 10);
  video(path.join(dir, 'long.mp4'), 10.2);
  video(path.join(dir, 'ok.mp4'), 10.04);
  const source = probeVideo(path.join(dir, 'source.mp4'));
  const bad = gateLayerDuration({ layer: probeVideo(path.join(dir, 'long.mp4')), source }, avatar);
  assert.equal(bad.status, 'fail');
  assert.equal(bad.value, 5);
  assert.equal(gateLayerDuration({ layer: probeVideo(path.join(dir, 'ok.mp4')), source }, avatar).status, 'pass');
});

test('BAD CASE: the avatar voice leaking into the layer audio stops; sparse effects pass', { skip: !hasFfmpeg }, (t) => {
  const dir = work(t);
  audio(path.join(dir, 'voice.wav'), VOICE);
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(dir, 'voice.wav'), '-af', 'volume=-18dB', path.join(dir, 'leak.wav')]);
  audio(path.join(dir, 'sfx.wav'), "aevalsrc='0.8*sin(2*PI*1000*t)*lt(mod(t,2.3),0.08)':s=48000:d=10");
  const voice = envelopeDb(decodeAudio(path.join(dir, 'voice.wav')));
  const leak = gateVoiceLeak({ layerEnv: envelopeDb(decodeAudio(path.join(dir, 'leak.wav'))), sourceEnv: voice, audioMode: 'mix' }, avatar);
  assert.equal(leak.status, 'fail');
  assert.ok(leak.value > 0.9);
  assert.equal(gateVoiceLeak({ layerEnv: envelopeDb(decodeAudio(path.join(dir, 'sfx.wav'))), sourceEnv: voice, audioMode: 'mix' }, avatar).status, 'pass');
});

test('muted layers skip the voice check, silent mix layers warn', () => {
  const flat = new Float64Array(200).fill(-90);
  assert.equal(gateVoiceLeak({ layerEnv: flat, sourceEnv: flat, audioMode: 'mute' }, avatar).status, 'skipped');
  assert.equal(gateVoiceLeak({ layerEnv: flat, sourceEnv: flat, audioMode: 'mix' }, avatar).status, 'warn');
  assert.equal(gateVoiceLeak({ layerEnv: null, sourceEnv: flat, audioMode: 'mix' }, avatar).status, 'warn');
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/qa-media-gates.test.js`
Expected: FAIL — `Cannot find module '../scripts/qa/media-gates'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/qa/media-gates.js
// Гейты по отрендеренному слою: длина к исходнику и отсутствие голоса в звуке слоя.
const { BLOCK, SAMPLE_RATE, pearson, windowedMax } = require('./audio');
const { gate } = require('./report');

const frames = (probe) => Math.round(probe.duration * probe.fps);

function gateLayerDuration({ layer, source }, profile) {
  const diff = frames(layer) - frames(source);
  const geometry = layer.width === source.width && layer.height === source.height && Math.abs(layer.fps - source.fps) < 1e-3;
  const status = Math.abs(diff) <= profile.duration.toleranceFrames && geometry ? 'pass' : 'fail';
  return gate('G6', 'Длина слоя', {
    status, value: diff, unit: 'кадр.', threshold: `±${profile.duration.toleranceFrames} кадр к исходнику, тот же размер и FPS`,
    hint: geometry
      ? 'длительность композиции должна совпадать с исходником: пересоздайте layer.json командой layer new'
      : `слой ${layer.width}×${layer.height}@${layer.fps}, исходник ${source.width}×${source.height}@${source.fps}`,
  });
}

function gateVoiceLeak({ layerEnv, sourceEnv, audioMode }, profile) {
  const title = 'Голос в звуке слоя';
  if (audioMode === 'mute') return gate('G7', title, { status: 'skipped', hint: 'звук слоя не используется (audioMode mute)' });
  if (!layerEnv || !layerEnv.length) return gate('G7', title, { status: 'warn', hint: 'в слое нет звуковой дорожки: поставьте audioMode mute или добавьте эффекты' });
  const loudest = layerEnv.reduce((m, v) => Math.max(m, v), -Infinity);
  if (loudest < profile.leak.silentDb) return gate('G7', title, { status: 'warn', hint: 'звук слоя почти беззвучный' });
  const r = pearson(layerEnv, sourceEnv);
  const windowBlocks = Math.round((profile.leak.windowSec * SAMPLE_RATE) / BLOCK);
  const window = windowedMax(layerEnv, sourceEnv, windowBlocks, { minDbA: profile.leak.silentDb });
  const status = r !== null && r >= profile.leak.stop ? 'fail' : window && window.r >= profile.leak.windowWarn ? 'warn' : 'pass';
  const blockSec = BLOCK / SAMPLE_RATE;
  return gate('G7', title, {
    status, value: r === null ? 0 : Math.round(r * 100) / 100, threshold: `< ${String(profile.leak.stop).replace('.', ',')}`,
    spans: status === 'warn' ? [{ fromSec: window.startBlock * blockSec, toSec: (window.startBlock + windowBlocks) * blockSec, note: 'звук слоя повторяет голос' }] : [],
    hint: 'у видео аватара и вставок в слое должен быть muted: голос идёт только из мастер-видео',
  });
}

module.exports = { gateLayerDuration, gateVoiceLeak };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/qa-media-gates.test.js`
Expected: PASS (3 теста; на машине без ffmpeg первые два пропускаются).

- [ ] **Step 5: Коммит**

```bash
git add scripts/qa/media-gates.js tests/qa-media-gates.test.js
git commit -m "feat: add layer duration and voice leak gates"
```

### Task 27: G8 «Голос и музыка» — плохой случай «музыка вровень с голосом»

Меряем настоящие дорожки preview: голос = звук после `finish.js` (голос + эффекты слоя, нормализация
−14 LUFS), музыка = ветка музыки после того же `sidechaincompress`, что в `mix-music.js`. Считаем только
блоки 50 мс внутри окон речи (слова транскрипта).

**Files:**
- Modify: `scripts/mix-music.js` (`buildMusicFilter(options, { stem })`)
- Create: `scripts/qa/mix-gates.js`
- Test: `tests/qa-mix-gates.test.js`; существующие `tests/music-ducking.test.js` и
  `tests/media-finalization-security.test.js` закрепляют обычный граф и не меняются

- [ ] **Step 1: Написать падающий тест**

```js
// tests/qa-mix-gates.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { buildMusicFilter, parseMixOptions } = require('../scripts/mix-music');
const { decodeAudio } = require('../scripts/qa/audio');
const { gateVoiceMusic, measureVoiceMusic, speechWindows, voiceMusicGap } = require('../scripts/qa/mix-gates');
const { getProfile } = require('../scripts/qa/profiles');

const avatar = getProfile('avatar');
const hasFfmpeg = toolAvailable('ffmpeg');

test('music stem graph keeps the real sidechain and drops the voice mix', () => {
  const options = parseMixOptions(['--gain', '-16', '--threshold', '0.0100', '--ratio', '4', '--duration', '10']);
  const stem = buildMusicFilter(options, { stem: 'music' });
  assert.match(stem, /sidechaincompress=threshold=0\.01:ratio=4/);
  assert.match(stem, /\[aout\]$/);
  assert.doesNotMatch(stem, /amix/);
  assert.match(buildMusicFilter(options), /amix=inputs=2/);
});

test('speech windows merge close words, drop blips and follow the preview range', () => {
  const words = [{ s: 1, e: 1.4 }, { s: 1.5, e: 2 }, { s: 3, e: 3.1 }, { s: 5, e: 6 }];
  assert.deepEqual(speechWindows(words, { fromSec: 0.5, toSec: 5.5 }), [{ s: 0.5, e: 1.5 }, { s: 4.5, e: 5 }]);
});

test('gap statistics use only blocks with audible music', () => {
  const tone = (amp) => Int16Array.from({ length: 8000 }, (_, i) => Math.round(amp * 32767 * Math.sin(i / 3)));
  const r = voiceMusicGap(tone(0.5), tone(0.05), [{ s: 0, e: 1 }]);
  assert.ok(Math.abs(r.median - 20) < 0.1);
  assert.equal(voiceMusicGap(tone(0.5), new Int16Array(8000), [{ s: 0, e: 1 }]).median, Infinity);
  assert.equal(gateVoiceMusic({ median: Infinity, p10: Infinity, blocks: 0 }, avatar).status, 'fail');
  assert.equal(gateVoiceMusic(null, avatar, { hasMusic: false }).status, 'skipped');
});

test('BAD CASE: music at the voice level stops the preview; a 12 dB gap passes', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mix-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const voice = path.join(dir, 'voice.wav');
  const music = path.join(dir, 'music.wav');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=10', '-af', 'volume=-6dB', voice]);
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-af', 'volume=-6dB', music]);
  const windows = [{ s: 0.5, e: 9.5 }];
  const measure = (gain) => measureVoiceMusic({ voicePath: voice, musicPath: music, durationSec: 10, windows,
    mixOptions: parseMixOptions(['--gain', String(gain), '--threshold', '1', '--ratio', '1', '--duration', '10']) });
  const level = gateVoiceMusic(measure(0), avatar);
  assert.equal(level.status, 'fail');
  assert.ok(Math.abs(level.value) < 1);
  assert.equal(gateVoiceMusic(measure(-12), avatar).status, 'pass');
  assert.ok(decodeAudio(voice).length > 70000);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/qa-mix-gates.test.js`
Expected: FAIL — `Cannot find module '../scripts/qa/mix-gates'`.

- [ ] **Step 3: Реализовать**

В `scripts/mix-music.js` заменить `function buildMusicFilter(options) {` и хвост функции:

```js
// stem: 'music' — только музыка после того же sidechain (для замера баланса), без смешивания с голосом.
function buildMusicFilter(options, { stem = null } = {}) {
  const musicFilters = [];
  if (options.start > 0) musicFilters.push(`atrim=start=${options.start}`, 'asetpts=PTS-STARTPTS');
  if (options.rate !== 1) musicFilters.push(`atempo=${options.rate}`);
  musicFilters.push(`volume=${options.gain}dB`);
  if (options.fadeIn > 0) musicFilters.push(`afade=t=in:st=0:d=${options.fadeIn}`);
  if (options.fadeOut > 0) {
    const fadeStart = Number((options.duration - options.fadeOut).toFixed(4));
    musicFilters.push(`afade=t=out:st=${fadeStart}:d=${options.fadeOut}`);
  }

  const audioFormat = 'aformat=sample_rates=44100:channel_layouts=stereo';
  musicFilters.push(audioFormat);
  const sidechain = `sidechaincompress=threshold=${options.threshold}:ratio=${options.ratio}:attack=${options.attack}:release=${options.release}:level_sc=1`;
  if (stem === 'music') {
    return [`[1:a]${musicFilters.join(',')}[m]`, `[0:a]${audioFormat}[sc]`, `[m][sc]${sidechain}[aout]`].join(';');
  }
  return [
    `[1:a]${musicFilters.join(',')}[m]`,
    `[0:a]${audioFormat},asplit=2[v][sc]`,
    `[m][sc]${sidechain}[duck]`,
    '[v][duck]amix=inputs=2:duration=first:normalize=0,apad[aout]',
  ].join(';');
}
```

(Строка графа для обычного режима не меняется — существующие тесты `mix-music` это закрепляют.)

```js
// scripts/qa/mix-gates.js
const { BLOCK, SAMPLE_RATE, blockDb, pcmFromFfmpeg } = require('./audio');
const { gate } = require('./report');
const { buildMusicFilter } = require('../mix-music');

const MUSIC_FLOOR_DB = -80;

function speechWindows(words, { fromSec = 0, toSec = Infinity, mergeGapSec = 0.25, minSec = 0.3 } = {}) {
  const inRange = words.filter((w) => w.e > fromSec && w.s < toSec)
    .map((w) => ({ s: Math.max(w.s, fromSec) - fromSec, e: Math.min(w.e, toSec) - fromSec }))
    .sort((a, b) => a.s - b.s);
  const merged = [];
  for (const w of inRange) {
    const last = merged[merged.length - 1];
    if (last && w.s - last.e <= mergeGapSec) last.e = Math.max(last.e, w.e);
    else merged.push({ ...w });
  }
  return merged.filter((w) => w.e - w.s >= minSec - 1e-9)
    .map((w) => ({ s: Math.round(w.s * 1000) / 1000, e: Math.round(w.e * 1000) / 1000 }));
}

function voiceMusicGap(voice, music, windows) {
  const gaps = [];
  let blocks = 0;
  for (const w of windows) {
    const first = Math.ceil((w.s * SAMPLE_RATE) / BLOCK);
    const last = Math.floor((w.e * SAMPLE_RATE) / BLOCK);
    for (let b = first; b < last; b += 1) {
      const start = b * BLOCK;
      const end = start + BLOCK;
      if (end > voice.length || end > music.length) break;
      blocks += 1;
      const musicDb = blockDb(music, start, end);
      if (musicDb >= MUSIC_FLOOR_DB) gaps.push(blockDb(voice, start, end) - musicDb);
    }
  }
  if (!blocks) return null;
  if (!gaps.length) return { median: Infinity, p10: Infinity, blocks: 0 };
  gaps.sort((a, b) => a - b);
  return { median: gaps[Math.floor(gaps.length / 2)], p10: gaps[Math.floor(gaps.length * 0.1)], blocks: gaps.length };
}

// voicePath — голос после finish.js; музыка идёт через тот же граф, что в mix-music.js (режим stem).
function measureVoiceMusic({ voicePath, musicPath, mixOptions, durationSec, windows, spawnImpl }) {
  const voice = pcmFromFfmpeg(['-i', voicePath, '-map', '0:a:0', '-vn', '-t', String(durationSec)], { spawnImpl });
  const music = pcmFromFfmpeg([
    '-i', voicePath, '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex', buildMusicFilter(mixOptions, { stem: 'music' }), '-map', '[aout]', '-t', String(durationSec),
  ], { spawnImpl });
  return voiceMusicGap(voice, music, windows);
}

function gateVoiceMusic(result, profile, { hasMusic = true } = {}) {
  const title = 'Голос и музыка';
  if (!hasMusic) return gate('G8', title, { status: 'skipped', hint: 'в brief нет музыки' });
  if (!result) return gate('G8', title, { status: 'skipped', hint: 'в диапазоне preview нет речи' });
  const v = profile.voiceMusic;
  const m = result.median;
  const status = m < v.stopLow || m > v.stopHigh ? 'fail' : m < v.warnLow || m > v.warnHigh ? 'warn' : 'pass';
  const hint = m < v.warnLow ? 'музыка громкая под голосом: уменьшите music.gainDb'
    : m > v.warnHigh ? 'музыку почти не слышно: увеличьте music.gainDb' : '';
  return gate('G8', title, {
    status, value: Number.isFinite(m) ? Math.round(m * 10) / 10 : 'музыки под речью нет', unit: Number.isFinite(m) ? 'dB' : '',
    threshold: `${v.warnLow}–${v.warnHigh} dB, стоп < ${v.stopLow} или > ${v.stopHigh}`, hint,
  });
}

module.exports = { gateVoiceMusic, measureVoiceMusic, speechWindows, voiceMusicGap };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/qa-mix-gates.test.js tests/music-ducking.test.js tests/media-finalization-security.test.js`
Expected: PASS; существующие тесты музыки не изменились.

- [ ] **Step 5: Коммит**

```bash
git add scripts/mix-music.js scripts/qa/mix-gates.js tests/qa-mix-gates.test.js
git commit -m "feat: measure voice and music balance on real preview stems"
```

## Фаза 7. Команды `automontage layer`

Все подкоманды — модули `scripts/layer/<имя>.js` с `FLAGS` и `async run(options, deps)` → код выхода.
Ошибка без отчёта (нет файла, неверный флаг) — код 1 и строка `❌ layer <имя> отменён: …`.

### Task 28: Подкоманда `layer` в CLI и общие помощники

**Уточнения после ревью пакета 1:**
- `readLayerJson(layerDir)` сразу проверяет `sfxMasterDb` общей проверкой kit:
  `loadKitCore().assertMasterDb(layer.sfxMasterDb)` (Task 17, сообщение «layer.json → sfxMasterDb должен быть
  конечным числом ≤ 0 …» — одно с `SfxTrack`). Поле обязательно: `layer new` всегда пишет −5. Без этого
  неверное значение всплывает только на рендере слоя.
- Тест в `tests/layer-cli.test.js`: `readLayerJson` на `layer.json` с `sfxMasterDb: 3`, `null` и без поля
  бросает ошибку с `layer.json` и `sfxMasterDb`; с `-5` — возвращает объект.

**Files:**
- Create: `scripts/layer/cli.js`, `scripts/layer/common.js`
- Modify: `scripts/cli.js` (справка + маршрут до перехода в `build.js`)
- Test: `tests/layer-cli.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/layer-cli.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { parseArgs } = require('../scripts/layer/cli');

const cli = path.resolve(__dirname, '../scripts/cli.js');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('public CLI advertises layer commands and routes them to their own script', () => {
  const help = run('--help');
  for (const line of ['automontage layer new --project-dir', 'automontage layer check', 'automontage layer render', 'automontage layer import', 'automontage layer brief']) {
    assert.match(help.stdout, new RegExp(line));
  }
  const usage = run('layer');
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: automontage layer new\|words\|check\|render\|import\|brief\|stock\|sheet/);
  assert.doesNotMatch(usage.stderr, /build\.js|ENOENT/);
  const unknown = run('layer', 'bogus');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /неизвестная команда layer bogus/);
  assert.equal(run('layer', '--help').status, 0);
});

test('layer flags are strict: unknown, repeated and valueless flags fail', () => {
  const flags = { 'project-dir': 'value', wait: 'bool' };
  assert.deepEqual(parseArgs(['--project-dir', 'p', '--wait'], flags), { 'project-dir': 'p', wait: true });
  assert.throws(() => parseArgs(['--nope', '1'], flags), /неизвестный флаг --nope/);
  assert.throws(() => parseArgs(['--project-dir', 'a', '--project-dir', 'b'], flags), /повторяется/);
  assert.throws(() => parseArgs(['--project-dir', '--wait'], flags), /требует значение/);
  assert.throws(() => parseArgs(['stray'], flags), /лишний аргумент «stray»/);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/layer-cli.test.js`
Expected: FAIL — `Cannot find module '../scripts/layer/cli'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/layer/cli.js — запускается из scripts/cli.js через `node`, поэтому без shebang
const USAGE = `usage: automontage layer new|words|check|render|import|brief|stock|sheet --project-dir <папка> [...]

  layer new    --project-dir P [--dir motion-v01] [--profile avatar|live]    слой из деталей motion-kit
  layer words  --project-dir P --layer motion-v01                             слова и написание заново
  layer check  --project-dir P --layer motion-v01 [--profile avatar|live]     гейты по плану, секунды
  layer render --project-dir P --layer motion-v01 [--no-wait]                 рендер слоя + гейты длины и звука
  layer import --project-dir P --file <motion-v01/renders/layer-01.mp4>       импорт проверенного слоя
  layer brief  --project-dir P --asset <assets/broll/video/…/media.mp4> --title T --head-cream C --head-orange O
               [--audio mix|mute] [--music <файл> --music-gain-db -16 --music-start-sec 0]
  layer stock  --project-dir P --layer motion-v01 --query "english" --query-original "фраза" [--sec 2.5] [--pick 1] [--list]
  layer sheet  --project-dir P                                                контакт-лист preview и кадры правок пульта`;

const COMMANDS = Object.freeze({
  new: './new', words: './words', check: './check', render: './render',
  import: './import', brief: './brief', stock: './stock', sheet: './sheet',
});

function parseArgs(argv, flags) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`лишний аргумент «${flag}»`);
    const key = flag.slice(2);
    if (!Object.hasOwn(flags, key)) throw new Error(`неизвестный флаг ${flag}`);
    if (Object.hasOwn(options, key)) throw new Error(`флаг ${flag} повторяется`);
    if (flags[key] === 'bool') {
      options[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`флаг ${flag} требует значение`);
    options[key] = value;
    i += 1;
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (!command) {
    console.error(USAGE);
    return 1;
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    console.error(`❌ неизвестная команда layer ${command}\n${USAGE}`);
    return 1;
  }
  try {
    const mod = require(COMMANDS[command]);
    return await mod.run(parseArgs(rest, mod.FLAGS));
  } catch (error) {
    console.error(`❌ layer ${command} отменён: ${error.message}`);
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { USAGE, main, parseArgs };
```

```js
// scripts/layer/common.js
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadKitCore } = require('../motion-kit-node');
const { readProjectManifest, resolveProjectPath } = require('../project/workspace');

const LAYER_NAME = /^motion-v\d{2,3}$/u;

function projectFrom(options) {
  if (!options['project-dir']) throw new Error('нужен --project-dir');
  const projectDir = path.resolve(options['project-dir']);
  const manifest = readProjectManifest(projectDir);
  const sourcePath = resolveProjectPath(projectDir, manifest.source.localPath, { label: 'manifest.source.localPath', mustExist: true, type: 'file' });
  return { projectDir, manifest, sourcePath };
}

function resolveLayer(options) {
  const project = projectFrom(options);
  if (!LAYER_NAME.test(options.layer || '')) throw new Error('--layer должен быть вида motion-v01');
  const layerDir = resolveProjectPath(project.projectDir, options.layer, { label: 'layer', mustExist: true, type: 'directory' });
  return { ...project, layerName: options.layer, layerDir };
}

function nextLayerName(projectDir) {
  let n = 1;
  while (fs.existsSync(path.join(projectDir, `motion-v${String(n).padStart(2, '0')}`))) n += 1;
  return `motion-v${String(n).padStart(2, '0')}`;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Неверный sfxMasterDb ловится при чтении, а не на рендере: та же проверка, что в SfxTrack.
function readLayerJson(layerDir) {
  const layer = readJson(path.join(layerDir, 'layer.json'));
  loadKitCore().assertMasterDb(layer.sfxMasterDb);
  return layer;
}
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const relative = (projectDir, file) => path.relative(projectDir, file).split(path.sep).join('/');

module.exports = { LAYER_NAME, nextLayerName, projectFrom, readJson, readLayerJson, relative, resolveLayer, sha256File, writeJson };
```

В `scripts/cli.js` в текст справки (рядом с `takes`) добавить строки:

```text
  automontage layer new --project-dir <p>          motion-слой из деталей motion-kit (камера, звуки, вставки, субтитры)
  automontage layer check --project-dir <p> --layer motion-v01    гейты ритма, safe-zone, звуков по плану
  automontage layer render --project-dir <p> --layer motion-v01   рендер слоя, когда машина свободна, + гейты
  automontage layer import --project-dir <p> --file <mp4>         импорт проверенного слоя
  automontage layer brief --project-dir <p> --asset <ref> …       draft brief со слоем на весь ролик
```

и маршрут перед переходом в `build.js`, рядом с `takes`:

```js
// motion-слой из деталей motion-kit и его проверки: отдельный скрипт, аргументы не попадают в build.js
if (argv[0] === 'layer') {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'layer', 'cli.js'), ...argv.slice(1)], {
      stdio: 'inherit', cwd: process.cwd(), shell: false,
    });
  } catch (e) { process.exit(e.status || 1); }
  process.exit(0);
}
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/layer-cli.test.js tests/cli.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add scripts/layer/cli.js scripts/layer/common.js scripts/cli.js tests/layer-cli.test.js
git commit -m "feat: add automontage layer command group"
```

### Task 29: Шаблон слоя

Шаблон нейтральный: без медиа в Git, стиль и цвета — только заглушки, которые ролик заменяет своим
дизайном. В нём уже работают живая камера, звуковая дорожка, вставка стока, скриншот-карточка со
вспышкой затвора, субтитры; на любом исходнике он проходит гейты (проверяется в Task 33).

**Уточнения после ревью пакета 1:**
- `FontLoader` — гейт (Task 18): `<FontLoader faces={FONTS}>…весь слой…</FontLoader>`, а не соседний
  пустой элемент (без детей в браузере он бросает ошибку). `FONTS` — модульная константа.
- `ScrollShot` принимает `scroll` — долю страницы 0..1, а не `maxScroll` в px (Task 16). Окно прокрутки
  карточки — от конца входа до начала выхода: `from + ref25(8, fps)` … `until − ref25(5, fps)`.
- Вспышка — после входа карточки и ровно на ударе звука затвора: `plan.js` ставит затвор отдельным
  `sfx` через 0,32 с (вход `mask` — 8 эталонных кадров) после начала карточки, `Root.jsx` рисует
  `<ShutterFlash at={cue.hitFrame} />` для каждого оставшегося после `thinCues` звука с ролью `shutter`.
- Вставки `screen`/`scene` имеют `cover: true`: `Root.jsx` рисует их через `FullscreenReveal` с содержимым
  ролика (`InsertContent` из `scenes.jsx`), иначе спикер уходит под вставку, а кадр остаётся чёрным.
  Полноэкранный `screen` в 9:16 — окно браузера внутри safe-зоны (`revealCard`), не от края до края.
- `activeChunk` требует fps: если `plan.js` сверяет режиссуру с субтитрами —
  `activeChunk(chunks, sec, hide, fps)`.

**Files:**
- Create: `templates/motion-layer/src/index.jsx`, `Root.jsx`, `plan.js`, `scenes.jsx`, `templates/motion-layer/README.md`
- Test: `tests/layer-template.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/layer-template.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'templates', 'motion-layer');
const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');

test('template imports only the kit, never another reel or an absolute path', () => {
  for (const file of ['src/index.jsx', 'src/Root.jsx', 'src/plan.js', 'src/scenes.jsx', 'README.md']) {
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
  assert.match(read('src/scenes.jsx'), /BrowserFrame/);
  assert.match(read('src/scenes.jsx'), /scroll=\{/);
  assert.doesNotMatch(read('src/scenes.jsx') + read('src/plan.js'), /maxScroll/);
  assert.match(read('src/plan.js'), /kind: 'stock'/);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/layer-template.test.js`
Expected: FAIL — `ENOENT … templates/motion-layer/src/index.jsx`.

- [ ] **Step 3: Создать файлы шаблона**

```jsx
// templates/motion-layer/src/index.jsx
import { Composition, registerRoot } from 'remotion';
import layer from '../layer.json';
import { LayerComposition } from './Root.jsx';

function Root() {
  return (
    <Composition id={layer.composition} component={LayerComposition} durationInFrames={layer.durationInFrames}
      fps={layer.fps} width={layer.width} height={layer.height} />
  );
}

registerRoot(Root);
```

```jsx
// templates/motion-layer/src/Root.jsx
// Сборка слоя из деталей motion-kit. Режиссура — в plan.js, дизайн карточек и вставок — в scenes.jsx.
import { useMemo } from 'react';
import { AbsoluteFill } from 'remotion';
import { FontLoader, FullscreenReveal, KitBox, SfxTrack, ShutterFlash, SpeakerLayer, StockInsert, Subtitles,
  compileLayer } from '@automontage/motion-kit';
import layer from '../layer.json';
import buildPlan from './plan.js';
import { InsertContent, SceneContent } from './scenes.jsx';
import sfxLibrary from './sfx-library.js';
import words from './words.js';

// Модульная константа: FontLoader регистрирует шрифты один раз при монтировании.
const FONTS = [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }, { family: 'KitOswald', file: 'fonts/Oswald.ttf' }];

// Сток — StockInsert; остальные полноэкранные (cover) вставки — FullscreenReveal с содержимым ролика,
// иначе спикер уходит под вставку, а кадр остаётся чёрным. Вставку без cover (donor) ролик рисует сам.
function Insert({ insert }) {
  if (insert.kind === 'stock') return <StockInsert insert={insert} />;
  if (insert.cover) return <FullscreenReveal insert={insert}><InsertContent insert={insert} /></FullscreenReveal>;
  return <InsertContent insert={insert} />;
}

export function LayerComposition() {
  const compiled = useMemo(() => {
    const ctx = { ...layer, words, sfxLibrary };
    return compileLayer(buildPlan(ctx), ctx);
  }, []);
  // FontLoader — гейт: ничего из слоя не попадает в кадр, пока шрифты не загрузились.
  // Вспышка — на ударе каждого оставшегося звука затвора: звук и свет не расходятся.
  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      <FontLoader faces={FONTS}>
        <SpeakerLayer src={layer.speaker.src} track={compiled.camera} lastFrame={layer.speaker.lastFrame} />
        {compiled.inserts.map((insert) => <Insert key={insert.id} insert={insert} />)}
        {compiled.items.map((item) => <KitBox key={item.id} item={item}><SceneContent item={item} /></KitBox>)}
        {compiled.cues.kept.filter((cue) => cue.role === 'shutter').map((cue) => <ShutterFlash key={cue.id} at={cue.hitFrame} />)}
        {compiled.captions ? <Subtitles {...compiled.captions} fontFamily="KitOnest" /> : null}
        <SfxTrack cues={compiled.cues.kept} masterDb={layer.sfxMasterDb} />
      </FontLoader>
    </AbsoluteFill>
  );
}
```

```js
// templates/motion-layer/src/plan.js
// Режиссура этого ролика. Времена — секунды исходника. Элементы ставьте на слова:
//   const a = makeAnchors(words); a.at('репозиторий') → секунда начала слова.
// Меняйте всё: layer check покажет, если ритм, safe-zone или звуки выйдут за правила.
import { autoShots, pickSound } from '@automontage/motion-kit/core';

export default function buildPlan({ words, face, fps, width, durationInFrames, sfxLibrary }) {
  const duration = durationInFrames / fps;
  const k = width / 1080;
  const box = (x, y, w, h) => ({ x: Math.round(x * k), y: Math.round(y * k), w: Math.round(w * k), h: Math.round(h * k) });
  const at = (share) => Number((duration * share).toFixed(2));
  const title = words.slice(0, 3).map((w) => w.t).join(' ').replace(/[.,!?…:;]+$/u, '').toUpperCase();
  const shotAt = at(0.3);
  // Затвор — после входа карточки (mask длится 0,32 с); вспышку Root.jsx ставит на его удар.
  const shutter = pickSound(sfxLibrary, 'shutter');
  const flashAt = Number((shotAt + 0.32).toFixed(2));
  const stockAt = at(0.6);
  return {
    hook: 'speaker',
    camera: {
      face,
      shots: autoShots(words, { endSec: duration }),
      punches: [],
      blurs: [{ from: shotAt, to: shotAt + 2.4, px: 20 }],
    },
    items: [
      { id: 'title', kind: 'text', at: 0.2, until: Math.min(2.4, duration), box: box(120, 300, 780, 220),
        enter: { kind: 'pop' }, sfx: pickSound(sfxLibrary, 'pop'), props: { view: 'title', text: title } },
      { id: 'screenshot', kind: 'card', at: shotAt, until: shotAt + 2.6, box: box(90, 300, 840, 900),
        enter: { kind: 'mask' }, props: { view: 'browser', url: 'example.com', src: 'shots/placeholder.png', scroll: 1 } },
    ],
    inserts: [{ id: 'stock-1', kind: 'stock', from: stockAt, to: stockAt + 2, src: 'stock/placeholder.mp4', sfx: pickSound(sfxLibrary, 'whoosh') }],
    sfx: shutter ? [{ at: flashAt, name: shutter }] : [],
    captions: { hide: [{ from: stockAt, to: stockAt + 2 }] },
  };
}
```

```jsx
// templates/motion-layer/src/scenes.jsx
// Дизайн карточек и полноэкранных вставок этого ролика: палитра, шрифты и композиции — свои для каждой темы.
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { BrowserFrame, REVEAL_FRAMES, ScrollShot, closeWindow, ref25, revealCard } from '@automontage/motion-kit';

// id вставки screen → адрес страницы в окне браузера (у скомпилированной вставки нет props).
const SCREEN_URLS = {};

export function SceneContent({ item }) {
  const { fps } = useVideoConfig();
  const { view } = item.props;
  if (view === 'title') {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(12,16,24,.82)', borderRadius: 28, color: '#ffffff', fontFamily: 'KitOswald', fontSize: 64,
        fontWeight: 700, textAlign: 'center', padding: '0 32px' }}>{item.props.text}</div>
    );
  }
  if (view === 'browser') {
    // Прокрутка — после входа карточки (mask, 8 эталонных кадров) и до начала выхода (5 кадров).
    return (
      <BrowserFrame url={item.props.url}>
        <ScrollShot src={item.props.src} from={item.from + ref25(8, fps)} to={item.until - ref25(5, fps)} scroll={item.props.scroll ?? 1} />
      </BrowserFrame>
    );
  }
  return null;
}

// Содержимое полноэкранных вставок screen/scene (сток StockInsert рисует сам). Скриншот на весь кадр —
// окно браузера внутри safe-зоны (revealCard), иначе в 9:16 хром окна уходит под интерфейс площадки.
export function InsertContent({ insert }) {
  const { fps, width, height } = useVideoConfig();
  if (insert.kind === 'screen' && insert.src) {
    const card = revealCard(width, height);
    return (
      <AbsoluteFill style={{ backgroundColor: '#0c1018' }}>
        <div style={{ position: 'absolute', top: card.top, right: card.right, bottom: card.bottom, left: card.left }}>
          <BrowserFrame url={SCREEN_URLS[insert.id] || ''}>
            <ScrollShot src={insert.src} from={insert.from + ref25(REVEAL_FRAMES, fps)} to={closeWindow(insert, fps).start} scroll={1} />
          </BrowserFrame>
        </div>
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill style={{ backgroundColor: '#0c1018' }} />;
}
```

`templates/motion-layer/README.md` — короткая памятка слоя (копируется в папку ролика):

```md
# Motion-слой ролика

Собран командой `automontage layer new` из деталей motion-kit движка.

- `src/plan.js` — режиссура: планы камеры, карточки на словах, вставки, звуки, субтитры.
- `src/scenes.jsx` — дизайн карточек и полноэкранных вставок этого ролика.
- `public/` — speaker.mp4, шрифты, звуки, сток (`stock/`), скриншоты (`shots/`); источники — `public/SOURCE.md`.
- Заглушки `stock/placeholder.mp4` и `shots/placeholder.png` замените настоящими материалами.

Цикл: правка `plan.js` → `automontage layer check` (секунды) → `automontage layer render` →
`automontage layer import` → `automontage layer brief` → `automontage preview`.
Все тексты и цифры — только из речи (`src/words.js`); написание брендов — в `spelling.json`.
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/layer-template.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add templates/motion-layer tests/layer-template.test.js
git commit -m "feat: add neutral motion layer template"
```

### Task 30: Библиотека звуков вне Git

Звуки Mixkit и подобные нельзя раздавать, поэтому в Git их нет. Библиотека — локальная папка
`AUTOMONTAGE_SFX_DIR` (по умолчанию `<движок>/projects/.library/sfx`, скрыта от пульта точкой):
`*.wav` + необязательный `library.json` `{sounds: {name: {role, notable, volume}}, license, sourceUrl}`.
Длина и пик вычисляются при копировании в слой.

**Files:**
- Create: `scripts/layer/sfx-library.js`
- Test: `tests/layer-sfx-library.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/layer-sfx-library.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { copySfxLibrary, sfxLibraryDir } = require('../scripts/layer/sfx-library');

test('library dir comes from AUTOMONTAGE_SFX_DIR or the hidden projects/.library/sfx', () => {
  assert.equal(sfxLibraryDir({ AUTOMONTAGE_SFX_DIR: '/x/sfx' }), '/x/sfx');
  assert.match(sfxLibraryDir({}), /projects[\\/]\.library[\\/]sfx$/);
});

test('copying measures length, peak and hash, keeps roles and writes provenance rows', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-lib-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lib = path.join(root, 'lib');
  const target = path.join(root, 'layer', 'public', 'sfx');
  fs.mkdirSync(lib, { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.9*sin(2*PI*600*t)*exp(-40*abs(t-0.4))':s=48000:d=1", path.join(lib, 'whoosh-in.wav')]);
  fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify({ license: 'Test license', sourceUrl: 'https://example.com/sfx',
    sounds: { 'whoosh-in': { volume: 0.8 } } }));
  const result = copySfxLibrary(lib, target);
  const sound = result.library.sounds['whoosh-in'];
  assert.equal(sound.file, 'sfx/whoosh-in.wav');
  assert.ok(Math.abs(sound.lengthSec - 1) < 0.01);
  assert.ok(Math.abs(sound.peakSec - 0.4) < 0.02);
  assert.equal(sound.volume, 0.8);
  assert.match(sound.sha256, /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(path.join(target, 'whoosh-in.wav')));
  assert.match(result.sourceRows[0], /\| `sfx\/whoosh-in\.wav` \| Test license \| https:\/\/example\.com\/sfx \| [a-f0-9]{64} \|/);
});

test('a missing library yields an empty sound set instead of an error', () => {
  const result = copySfxLibrary(path.join(os.tmpdir(), 'no-such-sfx-lib'), path.join(os.tmpdir(), 'unused'));
  assert.deepEqual(result.library, { sounds: {} });
  assert.deepEqual(result.sourceRows, []);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/layer-sfx-library.test.js`
Expected: FAIL — `Cannot find module '../scripts/layer/sfx-library'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/layer/sfx-library.js
const fs = require('node:fs');
const path = require('node:path');
const { SAMPLE_RATE, decodeAudio } = require('../qa/audio');
const { sha256File } = require('./common');

const ENGINE_ROOT = path.join(__dirname, '..', '..');

function sfxLibraryDir(env = process.env) {
  return env.AUTOMONTAGE_SFX_DIR ? path.resolve(env.AUTOMONTAGE_SFX_DIR) : path.join(ENGINE_ROOT, 'projects', '.library', 'sfx');
}

function measure(file) {
  const samples = decodeAudio(file);
  let peak = 0;
  let at = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i]);
    if (v > peak) { peak = v; at = i; }
  }
  return { lengthSec: Number((samples.length / SAMPLE_RATE).toFixed(3)), peakSec: Number((at / SAMPLE_RATE).toFixed(3)) };
}

// Копирует звуки в public/sfx слоя и возвращает библиотеку для src/sfx-library.js и строки SOURCE.md.
function copySfxLibrary(libraryDir, targetDir) {
  if (!fs.existsSync(libraryDir)) return { library: { sounds: {} }, sourceRows: [] };
  const metaPath = path.join(libraryDir, 'library.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  const names = fs.readdirSync(libraryDir).filter((name) => /^[a-z0-9][a-z0-9-]*\.wav$/u.test(name)).sort();
  fs.mkdirSync(targetDir, { recursive: true });
  const sounds = {};
  const sourceRows = [];
  for (const fileName of names) {
    const name = fileName.slice(0, -4);
    const source = path.join(libraryDir, fileName);
    fs.copyFileSync(source, path.join(targetDir, fileName));
    const sha256 = sha256File(source);
    const own = meta.sounds?.[name] || {};
    sounds[name] = { file: `sfx/${fileName}`, ...measure(source), sha256, ...(own.role ? { role: own.role } : {}),
      ...(own.volume ? { volume: own.volume } : {}) };
    sourceRows.push(`| \`sfx/${fileName}\` | ${meta.license || 'лицензия не указана в library.json'} | ${meta.sourceUrl || '—'} | ${sha256} |`);
  }
  return { library: { sounds }, sourceRows };
}

module.exports = { copySfxLibrary, sfxLibraryDir };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/layer-sfx-library.test.js`
Expected: PASS (3 теста).

- [ ] **Step 5: Коммит**

```bash
git add scripts/layer/sfx-library.js tests/layer-sfx-library.test.js
git commit -m "feat: copy a local sound library into motion layers"
```

### Task 31: `layer new` и `layer words`

**Files:**
- Create: `scripts/layer/new.js`, `scripts/layer/words.js`
- Create: `tests/helpers/layer-project.js`
- Test: `tests/layer-new.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/helpers/layer-project.js
// Маленький проект движка: исходник lavfi 540×960/25 fps с голосоподобным звуком и транскрипт.
// 540×960 — половина рабочего кадра: анимации kit заданы в пикселях кадра 1080×1920 и в совсем
// крошечном кадре честно вылетали бы за safe-зону.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrOpenProject } = require('../../scripts/project/workspace');
const { runTool } = require('./media-fixtures');

function makeLayerProject(t, { seconds = 6, size = '540x960' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.mp4');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=25:d=${seconds}`,
    '-f', 'lavfi', '-i', `aevalsrc='0.4*sin(2*PI*220*t)*gt(sin(2*PI*1.3*t),0)':s=48000:d=${seconds}`,
    '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', source]);
  const projectDir = path.join(root, 'projects', 'kit-fixture');
  const workspace = createOrOpenProject({ projectDir, name: 'kit fixture', sourcePath: source });
  const words = Array.from({ length: seconds * 2 - 1 }, (_, i) => ({ w: i === 0 ? ' Привет,' : ` слово${i}`, s: i * 0.5, e: i * 0.5 + 0.4 }));
  fs.mkdirSync(path.join(projectDir, 'transcript'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, workspace.manifest.transcript.words), JSON.stringify([{ start: 0, end: seconds, text: '', words }]));
  return { root, projectDir, workspace };
}

module.exports = { makeLayerProject };
```

```js
// tests/layer-new.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolAvailable } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const newLayer = require('../scripts/layer/new');
const layerWords = require('../scripts/layer/words');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');

test('layer new scaffolds a renderable layer that matches the source geometry', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = path.join(projectDir, 'no-library');
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  assert.equal(await newLayer.run({ 'project-dir': projectDir }), 0);
  const dir = path.join(projectDir, 'motion-v01');
  const layer = JSON.parse(fs.readFileSync(path.join(dir, 'layer.json'), 'utf8'));
  assert.deepEqual([layer.fps, layer.width, layer.height, layer.durationInFrames, layer.profile], [25, 540, 960, 150, 'avatar']);
  assert.deepEqual(layer.face, { x: 270, y: 394 });
  assert.equal(layer.speaker.lastFrame, 149);
  for (const file of ['src/index.jsx', 'src/Root.jsx', 'src/plan.js', 'src/scenes.jsx', 'src/words.js', 'src/sfx-library.js',
    'spelling.json', 'README.md', 'public/speaker.mp4', 'public/fonts/Onest.ttf', 'public/fonts/OFL-Onest.txt',
    'public/stock/placeholder.mp4', 'public/shots/placeholder.png', 'public/SOURCE.md']) {
    assert.ok(fs.existsSync(path.join(dir, file)), file);
  }
  assert.match(fs.readFileSync(path.join(dir, 'src/words.js'), 'utf8'), /"t":"Привет,"/);
  assert.equal(await newLayer.run({ 'project-dir': projectDir }), 0);
  assert.ok(fs.existsSync(path.join(projectDir, 'motion-v02')));
  await assert.rejects(newLayer.run({ 'project-dir': projectDir, dir: 'motion-v01' }), /уже существует/);
});

test('layer words re-applies spelling.json', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = path.join(projectDir, 'no-library');
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  await newLayer.run({ 'project-dir': projectDir });
  const dir = path.join(projectDir, 'motion-v01');
  fs.writeFileSync(path.join(dir, 'spelling.json'), JSON.stringify({ 'привет': 'Здравствуйте' }));
  assert.equal(await layerWords.run({ 'project-dir': projectDir, layer: 'motion-v01' }), 0);
  assert.match(fs.readFileSync(path.join(dir, 'src/words.js'), 'utf8'), /"t":"Здравствуйте,"/);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/layer-new.test.js`
Expected: FAIL — `Cannot find module '../scripts/layer/new'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/layer/words.js
const fs = require('node:fs');
const path = require('node:path');
const { resolveProjectPath } = require('../project/workspace');
const { loadKitCore } = require('../motion-kit-node');
const { readJson, resolveLayer } = require('./common');

const FLAGS = { 'project-dir': 'value', layer: 'value' };

// Слова транскрипта проекта → src/words.js слоя с написанием из spelling.json.
function writeLayerWords(projectDir, manifest, layerDir) {
  const transcript = resolveProjectPath(projectDir, manifest.transcript.words, { label: 'manifest.transcript.words', mustExist: true, type: 'file' });
  const spellingPath = path.join(layerDir, 'spelling.json');
  const spelling = fs.existsSync(spellingPath) ? readJson(spellingPath) : {};
  const words = loadKitCore().flattenTranscript(readJson(transcript), { spelling });
  fs.mkdirSync(path.join(layerDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'src', 'words.js'), `// Сгенерировано automontage layer words — не править руками.\nexport default ${JSON.stringify(words)};\n`);
  return words.length;
}

async function run(options) {
  const { projectDir, manifest, layerDir } = resolveLayer(options);
  const count = writeLayerWords(projectDir, manifest, layerDir);
  console.log(`✅ слов: ${count} → ${path.join(options.layer, 'src', 'words.js')}`);
  return 0;
}

module.exports = { FLAGS, run, writeLayerWords };
```

```js
// scripts/layer/new.js
const fs = require('node:fs');
const path = require('node:path');
const { probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { resolveProjectPath } = require('../project/workspace');
const { LAYER_NAME, nextLayerName, projectFrom, writeJson } = require('./common');
const { copySfxLibrary, sfxLibraryDir } = require('./sfx-library');
const { writeLayerWords } = require('./words');

const FLAGS = { 'project-dir': 'value', dir: 'value', profile: 'value' };
const ENGINE_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE = path.join(ENGINE_ROOT, 'templates', 'motion-layer');
const FONTS = ['Onest.ttf', 'OFL-Onest.txt', 'Oswald.ttf', 'OFL-Oswald.txt'];

function copyTemplate(layerDir) {
  for (const file of ['src/index.jsx', 'src/Root.jsx', 'src/plan.js', 'src/scenes.jsx', 'README.md']) {
    fs.mkdirSync(path.dirname(path.join(layerDir, file)), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATE, file), path.join(layerDir, file));
  }
}

function placeholders(layerDir, { width, height, fps }) {
  const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];
  fs.mkdirSync(path.join(layerDir, 'public', 'stock'), { recursive: true });
  fs.mkdirSync(path.join(layerDir, 'public', 'shots'), { recursive: true });
  runTool('ffmpeg', [...quiet, '-f', 'lavfi', '-i', `gradients=s=${width}x${height}:r=${fps}:d=4:speed=0.03`,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(layerDir, 'public', 'stock', 'placeholder.mp4')], { stage: 'layer placeholder stock' });
  runTool('ffmpeg', [...quiet, '-f', 'lavfi', '-i', 'color=c=0xF4F6FA:s=1080x2400',
    '-vf', 'drawbox=x=60:y=60:w=960:h=140:color=0xDDE3EC:t=fill,drawbox=x=60:y=260:w=640:h=60:color=0xC7D0DC:t=fill,drawbox=x=60:y=380:w=960:h=900:color=0xE7ECF3:t=fill',
    '-frames:v', '1', path.join(layerDir, 'public', 'shots', 'placeholder.png')], { stage: 'layer placeholder screenshot' });
}

async function run(options) {
  const { projectDir, manifest, sourcePath } = projectFrom(options);
  const name = options.dir || nextLayerName(projectDir);
  if (!LAYER_NAME.test(name)) throw new Error('--dir должен быть вида motion-v01');
  const layerDir = resolveProjectPath(projectDir, name, { label: 'layer', mustExist: false });
  if (fs.existsSync(layerDir)) throw new Error(`папка ${name} уже существует — выберите другую через --dir`);
  const profile = options.profile || 'avatar';
  if (!['avatar', 'live'].includes(profile)) throw new Error('--profile: avatar или live');
  const probe = probeVideo(sourcePath);
  const durationInFrames = Math.round(probe.duration * probe.fps);
  fs.mkdirSync(path.join(layerDir, 'public', 'fonts'), { recursive: true });
  copyTemplate(layerDir);
  writeJson(path.join(layerDir, 'layer.json'), {
    version: 1, composition: 'Layer', fps: probe.fps, width: probe.width, height: probe.height, durationInFrames,
    face: { x: Math.round(probe.width * 0.5), y: Math.round(probe.height * 0.41) },
    profile, sfxMasterDb: -5, speaker: { src: 'speaker.mp4', lastFrame: durationInFrames - 1 },
  });
  writeJson(path.join(layerDir, 'spelling.json'), {});
  writeLayerWords(projectDir, manifest, layerDir);
  fs.copyFileSync(sourcePath, path.join(layerDir, 'public', 'speaker.mp4'), fs.constants.COPYFILE_FICLONE);
  for (const font of FONTS) fs.copyFileSync(path.join(ENGINE_ROOT, 'public', 'fonts', font), path.join(layerDir, 'public', 'fonts', font));
  const sfx = copySfxLibrary(sfxLibraryDir(), path.join(layerDir, 'public', 'sfx'));
  fs.writeFileSync(path.join(layerDir, 'src', 'sfx-library.js'), `// Сгенерировано automontage layer new.\nexport default ${JSON.stringify(sfx.library)};\n`);
  placeholders(layerDir, probe);
  fs.writeFileSync(path.join(layerDir, 'public', 'SOURCE.md'), [
    '# Источники материалов слоя', '',
    '| Файл | Лицензия / автор | Источник | SHA-256 или команда |', '|---|---|---|---|',
    `| \`speaker.mp4\` | исходник проекта | \`${manifest.source.localPath}\` | копия исходника |`,
    '| `fonts/Onest.ttf`, `fonts/Oswald.ttf` | SIL OFL 1.1 (`fonts/OFL-*.txt`) | Google Fonts | копия из движка |',
    ...sfx.sourceRows,
    '| `stock/placeholder.mp4`, `shots/placeholder.png` | заглушки, заменить | ffmpeg lavfi | automontage layer new |', '',
  ].join('\n'));
  console.log(`✅ слой ${name}: ${durationInFrames} кадров ${probe.width}×${probe.height}@${probe.fps}, звуков в библиотеке: ${Object.keys(sfx.library.sounds).length}`);
  console.log(`Дальше: правка ${name}/src/plan.js → automontage layer check --project-dir ${projectDir} --layer ${name}`);
  return 0;
}

module.exports = { FLAGS, run };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/layer-new.test.js`
Expected: PASS (2 теста).

- [ ] **Step 5: Коммит**

```bash
git add scripts/layer/new.js scripts/layer/words.js tests/helpers/layer-project.js tests/layer-new.test.js
git commit -m "feat: scaffold motion layers with automontage layer new"
```

### Task 32: `layer check`

**Уточнения после ревью пакета 1:**
- `readLayerJson` (с проверкой `sfxMasterDb` из Task 28) вызывается внутри `try`: испорченный `layer.json`
  даёт отчёт с `error` и код 2, а не «❌ layer check отменён». Профиль до чтения — `options.profile ||
  'avatar'`, после — `options.profile || layer.profile || 'avatar'`.
- Тест: `BAD CASE: a bad sfxMasterDb in layer.json exits 2 and names the field` — `sfxMasterDb: 3` → код 2,
  `report.error` содержит `layer.json` и `sfxMasterDb`.

**Files:**
- Create: `scripts/layer/check.js`
- Test: `tests/layer-check.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/layer-check.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolAvailable } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const newLayer = require('../scripts/layer/new');
const check = require('../scripts/layer/check');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');

async function scaffold(t) {
  const project = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = path.join(project.projectDir, 'no-library');
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  await newLayer.run({ 'project-dir': project.projectDir });
  return { ...project, layerDir: path.join(project.projectDir, 'motion-v01') };
}

test('the fresh template passes every stop gate and writes manifest and report', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir } = await scaffold(t);
  assert.equal(await check.run({ 'project-dir': projectDir, layer: 'motion-v01' }), 0);
  assert.ok(fs.existsSync(path.join(layerDir, 'out', 'manifest.json')));
  const report = JSON.parse(fs.readFileSync(path.join(projectDir, 'qa', 'layer-motion-v01-check.json'), 'utf8'));
  assert.equal(report.summary.fail, 0);
  assert.deepEqual(report.gates.map((g) => g.id), ['G1', 'G2', 'G3', 'G4', 'G5', 'G9', 'G10', 'G11']);
});

test('BAD CASE: one static shot for the whole layer exits 1, a broken plan exits 2', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir } = await scaffold(t);
  fs.writeFileSync(path.join(layerDir, 'src', 'plan.js'),
    "export default function buildPlan({ face }) { return { camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }] }, items: [] }; }\n");
  assert.equal(await check.run({ 'project-dir': projectDir, layer: 'motion-v01' }), 1);
  fs.writeFileSync(path.join(layerDir, 'src', 'plan.js'), 'export default function buildPlan( {\n');
  assert.equal(await check.run({ 'project-dir': projectDir, layer: 'motion-v01' }), 2);
  const report = JSON.parse(fs.readFileSync(path.join(projectDir, 'qa', 'layer-motion-v01-check.json'), 'utf8'));
  assert.match(report.error, /не собирается plan\.js/);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/layer-check.test.js`
Expected: FAIL — `Cannot find module '../scripts/layer/check'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/layer/check.js
const path = require('node:path');
const { buildLayerManifest } = require('../motion-kit-node');
const { getProfile } = require('../qa/profiles');
const { buildReport, exitCodeFor, formatReport, writeReport } = require('../qa/report');
const { runTimelineGates } = require('../qa/timeline-gates');
const { readLayerJson, resolveLayer, writeJson } = require('./common');

const FLAGS = { 'project-dir': 'value', layer: 'value', profile: 'value' };

async function run(options) {
  const { projectDir, layerDir, layerName } = resolveLayer(options);
  let profileName = options.profile || 'avatar';
  let report;
  try {
    profileName = options.profile || readLayerJson(layerDir).profile || 'avatar';
    const profile = getProfile(profileName);
    const manifest = buildLayerManifest(layerDir);
    writeJson(path.join(layerDir, 'out', 'manifest.json'), manifest);
    report = buildReport({ kind: 'layer-check', layer: layerName, profile: profileName, gates: runTimelineGates(manifest, profile) });
  } catch (error) {
    report = buildReport({ kind: 'layer-check', layer: layerName, profile: profileName, gates: [], error: error.message });
  }
  const paths = writeReport(projectDir, `layer-${layerName}-check`, report);
  console.log(formatReport(report));
  console.log(`Отчёт: ${paths.textPath}`);
  return exitCodeFor(report);
}

module.exports = { FLAGS, run };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/layer-check.test.js`
Expected: PASS (2 теста). Если первый тест падает на G1/G5 — чинить шаблон `plan.js`, а не пороги.

- [ ] **Step 5: Коммит**

```bash
git add scripts/layer/check.js tests/layer-check.test.js
git commit -m "feat: run timeline gates with automontage layer check"
```

### Task 33: Занятость машины и защищённая команда рендера слоя

**Files:**
- Create: `scripts/layer/busy.js`
- Modify: `scripts/build-commands.js` (+ `remotionLayerRenderCommand`)
- Modify: `tests/broll-render-env-security.test.js` (добавить builder `layer`)
- Test: `tests/layer-busy.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/layer-busy.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { busyRenders, waitUntilFree } = require('../scripts/layer/busy');
const { remotionLayerRenderCommand } = require('../scripts/build-commands');

function fakePs(table) {
  return (args) => {
    if (args[0] === '-ax') return table.map((p) => `${p.pid} ${p.comm}`).join('\n');
    const pid = Number(args[args.indexOf('-p') + 1]);
    return `${table.find((p) => p.pid === pid).command}\n`;
  };
}

test('only real node render processes count as busy, not shell wrappers holding script text', () => {
  const table = [
    { pid: 10, comm: '/bin/zsh', command: "zsh -c 'cat > q.sh <<EOF remotion render EOF'" },
    { pid: 11, comm: '/opt/homebrew/bin/node', command: 'node node_modules/@remotion/cli/remotion-cli.js --env-file=x render src/index.js Lesson out.mp4' },
    { pid: 12, comm: 'node', command: 'node scripts/cli.js preview --project-dir p' },
    { pid: 13, comm: 'node', command: 'node some-server.js' },
  ];
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [] }).map((p) => p.pid), [11, 12]);
  assert.deepEqual(busyRenders({ psImpl: fakePs(table.slice(0, 1)), selfPids: [] }), []);
});

test('waitUntilFree polls until the machine is free and times out with the blocking command', async () => {
  let calls = 0;
  const logs = [];
  await waitUntilFree({ busyImpl: () => (calls++ < 2 ? [{ pid: 1, command: 'render' }] : []), sleep: async () => {}, log: (m) => logs.push(m) });
  assert.equal(calls, 3);
  assert.equal(logs.length, 2);
  let t = 0;
  await assert.rejects(waitUntilFree({ busyImpl: () => [{ pid: 1, command: 'node render' }], sleep: async () => { t += 60_000; }, now: () => t, timeoutMs: 120_000, log: () => {} }),
    /машина занята дольше 2 мин: node render/);
});

test('layer render command keeps the empty env-file first and never needs props', () => {
  const command = remotionLayerRenderCommand({ command: 'node', argsPrefix: ['cli.js', '--env-file=empty.env'] },
    { entry: 'layer/src/index.jsx', composition: 'Layer', output: 'out.mp4', publicDir: 'layer/public' });
  assert.deepEqual(command.args.slice(0, 5), ['cli.js', '--env-file=empty.env', 'render', 'layer/src/index.jsx', 'Layer']);
  assert.ok(command.args.includes('--public-dir'));
  assert.ok(!command.args.includes('--props'));
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/layer-busy.test.js`
Expected: FAIL — `Cannot find module '../scripts/layer/busy'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/layer/busy.js
// Занятость машины — только по настоящим процессам node (shell-обёртки с текстом скрипта не в счёт).
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MARKERS = ['remotion render', 'remotion/cli.js render', 'cli.js preview', 'scripts/build.js'];
const REMOTION_CLI = /@remotion[\\/]cli[\\/]\S*\s.*\brender\b/u;
const defaultPs = (args) => execFileSync('ps', args, { encoding: 'utf8', shell: false });

function busyRenders({ psImpl = defaultPs, selfPids = [process.pid, process.ppid] } = {}) {
  const nodes = psImpl(['-ax', '-o', 'pid=,comm=']).split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => { const [pid, ...rest] = line.split(/\s+/u); return { pid: Number(pid), comm: rest.join(' ') }; })
    .filter((p) => path.basename(p.comm) === 'node' && !selfPids.includes(p.pid));
  const busy = [];
  for (const p of nodes) {
    let command;
    try {
      command = psImpl(['-o', 'command=', '-p', String(p.pid)]).trim().replace(/\s+/gu, ' ');
    } catch (_) {
      continue;
    }
    if (MARKERS.some((m) => command.includes(m)) || REMOTION_CLI.test(command)
      || (command.includes('scripts/cli.js') && command.includes('--template'))) {
      busy.push({ pid: p.pid, command: command.slice(0, 160) });
    }
  }
  return busy;
}

async function waitUntilFree({ busyImpl = busyRenders, pollMs = 30_000, timeoutMs = 3 * 3600_000, log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const started = now();
  for (;;) {
    const busy = busyImpl();
    if (!busy.length) return;
    if (now() - started >= timeoutMs) {
      throw new Error(`машина занята дольше ${Math.round(timeoutMs / 60_000)} мин: ${busy[0].command}`);
    }
    log(`⏳ идёт другой рендер (pid ${busy[0].pid}), жду ${Math.round(pollMs / 1000)} с…`);
    await sleep(pollMs);
  }
}

module.exports = { busyRenders, waitUntilFree };
```

В `scripts/build-commands.js` рядом с `remotionRenderCommand`:

```js
// Рендер проектного motion-слоя: props не нужны (слой читает свой layer.json), звук эффектов сохраняется.
function remotionLayerRenderCommand(resolved, { entry, composition, output, publicDir, concurrency = '50%' }) {
  return {
    command: resolved.command,
    args: [
      ...resolved.argsPrefix, 'render', entry, composition, hostPath(output),
      '--public-dir', hostPath(publicDir), '--codec=h264', '--log=error', `--concurrency=${concurrency}`, '--overwrite',
    ],
  };
}
```

и добавить его в `module.exports`. В `tests/broll-render-env-security.test.js` в объект `builders` добавить:

```js
  layer: (resolved) => remotionLayerRenderCommand(resolved, {
    entry: 'projects/p/motion-v01/src/index.jsx', composition: 'Layer', output: 'out.mp4', publicDir: 'projects/p/motion-v01/public',
  }),
```

(и импорт `remotionLayerRenderCommand` рядом с `remotionRenderCommand`).

- [ ] **Step 4: Запустить**

Run: `node --test tests/layer-busy.test.js tests/broll-render-env-security.test.js`
Expected: PASS; тест безопасности проверяет и новый builder.

- [ ] **Step 5: Коммит**

```bash
git add scripts/layer/busy.js scripts/build-commands.js tests/layer-busy.test.js tests/broll-render-env-security.test.js
git commit -m "feat: wait for a free machine and render layers with the protected Remotion command"
```

### Task 34: `layer render` — рендер, нормализация, G6 и G7

**Files:**
- Create: `scripts/layer/render.js`
- Test: `tests/layer-render.test.js`

- [ ] **Step 1: Написать падающий тест**

Вместо настоящего Remotion подставляется функция, которая кладёт в `output` ролик lavfi нужной длины и
со звуком. Остальная цепочка (нормализация ffmpeg, probe, PCM, гейты, отчёт) — настоящая.

```js
// tests/layer-render.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const newLayer = require('../scripts/layer/new');
const render = require('../scripts/layer/render');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');

function fakeRemotion(seconds, audioLavfi) {
  const calls = [];
  const runToolImpl = (command, args, options) => {
    if (options.stage !== 'layer Remotion render') return runTool(command, args, options);
    calls.push(args);
    const output = args[args.indexOf('render') + 3];
    return runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=540x960:r=25:d=${seconds}`,
      '-f', 'lavfi', '-i', audioLavfi, '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', output]);
  };
  return { calls, runToolImpl };
}

async function scaffold(t) {
  const project = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = path.join(project.projectDir, 'no-library');
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  await newLayer.run({ 'project-dir': project.projectDir });
  return project;
}

const EFFECTS = "aevalsrc='0.8*sin(2*PI*1000*t)*lt(mod(t,2.3),0.08)':s=48000:d=6";

test('a good layer renders, normalises to limited-range yuv420p and passes G6 and G7', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = await scaffold(t);
  const fake = fakeRemotion(6, EFFECTS);
  const code = await render.run({ 'project-dir': projectDir, layer: 'motion-v01', 'no-wait': true }, { runToolImpl: fake.runToolImpl });
  assert.equal(code, 0);
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0].some((a) => String(a).startsWith('--env-file=')));
  const out = path.join(projectDir, 'motion-v01', 'renders', 'layer-01.mp4');
  assert.ok(fs.existsSync(out));
  const report = JSON.parse(fs.readFileSync(path.join(projectDir, 'qa', 'layer-motion-v01-render-01.json'), 'utf8'));
  assert.deepEqual(report.gates.map((g) => [g.id, g.status]), [['G6', 'pass'], ['G7', 'pass']]);
  assert.match(report.inputs[0].sha256, /^[a-f0-9]{64}$/);
});

test('BAD CASE: a layer longer than the source is rendered but stopped by G6', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = await scaffold(t);
  const code = await render.run({ 'project-dir': projectDir, layer: 'motion-v01', 'no-wait': true }, { runToolImpl: fakeRemotion(6.4, EFFECTS).runToolImpl });
  assert.equal(code, 1);
});

test('a failing layer check blocks the render before Remotion starts', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = await scaffold(t);
  fs.writeFileSync(path.join(projectDir, 'motion-v01', 'src', 'plan.js'),
    "export default function buildPlan({ face }) { return { camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }] }, items: [] }; }\n");
  const fake = fakeRemotion(6, EFFECTS);
  assert.equal(await render.run({ 'project-dir': projectDir, layer: 'motion-v01', 'no-wait': true }, { runToolImpl: fake.runToolImpl }), 1);
  assert.equal(fake.calls.length, 0);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/layer-render.test.js`
Expected: FAIL — `Cannot find module '../scripts/layer/render'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/layer/render.js
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, resolveRemotionCommand } = require('../env');
const { remotionLayerRenderCommand } = require('../build-commands');
const { probeVideo } = require('../media-probe');
const { captureToolResult, runTool } = require('../process');
const { decodeAudio, envelopeDb } = require('../qa/audio');
const { gateLayerDuration, gateVoiceLeak } = require('../qa/media-gates');
const { getProfile } = require('../qa/profiles');
const { buildReport, exitCodeFor, formatReport, writeReport } = require('../qa/report');
const check = require('./check');
const { waitUntilFree } = require('./busy');
const { readLayerJson, relative, resolveLayer, sha256File } = require('./common');

const FLAGS = { 'project-dir': 'value', layer: 'value', profile: 'value', 'no-wait': 'bool' };
const pad = (n) => String(n).padStart(2, '0');

function nextRender(rendersDir) {
  let n = 1;
  while (fs.existsSync(path.join(rendersDir, `layer-${pad(n)}.mp4`))) n += 1;
  return n;
}

function hasAudio(file) {
  const out = captureToolResult('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
    { maxBuffer: 1024 * 1024, stage: 'layer audio probe' });
  return String(out.stdout).trim().length > 0;
}

async function run(options, deps = {}) {
  const runToolImpl = deps.runToolImpl || runTool;
  const { projectDir, layerDir, layerName, sourcePath } = resolveLayer(options);
  const checkCode = await check.run({ 'project-dir': projectDir, layer: layerName, ...(options.profile ? { profile: options.profile } : {}) });
  if (checkCode !== 0) {
    console.error('❌ рендер не запущен: сначала исправьте план слоя (отчёт layer check выше)');
    return checkCode;
  }
  if (!options['no-wait']) await (deps.waitUntilFree || waitUntilFree)();
  const layer = readLayerJson(layerDir);
  const profileName = options.profile || layer.profile || 'avatar';
  const rendersDir = path.join(layerDir, 'renders');
  fs.mkdirSync(rendersDir, { recursive: true });
  const n = nextRender(rendersDir);
  const raw = path.join(rendersDir, `layer-${pad(n)}.raw.mp4`);
  const out = path.join(rendersDir, `layer-${pad(n)}.mp4`);
  const command = remotionLayerRenderCommand(resolveRemotionCommand(ROOT), {
    entry: path.join(layerDir, 'src', 'index.jsx'), composition: layer.composition, output: raw, publicDir: path.join(layerDir, 'public'),
  });
  runToolImpl(command.command, command.args, { cwd: ROOT, stage: 'layer Remotion render' });
  runToolImpl('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw,
    '-vf', 'scale=in_range=full:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '14',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', out], { cwd: ROOT, stage: 'layer normalize' });
  fs.rmSync(raw, { force: true });
  const profile = getProfile(profileName);
  const layerEnv = hasAudio(out) ? envelopeDb(decodeAudio(out)) : null;
  const gates = [
    gateLayerDuration({ layer: probeVideo(out), source: probeVideo(sourcePath) }, profile),
    gateVoiceLeak({ layerEnv, sourceEnv: envelopeDb(decodeAudio(sourcePath)), audioMode: 'mix' }, profile),
  ];
  const report = buildReport({ kind: 'layer-render', layer: layerName, profile: profileName, gates,
    inputs: [{ path: relative(projectDir, out), sha256: sha256File(out) }] });
  const paths = writeReport(projectDir, `layer-${layerName}-render-${pad(n)}`, report);
  console.log(formatReport(report));
  console.log(`Отчёт: ${paths.textPath}`);
  if (exitCodeFor(report) === 0) console.log(`Дальше: automontage layer import --project-dir ${projectDir} --file ${out}`);
  return exitCodeFor(report);
}

module.exports = { FLAGS, run };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/layer-render.test.js`
Expected: PASS (3 теста).

- [ ] **Step 5: Коммит**

```bash
git add scripts/layer/render.js tests/layer-render.test.js
git commit -m "feat: render motion layers with duration and voice leak gates"
```

### Task 35: Импорт под нагрузкой: `-threads 1` для VP8-прокси

Под нагрузкой многопоточный libvpx падал до ~18 кадров в минуту, однопоточный давал ~9 кадров в
секунду (наблюдение пакета 27.09). Прокси нужен только для просмотра в Review.

**Files:**
- Modify: `scripts/review/media-import.js` (`videoProxyInvocation`)
- Modify: `tests/review-media-import.test.js` (закреплённые аргументы)

- [ ] **Step 1: Написать падающий тест**

В `tests/review-media-import.test.js` рядом с проверкой аргументов прокси (строки ~731–737) добавить:

```js
test('regression: VP8 review proxy encodes in one thread so imports do not crawl under render load', () => {
  const source = require('node:fs').readFileSync(require.resolve('../scripts/review/media-import.js'), 'utf8');
  assert.match(source, /'-c:v', 'libvpx', '-threads', '1', '-crf', '32', '-b:v', '0'/);
});
```

и в существующем ожидании аргументов прокси заменить `'-c:v', 'libvpx', '-crf', '32', '-b:v', '0'` на
`'-c:v', 'libvpx', '-threads', '1', '-crf', '32', '-b:v', '0'`.

- [ ] **Step 2: Запустить**

Run: `node --test tests/review-media-import.test.js`
Expected: FAIL — новый тест и обновлённое ожидание.

- [ ] **Step 3: Реализовать**

В `videoProxyInvocation`: `'-c:v', 'libvpx', '-crf', '32', '-b:v', '0',` → `'-c:v', 'libvpx', '-threads', '1', '-crf', '32', '-b:v', '0',`.

- [ ] **Step 4: Запустить**

Run: `node --test tests/review-media-import.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add scripts/review/media-import.js tests/review-media-import.test.js
git commit -m "fix: encode the VP8 review proxy in one thread under render load"
```

### Task 36: `layer import` и реестр проверенных слоёв

**Files:**
- Create: `scripts/layer/registry.js`, `scripts/layer/import.js`
- Test: `tests/layer-import.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/layer-import.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { sha256File, writeJson } = require('../scripts/layer/common');
const { findByCanonical, findByReference } = require('../scripts/layer/registry');
const layerImport = require('../scripts/layer/import');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');

function renderedLayer(projectDir, status) {
  const file = path.join(projectDir, 'motion-v01', 'renders', 'layer-01.mp4');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=108x192:r=25:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=900:duration=6', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', file]);
  if (status) {
    writeJson(path.join(projectDir, 'qa', 'layer-motion-v01-render-01.json'), { version: 1, kind: 'layer-render', layer: 'motion-v01',
      profile: 'avatar', inputs: [{ path: 'motion-v01/renders/layer-01.mp4', sha256: sha256File(file) }], gates: [], summary: { status, fail: status === 'fail' ? 1 : 0, warn: 0 }, error: null });
  }
  return file;
}

test('import refuses a layer that never passed layer render, or failed it', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t);
  const file = renderedLayer(projectDir, null);
  await assert.rejects(layerImport.run({ 'project-dir': projectDir, file }), /не проходил layer render/);
  renderedLayer(projectDir, 'fail');
  await assert.rejects(layerImport.run({ 'project-dir': projectDir, file }), /не прошёл проверки/);
});

test('a checked layer is imported through the official path and registered', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t);
  const file = renderedLayer(projectDir, 'pass');
  assert.equal(await layerImport.run({ 'project-dir': projectDir, file }), 0);
  const entry = findByReference(projectDir, JSON.parse(fs.readFileSync(path.join(projectDir, 'qa', 'layer-imports.json'), 'utf8')).imports[0].reference);
  assert.equal(entry.layer, 'motion-v01');
  assert.match(entry.reference, /^assets\/broll\/video\/[^/]+\/media\.mp4$/);
  assert.equal(findByCanonical(projectDir, entry.canonicalSha256).renderSha256, sha256File(file));
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/layer-import.test.js`
Expected: FAIL — `Cannot find module '../scripts/layer/registry'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/layer/registry.js
// qa/layer-imports.json: какие импортированные ассеты — проверенные слои kit (по SHA-256).
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('./common');

const file = (projectDir) => path.join(projectDir, 'qa', 'layer-imports.json');

function readRegistry(projectDir) {
  return fs.existsSync(file(projectDir)) ? readJson(file(projectDir)) : { version: 1, imports: [] };
}

function appendRegistry(projectDir, entry) {
  const registry = readRegistry(projectDir);
  registry.imports = registry.imports.filter((e) => e.canonicalSha256 !== entry.canonicalSha256).concat(entry);
  writeJson(file(projectDir), registry);
}

const findByCanonical = (projectDir, sha256) => readRegistry(projectDir).imports.find((e) => e.canonicalSha256 === sha256) || null;
const findByReference = (projectDir, reference) => readRegistry(projectDir).imports.find((e) => e.reference === reference) || null;

// Отчёт layer render, в котором проверялся именно этот файл.
function findRenderReport(projectDir, sha256) {
  const dir = path.join(projectDir, 'qa');
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir).filter((n) => /^layer-.+-render-\d+\.json$/u.test(n)).sort().reverse()) {
    const report = readJson(path.join(dir, name));
    if (report.inputs?.some((input) => input.sha256 === sha256)) return { ...report, fileName: name };
  }
  return null;
}

module.exports = { appendRegistry, findByCanonical, findByReference, findRenderReport, readRegistry };
```

```js
// scripts/layer/import.js
const fs = require('node:fs');
const path = require('node:path');
const { configureMediaToolPath } = require('../env');
const { probeVideo } = require('../media-probe');
const { createImportController, importReviewMedia } = require('../review/media-import');
const { runMediaProcess } = require('../review/media-process');
const { projectFrom, sha256File } = require('./common');
const { appendRegistry, findRenderReport } = require('./registry');

const FLAGS = { 'project-dir': 'value', file: 'value' };

async function run(options) {
  const { projectDir, sourcePath } = projectFrom(options);
  if (!options.file) throw new Error('нужен --file <motion-vNN/renders/layer-NN.mp4>');
  const file = path.resolve(options.file);
  const renderSha256 = sha256File(file);
  const report = findRenderReport(projectDir, renderSha256);
  if (!report) throw new Error('этот файл не проходил layer render: импортируется только проверенный слой');
  if (report.error || report.summary.status === 'fail') throw new Error(`слой не прошёл проверки: qa/${report.fileName}`);
  if (typeof configureMediaToolPath === 'function') configureMediaToolPath();
  const imported = await importReviewMedia({
    request: fs.createReadStream(file),
    signal: new AbortController().signal,
    projectDir,
    outputFps: probeVideo(sourcePath).fps,
    headers: {
      'content-length': String(fs.statSync(file).size),
      'content-type': 'video/mp4',
      'x-automontage-filename': encodeURIComponent(path.basename(file)),
    },
    controller: createImportController(),
    runMediaProcessImpl: runMediaProcess,
  });
  const asset = imported.asset || imported;
  appendRegistry(projectDir, { layer: report.layer, profile: report.profile, renderSha256,
    canonicalSha256: asset.canonicalSha256, reference: asset.reference, importedAt: new Date().toISOString() });
  console.log(JSON.stringify({ reference: asset.reference, canonicalSha256: asset.canonicalSha256 }, null, 2));
  console.log(`Дальше: automontage layer brief --project-dir ${projectDir} --asset ${asset.reference} --title … --head-cream … --head-orange …`);
  return 0;
}

module.exports = { FLAGS, run };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/layer-import.test.js`
Expected: PASS (2 теста).

- [ ] **Step 5: Коммит**

```bash
git add scripts/layer/registry.js scripts/layer/import.js tests/layer-import.test.js
git commit -m "feat: import only checked motion layers and register them"
```

### Task 37: `layer brief`

**Уточнения после ревью пакета 1:**
- Слой — ровно одна сцена `broll` на весь хронометраж; тест закрепляет `brief.scenes.length === 1`. Резать слой
  на несколько сцен нельзя: `brollEnvelope` (`src/scenes/BrollMedia.jsx`) приглушает звук слоя
  `round(0,12·fps)` кадров на входе и выходе каждой сцены, и эффекты на стыках сцен частично глохнут.
- Даже одна сцена приглушает первые и последние 0,12 с: звук хука на t = 0 в preview звучит тише задуманного.
  `layer brief` после публикации печатает подсказку «звук слоя в первые и последние 0,12 с приглушён
  огибающей сцены — эффект хука ставьте не раньше 0,12 с»; то же правило — в `motion-layer-brief.md`
  (Task 44), на пробе (Task 49) эффект хука проверить на слух.

**Files:**
- Create: `scripts/layer/brief.js`
- Test: `tests/layer-brief.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/layer-brief.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLessonBrief } = require('../scripts/lesson/brief');
const { buildLayerBrief } = require('../scripts/layer/brief');

const entry = { layer: 'motion-v01', profile: 'avatar', reference: 'assets/broll/video/1b2c/media.mp4', canonicalSha256: 'a'.repeat(64) };
const base = { sourcePath: '/tmp/p/input/source.mp4', probe: { width: 1080, height: 1920, fps: 25, duration: 84.36 },
  entry, title: 'Тема', headCream: 'ТЕМА', headOrange: 'РОЛИКА', audioMode: 'mix' };

test('layer brief is one full-length broll scene without overlay, with preview-required review', () => {
  const brief = buildLayerBrief({ ...base, music: { file: '/tmp/m.mp3', gainDb: -16, startSec: 3 } });
  assert.equal(validateLessonBrief(brief).ok, true, JSON.stringify(validateLessonBrief(brief).errors));
  assert.equal(brief.status, 'draft');
  assert.equal(brief.brollReviewPolicy, 'preview-required');
  assert.deepEqual(brief.output, { aspect: 'vertical', width: 1080, height: 1920, fps: 25, durationInFrames: 2109 });
  assert.equal(brief.scenes.length, 1, 'слой — одна сцена: brollEnvelope глушит звук слоя на стыках сцен');
  const [scene] = brief.scenes;
  assert.deepEqual([scene.scene, scene.start, scene.end], ['broll', 0, 84.36]);
  assert.deepEqual(scene.brollMedia, { kind: 'video', src: entry.reference, sha256: entry.canonicalSha256, trimStartSec: 0, fit: 'cover', audioMode: 'mix', overlay: 'none' });
  assert.deepEqual(brief.music.ducking, { thresholdDb: -40, ratio: 4, attackMs: 10, releaseMs: 260 });
});

test('live profile keeps the engine default ducking and a brief without music stays valid', () => {
  const brief = buildLayerBrief({ ...base, entry: { ...entry, profile: 'live' }, music: { file: '/tmp/m.mp3', gainDb: -12, startSec: 0 } });
  assert.equal(brief.music.ducking, undefined);
  assert.equal(validateLessonBrief(buildLayerBrief({ ...base, music: null })).ok, true);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/layer-brief.test.js`
Expected: FAIL — `Cannot find module '../scripts/layer/brief'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/layer/brief.js
const path = require('node:path');
const { formatBriefMarkdown, validateLessonBrief } = require('../lesson/brief');
const { probeVideo } = require('../media-probe');
const { createOrOpenProject, publishBriefRevision } = require('../project/workspace');
const { projectFrom } = require('./common');
const { findByReference } = require('./registry');

const FLAGS = { 'project-dir': 'value', asset: 'value', title: 'value', 'head-cream': 'value', 'head-orange': 'value',
  audio: 'value', music: 'value', 'music-gain-db': 'value', 'music-start-sec': 'value' };
const AVATAR_DUCKING = { thresholdDb: -40, ratio: 4, attackMs: 10, releaseMs: 260 };

function aspectOf({ width, height }) {
  if (width === 1080 && height === 1920) return 'vertical';
  if (width === 1920 && height === 1080) return 'horizontal';
  return 'source';
}

function buildLayerBrief({ sourcePath, probe, entry, title, headCream, headOrange, audioMode = 'mix', music = null }) {
  const brief = {
    version: 1, status: 'draft', source: sourcePath, theme: 'lesson-neutral', title,
    facePos: { x: 0.5, y: 0.41 }, faceZoom: 1, brollReviewPolicy: 'preview-required',
    output: { aspect: aspectOf(probe), width: probe.width, height: probe.height, fps: probe.fps, durationInFrames: Math.round(probe.duration * probe.fps) },
    corrections: [],
    scenes: [{
      scene: 'broll', start: 0, end: probe.duration, videoTitle: ' ', headCream, headOrange, showSpeakerPip: false,
      brollMedia: { kind: 'video', src: entry.reference, sha256: entry.canonicalSha256, trimStartSec: 0, fit: 'cover', audioMode, overlay: 'none' },
      reason: `Motion-слой ${entry.layer} на весь хронометраж: графика, звуки и субтитры внутри слоя, голос — из исходника по глобальному таймкоду. Слой прошёл layer check и layer render.`,
    }],
  };
  if (music) {
    brief.music = { file: music.file, gainDb: music.gainDb, fadeInSec: 0.35, fadeOutSec: 1.2, startSec: music.startSec, playbackRate: 1,
      ...(entry.profile === 'avatar' ? { ducking: { ...AVATAR_DUCKING } } : {}) };
  }
  return brief;
}

async function run(options) {
  const { projectDir, sourcePath } = projectFrom(options);
  for (const flag of ['asset', 'title', 'head-cream', 'head-orange']) if (!options[flag]) throw new Error(`нужен --${flag}`);
  const entry = findByReference(projectDir, options.asset);
  if (!entry) throw new Error('ассет не импортирован через layer import: brief принимает только проверенный слой');
  const audioMode = options.audio || 'mix';
  if (!['mix', 'mute'].includes(audioMode)) throw new Error('--audio: mix или mute');
  const music = options.music ? {
    file: path.resolve(options.music),
    gainDb: Number(options['music-gain-db'] ?? (entry.profile === 'avatar' ? -16 : -12)),
    startSec: Number(options['music-start-sec'] ?? 0),
  } : null;
  const brief = buildLayerBrief({ sourcePath, probe: probeVideo(sourcePath), entry, title: options.title,
    headCream: options['head-cream'], headOrange: options['head-orange'], audioMode, music });
  const check = validateLessonBrief(brief);
  if (!check.ok) throw new Error(`brief невалиден:\n${(check.errors || []).join('\n')}`);
  const workspace = createOrOpenProject({ projectDir });
  const result = publishBriefRevision(workspace, { brief, markdown: formatBriefMarkdown(brief) });
  console.log(`✅ черновик ${result.relativePath}`);
  console.log('Звук слоя в первые и последние 0,12 с приглушён огибающей сцены — эффект хука ставьте не раньше 0,12 с.');
  console.log(`Дальше: automontage preview --project-dir ${projectDir} --brief ${result.relativePath}`);
  return 0;
}

module.exports = { FLAGS, buildLayerBrief, run };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/layer-brief.test.js`
Expected: PASS (2 теста). Если `validateLessonBrief` отклоняет поле — сверить с `schema/lesson-brief.schema.json`
и поправить `buildLayerBrief`, а не схему.

- [ ] **Step 5: Коммит**

```bash
git add scripts/layer/brief.js tests/layer-brief.test.js
git commit -m "feat: publish a draft brief for a checked motion layer"
```

### Task 38: `layer stock` — сток Pexels в слой

**Уточнения после ревью пакета 1:**
- Сток короче окна вставки замирает на последнем кадре (`StockInsert` держит видео своей `Sequence` до `to`).
  Новый флаг `--insert <id>`: длина клипа по умолчанию — длина этой вставки `(to − from)/fps` из
  `buildLayerManifest(layerDir).inserts`, округлённая вверх до 0,1 с; явный `--sec` важнее; без `--insert` —
  2,5 с, как раньше. Неизвестный id — ошибка со списком id stock-вставок. `FLAGS` += `insert: 'value'`.
- `layer check` предупреждает о коротком стоке: для каждой `kind: 'stock'` вставки с `src` (поле манифеста из
  Task 22) меряет `probeVideo(public/<src>).duration`; клип короче окна больше чем на кадр — G10 получает `warn`
  (если был `pass`) и span «сток <src> короче вставки <id> на X с — последний кадр замрёт»; нет файла — тот же
  `warn` с «нет public/<src>». Тест: сток 1 с на вставку 2 с → G10 `warn`, код 0.
- Тест `layer stock`: `--insert stock-1` без `--sec` даёт клип длиной вставки шаблона (≈ 2 с).

**Files:**
- Create: `scripts/layer/stock.js`
- Modify: `scripts/layer/check.js` (предупреждение о коротком стоке)
- Test: `tests/layer-stock.test.js`, `tests/layer-check.test.js` (дописать)

- [ ] **Step 1: Написать падающий тест**

```js
// tests/layer-stock.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { probeVideo } = require('../scripts/media-probe');
const newLayer = require('../scripts/layer/new');
const stock = require('../scripts/layer/stock');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const candidate = { providerAssetId: '12345', sourcePage: 'https://www.pexels.com/video/12345/', author: { name: 'Автор', url: 'https://www.pexels.com/@a' },
  license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' }, width: 1080, height: 1920, durationSec: 8,
  downloadUrl: 'https://videos.pexels.com/video-files/12345/a.mp4', queryOriginal: 'люди за ноутбуком', retrievedAt: '2026-01-01T00:00:00.000Z' };

async function scaffold(t) {
  const project = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = path.join(project.projectDir, 'no-library');
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  await newLayer.run({ 'project-dir': project.projectDir });
  return project;
}

test('without PEXELS_API_KEY the command explains that stock search is optional', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = await scaffold(t);
  await assert.rejects(stock.run({ 'project-dir': projectDir, layer: 'motion-v01', query: 'people laptop' }, { env: {} }), /PEXELS_API_KEY не задан/);
});

test('a picked Pexels clip is cropped to the layer, muted and recorded with its provenance', { skip: !hasFfmpeg }, async (t) => {
  const { root, projectDir } = await scaffold(t);
  const downloaded = path.join(root, 'download.mp4');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=4',
    '-f', 'lavfi', '-i', 'sine=duration=4', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', downloaded]);
  const deps = { env: { PEXELS_API_KEY: 'k' },
    createProvider: () => ({ search: async (input) => { assert.equal(input.orientation, 'portrait'); return { candidates: [candidate] }; } }),
    request: async (req) => { assert.equal(req.url, candidate.downloadUrl); return { bytes: fs.readFileSync(downloaded) }; } };
  assert.equal(await stock.run({ 'project-dir': projectDir, layer: 'motion-v01', query: 'people laptop', 'query-original': 'люди за ноутбуком', sec: '2' }, deps), 0);
  const clip = path.join(projectDir, 'motion-v01', 'public', 'stock', 'pexels-12345.mp4');
  const probe = probeVideo(clip);
  assert.deepEqual([probe.width, probe.height, probe.fps], [540, 960, 25]);
  assert.ok(Math.abs(probe.duration - 2) < 0.1);
  const source = fs.readFileSync(path.join(projectDir, 'motion-v01', 'public', 'SOURCE.md'), 'utf8');
  assert.match(source, /\| `stock\/pexels-12345\.mp4` \| Pexels License, Автор \| https:\/\/www\.pexels\.com\/video\/12345\/ \| [a-f0-9]{64} \|/);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/layer-stock.test.js`
Expected: FAIL — `Cannot find module '../scripts/layer/stock'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/layer/stock.js
const fs = require('node:fs');
const path = require('node:path');
const { createPexelsProvider, VIDEO_HOSTS } = require('../broll/pexels');
const { LIMITS, requestRemote } = require('../broll/remote');
const { runTool } = require('../process');
const { readLayerJson, resolveLayer, sha256File } = require('./common');

const FLAGS = { 'project-dir': 'value', layer: 'value', query: 'value', 'query-original': 'value', sec: 'value', pick: 'value', list: 'bool' };

async function run(options, deps = {}) {
  const env = deps.env || process.env;
  if (!env.PEXELS_API_KEY) {
    throw new Error('PEXELS_API_KEY не задан: поиск стока необязателен — положите клип в public/stock/ вручную или добавьте ключ в .env');
  }
  const { layerDir } = resolveLayer(options);
  if (!options.query) throw new Error('нужен --query (английский запрос для Pexels)');
  const layer = readLayerJson(layerDir);
  const sec = Number(options.sec || 2.5);
  const provider = (deps.createProvider || createPexelsProvider)({ apiKey: env.PEXELS_API_KEY });
  const { candidates } = await provider.search({ mediaKind: 'video', queryEnglish: options.query,
    queryOriginal: options['query-original'] || options.query, orientation: layer.height > layer.width ? 'portrait' : 'landscape', minDurationSec: sec });
  if (!candidates.length) throw new Error('Pexels ничего не нашёл: переформулируйте запрос');
  if (options.list) {
    candidates.forEach((c, i) => console.log(`${i + 1}. ${c.providerAssetId} ${c.width}×${c.height} ${c.durationSec} с — ${c.author.name} ${c.sourcePage}`));
    return 0;
  }
  const candidate = candidates[Number(options.pick || 1) - 1];
  if (!candidate) throw new Error(`--pick вне списка 1–${candidates.length}`);
  const response = await (deps.request || requestRemote)({ url: candidate.downloadUrl, allowedHosts: VIDEO_HOSTS,
    maxBytes: LIMITS.video, timeoutMs: 120_000, expectedMimeTypes: ['video/mp4'] });
  const outDir = path.join(layerDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(layerDir, 'public', 'stock'), { recursive: true });
  const download = path.join(outDir, `pexels-${candidate.providerAssetId}.download.mp4`);
  fs.writeFileSync(download, response.bytes);
  const name = `pexels-${candidate.providerAssetId}.mp4`;
  const target = path.join(layerDir, 'public', 'stock', name);
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', download, '-t', String(sec),
    '-vf', `scale=${layer.width}:${layer.height}:force_original_aspect_ratio=increase,crop=${layer.width}:${layer.height},fps=${layer.fps}`,
    '-an', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', target], { stage: 'layer stock normalize' });
  fs.rmSync(download, { force: true });
  const row = `| \`stock/${name}\` | ${candidate.license.name}, ${candidate.author.name} | ${candidate.sourcePage} | ${sha256File(target)} | «${options['query-original'] || options.query}», ${candidate.retrievedAt} |`;
  fs.appendFileSync(path.join(layerDir, 'public', 'SOURCE.md'), `${row}\n`);
  console.log(`✅ сток stock/${name}: вставка { kind: 'stock', src: 'stock/${name}' } в plan.js`);
  return 0;
}

module.exports = { FLAGS, run };
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/layer-stock.test.js`
Expected: PASS (2 теста).

- [ ] **Step 5: Коммит**

```bash
git add scripts/layer/stock.js scripts/layer/check.js tests/layer-stock.test.js tests/layer-check.test.js
git commit -m "feat: fetch Pexels stock into motion layers with provenance"
```

### Task 39: `layer sheet` — контакт-лист, кадры правок пульта, G12

**Files:**
- Create: `scripts/layer/sheet.js`
- Test: `tests/layer-sheet.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/layer-sheet.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { buildSheet, sheetTimes } = require('../scripts/layer/sheet');

test('sheet times sit in the middle of 16 equal slices', () => {
  assert.deepEqual(sheetTimes(16).slice(0, 3), [0.5, 1.5, 2.5]);
  assert.equal(sheetTimes(16).length, 16);
});

test('contact sheet, comment strips and empty frame warnings from a real video', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-sheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'preview.mp4');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=108x192:r=25:d=4',
    '-f', 'lavfi', '-i', 'testsrc2=s=108x192:r=25:d=4', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', video]);
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 8, outDir: dir, name: 'sheet-test',
    comments: [{ id: 'c-1234abcd', timeSec: 6 }] });
  assert.ok(fs.statSync(result.sheetPath).size > 0);
  assert.ok(fs.statSync(result.commentPaths[0]).size > 0);
  assert.equal(result.gate.id, 'G12');
  assert.equal(result.gate.status, 'warn');
  assert.ok(result.gate.value >= 7);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/layer-sheet.test.js`
Expected: FAIL — `Cannot find module '../scripts/layer/sheet'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/layer/sheet.js
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readComments } = require('../pult/comments');
const { probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { resolveProjectPath } = require('../project/workspace');
const { gate } = require('../qa/report');
const { safeRect } = require('../qa/safe-rect');
const { projectFrom } = require('./common');

const FLAGS = { 'project-dir': 'value' };
const THUMB = 270;
const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];

const sheetTimes = (duration, n = 16) => Array.from({ length: n }, (_, i) => Number((((i + 0.5) * duration) / n).toFixed(3)));

function frameStats(videoPath, timeSec) {
  const result = spawnSync('ffmpeg', [...quiet, '-ss', String(timeSec), '-i', videoPath, '-frames:v', '1',
    '-vf', 'scale=32:-2,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024, shell: false });
  if (result.status !== 0 || !result.stdout.length) return null;
  const values = [...result.stdout];
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, variance };
}

function thumb(videoPath, timeSec, out, box) {
  const drawbox = `drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=yellow@0.7:t=1`;
  runTool('ffmpeg', [...quiet, '-ss', String(timeSec), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${THUMB}:-2,${drawbox}`, out], { stage: 'sheet frame' });
}

// Контакт-лист 4×4 с рамкой safe-зоны, полоски кадров вокруг секунд правок пульта и G12 «пустые кадры».
function buildSheet({ videoPath, width, height, duration, outDir, name, comments = [] }) {
  const k = THUMB / width;
  const safe = safeRect(width, height);
  const box = { x: Math.round(safe.left * k), y: Math.round(safe.top * k), w: Math.round((safe.right - safe.left) * k), h: Math.round((safe.bottom - safe.top) * k) };
  const work = path.join(outDir, `${name}.frames`);
  fs.mkdirSync(work, { recursive: true });
  const times = sheetTimes(duration);
  times.forEach((t, i) => thumb(videoPath, t, path.join(work, `f${String(i + 1).padStart(2, '0')}.png`), box));
  const sheetPath = path.join(outDir, `${name}.jpg`);
  runTool('ffmpeg', [...quiet, '-i', path.join(work, 'f%02d.png'), '-vf', 'tile=4x4', '-frames:v', '1', sheetPath], { stage: 'sheet tile' });
  const commentPaths = comments.map((comment) => {
    const strip = path.join(work, comment.id);
    fs.mkdirSync(strip, { recursive: true });
    [-1, -0.5, 0, 0.5, 1].forEach((d, i) => thumb(videoPath, Math.min(Math.max(0, comment.timeSec + d), Math.max(0, duration - 0.05)), path.join(strip, `f${i + 1}.png`), box));
    const out = path.join(outDir, `comment-${comment.id}.jpg`);
    runTool('ffmpeg', [...quiet, '-i', path.join(strip, 'f%d.png'), '-vf', 'tile=5x1', '-frames:v', '1', out], { stage: 'sheet comment' });
    return out;
  });
  fs.rmSync(work, { recursive: true, force: true });
  const empty = times.filter((t) => { const s = frameStats(videoPath, t); return !s || s.mean <= 10 || s.variance <= 100; });
  return {
    sheetPath, commentPaths,
    gate: gate('G12', 'Пустые кадры', { status: empty.length ? 'warn' : 'pass', value: empty.length, unit: 'из 16', threshold: 'яркость > 10, разброс > 100',
      spans: empty.slice(0, 5).map((t) => ({ fromSec: t, toSec: t, note: 'пустой или однотонный кадр' })), hint: 'проверьте, не выпала ли графика или видео слоя' }),
  };
}

async function run(options) {
  const { projectDir, manifest } = projectFrom(options);
  const current = manifest.currentPreview;
  if (!current) throw new Error('в проекте нет текущего preview');
  const videoPath = resolveProjectPath(projectDir, current.filePath, { label: 'currentPreview.filePath', mustExist: true, type: 'file' });
  const probe = probeVideo(videoPath);
  const comments = readComments(projectDir).filter((c) => c.status === 'new')
    .map((c) => ({ id: c.id, timeSec: c.timeSec - (current.fromSec || 0) })).filter((c) => c.timeSec >= 0 && c.timeSec <= probe.duration);
  const result = buildSheet({ videoPath, width: probe.width, height: probe.height, duration: probe.duration,
    outDir: path.join(projectDir, 'qa'), name: `sheet-${current.sha256.slice(0, 8)}`, comments });
  console.log(`Контакт-лист: ${result.sheetPath}`);
  result.commentPaths.forEach((p) => console.log(`Кадры правки: ${p}`));
  console.log(`${result.gate.status === 'pass' ? '✅' : '⚠️'} G12 Пустые кадры: ${result.gate.value} из 16`);
  return 0;
}

module.exports = { FLAGS, buildSheet, run, sheetTimes };
```

`sheetTimes(16)` в тесте — это `sheetTimes(duration = 16)`: середины 16 отрезков по 1 с.

- [ ] **Step 4: Запустить**

Run: `node --test tests/layer-sheet.test.js`
Expected: PASS (2 теста).

- [ ] **Step 5: Коммит**

```bash
git add scripts/layer/sheet.js tests/layer-sheet.test.js
git commit -m "feat: add contact sheet, pult comment frames and empty frame gate"
```

## Фаза 8. Барьер в `preview`

### Task 40: Гейты перед публикацией preview

Для слоя kit (его SHA-256 есть в `qa/layer-imports.json`) стоп блокирует публикацию: новый preview
не появляется, в пульте остаётся прошлый. Для прочих роликов те же проверки — только предупреждение
(поведение существующих проектов не меняется).

**Files:**
- Create: `scripts/qa/preview-gates.js`
- Modify: `scripts/preview.js` (вызов после `mix-music`, до `publishCurrentPreview`)
- Test: `tests/qa-preview-gates.test.js`, `tests/lesson-preview.test.js` (дописать, там уже есть `makeProject` и `fakePreviewTools`)

- [ ] **Step 1: Написать падающий тест**

```js
// tests/qa-preview-gates.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJson } = require('../scripts/layer/common');
const { runPreviewGates } = require('../scripts/qa/preview-gates');

function project(t, { registered, renderStatus = 'pass' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-gates-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (registered) {
    writeJson(path.join(dir, 'qa', 'layer-imports.json'), { version: 1, imports: [{ layer: 'motion-v01', profile: 'avatar', renderSha256: 'r'.repeat(64), canonicalSha256: 'c'.repeat(64), reference: 'assets/broll/video/x/media.mp4' }] });
    writeJson(path.join(dir, 'qa', 'layer-motion-v01-render-01.json'), { kind: 'layer-render', layer: 'motion-v01', inputs: [{ sha256: 'r'.repeat(64) }], summary: { status: renderStatus }, error: null });
  }
  return dir;
}
const brief = { scenes: [{ scene: 'broll', brollMedia: { kind: 'video', sha256: 'c'.repeat(64) } }] };
const loud = () => ({ median: 0.5, p10: 0, blocks: 100 });

test('a kit layer with music at the voice level blocks the preview', (t) => {
  const result = runPreviewGates({ projectDir: project(t, { registered: true }), brief, hasMusic: true, words: [], range: { fromSec: 0, toSec: 10 } },
    { measureImpl: loud });
  assert.equal(result.block, true);
  assert.deepEqual(result.report.gates.map((g) => [g.id, g.status]), [['L', 'pass'], ['G8', 'fail']]);
});

test('a kit layer whose render failed blocks even with good music', (t) => {
  const result = runPreviewGates({ projectDir: project(t, { registered: true, renderStatus: 'fail' }), brief, hasMusic: true, words: [], range: { fromSec: 0, toSec: 10 } },
    { measureImpl: () => ({ median: 12, p10: 10, blocks: 100 }) });
  assert.equal(result.block, true);
  assert.equal(result.report.gates[0].status, 'fail');
});

test('other projects only get warnings and are never blocked', (t) => {
  const result = runPreviewGates({ projectDir: project(t, { registered: false }), brief, hasMusic: true, words: [], range: { fromSec: 0, toSec: 10 } },
    { measureImpl: loud });
  assert.equal(result.block, false);
  assert.equal(result.report.gates[0].status, 'warn');
  assert.equal(result.report.profile, 'live');
});
```

В `tests/lesson-preview.test.js` (рядом с тестом «preview command runs the real composition stages»):

```js
test('blocking preview gates stop publication and keep the previous preview', (t) => {
  const fixture = makeProject(t, { music: true });
  const calls = [];
  const blocked = { block: true, paths: { textPath: 'qa/preview-1.txt' },
    report: { kind: 'preview', summary: { status: 'fail', fail: 1, warn: 0 }, gates: [] } };
  assert.throws(() => runPreview({ projectDir: fixture.workspace.dir, briefPath: fixture.published.relativePath, open: false },
    { ...fakePreviewTools({ calls }), runPreviewGatesImpl: () => blocked }),
  /preview не опубликован: проверки не пройдены \(qa\/preview-1\.txt\)/);
  assert.ok(!readProjectManifest(fixture.workspace.dir).currentPreview);
  assert.deepEqual(calls, ['preview Remotion', 'preview finish', 'preview music mix']);
});
```

Существующий тест порядка стадий остаётся без изменений: настоящий `runPreviewGates` не вызывает
`runToolImpl`, а замер на текстовых подменах падает и для не-kit проекта становится предупреждением.

- [ ] **Step 2: Запустить**

Run: `node --test tests/qa-preview-gates.test.js`
Expected: FAIL — `Cannot find module '../scripts/qa/preview-gates'`.

- [ ] **Step 3: Реализовать**

```js
// scripts/qa/preview-gates.js
const { parseMixOptions } = require('../mix-music');
const { findByCanonical, findRenderReport } = require('../layer/registry');
const { gateVoiceMusic, measureVoiceMusic, speechWindows } = require('./mix-gates');
const { getProfile } = require('./profiles');
const { buildReport, gate, writeReport } = require('./report');

function layerEntry(projectDir, brief) {
  const scene = (brief.scenes || []).find((s) => s.scene === 'broll' && s.brollMedia?.kind === 'video');
  return scene ? findByCanonical(projectDir, scene.brollMedia.sha256) : null;
}

// Возвращает {report, block}. block = true только для слоя kit со стоп-нарушением.
function runPreviewGates({ projectDir, brief, hasMusic, words, range, finishedPath, musicPath, mixArgs }, deps = {}) {
  const entry = layerEntry(projectDir, brief);
  const profileName = entry?.profile || 'live';
  const profile = getProfile(profileName);
  const gates = [];
  if (entry) {
    const render = findRenderReport(projectDir, entry.renderSha256);
    const ok = render && !render.error && render.summary.status !== 'fail';
    gates.push(gate('L', 'Слой прошёл layer check и layer render', { status: ok ? 'pass' : 'fail', hint: 'пересоберите слой: layer render → layer import' }));
  }
  let measured = null;
  let failure = null;
  if (hasMusic) {
    try {
      const windows = speechWindows(words, { fromSec: range.fromSec, toSec: range.toSec });
      measured = (deps.measureImpl || measureVoiceMusic)({ voicePath: finishedPath, musicPath,
        mixOptions: mixArgs ? parseMixOptions(mixArgs) : null, durationSec: range.toSec - range.fromSec, windows });
    } catch (error) {
      failure = error.message;
    }
  }
  gates.push(failure
    ? gate('G8', 'Голос и музыка', { status: 'fail', hint: `замер не удался: ${failure}` })
    : gateVoiceMusic(measured, profile, { hasMusic }));
  const enforced = entry ? gates : gates.map((g) => (g.status === 'fail'
    ? { ...g, status: 'warn', hint: `${g.hint} (ролик без слоя kit — только предупреждение)`.trim() } : g));
  const report = buildReport({ kind: 'preview', layer: entry?.layer || null, profile: profileName, gates: enforced });
  return { report, block: Boolean(entry) && report.summary.status === 'fail',
    paths: deps.write === false ? null : writeReport(projectDir, `preview-${Date.now()}`, report) };
}

module.exports = { layerEntry, runPreviewGates };
```

В тестах `runPreviewGates` отчёт пишется в временную папку проекта — это нормально.

В `scripts/preview.js`:

1. Импорт: `const { runPreviewGates } = require('./qa/preview-gates');` и
   `const { formatReport } = require('./qa/report');`.
2. В `runPreview`: `const runPreviewGatesImpl = dependencies.runPreviewGatesImpl || runPreviewGates;`.
3. Перед `withPreviewMediaBundleImpl` объявить `let gateResult = null;`.
4. Внутри колбэка, сразу после блока `if (prepared.music) { … }` (для `kind !== 'motion-reel'`):

```js
      if (kind !== 'motion-reel') {
        gateResult = runPreviewGatesImpl({
          projectDir, brief, hasMusic: Boolean(prepared.music), words: readProjectWords(projectDir, manifest),
          range: prepared.range, finishedPath: planned.finishedPath,
          musicPath: prepared.music ? (lease.musicPath || prepared.music.sourcePath) : null,
          mixArgs: prepared.music ? prepared.music.mixArgs : null,
        });
      }
```

5. Сразу после вызова `withPreviewMediaBundleImpl(…)` — до `runToolImpl('ffmpeg', … 'preview decode')`,
   чтобы заблокированный preview не тратил время на полное декодирование (промежуточные файлы удалит
   существующий `finally { cleanupPreviewStages(...) }`, прошлый preview остаётся):

```js
    if (gateResult) console.log(formatReport(gateResult.report));
    if (gateResult?.block) {
      throw new Error(`preview не опубликован: проверки не пройдены (${gateResult.paths?.textPath || 'qa/'})`);
    }
```

6. Помощник в `preview.js`:

```js
function readProjectWords(projectDir, manifest) {
  if (!manifest.transcript?.words) return [];
  const file = resolveProjectPath(projectDir, manifest.transcript.words, { label: 'manifest.transcript.words', mustExist: false, type: 'file' });
  if (!fs.existsSync(file)) return [];
  const segments = JSON.parse(fs.readFileSync(file, 'utf8'));
  return segments.flatMap((segment) => segment.words || [])
    .filter((w) => Number.isFinite(w.s) && Number.isFinite(w.e)).map((w) => ({ s: w.s, e: w.e }));
}
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/qa-preview-gates.test.js && npm test`
Expected: PASS; все существующие тесты preview зелёные: их проекты не слои kit, поэтому неудачный
замер на подменённых файлах превращается в предупреждение и публикацию не блокирует.

- [ ] **Step 5: Коммит**

```bash
git add scripts/qa/preview-gates.js scripts/preview.js tests/qa-preview-gates.test.js tests/preview*.test.js
git commit -m "feat: block publishing kit previews that fail the voice-music gate"
```

### Task 41: Настоящий кадр шаблона (глубокая проверка, по флагу)

**Уточнения после ревью пакета 1:**
- На полосе субтитров `[data-kit-text="captions"]` дополнительно проверять `scrollWidth ≤ clientWidth &&
  scrollHeight ≤ clientHeight` (как unbroken-caption в `tests/motion-render.test.js`): кегль подогнан в одну
  строку, и `overflow: hidden` полосы ничего не срезал.
- Мерить в том же кадре, который снимается: `renderStill` ждёт все `delayRender` — гейт `FontLoader`, которым
  шаблон оборачивает весь слой, и подгонку кегля `Subtitles`; до этого `[data-kit-text]` в DOM ещё нет.
  Как это делается в настоящем браузере — `tests/motion-kit-render.test.js` (Task 18).
- Кадры для 10-секундного шаблона: 5 и 40 — титул и субтитры, 90 — середина скриншот-карточки (3,0–5,6 с),
  160 — сток (6–8 с, раскрытие закончилось к кадру 159).

**Files:**
- Test: `tests/layer-render-still.test.js`

- [ ] **Step 1: Написать тест**

По образцу `tests/motion-render.test.js`: включается `AUTOMONTAGE_TEST_MOTION_RENDER=1`. Создаёт проект
(`makeLayerProject`, 1080×1920 вместо 108×192 — параметр `size`), `layer new`, затем `bundle` из
`@remotion/bundler` с `webpackOverride: (c) => withMotionKitAlias(c)` и `renderStill` кадров 5, 40,
середины карточки и середины стока; через `page.evaluate` меряет все `[data-kit-text]` и сверяет с
`safeRect(1080, 1920)`; ожидание — ни одного выхода и ненулевой PNG.

```js
// tests/layer-render-still.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

test('real Remotion stills of the template keep every kit text inside the safe zone', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 300_000,
}, async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderStill, selectComposition } = require('@remotion/renderer');
  const { withMotionKitAlias } = require('../scripts/remotion-webpack');
  const { safeRect } = require('../scripts/qa/safe-rect');
  const { makeLayerProject } = require('./helpers/layer-project');
  const newLayer = require('../scripts/layer/new');
  const { projectDir } = makeLayerProject(t, { seconds: 10, size: '1080x1920' });
  process.env.AUTOMONTAGE_SFX_DIR = path.join(projectDir, 'no-library');
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  await newLayer.run({ 'project-dir': projectDir });
  const layerDir = path.join(projectDir, 'motion-v01');
  const serveUrl = await bundle({ entryPoint: path.join(layerDir, 'src', 'index.jsx'), publicDir: path.join(layerDir, 'public'),
    webpackOverride: (config) => withMotionKitAlias(config) });
  const browser = await openBrowser('chrome', { logLevel: 'error' });
  t.after(() => browser.close({ silent: true }));
  const composition = await selectComposition({ serveUrl, id: 'Layer', puppeteerInstance: browser });
  const safe = safeRect(1080, 1920);
  for (const frame of [5, 40, 90, 160]) {
    const output = path.join(layerDir, 'out', `still-${frame}.png`);
    await renderStill({ serveUrl, composition, frame, output, puppeteerInstance: browser,
      onBrowserLog: () => {}, overwrite: true });
    assert.ok(fs.statSync(output).size > 1000, `frame ${frame}`);
  }
  assert.ok(safe.right === 950);
});
```

Параметр `size` добавить в `makeLayerProject` (`testsrc2=s=${size}`), по умолчанию `108x192`. Замер
`[data-kit-text]` через DOM — перенести из `tests/motion-render.test.js:100-140` (перехват `page.close`),
заменив селекторы на `[data-kit-text]` и границы на `safeRect(1080, 1920)`.

- [ ] **Step 2: Запустить**

Run: `AUTOMONTAGE_TEST_MOTION_RENDER=1 node --test tests/layer-render-still.test.js`
Expected: PASS за 1–3 минуты. Без флага — `skipped`.

- [ ] **Step 3: Коммит**

```bash
git add tests/layer-render-still.test.js tests/helpers/layer-project.js
git commit -m "test: render real template stills and measure kit text boxes"
```

## Фаза 9. Документы и навыки

### Task 42: Пользовательская документация kit

**Files:**
- Create: `docs/MOTION-KIT.md`
- Modify: `README.md` (раздел команд), `.env.example`, `ASSETS.md` (Policy)
- Test: `tests/motion-kit-docs.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
// tests/motion-kit-docs.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('motion kit is documented for people and agents', () => {
  const guide = read('docs/MOTION-KIT.md');
  for (const id of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12']) assert.match(guide, new RegExp(`\\b${id}\\b`));
  for (const cmd of ['layer new', 'layer check', 'layer render', 'layer import', 'layer brief', 'layer stock', 'layer sheet']) assert.match(guide, new RegExp(cmd));
  assert.match(guide, /@automontage\/motion-kit\/core/);
  assert.match(read('README.md'), /automontage layer new --project-dir/);
  assert.match(read('.env.example'), /^AUTOMONTAGE_SFX_DIR=$/m);
  assert.match(read('ASSETS.md'), /AUTOMONTAGE_SFX_DIR/);
  assert.doesNotMatch(guide, /\/Users\/|projects\/20\d\d/);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/motion-kit-docs.test.js`
Expected: FAIL — `ENOENT … docs/MOTION-KIT.md`.

- [ ] **Step 3: Написать документы**

`docs/MOTION-KIT.md` — разделы (по-русски, простым языком, с примерами команд):

1. **Зачем.** Слой ролика собирается из готовых деталей движка; в пульт попадает только проверенный preview.
2. **Путь нового ролика.** `layer new` → правка `src/plan.js` и `src/scenes.jsx` → `layer check` → `layer stock`
   (по желанию) → `layer render` → `layer import` → `layer brief` → `automontage preview` → `layer sheet` → пульт.
3. **Контракт слоя** — дерево `motion-vNN/` и `LayerPlan` из этого плана (раздел «Контракт слоя»).
4. **API kit.** Импорт: `plan.js` — только `@automontage/motion-kit/core`; `Root.jsx`/`scenes.jsx` —
   `@automontage/motion-kit`. Таблица: `autoShots`, `makeAnchors`, `pickSound`, пресеты камеры W/M/L/R/top,
   входы pop/fly/mask/cut, `typed`, `SpeakerLayer`, `KitBox`, `StockInsert`, `FullscreenReveal` (`revealCard`),
   `BrowserFrame`/`ScrollShot({src, from, to, scroll})`/`ShutterFlash({at})`, `SfxTrack({cues, masterDb})`,
   `Subtitles`, `FontLoader` (гейт, оборачивает весь слой), чистые `captionSpans`, `activeChunk(chunks, sec,
   hide, fps)`, `cueVolume`.
5. **Гейты G1–G12**: таблица «что проверяет → порог → где считается (check/render/preview/sheet) → стоп или
   предупреждение → как чинить»; исключения `waivers` только для G1, G4, G11 и только с причиной.
6. **Профили** `avatar` и `live`, коридор «голос − музыка» и откуда он взят (DECISIONS).
7. **Звуки**: локальная библиотека `AUTOMONTAGE_SFX_DIR` (`*.wav` + `library.json`), почему не в Git, роли по
   префиксу имени (`whoosh-in` → `whoosh`), громкость `sfxMasterDb`.
8. **Ограничения**: слой должен лежать вне `node_modules` (npm-установка движка не транспилирует JSX оттуда);
   анимации заданы в пикселях кадра 1080×1920; проверка safe-zone видит только текст внутри `KitBox` и `Subtitles`.

**Уточнения после ревью пакета 1** (в разделы 4 и 8 `docs/MOTION-KIT.md`):
- `ScrollShot`: `scroll` — доля страницы 0..1 (не пиксели); прокрутка карточки — от конца входа
  `from + ref25(8)` до начала выхода `until − ref25(5)`. `ShutterFlash`: `at` — `hitFrame` звука затвора, после
  входа карточки. `FontLoader` — `<FontLoader faces={FONTS}>…весь слой…</FontLoader>`. `Subtitles` — одна строка,
  кегль подгоняется по ширине полосы. `StockInsert`/`FullscreenReveal`/`KitBox` принимают только
  скомпилированные элементы; cover-вставка не короче 0,68 с (при 25 fps); `screen`/`scene` проект рисует через
  `FullscreenReveal`.
- Вспышки — не чаще раза в секунду: затвор — заметный звук, `thinCues` держит такие звуки ≥ 1 с друг от друга,
  а шаблон ставит вспышку только на оставшийся звук.
- Скриншоты — не выше ~16k px. Широкий скриншот не прокручивается и обрезается по бокам (cover): брать
  карточку близкой пропорции или высокий full-page.
- `radius` и `scale` у `BrowserFrame` — в px эталона 1080 (умножаются на короткую сторону кадра / 1080).
- G5 видит `item.box`, а не вылезающий текст: содержимое карточки обязано помещаться в свой box.
- Звук слоя в первые и последние 0,12 с приглушает огибающая сцены preview (`brollEnvelope`, Task 37).

`README.md` — в раздел команд добавить блок:

```bash
automontage layer new --project-dir projects/<ролик>                 # motion-слой из деталей kit
automontage layer check --project-dir projects/<ролик> --layer motion-v01
automontage layer render --project-dir projects/<ролик> --layer motion-v01
automontage layer import --project-dir projects/<ролик> --file projects/<ролик>/motion-v01/renders/layer-01.mp4
automontage layer brief --project-dir projects/<ролик> --asset <reference> --title … --head-cream … --head-orange …
```

и ссылку «Подробно: `docs/MOTION-KIT.md`».

`.env.example` — после `AUTOMONTAGE_FFMPEG_DIR`:

```bash
# Локальная библиотека звуковых эффектов motion-слоя: <name>.wav + необязательный library.json.
# Файлы в репозиторий не входят (лицензии вроде Mixkit запрещают раздачу). По умолчанию
# projects/.library/sfx; без библиотеки слой рендерится без эффектов.
AUTOMONTAGE_SFX_DIR=
```

`ASSETS.md`, раздел Policy — пункт:

```md
- Sound effects for motion layers are never tracked: `automontage layer new` copies them from the local
  `AUTOMONTAGE_SFX_DIR` library into the ignored project folder and records license and SHA-256 in the
  layer's `public/SOURCE.md`.
```

- [ ] **Step 4: Запустить**

Run: `node --test tests/motion-kit-docs.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add docs/MOTION-KIT.md README.md .env.example ASSETS.md tests/motion-kit-docs.test.js
git commit -m "docs: document motion-kit layers and QA gates"
```

### Task 43: ARCHITECTURE, DECISIONS, TESTING, CHANGELOG

**Files:**
- Modify: `ARCHITECTURE.md` (новый подраздел `### 3.5 Motion-kit слой и гейты`, строки в §5, §6, §7)
- Modify: `DECISIONS.md` (D-034 … D-037)
- Modify: `TESTING.md` (новый раздел `## 12. Motion-kit и гейты`)
- Modify: `CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: ARCHITECTURE.md**

§3.5 — поток: `project source + transcript` → `layer new` (`motion-vNN/`, `layer.json`, words, sfx) →
`plan.js` → `compileLayer` (kit) → два потребителя: Remotion (`Root.jsx`) и `buildManifest` →
`scripts/qa/timeline-gates.js`; `layer render` (`remotionLayerRenderCommand` + `resolveRemotionCommand`) →
нормализация → `media-gates` → `layer import` (`importReviewMedia`, `qa/layer-imports.json`) → `layer brief`
→ `preview` (`finish.js` → `mix-music.js` → `qa/preview-gates.js` → публикация или стоп). §5 — строки про
`scripts/layer/*`, `scripts/qa/*`, `scripts/motion-kit-node.js`, `src/motion-kit/*`, `templates/motion-layer/`.
§6 — артефакты `motion-vNN/out/manifest.json`, `motion-vNN/renders/`, `qa/*.json|txt`,
`qa/layer-imports.json`. §7 — `AUTOMONTAGE_SFX_DIR`.

- [ ] **Step 2: DECISIONS.md**

- **D-034 – Motion-kit импортируется из движка, стартовые файлы ролика копируются.** Контекст (пять копий
  камеры и звука в пакете, три круга правок), варианты (npm-пакет; полная копия; импорт + копия шаблона),
  решение и последствия (правка kit меняет перерендер старых слоёв — утверждённый final не меняется, он
  собран из импортированного MP4 с SHA-256; `kitVersion` в манифесте).
- **D-035 – QA-гейты в трёх точках, стоп только для объективных нарушений.** Пороги G1–G12, профили `avatar`
  и `live`, исключения только G1/G4/G11 с причиной; для не-kit роликов гейты `preview` — предупреждения.
  Замер «голос − музыка» по настоящим дорожкам после нормализации, а не моделью на сыром голосе; коридор
  `avatar` откалиброван по утверждённому эталонному preview: R = `<значение из Task 47>` dB.
- **D-036 – Звук слоя kit: только эффекты, `audioMode: "mix"`, громкость `sfxMasterDb`.** Почему не поле
  brief (D-014: громкость — подготовка медиа; Review не меняется); почему библиотека вне Git (лицензия).
- **D-037 – Вставка раскрывается из карточки safe-зоны, спикер возвращается до её закрытия.** См. уточнение ниже.

**Уточнения после ревью пакета 1** (D-037): стартовая карточка `FullscreenReveal` — safe-зона кадра
(`revealCard`): для 9:16 инсеты `{top: 250, right: 130, bottom: 420, left: 70}` вместо плановой константы
`{420, 56, 420, 130}` под один формат, 16:9 работает той же формулой. Спикер полностью возвращается (резкий,
непрозрачный) к началу закрытия вставки (`away.to = to − close − exit`), поэтому cover-вставка не короче
`close + exit + 1` кадра (0,68 с при 25 fps). Отклонено: константа под 1080×1920 (неверная карточка на 16:9) и
возврат к самому концу вставки (на стыке видно размытое тёмное кольцо вместо лица).

- [ ] **Step 3: TESTING.md**

Раздел 12: команды `node --test tests/motion-kit-*.test.js tests/qa-*.test.js tests/layer-*.test.js`;
список пяти плохих случаев с именами тестов `BAD CASE: …`; глубокий рендер
`AUTOMONTAGE_TEST_MOTION_RENDER=1 node --test tests/layer-render-still.test.js`; ручная проверка слоя
(`layer sheet`, кадры входов/выходов).

- [ ] **Step 4: CHANGELOG.md, `[Unreleased]` → «Добавлено» / «Исправлено»**

Добавлено: motion-kit (`src/motion-kit/`), команды `automontage layer new|words|check|render|import|brief|stock|sheet`,
QA-гейты G1–G12 и барьер в `preview`. Исправлено: VP8-прокси импорта кодируется в один поток; рендер
проектного слоя идёт только через защищённый `--env-file`.

- [ ] **Step 5: Проверить и закоммитить**

Run: `npm test && node scripts/check-public-privacy.js --staged`
Expected: PASS.

```bash
git add ARCHITECTURE.md DECISIONS.md TESTING.md CHANGELOG.md
git commit -m "docs: record motion-kit architecture, decisions and tests"
```

### Task 44: Единое задание субагенту слоя и контракт Creative Motion

Три задания пакета (v1 — правила и вход, v2 — живая камера, звук, настоящие вставки, v3 — громкости и
ритм ≤ 2,5 с) сведены в один публичный шаблон без имён клиентов и личных путей.

**Files:**
- Create: `skills/reel-turnkey/references/motion-layer-brief.md`
- Modify: `skills/reel-turnkey/references/creative-motion.md`, `skills/reel-turnkey/references/qa-checklist.md`
- Test: `tests/creative-motion-instructions.test.js` (дописать)

- [ ] **Step 1: Дописать падающий тест**

```js
test('motion layer brief and creative motion start with the kit and its gates', () => {
  const brief = read('skills/reel-turnkey/references/motion-layer-brief.md');
  for (const rule of ['automontage layer new', 'automontage layer check', '70/130/250/420', '2,5 с', 'muted', 'public/SOURCE.md', 'hook: \'enumeration\'', 'waivers']) {
    assert.ok(brief.includes(rule), rule);
  }
  assert.doesNotMatch(brief, /\/Users\/|\/home\/|projects\/20\d\d/u);
  const creative = read('skills/reel-turnkey/references/creative-motion.md');
  assert.match(creative, /automontage layer new/);
  assert.match(creative, /audioMode: "mix"/);
  const checklist = read('skills/reel-turnkey/references/qa-checklist.md');
  assert.match(checklist, /2,5 секунды/);
  assert.match(checklist, /automontage layer check/);
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/creative-motion-instructions.test.js`
Expected: FAIL — `ENOENT … motion-layer-brief.md`.

- [ ] **Step 3: Написать шаблон и поправить контракт**

`skills/reel-turnkey/references/motion-layer-brief.md`:

```md
# Задание субагенту: motion-слой ролика на motion-kit

Читает субагент, который собирает motion-слой одного ролика. Пиши только в
`projects/<папка ролика>/motion-vNN/`. Не трогай `src/`, `scripts/`, `schema/`, другие ролики и git.
Полный рендер не запускай — его делает оркестратор (`automontage layer render` сам ждёт свободную машину).
Для проверки кадров — `npx remotion still` из корня движка (до ~10 кадров за итерацию) и
`automontage layer check` (секунды).

## Вход

| Что | Где |
|---|---|
| Слой из шаблона | `automontage layer new --project-dir <папка>` → `motion-vNN/` |
| Слова с таймкодами (`w` — как услышал Whisper, `t` — как писать) | `motion-vNN/src/words.js`; написание брендов — `spelling.json`, затем `automontage layer words` |
| Тема, разбор донора, текст озвучки | папка ролика (`research/`, `script.md`) |
| Звуки | `public/sfx/` — скопированы из локальной библиотеки, источник в `public/SOURCE.md` |

## Что уже есть в kit — не писать заново

- Живая камера: `camera.shots` (пресеты W/M/L/R/top, стартовая раскадровка `autoShots`), `punches`, `blurs`,
  `aways`; аватар — один `OffthreadVideo muted` в `SpeakerLayer` по глобальному таймкоду.
- Карточки: `items` с входом pop/fly/mask/cut, жизнью и выходом; весь текст — внутри `KitBox` и помещается в
  свой `box` (safe-zone проверяется по box, а не по тексту).
- Вставки: `inserts` stock/screen/donor/scene; сток с Ken Burns (`StockInsert`), раскрытие на весь кадр из
  карточки safe-зоны (`FullscreenReveal`); спикер уходит под полноэкранную вставку сам и возвращается к началу
  её закрытия; полноэкранная вставка — не короче 0,68 с; `screen`/`scene` рисуются в `scenes.jsx`
  (`InsertContent`) через `FullscreenReveal`.
- Скриншот-карточка: `BrowserFrame` + `ScrollShot` (`scroll` — доля страницы 0..1, прокрутка между входом и
  выходом карточки) + `ShutterFlash` на ударе звука затвора после входа карточки (шаблон делает это сам).
- Звук: `sfx` у элемента или вставки, `type` для набора текста; kit ставит пик whoosh на удар, держит
  заметные звуки ≥ 1 с друг от друга и любые ≥ 0,3 с; громкость эффектов — `sfxMasterDb` в `layer.json`;
  первый эффект — не раньше 0,12 с (огибающая сцены preview приглушает начало и конец слоя).
- Субтитры: `captions` — 1–4 слова одной строкой в полосе safe-зоны, кегль подгоняется по ширине; `hide` на
  полноэкранных сценах. Шрифты — только через `<FontLoader faces={FONTS}>`, который оборачивает весь слой.

## Правила, которые проверяет `automontage layer check`

- План спикера без события — не дольше 2,5 с (цель ≤ 2,2 с). Событие: джамп-кат ≥ 15 % или сдвиг лица
  ≥ 85 px, панч-ин на общем плане W, размытие под графикой, уход под вставку. Медленный дрейф — не событие.
- Масштаб аватара ≤ 1,25 (исходник аватара растянут из 720p).
- Спикер виден в первые 3 с. Хук-перечисление без человека — только по решению владельца: `hook: 'enumeration'`.
- Весь текст — внутри safe-zone 70/130/250/420 px на каждом кадре, включая вход и выход; никаких
  отрицательных `left`/`translateX` за экран.
- 3–4 стоковые вставки по смыслу фраз (`automontage layer stock`), без читаемых чужих брендов.
- Чужое видео — только 2–3 с подряд, с подписью автора; выдуманные сатирой цитаты — с меткой «САТИРА».
- Исключение из правила ритма, хука или чужого видео — только строкой `waivers: [{ gate, reason }]`
  с причиной (например, номер правки владельца).

## Правила владельца, которые гейт не видит

- Каждый элемент появляется на своём слове (`makeAnchors(words).at('слово')`), не пачкой в начале сцены.
- Смена картинки или заметного состояния — каждые 2–3 с; тезис не висит дольше 3 с.
- Схемы строятся по смыслу: блок → связь → следующий блок → итог. Pan/zoom готовой картинки — не анимация.
- Нет больших пустых однотонных карточек с одной фразой.
- Где речь называет реальные вещи (сайты, посты, рассылки, книги, видео) — настоящие скриншоты, по
  возможности на русском; лицо в этот момент уходит.
- У каждой карточки вход (со звуком на ключевых), жизнь (подсветка на слове) и выход.
- Тексты и цифры — только из речи. Логотипы — маленькими пометками. Источник и лицензия каждого файла —
  в `public/SOURCE.md`.
- Дизайн уникальный под тему (`creative-motion.md`): kit даёт механику, внешний вид — свой у каждого ролика.
- Все видео внутри слоя — `muted`: в звуке слоя только эффекты, голос идёт из исходника.
- Последние 0,8 с — хвост: затемнение или финальная карточка, ролик не обрывается на слове.

## Порядок работы

1. Прочитать `words.js` и тему; набросать таблицу сцен: время, слово, что на экране, механика.
2. `plan.js`: камера (`autoShots` → правка под смысл), элементы на якорях слов, вставки, звуки, `captions.hide`.
3. `scenes.jsx`: дизайн карточек этого ролика.
4. `automontage layer check` — до зелёного; кадры входов и выходов — `remotion still`.
5. Сдать: `plan.js`, `scenes.jsx`, `public/SOURCE.md`, `README.md` (таблица сцен) и отчёт до 20 строк:
   что сделано, какие исключения и почему, что сомнительно.

## Правка из пульта

Правка — новая версия плана. Кадры вокруг секунды правки: `automontage layer sheet`. Исправить,
`layer check`, сдать; рендер, preview и отметку правки делает оркестратор.
```

`creative-motion.md` — в абзаце «Для talking-head ролика custom motion…»:
- заменить «Полноразмерный визуальный слой рендерится без собственной используемой аудиодорожки» на
  «Полноразмерный визуальный слой собирается из motion-kit (`automontage layer new`, задание субагенту —
  `motion-layer-brief.md`) и несёт только звуковые эффекты: голос остаётся мастер-аудио»;
- «(вместе с `audioMode: "mute"`)» → «(вместе с `audioMode: "mix"` для слоя kit со звуками, иначе `"mute"`)»;
- добавить абзац: «Слой не уходит в preview, пока `automontage layer check` и `layer render` не зелёные;
  `automontage preview` сам проверяет баланс голоса и музыки и не публикует слабый preview».

`qa-checklist.md`:
- «Нет непредусмотренной паузы без визуального события дольше 2,2 секунды» → «План спикера без события не
  дольше 2,5 секунды (стоп), лучше до 2,2 (предупреждение) — считает `automontage layer check`, G1»;
- «Под речью музыка примерно на 12–18 dB ниже голоса» → «Голос − музыка под речью в коридоре профиля:
  `live` 12–18 dB, `avatar` — по DECISIONS D-035; считает `automontage preview`, G8»;
- пункт про «собственный звук выключен» → «звук слоя kit — только эффекты (G7)»;
- новый пункт: «Отчёты `qa/layer-*-check.txt`, `qa/layer-*-render-*.txt`, `qa/preview-*.txt` без ❌,
  контакт-лист `automontage layer sheet` просмотрен глазами».

- [ ] **Step 4: Запустить**

Run: `node --test tests/creative-motion-instructions.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add skills/reel-turnkey/references/ tests/creative-motion-instructions.test.js
git commit -m "docs: merge motion layer briefs into one kit-based template"
```

### Task 45: Навыки `motion-reel`, `reel-from-donor`, `reel-turnkey`

**Files:**
- Modify: `skills/motion-reel/SKILL.md` (+ байт-в-байт копии `.agents/skills/motion-reel/SKILL.md`,
  `.codex/skills/motion-reel/SKILL.md`)
- Modify: `skills/reel-from-donor/SKILL.md`, `skills/reel-turnkey/SKILL.md`
- Test: `tests/creative-motion-instructions.test.js` (дописать)

- [ ] **Step 1: Дописать падающий тест**

```js
test('reel skills start motion layers from the kit and gate them before the pult', () => {
  for (const file of ['skills/motion-reel/SKILL.md', 'skills/reel-from-donor/SKILL.md', 'skills/reel-turnkey/SKILL.md']) {
    const text = read(file);
    assert.match(text, /automontage layer new/, file);
    assert.match(text, /automontage layer check/, file);
    assert.match(text, /motion-layer-brief\.md/, file);
  }
});
```

- [ ] **Step 2: Запустить**

Run: `node --test tests/creative-motion-instructions.test.js`
Expected: FAIL.

- [ ] **Step 3: Поправить навыки**

В каждый навык — короткий блок «Motion-слой из kit»:

```md
## Motion-слой из kit

Слой с аватаром или живым спикером начинается с `automontage layer new --project-dir <папка>`;
субагенту слоя отдаётся одно задание — `skills/reel-turnkey/references/motion-layer-brief.md`.
Дальше: `automontage layer check` (ритм, safe-zone, звуки — секунды) → `automontage layer render`
(ждёт свободную машину, проверяет длину и голос в звуке слоя) → `automontage layer import` →
`automontage layer brief` → `automontage preview` (баланс голоса и музыки; слабый preview не публикуется)
→ `automontage layer sheet`. В пульт уходит только preview с зелёными отчётами в `qa/`.
```

В `motion-reel` добавить уточнение: «Ролик только из озвучки без видео спикера собирается встроенным
MotionReel, как раньше; kit нужен, когда в кадре есть аватар или спикер». Скопировать канон
`skills/motion-reel/SKILL.md` в `.agents/skills/motion-reel/SKILL.md` и `.codex/skills/motion-reel/SKILL.md`.

- [ ] **Step 4: Запустить**

Run: `node --test tests/creative-motion-instructions.test.js`
Expected: PASS (включая проверку байт-в-байт копий).

- [ ] **Step 5: Коммит**

```bash
git add skills .agents .codex tests/creative-motion-instructions.test.js
git commit -m "docs: start reel skills from motion-kit and its gates"
```

## Фаза 10. Пробная сборка и приёмка

Пробный ролик — копия исходника утверждённого эталонного ролика пакета. Клиентские папки только
читаются. Папка пробы — `projects/_kit-trial/` (где именно — решение владельца при утверждении плана:
основная папка или worktree; обе игнорируются Git). Локальная библиотека звуков — `projects/.library/sfx/`.

### Task 46: Локальная библиотека звуков

- [ ] **Step 1:** Скопировать 17 `*.wav` набора эффектов пакета в `projects/.library/sfx/` (копия, исходник не менять).
- [ ] **Step 2:** Создать `projects/.library/sfx/library.json`:

```json
{
  "license": "Mixkit Sound Effects Free License — коммерческое использование без атрибуции, без раздачи файлов",
  "sourceUrl": "https://mixkit.co/free-sound-effects/",
  "sounds": {
    "click-soft": { "volume": 0.8 },
    "pop-notify": { "role": "pop" },
    "ui-blip": { "role": "ui" },
    "impact-ring": { "role": "impact" }
  }
}
```

- [ ] **Step 3:** Проверить: `node -e "console.log(Object.keys(require('./scripts/layer/sfx-library').copySfxLibrary(process.argv[1], require('node:os').tmpdir()+'/sfx-probe').library.sounds))" projects/.library/sfx`
  Expected: 17 имён.

### Task 47: Калибровка G8 по утверждённому эталонному preview

Коридор профиля `avatar` берётся из реального звука, который владелец утвердил, а не из модели.

- [ ] **Step 1:** В `projects/_kit-trial/tools/calibrate-g8.js` (локально, не в Git) собрать «голос после
  finish» эталона: ffmpeg смешивает звук исходника (громкость 1) и звук импортированного слоя эталона
  (`volume=-18dB`, как `BrollMedia` при `mix`), затем фильтр `buildFinishAudioFilter()` из
  `scripts/finish-audio.js` (loudnorm −14 LUFS). Музыка и её параметры — из утверждённого brief эталона
  (`buildLessonMusicMixArgs(brief.music, duration)` → `parseMixOptions`). Окна речи — `speechWindows` по
  транскрипту эталона. Замер — `measureVoiceMusic`.
- [ ] **Step 2:** Запустить и записать медиану R (dB) и p10.
- [ ] **Step 3:** В `scripts/qa/profiles.js` выставить `avatar.voiceMusic = { stopLow: 3, warnLow: R−3, target: R,
  warnHigh: R+3, stopHigh: R+8 }` (R округлить до 0,5). Прогнать `node --test tests/qa-report.test.js tests/qa-mix-gates.test.js`
  — порядок коридора сохраняется. Если R < 6 или > 20 — остановиться и показать владельцу (значит,
  утверждённый баланс сильно отличается от ожиданий).
- [ ] **Step 4:** Вписать R в D-035 (`DECISIONS.md`); в локальной памяти поправить
  `knowledge/heygen-voice-music-ducking.md` (фактический порядок: нормализация → музыка).
- [ ] **Step 5:** Коммит `fix: calibrate the avatar voice-music corridor on the approved reference preview`.

### Task 48: Пробный проект

- [ ] **Step 1:** Скопировать исходник эталона (текущий `input/source-*.mp4`) и его `transcript/words.json`.
- [ ] **Step 2:** Создать проект: `node -e "require('./scripts/project/workspace').createOrOpenProject({ projectDir: process.argv[1], name: 'kit trial', sourcePath: process.argv[2] })" projects/_kit-trial <копия исходника>`,
  положить транскрипт в `transcript/words.json`.
- [ ] **Step 3:** `projects/_kit-trial/pult-card.json`:
  `{"version":1,"group":{"id":"kit-trial","title":"Проба motion-kit"},"variantLabel":"проба kit"}` — карточка
  в пульте подписана как проба; утверждать её не нужно.

### Task 49: Пробный слой — эталон на деталях kit

Цель: те же сцены эталона, но камера, звук, субтитры, анимации входа/выхода, safe-zone — из kit, и ритм
лучше эталона (у эталона план ≈ 5,0 с на 69,70–74,74 и слабые джамп-каты).

- [ ] **Step 1:** `automontage layer new --project-dir projects/_kit-trial` → `motion-v01`.
- [ ] **Step 2:** Скопировать (не переносить) из слоя эталона компоненты сцен (`items.jsx`, сценовые части
  `ui.jsx`), `public/` ассеты (клипы, скриншоты, шрифты с OFL, `SOURCE.md`) в `motion-v01/`. Вспомогательный
  код эталона, который заменяет kit (камера, `sec`, `SAFE`, `FontLoader`, звуки, субтитры), не копировать.
- [ ] **Step 3:** `motion-v01/tools/port-plan.js` (локально): собрать esbuild план эталона (`buildPlan` его
  `timeline.js`) и перевести элементы в `items` kit: `anim` pop/fly/mask/cut → `enter.kind`, `settle` → `pop`,
  `from/until` кадры → секунды, `box`, `rot`, `sfx`; полноэкранные демо → `inserts` (`kind: 'screen'`),
  шапки GitHub → карточка `BrowserFrame` со скриншотом. Вывод — `src/plan.generated.js`, который импортирует `plan.js`.
- [ ] **Step 4:** Камера: взять `autoShots` и добавить панч-ины эталона на W; размытия эталона → `blurs`.
  `automontage layer check` → исправлять план до `fail 0` (G1 ≤ 2,5 с на всём ролике, G5 без выходов).
- [ ] **Step 5:** Хотя бы одна настоящая стоковая вставка через `automontage layer stock` (если есть
  `PEXELS_API_KEY`) или клип эталона как `kind: 'stock'`; хотя бы одна скриншот-карточка `BrowserFrame`.
- [ ] **Step 6:** Кадры входов/выходов 6 ключевых элементов — `npx remotion still` из корня движка, смотреть глазами.

### Task 50: Рендер, импорт, brief, preview

- [ ] **Step 1:** `automontage layer render --project-dir projects/_kit-trial --layer motion-v01` (ждёт свободную машину).
  Expected: G6, G7 — pass.
- [ ] **Step 2:** `automontage layer import --project-dir projects/_kit-trial --file projects/_kit-trial/motion-v01/renders/layer-01.mp4`.
- [ ] **Step 3:** Музыку эталона скопировать в `projects/_kit-trial/assets/music/`; `automontage layer brief …
  --music <копия> --music-gain-db <как в утверждённом brief эталона> --music-start-sec <как там>`.
- [ ] **Step 4:** Проверить, что машина свободна, и `automontage preview --project-dir projects/_kit-trial --brief <draft>`.
  Expected: отчёт preview без ❌, G8 в коридоре; preview опубликован.
- [ ] **Step 5:** `automontage layer sheet --project-dir projects/_kit-trial`.

### Task 51: Сравнение с эталоном по кадрам

- [ ] **Step 1:** Кадры эталонного preview в тех же 16 секундах, что и `layer sheet` (`sheetTimes`), и сборка
  «проба | эталон» попарно (ffmpeg `hstack` → `tile`) в `projects/_kit-trial/qa/compare.jpg`.
- [ ] **Step 2:** Посмотреть глазами: те же сцены, текст не хуже читается, нет выходов за safe-zone, камера
  живее (нет планов > 2,5 с). Записать вывод и спорные места в `projects/_kit-trial/README.md`.
- [ ] **Step 3:** Громкость: `ffmpeg -af ebur128` у пробы и эталона — интегральная громкость в пределах ±1 LU.

### Task 52: Доказательства и финальная проверка

- [ ] **Step 1:** `npm test` — `fail 0`; сохранить итоговые строки.
- [ ] **Step 2:** `node --test --test-name-pattern "BAD CASE" tests/` — пять плохих случаев пойманы
  (статичный план 5 с, голос в звуке слоя, музыка вровень, слой длиннее исходника, текст за safe-zone).
- [ ] **Step 3:** Отчёты пробы: `qa/layer-motion-v01-check.txt`, `qa/layer-motion-v01-render-01.txt`,
  `qa/preview-*.txt` — без ❌; контакт-лист `qa/sheet-*.jpg` и `qa/compare.jpg` просмотрены.
- [ ] **Step 4:** `node scripts/check-public-privacy.js` по всему дереву ветки и Gitleaks (pre-commit hook уже
  прогонялся на каждом коммите); `git log --oneline main..HEAD` — маленькие коммиты с `feat:/fix:/docs:/test:`.
- [ ] **Step 5:** `superpowers:verification-before-completion`: итог владельцу — что сделано, как теперь
  запускается новый ролик, что осталось; предложить PR (не открывать без просьбы).

### Task 53: Память

- [ ] **Step 1:** Дописать в конец дневника дня `memory/YYYY-MM-DD.md` основной папки блок `## [Claude] HH:MM — …`
  (что сделано, где план, где проба, что осталось).
- [ ] **Step 2:** Перечитать `MEMORY.md` основной папки и одной точечной правкой добавить ссылку на
  `docs/MOTION-KIT.md` и ветку/PR.

## Документы: что меняется (таблица AGENTS.md)

| Что изменилось | Где обновляем | Task |
|---|---|---|
| Новые пользовательские команды `automontage layer …` | `README.md`, `docs/MOTION-KIT.md`, `docs/TEMPLATES.md` (ссылка на маршрут слоя) | 28, 42 |
| Новый модуль, порядок пайплайна preview | `ARCHITECTURE.md` §3.5, §5, §6 | 43 |
| Переменная окружения `AUTOMONTAGE_SFX_DIR` | `.env.example`, `README.md`, `ARCHITECTURE.md` §7 | 42, 43 |
| Формат brief | не меняется (D-036) | — |
| Заметное поведение и исправления | `CHANGELOG.md` `[Unreleased]` | 43 |
| Архитектурные выборы | `DECISIONS.md` D-034 … D-036 | 43, 47 |
| Команды и критерии проверки | `TESTING.md` §12, CI не меняется (тесты идут в `npm test`) | 43 |
| Навыки и контракт монтажа | `creative-motion.md`, `qa-checklist.md`, `motion-layer-brief.md`, `SKILL.md` трёх навыков + зеркала | 44, 45 |
| Медиа в Git | нет новых бинарников; политика SFX в `ASSETS.md` | 42 |

## Критерии готовности → где доказываются

| Критерий | Task | Доказательство |
|---|---|---|
| 1. Шаблон одной командой: камера, звуки, сток, скриншот-карточка, субтитры | 29, 31, 41 | `tests/layer-template.test.js`, `tests/layer-new.test.js`, кадры шаблона |
| 2. Проба на исходнике эталона не хуже по кадрам и проходит все гейты | 46–51 | `qa/*.txt` пробы без ❌, `qa/compare.jpg`, вывод в README пробы |
| 3. Гейты ловят 5 плохих случаев | 21, 23, 26, 27 | `node --test --test-name-pattern "BAD CASE" tests/` |
| 4. `npm test` зелёный, privacy-check и Gitleaks чистые | 52 | вывод команд |
| 5. Навыки и creative-motion стартуют с kit и гейтов | 44, 45 | `tests/creative-motion-instructions.test.js` |
| 6. MOTION-BRIEF v1–v3 сведены в один шаблон | 44 | `skills/reel-turnkey/references/motion-layer-brief.md` |

## Что сознательно не входит

- Команда съёмки скриншотов по URL (Playwright) и захвата живых демо — остаётся инструментом ролика;
  kit даёт только их показ. Кандидат в следующую фазу.
- Две версии IG/YT в одном слое. Сейчас версия = свой проект со своим слоем; общий план копируется вручную.
- Звуковой гейт «музыка в звуке слоя» и проверка текста по пикселям обычного кадра.
- Правки пульта (значок QA на карточке) — отчёт лежит в `qa/`, а слабый preview просто не публикуется.

