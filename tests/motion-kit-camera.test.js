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

test('punch rises within six frames, holds until `until`, and never exceeds maxScale', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W', drift: 'none' }],
    punches: [{ at: 1, until: 3, k: 1.15 }] }, cfg);
  assert.equal(kit.cameraAt(track, 24).s, 1);
  assert.ok(kit.cameraAt(track, 31).s >= 1.08);
  assert.ok(Math.abs(kit.cameraAt(track, 70).s - 1.15) < 0.01);
  assert.ok(Math.abs(kit.cameraAt(track, 90).s - 1) < 1e-6);
  const capped = kit.compileCamera({ face, shots: [{ at: 0, preset: 'M', drift: 'none' }], punches: [{ at: 0, until: 5, k: 1.15 }] }, cfg);
  const c = kit.cameraAt(capped, 20);
  assert.equal(c.s, 1.25);
  assert.ok(c.requested > 1.3);
});

test('blur from 0 starts sharp-free, ramps out, and dims the speaker', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }], blurs: [{ from: 0, to: 1, px: 24 }] }, cfg);
  assert.equal(kit.cameraAt(track, 0).blur, 24);
  assert.ok(Math.abs(kit.cameraAt(track, 0).dim - 0.72) < 1e-9);
  assert.equal(kit.cameraAt(track, 40).blur, 0);
});

test('away hides the speaker after the enter ramp and brings it back', () => {
  const track = kit.withAways(kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }] }, cfg), [{ from: 50, to: 100 }]);
  assert.equal(kit.cameraAt(track, 49).visible, true);
  assert.equal(kit.cameraAt(track, 60).visible, false);
  assert.equal(kit.cameraAt(track, 115).visible, true);
  assert.equal(kit.cameraAt(track, 60).s <= 1.25, true);
});

test('autoShots cuts on word ends, keeps every shot within 2.2 s and alternates presets', () => {
  const words = Array.from({ length: 40 }, (_, i) => ({ w: `слово${i}`, t: i % 7 === 6 ? `слово${i}.` : `слово${i}`, s: i * 0.5, e: i * 0.5 + 0.4 }));
  const shots = kit.autoShots(words, { endSec: 20.8 });
  assert.equal(shots[0].at, 0);
  const bounds = [...shots.map((s) => s.at), 20.8];
  for (let i = 1; i < bounds.length; i += 1) assert.ok(bounds[i] - bounds[i - 1] <= 2.2 + 1e-9, `shot ${i} ${bounds[i] - bounds[i - 1]}`);
  for (const shot of shots.slice(1)) assert.ok(words.some((w) => Math.abs(w.e - shot.at) < 1e-9));
  assert.deepEqual(shots.slice(0, 6).map((s) => s.preset), ['W', 'M', 'W', 'L', 'W', 'R']);
  assert.ok(shots.every((s) => s.drift === (s.preset === 'W' ? 'in' : 'out')));
});
