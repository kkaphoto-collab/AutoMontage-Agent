const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { validateLessonBrief } = require('../scripts/lesson/brief');
const { buildLayerBrief } = require('../scripts/layer/brief');
const layerBrief = require('../scripts/layer/brief');
const layerImport = require('../scripts/layer/import');
const { sha256File, writeJson } = require('../scripts/layer/common');
const { readRegistry } = require('../scripts/layer/registry');
const { buildReport, gate } = require('../scripts/qa/report');
const { readProjectManifest } = require('../scripts/project/workspace');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');

const entry = { layer: 'motion-v01', profile: 'avatar', reference: 'assets/broll/video/1b2c/media.mp4', canonicalSha256: 'a'.repeat(64) };
const base = { sourcePath: '/tmp/p/input/source.mp4', probe: { width: 1080, height: 1920, fps: 25, duration: 84.36 },
  entry, title: 'Тема', headCream: 'ТЕМА', headOrange: 'РОЛИКА', audioMode: 'mix' };

test('layer brief is one full-length broll scene without overlay, with preview-required review', () => {
  const brief = buildLayerBrief({ ...base, music: { file: '/tmp/m.mp3', gainDb: -16, startSec: 3 } });
  assert.equal(validateLessonBrief(brief).ok, true, JSON.stringify(validateLessonBrief(brief).errors));
  assert.equal(brief.status, 'draft');
  assert.equal(brief.brollReviewPolicy, 'preview-required');
  assert.deepEqual(brief.output, { aspect: 'vertical', width: 1080, height: 1920, fps: 25, durationInFrames: 2109 });
  assert.equal(brief.scenes.length, 1, 'слой – одна сцена: brollEnvelope глушит звук слоя на стыках сцен');
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

// Нормализованный слой без Remotion (lavfi) длиной seconds на месте motion-v01/renders/layer-NN.mp4 и
// проходящий отчёт layer render той же формы, что пишет scripts/layer/render.js, для текущего исходника.
function renderCheckedLayer(project, { n = 1, seconds = 2, audio = true } = {}) {
  const name = `layer-${String(n).padStart(2, '0')}.mp4`;
  const file = path.join(project.projectDir, 'motion-v01', 'renders', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=540x960:r=25:d=${seconds}`,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=900:duration=${seconds}`, '-shortest', '-c:a', 'aac'] : []), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', file]);
  const inputs = [
    { role: 'layer', path: `motion-v01/renders/${name}`, sha256: sha256File(file) },
    { role: 'source', path: project.workspace.manifest.source.localPath, sha256: sha256File(project.workspace.sourcePath) },
  ];
  const report = buildReport({ kind: 'layer-render', layer: 'motion-v01', profile: 'avatar', inputs,
    gates: [gate('G6', 'Длина слоя'), gate('G7', 'Голос в звуке слоя')] });
  const reportPath = path.join(project.projectDir, 'qa', `layer-motion-v01-render-${String(n).padStart(2, '0')}.json`);
  writeJson(reportPath, report);
  return { file, reportPath };
}

// Проект с исходником 2 с и импортированным проверенным слоем (layer import) длиной layerSeconds.
async function layerProject(t, { layerSeconds = 2, layerAudio = true } = {}) {
  const project = makeLayerProject(t, { seconds: 2 });
  const layer = renderCheckedLayer(project, { seconds: layerSeconds, audio: layerAudio });
  await layerImport.run({ 'project-dir': project.projectDir, file: layer.file }, { log: () => {} });
  const [imported] = readRegistry(project.projectDir).imports;
  const logs = [];
  const run = (options = {}) => layerBrief.run({ 'project-dir': project.projectDir, asset: imported.reference,
    title: 'Тема', 'head-cream': 'ТЕМА', 'head-orange': 'РОЛИКА', ...options }, { log: (line) => logs.push(String(line)) });
  return { ...project, layer, imported, logs, run };
}

const readBrief = (projectDir, relativePath) => JSON.parse(fs.readFileSync(path.join(projectDir, relativePath), 'utf8'));
const nothingPublished = (projectDir) => {
  assert.deepEqual(readProjectManifest(projectDir).briefs, []);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'brief')), []);
};

test('layer brief publishes the next draft revision for the imported layer and never approves it', { skip: !hasFfmpeg }, async (t) => {
  const p = await layerProject(t);
  assert.equal(await p.run(), 0);
  const manifest = readProjectManifest(p.projectDir);
  assert.equal(manifest.currentBrief, 'brief/v01-draft.lesson.json');
  assert.deepEqual(manifest.briefs.map((b) => [b.kind, b.status]), [['lesson', 'draft']]);
  const brief = readBrief(p.projectDir, manifest.currentBrief);
  assert.equal(validateLessonBrief(brief).ok, true, JSON.stringify(validateLessonBrief(brief).errors));
  assert.equal(brief.status, 'draft');
  assert.equal(brief.source, p.workspace.sourcePath);
  assert.equal(brief.music, undefined, 'без --music музыки нет');
  assert.equal(brief.scenes.length, 1);
  assert.deepEqual([brief.scenes[0].start, brief.scenes[0].end, brief.output.durationInFrames], [0, 2, 50]);
  assert.deepEqual(brief.scenes[0].brollMedia, { kind: 'video', src: p.imported.reference, sha256: p.imported.canonicalSha256,
    trimStartSec: 0, fit: 'cover', audioMode: 'mix', overlay: 'none' });
  assert.ok(fs.existsSync(path.join(p.projectDir, 'brief', 'v01-draft.lesson.md')));
  assert.ok(p.logs.some((line) => /первые и последние 0,12 с приглушён огибающей сцены – эффект хука ставьте не раньше 0,12 с/.test(line)), p.logs.join('\n'));
  assert.ok(p.logs.some((line) => line.includes('automontage preview --project-dir') && line.includes('brief/v01-draft.lesson.json')), p.logs.join('\n'));

  // По sha256 ассета тоже находится; --audio mute – звук слоя выключен; следующая ревизия – v02.
  assert.equal(await p.run({ asset: p.imported.canonicalSha256, audio: 'mute' }), 0);
  const next = readProjectManifest(p.projectDir);
  assert.equal(next.currentBrief, 'brief/v02-draft.lesson.json');
  assert.equal(readBrief(p.projectDir, next.currentBrief).scenes[0].brollMedia.audioMode, 'mute');
  assert.ok(next.briefs.every((b) => b.status === 'draft'), 'layer brief никогда не утверждает');
});

test('music outside the project is copied into assets/music; a different file with that name is not overwritten', { skip: !hasFfmpeg }, async (t) => {
  const p = await layerProject(t);
  const outside = path.join(p.root, 'track.mp3');
  fs.writeFileSync(outside, Buffer.from('music bytes'));
  assert.equal(await p.run({ music: outside, 'music-gain-db': '-18', 'music-start-sec': '4.5' }), 0);
  const copy = path.join(p.projectDir, 'assets', 'music', 'track.mp3');
  assert.equal(sha256File(copy), sha256File(outside));
  const brief = readBrief(p.projectDir, readProjectManifest(p.projectDir).currentBrief);
  assert.equal(brief.music.file, copy);
  assert.deepEqual([brief.music.gainDb, brief.music.startSec], [-18, 4.5]);
  assert.deepEqual(brief.music.ducking, { thresholdDb: -40, ratio: 4, attackMs: 10, releaseMs: 260 }, 'профиль слоя avatar');

  // Файл уже в assets/music – берётся как есть; повторная копия тех же байтов – не ошибка.
  assert.equal(await p.run({ music: copy }), 0);
  assert.equal(readBrief(p.projectDir, readProjectManifest(p.projectDir).currentBrief).music.gainDb, -16, 'avatar по умолчанию −16 дБ');
  assert.equal(await p.run({ music: outside }), 0);
  fs.writeFileSync(outside, Buffer.from('other music'));
  await assert.rejects(p.run({ music: outside }), /в assets\/music уже есть другой файл track\.mp3/);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'music bytes');
  assert.equal(readProjectManifest(p.projectDir).briefs.length, 3);
});

test('flags are checked before anything is written', { skip: !hasFfmpeg }, async (t) => {
  const p = await layerProject(t);
  const music = path.join(p.root, 'track.mp3');
  fs.writeFileSync(music, Buffer.from('music bytes'));
  for (const flag of ['asset', 'title', 'head-cream', 'head-orange']) {
    await assert.rejects(p.run({ [flag]: undefined }), new RegExp(`нужен --${flag}`));
  }
  await assert.rejects(p.run({ audio: 'replace' }), /--audio replace: допустимо mix или mute/);
  await assert.rejects(p.run({ 'music-gain-db': '-10' }), /--music-gain-db без --music/);
  await assert.rejects(p.run({ music, 'music-gain-db': 'громко' }), /--music-gain-db: нужно число/);
  await assert.rejects(p.run({ music, 'music-start-sec': '' }), /--music-start-sec: нужно число/);
  await assert.rejects(p.run({ music, 'music-gain-db': '5' }), /brief невалиден:\n\/music\/gainDb/);
  await assert.rejects(p.run({ music: path.join(p.root, 'missing.mp3') }), /--music .*: файл не найден/);
  nothingPublished(p.projectDir);
  assert.deepEqual(fs.readdirSync(path.join(p.projectDir, 'assets', 'music')), []);
});

test('only an asset registered as a checked layer, with a passing render report and an intact bundle, gets a brief', { skip: !hasFfmpeg }, async (t) => {
  const p = await layerProject(t);
  const notChecked = /ассет не импортирован как проверенный слой .*– сначала automontage layer import --project-dir ".+" --file motion-vNN\/renders\/layer-NN\.mp4/;
  // Ассет, которого нет в реестре (например, импортирован обычным путём Review), и чужой sha256.
  await assert.rejects(p.run({ asset: 'assets/broll/video/00000000-0000-4000-8000-000000000000/media.mp4' }), notChecked);
  await assert.rejects(p.run({ asset: 'f'.repeat(64) }), notChecked);
  // Отчёт layer render этого рендера теперь «стоп».
  const passing = fs.readFileSync(p.layer.reportPath);
  const report = JSON.parse(passing);
  writeJson(p.layer.reportPath, buildReport({ ...report, now: new Date(report.createdAt),
    gates: [gate('G6', 'Длина слоя', { status: 'fail' }), gate('G7', 'Голос в звуке слоя')] }));
  await assert.rejects(p.run(), (error) => notChecked.test(error.message) && /не прошёл проверки/.test(error.message));
  fs.rmSync(p.layer.reportPath);
  await assert.rejects(p.run(), (error) => notChecked.test(error.message) && /нет отчёта layer render/.test(error.message));
  fs.writeFileSync(p.layer.reportPath, passing);
  // Запись реестра правлена руками: отчёт ищется по sha256 и пути рендера, без пути запись неполная.
  const registryFile = path.join(p.projectDir, 'qa', 'layer-imports.json');
  const registry = fs.readFileSync(registryFile);
  const tamper = (fields) => writeJson(registryFile, { version: 1, imports: [{ ...p.imported, ...fields }] });
  tamper({ renderFile: 'motion-v01/renders/layer-07.mp4' });
  await assert.rejects(p.run(), (error) => notChecked.test(error.message) && /нет отчёта layer render для motion-v01\/renders\/layer-07\.mp4/.test(error.message));
  tamper({ renderFile: undefined });
  await assert.rejects(p.run(), (error) => notChecked.test(error.message) && /запись qa\/layer-imports\.json неполная/.test(error.message));
  fs.writeFileSync(registryFile, registry);
  // Ассет импорта повреждён: без VP8-прокси preview его не примет.
  fs.rmSync(path.join(p.projectDir, 'previews', 'broll', `${p.imported.assetId}.webm`));
  await assert.rejects(p.run(), (error) => notChecked.test(error.message) && error.message.includes(`ассет ${p.imported.reference} повреждён или удалён`));
  nothingPublished(p.projectDir);
});

test('a layer shorter than the source (any frame) or longer by more than a frame is refused', { skip: !hasFfmpeg }, async (t) => {
  // Короче на кадр – preview упал бы на BROLL_MEDIA_CLIP_OVERRUN; длиннее – слой собран не под этот исходник.
  for (const [layerSeconds, pattern] of [[1.96, /слой короче исходника: 1,96 с против 2 с/], [2.2, /слой длиннее исходника: 2,2 с против 2 с/]]) {
    const p = await layerProject(t, { layerSeconds });
    await assert.rejects(p.run(), (error) => pattern.test(error.message)
      && /создайте новый слой: automontage layer new --project-dir ".+" → layer render → layer import/.test(error.message));
    nothingPublished(p.projectDir);
  }
});

test('regression: a layer rendered for an earlier source is refused after the source bytes change', { skip: !hasFfmpeg }, async (t) => {
  const p = await layerProject(t);
  // Та же длина, другие байты: проверка длины этого не видит – только sha256 исходника из отчёта layer render.
  const replacement = `${p.workspace.sourcePath}.new.mp4`;
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=540x960:r=25:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', replacement]);
  fs.renameSync(replacement, p.workspace.sourcePath);
  await assert.rejects(p.run(), /слой собран для другого исходника \(отчёт qa\/layer-motion-v01-render-01\.json\) – создайте новый слой: automontage layer new --project-dir ".+" → layer render → layer import/);
  nothingPublished(p.projectDir);
});

test('a layer without an audio track is refused with the layer sound on, and works muted', { skip: !hasFfmpeg }, async (t) => {
  const p = await layerProject(t, { layerAudio: false });
  await assert.rejects(p.run(), /в слое нет звука – укажите --audio mute или пересоберите слой со звуками/);
  nothingPublished(p.projectDir);
  assert.equal(await p.run({ audio: 'mute' }), 0);
  const brief = readBrief(p.projectDir, readProjectManifest(p.projectDir).currentBrief);
  assert.equal(brief.scenes[0].brollMedia.audioMode, 'mute');
});
