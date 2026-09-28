const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { writeProjectManifest } = require('../scripts/project/workspace');
const { hashFile } = require('../scripts/pult/files');
const { acceptComment, addComment } = require('../scripts/pult/comments');
const { buildSheet, run, sheetTimes } = require('../scripts/layer/sheet');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');

function imageDims(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  const [width, height] = out.split(',').map(Number);
  return { width, height };
}

// Видео с чёрной половиной (0–4 с) и цветной half testsrc2 (4–8 с): 8 из 16 середин отрезков
// попадают на чёрный участок (яркость и разброс пикселей 0) — ровно случай из плана.
function halfBlackVideo(file, { size = '108x192', fps = 25, halfSec = 4 } = {}) {
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', `-i`, `color=c=black:s=${size}:r=${fps}:d=${halfSec}`,
    '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${fps}:d=${halfSec}`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', file]);
}

function plainVideo(file, { size = '108x192', fps = 25, seconds = 8 } = {}) {
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${fps}:d=${seconds}`, '-pix_fmt', 'yuv420p', file]);
}

test('sheet times sit in the middle of 16 equal slices', () => {
  assert.deepEqual(sheetTimes(16).slice(0, 3), [0.5, 1.5, 2.5]);
  assert.equal(sheetTimes(16).length, 16);
});

test('contact sheet, comment strips and empty frame warnings from a real video', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-sheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'preview.mp4');
  halfBlackVideo(video);
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 8, outDir: dir, name: 'sheet-test',
    comments: [{ id: 'c-1234abcd', timeSec: 6 }] });
  assert.ok(fs.statSync(result.sheetPath).size > 0);
  assert.ok(fs.statSync(result.commentPaths[0]).size > 0);
  assert.equal(result.gate.id, 'G12');
  assert.equal(result.gate.status, 'warn');
  assert.ok(result.gate.value >= 7);
  // Рабочая папка PNG-кадров не остаётся рядом с готовым контакт-листом.
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.frames')), []);
});

test('a video with no empty stretch passes G12 with value 0', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-sheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video);
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 8, outDir: dir, name: 'sheet-pass' });
  assert.equal(result.gate.status, 'pass');
  assert.equal(result.gate.value, 0);
  assert.deepEqual(result.commentPaths, []);
});

test('a comment id with path traversal is skipped and never escapes the output folder', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-sheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video, { seconds: 4 });
  const warnings = [];
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 4, outDir: dir, name: 'sheet-evil',
    comments: [{ id: '../../evil', timeSec: 1 }, { id: 'c-not safe!', timeSec: 1 }, { id: 'c-ok12345', timeSec: 1 }],
    log: (line) => warnings.push(line) });
  // Только валидный id получил полосу кадров; остальные — предупреждение по-русски, не файл.
  assert.equal(result.commentPaths.length, 1);
  assert.match(result.commentPaths[0], /comment-c-ok12345\.jpg$/);
  assert.equal(warnings.length, 2);
  for (const line of warnings) assert.match(line, /[а-я]/);
  // outDir содержит исходник, контакт-лист и полосу валидной правки — ничего от «../../evil».
  assert.deepEqual(fs.readdirSync(dir).sort(), ['comment-c-ok12345.jpg', 'preview.mp4', 'sheet-evil.jpg']);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil')), 'подмена id не вышла за пределы temp-папки теста');
});

test('a comment near the very end still gets its frame strip (duration - 0.05 clamp)', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-sheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video, { seconds: 4 });
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 4, outDir: dir, name: 'sheet-edge',
    comments: [{ id: 'c-nearend01', timeSec: 3.98 }] });
  assert.equal(result.commentPaths.length, 1);
  assert.ok(fs.statSync(result.commentPaths[0]).size > 0);
});

test('BAD CASE: a duration longer than the real clip fails with a clear Russian error, not a shorter sheet', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-sheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video, { seconds: 4 });
  // Заявленная длина больше настоящей: последний из 16 семплов (15,5/16 * 4,5 ≈ 4,36 с) требует
  // кадра за пределами 4-секундного ролика — ffmpeg там отработает кодом 0, но кадра не отдаст.
  assert.throws(() => buildSheet({ videoPath: video, width: 108, height: 192, duration: 4.5, outDir: dir, name: 'sheet-short' }),
    /кадр на .* не получен/);
  // Рабочая папка убрана даже после отказа (try/finally), рядом ничего не осталось.
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.frames')), []);
});

test('two runs on the same preview name do not collide on the same work folder', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-sheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video, { seconds: 4 });
  // Папка со старым (наивным, без суффикса) именем уже существует и занята чужим файлом — новый
  // запуск не должен упасть на неё и не должен её тронуть.
  const naive = path.join(dir, 'sheet-same.frames');
  fs.mkdirSync(naive);
  fs.writeFileSync(path.join(naive, 'leftover.txt'), 'чужой файл');
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 4, outDir: dir, name: 'sheet-same' });
  assert.ok(fs.statSync(result.sheetPath).size > 0);
  assert.deepEqual(fs.readdirSync(naive), ['leftover.txt'], 'чужая папка не тронута');
});

for (const [label, size] of [['portrait 1080x1920', '1080x1920'], ['landscape 1920x1080', '1920x1080']]) {
  test(`odd frame size ${label} produces a sheet with an even thumbnail height`, { skip: !hasFfmpeg }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-sheet-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const [width, height] = size.split('x').map(Number);
    const video = path.join(dir, 'preview.mp4');
    plainVideo(video, { size, seconds: 4 });
    const result = buildSheet({ videoPath: video, width, height, duration: 4, outDir: dir, name: 'sheet-odd' });
    const dims = imageDims(result.sheetPath);
    // Лист — тайл 4×4: высота одной миниатюры (с -2 у scale она всегда чётная) повторена 4 раза,
    // поэтому чётная миниатюра даёт высоту листа, кратную 8; нечётная дала бы остаток 4.
    assert.equal(dims.height % 8, 0, `sheet height ${dims.height} not a multiple of 8`);
  });
}

test('a 30000/1001 fps clip produces a sheet', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-sheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'preview.mp4');
  plainVideo(video, { fps: '30000/1001', seconds: 4 });
  const result = buildSheet({ videoPath: video, width: 108, height: 192, duration: 4, outDir: dir, name: 'sheet-vfr' });
  assert.ok(fs.statSync(result.sheetPath).size > 0);
});

// --- run(): интеграция с project.json и pult/comments.json ---

function scaffoldProject(t, { seconds = 4, size = '108x192' } = {}) {
  // Длина исходника проекта (макет kit-fixture) и длина preview — разные ролики; исходник просто
  // должен быть достаточно длинным для транскрипта-заглушки makeLayerProject.
  const { root, projectDir, workspace } = makeLayerProject(t, { seconds: 6 });
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
  return { root, projectDir, previewPath, previewRelative, addPreviewComment };
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
  assert.ok(files.some((f) => f.startsWith('comment-')), files.join(', '));
  assert.ok(lines.some((line) => line.includes('Контакт-лист')));
  assert.ok(lines.some((line) => line.includes('G12')));
});

test('run() skips comments from another video and comments past the preview duration', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, addPreviewComment } = scaffoldProject(t, { seconds: 4 });
  // Комментарий к правильному preview, но со временем за пределами его длины (ролик обрезали после
  // правки) — этой правки в текущем ролике больше нет.
  addPreviewComment(100);
  // Комментарий к другому видео (устаревший preview того же ролика) — другая система координат.
  plainVideo(path.join(projectDir, 'stale.mp4'), { seconds: 4 });
  addPreviewComment(1, { video: { kind: 'stale-preview', path: 'stale.mp4', sha256: null } });
  // Валидная правка внутри текущего preview.
  addPreviewComment(2);
  assert.equal(await run({ 'project-dir': projectDir }, { log: () => {} }), 0);
  const qaDir = path.join(projectDir, 'qa');
  const commentFiles = fs.readdirSync(qaDir).filter((f) => f.startsWith('comment-'));
  assert.equal(commentFiles.length, 1, commentFiles.join(', '));
});

test('run() ignores already accepted comments', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, addPreviewComment } = scaffoldProject(t, { seconds: 4 });
  const comment = addPreviewComment(1);
  acceptComment(projectDir, comment.id);
  assert.equal(await run({ 'project-dir': projectDir }, { log: () => {} }), 0);
  const qaDir = path.join(projectDir, 'qa');
  assert.deepEqual(fs.readdirSync(qaDir).filter((f) => f.startsWith('comment-')), []);
});
