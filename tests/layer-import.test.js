const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { sha256File, writeJson } = require('../scripts/layer/common');
const { buildReport, gate } = require('../scripts/qa/report');
const {
  appendRegistry, findByCanonical, findByReference, findByRender, findRenderReport, readRegistry, renderPassed,
} = require('../scripts/layer/registry');
const layerImport = require('../scripts/layer/import');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const pad = (n) => String(n).padStart(2, '0');
const quiet = { log: () => {} };

// Нормализованный слой без Remotion: короткий lavfi-ролик на месте motion-v01/renders/layer-NN.mp4.
function renderedLayer(projectDir, { n = 1, frequency = 900 } = {}) {
  const file = path.join(projectDir, 'motion-v01', 'renders', `layer-${pad(n)}.mp4`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=108x192:r=25:d=2',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=2`, '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', file]);
  return file;
}

// Отчёт layer render той же формы, что пишет scripts/layer/render.js: слой первым (role 'layer'), затем
// исходник и манифест. status: 'pass' | 'warn' | 'fail'; error — строка или null.
function renderReport(projectDir, { n = 1, layerSha, sourceSha = 's'.repeat(64), status = 'pass', error = null, createdAt = '2026-09-28T10:00:00.000Z' }) {
  const gates = status === 'pass' ? [gate('G6', 'Длина слоя')] : [gate('G6', 'Длина слоя', { status })];
  const inputs = [
    ...(layerSha ? [{ role: 'layer', path: `motion-v01/renders/layer-${pad(n)}.mp4`, sha256: layerSha }] : []),
    { role: 'source', path: 'input/source.mp4', sha256: sourceSha },
    { role: 'manifest', path: 'motion-v01/out/manifest.json', sha256: 'm'.repeat(64) },
  ];
  const report = buildReport({ kind: 'layer-render', layer: 'motion-v01', profile: 'avatar', gates, error, inputs, now: new Date(createdAt) });
  const file = path.join(projectDir, 'qa', `layer-motion-v01-render-${pad(n)}.json`);
  writeJson(file, report);
  return file;
}

const registryPath = (projectDir) => path.join(projectDir, 'qa', 'layer-imports.json');
const videoAssets = (projectDir) => {
  const dir = path.join(projectDir, 'assets', 'broll', 'video');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => !name.startsWith('.')) : [];
};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('import refuses a layer that never passed layer render, or failed it', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  const file = renderedLayer(projectDir);
  await assert.rejects(layerImport.run({ 'project-dir': projectDir, file }, quiet), /не проходил layer render/);
  renderReport(projectDir, { layerSha: sha256File(file), status: 'fail' });
  await assert.rejects(layerImport.run({ 'project-dir': projectDir, file }, quiet), /не прошёл проверки: qa\/layer-motion-v01-render-01\.json/);
  renderReport(projectDir, { layerSha: sha256File(file), error: 'ffmpeg упал' });
  await assert.rejects(layerImport.run({ 'project-dir': projectDir, file }, quiet), /не прошёл проверки: qa\/layer-motion-v01-render-01\.json.*ffmpeg упал/);
  assert.equal(fs.existsSync(registryPath(projectDir)), false);
  assert.deepEqual(videoAssets(projectDir), []);
});

test('a checked layer is imported through the official path and registered', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  const file = renderedLayer(projectDir);
  renderReport(projectDir, { layerSha: sha256File(file) });
  assert.equal(await layerImport.run({ 'project-dir': projectDir, file }, quiet), 0);
  const entry = findByReference(projectDir, JSON.parse(fs.readFileSync(registryPath(projectDir), 'utf8')).imports[0].reference);
  assert.equal(entry.layer, 'motion-v01');
  assert.match(entry.reference, /^assets\/broll\/video\/[^/]+\/media\.mp4$/);
  assert.equal(findByCanonical(projectDir, entry.canonicalSha256).renderSha256, sha256File(file));
  // Запись реестра: слой, номер и отчёт рендера, sha256 нормализованного рендера, ассет и его sha256, профиль, время.
  assert.equal(entry.render, 1);
  assert.equal(entry.renderReport, 'qa/layer-motion-v01-render-01.json');
  assert.equal(entry.renderFile, 'motion-v01/renders/layer-01.mp4');
  assert.equal(entry.profile, 'avatar');
  assert.equal(entry.assetId, entry.reference.split('/')[3]);
  assert.equal(entry.canonicalSha256, sha256File(path.join(projectDir, entry.reference)));
  assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
  assert.deepEqual(videoAssets(projectDir), [entry.assetId]);
});

test('importing the same render twice keeps one asset and one registry entry; warnings are fine', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t, { seconds: 2 });
  const file = renderedLayer(projectDir);
  renderReport(projectDir, { layerSha: sha256File(file), status: 'warn' });
  const logs = [];
  const log = (line) => logs.push(String(line));
  assert.equal(await layerImport.run({ 'project-dir': projectDir, file }, { log }), 0);
  const [first] = readRegistry(projectDir).imports;
  assert.equal(await layerImport.run({ 'project-dir': projectDir, file }, { log }), 0);
  const { imports } = readRegistry(projectDir);
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0], first);
  assert.deepEqual(videoAssets(projectDir), [first.assetId]);
  assert.ok(logs.some((line) => /уже импортирован/.test(line)), logs.join('\n'));
});

test('regression: the project source is never registered through the source input of a passing report', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, workspace } = makeLayerProject(t, { seconds: 2 });
  const sourcePath = path.join(projectDir, workspace.manifest.source.localPath);
  const file = renderedLayer(projectDir);
  // Настоящий отчёт layer render хранит sha256 исходника во входе role 'source': по нему исходник-аватар
  // выглядел бы «проверенным слоем kit».
  renderReport(projectDir, { layerSha: sha256File(file), sourceSha: sha256File(sourcePath) });
  await assert.rejects(layerImport.run({ 'project-dir': projectDir, file: sourcePath }, quiet), /не проходил layer render/);
  assert.equal(fs.existsSync(registryPath(projectDir)), false);
  assert.deepEqual(videoAssets(projectDir), []);
});

test('import refuses files outside the project, links and non-regular files', { skip: !hasFfmpeg }, async (t) => {
  const { root, projectDir } = makeLayerProject(t, { seconds: 2 });
  const file = renderedLayer(projectDir);
  renderReport(projectDir, { layerSha: sha256File(file) });
  const run = (target) => layerImport.run({ 'project-dir': projectDir, ...(target === undefined ? {} : { file: target }) }, quiet);

  await assert.rejects(run(), /нужен --file/);
  await assert.rejects(run(path.join(projectDir, 'motion-v01', 'renders', 'layer-09.mp4')), /файл не найден/);
  // Те же байты с проходящим отчётом, но вне папки проекта.
  const outside = path.join(root, 'outside.mp4');
  fs.copyFileSync(file, outside);
  await assert.rejects(run(outside), /вне проекта/);
  await assert.rejects(run(path.join(projectDir, 'motion-v01', 'renders')), /не обычный файл/);
  let linked = true;
  try {
    fs.symlinkSync(file, path.join(projectDir, 'motion-v01', 'renders', 'link.mp4'));
    fs.symlinkSync(root, path.join(projectDir, 'escape'), 'dir');
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    linked = false; // Windows без прав на ссылки
  }
  if (linked) {
    await assert.rejects(run(path.join(projectDir, 'motion-v01', 'renders', 'link.mp4')), /ссылка/);
    await assert.rejects(run(path.join(projectDir, 'escape', 'outside.mp4')), /вне проекта/);
  }
  assert.equal(fs.existsSync(registryPath(projectDir)), false);
  assert.deepEqual(videoAssets(projectDir), []);
});

test('findRenderReport matches only the layer input and takes the newest report', (t) => {
  const dir = tempDir(t);
  const layerSha = 'a'.repeat(64);
  const sourceSha = 'b'.repeat(64);
  assert.equal(findRenderReport(dir, layerSha), null, 'нет папки qa — нет отчёта');
  renderReport(dir, { n: 1, layerSha, sourceSha });
  assert.equal(findRenderReport(dir, sourceSha), null, 'исходник — вход role source, а не слой');
  assert.equal(findRenderReport(dir, 'm'.repeat(64)), null, 'манифест — не слой');
  writeJson(path.join(dir, 'qa', 'layer-motion-v01-render-02.json'), { kind: 'layer-render', layer: 'motion-v01', inputs: [{ sha256: sourceSha }], summary: { status: 'pass' }, error: null });
  assert.equal(findRenderReport(dir, sourceSha), null, 'вход без role не считается слоем');
  assert.equal(findRenderReport(dir, layerSha).fileName, 'layer-motion-v01-render-01.json');

  // Номер рендера может быть занят заново после дыры: свежесть решает createdAt, а не номер.
  const other = 'c'.repeat(64);
  renderReport(dir, { n: 3, layerSha: other, status: 'fail', createdAt: '2026-09-28T12:00:00.000Z' });
  renderReport(dir, { n: 4, layerSha: other, status: 'pass', createdAt: '2026-09-28T11:00:00.000Z' });
  const newest = findRenderReport(dir, other);
  assert.deepEqual([newest.fileName, newest.renderNumber, renderPassed(newest)], ['layer-motion-v01-render-03.json', 3, false]);

  // При равном createdAt — больший номер, числом: 100 новее 99, хотя строкой «100» < «99».
  const third = 'd'.repeat(64);
  renderReport(dir, { n: 99, layerSha: third, status: 'fail' });
  renderReport(dir, { n: 100, layerSha: third, status: 'pass' });
  assert.deepEqual([findRenderReport(dir, third).renderNumber, renderPassed(findRenderReport(dir, third))], [100, true]);

  fs.writeFileSync(path.join(dir, 'qa', 'layer-motion-v01-render-05.json'), '{');
  assert.throws(() => findRenderReport(dir, layerSha), /qa\/layer-motion-v01-render-05\.json: неверный JSON/);
});

test('renderPassed accepts pass and warn only', () => {
  assert.equal(renderPassed({ summary: { status: 'pass' }, error: null }), true);
  assert.equal(renderPassed({ summary: { status: 'warn' }, error: null }), true);
  assert.equal(renderPassed({ summary: { status: 'fail' }, error: null }), false);
  assert.equal(renderPassed({ summary: { status: 'error' }, error: 'x' }), false);
  assert.equal(renderPassed({ summary: { status: 'pass' }, error: 'x' }), false);
  assert.equal(renderPassed({ error: null }), false);
  assert.equal(renderPassed(null), false);
});

test('the registry keeps one entry per render, asset and reference', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readRegistry(dir), { version: 1, imports: [] });
  const entry = (render, canonical, reference) => ({ layer: 'motion-v01', renderSha256: render, canonicalSha256: canonical, reference });
  appendRegistry(dir, entry('r1', 'c1', 'assets/broll/video/1/media.mp4'));
  appendRegistry(dir, entry('r2', 'c2', 'assets/broll/video/2/media.mp4'));
  appendRegistry(dir, entry('r1', 'c3', 'assets/broll/video/3/media.mp4'));
  assert.deepEqual(readRegistry(dir).imports.map((e) => e.reference), ['assets/broll/video/2/media.mp4', 'assets/broll/video/3/media.mp4']);
  assert.equal(findByRender(dir, 'r1').canonicalSha256, 'c3');
  assert.equal(findByCanonical(dir, 'c1'), null);
  assert.equal(findByReference(dir, 'assets/broll/video/2/media.mp4').renderSha256, 'r2');
  fs.writeFileSync(registryPath(dir), '{"version":1}');
  assert.throws(() => readRegistry(dir), /qa\/layer-imports\.json: .*imports/);
});
