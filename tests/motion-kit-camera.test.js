const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');
const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250 };
const face = { x: 540, y: 787 };

test('compileCamera converts shots to frames and closes each shot at the next one', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'M', drift: 'out' }] }, cfg);
  assert.deepEqual(track.shots.map((s) => [s.from, s.to, s.preset, s.drift]), [[0, 50, 'W', 'in'], [50, 250, 'M', 'out']]);
});

test('compileCamera rejects a missing face, an unknown preset and a late first shot', () => {
  assert.throws(() => kit.compileCamera({ shots: [{ at: 0, preset: 'W' }] }, cfg), /camera\.face/);
  assert.throws(() => kit.compileCamera({ face, shots: [{ at: 0, preset: 'XL' }] }, cfg), /неизвестный пресет «XL»/);
  assert.throws(() => kit.compileCamera({ face, shots: [{ at: 1, preset: 'W' }] }, cfg), /первый план/);
});

test('drift grows W slowly and a W→M cut is a visible jump', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'M', drift: 'out' }] }, cfg);
  const start = kit.cameraAt(track, 0);
  const beforeCut = kit.cameraAt(track, 49);
  const afterCut = kit.cameraAt(track, 50);
  assert.equal(start.s, 1);
  assert.ok(beforeCut.s > 1.01 && beforeCut.s <= 1.05 + 1e-9);
  assert.ok(afterCut.s / beforeCut.s >= 1.15, `jump ${afterCut.s / beforeCut.s}`);
  assert.ok(Math.abs(kit.cameraAt(track, 1).s - start.s) < 0.002, 'drift must not jump between frames');
});

test('without fill the speaker never reveals the frame edge', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W', dx: 300 }] }, cfg);
  for (const frame of [0, 40, 120, 249]) {
    const c = kit.cameraAt(track, frame);
    assert.ok(c.dx <= (c.s - 1) * face.x + 1e-9);
    assert.ok(c.dx >= -(c.s - 1) * (1080 - face.x) - 1e-9);
  }
});

test('side presets shift the face by at least 85 px and use a fill layer', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'L' }] }, cfg);
  const w = kit.cameraAt(track, 49);
  const l = kit.cameraAt(track, 50);
  assert.equal(l.fill, true);
  assert.ok(Math.abs(l.dx - w.dx) >= 85);
});
