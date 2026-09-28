// automontage layer brief — черновик lesson brief для проверенного слоя kit: одна сцена broll на весь
// хронометраж играет импортированный слой (звук слоя по умолчанию mix, D6), голос — из исходника по
// глобальному таймкоду, музыка — по желанию. Формат brief прежний (D-036). Команда только публикует
// draft: утверждает человек после просмотра preview.
//
// Одна сцена, а не несколько: brollEnvelope (src/scenes/BrollMedia.jsx) приглушает звук слоя на входе и
// выходе каждой сцены, и эффекты на внутренних стыках глохли бы там, где G9 их не видит.
const fs = require('node:fs');
const path = require('node:path');
const { formatBriefMarkdown, validateLessonBrief } = require('../lesson/brief');
const { LESSON_DEFAULT_THEME } = require('../lesson/workflow');
const { probeVideo } = require('../media-probe');
const { copyProjectFileNoReplace, createOrOpenProject, publishBriefRevision, resolveProjectPath } = require('../project/workspace');
const { PROFILES } = require('../qa/profiles');
const { formatNumber, projectFrom, relative, sha256File } = require('./common');
const { findByCanonical, findByReference, findRenderReport, layerAsset, renderReportProblem } = require('./registry');

const FLAGS = { 'project-dir': 'value', asset: 'value', title: 'value', 'head-cream': 'value', 'head-orange': 'value',
  audio: 'value', music: 'value', 'music-gain-db': 'value', 'music-start-sec': 'value' };
const AUDIO_MODES = ['mix', 'mute'];
const SHA256 = /^[a-f0-9]{64}$/u;
// Музыка под голос аватара: свой ducking и тише по умолчанию; живой голос — ducking движка.
const AVATAR_DUCKING = Object.freeze({ thresholdDb: -40, ratio: 4, attackMs: 10, releaseMs: 260 });
const MUSIC_GAIN_DB = Object.freeze({ avatar: -16, live: -12 });

const newLayer = (projectDir) => `создайте новый слой: automontage layer new --project-dir "${projectDir}" → layer render → layer import`;

function aspectOf({ width, height }) {
  if (width === 1080 && height === 1920) return 'vertical';
  if (width === 1920 && height === 1080) return 'horizontal';
  return 'source';
}

function buildLayerBrief({ sourcePath, probe, entry, title, headCream, headOrange, audioMode = 'mix', music = null }) {
  const brief = {
    version: 1, status: 'draft', source: sourcePath, theme: LESSON_DEFAULT_THEME, title,
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

// --asset (ссылка assets/broll/video/…/media.mp4 или sha256 ассета) — слой kit из реестра, чей отчёт layer
// render (тот же рендер: sha256 и путь во входе «layer») всё ещё целый и пройденный, а сам ассет цел.
function checkedLayer(projectDir, asset) {
  const refuse = (why) => new Error(`ассет не импортирован как проверенный слой (${why}) — сначала automontage layer import `
    + `--project-dir "${projectDir}" --file motion-vNN/renders/layer-NN.mp4`);
  const entry = SHA256.test(asset) ? findByCanonical(projectDir, asset) : findByReference(projectDir, asset);
  if (!entry) throw refuse(`${asset} нет в qa/layer-imports.json`);
  const fields = ['layer', 'renderFile', 'renderSha256', 'reference', 'canonicalSha256'];
  if (!fields.every((key) => typeof entry[key] === 'string') || !Object.hasOwn(PROFILES, entry.profile)) {
    throw refuse('запись qa/layer-imports.json неполная');
  }
  const report = findRenderReport(projectDir, entry.renderSha256, { path: entry.renderFile });
  if (!report) throw refuse(`нет отчёта layer render для ${entry.renderFile}`);
  const problem = renderReportProblem(report, { layer: entry.layer });
  if (problem) throw refuse(problem);
  const record = layerAsset(projectDir, entry);
  if (!record || record.mediaKind !== 'video') throw refuse(`ассет ${entry.reference} повреждён или удалён`);
  return { entry, record };
}

// Сцена слоя идёт на весь исходник: output.durationInFrames = round(длина × fps). Слой короче хотя бы на кадр —
// preview упал бы на BROLL_MEDIA_CLIP_OVERRUN; длиннее больше допуска G6 — слой собран не под этот исходник.
// Длина ассета — по видеопотоку из asset.json, как её сверяет preview.
function assertFullLength({ record, probe, profile, projectDir }) {
  const sourceFrames = Math.round(probe.duration * probe.fps);
  const layerFrames = Math.round(record.durationSec * probe.fps);
  const tolerance = profile.duration.toleranceFrames;
  const lengths = `${formatNumber(record.durationSec)} с против ${formatNumber(probe.duration)} с`;
  if (layerFrames < sourceFrames) {
    throw new Error(`слой короче исходника: ${lengths} — слой идёт одной сценой на весь ролик и кончился бы раньше него; ${newLayer(projectDir)}`);
  }
  if (layerFrames - sourceFrames > tolerance) {
    throw new Error(`слой длиннее исходника: ${lengths} (допуск ${tolerance} кадр) — слой собран не под этот исходник; ${newLayer(projectDir)}`);
  }
}

function numberFlag(options, flag) {
  const raw = options[flag];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (String(raw).trim() === '' || !Number.isFinite(value)) throw new Error(`--${flag}: нужно число, получено «${raw}»`);
  return value;
}

// Музыка lesson-брифа — абсолютный путь к файлу в assets/music проекта (preview берёт brief.music.file как
// есть). Файл снаружи копируется туда под своим именем: те же байты под этим именем переиспользуются, другой
// файл с этим именем не перезаписывается. Копирует run — после проверки brief.
function planMusic(projectDir, option) {
  const file = path.resolve(option);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) throw new Error(`--music ${option}: файл не найден`);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`--music ${option}: нужен сам аудиофайл, а не ссылка или папка`);
  const inProject = relative(projectDir, file);
  if (inProject.startsWith('assets/music/')) {
    return { file: resolveProjectPath(projectDir, inProject, { label: '--music', mustExist: true, type: 'file' }), copyFrom: null };
  }
  const storedPath = path.posix.join('assets', 'music', path.basename(file));
  const destination = resolveProjectPath(projectDir, storedPath, { label: 'assets/music', mustExist: false, type: 'file' });
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
    if (sha256File(destination) !== sha256File(file)) {
      throw new Error(`в assets/music уже есть другой файл ${path.basename(file)} — переименуйте файл музыки или укажите ${storedPath}`);
    }
    return { file: destination, copyFrom: null };
  }
  return { file: destination, copyFrom: file, storedPath };
}

// deps: log — вывод (тихий в тестах).
async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const { projectDir, sourcePath } = projectFrom(options);
  for (const flag of ['asset', 'title', 'head-cream', 'head-orange']) if (!options[flag]) throw new Error(`нужен --${flag}`);
  const audioMode = options.audio ?? 'mix';
  if (!AUDIO_MODES.includes(audioMode)) throw new Error(`--audio ${audioMode}: допустимо mix или mute`);
  for (const flag of ['music-gain-db', 'music-start-sec']) {
    if (!options.music && options[flag] !== undefined) throw new Error(`--${flag} без --music: укажите файл музыки`);
  }
  const gainDb = numberFlag(options, 'music-gain-db');
  const startSec = numberFlag(options, 'music-start-sec') ?? 0;

  const { entry, record } = checkedLayer(projectDir, options.asset);
  const profile = PROFILES[entry.profile];
  const probe = probeVideo(sourcePath);
  assertFullLength({ record, probe, profile, projectDir });
  const music = options.music ? planMusic(projectDir, options.music) : null;
  const brief = buildLayerBrief({ sourcePath, probe, entry, title: options.title, headCream: options['head-cream'],
    headOrange: options['head-orange'], audioMode,
    music: music && { file: music.file, gainDb: gainDb ?? MUSIC_GAIN_DB[entry.profile], startSec } });
  const check = validateLessonBrief(brief);
  if (!check.ok) throw new Error(`brief невалиден:\n${check.errors.join('\n')}`);

  const workspace = createOrOpenProject({ projectDir });
  if (music?.copyFrom) copyProjectFileNoReplace({ projectDir, sourcePath: music.copyFrom, storedPath: music.storedPath });
  const result = publishBriefRevision(workspace, { brief, markdown: formatBriefMarkdown(brief) });
  log(`✅ черновик ${result.relativePath}: слой ${entry.layer} (${entry.reference}), звук слоя ${audioMode}`
    + `${music ? `, музыка ${relative(projectDir, music.file)}` : ''}`);
  if (audioMode === 'mix') {
    const fade = formatNumber(profile.sfx.sceneFadeSec);
    log(`Звук слоя в первые и последние ${fade} с приглушён огибающей сцены — эффект хука ставьте не раньше ${fade} с.`);
  }
  log(`Дальше: automontage preview --project-dir "${projectDir}" --brief ${result.relativePath}`);
  return 0;
}

module.exports = { FLAGS, buildLayerBrief, run };
