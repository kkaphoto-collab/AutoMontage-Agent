// Задача 25: звук для гейтов в Node — PCM из ffmpeg, огибающая по 50 мс, корреляция Пирсона,
// поиск короткой/сдвинутой утечки голоса и доля звука слоя вне известных вставок.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runTool, toolAvailable } = require('./helpers/media-fixtures');
const {
  BLOCK, audibleOutside, bestLagPearson, blockDb, decodeAudio, envelopeDb, pcmFromFfmpeg, pearson, windowedMax,
} = require('../scripts/qa/audio');

test('envelope is -90 dBFS on silence and ~-3 dBFS on a full-scale sine', () => {
  const silence = new Int16Array(800);
  const sine = Int16Array.from({ length: 800 }, (_, i) => Math.round(32767 * Math.sin((2 * Math.PI * 220 * i) / 8000)));
  assert.deepEqual([...envelopeDb(silence)], [-90, -90]);
  assert.ok(Math.abs(blockDb(sine, 0, 800) + 3.01) < 0.1);
});

test('pearson is 1 for scaled copies, null for flat input, windowedMax finds the loud window', () => {
  const a = Float64Array.from([1, 2, 3, 4]);
  assert.ok(Math.abs(pearson(a, Float64Array.from([2, 4, 6, 8])) - 1) < 1e-12);
  assert.equal(pearson(a, Float64Array.from([5, 5, 5, 5])), null);
  const x = Float64Array.from([-90, -90, -90, -90, -20, -30, -20, -30]);
  const y = Float64Array.from([-40, -41, -39, -40, -20, -30, -20, -30]);
  assert.equal(windowedMax(x, y, 4).startBlock, 4);
});

// --- Ревью задачи 25, п.1: гейт по доле слышимых блоков, а не по средней громкости окна ---

// Реальная находка ревью: 4 громких блока из 10 (утечка), остальные 6 — фон −90 дБФС. Среднее по
// всему окну = (4×−20 + 6×−90)/10 = −64 дБФС — ниже дефолтного minDbA (−60), старый гейт по
// среднему целиком пропускал бы такое окно, хотя утечка внутри него звучит в полную силу и хорошо
// коррелирует. Доля слышимых блоков — 4/10 = 0,4, ровно дефолтный minAudibleShare — гейт по доле
// пропускает её.
test('windowedMax finds a leak whose window MEAN falls below minDbA but whose audible SHARE clears the threshold', () => {
  const a = Float64Array.from([-90, -90, -90, -20, -30, -20, -30, -90, -90, -90]);
  const b = Float64Array.from([-90, -90, -90, -18, -28, -18, -28, -90, -90, -90]);
  const fullWindowMean = a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(fullWindowMean < -60, `сценарий должен реально давать среднее ниже -60: ${fullWindowMean}`);
  const found = windowedMax(a, b, 10, { hop: 10 });
  assert.ok(found, 'гейт по доле обязан найти утечку, которую гейт по среднему пропустил бы');
  assert.ok(found.r > 0.9, `корреляция внутри утечки должна быть высокой: ${found.r}`);
  // Тот же сценарий с более строгой долей (50 %, утечка даёт только 40 %) обязан не найти утечку —
  // подтверждает, что находка выше объясняется именно долей, а не побочным эффектом.
  assert.equal(windowedMax(a, b, 10, { hop: 10, minAudibleShare: 0.5 }), null);
});

// Последнее окно у самого конца сигнала (start = n − windowBlocks) проверяется всегда, даже если
// обычная сетка шагом туда не попадает: windowBlocks=10, hop по умолчанию = 2, n=15 → сетка идёт
// 0,2,4 (следующий шаг 6 уже даёт start+windowBlocks=16>15), lastStart=5 сеткой не покрыт.
// Утечка (блоки 11..14, доля 4/10=0,4) целиком лежит только в окне [5,15) и не даёт достаточную
// долю ни в одном окне сетки (0,2,4) — без явной проверки последнего окна была бы null.
test('windowedMax always checks the very last window even when the regular hop grid skips it', () => {
  const a = new Float64Array(15).fill(-90);
  const b = new Float64Array(15).fill(-90);
  const loudA = [-20, -30, -20, -30];
  const loudB = [-18, -28, -18, -28];
  [11, 12, 13, 14].forEach((idx, k) => { a[idx] = loudA[k]; b[idx] = loudB[k]; });
  const found = windowedMax(a, b, 10);
  assert.ok(found, 'утечка у самого конца сигнала должна быть найдена');
  assert.equal(found.startBlock, 5);
});

// --- Ревью задачи 25, п.2: bestLagPearson и maxLagBlocks в windowedMax ---

test('bestLagPearson finds the exact lag and r≈1 for a shifted copy, and null for a flat signal', () => {
  const base = [0, 3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4, 6, 2, 6, 4];
  const shifted = (shift, n = 20) => {
    const b = Float64Array.from(base.slice(0, n));
    const a = new Float64Array(n);
    for (let i = 0; i < n; i += 1) a[i] = i - shift >= 0 && i - shift < base.length ? base[i - shift] : 0;
    return { a, b };
  };
  for (const shift of [2, 5]) {
    const { a, b } = shifted(shift);
    const found = bestLagPearson(a, b, 6);
    assert.ok(found, `сдвиг на ${shift} блоков должен быть найден`);
    assert.equal(found.lag, shift);
    assert.ok(Math.abs(found.r - 1) < 1e-9);
  }
  const flat = new Float64Array(20).fill(5);
  const varying = Float64Array.from(base.slice(0, 20));
  assert.equal(bestLagPearson(flat, varying, 6), null);
  assert.equal(bestLagPearson(flat, flat, 6), null);
});

// Реальная находка ревью: задержка звука слоя на 100–300 мс (микрофон/буфер муксера) быстро гасит
// корреляцию БЕЗ лага (r0 у ревьюера упал с 0,56 до 0,19 на 100→300 мс), хотя утечка реально там
// есть. Внутри окна утечка сдвинута на 3 блока (150 мс) — ищем её тем же windowedMax.
test('windowedMax with the default maxLagBlocks finds a delayed leak that a zero-lag search misses', () => {
  const FLOOR = -90;
  const pattern = [-20, -32, -18, -36, -24, -30, -22, -40];
  const build = (offset, n = 20) => {
    const x = new Float64Array(n).fill(FLOOR);
    pattern.forEach((v, i) => { x[offset + i] = v; });
    return x;
  };
  const b = build(4); // исходник: голос в блоках 4..11
  const a = build(4 + 3); // утечка в звуке слоя задержана на 3 блока (150 мс)
  const zeroLagOnly = windowedMax(a, b, 20, { maxLagBlocks: 0, hop: 20 });
  assert.ok(zeroLagOnly, 'окно всё равно должно пройти гейт по доле');
  assert.ok(zeroLagOnly.r < 0.6, `без лага корреляция должна быть слабой: ${zeroLagOnly.r}`);
  const withLag = windowedMax(a, b, 20, { hop: 20 });
  assert.ok(withLag);
  assert.equal(withLag.lag, 3);
  assert.ok(Math.abs(withLag.r - 1) < 1e-9);
});

// --- Ревью задачи 25, п.3: audibleOutside — секунды звука слоя вне известных окон эффектов ---

test('audibleOutside is 0 s when every audible block sits inside the given spans', () => {
  const FLOOR = -90;
  const LOUD = -20;
  // 20 блоков по 50 мс = 1 с. Громкие блоки 4..15 (0,2..0,8 с) целиком внутри span [0,2, 0,8).
  const envelope = Float64Array.from({ length: 20 }, (_, i) => (i >= 4 && i < 16 ? LOUD : FLOOR));
  const { seconds, stretches } = audibleOutside(envelope, [[0.2, 0.8]]);
  assert.equal(seconds, 0);
  assert.deepEqual(stretches, []);
});

test('a 1 s audible stretch outside the spans is reported almost exactly, with its own stretch', () => {
  const FLOOR = -90;
  const LOUD = -20;
  // 40 блоков = 2 с. Громкие блоки 10..29 (0,5..1,5 с) — 1 с, полностью вне spans.
  const envelope = Float64Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 ? LOUD : FLOOR));
  const { seconds, stretches } = audibleOutside(envelope, [[1.6, 1.8]]);
  assert.equal(seconds, 1);
  assert.deepEqual(stretches, [{ fromSec: 0.5, toSec: 1.5 }]);
});

test('the tail margin after a span absorbs a short reverberation right after it, but not further out', () => {
  const FLOOR = -90;
  const LOUD = -20;
  // span [0, 0,5) + tailSec(0,15) → заглушено фактически до 0,65 с. Блок 0,60..0,65 (индекс 12)
  // внутри хвоста — не считается; блок 0,70..0,75 (индекс 14) уже снаружи хвоста — считается.
  const envelope = Float64Array.from({ length: 20 }, (_, i) => (i === 12 || i === 14 ? LOUD : FLOOR));
  const { seconds, stretches } = audibleOutside(envelope, [[0, 0.5]], { tailSec: 0.15 });
  assert.equal(seconds, 0.05);
  assert.deepEqual(stretches, [{ fromSec: 0.7, toSec: 0.75 }]);
});

// --- Ревью задачи 25, п.4: причина сбоя ffmpeg — приоритет stderr → error.message → сигнал/статус ---

test('ffmpeg failures are errors, never a silent pass', () => {
  const failing = () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('No such file') });
  assert.throws(() => pcmFromFfmpeg(['-i', 'missing.wav'], { spawnImpl: failing }), /ffmpeg не смог отдать звук: No such file/);
  const ok = () => ({ status: 0, stdout: Buffer.from([1, 0, 255, 255]), stderr: Buffer.alloc(0) });
  assert.deepEqual([...pcmFromFfmpeg([], { spawnImpl: ok })], [1, -1]);
});

test('ENOENT gets a doctor hint, not the generic "ffmpeg не смог отдать звук"', () => {
  const enoent = () => ({
    error: Object.assign(new Error('spawnSync ffmpeg ENOENT'), { code: 'ENOENT' }),
    status: null, signal: null, stdout: undefined, stderr: undefined,
  });
  assert.throws(() => pcmFromFfmpeg(['-i', 'x.wav'], { spawnImpl: enoent }), /ffmpeg не найден; запусти npm run doctor/);
});

// Реальная находка ревью: пустой Buffer (stdout/stderr при таймауте или сигнале — не null, как при
// ENOENT, а именно пустой Buffer) сам по себе truthy — `result.stderr || result.error?.message`
// раньше ВСЕГДА выбирал его и терял настоящую причину из error.message (например ETIMEDOUT).
test('an empty stderr Buffer does not swallow a real error.message (timeout-style failure)', () => {
  const timedOut = () => ({
    error: new Error('spawnSync ffmpeg ETIMEDOUT'), status: null, signal: 'SIGKILL',
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
  });
  assert.throws(() => pcmFromFfmpeg(['-i', 'x.wav'], { spawnImpl: timedOut }), /ffmpeg не смог отдать звук: spawnSync ffmpeg ETIMEDOUT/);
});

// Ни stderr, ни error.message — последняя инстанция: голый сигнал, а не пустое сообщение.
test('a signal-killed process with no stderr and no error.message still names the signal', () => {
  const killed = () => ({ error: null, status: null, signal: 'SIGSEGV', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  assert.throws(() => pcmFromFfmpeg(['-i', 'x.wav'], { spawnImpl: killed }), /ffmpeg не смог отдать звук: процесс убит сигналом SIGSEGV/);
});

test('a plain non-zero status with nothing else falls back to naming the status', () => {
  const failed = () => ({ error: null, status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  assert.throws(() => pcmFromFfmpeg(['-i', 'x.wav'], { spawnImpl: failed }), /ffmpeg не смог отдать звук: процесс завершился со статусом 1/);
});

// «Stream map '' matches no streams» — ffmpeg так отказывает -map 0:a:0 на файле без звуковой
// дорожки; сообщение полезнее сырого текста ffmpeg с именем опции.
test('a file with no audio stream throws a clear message naming the file', () => {
  const noAudio = () => ({
    error: null, status: 234, signal: null, stdout: Buffer.alloc(0),
    stderr: Buffer.from("Stream map '' matches no streams.\nTo ignore this, add a trailing '?' to the map.\n"),
  });
  assert.throws(() => decodeAudio('clip.mp4', { spawnImpl: noAudio }), /в clip\.mp4 нет звуковой дорожки/);
});

// --- Ревью задачи 25, п.5: decodeAudio — формат секунд, валидация durationSec, пустой отрезок ---

function captureArgv() {
  const calls = [];
  // Непустой stdout по умолчанию — иначе decodeAudio() сам бросил бы «нет звука в заданном
  // отрезке» раньше, чем тест успеет посмотреть на перехваченный argv.
  const spy = (cmd, args) => { calls.push(args); return { status: 0, stdout: Buffer.from([0, 0, 0, 0]), stderr: Buffer.alloc(0) }; };
  return { calls, spy };
}

test('decodeAudio formats seconds as plain decimals, never exponential notation or float noise', () => {
  const { calls, spy } = captureArgv();
  decodeAudio('f.wav', { fromSec: 1e-7, spawnImpl: spy });
  decodeAudio('f.wav', { fromSec: 0.1 + 0.2, spawnImpl: spy });
  decodeAudio('f.wav', { fromSec: 5, durationSec: 123456789e-9, spawnImpl: spy });
  const ssArg = (args) => args[args.indexOf('-ss') + 1];
  const tArg = (args) => args[args.indexOf('-t') + 1];
  assert.equal(ssArg(calls[0]), '0');
  assert.equal(ssArg(calls[1]), '0.3');
  assert.equal(ssArg(calls[2]), '5');
  assert.equal(tArg(calls[2]), '0.123457');
  for (const args of calls) for (const value of args) assert.ok(!/e[-+]?\d/i.test(value), `аргумент не должен быть экспоненциальной записью: ${value}`);
});

test('decodeAudio refuses a non-finite or non-positive durationSec', () => {
  const { spy } = captureArgv();
  for (const bad of [-1, 0, NaN, Infinity, -Infinity]) {
    assert.throws(() => decodeAudio('f.wav', { durationSec: bad, spawnImpl: spy }),
      /decodeAudio: durationSec должен быть конечным положительным числом/);
  }
  assert.doesNotThrow(() => decodeAudio('f.wav', { durationSec: 1, spawnImpl: spy }));
  assert.doesNotThrow(() => decodeAudio('f.wav', { spawnImpl: spy }));
});

test('decodeAudio throws a clear message on an empty decode instead of returning an empty array', () => {
  const empty = () => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  assert.throws(() => decodeAudio('f.wav', { fromSec: 999, spawnImpl: empty }), /нет звука в заданном отрезке/);
});

// --- Реальный ffmpeg ---

test('a real ffmpeg full-scale sine decodes to a ~-3 dBFS, 20-block one-second envelope', (t) => {
  const check = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', shell: false });
  if (check.error || check.status !== 0) {
    t.skip('ffmpeg не найден в PATH');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-audio-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wav = path.join(dir, 'sine.wav');
  const generated = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*440*t):d=1',
    wav,
  ], { encoding: 'utf8', shell: false });
  assert.equal(generated.status, 0, generated.stderr);

  const samples = decodeAudio(wav);
  const envelope = envelopeDb(samples);
  assert.equal(envelope.length, 20);
  for (const db of envelope) assert.ok(Math.abs(db + 3.01) < 0.2, `блок не похож на полношкальный синус: ${db} дБФС`);
});

test('a real stereo source still downmixes to a 20-block mono envelope (pins -ac 1)', (t) => {
  if (!toolAvailable('ffmpeg')) { t.skip('ffmpeg не найден в PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-audio-stereo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wav = path.join(dir, 'stereo.wav');
  runTool('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*440*t)|sin(2*PI*440*t):d=1', wav], dir);
  const envelope = envelopeDb(decodeAudio(wav));
  assert.equal(envelope.length, 20);
  for (const db of envelope) assert.ok(Math.abs(db + 3.01) < 0.2, `блок: ${db} дБФС`);
});

test('a real -ss/-t decode lands on the silence-then-tone boundary it asked for', (t) => {
  if (!toolAvailable('ffmpeg')) { t.skip('ffmpeg не найден в PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-audio-sstone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wav = path.join(dir, 'silence-then-tone.wav');
  runTool('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1',
    '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*440*t):d=1',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1',
    wav,
  ], dir);
  const envelope = envelopeDb(decodeAudio(wav, { fromSec: 0.5, durationSec: 1 }));
  assert.equal(envelope.length, 20);
  // Первые 9 блоков — чистая тишина (-90). Понижающий ресемплинг 48 → 8 кГц размывает сам переход
  // ровно на один блок (у фильтра ресемплинга есть протяжка/lookahead в несколько сэмплов) — блок 9
  // на границе не проверяем строго, это ожидаемое смазывание реального декодирования, а не баг
  // decodeAudio. Блоки 10..19 — чистый тон (~-3 дБФС).
  for (let i = 0; i < 9; i += 1) assert.equal(envelope[i], -90, `блок ${i} должен быть тишиной`);
  for (let i = 10; i < 20; i += 1) assert.ok(Math.abs(envelope[i] + 3.01) < 0.2, `блок ${i}: ${envelope[i]}`);
});

test('a real decode whose sample count is not a multiple of the block drops the partial tail block', (t) => {
  if (!toolAvailable('ffmpeg')) { t.skip('ffmpeg не найден в PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-audio-partial-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wav = path.join(dir, 'tone.wav');
  runTool('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*440*t):d=2', wav], dir);
  const samples = decodeAudio(wav, { durationSec: 0.973 });
  assert.notEqual(samples.length % BLOCK, 0, 'сценарий должен реально давать не кратное блоку число сэмплов');
  const envelope = envelopeDb(samples);
  assert.equal(envelope.length, Math.floor(samples.length / BLOCK));
  assert.ok(envelope.length * BLOCK < samples.length, 'последний неполный блок должен быть отброшен, а не округлён вверх');
});

test('a real video-only file throws the no-audio-track message naming the file', (t) => {
  if (!toolAvailable('ffmpeg')) { t.skip('ffmpeg не найден в PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-audio-noaudio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mp4 = path.join(dir, 'video-only.mp4');
  runTool('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25:d=0.5', '-an', mp4], dir);
  assert.throws(() => decodeAudio(mp4), /нет звуковой дорожки/);
});
