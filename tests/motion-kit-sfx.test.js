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

// Ревью: 5) границы 0 ≤ hitFrame < durationInFrames — лид звука мог утащить start в минус, но
// сам hitFrame оставался как задан; звук целиком за пределами композиции (в обе стороны) должен
// исчезать, а не оставаться в списке с отрицательным или запредельным hitFrame.
test('a lead longer than the time since element start clamps startFrame to 0 but keeps hitFrame', () => {
  const [cue] = kit.sfxFromItems([{ from: 5, sfx: 'whoosh-in' }], [], opts);
  assert.deepEqual([cue.startFrame, cue.hitFrame], [0, 5]);
});

test('cues entirely outside [0, durationInFrames) are dropped, not clamped into range', () => {
  assert.deepEqual(kit.sfxFromItems([], [{ at: -1, name: 'pop' }], opts), []);
  assert.deepEqual(kit.sfxFromItems([], [{ at: 25, name: 'pop' }], opts), []); // durationInFrames=500=20s
  assert.deepEqual(kit.sfxFromItems([{ from: 505, sfx: 'whoosh-in' }], [], opts), []);
});

// 6) leadFrames — в кадрах эталона 25 fps, как и остальные длительности kit (ref25), а не в кадрах
// композиции: иначе один и тот же plan.js звучит на разных fps по-разному.
test('leadFrames is interpreted as 25-fps reference frames, not raw composition frames', () => {
  const at25 = kit.sfxFromItems([{ from: 100, sfx: { name: 'whoosh-in', leadFrames: 10 } }], [], opts);
  const at50 = kit.sfxFromItems([{ from: 100, sfx: { name: 'whoosh-in', leadFrames: 10 } }], [], { ...opts, fps: 50 });
  assert.equal((at25[0].hitFrame - at25[0].startFrame) / 25, 0.4);
  assert.equal((at50[0].hitFrame - at50[0].startFrame) / 50, 0.4);
  const zero = kit.sfxFromItems([{ from: 100, sfx: { name: 'whoosh-in', leadFrames: 0 } }], [], opts);
  assert.equal(zero[0].startFrame, zero[0].hitFrame, 'leadFrames:0 must not get a minimum of 1');
});

// 7) id должны быть уникальны — иначе React-ключи в SfxTrack дублируются.
test('cue ids stay unique even when two typing beds start on the same frame', () => {
  const cues = kit.sfxFromItems([
    { from: 50, typeFrom: 50, typeTo: 80 }, { from: 50, typeFrom: 50, typeTo: 90 },
  ], [], opts);
  assert.equal(cues.length, 2);
  assert.equal(new Set(cues.map((c) => c.id)).size, 2);
});

// 8) неявная подложка набора текста (никто явно не просил typeSfx) молча пропускается, если в
// библиотеке нет ни typing, ни typing-long — это обычный ролик без такого звука в паке; но явный
// type.sfx на несуществующий звук — это ошибка автора plan.js, и она должна бросаться, как раньше.
test('an implicit typing bed is skipped when the library has no typing sound, but an explicit one still throws', () => {
  const empty = { fps: 25, library: { sounds: {} }, durationInFrames: 500 };
  assert.deepEqual(kit.sfxFromItems([{ from: 10, typeFrom: 10, typeTo: 40 }], [], empty), []);
  assert.deepEqual(kit.sfxFromItems([{ from: 10, typeFrom: 10, typeTo: 40 }], [], { fps: 25, durationInFrames: 500 }), []);
  assert.throws(
    () => kit.sfxFromItems([{ from: 10, typeFrom: 10, typeTo: 40, typeSfx: 'typing' }], [], empty),
    /звук «typing» не найден/,
  );
});
