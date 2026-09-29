// Барьер перед публикацией preview (D3, D4). Строгий только для слоёв kit – видео сцен, чей sha256 есть в
// реестре qa/layer-imports.json (его пишет layer import): там стоп не даёт опубликовать preview. Для прочих
// роликов G8 – только справка (skipped, без советов по music.gainDb): без слоя kit профиль голоса
// неизвестен (живая запись или аватар), коридор live не откалиброван, а утверждённые аватар-рецепты
// читаются как ~38 LU (D-035) – совет «увеличьте gainDb» сделал бы музыку громче утверждённого
// вкуса. Подсказка нейтральная: музыку ведёт утверждённый рецепт. Публикация таких роликов не
// блокируется.
const fs = require('node:fs');
const path = require('node:path');
const { parseMixOptions } = require('../mix-music');
const { readJsonIfExists } = require('../pult/files');
const { resolveProjectPath } = require('../project/workspace');
const { assertReportSource, findRenderReport, readRegistry, renderReportProblem } = require('../layer/registry');
const { gateVoiceMusic, measureVoiceMusic, speechWindows } = require('./mix-gates');
const { getProfile, PROFILES } = require('./profiles');
const { buildReport, gate, projectQaDir, writeReport } = require('./report');

const LAYER_TITLE = 'Слой прошёл layer render и импорт';
const VOICE_MUSIC_TITLE = 'Голос и музыка';
// Без слоя kit замер – только справка, а это два полных декодирования во float (~80 МБ на минуту в памяти)
// внутри lease preview, у задачи preview в Review тайм-аут 10 минут. Поэтому справку меряем только для
// роликов до 3 минут (Reels сохраняют своё число), длинный lesson пропускается с пометкой.
const INFO_MAX_SEC = 180;
const REBUILD = 'пересоберите слой: layer render → layer import → layer brief';
// Имя файла, которое пишет layer render (renders/layer-NN.mp4). Импорт через Review сохраняет его в asset.json
// (label) – так дёшево и без хеширования видно слой kit, минувший layer import.
const LAYER_RENDER_LABEL = /^layer-\d+(?:\.raw)?\.mp4$/iu;
const IMPORTED_VIDEO = /^assets\/broll\/video\/[^/]+\/media\.mp4$/u;
const message = (error) => error?.message ?? String(error);

// Текст ошибки для подсказки гейта без абсолютных путей: сырой stderr ffmpeg и сообщения fs называют файл
// полным путём (папка проекта, временная папка preview). Путь в кавычках и путь после пробела, скобки или
// «=» заменяются именем файла (POSIX и Windows), остаток папки проекта – «…».
const fileName = (file) => file.split(/[\\/]/u).filter(Boolean).pop() || file;
function hidePaths(text, projectDir) {
  let out = String(text)
    .replace(/'([^']*[\\/][^']*)'|"([^"]*[\\/][^"]*)"/gu, (_, single, double) => `«${fileName(single ?? double)}»`)
    .replace(/(^|[\s(=«])((?:[A-Za-z]:)?[\\/][^\s'"()«»]*)/gu, (_, before, file) => {
      const tail = /[.,:;]+$/u.exec(file)?.[0] ?? '';
      return `${before}${fileName(file.slice(0, file.length - tail.length))}${tail}`;
    });
  if (projectDir) out = out.split(projectDir).join('…');
  return out;
}
const r1 = (value) => String(Math.round(value * 10) / 10).replace('.', ',');

// Видео всех сцен brief (слоёв может быть несколько), без повторов по sha256.
function videoScenes(brief) {
  const seen = new Set();
  return (Array.isArray(brief?.scenes) ? brief.scenes : []).filter((scene) => {
    const media = scene?.brollMedia;
    if (media?.kind !== 'video' || typeof media.sha256 !== 'string' || seen.has(media.sha256)) return false;
    seen.add(media.sha256);
    return true;
  }).map((scene) => scene.brollMedia);
}

// Видео, импортированное не через layer import, но названное как рендер слоя – только признак для
// предупреждения, любая ошибка чтения означает «признака нет».
function looksLikeLayer(projectDir, media) {
  if (typeof media.src !== 'string' || !IMPORTED_VIDEO.test(media.src)) return false;
  try {
    const record = readJsonIfExists(path.join(projectDir, ...path.posix.dirname(media.src).split('/'), 'asset.json'), 'asset.json');
    return typeof record?.label === 'string' && LAYER_RENDER_LABEL.test(record.label);
  } catch {
    return false;
  }
}

// Почему записи реестра нельзя доверять, или null: тот же отчёт layer render, что принял layer import
// (вход «layer» с тем же sha256 и путём), целый и не «стоп», и собран для текущего исходника preview.
function entryProblem(projectDir, entry, sourceSha256) {
  const fields = ['layer', 'renderFile', 'renderSha256'];
  if (!fields.every((key) => typeof entry[key] === 'string') || !Object.hasOwn(PROFILES, entry.profile)) {
    return `запись qa/layer-imports.json для ${entry.reference ?? entry.canonicalSha256} неполная – повторите layer import`;
  }
  const report = findRenderReport(projectDir, entry.renderSha256, { path: entry.renderFile });
  if (!report) return `${entry.layer}: нет отчёта layer render для ${entry.renderFile} – ${REBUILD}`;
  const problem = renderReportProblem(report, { layer: entry.layer });
  if (problem) return `${entry.layer}: ${problem}`;
  // Тот же приговор, что в layer import и layer brief, но по sha256 исходника, который preview уже посчитал.
  // projectDir не передаём: барьер preview не должен класть абсолютный путь проекта в отчёт и консоль.
  if (sourceSha256 !== undefined) assertReportSource(report, { sourceSha256 });
  return null;
}

// Почему реестр не читается – человеческими словами: qa/ не папка или сам реестр повреждён.
function registryProblem(projectDir, error) {
  const stat = fs.lstatSync(path.join(projectDir, 'qa'), { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    return 'qa/ – ссылка или файл, а не папка проекта: реестр слоёв kit (qa/layer-imports.json) не прочитать – '
      + 'уберите её и верните настоящую папку qa/ проекта';
  }
  const reason = /\(([^)]+)\)/u.exec(message(error))?.[1];
  return `реестр слоёв повреждён: qa/layer-imports.json${reason ? ` (${reason})` : ''} – почините или удалите его и импортируйте слои заново (layer import)`;
}

// Гейт L и записи реестра для видео brief. strict – у проекта есть реестр слоёв kit (или он не читается:
// тогда слоям доверять нельзя, и барьер закрыт).
function layerGate(projectDir, brief, sourceSha256) {
  const videos = videoScenes(brief);
  if (!videos.length) return { gate: null, entries: [], strict: false };
  let imports;
  try {
    imports = readRegistry(projectDir).imports;
  } catch (error) {
    return { gate: gate('L', LAYER_TITLE, { status: 'fail', hint: registryProblem(projectDir, error) }), entries: [], strict: true };
  }
  const entries = [];
  const problems = [];
  const unregistered = [];
  for (const media of videos) {
    const entry = imports.find((e) => e?.canonicalSha256 === media.sha256);
    if (!entry) {
      if (looksLikeLayer(projectDir, media)) unregistered.push(media.src);
      continue;
    }
    entries.push(entry);
    try {
      const problem = entryProblem(projectDir, entry, sourceSha256);
      if (problem) problems.push(problem);
    } catch (error) {
      problems.push(`${entry.layer}: ${hidePaths(message(error), projectDir)}`);
    }
  }
  if (!entries.length && !unregistered.length) return { gate: null, entries, strict: false };
  const notes = [...problems];
  if (unregistered.length) {
    notes.push(`похоже на слой kit, но не импортировано через layer import: ${unregistered.join(', ')} – `
      + 'импортируйте рендер слоя командой automontage layer import и соберите brief через layer brief');
  }
  const status = problems.length ? 'fail' : unregistered.length ? 'warn' : 'pass';
  return { gate: gate('L', LAYER_TITLE, { status, hint: notes.join('; ') }), entries, strict: entries.length > 0 };
}

// Слова транскрипта проекта ({s, e}) для окон речи G8: transcript/words.json – [{start, end, text, words: [{w, s, e}]}],
// тот же формат, что читает flattenTranscript kit. Не layer/words.js: тот грузит kit через esbuild
// (motion-kit-node, loadKitCore), а preview любого ролика не должен собирать kit ради двух чисел на слово.
// Нет файла – ошибка: без окон речи замер невозможен.
function readProjectWords(projectDir, manifest) {
  const stored = manifest?.transcript?.words;
  if (typeof stored !== 'string') throw new Error('нет транскрипта: в project.json не указан transcript.words');
  const file = resolveProjectPath(projectDir, stored, { label: 'manifest.transcript.words', mustExist: false, type: 'file' });
  const segments = readJsonIfExists(file, stored);
  if (segments === undefined) throw new Error(`нет транскрипта ${stored} – окна речи не из чего взять`);
  if (!Array.isArray(segments)) throw new Error(`${stored}: ожидается массив сегментов`);
  return segments.flatMap((segment) => (Array.isArray(segment?.words) ? segment.words : []))
    .filter((w) => Number.isFinite(w?.s) && Number.isFinite(w?.e)).map((w) => ({ s: w.s, e: Math.max(w.s, w.e) }));
}

const pad = (n, width = 2) => String(n).padStart(width, '0');
const stamp = (date) => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-`
  + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;

// Первое свободное имя preview-<время>-NN: номер занимается созданием пустого JSON с флагом wx (два preview в
// одну секунду не затрут отчёт друг друга), потом writeReport атомарно заменяет его настоящим отчётом.
function writePreviewReport(projectDir, report, now) {
  const dir = projectQaDir(projectDir, { create: true });
  const prefix = `preview-${stamp(now)}`;
  for (let n = 1; ; n += 1) {
    const name = `${prefix}-${pad(n)}`;
    const claim = path.join(dir, `${name}.json`);
    if (fs.lstatSync(path.join(dir, `${name}.txt`), { throwIfNoEntry: false })) continue;
    try {
      fs.closeSync(fs.openSync(claim, 'wx'));
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    try {
      return writeReport(projectDir, name, report);
    } catch (error) {
      fs.rmSync(claim, { force: true });
      throw error;
    }
  }
}

// Причина сбоя записи без абсолютных путей: текст ошибок fs содержит полный путь к проекту.
function writeReason(error) {
  return error?.code ? `не удалось записать в qa/ (${error.code})` : `не удалось записать в qa/: ${message(error).replace(/'[^']*'|"[^"]*"/gu, '…')}`;
}

// Путь входа для отчёта – относительно проекта и через «/», как во входах отчётов layer (scripts/layer/common.js
// relative): абсолютный путь пользователя в qa/ не попадает. Если относительного пути нет (другой диск в
// Windows), остаётся только имя файла.
function projectRelative(projectDir, file) {
  const relative = path.relative(projectDir, path.resolve(projectDir, file));
  return path.isAbsolute(relative) ? path.basename(file) : relative.split(path.sep).join('/');
}

// Входы отчёта preview той же формы {role, path, sha256}, что у layer render: исходник и brief – по sha256,
// которые preview уже посчитал (здесь ничего не хешируется), и каждый слой kit из реестра, который проверил
// гейт L, – импортированный ассет (reference) и его canonicalSha256. Вход без пути или sha256 не пишется.
// findRenderReport такие входы «layer» не видит: он читает только отчёты layer-*-render-NN.json.
function previewInputs(projectDir, { sourcePath, sourceSha256, briefPath, briefSha256, entries }) {
  const inputs = [];
  const add = (role, file, sha256) => {
    if (typeof file === 'string' && file && typeof sha256 === 'string') inputs.push({ role, path: projectRelative(projectDir, file), sha256 });
  };
  add('source', sourcePath, sourceSha256);
  add('brief', briefPath, briefSha256);
  for (const entry of entries) add('layer', entry.reference, entry.canonicalSha256);
  return inputs;
}

// Справочный G8 для ролика без слоя kit: статус skipped (нейтральный), без порога и без советов.
function infoVoiceMusic(note) {
  return gate('G8', VOICE_MUSIC_TITLE, { status: 'skipped', hint: `для справки: ${note}` });
}

function infoFromMeasured(measured) {
  if (!measured) return infoVoiceMusic('в диапазоне preview нет речи');
  const { gapLu } = measured;
  if (typeof gapLu !== 'number' || Number.isNaN(gapLu)) return infoVoiceMusic('замер не удался: в замере нет gapLu');
  const value = gapLu === -Infinity || measured.voiceLufs === -Infinity ? 'голос в окнах речи не звучит'
    : gapLu === Infinity ? 'музыки под речью нет' : `разница голос/музыка ${r1(gapLu)} LU`;
  return infoVoiceMusic(`${value}; без слоя kit G8 не оценивает баланс – `
    + 'музыку ведёт утверждённый рецепт');
}

// Возвращает {report, block, enforced, paths, writeError}. block = true только для слоя kit со стоп-нарушением;
// enforced – барьер строгий (слой kit): без записанного отчёта такой preview не публикуется. Отчёт возвращается
// всегда, даже если его не удалось записать (paths = null, writeError – короткая причина).
// words – слова {s, e} (иначе читаются из транскрипта manifest); range – диапазон preview в секундах исходника;
// finishedPath – звук после finish.js; musicPath и mixArgs – те же, что получил mix-music.js.
// sourcePath (иначе manifest.source.localPath), briefPath и briefSha256 – входы отчёта; пути пишутся относительными.
// deps: measureImpl – замер G8 (подмена в тестах), now – время отчёта, write: false – не писать отчёт.
function runPreviewGates({ projectDir, brief, manifest, hasMusic, words, range, sourceSha256, finishedPath, musicPath, mixArgs,
  sourcePath, briefPath, briefSha256 }, deps = {}) {
  const layer = layerGate(projectDir, brief, sourceSha256);
  // Слоёв с разными профилями быть не должно (голос один – исходник проекта); если всё же так, берём профиль
  // первого слоя по порядку сцен, а не «строжайший»: коридоры avatar и live не вложены друг в друга.
  const profileName = layer.entries[0]?.profile || 'live';
  const gates = layer.gate ? [layer.gate] : [];
  const durationSec = range.toSec - range.fromSec;
  // Замер и гейт в одном try: ошибка ffmpeg, транскрипта, нет mixOptions или неверная форма замера – «замер не удался».
  try {
    const profile = getProfile(profileName);
    if (!layer.strict && !hasMusic) {
      gates.push(infoVoiceMusic('в brief нет музыки'));
    } else if (!layer.strict && durationSec > INFO_MAX_SEC) {
      gates.push(infoVoiceMusic('preview длиннее 3 мин – баланс голоса и музыки не замерялся (справочный замер '
        + 'держит в памяти ~80 МБ на минуту)'));
    } else {
      let measured = null;
      if (hasMusic) {
        const windows = speechWindows(Array.isArray(words) ? words : readProjectWords(projectDir, manifest), range);
        if (windows.length) {
          measured = (deps.measureImpl || measureVoiceMusic)({ voicePath: finishedPath, musicPath,
            mixOptions: mixArgs ? parseMixOptions(mixArgs) : null, durationSec, windows });
        }
      }
      gates.push(layer.strict
        ? gateVoiceMusic(measured, profile, { hasMusic: Boolean(hasMusic), gainDb: brief?.music?.gainDb })
        : infoFromMeasured(measured));
    }
  } catch (error) {
    const reason = hidePaths(message(error), projectDir);
    gates.push(layer.strict
      ? gate('G8', VOICE_MUSIC_TITLE, { status: 'fail', hint: `замер не удался: ${reason}` })
      : infoVoiceMusic(`замер не удался: ${reason}`));
  }
  const inputs = previewInputs(projectDir, { sourcePath: sourcePath ?? manifest?.source?.localPath, sourceSha256,
    briefPath, briefSha256, entries: layer.entries });
  const report = buildReport({ kind: 'preview', layer: layer.entries.map((e) => e.layer).join(', ') || null,
    profile: profileName, gates, inputs, now: (deps.now || (() => new Date()))() });
  const result = { report, block: layer.strict && report.summary.status === 'fail', enforced: layer.strict, paths: null, writeError: null };
  if (deps.write !== false) {
    try {
      result.paths = writePreviewReport(projectDir, report, new Date(report.createdAt));
    } catch (error) {
      result.writeError = writeReason(error);
    }
  }
  return result;
}

module.exports = { readProjectWords, runPreviewGates };
