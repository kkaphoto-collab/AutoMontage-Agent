const React = require('react');
const real = require('remotion');

// Реальные spring/interpolate/Easing + подмена хуков и медиа-компонентов на простую разметку.
function remotionStub({ frame = 0, fps = 25, width = 1080, height = 1920, calls = {} } = {}) {
  const box = (tag) => ({ children, style, ...rest }) => React.createElement(tag, { style, ...rest }, children);
  return {
    ...real,
    useCurrentFrame: () => frame,
    useVideoConfig: () => ({ fps, width, height, durationInFrames: 100000 }),
    AbsoluteFill: box('div'),
    Sequence: ({ children, from, durationInFrames }) => React.createElement('div', { 'data-sequence-from': from, 'data-sequence-duration': durationInFrames }, children),
    Freeze: ({ children, frame: at }) => React.createElement('div', { 'data-freeze': at }, children),
    OffthreadVideo: (props) => React.createElement('video', { src: props.src, muted: props.muted, 'data-trim-before': props.trimBefore }),
    Audio: (props) => React.createElement('audio', { src: props.src, 'data-volume': typeof props.volume === 'function' ? props.volume(0).toFixed(4) : props.volume }),
    Img: (props) => React.createElement('img', { src: props.src, style: props.style }),
    staticFile: (src) => `/static/${src}`,
    delayRender: () => { calls.delay = (calls.delay || 0) + 1; return 7; },
    continueRender: () => { calls.continue = (calls.continue || 0) + 1; },
    cancelRender: (error) => { calls.cancel = error; },
  };
}

const render = (element) => require('react-dom/server').renderToStaticMarkup(element);

module.exports = { remotionStub, render };
