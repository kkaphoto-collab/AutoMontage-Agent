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

const DEFAULT_OVERLAY = {
  mediaFilter: 'brightness(0.85)',
  bottomGradient: true,
  chip: true,
  textBlock: true,
  speakerPip: true,
};
const CLEAN_OVERLAY = {
  mediaFilter: null,
  bottomGradient: false,
  chip: false,
  textBlock: false,
  speakerPip: false,
};

function makeMedia(kind, overlay) {
  const media = kind === 'video'
    ? {
      kind: 'video',
      src: 'render-assets/motion-layer.mp4',
      sha256: 'a'.repeat(64),
      trimStartSec: 0,
      fit: 'cover',
      audioMode: 'mute',
    }
    : { kind: 'image', src: 'render-assets/still.webp', sha256: 'b'.repeat(64), fit: 'cover' };
  return overlay === undefined ? media : { ...media, overlay };
}

function renderBrollScene(media) {
  const { SceneDirector } = loadJsx('src/SceneDirector.jsx');
  const markup = renderToStaticMarkup(React.createElement(SceneDirector, {
    faceSrc: 'speaker-source.mp4',
    videoTitle: 'ЗАГОЛОВОК РОЛИКА',
    scenes: [{
      scene: 'broll',
      start: 0,
      end: 4,
      headCream: 'ЧИСТЫЙ',
      headOrange: 'СЛОЙ',
      sub: 'Подпись под заголовком',
      brollMedia: media,
    }],
  }));
  // Инлайн-шрифты не относятся к проверяемому оформлению сцены.
  return markup.replace(/<style>[\s\S]*?<\/style>/gu, '');
}

test('overlay helper keeps the default engine chrome unless a clean layer is requested', () => {
  const { brollOverlayPresentation } = loadJsx('src/scenes/BrollMedia.jsx');

  assert.equal(typeof brollOverlayPresentation, 'function');
  for (const media of [undefined, null, makeMedia('image'), makeMedia('video'),
    makeMedia('video', 'default'), makeMedia('image', 'default')]) {
    assert.deepEqual(brollOverlayPresentation(media), DEFAULT_OVERLAY, JSON.stringify(media));
  }
  assert.deepEqual(brollOverlayPresentation(makeMedia('video', 'none')), CLEAN_OVERLAY);
  assert.deepEqual(brollOverlayPresentation(makeMedia('image', 'none')), CLEAN_OVERLAY);
  // Неизвестное значение отсекает валидатор; renderer на всякий случай остаётся прежним.
  assert.deepEqual(brollOverlayPresentation(makeMedia('video', 'clean')), DEFAULT_OVERLAY);
});

test('default b-roll media keeps the exact darkened style object', () => {
  const { BrollMedia } = loadJsx('src/scenes/BrollMedia.jsx');
  const expected = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    objectPosition: '50% 40%',
    filter: 'brightness(0.85)',
  };

  for (const element of [
    BrollMedia({ legacySrc: 'broll/legacy.png', durationInFrames: 50 }),
    BrollMedia({ media: makeMedia('image'), durationInFrames: 50 }),
    BrollMedia({ media: makeMedia('video'), durationInFrames: 50 }),
    BrollMedia({ media: makeMedia('video', 'default'), durationInFrames: 50 }),
  ]) {
    assert.deepEqual(element.props.style, expected);
    assert.deepEqual(Object.keys(element.props.style), Object.keys(expected));
  }
});

test('clean b-roll media is shown without the brightness filter', () => {
  const { BrollMedia } = loadJsx('src/scenes/BrollMedia.jsx');

  for (const kind of ['image', 'video']) {
    const element = BrollMedia({ media: makeMedia(kind, 'none'), durationInFrames: 50 });
    assert.deepEqual(element.props.style, {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      objectPosition: '50% 40%',
    });
    assert.equal(Object.hasOwn(element.props.style, 'filter'), false);
  }
});

test('default broll scene still draws gradient, chip, heading, subtitle and speaker window', () => {
  const absent = renderBrollScene(makeMedia('video'));
  const explicit = renderBrollScene(makeMedia('video', 'default'));

  assert.equal(explicit, absent);
  assert.match(absent, /src="render-assets\/motion-layer\.mp4"/u);
  assert.match(absent, /filter:brightness\(0\.85\)/u);
  assert.match(absent, /linear-gradient\(180deg, transparent 45%, rgba\(0,0,0,\.8\)\)/u);
  assert.match(absent, /▸_ ЗАГОЛОВОК РОЛИКА/u);
  assert.match(absent, /ЧИСТЫЙ/u);
  assert.match(absent, /СЛОЙ/u);
  assert.match(absent, /Подпись под заголовком/u);
  assert.match(absent, /src="speaker-source\.mp4"/u);
});

test('clean broll scene shows only the media exactly as rendered', () => {
  for (const kind of ['image', 'video']) {
    const media = makeMedia(kind, 'none');
    const markup = renderBrollScene(media);

    assert.match(markup, new RegExp(`src="${media.src.replace('.', '\\.')}"`, 'u'));
    assert.doesNotMatch(markup, /brightness\(0\.85\)/u);
    assert.doesNotMatch(markup, /linear-gradient\(180deg, transparent 45%/u);
    assert.doesNotMatch(markup, /ЗАГОЛОВОК РОЛИКА|▸_/u);
    assert.doesNotMatch(markup, /ЧИСТЫЙ|СЛОЙ|Подпись под заголовком/u);
    assert.doesNotMatch(markup, /speaker-source\.mp4/u);
  }
});
