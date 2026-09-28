const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('../scripts/layer/cli');
const { nextLayerName, readLayerJson, relative, resolveLayer } = require('../scripts/layer/common');
const { createOrOpenProject } = require('../scripts/project/workspace');

const cli = path.resolve(__dirname, '../scripts/cli.js');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

function makeProjectFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.mp4');
  fs.writeFileSync(sourcePath, 'video');
  const workspace = createOrOpenProject({
    baseDir: path.join(dir, 'projects'),
    name: 'Layer CLI fixture',
    sourcePath,
    now: new Date('2026-09-01T00:00:00Z'),
  });
  return { dir, projectDir: workspace.dir };
}

test('public CLI advertises layer commands and routes them to their own script', () => {
  const help = run('--help');
  for (const line of ['automontage layer new --project-dir', 'automontage layer check', 'automontage layer render', 'automontage layer import', 'automontage layer brief']) {
    assert.match(help.stdout, new RegExp(line));
  }
  const usage = run('layer');
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: automontage layer new\|words\|check\|render\|import\|brief\|stock\|sheet/);
  assert.doesNotMatch(usage.stderr, /build\.js|ENOENT/);
  const unknown = run('layer', 'bogus');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /неизвестная команда layer bogus/);
  assert.equal(run('layer', '--help').status, 0);
});

test('layer flags are strict: unknown, repeated and valueless flags fail', () => {
  const flags = { 'project-dir': 'value', wait: 'bool' };
  assert.deepEqual(parseArgs(['--project-dir', 'p', '--wait'], flags), { 'project-dir': 'p', wait: true });
  assert.throws(() => parseArgs(['--nope', '1'], flags), /неизвестный флаг --nope/);
  assert.throws(() => parseArgs(['--project-dir', 'a', '--project-dir', 'b'], flags), /повторяется/);
  assert.throws(() => parseArgs(['--project-dir', '--wait'], flags), /требует значение/);
  assert.throws(() => parseArgs(['stray'], flags), /лишний аргумент «stray»/);
});

test('readLayerJson validates sfxMasterDb the same way SfxTrack does', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const layerDir = path.join(dir, 'motion-v01');
  fs.mkdirSync(layerDir, { recursive: true });
  const writeLayer = (value, { omit = false } = {}) => {
    const layer = { version: 1, composition: 'motion-v01', fps: 25, width: 1080, height: 1920 };
    if (!omit) layer.sfxMasterDb = value;
    fs.writeFileSync(path.join(layerDir, 'layer.json'), JSON.stringify(layer));
  };

  writeLayer(3);
  assert.throws(() => readLayerJson(layerDir), /layer\.json/);
  assert.throws(() => readLayerJson(layerDir), /sfxMasterDb/);

  writeLayer(null);
  assert.throws(() => readLayerJson(layerDir), /layer\.json/);
  assert.throws(() => readLayerJson(layerDir), /sfxMasterDb/);

  writeLayer(undefined, { omit: true });
  assert.throws(() => readLayerJson(layerDir), /layer\.json/);
  assert.throws(() => readLayerJson(layerDir), /sfxMasterDb/);

  writeLayer(-5);
  const layer = readLayerJson(layerDir);
  assert.equal(layer.sfxMasterDb, -5);
  assert.equal(layer.composition, 'motion-v01');
});

test('resolveLayer accepts a real layer directory and rejects bad names, including traversal-shaped ones', (t) => {
  const { projectDir } = makeProjectFixture(t);
  fs.mkdirSync(path.join(projectDir, 'motion-v01'));

  const resolved = resolveLayer({ 'project-dir': projectDir, layer: 'motion-v01' });
  assert.equal(resolved.layerName, 'motion-v01');
  assert.equal(resolved.layerDir, path.join(projectDir, 'motion-v01'));
  assert.equal(resolved.projectDir, projectDir);

  assert.throws(
    () => resolveLayer({ 'project-dir': projectDir, layer: 'foo' }),
    /--layer должен быть вида motion-v01/,
  );
  assert.throws(
    () => resolveLayer({ 'project-dir': projectDir, layer: 'motion-v1' }),
    /--layer должен быть вида motion-v01/,
  );
  // Путь вида «../x» не совпадает с motion-vNN и отклоняется раньше, чем дошёл бы до файловой
  // системы — resolveProjectPath (вторая линия защиты от выхода за пределы проекта) не вызывается.
  assert.throws(
    () => resolveLayer({ 'project-dir': projectDir, layer: '../x' }),
    /--layer должен быть вида motion-v01/,
  );
  assert.throws(
    () => resolveLayer({ 'project-dir': projectDir, layer: '../motion-v01' }),
    /--layer должен быть вида motion-v01/,
  );
  // Имя формально проходит шаблон, но такой папки в проекте нет — вторая линия защиты
  // (resolveProjectPath) не даёт использовать несуществующий или чужой путь молча.
  assert.throws(
    () => resolveLayer({ 'project-dir': projectDir, layer: 'motion-v99' }),
    /does not exist/,
  );
});

test('nextLayerName picks the next free number and fills gaps', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-next-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(nextLayerName(dir), 'motion-v01');
  fs.mkdirSync(path.join(dir, 'motion-v01'));
  assert.equal(nextLayerName(dir), 'motion-v02');
  fs.mkdirSync(path.join(dir, 'motion-v03'));
  // v02 остаётся свободным между v01 и v03 — следующее имя заполняет дыру, а не идёт за максимум.
  assert.equal(nextLayerName(dir), 'motion-v02');
  fs.mkdirSync(path.join(dir, 'motion-v02'));
  assert.equal(nextLayerName(dir), 'motion-v04');
});

test('relative uses forward slashes for a nested layer path', () => {
  const projectDir = path.join('a', 'b', 'project');
  const file = path.join(projectDir, 'motion-v01', 'out', 'manifest.json');
  assert.equal(relative(projectDir, file), 'motion-v01/out/manifest.json');
});
