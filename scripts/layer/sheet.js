// automontage layer sheet — контакт-лист текущего preview (миниатюры с рамкой safe-зоны), узкие
// полоски кадров вокруг правок пульта и гейт G12 «пустые кадры» (доля краевых пикселей —
// scripts/qa/empty-frame-gate.js). Команда только показывает и предупреждает — стоп она не ставит
// (не в GATE_COMMANDS scripts/layer/cli.js), qa-отчёт не пишет.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { COMMENT_ID, readComments } = require('../pult/comments');
const { probeMediaPath } = require('../media-probe');
const { runTool } = require('../process');
const { resolveProjectPath } = require('../project/workspace');
const { buildReport, formatReport } = require('../qa/report');
const { EDGE_THRESHOLD, EDGE_WIDTH, emptyFrameGate } = require('../qa/empty-frame-gate');
const { safeRect } = require('../qa/safe-rect');
const { projectFrom } = require('./common');

const FLAGS = { 'project-dir': 'value' };
const QUIET = ['-hide_banner', '-loglevel', 'error', '-y'];

// Середины 16 равных отрезков ролика: sheetTimes(16) в тесте — это sheetTimes(duration = 16).
const sheetTimes = (duration, n = 16) => Array.from({ length: n }, (_, i) => Number((((i + 0.5) * duration) / n).toFixed(3)));

// ffmpeg понимает -ss только как обычную десятичную запись: String(1e-7) печатает экспоненциальную
// форму («1e-7»), которую он отказывается разбирать. Math.max(0, …) — защита от -0 и микроскопических
// отрицательных остатков после вычитания.
const formatSeconds = (t) => Math.max(0, t).toFixed(3);

// Ширина миниатюры: у портретного кадра — сама ширина 270 px; у альбомного длинная сторона (тоже
// ширина) должна остаться читаемой, около 480 px — иначе 16:9 давал бы миниатюры вдвое ниже нужного.
const thumbWidth = (width, height) => (height > width ? 270 : 480);

// Ширина миниатюры, коэффициент масштаба к ней и прямоугольник safe-зоны в её координатах — то, что
// нужно и для рисования рамки на миниатюрах, и тестам, чтобы посчитать тот же ожидаемый прямоугольник.
function thumbBox(width, height) {
  const w = thumbWidth(width, height);
  const k = w / width;
  const safe = safeRect(width, height);
  return { thumbW: w, k, box: { x: Math.round(safe.left * k), y: Math.round(safe.top * k), w: Math.round((safe.right - safe.left) * k), h: Math.round((safe.bottom - safe.top) * k) } };
}

// PGM (P5) из stdout ffmpeg: текстовый заголовок «P5\n<width> <height>\n<maxval>\n», затем ровно
// width*height байт серого. Формат сам несёт свои размеры — не нужно гадать, во что именно scale=…:-2
// округлил высоту.
function parsePgm(buffer) {
  let pos = 0;
  const isSpace = (byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
  const token = () => {
    while (pos < buffer.length && buffer[pos] === 0x23) { while (pos < buffer.length && buffer[pos] !== 0x0a) pos += 1; pos += 1; }
    while (pos < buffer.length && isSpace(buffer[pos])) pos += 1;
    const start = pos;
    while (pos < buffer.length && !isSpace(buffer[pos])) pos += 1;
    return buffer.subarray(start, pos).toString('ascii');
  };
  if (token() !== 'P5') return null;
  const width = Number(token());
  const height = Number(token());
  token(); // maxval — не нужен для ч/б без нормировки (0–255 стандартно для 8-битного gray)
  pos += 1; // единственный пробел после maxval по спецификации PGM, дальше — сразу бинарные байты
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const pixels = buffer.subarray(pos, pos + width * height);
  return pixels.length === width * height ? { width, height, pixels } : null;
}

// Доля пикселей уменьшенного (EDGE_WIDTH px по ширине) ч/б кадра, у которых сосед справа или снизу
// отличается по яркости больше чем на EDGE_THRESHOLD уровней. Ровный фон, плавная виньетка или
// градиент, сглаженный шум после сильного уменьшения — везде эта доля около нуля, это и есть «пусто»
// для G12; читаемый текст или тестовая сетка дают заметную долю даже мелким шрифтом. null — кадр не
// удалось декодировать (не значит «пусто» само по себе, но и не «всё хорошо» — решает emptyFrameGate).
function frameEdgeShare(videoPath, timeSec) {
  const result = spawnSync('ffmpeg', [...QUIET, '-ss', formatSeconds(timeSec), '-i', videoPath, '-frames:v', '1',
    '-vf', `scale=${EDGE_WIDTH}:-2,format=gray`, '-f', 'image2pipe', '-vcodec', 'pgm', '-'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, shell: false });
  if (result.error || result.status !== 0 || !result.stdout || !result.stdout.length) return null;
  const image = parsePgm(result.stdout);
  if (!image || image.width < 2 || image.height < 2) return null;
  const { width, height, pixels } = image;
  let edges = 0;
  const total = (width - 1) * (height - 1);
  for (let y = 0; y < height - 1; y += 1) {
    const row = y * width;
    const nextRow = row + width;
    for (let x = 0; x < width - 1; x += 1) {
      const p = pixels[row + x];
      if (Math.abs(pixels[row + x + 1] - p) > EDGE_THRESHOLD || Math.abs(pixels[nextRow + x] - p) > EDGE_THRESHOLD) edges += 1;
    }
  }
  return total > 0 ? edges / total : 0;
}

// Кадр с рамкой safe-зоны. Вызывающий код обязан заранее свести timeSec к [0, lastFrameSec]
// (см. buildSheet) — если ffmpeg всё равно не отдал ни одного кадра, это уже не «запросили время
// за пределами ролика», а настоящий отказ декодера (повреждённый фрагмент, неподдерживаемый кодек).
function thumb(videoPath, timeSec, out, box, thumbW, stage) {
  const drawbox = `drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=magenta@0.9:t=2`;
  runTool('ffmpeg', [...QUIET, '-ss', formatSeconds(timeSec), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${thumbW}:-2,${drawbox}`, out], { stage });
  if (!fs.statSync(out, { throwIfNoEntry: false })?.size) {
    throw new Error(`${stage}: не удалось получить кадр на ${timeSec.toFixed(2)} с — файл повреждён или кодек не читается`);
  }
}

// Контакт-лист 4×4 с рамкой safe-зоны, полоски кадров вокруг секунд правок пульта и G12 «пустые
// кадры». comments — [{id, timeSec}] уже в системе координат videoPath (секунды от начала файла).
// id идёт прямо в имя файла: чужой или подменённый comments.json не должен вывести запись за
// пределы qa/, поэтому принимаем только канонический вид c-<до 40 букв/цифр/дефисов> (COMMENT_ID
// из scripts/pult/comments — в нём нет ни `/`, ни `..`); остальные пропускаем с предупреждением,
// а не роняем всю команду из-за одной записи.
function buildSheet({ videoPath, width, height, duration, fps, outDir, name, comments = [], log = console.warn }) {
  const { thumbW, box } = thumbBox(width, height);
  // Последний реально существующий кадр видео-дорожки: -ss ровно на длительности или за ней ffmpeg
  // молча не отдаёт ничего, даже если сам процесс завершился кодом 0. К этому приводят десятые доли
  // секунды рассинхрона звука и видео, низкий fps, однокадровый ролик — секунды всегда зажаты сюда.
  const lastFrameSec = Math.max(0, duration - 1 / fps);
  const clampSeek = (t) => Math.min(Math.max(0, t), lastFrameSec);
  // Суффикс pid+random: два параллельных запуска `layer sheet` по одному и тому же preview (то же
  // имя sha256) не должны делить одну рабочую папку.
  const work = path.join(outDir, `${name}.frames-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    const times = sheetTimes(duration).map(clampSeek);
    times.forEach((t, i) => thumb(videoPath, t, path.join(work, `f${String(i + 1).padStart(2, '0')}.png`), box, thumbW, 'sheet frame'));
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
      [-1, -0.5, 0, 0.5, 1].forEach((d, i) => thumb(videoPath, clampSeek(comment.timeSec + d), path.join(strip, `f${i + 1}.png`), box, thumbW, 'sheet comment'));
      // Имя привязано к самому preview (name = sheet-<sha256>), а не только к id правки: две разные
      // версии preview не путают полоски друг друга в одной папке qa/.
      const out = path.join(outDir, `${name}-comment-${comment.id}.jpg`);
      runTool('ffmpeg', [...QUIET, '-i', path.join(strip, 'f%d.png'), '-vf', 'tile=5x1', '-frames:v', '1', out], { stage: 'sheet comment' });
      commentPaths.push(out);
    }

    const samples = times.map((t) => {
      const edgeShare = frameEdgeShare(videoPath, t);
      return edgeShare === null ? null : { timeSec: t, edgeShare };
    });
    return { sheetPath, commentPaths, gate: emptyFrameGate(samples) };
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
  // Длительность и геометрия — по самой видео-дорожке (probeMediaPath), а не по контейнеру: если
  // звук preview длиннее видео на десятые доли секунды, длительность контейнера завысила бы конец
  // ролика, и последний семпл или полоска правки просили бы кадр, которого в видео уже нет.
  const probe = probeMediaPath(videoPath, { stage: 'layer sheet probe' });
  // Правки пульта пишут timeSec как currentTime плеера, то есть уже в секундах ОТ НАЧАЛА того самого
  // файла, что играл браузер (scripts/pult/status.js: video.path === preview.filePath) — сдвигать на
  // currentPreview.fromSec не нужно и неверно для preview-фрагмента. Комментарий к другому видео,
  // к более старой версии того же файла на диске (sha256 не совпадает) или со временем за пределами
  // текущей длины — не про этот ролик.
  const comments = readComments(projectDir)
    .filter((comment) => comment.status === 'new' && comment.video.path === current.filePath
      && (comment.video.sha256 === null || comment.video.sha256 === current.sha256)
      && comment.timeSec >= 0 && comment.timeSec <= probe.durationSec)
    .map((comment) => ({ id: comment.id, timeSec: comment.timeSec }));
  const result = buildSheet({
    videoPath, width: probe.width, height: probe.height, duration: probe.durationSec, fps: probe.fps,
    outDir: path.join(projectDir, 'qa'), name: `sheet-${current.sha256.slice(0, 8)}`, comments, log: deps.warn || console.warn,
  });
  log(`Контакт-лист: ${result.sheetPath}`);
  result.commentPaths.forEach((p) => log(`Кадры правки: ${p}`));
  log(formatReport(buildReport({ kind: 'sheet', profile: null, gates: [result.gate], inputs: [] })));
  return 0;
}

module.exports = { FLAGS, buildSheet, frameEdgeShare, run, sheetTimes, thumbBox };
