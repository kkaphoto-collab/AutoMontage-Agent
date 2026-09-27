const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { withMotionKitAlias, MOTION_KIT_ALIAS } = require('../scripts/remotion-webpack');
const { loadEsm } = require('./helpers/load-esm');

test('webpack config resolves @automontage/motion-kit to the engine kit directory', () => {
  const config = withMotionKitAlias({ resolve: { alias: { react: 'x' } }, module: { rules: [] } });
  assert.equal(MOTION_KIT_ALIAS, '@automontage/motion-kit');
  assert.equal(config.resolve.alias.react, 'x');
  assert.equal(config.resolve.alias[MOTION_KIT_ALIAS], path.join(__dirname, '..', 'src', 'motion-kit'));
});

test('kit core converts seconds to frames on the frame grid', () => {
  const { secToFrame, frameToSec } = loadEsm('src/motion-kit/core.js');
  assert.equal(secToFrame(1.5, 25), 38);
  assert.equal(secToFrame(0.04, 25), 1);
  assert.equal(frameToSec(50, 25), 2);
});
