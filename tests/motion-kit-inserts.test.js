const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEsm } = require('./helpers/load-esm');

const kit = loadEsm('src/motion-kit/core.js');

test('inserts compile to frames, default ids, cover and Ken Burns range', () => {
  const inserts = kit.compileInserts([
    { kind: 'stock', from: 2, to: 4, src: 'stock/a.mp4', sfx: 'whoosh' },
    { kind: 'donor', from: 1.3, to: 3.4, src: 'donor.mp4' },
  ], { fps: 25 });
  assert.deepEqual(inserts.map((i) => [i.id, i.from, i.to, i.cover]), [['stock-1', 50, 100, true], ['donor-2', 33, 85, false]]);
  assert.deepEqual(inserts[0].kb, [1.03, 1.1]);
  assert.equal(inserts[0].sfx, 'whoosh');
});

test('invalid inserts are rejected', () => {
  assert.throws(() => kit.compileInserts([{ kind: 'meme', from: 0, to: 1 }], { fps: 25 }), /inserts\[0\]: kind/);
  assert.throws(() => kit.compileInserts([{ kind: 'stock', from: 2, to: 2 }], { fps: 25 }), /to должен быть больше from/);
});

test('covering inserts send the speaker away and bring it back before the insert closes', () => {
  // stock: from=2s=50f, to=4s=100f. away.to = to − ref25(CLOSE_FRAMES=6) − ref25(exitFrames=10)
  // = 100 − 6 − 10 = 84: the return ramp must finish exactly when the close (card shrinking back
  // down) starts, so the speaker is already sharp and fully opaque under the shrinking card.
  const aways = kit.awaysFromInserts(kit.compileInserts([
    { kind: 'stock', from: 2, to: 4 }, { kind: 'donor', from: 5, to: 6 },
  ], { fps: 25 }));
  assert.deepEqual(aways, [{ from: 50, to: 84 }]);
});

test('compileInserts rejects a malformed kb, naming the insert', () => {
  const bad = (kb) => () => kit.compileInserts([{ kind: 'stock', from: 0, to: 1, kb }], { fps: 25 });
  assert.throws(bad([1.03]), /inserts\[0\] \(stock-1\): kb должен быть парой чисел/);
  assert.throws(bad([0.9, 1.1]), /inserts\[0\] \(stock-1\): kb должен быть парой чисел/);
  assert.throws(bad(['a', 1.1]), /inserts\[0\] \(stock-1\): kb должен быть парой чисел/);
  assert.throws(bad([1.03, 1.1, 1.2]), /inserts\[0\] \(stock-1\): kb должен быть парой чисел/);
  assert.throws(bad('nope'), /inserts\[0\] \(stock-1\): kb должен быть парой чисел/);
});

// Гарантия всего pipeline (compileInserts → awaysFromInserts → compileCamera/withAways →
// cameraAt) на нескольких fps: спикер обязан быть резким и непрозрачным на всём close, чтобы
// сжимающаяся обратно карточка не открывала размытое/полупрозрачное лицо (тёмное кольцо на
// стыке); и пока в кадре ещё виден зазор карточки (открытие не докрыло экран), спикер не должен
// успеть погаснуть — иначе в зазоре на миг будет видна пустота вместо живого (пусть и размытого)
// спикера.
test('the speaker is fully back before the close starts and never goes dark while a reveal gap is still visible', () => {
  for (const fps of [24, 25, 30, 50, 60]) {
    const width = 1080;
    const height = 1920;
    const durationInFrames = fps * 10;
    const inserts = kit.compileInserts([{ kind: 'stock', from: 2, to: 4.4, src: 'stock/a.mp4' }], { fps, durationInFrames });
    const [insert] = inserts;
    const track = kit.withAways(
      kit.compileCamera({ face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }] }, { fps, width, height, durationInFrames }),
      kit.awaysFromInserts(inserts, { fps }),
    );
    const card = kit.revealCard(width, height);
    const revealFrames = kit.ref25(kit.REVEAL_FRAMES, fps);
    let sawClose = false;
    for (let frame = insert.from; frame < insert.to; frame += 1) {
      const p = kit.revealProgress(frame, insert, fps);
      const cam = kit.cameraAt(track, frame);
      if (frame >= insert.from + revealFrames && p < 1) {
        sawClose = true;
        assert.ok(cam.opacity >= 0.99, `fps ${fps} frame ${frame}: speaker opacity ${cam.opacity} during close`);
        assert.ok(cam.blur <= 0.05, `fps ${fps} frame ${frame}: speaker blur ${cam.blur} during close`);
      }
      const insetMax = Math.max(card.top, card.right, card.bottom, card.left) * (1 - p);
      if (insetMax > 0.5) {
        assert.ok(cam.opacity >= 0.01, `fps ${fps} frame ${frame}: speaker opacity ${cam.opacity} while a ${insetMax.toFixed(2)}px gap is still visible`);
      }
    }
    assert.ok(sawClose, `fps ${fps}: expected the close phase to actually run for this insert`);

    // Step 0 fix: тот же pipeline на вставке ровно минимальной длины (close + exit + 1 кадр) —
    // здесь away-окно вырождается в 1 кадр (см. тест «never inverts from/to»), и это самый тесный
    // случай для возврата спикера в фокус. С closeStart и до конца вставки спикер обязан быть уже
    // резким и непрозрачным на каждом кадре.
    const minFrames = kit.ref25(kit.CLOSE_FRAMES, fps) + kit.ref25(kit.CAMERA_DEFAULTS.away.exitFrames, fps) + 1;
    const minInserts = kit.compileInserts([{ kind: 'stock', from: 0, to: minFrames / fps, src: 'stock/a.mp4' }], { fps, durationInFrames });
    const [minInsert] = minInserts;
    const minTrack = kit.withAways(
      kit.compileCamera({ face: { x: 540, y: 787 }, shots: [{ at: 0, preset: 'W' }] }, { fps, width, height, durationInFrames }),
      kit.awaysFromInserts(minInserts, { fps }),
    );
    const { start: minCloseStart } = kit.closeWindow(minInsert, fps);
    for (let frame = minCloseStart; frame < minInsert.to; frame += 1) {
      const cam = kit.cameraAt(minTrack, frame);
      assert.ok(cam.opacity >= 0.99, `fps ${fps} frame ${frame} (min-length insert): speaker opacity ${cam.opacity} during close`);
      assert.ok(cam.blur <= 0.05, `fps ${fps} frame ${frame} (min-length insert): speaker blur ${cam.blur} during close`);
    }
  }
});

// Граничные случаи сверх плана: пустой список вставок не должен падать (нет вставок в ролике —
// обычный случай для роликов без стока), и awaysFromInserts должен молча пропускать вставки
// короче окна возврата, а не уходить в отрицательный диапазон.
test('an empty insert list compiles and produces no away windows', () => {
  assert.deepEqual(kit.compileInserts([], { fps: 25 }), []);
  assert.deepEqual(kit.awaysFromInserts([], { fps: 25 }), []);
});

test('a covering insert at the minimum cover length never inverts from/to in its away window', () => {
  // Новый минимум = close + exit + 1 кадр (ревью code-quality к Task 16): ровно на минимуме
  // away.to = to − close − exit уже честно равен insert.from + 1 САМ ПО СЕБЕ, без обращения к
  // Math.max — гарантия «away-окно никогда не вырождается в ноль» теперь буквально верна, а не
  // держится на подстраховке. Math.max в awaysFromInserts остаётся только для вставок, собранных
  // в обход compileInserts.
  const minFrames = kit.ref25(kit.CLOSE_FRAMES, 25) + kit.ref25(kit.CAMERA_DEFAULTS.away.exitFrames, 25) + 1;
  const inserts = kit.compileInserts([{ kind: 'stock', from: 0, to: minFrames / 25 }], { fps: 25 });
  const [away] = kit.awaysFromInserts(inserts, { fps: 25 });
  assert.equal(away.to - away.from, 1, 'at the exact minimum the away window is naturally 1 frame, not clamped from 0');
});

test('compileInserts rejects a cover insert shorter than the return-before-close minimum, naming the insert and the minimum in frames and seconds', () => {
  for (const fps of [25, 50]) {
    const minFrames = kit.ref25(kit.CLOSE_FRAMES, fps) + kit.ref25(kit.CAMERA_DEFAULTS.away.exitFrames, fps) + 1;
    // Секунды в сообщении округлены ВВЕРХ (не к ближайшему): plan-автор, который дословно
    // перепишет это число в plan.js, обязан получить вставку не короче минимума в кадрах — иначе
    // округление к ближайшему могло показать значение, которое всё ещё не проходит проверку.
    const minSec = Math.ceil((minFrames / fps) * 100) / 100;
    // Ровно минимум — проходит.
    assert.doesNotThrow(() => kit.compileInserts([{ kind: 'stock', from: 0, to: minFrames / fps }], { fps }));
    // На один кадр короче — падает с понятной причиной, минимумом в кадрах и в секундах.
    const oneFrameShort = (minFrames - 1) / fps;
    assert.throws(
      () => kit.compileInserts([{ kind: 'stock', from: 0, to: oneFrameShort }], { fps }),
      new RegExp(`inserts\\[0\\] \\(stock\\): закрывающая вставка короче минимума ${minFrames} кадров \\(${minSec.toFixed(2)} с\\)`),
      `fps ${fps}: expected the short-cover rejection`,
    );
  }
});

test('a cover insert shortened by the composition end says so in the short-cover error', () => {
  // from=100f (4с), durationInFrames=110 → «сырой» to (10с=250f) обрезается до 110, оставляя
  // всего 10 кадров — короче минимума (17 при fps 25). Сообщение обязано отдельно объяснить, что
  // причина в конце ролика, а не в том, что автор plan.js написал слишком короткую вставку.
  assert.throws(
    () => kit.compileInserts([{ kind: 'stock', from: 4, to: 10 }], { fps: 25, durationInFrames: 110 }),
    /inserts\[0\] \(stock\): закрывающая вставка короче минимума 17 кадров \(0\.68 с\) \(обрезана концом ролика до 0\.40 с\)/,
  );
});

test('a non-covering (donor) insert is not subject to the cover-length minimum', () => {
  // donor: cover=false по умолчанию — вставка короче ref25(CLOSE_FRAMES)+ref25(exitFrames) не
  // должна отклоняться, потому что она не отправляет спикера в away и не обязана его возвращать.
  assert.doesNotThrow(() => kit.compileInserts([{ kind: 'donor', from: 0, to: 0.1 }], { fps: 25 }));
});

// Вставки обязаны обрезаться по длительности композиции: донор, начатый до конца ролика, но
// заканчивающийся далеко после него, не должен попасть в манифест с «to» за пределами видео
// (иначе G11 посчитает его длину неправильно), а вставка целиком за концом ролика должна быть
// отклонена, а не молча пройти компиляцию.
test('an insert reaching past the composition end is clamped to its duration', () => {
  const [donor] = kit.compileInserts([{ kind: 'donor', from: 18, to: 25 }], { fps: 25, durationInFrames: 500 });
  assert.equal(donor.to, 500);
  assert.equal(donor.from, 450);
  assert.equal((donor.to - donor.from) / 25, 2, 'видимый хвост донора должен остаться 2 с');
});

test('an insert starting at or after the composition end is rejected', () => {
  assert.throws(
    () => kit.compileInserts([{ kind: 'stock', from: 22, to: 24 }], { fps: 25, durationInFrames: 500 }),
    /inserts\[0\] \(stock\): начинается после конца ролика/,
  );
  assert.throws(
    () => kit.compileInserts([{ kind: 'stock', from: 20, to: 24 }], { fps: 25, durationInFrames: 500 }),
    /начинается после конца ролика/,
    'from ровно на конце ролика — тоже поздно, ролик заканчивается на durationInFrames',
  );
});

test('compileInserts keeps its old unclamped behaviour when durationInFrames is omitted', () => {
  // Task 8 вызывает compileInserts(inserts, { fps }) без durationInFrames — эти вызовы не должны
  // ломаться или начать обрезать to, иначе существующие тесты и places, которые ещё не знают
  // длительность композиции, перестанут работать.
  const [insert] = kit.compileInserts([{ kind: 'stock', from: 2, to: 100 }], { fps: 25 });
  assert.equal(insert.to, 2500);
});

test('the close fade (insertOpacity) is already moving one frame after closeWindow starts at fps 50', () => {
  const insert = { id: 'stock-4', kind: 'stock', from: 0, to: 200 };
  const { start } = kit.closeWindow(insert, 50);
  const opacity = kit.insertOpacity(start + 1, insert, 50);
  assert.ok(opacity > 0 && opacity < 1, `expected 0 < opacity < 1 at closeStart+1, got ${opacity}`);
});

// Более сильная версия проверки общего close-окна: не просто «оба сдвинулись», а буквально равны
// на каждом кадре, где revealProgress уже полностью открылся (frame >= from + reveal) — там его
// множитель prog(...reveal) строго равен 1, так что revealProgress вырождается в тот же самый
// (1 - closeProg), что и insertOpacity, на нескольких fps сразу.
test('revealProgress and insertOpacity are exactly equal once the reveal is fully open, at every fps', () => {
  const insert = { id: 'stock-5', kind: 'stock', from: 0, to: 300 };
  for (const fps of [24, 25, 30, 50, 60]) {
    const reveal = kit.ref25(kit.REVEAL_FRAMES, fps);
    for (let f = insert.from + reveal; f < insert.to; f += 1) {
      assert.equal(kit.revealProgress(f, insert, fps), kit.insertOpacity(f, insert, fps), `fps ${fps} frame ${f}`);
    }
  }
});
