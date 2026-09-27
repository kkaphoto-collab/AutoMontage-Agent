const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildLayerManifest, loadKitCore } = require('../scripts/motion-kit-node');

function writeLayer(dir, plan) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'layer.json'), JSON.stringify({ version: 1, composition: 'Layer', fps: 25, width: 1080,
    height: 1920, durationInFrames: 250, face: { x: 540, y: 787 }, profile: 'avatar', sfxMasterDb: -5, speaker: { src: 'speaker.mp4', lastFrame: 249 } }));
  fs.writeFileSync(path.join(dir, 'src/words.js'), 'export default [{"w":"Привет","t":"Привет","s":0.2,"e":0.6}];\n');
  fs.writeFileSync(path.join(dir, 'src/sfx-library.js'), 'export default {"sounds":{}};\n');
  fs.writeFileSync(path.join(dir, 'src/plan.js'), plan);
}

test('kit core loads in Node with the real Remotion math', () => {
  const kit = loadKitCore();
  assert.equal(typeof kit.compileLayer, 'function');
  assert.equal(kit.secToFrame(2, 25), 50);
});

test('a layer outside the engine folder compiles to a manifest from its plan', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-layer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLayer(dir, `import { autoShots } from '@automontage/motion-kit/core';
export default function buildPlan({ words, face, durationInFrames, fps }) {
  return { camera: { face, shots: autoShots(words, { endSec: durationInFrames / fps }) }, items: [] };
}\n`);
  const manifest = buildLayerManifest(dir);
  assert.equal(manifest.camera.s.length, 250);
  assert.equal(manifest.texts[0].id, 'caption-1');
});

test('broken layers explain what is missing or failing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-layer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => buildLayerManifest(dir), /нет layer\.json/);
  writeLayer(dir, 'export default function buildPlan() { return { camera: { shots: [] }, items: [] }; }\n');
  assert.throws(() => buildLayerManifest(dir), /camera\.face/);
  writeLayer(dir, 'export default function buildPlan( {\n');
  assert.throws(() => buildLayerManifest(dir), /не собирается plan\.js/);
});
