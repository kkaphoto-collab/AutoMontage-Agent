const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadScenes() {
  const filename = path.join(ROOT, 'src/scenes/scenes.jsx');
  const output = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'remotion', '@remotion/layout-utils'],
    logLevel: 'silent',
  }).outputFiles[0].text;
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(output, filename);
  return compiled.exports;
}

test('a long single-token blur-overlay word shrinks to stay within the safe width', () => {
  const { getBlurBigFontSize } = loadScenes();

  assert.equal(typeof getBlurBigFontSize, 'function');
  // 1080x1920 safe width (SAFE_9x16: left 70, right 130) is 880px.
  const portraitWidth = 880;
  for (const text of ['ЯСНОСТЬ', 'ГЛУБИНУ']) {
    const size = getBlurBigFontSize(text, portraitWidth, false);
    assert.ok(size < 360, `${text}: must shrink below the portrait max of 360`);
    assert.ok(size * text.length * 0.48 <= portraitWidth + 1, `${text}: must fit the safe width`);
  }
});

test('short blur-overlay text keeps the existing 240/360 max', () => {
  const { getBlurBigFontSize } = loadScenes();

  assert.equal(getBlurBigFontSize('4', 880, false), 360);
  assert.equal(getBlurBigFontSize('4', 1760, true), 240);
});
