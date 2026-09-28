const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadKitCore } = require('../motion-kit-node');
const { readProjectManifest, resolveProjectPath } = require('../project/workspace');

const LAYER_NAME = /^motion-v\d{2,3}$/u;

function projectFrom(options) {
  if (!options['project-dir']) throw new Error('нужен --project-dir');
  const projectDir = path.resolve(options['project-dir']);
  const manifest = readProjectManifest(projectDir);
  const sourcePath = resolveProjectPath(projectDir, manifest.source.localPath, { label: 'manifest.source.localPath', mustExist: true, type: 'file' });
  return { projectDir, manifest, sourcePath };
}

function resolveLayer(options) {
  const project = projectFrom(options);
  if (!LAYER_NAME.test(options.layer || '')) throw new Error('--layer должен быть вида motion-v01');
  const layerDir = resolveProjectPath(project.projectDir, options.layer, { label: 'layer', mustExist: true, type: 'directory' });
  return { ...project, layerName: options.layer, layerDir };
}

function nextLayerName(projectDir) {
  let n = 1;
  while (fs.existsSync(path.join(projectDir, `motion-v${String(n).padStart(2, '0')}`))) n += 1;
  return `motion-v${String(n).padStart(2, '0')}`;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Неверный sfxMasterDb ловится при чтении, а не на рендере: та же проверка, что в SfxTrack.
function readLayerJson(layerDir) {
  const layer = readJson(path.join(layerDir, 'layer.json'));
  loadKitCore().assertMasterDb(layer.sfxMasterDb);
  return layer;
}
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const relative = (projectDir, file) => path.relative(projectDir, file).split(path.sep).join('/');

module.exports = { LAYER_NAME, nextLayerName, projectFrom, readJson, readLayerJson, relative, resolveLayer, sha256File, writeJson };
