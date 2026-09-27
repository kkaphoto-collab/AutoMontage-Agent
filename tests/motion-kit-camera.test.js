const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');
const cfg = { fps: 25, width: 1080, height: 1920, durationInFrames: 250 };
const face = { x: 540, y: 787 };

test('compileCamera converts shots to frames and closes each shot at the next one', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'M', drift: 'out' }] }, cfg);
  assert.deepEqual(track.shots.map((s) => [s.from, s.to, s.preset, s.drift]), [[0, 50, 'W', 'in'], [50, 250, 'M', 'out']]);
});

test('compileCamera rejects a missing face, an unknown preset and a late first shot', () => {
  assert.throws(() => kit.compileCamera({ shots: [{ at: 0, preset: 'W' }] }, cfg), /camera\.face/);
  assert.throws(() => kit.compileCamera({ face, shots: [{ at: 0, preset: 'XL' }] }, cfg), /неизвестный пресет «XL»/);
  assert.throws(() => kit.compileCamera({ face, shots: [{ at: 1, preset: 'W' }] }, cfg), /первый план/);
});

test('compileCamera reports a shot\'s original array index even after sorting by `at`', () => {
  // shots[2] в исходном массиве («XL») после сортировки по at окажется на позиции 1 —
  // сообщение об ошибке должно называть исходный индекс 2, а не позицию после сортировки.
  assert.throws(
    () => kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }, { at: 4, preset: 'M' }, { at: 2, preset: 'XL' }] }, cfg),
    /camera\.shots\[2\]/,
  );
});

test('drift grows W slowly and a W→M cut is a visible jump', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'M', drift: 'out' }] }, cfg);
  const start = kit.cameraAt(track, 0);
  const beforeCut = kit.cameraAt(track, 49);
  const afterCut = kit.cameraAt(track, 50);
  assert.equal(start.s, 1);
  assert.ok(beforeCut.s > 1.01 && beforeCut.s <= 1.05 + 1e-9);
  assert.ok(afterCut.s / beforeCut.s >= 1.15, `jump ${afterCut.s / beforeCut.s}`);
  assert.ok(Math.abs(kit.cameraAt(track, 1).s - start.s) < 0.002, 'drift must not jump between frames');
});

test('without fill the speaker never reveals the frame edge', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W', dx: 300 }] }, cfg);
  for (const frame of [0, 40, 120, 249]) {
    const c = kit.cameraAt(track, frame);
    assert.ok(c.dx <= (c.s - 1) * face.x + 1e-9);
    assert.ok(c.dx >= -(c.s - 1) * (1080 - face.x) - 1e-9);
  }
});

test('side presets shift the face by at least 85 px and use a fill layer', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }, { at: 2, preset: 'L' }] }, cfg);
  const w = kit.cameraAt(track, 49);
  const l = kit.cameraAt(track, 50);
  assert.equal(l.fill, true);
  assert.ok(Math.abs(l.dx - w.dx) >= 85);
});

test('punch rises within six frames, holds until `until`, and never exceeds maxScale', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W', drift: 'none' }],
    punches: [{ at: 1, until: 3, k: 1.15 }] }, cfg);
  assert.equal(kit.cameraAt(track, 24).s, 1);
  assert.ok(kit.cameraAt(track, 31).s >= 1.08);
  assert.ok(Math.abs(kit.cameraAt(track, 70).s - 1.15) < 0.01);
  assert.ok(Math.abs(kit.cameraAt(track, 90).s - 1) < 1e-6);
  const capped = kit.compileCamera({ face, shots: [{ at: 0, preset: 'M', drift: 'none' }], punches: [{ at: 0, until: 5, k: 1.15 }] }, cfg);
  const c = kit.cameraAt(capped, 20);
  assert.equal(c.s, 1.25);
  assert.ok(c.requested > 1.3);
});

test('blur from 0 starts sharp-free, ramps out, and dims the speaker', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }], blurs: [{ from: 0, to: 1, px: 24 }] }, cfg);
  assert.equal(kit.cameraAt(track, 0).blur, 24);
  assert.ok(Math.abs(kit.cameraAt(track, 0).dim - 0.72) < 1e-9);
  assert.equal(kit.cameraAt(track, 40).blur, 0);
});

test('away hides the speaker after the enter ramp and brings it back', () => {
  const track = kit.withAways(kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }] }, cfg), [{ from: 50, to: 100 }]);
  assert.equal(kit.cameraAt(track, 49).visible, true);
  assert.equal(kit.cameraAt(track, 60).visible, false);
  assert.equal(kit.cameraAt(track, 115).visible, true);
  assert.equal(kit.cameraAt(track, 60).s <= 1.25, true);
});

test('autoShots cuts on word ends, keeps every shot within 2.2 s and alternates presets', () => {
  const words = Array.from({ length: 40 }, (_, i) => ({ w: `слово${i}`, t: i % 7 === 6 ? `слово${i}.` : `слово${i}`, s: i * 0.5, e: i * 0.5 + 0.4 }));
  const shots = kit.autoShots(words, { endSec: 20.8 });
  assert.equal(shots[0].at, 0);
  const bounds = [...shots.map((s) => s.at), 20.8];
  for (let i = 1; i < bounds.length; i += 1) assert.ok(bounds[i] - bounds[i - 1] <= 2.2 + 1e-9, `shot ${i} ${bounds[i] - bounds[i - 1]}`);
  for (const shot of shots.slice(1)) assert.ok(words.some((w) => Math.abs(w.e - shot.at) < 1e-9));
  assert.deepEqual(shots.slice(0, 6).map((s) => s.preset), ['W', 'M', 'W', 'L', 'W', 'R']);
  assert.ok(shots.every((s) => s.drift === (s.preset === 'W' ? 'in' : 'out')));
});

// Длины планов между соседними точками разреза (и до endSec) — по этим длинам меряем максимум.
const shotLengths = (shots, endSec) => {
  const bounds = [...shots.map((s) => s.at), endSec];
  return bounds.slice(1).map((at, i) => at - bounds[i]);
};

test('autoShots cuts a short sentence-end word early when waiting for the next word would exceed 2.2 s', () => {
  // Слово «два.» стоит на границе предложения, но само по себе кончается раньше minSec (1,2 с);
  // следующее слово «три» без разреза увело бы план до 2,45 с — дольше maxSec.
  const words = [
    { w: 'один', t: 'один', s: 0, e: 0.5 },
    { w: 'два', t: 'два.', s: 0.6, e: 1.1 },
    { w: 'три', t: 'три', s: 1.2, e: 2.45 },
  ];
  const shots = kit.autoShots(words, { endSec: 2.45 });
  const lengths = shotLengths(shots, 2.45);
  assert.ok(lengths.every((len) => len <= 2.2 + 1e-9), `lengths ${lengths}`);
  assert.ok(shots.length >= 2, 'слово на границе должно вызвать ранний разрез');
});

test('autoShots splits a long tail after the last word into chunks no longer than 2.2 s', () => {
  const words = [{ w: 'тест', t: 'тест', s: 0, e: 0.2 }];
  const shots = kit.autoShots(words, { endSec: 3.2 }); // хвост после последнего слова — 3 с
  const lengths = shotLengths(shots, 3.2);
  assert.ok(lengths.every((len) => len <= 2.2 + 1e-9), `lengths ${lengths}`);
});

test('autoShots splits a 5 s pause between words into chunks no longer than 2.2 s', () => {
  const words = [
    { w: 'да', t: 'да', s: 0, e: 0.3 },
    { w: 'нет', t: 'нет.', s: 5.3, e: 5.6 }, // пауза 0.3 → 5.3 с = 5 с
  ];
  const shots = kit.autoShots(words, { endSec: 5.6 });
  const lengths = shotLengths(shots, 5.6);
  assert.ok(lengths.every((len) => len <= 2.2 + 1e-9), `lengths ${lengths}`);
});

test('autoShots splits long leading silence before speech starting at 3 s', () => {
  const words = [{ w: 'старт', t: 'старт', s: 3.0, e: 3.4 }];
  const shots = kit.autoShots(words, { endSec: 6.0 });
  const lengths = shotLengths(shots, 6.0);
  assert.ok(lengths.every((len) => len <= 2.2 + 1e-9), `lengths ${lengths}`);
  assert.ok(shots.length > 1, 'молчание в начале должно быть разбито хотя бы одним разрезом');
});

test('autoShots does not leave a 1-frame flash when the last word ends right at the end', () => {
  const words = [{ w: 'да', t: 'да.', s: 0, e: 1.5 }];
  const shots = kit.autoShots(words, { endSec: 1.54 });
  const lengths = shotLengths(shots, 1.54);
  // Либо разреза вообще не было (один план на весь ролик), либо последний план не короче minSec (1,2 с).
  assert.ok(shots.length === 1 || lengths.at(-1) >= 1.2 - 1e-9, `last length ${lengths.at(-1)}`);
  assert.ok(lengths.every((len) => len <= 2.2 + 1e-9), `lengths ${lengths}`);
});

test('autoShots evenly splits an empty transcript into chunks no longer than 2.2 s', () => {
  const shots = kit.autoShots([], { endSec: 10 });
  assert.equal(shots[0].at, 0);
  const lengths = shotLengths(shots, 10);
  assert.ok(lengths.every((len) => len <= 2.2 + 1e-9), `lengths ${lengths}`);
});

test('autoShots rejects words that are not an array', () => {
  assert.throws(() => kit.autoShots({}, { endSec: 5 }), /массив/);
  assert.throws(() => kit.autoShots('слово', { endSec: 5 }), /массив/);
});

// Камера задана в кадрах эталона 25 fps (время в секундах должно быть одинаковым на любом fps).
const cfg50 = { fps: 50, width: 1080, height: 1920, durationInFrames: 500 };

test('at 50 fps the blur in-ramp takes 12 frames (6 frames at 25 fps = 0.24 s)', () => {
  // b.from > 0, поэтому размытие входит через inFrames-рампу (не «резко с первого кадра»).
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W', drift: 'none' }],
    blurs: [{ from: 1, to: 8, px: 24 }] }, cfg50);
  const fromFrame = 50; // at: 1 с при 50 fps
  assert.ok(kit.cameraAt(track, fromFrame + 11).blur < 24, 'до 12 кадров рампа ещё не завершена');
  assert.equal(kit.cameraAt(track, fromFrame + 12).blur, 24);
});

test('at 50 fps away hides the speaker after 16 frames (8 frames at 25 fps = 0.16 s)', () => {
  const track = kit.withAways(kit.compileCamera({ face, shots: [{ at: 0, preset: 'W' }] }, cfg50), [{ from: 100, to: 400 }]);
  assert.equal(kit.cameraAt(track, 100 + 15).visible, true);
  assert.equal(kit.cameraAt(track, 100 + 16).visible, false);
});

test('sway dx at 50 fps frame 2N equals dx at 25 fps frame N for the same preset', () => {
  // preset L использует fill: true — клэмп по safe-краю кадра не применяется, sway виден напрямую.
  const track25 = kit.compileCamera({ face, shots: [{ at: 0, preset: 'L', drift: 'none' }] }, cfg);
  const track50 = kit.compileCamera({ face, shots: [{ at: 0, preset: 'L', drift: 'none' }] }, cfg50);
  for (const n of [3, 10, 40, 90]) {
    const dx25 = kit.cameraAt(track25, n).dx;
    const dx50 = kit.cameraAt(track50, 2 * n).dx;
    assert.ok(Math.abs(dx25 - dx50) < 1e-6, `n=${n} dx25=${dx25} dx50=${dx50}`);
  }
});

test('at 50 fps a punch k=1.15 grows at least 10 % within 12 frames', () => {
  const track = kit.compileCamera({ face, shots: [{ at: 0, preset: 'W', drift: 'none' }],
    punches: [{ at: 0, until: 5, k: 1.15 }] }, cfg50);
  assert.ok(kit.cameraAt(track, 12).s >= 1.10, `s=${kit.cameraAt(track, 12).s}`);
});
