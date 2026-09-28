const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');
const { safeRect: cjsSafeRect, overflow: cjsOverflow } = require('../scripts/qa/safe-rect');

const kit = loadEsm('src/motion-kit/core.js');

test('portrait safe rect equals the owner rule 70/130/250/420 on 1080x1920', () => {
  assert.deepEqual(kit.safeRect(1080, 1920), { left: 70, top: 250, right: 950, bottom: 1500 });
  assert.deepEqual(kit.safeRect(720, 1280), { left: 70 * 720 / 1080, top: 250 * 720 / 1080, right: 720 - 130 * 720 / 1080, bottom: 1280 - 420 * 720 / 1080 });
});

test('node and kit safe rects stay identical', () => {
  for (const [w, h] of [[1080, 1920], [720, 1280], [1920, 1080]]) {
    assert.deepEqual(cjsSafeRect(w, h), kit.safeRect(w, h));
  }
});

test('overflow reports only the sides that leave the safe rect', () => {
  const safe = kit.safeRect(1080, 1920);
  assert.equal(kit.overflow({ left: 90, top: 300, right: 900, bottom: 400 }, safe), null);
  assert.deepEqual(kit.overflow({ left: 40, top: 300, right: 980, bottom: 400 }, safe), { left: 30, right: 30 });
  assert.deepEqual(cjsOverflow({ left: 40, top: 300, right: 980, bottom: 400 }, safe), { left: 30, right: 30 });
});

// Ревью задачи 23 (важно): дефолтный epsilon (0,5 px) пристёгнут с обеих сторон в обеих версиях
// (ESM kit.overflow и CommonJS-двойник) — 0,4 px ниже эпсилона (шум округления) не считается
// выходом, 0,6 px уже считается.
test('the default 0.5 px epsilon is exact on both the ESM and CommonJS overflow twins', () => {
  const safe = kit.safeRect(1080, 1920);
  const rect = (overPx) => ({ left: safe.left - overPx, top: 300, right: 900, bottom: 400 });
  assert.equal(kit.overflow(rect(0.4), safe), null);
  assert.equal(cjsOverflow(rect(0.4), safe), null);
  assert.deepEqual(kit.overflow(rect(0.6), safe), { left: 1 });
  assert.deepEqual(cjsOverflow(rect(0.6), safe), { left: 1 });
});
