const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');
const library = { sounds: {
  'whoosh-in': { file: 'sfx/whoosh-in.wav', lengthSec: 1.2, peakSec: 0.4 },
  'pop-cluster': { file: 'sfx/pop-cluster.wav', lengthSec: 0.5, peakSec: 0.02 },
  typing: { file: 'sfx/typing.wav', lengthSec: 2.8, peakSec: 0.05 },
  'typing-long': { file: 'sfx/typing-long.wav', lengthSec: 12, peakSec: 0.05 },
  'click-soft': { file: 'sfx/click-soft.wav', lengthSec: 0.2, peakSec: 0.01, volume: 0.8 },
} };
const opts = { fps: 25, library, durationInFrames: 500 };

test('a whoosh starts early so its peak lands on the element entrance', () => {
  const [cue] = kit.sfxFromItems([{ from: 100, sfx: 'whoosh-in' }], [], opts);
  assert.deepEqual([cue.startFrame, cue.hitFrame, cue.notable, cue.role], [90, 100, true, 'whoosh']);
});

test('roles resolve to library files and volumes follow spec > library > role', () => {
  const cues = kit.sfxFromItems([
    { from: 10, sfx: 'pop' }, { from: 40, sfx: { name: 'click-soft' } }, { from: 80, sfx: { name: 'click-soft', vol: 0.4 } },
  ], [], opts);
  assert.equal(cues[0].name, 'pop-cluster');
  assert.equal(cues[0].vol, 0.55);
  assert.equal(cues[1].vol, 0.8);
  assert.equal(cues[2].vol, 0.4);
  assert.throws(() => kit.sfxFromItems([{ from: 1, sfx: 'boom' }], [], opts), /звук «boom» не найден/);
});

test('typing is a bed that lasts as long as the text types and picks the long loop when needed', () => {
  const [cue] = kit.sfxFromItems([{ from: 50, typeFrom: 50, typeTo: 150 }], [], opts);
  assert.deepEqual([cue.name, cue.durationFrames, cue.bed], ['typing-long', 100, true]);
});

test('thinning keeps one notable sound per second and 0.3 s between any sounds', () => {
  const cues = kit.sfxFromItems([
    { from: 100, sfx: 'whoosh-in' }, { from: 110, sfx: 'whoosh-in' }, { from: 104, sfx: 'pop' },
    { from: 100, typeFrom: 100, typeTo: 140 },
  ], [], opts);
  const { kept, dropped } = kit.thinCues(cues, { fps: 25 });
  assert.deepEqual(kept.map((c) => c.name).sort(), ['typing', 'whoosh-in']);
  assert.deepEqual(dropped.map((d) => d.reason).sort(), ['min-gap', 'notable-gap']);
});

test('pickSound returns a role only when the library has it', () => {
  assert.equal(kit.pickSound(library, 'whoosh'), 'whoosh');
  assert.equal(kit.pickSound({ sounds: {} }, 'whoosh'), null);
});

// Граничные случаи сверх плана: пустые items/extra не должны падать (ролик без звуков —
// обычный случай), thinCues на пустом списке тоже, а явный typeSfx:null должен молча
// выключать бед набора текста, а не пытаться резолвить несуществующий звук.
test('empty items and extra sfx lists compile and thin without throwing', () => {
  assert.deepEqual(kit.sfxFromItems([], [], opts), []);
  assert.deepEqual(kit.thinCues([], { fps: 25 }), { kept: [], dropped: [] });
});

test('an explicit typeSfx: null suppresses the typing bed', () => {
  const cues = kit.sfxFromItems([{ from: 50, typeFrom: 50, typeTo: 150, typeSfx: null }], [], opts);
  assert.deepEqual(cues, []);
});
