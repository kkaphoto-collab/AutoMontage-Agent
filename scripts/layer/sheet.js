// automontage layer sheet — контакт-лист текущего preview (4×4 миниатюры с рамкой safe-зоны),
// узкие полоски кадров вокруг правок пульта и гейт G12 «пустые кадры»: 16 кадров через равные
// промежутки, у каждого яркость и разброс пикселей — пропавшая графика или чёрный экран слоя
// дают низкие оба значения. Команда только показывает и предупреждает — стоп она не ставит
// (не в GATE_COMMANDS scripts/layer/cli.js), qa-отчёт не пишет.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { COMMENT_ID, readComments } = require('../pult/comments');
const { probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { resolveProjectPath } = require('../project/workspace');
const { gate } = require('../qa/report');
const { safeRect } = require('../qa/safe-rect');
const { projectFrom } = require('./common');

const FLAGS = { 'project-dir': 'value' };
const THUMB = 270;
const EMPTY_MEAN = 10;
const EMPTY_VARIANCE = 100;
const QUIET = ['-hide_banner', '-loglevel', 'error', '-y'];

// Середины 16 равных отрезков ролика: sheetTimes(16) в тесте — это sheetTimes(duration = 16).
const sheetTimes = (duration, n = 16) => Array.from({ length: n }, (_, i) => Number((((i + 0.5) * duration) / n).toFixed(3)));

// Яркость и разброс уменьшенного ч/б кадра для G12. Сбой ffmpeg (кодек, битый файл) — не гейта
// дело чинить: считаем такой кадр тоже подозрительным (null → «пустой»), а не роняем всю команду —
// это не единственный источник качества, а лишь один из 16 семплов.
function frameStats(videoPath, timeSec) {
  const result = spawnSync('ffmpeg', [...QUIET, '-ss', String(timeSec), '-i', videoPath, '-frames:v', '1',
    '-vf', 'scale=32:-2,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024, shell: false });
  if (result.error || result.status !== 0 || !result.stdout || !result.stdout.length) return null;
  const values = result.stdout;
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / values.length;
  let variance = 0;
  for (const value of values) variance += (value - mean) ** 2;
  variance /= values.length;
  return { mean, variance };
}

// Кадр с жёлтой рамкой safe-зоны, масштаб фиксированной ширины (высота — чётная, -2). ffmpeg может
// отработать кодом 0 и не отдать ни одного кадра — так бывает, если -ss попал ровно на длительность
// ролика или за неё: свободного кадра там больше нет. Тихий провал одного кадра превратил бы
// контакт-лист 4×4 в лист из 15 картинок или сломал бы tile; вместо этого — понятная русская ошибка.
function thumb(videoPath, timeSec, out, box, stage) {
  const drawbox = `drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=yellow@0.7:t=1`;
  runTool('ffmpeg', [...QUIET, '-ss', String(timeSec), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${THUMB}:-2,${drawbox}`, out], { stage });
  if (!fs.statSync(out, { throwIfNoEntry: false })?.size) {
    throw new Error(`${stage}: кадр на ${timeSec.toFixed(2)} с не получен — ролик короче, чем нужно для контакт-листа`);
  }
}

// Контакт-лист 4×4 с рамкой safe-зоны, полоски кадров вокруг секунд правок пульта и G12 «пустые
// кадры». comments — [{id, timeSec}] уже в системе координат videoPath (секунды от начала файла).
// id идёт прямо в имя файла: чужой или подменённый comments.json не должен вывести запись за
// пределы qa/, поэтому принимаем только канонический вид c-<до 40 букв/цифр/дефисов> (COMMENT_ID
// из scripts/pult/comments — в нём нет ни `/`, ни `..`); остальные пропускаем с предупреждением,
// а не роняем всю команду из-за одной записи.
function buildSheet({ videoPath, width, height, duration, outDir, name, comments = [], log = console.warn }) {
  const k = THUMB / width;
  const safe = safeRect(width, height);
  const box = { x: Math.round(safe.left * k), y: Math.round(safe.top * k), w: Math.round((safe.right - safe.left) * k), h: Math.round((safe.bottom - safe.top) * k) };
  // Суффикс pid+random: два параллельных запуска `layer sheet` по одному и тому же preview (то же
  // имя sha256) не должны делить одну рабочую папку.
  const work = path.join(outDir, `${name}.frames-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    const times = sheetTimes(duration);
    times.forEach((t, i) => thumb(videoPath, t, path.join(work, `f${String(i + 1).padStart(2, '0')}.png`), box, 'sheet frame'));
    const sheetPath = path.join(outDir, `${name}.jpg`);
    runTool('ffmpeg', [...QUIET, '-i', path.join(work, 'f%02d.png'), '-vf', 'tile=4x4', '-frames:v', '1', sheetPath], { stage: 'sheet tile' });

    const commentPaths = [];
    for (const comment of comments) {
      if (typeof comment.id !== 'string' || !COMMENT_ID.test(comment.id)) {
        log(`⚠️ правка с недопустимым id пропущена, кадры не собраны: ${JSON.stringify(comment.id)}`);
        continue;
      }
      const strip = path.join(work, comment.id);
      fs.mkdirSync(strip, { recursive: true });
      const clamp = (t) => Math.min(Math.max(0, t), Math.max(0, duration - 0.05));
      [-1, -0.5, 0, 0.5, 1].forEach((d, i) => thumb(videoPath, clamp(comment.timeSec + d), path.join(strip, `f${i + 1}.png`), box, 'sheet comment'));
      const out = path.join(outDir, `comment-${comment.id}.jpg`);
      runTool('ffmpeg', [...QUIET, '-i', path.join(strip, 'f%d.png'), '-vf', 'tile=5x1', '-frames:v', '1', out], { stage: 'sheet comment' });
      commentPaths.push(out);
    }

    const empty = times.filter((t) => {
      const stats = frameStats(videoPath, t);
      return !stats || stats.mean <= EMPTY_MEAN || stats.variance <= EMPTY_VARIANCE;
    });
    return {
      sheetPath,
      commentPaths,
      gate: gate('G12', 'Пустые кадры', {
        status: empty.length ? 'warn' : 'pass',
        value: empty.length,
        unit: 'из 16',
        threshold: 'яркость > 10, разброс > 100',
        spans: empty.slice(0, 5).map((t) => ({ fromSec: t, toSec: t, note: 'пустой или однотонный кадр' })),
        hint: 'проверьте, не выпала ли графика или видео слоя',
      }),
    };
  } finally {
    // Рабочая папка с промежуточными PNG убирается и при успехе, и при любом отказе ffmpeg внутри try.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const { projectDir, manifest } = projectFrom(options);
  const current = manifest.currentPreview;
  if (!current) throw new Error('в проекте нет текущего preview — сначала соберите preview');
  const videoPath = resolveProjectPath(projectDir, current.filePath, { label: 'currentPreview.filePath', mustExist: true, type: 'file' });
  const probe = probeVideo(videoPath, { stage: 'layer sheet probe' });
  // Правки пульта пишут timeSec как currentTime плеера, то есть уже в секундах ОТ НАЧАЛА того самого
  // файла, что играл браузер (scripts/pult/status.js: video.path === preview.filePath) — сдвигать на
  // currentPreview.fromSec не нужно и неверно для preview-фрагмента. Комментарий к другому видео
  // (устаревший preview, final) или со временем за пределами текущей длины — не про этот ролик.
  const comments = readComments(projectDir)
    .filter((comment) => comment.status === 'new' && comment.video.path === current.filePath
      && comment.timeSec >= 0 && comment.timeSec <= probe.duration)
    .map((comment) => ({ id: comment.id, timeSec: comment.timeSec }));
  const result = buildSheet({
    videoPath, width: probe.width, height: probe.height, duration: probe.duration,
    outDir: path.join(projectDir, 'qa'), name: `sheet-${current.sha256.slice(0, 8)}`, comments, log: deps.warn || console.warn,
  });
  log(`Контакт-лист: ${result.sheetPath}`);
  result.commentPaths.forEach((p) => log(`Кадры правки: ${p}`));
  log(`${result.gate.status === 'pass' ? '✅' : '⚠️'} G12 ${result.gate.title}: ${result.gate.value} ${result.gate.unit}`);
  return 0;
}

module.exports = { FLAGS, buildSheet, run, sheetTimes };
