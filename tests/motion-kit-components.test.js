const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { loadEsm } = require('./helpers/load-esm');
const { remotionStub, render } = require('./helpers/remotion-stub');

const kitAt = (frame, calls = {}) => loadEsm('src/motion-kit/index.js', { stubs: { remotion: remotionStub({ frame, calls }) } });
const item = (over = {}) => ({ id: 'title', kind: 'text', from: 10, until: 60, box: { x: 90, y: 300, w: 840, h: 200 },
  rot: 0, enter: { kind: 'fly' }, exit: { frames: 5, dir: 'down' }, life: {}, ...over });

test('KitBox places text at its box, marks it for safe-zone checks and hides outside its window', () => {
  const kit = kitAt(30);
  const html = render(React.createElement(kit.KitBox, { item: item() }, 'Текст'));
  assert.match(html, /data-kit-text="title"/);
  assert.match(html, /left:90px;top:300px;width:840px;height:200px/);
  assert.match(html, /transform:translate\(/);
  assert.equal(render(React.createElement(kitAt(5).KitBox, { item: item() }, 'Текст')), '');
  assert.doesNotMatch(render(React.createElement(kit.KitBox, { item: item({ kind: 'media' }) }, 'x')), /data-kit-text/);
});
