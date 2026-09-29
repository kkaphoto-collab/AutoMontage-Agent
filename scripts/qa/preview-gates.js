// Барьер перед публикацией preview (D3, D4). Строгий только для слоёв kit — видео сцен, чей sha256 есть в
// реестре qa/layer-imports.json (его пишет layer import): там стоп не даёт опубликовать preview. Для прочих
// роликов те же проверки — только предупреждение, публикация не блокируется (поведение проектов без слоёв
// kit не меняется).
const fs = require('node:fs');
const path = require('node:path');
const { parseMixOptions } = require('../mix-music');
const { readJsonIfExists } = require('../pult/files');
const { resolveProjectPath } = require('../project/workspace');
const { findRenderReport, readRegistry, renderReportProblem } = require('../layer/registry');
const { gateVoiceMusic, measureVoiceMusic, speechWindows } = require('./mix-gates');
const { getProfile, PROFILES } = require('./profiles');
const { buildReport, gate, writeReport } = require('./report');

const LAYER_TITLE = 'Слои kit прошли layer check и layer render';
const REBUILD = 'пересоберите слой: layer render → layer import → layer brief';
// Имя файла, которое пишет layer render (renders/layer-NN.mp4). Импорт через Review сохраняет его в asset.json
// (label) — так дёшево и без хеширования видно слой kit, минувший layer import.
const LAYER_RENDER_LABEL = /^layer-\d+(?:\.raw)?\.mp4$/iu;
const IMPORTED_VIDEO = /^assets\/broll\/video\/[^/]+\/media\.mp4$/u;
const message = (error) => error?.message ?? String(error);

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
  if (sourceSha256 !== undefined) {
    const source = (Array.isArray(report.inputs) ? report.inputs : []).find((input) => input?.role === 'source');
    if (source?.sha256 !== sourceSha256) {
      return `${entry.layer}: слой собран для другого исходника (qa/${report.fileName}) — создайте новый слой: layer new → layer render → layer import`;
    }
  }
  return null;
}

// Гейт L и записи реестра для видео brief. strict — у проекта есть реестр слоёв kit (или он повреждён:
// тогда слоям доверять нельзя, и барьер закрыт).
function layerGate(projectDir, brief, sourceSha256) {
  const videos = videoScenes(brief);
  if (!videos.length) return { gate: null, entries: [], strict: false };
  let imports;
  try {
    imports = readRegistry(projectDir).imports;
  } catch (error) {
    return { gate: gate('L', LAYER_TITLE, { status: 'fail', hint: message(error) }), entries: [], strict: true };
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
// тот же формат, что читает flattenTranscript kit. Нет файла — ошибка: без окон речи замер невозможен.
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

// Возвращает {report, block, paths}. block = true только для слоя kit со стоп-нарушением.
// words — слова {s, e} (иначе читаются из транскрипта manifest); range — диапазон preview в секундах исходника;
// finishedPath — звук после finish.js; musicPath и mixArgs — те же, что получил mix-music.js.
// deps: measureImpl — замер G8 (подмена в тестах), now — время отчёта, write: false — не писать отчёт.
function runPreviewGates({ projectDir, brief, manifest, hasMusic, words, range, sourceSha256, finishedPath, musicPath, mixArgs }, deps = {}) {
  const layer = layerGate(projectDir, brief, sourceSha256);
  const profileName = layer.entries[0]?.profile || 'live';
  const gates = layer.gate ? [layer.gate] : [];
  // Замер и гейт в одном try: ошибка ffmpeg, транскрипта, нет mixOptions или неверная форма замера — «замер не удался».
  try {
    const profile = getProfile(profileName);
    let measured = null;
    if (hasMusic) {
      const windows = speechWindows(Array.isArray(words) ? words : readProjectWords(projectDir, manifest), range);
      if (windows.length) {
        measured = (deps.measureImpl || measureVoiceMusic)({ voicePath: finishedPath, musicPath,
          mixOptions: mixArgs ? parseMixOptions(mixArgs) : null, durationSec: range.toSec - range.fromSec, windows });
      }
    }
    gates.push(gateVoiceMusic(measured, profile, { hasMusic: Boolean(hasMusic), gainDb: brief?.music?.gainDb }));
  } catch (error) {
    gates.push(gate('G8', 'Голос и музыка', { status: 'fail', hint: `замер не удался: ${message(error)}` }));
  }
  const enforced = layer.strict ? gates : gates.map((g) => (g.status === 'fail'
    ? { ...g, status: 'warn', hint: `${g.hint} (ролик без слоя kit — только предупреждение)`.trim() } : g));
  const report = buildReport({ kind: 'preview', layer: layer.entries.map((e) => e.layer).join(', ') || null,
    profile: profileName, gates: enforced, now: (deps.now || (() => new Date()))() });
  const block = layer.strict && report.summary.status === 'fail';
  let paths = null;
  if (deps.write !== false) {
    try {
      paths = writePreviewReport(projectDir, report, new Date(report.createdAt));
    } catch (error) {
      // Слой kit без записанного отчёта не публикуется; прочим роликам сбой записи не мешает.
      if (layer.strict) throw error;
    }
  }
  return { report, block, paths };
}

module.exports = { readProjectWords, runPreviewGates };
