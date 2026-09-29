// Барьер перед публикацией preview (D3, D4). Строгий только для слоёв kit — видео сцен, чей sha256 есть в
// реестре qa/layer-imports.json (его пишет layer import): там стоп не даёт опубликовать preview. Для прочих
// роликов G8 — только справка (skipped, без советов по music.gainDb): коридор live не откалиброван, а
// утверждённые рецепты музыки читаются как ~30–50 LU, и совет «увеличьте gainDb» агент выполнил бы на
// клиентском ролике. Публикация таких роликов не блокируется (их поведение не меняется).
const fs = require('node:fs');
const path = require('node:path');
const { parseMixOptions } = require('../mix-music');
const { readJsonIfExists } = require('../pult/files');
const { resolveProjectPath } = require('../project/workspace');
const { assertReportSource, findRenderReport, readRegistry, renderReportProblem } = require('../layer/registry');
const { gateVoiceMusic, measureVoiceMusic, speechWindows } = require('./mix-gates');
const { getProfile, PROFILES } = require('./profiles');
const { buildReport, gate, writeReport } = require('./report');

const LAYER_TITLE = 'Слой прошёл layer render и импорт';
const VOICE_MUSIC_TITLE = 'Голос и музыка';
// Без слоя kit замер — только справка, а PCM обеих дорожек в памяти ~80 МБ на минуту: дольше 10 минут не меряем.
const INFO_MAX_SEC = 600;
const REBUILD = 'пересоберите слой: layer render → layer import → layer brief';
// Имя файла, которое пишет layer render (renders/layer-NN.mp4). Импорт через Review сохраняет его в asset.json
// (label) — так дёшево и без хеширования видно слой kit, минувший layer import.
const LAYER_RENDER_LABEL = /^layer-\d+(?:\.raw)?\.mp4$/iu;
const IMPORTED_VIDEO = /^assets\/broll\/video\/[^/]+\/media\.mp4$/u;
const message = (error) => error?.message ?? String(error);
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

// Видео, импортированное не через layer import, но названное как рендер слоя — только признак для
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
    return `запись qa/layer-imports.json для ${entry.reference ?? entry.canonicalSha256} неполная — повторите layer import`;
  }
  const report = findRenderReport(projectDir, entry.renderSha256, { path: entry.renderFile });
  if (!report) return `${entry.layer}: нет отчёта layer render для ${entry.renderFile} — ${REBUILD}`;
  const problem = renderReportProblem(report, { layer: entry.layer });
  if (problem) return `${entry.layer}: ${problem}`;
  // Тот же приговор, что в layer import и layer brief, но по sha256 исходника, который preview уже посчитал.
  // projectDir не передаём: барьер preview не должен класть абсолютный путь проекта в отчёт и консоль.
  if (sourceSha256 !== undefined) assertReportSource(report, { sourceSha256 });
  return null;
}

// Почему реестр не читается — человеческими словами: qa/ не папка или сам реестр повреждён.
function registryProblem(projectDir, error) {
  const stat = fs.lstatSync(path.join(projectDir, 'qa'), { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    return 'qa/ — ссылка или файл, а не папка проекта: реестр слоёв kit (qa/layer-imports.json) не прочитать — '
      + 'уберите её и верните настоящую папку qa/ проекта';
  }
  const reason = /\(([^)]+)\)/u.exec(message(error))?.[1];
  return `реестр слоёв повреждён: qa/layer-imports.json${reason ? ` (${reason})` : ''} — почините или удалите его и импортируйте слои заново (layer import)`;
}

// Гейт L и записи реестра для видео brief. strict — у проекта есть реестр слоёв kit (или он не читается:
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
      problems.push(`${entry.layer}: ${message(error)}`);
    }
  }
  if (!entries.length && !unregistered.length) return { gate: null, entries, strict: false };
  const notes = [...problems];
  if (unregistered.length) {
    notes.push(`похоже на слой kit, но не импортировано через layer import: ${unregistered.join(', ')} — `
      + 'импортируйте рендер слоя командой automontage layer import и соберите brief через layer brief');
  }
  const status = problems.length ? 'fail' : unregistered.length ? 'warn' : 'pass';
  return { gate: gate('L', LAYER_TITLE, { status, hint: notes.join('; ') }), entries, strict: entries.length > 0 };
}

// Слова транскрипта проекта ({s, e}) для окон речи G8: transcript/words.json — [{start, end, text, words: [{w, s, e}]}],
// тот же формат, что читает flattenTranscript kit. Не layer/words.js: тот грузит kit через esbuild
// (motion-kit-node, loadKitCore), а preview любого ролика не должен собирать kit ради двух чисел на слово.
// Нет файла — ошибка: без окон речи замер невозможен.
function readProjectWords(projectDir, manifest) {
  const stored = manifest?.transcript?.words;
  if (typeof stored !== 'string') throw new Error('нет транскрипта: в project.json не указан transcript.words');
  const file = resolveProjectPath(projectDir, stored, { label: 'manifest.transcript.words', mustExist: false, type: 'file' });
  const segments = readJsonIfExists(file, stored);
  if (segments === undefined) throw new Error(`нет транскрипта ${stored} — окна речи не из чего взять`);
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
  const dir = path.join(projectDir, 'qa');
  fs.mkdirSync(dir, { recursive: true });
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
  return infoVoiceMusic(`${value}; коридор live не откалиброван — музыку по этой цифре не менять`);
}

// Возвращает {report, block, enforced, paths, writeError}. block = true только для слоя kit со стоп-нарушением;
// enforced — барьер строгий (слой kit): без записанного отчёта такой preview не публикуется. Отчёт возвращается
// всегда, даже если его не удалось записать (paths = null, writeError — короткая причина).
// words — слова {s, e} (иначе читаются из транскрипта manifest); range — диапазон preview в секундах исходника;
// finishedPath — звук после finish.js; musicPath и mixArgs — те же, что получил mix-music.js.
// deps: measureImpl — замер G8 (подмена в тестах), now — время отчёта, write: false — не писать отчёт.
function runPreviewGates({ projectDir, brief, manifest, hasMusic, words, range, sourceSha256, finishedPath, musicPath, mixArgs }, deps = {}) {
  const layer = layerGate(projectDir, brief, sourceSha256);
  // Слоёв с разными профилями быть не должно (голос один — исходник проекта); если всё же так, берём профиль
  // первого слоя по порядку сцен, а не «строжайший»: коридоры avatar и live не вложены друг в друга.
  const profileName = layer.entries[0]?.profile || 'live';
  const gates = layer.gate ? [layer.gate] : [];
  const durationSec = range.toSec - range.fromSec;
  // Замер и гейт в одном try: ошибка ffmpeg, транскрипта, нет mixOptions или неверная форма замера — «замер не удался».
  try {
    const profile = getProfile(profileName);
    if (!layer.strict && !hasMusic) {
      gates.push(infoVoiceMusic('в brief нет музыки'));
    } else if (!layer.strict && durationSec > INFO_MAX_SEC) {
      gates.push(infoVoiceMusic('preview длиннее 10 мин — баланс голоса и музыки не замерялся (память ~80 МБ на минуту)'));
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
    gates.push(layer.strict
      ? gate('G8', VOICE_MUSIC_TITLE, { status: 'fail', hint: `замер не удался: ${message(error)}` })
      : infoVoiceMusic(`замер не удался: ${message(error)}`));
  }
  const report = buildReport({ kind: 'preview', layer: layer.entries.map((e) => e.layer).join(', ') || null,
    profile: profileName, gates, now: (deps.now || (() => new Date()))() });
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
