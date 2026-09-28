const test = require('node:test');
const assert = require('node:assert/strict');
const { getProfile } = require('../scripts/qa/profiles');
const { detectCameraEvents, gateRhythm, gateWeakCuts } = require('../scripts/qa/timeline-gates');
const { cutsEvery, manifestFixture } = require('./helpers/manifest-fixtures');

const avatar = getProfile('avatar');

test('BAD CASE: a static 5 s speaker plan stops the layer', () => {
  const m = manifestFixture({ camera: (f) => ({ s: f < 125 ? 1 : (Math.floor((f - 125) / 50) % 2 ? 1 : 1.18) }) });
  const g = gateRhythm(m, avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 5);
  assert.deepEqual([g.spans[0].fromSec, g.spans[0].toSec], [0, 5]);
});

test('a cut every 2 s passes, and slow drift alone is not an event', () => {
  assert.equal(gateRhythm(manifestFixture({ camera: cutsEvery(2) }), avatar).status, 'pass');
  const drift = manifestFixture({ camera: (f) => ({ s: 1 + 0.06 * (f / 250), dx: 22 * Math.sin(f / 38) }) });
  assert.equal(gateRhythm(drift, avatar).value, 10);
});

test('punch-ins, focus changes and speaker away windows split plans', () => {
  const punch = manifestFixture({ seconds: 4, camera: (f) => ({ s: f < 50 ? 1 : 1 + 0.15 * Math.min(1, (f - 50) / 5) }) });
  assert.deepEqual(detectCameraEvents(punch.camera, avatar.camera).events.map((e) => e.kind), ['punch']);
  const blur = manifestFixture({ seconds: 4, camera: (f) => ({ s: 1, blur: f >= 50 && f < 75 ? 20 : 0 }) });
  assert.equal(gateRhythm(blur, avatar).value, 2);
  const away = manifestFixture({ seconds: 6, camera: (f) => ({ s: 1, opacity: f >= 50 && f < 100 ? 0 : 1 }) });
  assert.equal(gateRhythm(away, avatar).value, 2);
});

test('a 2.3 s plan warns, and a 6 % cut is a weak cut that does not reset the plan', () => {
  assert.equal(gateRhythm(manifestFixture({ seconds: 6.9, camera: cutsEvery(2.3) }), avatar).status, 'warn');
  const weak = manifestFixture({ seconds: 4, camera: (f) => ({ s: f < 60 ? 1 : 1.08 }) });
  assert.equal(gateWeakCuts(weak, avatar).status, 'warn');
  assert.equal(gateRhythm(weak, avatar).value, 4);
});

test('the plan after a cover insert starts when the insert begins to close, not at its end', () => {
  const { speakerPlans } = require('../scripts/qa/timeline-gates');
  const kit = require('../scripts/motion-kit-node').loadKitCore();
  const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 150, words: [], sfxLibrary: { sounds: {} } };
  const m = kit.buildManifest(kit.compileLayer({ captions: false, items: [],
    camera: { face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W', drift: 'none' }] },
    inserts: [{ kind: 'stock', from: 2, to: 4, src: 'stock/a.mp4' }] }, cfg));
  const plans = speakerPlans(m.camera, detectCameraEvents(m.camera, avatar.camera), 25);
  assert.ok(plans.some((plan) => plan.from === 94), JSON.stringify(plans));
});
