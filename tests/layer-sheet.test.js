const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { writeProjectManifest } = require('../scripts/project/workspace');
const { hashFile } = require('../scripts/pult/files');
const { probeMediaPath } = require('../scripts/media-probe');
const { acceptComment, addComment } = require('../scripts/pult/comments');
const { safeRect } = require('../scripts/qa/safe-rect');
const { buildSheet, frameEdgeShare, run, sheetTimes, thumbBox } = require('../scripts/layer/sheet');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const FONT = path.join(__dirname, '..', 'public', 'fonts', 'Oswald.ttf');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-sheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function imageDims(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  const [width, height] = out.split(',').map(Number);
  return { width, height };
}

// Видео с чёрной половиной (0–4 с) и цветной половиной testsrc2 (4–8 с): 8 из 16 середин отрезков
// попадают на чёрный участок (доля краевых пикселей 0) – устойчивый ровно 50/50 случай для G12.
function halfBlackVideo(file, { size = '108x192', fps = 25, halfSec = 4 } = {}) {
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=${fps}:d=${halfSec}`,
    '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${fps}:d=${halfSec}`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', file]);
}

function plainVideo(file, { size = '108x192', fps = 25, seconds = 8 } = {}) {
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${fps}:d=${seconds}`, '-pix_fmt', 'yuv420p', file]);
}

test('sheet times sit in the middle of 16 equal slices', () => {
  assert.deepEqual(sheetTimes(16).slice(0, 3), [0.5, 1.5, 2.5]);
  assert.equal(sheetTimes(16).length, 16);
});

test('contact sheet, comment strips and an exact G12 warn value from a real half-black video', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const video = path.join(dir, 'preview.mp4');
  halfBlackVideo(video);
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 8, fps: 25, outDir: dir, name: 'sheet-test',
    comments: [{ id: 'c-1234abcd', timeSec: 6 }] });
  assert.ok(fs.statSync(result.sheetPath).size > 0);
  assert.ok(fs.statSync(result.commentPaths[0]).size > 0);
  assert.match(result.commentPaths[0], /sheet-test-comment-c-1234abcd\.jpg$/);
  assert.equal(result.gate.id, 'G12');
  assert.equal(result.gate.status, 'warn');
  // sheetTimes(8) середины: 0,25 0,75 … 7,75 – первые 8 (i=0..7) лежат в чёрной половине 0–4 с.
  assert.equal(result.gate.value, 8);
  const spanSeconds = result.gate.spans.map((span) => span.fromSec);
  for (const sec of spanSeconds) assert.ok(sec < 4, `${sec} должен быть в чёрной половине`);
  // Рабочая папка PNG-кадров не остаётся рядом с готовым контакт-листом.
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.frames')), []);
});

test('a video with no empty stretch passes G12 with value 0', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video);
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 8, fps: 25, outDir: dir, name: 'sheet-pass' });
  assert.equal(result.gate.status, 'pass');
  assert.equal(result.gate.value, 0);
  assert.deepEqual(result.commentPaths, []);
});

test('a comment id with path traversal is skipped and never escapes the output folder', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video, { seconds: 4 });
  const warnings = [];
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 4, fps: 25, outDir: dir, name: 'sheet-evil',
    comments: [{ id: '../../evil', timeSec: 1 }, { id: 'c-not safe!', timeSec: 1 }, { id: 'c-ok12345', timeSec: 1 }],
    log: (line) => warnings.push(line) });
  // Только валидный id получил полосу кадров; остальные – предупреждение по-русски, не файл.
  assert.equal(result.commentPaths.length, 1);
  assert.match(result.commentPaths[0], /sheet-evil-comment-c-ok12345\.jpg$/);
  assert.equal(warnings.length, 2);
  for (const line of warnings) assert.match(line, /[а-я]/);
  // outDir содержит исходник, контакт-лист и полосу валидной правки – ничего от «../../evil».
  assert.deepEqual(fs.readdirSync(dir).sort(), ['preview.mp4', 'sheet-evil-comment-c-ok12345.jpg', 'sheet-evil.jpg']);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil')), 'подмена id не вышла за пределы temp-папки теста');
});

// --- Конец ролика: -ss ровно на длительности (или за ней) отдаёт код 0, но ни одного кадра – даже
// когда запрошенное время формально внутри контейнера. Компенсируется через длительность именно
// видео-дорожки (lastFrameSec = videoDur - 1/fps) и зажим каждого -ss в [0, lastFrameSec]. Ниже –
// сценарии, которые раньше падали, и один настоящий отказ декодера, который остаётся ошибкой.

test('a comment near the very end still gets its frame strip (lastFrameSec clamp)', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video, { seconds: 4 });
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 4, fps: 25, outDir: dir, name: 'sheet-edge',
    comments: [{ id: 'c-nearend01', timeSec: 3.99 }] });
  assert.equal(result.commentPaths.length, 1);
  assert.ok(fs.statSync(result.commentPaths[0]).size > 0);
});

// formatSeconds rounds to the NEAREST millisecond by construction of toFixed(3): for a lastFrameSec
// like 3,9666667 с (30 fps, 4 с) that rounds UP to "3.967" – already past the real last frame, the
// exact same silent-failure this whole clamp exists to avoid. It must round DOWN instead.
test('a 30 fps 4 s clip with a comment at 3.98 s does not round -ss past the last real frame', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video, { fps: 30, seconds: 4 });
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 4, fps: 30, outDir: dir, name: 'sheet-30fps',
    comments: [{ id: 'c-thirty01', timeSec: 3.98 }] });
  assert.equal(result.commentPaths.length, 1);
  assert.ok(fs.statSync(result.commentPaths[0]).size > 0);
});

test('a 30000/1001 fps 12 s clip with a comment at 11.99 s does not round -ss past the last real frame', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const video = path.join(dir, 'preview.mp4');
  const fps = 30000 / 1001;
  plainVideo(video, { fps: '30000/1001', seconds: 12 });
  // 29,97 кадра в секунду: запрошенные 12 с ffmpeg округляет до целого числа кадров (360), реальная
  // длина видео-дорожки – 360/fps ≈ 12,012 с, не ровно 12 – берём её тем же способом, что run().
  const duration = probeMediaPath(video, { stage: 'test probe' }).durationSec;
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration, fps, outDir: dir, name: 'sheet-vfr12',
    comments: [{ id: 'c-vfr01', timeSec: 11.99 }] });
  assert.equal(result.commentPaths.length, 1);
  assert.ok(fs.statSync(result.commentPaths[0]).size > 0);
});

test('a 10 fps 3 s clip produces a full sheet (short clip, low fps)', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video, { fps: 10, seconds: 3 });
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 3, fps: 10, outDir: dir, name: 'sheet-lowfps' });
  assert.ok(fs.statSync(result.sheetPath).size > 0);
});

test('a one-frame clip produces a sheet instead of failing on every sample', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const video = path.join(dir, 'preview.mp4');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=108x192:r=25', '-frames:v', '1', '-pix_fmt', 'yuv420p', video]);
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 1 / 25, fps: 25, outDir: dir, name: 'sheet-oneframe' });
  assert.ok(fs.statSync(result.sheetPath).size > 0);
});

// Видео 4 с, звук 4,5 с: контейнер (format.duration) отдал бы 4,5 с – по видео-дорожке верно 4 с.
function scaffoldLongerAudioProject(t) {
  const { projectDir, workspace } = makeLayerProject(t, { seconds: 6 });
  const previewRelative = 'previews/preview.mp4';
  const previewPath = path.join(projectDir, previewRelative);
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=108x192:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=4.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-map', '0:v', '-map', '1:a', previewPath]);
  const nextManifest = {
    ...workspace.manifest,
    currentPreview: { filePath: previewRelative, briefPath: 'brief/v01-draft.lesson.json', kind: 'full', fromSec: 0, toSec: 4,
      width: 108, height: 192, fps: 25, generatedAt: new Date().toISOString(), sha256: hashFile(previewPath) },
  };
  writeProjectManifest(projectDir, nextManifest, { expectedManifest: workspace.manifest });
  const addPreviewComment = (timeSec) => addComment(projectDir,
    { timeSec, text: 'правка', video: { kind: 'preview', path: previewRelative, sha256: null } }, { captureFrame: null });
  return { projectDir, addPreviewComment };
}

test('an audio track 0.5 s longer than the video does not push a near-end comment past the real content', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, addPreviewComment } = scaffoldLongerAudioProject(t);
  // Правка на 3,99 с – почти у настоящего конца видео (4 с), а не у раздутого звуком конца контейнера.
  addPreviewComment(3.99);
  assert.equal(await run({ 'project-dir': projectDir }, { log: () => {} }), 0);
  const commentFiles = fs.readdirSync(path.join(projectDir, 'qa')).filter((f) => f.includes('-comment-'));
  assert.equal(commentFiles.length, 1, commentFiles.join(', '));
});

test('a comment between the video-stream end and the container end is kept and clamped, one past the container end is dropped', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, addPreviewComment } = scaffoldLongerAudioProject(t);
  // 4,03 с: за концом видео (4,0 с), но внутри контейнера (4,5 с, растянутого звуком) – это тот же
  // ролик, просто правка попала в хвост, где звук ещё идёт, а видео уже кончилось; buildSheet сам
  // сведёт секунды к lastFrameSec, поэтому такую правку не нужно отбрасывать.
  addPreviewComment(4.03);
  // 4,6 с – уже за пределами самого контейнера: это не про этот файл вовсе.
  addPreviewComment(4.6);
  assert.equal(await run({ 'project-dir': projectDir }, { log: () => {} }), 0);
  const commentFiles = fs.readdirSync(path.join(projectDir, 'qa')).filter((f) => f.includes('-comment-'));
  assert.equal(commentFiles.length, 1, commentFiles.join(', '));
});

test('BAD CASE: a genuinely unreadable frame fails with an honest Russian error (not "ролик короче")', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const full = path.join(dir, 'full.mp4');
  const broken = path.join(dir, 'preview.mp4');
  // faststart кладёт moov (метаданные, включая длительность) в начало файла: обрезка хвоста после
  // него оставляет верную длительность по ffprobe, но реальные данные конца ролика пропадают –
  // настоящий отказ декодера внутри границ, а не запрос времени за пределами ролика.
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=108x192:r=25:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', full]);
  const bytes = fs.readFileSync(full);
  fs.writeFileSync(broken, bytes.subarray(0, Math.floor(bytes.length * 0.5)));
  assert.throws(() => buildSheet({ videoPath: broken, width: 108, height: 192, duration: 4, fps: 25, outDir: dir, name: 'sheet-broken' }),
    (error) => {
      assert.match(error.message, /не удалось получить кадр/);
      assert.doesNotMatch(error.message, /ролик короче/);
      assert.match(error.message, /[а-я]/);
      return true;
    });
  // Рабочая папка убрана даже после отказа (try/finally), рядом ничего не осталось.
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.frames')), []);
});

test('two runs on the same preview name do not collide on the same work folder', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video, { seconds: 4 });
  // Папка со старым (наивным, без суффикса) именем уже существует и занята чужим файлом – новый
  // запуск не должен упасть на неё и не должен её тронуть.
  const naive = path.join(dir, 'sheet-same.frames');
  fs.mkdirSync(naive);
  fs.writeFileSync(path.join(naive, 'leftover.txt'), 'чужой файл');
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 4, fps: 25, outDir: dir, name: 'sheet-same' });
  assert.ok(fs.statSync(result.sheetPath).size > 0);
  assert.deepEqual(fs.readdirSync(naive), ['leftover.txt'], 'чужая папка не тронута');
});

for (const [label, size] of [['portrait 109x193', '109x193'], ['landscape 193x109', '193x109']]) {
  test(`odd frame size ${label} produces a sheet with an even thumbnail height`, { skip: !hasFfmpeg }, (t) => {
    const dir = tmpDir(t);
    const [width, height] = size.split('x').map(Number);
    const video = path.join(dir, 'preview.mp4');
    plainVideo(video, { size, seconds: 4 });
    const result = buildSheet({ videoPath: video, width, height, duration: 4, fps: 25, outDir: dir, name: 'sheet-odd' });
    const dims = imageDims(result.sheetPath);
    // Лист – тайл 4×4: высота одной миниатюры (с -2 у scale она всегда чётная) повторена 4 раза,
    // поэтому чётная миниатюра даёт высоту листа, кратную 8; нечётная дала бы остаток 4.
    assert.equal(dims.height % 8, 0, `sheet height ${dims.height} not a multiple of 8`);
  });
}

test('a 30000/1001 fps clip produces a sheet', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video, { fps: '30000/1001', seconds: 4 });
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 4, fps: 30000 / 1001, outDir: dir, name: 'sheet-vfr' });
  assert.ok(fs.statSync(result.sheetPath).size > 0);
});

// --- safe-зона: положение рамки на миниатюре, а не только что она нарисована ---

function magentaBox(sheetPath, thumbW) {
  const { width: sheetW, height: sheetH } = imageDims(sheetPath);
  assert.equal(sheetW, thumbW * 4, 'лист – тайл 4×4 в ширину');
  const thumbH = sheetH / 4;
  const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', sheetPath, '-vf', `crop=${thumbW}:${thumbH}:0:0`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  const buf = decoded.stdout;
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (let y = 0; y < thumbH; y += 1) {
    for (let x = 0; x < thumbW; x += 1) {
      const idx = (y * thumbW + x) * 3;
      const r = buf[idx], g = buf[idx + 1], b = buf[idx + 2];
      if (r > 150 && b > 150 && g < 110) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { left: minX, top: minY, right: maxX, bottom: maxY };
}

for (const [label, width, height, expectedThumbW] of [['portrait', 1080, 1920, 270], ['landscape', 1920, 1080, 480]]) {
  test(`safe-zone box sits where safeRect says it should (${label})`, { skip: !hasFfmpeg }, (t) => {
    const dir = tmpDir(t);
    const video = path.join(dir, 'preview.mp4');
    // Чёрный фон целиком: единственные не-чёрные пиксели на миниатюре – сама рамка magenta.
    runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=1`, '-pix_fmt', 'yuv420p', video]);
    const result = buildSheet({ videoPath: video, width, height, duration: 1, fps: 25, outDir: dir, name: 'sheet-safe' });
    const { thumbW, box } = thumbBox(width, height);
    // Пришпилено к конкретному числу, а не только к своей же формуле thumbWidth(): портрет – 270 px,
    // альбом – 480 px (то есть лист 4×4 у альбома должен быть ровно 1920 px в ширину).
    assert.equal(thumbW, expectedThumbW);
    assert.equal(imageDims(result.sheetPath).width, expectedThumbW * 4);
    const found = magentaBox(result.sheetPath, thumbW);
    const tolerance = 3;
    assert.ok(Math.abs(found.left - box.x) <= tolerance, `left ${found.left} vs ${box.x}`);
    assert.ok(Math.abs(found.top - box.y) <= tolerance, `top ${found.top} vs ${box.y}`);
    assert.ok(Math.abs(found.right - (box.x + box.w)) <= tolerance, `right ${found.right} vs ${box.x + box.w}`);
    assert.ok(Math.abs(found.bottom - (box.y + box.h)) <= tolerance, `bottom ${found.bottom} vs ${box.y + box.h}`);
    // sanity: safeRect действительно даёт разный прямоугольник для портрета и альбома.
    const safe = safeRect(width, height);
    assert.ok(safe.left >= 0 && safe.right <= width);
  });
}

// --- Тайминг полоски правки: кадр в центре полоски должен быть кадром на времени самой правки ---

test('the centre frame of a comment strip is the frame at the comment time, not an offset one', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir(t);
  const video = path.join(dir, 'preview.mp4');
  // Яркость кадра растёт линейно со временем (T*100, T – секунды по ffmpeg geq), почти без потерь
  // (crf 0): средняя яркость кадра – надёжные «часы», которые показывают, какой момент реально попал
  // в кадр, а не то, что мы думаем, что туда попало.
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25:d=2',
    '-vf', "geq=lum='T*100':cb=128:cr=128", '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv444p', video]);
  const comment = { id: 'c-clocktest', timeSec: 1.2 };
  const result = buildSheet({ videoPath: video, width: 64, height: 64, duration: 2, fps: 25, outDir: dir, name: 'sheet-clock', comments: [comment] });
  const { width: stripW, height: stripH } = imageDims(result.commentPaths[0]);
  const tileW = stripW / 5;
  const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', result.commentPaths[0], '-vf', `crop=${tileW}:${stripH}:${tileW * 2}:0`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  const pixels = decoded.stdout;
  let sum = 0;
  for (const value of pixels) sum += value;
  const impliedTime = (sum / pixels.length) / 100;
  assert.ok(Math.abs(impliedTime - comment.timeSec) < 0.3, `implied ${impliedTime} vs comment ${comment.timeSec}`);
});

// --- G12: доля краевых пикселей вместо среднего/разброса яркости ---

function shareCase(name, buildFixture, expectEmpty) {
  test(`edge density: ${name} → ${expectEmpty ? 'empty' : 'not empty'}`, { skip: !hasFfmpeg }, (t) => {
    const dir = tmpDir(t);
    const video = path.join(dir, 'preview.mp4');
    buildFixture(video);
    const share = frameEdgeShare(video, 0.05);
    assert.notEqual(share, null);
    if (expectEmpty) assert.ok(share < 0.001, `${name}: share ${share} should be < 0.1%`);
    else assert.ok(share >= 0.001, `${name}: share ${share} should be >= 0.1%`);
  });
}

const lavfi = (input, extraVf) => (video) => {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', input];
  if (extraVf) args.push('-vf', extraVf);
  args.push('-pix_fmt', 'yuv420p', video);
  runTool('ffmpeg', args);
};

shareCase('solid black', lavfi('color=c=black:s=1080x1920:d=0.2'), true);
shareCase('flat grey', lavfi('color=c=gray:s=1080x1920:d=0.2'), true);
shareCase('flat cream', lavfi('color=c=0xF5F0E1:s=1080x1920:d=0.2'), true);
shareCase('smoothed random noise (downscaled away)', lavfi('color=c=gray:s=1080x1920:d=0.2', 'noise=alls=40:allf=t'), true);
shareCase('smooth gradient', lavfi('gradients=s=1080x1920:d=0.2'), true);
shareCase('dark vignette', lavfi('color=c=gray:s=1080x1920:d=0.2', 'vignette=PI/3'), true);
shareCase('testsrc2 test grid', lavfi('testsrc2=s=1080x1920:d=0.2'), false);
shareCase('dark background with small white text', (video) => {
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1A1A1A:s=1080x1920:d=0.2', '-vf',
    `drawtext=fontfile=${FONT}:text=Шаг 1:fontcolor=white:fontsize=60:x=(w-text_w)/2:y=(h-text_h)/2`, '-pix_fmt', 'yuv420p', video]);
}, false);
shareCase('cream background with small dark numbers', (video) => {
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xF5F0E1:s=1080x1920:d=0.2', '-vf',
    `drawtext=fontfile=${FONT}:text=12 000:fontcolor=0x333333:fontsize=60:x=(w-text_w)/2:y=(h-text_h)/2`, '-pix_fmt', 'yuv420p', video]);
}, false);

// --- run(): интеграция с project.json и pult/comments.json ---

function scaffoldProject(t, { seconds = 4, size = '108x192' } = {}) {
  // Длина исходника проекта (макет kit-fixture) и длина preview – разные ролики; исходник просто
  // должен быть достаточно длинным для транскрипта-заглушки makeLayerProject.
  const { projectDir, workspace } = makeLayerProject(t, { seconds: 6 });
  const previewRelative = 'previews/preview.mp4';
  const previewPath = path.join(projectDir, previewRelative);
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  plainVideo(previewPath, { size, seconds });
  const nextManifest = {
    ...workspace.manifest,
    currentPreview: {
      filePath: previewRelative,
      briefPath: 'brief/v01-draft.lesson.json',
      kind: 'full',
      fromSec: 0,
      toSec: seconds,
      width: Number(size.split('x')[0]),
      height: Number(size.split('x')[1]),
      fps: 25,
      generatedAt: new Date().toISOString(),
      sha256: hashFile(previewPath),
    },
  };
  writeProjectManifest(projectDir, nextManifest, { expectedManifest: workspace.manifest });
  const addPreviewComment = (timeSec, overrides = {}) => addComment(projectDir, {
    timeSec, text: 'правка', video: { kind: 'preview', path: previewRelative, sha256: null }, ...overrides,
  }, { captureFrame: null });
  return { projectDir, previewPath, previewRelative, addPreviewComment };
}

test('run() without a currentPreview refuses in Russian', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t);
  await assert.rejects(run({ 'project-dir': projectDir }), (error) => {
    assert.match(error.message, /нет текущего preview/);
    return true;
  });
});

test('run() writes the sheet under qa/ and lists comment frame strips', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, addPreviewComment } = scaffoldProject(t, { seconds: 4 });
  addPreviewComment(2);
  const lines = [];
  assert.equal(await run({ 'project-dir': projectDir }, { log: (line) => lines.push(line) }), 0);
  const qaDir = path.join(projectDir, 'qa');
  const files = fs.readdirSync(qaDir);
  assert.ok(files.some((f) => /^sheet-[a-f0-9]{8}\.jpg$/.test(f)), files.join(', '));
  assert.ok(files.some((f) => f.includes('-comment-')), files.join(', '));
  assert.ok(lines.some((line) => line.includes('Контакт-лист')));
  assert.ok(lines.some((line) => line.includes('G12')));
});

function scaffoldHalfBlackProject(t) {
  const { projectDir, workspace } = makeLayerProject(t, { seconds: 6 });
  const previewRelative = 'previews/preview.mp4';
  const previewPath = path.join(projectDir, previewRelative);
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  halfBlackVideo(previewPath);
  const nextManifest = { ...workspace.manifest, currentPreview: { filePath: previewRelative, briefPath: 'brief/v01-draft.lesson.json',
    kind: 'full', fromSec: 0, toSec: 8, width: 108, height: 192, fps: 25, generatedAt: new Date().toISOString(), sha256: hashFile(previewPath) } };
  writeProjectManifest(projectDir, nextManifest, { expectedManifest: workspace.manifest });
  return { projectDir };
}

test('run() prints G12 span seconds and the hint when the gate warns', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = scaffoldHalfBlackProject(t);
  const lines = [];
  assert.equal(await run({ 'project-dir': projectDir }, { log: (line) => lines.push(line) }), 0);
  const block = lines.join('\n');
  assert.match(block, /Проверки \(контакт-лист\)/, 'kind has a human title, not the bare "sheet" key');
  assert.match(block, /⚠️.*G12/);
  assert.match(block, /\d+:\d{2},\d{2}/, 'span seconds are printed in clock form');
  assert.match(block, /проверьте, не выпала ли графика/);
});

test('run() skips comments from another video, past the preview duration, or with a stale sha256', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, addPreviewComment } = scaffoldProject(t, { seconds: 4 });
  // Комментарий к правильному preview, но со временем за пределами его длины (ролик обрезали после
  // правки) – этой правки в текущем ролике больше нет.
  addPreviewComment(100);
  // Комментарий к другому видео (устаревший preview того же ролика) – другая система координат.
  plainVideo(path.join(projectDir, 'stale.mp4'), { seconds: 4 });
  addPreviewComment(1, { video: { kind: 'stale-preview', path: 'stale.mp4', sha256: null } });
  // Тот же путь, что у текущего preview, но чужой sha256 – файл по этому пути с тех пор переписали.
  addPreviewComment(1.5, { video: { kind: 'preview', path: 'previews/preview.mp4', sha256: 'a'.repeat(64) } });
  // Валидная правка внутри текущего preview.
  addPreviewComment(2);
  assert.equal(await run({ 'project-dir': projectDir }, { log: () => {} }), 0);
  const qaDir = path.join(projectDir, 'qa');
  const commentFiles = fs.readdirSync(qaDir).filter((f) => f.includes('-comment-'));
  assert.equal(commentFiles.length, 1, commentFiles.join(', '));
});

test('run() ignores already accepted comments', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, addPreviewComment } = scaffoldProject(t, { seconds: 4 });
  const comment = addPreviewComment(1);
  acceptComment(projectDir, comment.id);
  assert.equal(await run({ 'project-dir': projectDir }, { log: () => {} }), 0);
  const qaDir = path.join(projectDir, 'qa');
  assert.deepEqual(fs.readdirSync(qaDir).filter((f) => f.includes('-comment-')), []);
});
