const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

const remotion = {
  AbsoluteFill: 'div',
  Sequence: 'div',
  Audio: 'audio',
  OffthreadVideo: ({ src, style }) => React.createElement('video', { src, style }),
  Img: ({ src, style }) => React.createElement('img', { src, style }),
  staticFile: (value) => value,
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ fps: 25, durationInFrames: 250, width: 1080, height: 1920 }),
  interpolate: () => 0,
  spring: () => 1,
};

function loadJsx(relativePath) {
  const filename = path.join(ROOT, relativePath);
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
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'remotion') return remotion;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const compiled = new Module(filename, module);
    compiled.filename = filename;
    compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(output, filename);
    return compiled.exports;
  } finally {
    Module._load = originalLoad;
  }
}

function renderScene(scene) {
  const { SceneDirector } = loadJsx('src/SceneDirector.jsx');
  const markup = renderToStaticMarkup(React.createElement(SceneDirector, {
    faceSrc: 'speaker-source.mp4',
    videoTitle: 'ЗАГОЛОВОК РОЛИКА',
    scenes: [{ start: 0, end: 4, ...scene }],
  }));
  return markup.replace(/<style>[\s\S]*?<\/style>/gu, '');
}

test('fullscreen shows the chip by default', () => {
  const markup = renderScene({ scene: 'fullscreen', caption: 'ПОДПИСЬ' });
  assert.match(markup, /ЗАГОЛОВОК РОЛИКА/);
});

test('hideChip removes the chip from fullscreen without touching anything else', () => {
  const markup = renderScene({ scene: 'fullscreen', caption: 'ПОДПИСЬ', hideChip: true });
  assert.doesNotMatch(markup, /ЗАГОЛОВОК РОЛИКА/);
  assert.match(markup, /ПОДПИСЬ/);
});

test('hideChip removes the chip from stat, bottom-diagram and default-overlay broll', () => {
  const stat = renderScene({
    scene: 'stat', hideChip: true, label: 'МЕТКА', statCream: '1', statOrange: 'X', headCream: 'A', headOrange: 'B',
  });
  assert.doesNotMatch(stat, /МЕТКА/);

  const diagram = renderScene({
    scene: 'bottom-diagram', hideChip: true, headCream: 'A', headOrange: 'B', steps: ['шаг'],
  });
  assert.doesNotMatch(diagram, /ЗАГОЛОВОК РОЛИКА/);

  const broll = renderScene({
    scene: 'broll',
    hideChip: true,
    headCream: 'A',
    headOrange: 'B',
    brollMedia: {
      kind: 'image', src: 'render-assets/still.webp', sha256: 'b'.repeat(64), fit: 'cover',
    },
  });
  assert.doesNotMatch(broll, /ЗАГОЛОВОК РОЛИКА/);
});
