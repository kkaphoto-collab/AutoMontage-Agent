// Задача 25: звук для гейтов в Node – PCM из ffmpeg, огибающая по 50 мс, корреляция Пирсона,
// поиск короткой/сдвинутой утечки голоса и доля звука слоя вне известных вставок.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runTool, toolAvailable } = require('./helpers/media-fixtures');
const {
  BLOCK, audibleOutside, bestLagPearson, blockDb, decodeAudio, envelopeDb, floatPcmFromFfmpeg, pcmFromFfmpeg, pearson, windowedMax,
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

// Реальная находка ревью: 4 громких блока из 10 (утечка), остальные 6 – фон −90 дБФС. Среднее по
// всему окну = (4×−20 + 6×−90)/10 = −64 дБФС – ниже дефолтного minDbA (−60), старый гейт по
// среднему целиком пропускал бы такое окно, хотя утечка внутри него звучит в полную силу и хорошо
// коррелирует. Доля слышимых блоков – 4/10 = 0,4, ровно дефолтный minAudibleShare – гейт по доле
// пропускает её.
test('windowedMax finds a leak whose window MEAN falls below minDbA but whose audible SHARE clears the threshold', () => {
  const a = Float64Array.from([-90, -90, -90, -20, -30, -20, -30, -90, -90, -90]);
  const b = Float64Array.from([-90, -90, -90, -18, -28, -18, -28, -90, -90, -90]);
  const fullWindowMean = a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(fullWindowMean < -60, `сценарий должен реально давать среднее ниже -60: ${fullWindowMean}`);
  const found = windowedMax(a, b, 10, { hop: 10 });
  assert.ok(found, 'гейт по доле обязан найти утечку, которую гейт по среднему пропустил бы');
  assert.ok(found.r > 0.9, `корреляция внутри утечки должна быть высокой: ${found.r}`);
  // Тот же сценарий с более строгой долей (50 %, утечка даёт только 40 %) обязан не найти утечку –
  // подтверждает, что находка выше объясняется именно долей, а не побочным эффектом.
  assert.equal(windowedMax(a, b, 10, { hop: 10, minAudibleShare: 0.5 }), null);
});

// Последнее окно у самого конца сигнала (start = n − windowBlocks) проверяется всегда, даже если
// обычная сетка шагом туда не попадает: windowBlocks=10, hop по умолчанию = 2, n=15 → сетка идёт
// 0,2,4 (следующий шаг 6 уже даёт start+windowBlocks=16>15), lastStart=5 сеткой не покрыт.
// Утечка (блоки 11..14, доля 4/10=0,4) целиком лежит только в окне [5,15) и не даёт достаточную
// долю ни в одном окне сетки (0,2,4) – без явной проверки последнего окна была бы null.
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
// есть. Внутри окна утечка сдвинута на 3 блока (150 мс) – ищем её тем же windowedMax.
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

// --- Ревью задачи 25, п.3: audibleOutside – секунды звука слоя вне известных окон эффектов ---

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
  // 40 блоков = 2 с. Громкие блоки 10..29 (0,5..1,5 с) – 1 с, полностью вне spans.
  const envelope = Float64Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 ? LOUD : FLOOR));
  const { seconds, stretches } = audibleOutside(envelope, [[1.6, 1.8]]);
  assert.equal(seconds, 1);
  assert.deepEqual(stretches, [{ fromSec: 0.5, toSec: 1.5 }]);
});

// Хвост – не реверберация: kit обрезает звук ровно на durationFrames (с коротким затуханием), и
// дольше заявленной длины файл не звучит. Запас после span покрывает смазывание кодека AAC (окно
// MDCT 1024 сэмпла ≈ 21 мс на каждое из двух поколений: Remotion → layer normalize).
test('the tail margin after a span absorbs AAC smearing right after it, but not further out', () => {
  const FLOOR = -90;
  const LOUD = -20;
  // span [0, 0,5) + tailSec(0,15) → заглушено фактически до 0,65 с. Блок 0,60..0,65 (индекс 12)
  // внутри хвоста – не считается; блок 0,70..0,75 (индекс 14) уже снаружи хвоста – считается.
  const envelope = Float64Array.from({ length: 20 }, (_, i) => (i === 12 || i === 14 ? LOUD : FLOOR));
  const { seconds, stretches } = audibleOutside(envelope, [[0, 0.5]], { tailSec: 0.15 });
  assert.equal(seconds, 0.05);
  assert.deepEqual(stretches, [{ fromSec: 0.7, toSec: 0.75 }]);
});

test('audibleOutside pads 0.15 s after a span by default (no tailSec passed)', () => {
  const envelope = Float64Array.from({ length: 20 }, (_, i) => (i === 12 ? -20 : -90));
  assert.equal(audibleOutside(envelope, [[0, 0.5]], { headSec: 0 }).seconds, 0);
  assert.equal(audibleOutside(envelope, [[0, 0.5]], { headSec: 0, tailSec: 0 }).seconds, 0.05);
});

// Предэхо AAC: кодек размазывает резкую атаку эффекта назад, в блок ПЕРЕД началом span. Запас
// headSec (по умолчанию 0,1 с) до начала span не даёт засчитать это предэхо как звук вне эффектов.
test('audibleOutside pads 0.1 s before a span by default and the pad is configurable', () => {
  // span [0,5, 0,6). Блок 8 (0,40..0,45) внутри запаса 0,1 с – не считается; блок 7 (0,35..0,40)
  // уже до запаса – считается.
  const envelope = Float64Array.from({ length: 20 }, (_, i) => (i === 7 || i === 8 ? -20 : -90));
  const withDefaults = audibleOutside(envelope, [[0.5, 0.6]]);
  assert.equal(withDefaults.seconds, 0.05);
  assert.deepEqual(withDefaults.stretches, [{ fromSec: 0.35, toSec: 0.4 }]);
  assert.equal(audibleOutside(envelope, [[0.5, 0.6]], { headSec: 0 }).seconds, 0.1);
  assert.equal(audibleOutside(envelope, [[0.5, 0.6]], { headSec: 0.2 }).seconds, 0);
});

test('audibleOutside counts only blocks louder than -60 dBFS by default', () => {
  const envelope = Float64Array.from({ length: 20 }, (_, i) => (i === 3 ? -70 : i === 15 ? -50 : -90));
  const { seconds, stretches } = audibleOutside(envelope, []);
  assert.equal(seconds, 0.05);
  assert.deepEqual(stretches, [{ fromSec: 0.75, toSec: 0.8 }]);
});

test('an audible stretch running to the very end of the envelope keeps its stretch', () => {
  const envelope = Float64Array.from({ length: 20 }, (_, i) => (i >= 15 ? -20 : -90));
  const { seconds, stretches } = audibleOutside(envelope, [[0.1, 0.2]]);
  assert.equal(seconds, 0.25);
  assert.deepEqual(stretches, [{ fromSec: 0.75, toSec: 1 }]);
});

// Шаг сетки по умолчанию – windowBlocks/4. Утечка (блоки 2,3,8,9) набирает долю 4/8 только в окне
// [2,10): при шаге /2 (0,4,8,12) ни одно окно сетки её не видит, при /4 (0,2,4,…) – окно 2.
test('windowedMax steps by a quarter window by default', () => {
  const a = new Float64Array(20).fill(-90);
  const b = new Float64Array(20).fill(-90);
  [[2, -20, -18], [3, -32, -30], [8, -22, -20], [9, -36, -34]].forEach(([i, va, vb]) => { a[i] = va; b[i] = vb; });
  const found = windowedMax(a, b, 8);
  assert.ok(found, 'утечку должно найти окно с шагом в четверть');
  assert.equal(found.startBlock, 2);
  assert.equal(windowedMax(a, b, 8, { hop: 4 }), null);
});

// hop 0 или отрицательный раньше зацикливал поиск навсегда (start += 0), NaN молча давал null.
test('windowedMax refuses a hop that is not a positive integer', () => {
  const x = new Float64Array(20).fill(-20);
  // Порядок важен только для старого кода: NaN падает сразу, а 0/−1 там зацикливались бы.
  for (const hop of [NaN, 1.5, Infinity, '2', 0, -1]) {
    assert.throws(() => windowedMax(x, x, 8, { hop }), /windowedMax: hop должен быть целым числом ≥ 1/);
  }
  assert.doesNotThrow(() => windowedMax(x, x, 8, { hop: 1 }));
});

// --- Ревью задачи 25, п.4: причина сбоя ffmpeg – приоритет stderr → error.message → сигнал/статус ---

test('ffmpeg failures are errors, never a silent pass', () => {
  const failing = () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('No such file') });
  assert.throws(() => pcmFromFfmpeg(['-i', 'missing.wav'], { spawnImpl: failing }), /ffmpeg не смог отдать звук: No such file/);
  const ok = () => ({ status: 0, stdout: Buffer.from([1, 0, 255, 255]), stderr: Buffer.alloc(0) });
  assert.deepEqual([...pcmFromFfmpeg([], { spawnImpl: ok })], [1, -1]);
});

// Полная полоса для громкости (G8): float без округления до 16 бит на выходе. Сами фильтры
// вызывающий код переводит во float отдельно (aformat=sample_fmts=fltp, см. mix-gates.js).
test('floatPcmFromFfmpeg asks for float PCM at the given rate and channels and keeps ffmpeg errors', () => {
  const calls = [];
  const bytes = Buffer.alloc(12);
  [0.5, -1.25, 2].forEach((v, i) => bytes.writeFloatLE(v, i * 4));
  const ok = (command, args) => { calls.push(args); return { status: 0, stdout: bytes, stderr: Buffer.alloc(0) }; };
  assert.deepEqual([...floatPcmFromFfmpeg(['-i', 'x.wav'], { sampleRate: 48000, channels: 2, spawnImpl: ok })], [0.5, -1.25, 2]);
  assert.deepEqual(calls[0], ['-hide_banner', '-loglevel', 'error', '-i', 'x.wav',
    '-ac', '2', '-ar', '48000', '-f', 'f32le', '-acodec', 'pcm_f32le', '-']);
  const failing = () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('No such file') });
  assert.throws(() => floatPcmFromFfmpeg(['-i', 'x.wav'], { sampleRate: 48000, channels: 2, spawnImpl: failing }),
    /ffmpeg не смог отдать звук: No such file/);
  const noAudio = () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("Stream map '0:a:0' matches no streams.") });
  assert.throws(() => floatPcmFromFfmpeg(['-i', 'clip.mp4'], { sampleRate: 48000, channels: 2, spawnImpl: noAudio }),
    /в clip\.mp4 нет звуковой дорожки/);
  for (const bad of [{ sampleRate: 0, channels: 2 }, { sampleRate: 48000, channels: 0 }, { sampleRate: 48000.5, channels: 2 }, {}]) {
    assert.throws(() => floatPcmFromFfmpeg(['-i', 'x.wav'], { ...bad, spawnImpl: ok }), /floatPcmFromFfmpeg: sampleRate и channels/);
  }
});

// Быстрое чтение видом Float32Array на выровненном буфере и медленное побайтное на невыровненном
// дают одно и то же; хвост короче 4 байт отбрасывается.
test('floatPcmFromFfmpeg reads aligned and unaligned buffers alike and drops a partial tail', () => {
  const values = [0.25, -0.75, 1.5];
  const aligned = Buffer.alloc(14);
  values.forEach((v, i) => aligned.writeFloatLE(v, i * 4));
  const unaligned = Buffer.alloc(15).subarray(1);
  values.forEach((v, i) => unaligned.writeFloatLE(v, i * 4));
  assert.equal(unaligned.byteOffset % 4, 1);
  for (const stdout of [aligned, unaligned]) {
    const spawnImpl = () => ({ status: 0, stdout, stderr: Buffer.alloc(0) });
    const samples = floatPcmFromFfmpeg(['-i', 'x.wav'], { sampleRate: 48000, channels: 1, spawnImpl });
    assert.ok(samples instanceof Float32Array);
    assert.deepEqual([...samples], values);
  }
});

test('ENOENT gets a doctor hint, not the generic "ffmpeg не смог отдать звук"', () => {
  const enoent = () => ({
    error: Object.assign(new Error('spawnSync ffmpeg ENOENT'), { code: 'ENOENT' }),
    status: null, signal: null, stdout: undefined, stderr: undefined,
  });
  assert.throws(() => pcmFromFfmpeg(['-i', 'x.wav'], { spawnImpl: enoent }), /ffmpeg не найден; запусти npm run doctor/);
});

// Реальная находка ревью: пустой Buffer (stdout/stderr при таймауте или сигнале – не null, как при
// ENOENT, а именно пустой Buffer) сам по себе truthy – `result.stderr || result.error?.message`
// раньше ВСЕГДА выбирал его и терял настоящую причину из error.message (например ETIMEDOUT).
test('an empty stderr Buffer does not swallow a real error.message (timeout-style failure)', () => {
  const timedOut = () => ({
    error: new Error('spawnSync ffmpeg ETIMEDOUT'), status: null, signal: 'SIGKILL',
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
  });
  assert.throws(() => pcmFromFfmpeg(['-i', 'x.wav'], { spawnImpl: timedOut }), /ffmpeg не смог отдать звук: spawnSync ffmpeg ETIMEDOUT/);
});

// Ни stderr, ни error.message – последняя инстанция: голый сигнал, а не пустое сообщение.
test('a signal-killed process with no stderr and no error.message still names the signal', () => {
  const killed = () => ({ error: null, status: null, signal: 'SIGSEGV', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  assert.throws(() => pcmFromFfmpeg(['-i', 'x.wav'], { spawnImpl: killed }), /ffmpeg не смог отдать звук: процесс убит сигналом SIGSEGV/);
});

test('a plain non-zero status with nothing else falls back to naming the status', () => {
  const failed = () => ({ error: null, status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  assert.throws(() => pcmFromFfmpeg(['-i', 'x.wav'], { spawnImpl: failed }), /ffmpeg не смог отдать звук: процесс завершился со статусом 1/);
});

// «Stream map '' matches no streams» – ffmpeg так отказывает -map 0:a:0 на файле без звуковой
// дорожки; сообщение полезнее сырого текста ffmpeg с именем опции.
test('a file with no audio stream throws a clear message naming the file', () => {
  const noAudio = () => ({
    error: null, status: 234, signal: null, stdout: Buffer.alloc(0),
    stderr: Buffer.from("Stream map '' matches no streams.\nTo ignore this, add a trailing '?' to the map.\n"),
  });
  assert.throws(() => decodeAudio('clip.mp4', { spawnImpl: noAudio }), /в clip\.mp4 нет звуковой дорожки/);
  // Абсолютный путь не попадает в сообщение (его читают отчёты гейтов): только имя файла.
  const deep = path.join(os.tmpdir(), 'project-x', 'renders', 'clip.mp4');
  assert.throws(() => decodeAudio(deep, { spawnImpl: noAudio }), (error) => error.message === 'в clip.mp4 нет звуковой дорожки');
});

// --- Ревью задачи 25, п.5: decodeAudio – формат секунд, валидация durationSec, пустой отрезок ---

function captureArgv() {
  const calls = [];
  // Непустой stdout по умолчанию – иначе decodeAudio() сам бросил бы «нет звука в заданном
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
  assert.throws(() => decodeAudio('f.wav', { fromSec: 999, spawnImpl: empty }),
    /нет звука в заданном отрезке: f\.wav, с 999 с до конца/);
  assert.throws(() => decodeAudio('clip.mp4', { fromSec: 2.5, durationSec: 1, spawnImpl: empty }),
    /нет звука в заданном отрезке: clip\.mp4, 2\.5–3\.5 с/);
});

test('decodeAudio refuses a negative, non-finite or non-number fromSec', () => {
  const { spy } = captureArgv();
  for (const bad of [-0.5, NaN, Infinity, '1', null]) {
    assert.throws(() => decodeAudio('f.wav', { fromSec: bad, spawnImpl: spy }),
      /decodeAudio: fromSec должен быть конечным числом ≥ 0/);
  }
  assert.doesNotThrow(() => decodeAudio('f.wav', { fromSec: 0, spawnImpl: spy }));
});

// -ss ПЕРЕД -i (seek по контейнеру) сдвигал звук AAC-файлов без видео на задержку кодека (до ~21 мс).
// Seek после -i декодирует с начала и режет точно по сэмплу; при fromSec 0 -ss не нужен вовсе.
test('decodeAudio seeks after the input and omits -ss entirely from the start', () => {
  const { calls, spy } = captureArgv();
  decodeAudio('f.m4a', { spawnImpl: spy });
  decodeAudio('f.m4a', { durationSec: 2, spawnImpl: spy });
  decodeAudio('f.m4a', { fromSec: 1.5, durationSec: 2, spawnImpl: spy });
  assert.ok(!calls[0].includes('-ss'));
  assert.ok(!calls[1].includes('-ss'));
  assert.ok(calls[1].indexOf('-t') > calls[1].indexOf('-i'));
  const [, , third] = calls;
  assert.ok(third.indexOf('-ss') > third.indexOf('-i'), `-ss должен стоять после -i: ${third.join(' ')}`);
  assert.equal(third[third.indexOf('-ss') + 1], '1.5');
  assert.ok(third.indexOf('-t') > third.indexOf('-i'));
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
  // Первые 9 блоков – чистая тишина (-90). Понижающий ресемплинг 48 → 8 кГц размывает сам переход
  // ровно на один блок (у фильтра ресемплинга есть протяжка/lookahead в несколько сэмплов) – блок 9
  // на границе не проверяем строго, это ожидаемое смазывание реального декодирования, а не баг
  // decodeAudio. Блоки 10..19 – чистый тон (~-3 дБФС).
  for (let i = 0; i < 9; i += 1) assert.equal(envelope[i], -90, `блок ${i} должен быть тишиной`);
  for (let i = 10; i < 20; i += 1) assert.ok(Math.abs(envelope[i] + 3.01) < 0.2, `блок ${i}: ${envelope[i]}`);
});

// Реальная находка повторного ревью задачи 25: на m4a без видео -ss 0 перед -i сдвигал звук на
// ~21 мс раньше – блок 19 (0,95..1,00 с) перед тоном звучал на −6,9 дБФС вместо тишины.
test('a real audio-only m4a decodes sample-exact from the start and from a mid-file offset', (t) => {
  if (!toolAvailable('ffmpeg')) { t.skip('ffmpeg не найден в PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-audio-m4a-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const m4a = path.join(dir, 'silence-then-tone.m4a');
  runTool('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1',
    '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*440*t):s=48000:d=1',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1', '-c:a', 'aac',
    m4a,
  ], dir);
  // Первый сэмпл громче −12 дБФС – начало тона с точностью до сэмпла 8 кГц.
  const onsetSec = (samples) => samples.findIndex((v) => Math.abs(v) > 8192) / 8000;

  const whole = decodeAudio(m4a);
  const envelope = envelopeDb(whole);
  assert.ok(envelope[19] < -60, `блок 19 перед тоном должен быть тишиной: ${envelope[19]} дБФС`);
  assert.ok(envelope[21] > -6, `блок 21 – уже тон: ${envelope[21]} дБФС`);
  assert.ok(Math.abs(onsetSec(whole) - 1) < 0.002, `тон начинается на 1,0 с, а не ${onsetSec(whole)} с`);

  const tail = decodeAudio(m4a, { fromSec: 0.73 });
  const tailEnvelope = envelopeDb(tail);
  assert.ok(tailEnvelope[4] < -60, `блок 4 (0,20..0,25 с) до тона: ${tailEnvelope[4]} дБФС`);
  assert.ok(Math.abs(onsetSec(tail) - 0.27) < 0.002, `после fromSec 0,73 тон начинается на 0,27 с, а не ${onsetSec(tail)} с`);
});

// Звук, который в контейнере начинается позже видео (здесь через 0,48 с), обязан лечь на глобальный
// таймкод: без выравнивания первый сэмпл PCM – это уже 0,48 с ролика, и всё звучание «переезжало»
// раньше на 0,48 с, а -ss до начала звука не отрезал ничего.
test('a real source whose audio starts 0.48 s after the video decodes on the global timecode', (t) => {
  if (!toolAvailable('ffmpeg')) { t.skip('ffmpeg не найден в PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-audio-late-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mp4 = path.join(dir, 'late-audio.mp4');
  runTool('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25:d=3',
    '-itsoffset', '0.48', '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*1000*t)*gte(t,1.02)':s=48000:d=2.52",
    '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4], dir);
  const onsetSec = (samples) => samples.findIndex((v) => Math.abs(v) > 8192) / 8000;
  const raw = pcmFromFfmpeg(['-i', mp4, '-map', '0:a:0', '-vn']);
  assert.ok(onsetSec(raw) < 1.1, `сценарий: сырой PCM начинается вместе со звуком, тон на ${onsetSec(raw)} с`);
  const whole = decodeAudio(mp4);
  assert.ok(Math.abs(onsetSec(whole) - 1.5) < 0.002, `тон звучит на 1,5 с ролика, а не на ${onsetSec(whole)} с`);
  assert.ok(Math.abs(whole.length / 8000 - 3) < 0.03, `звук покрывает весь ролик от 0 с: ${whole.length / 8000} с`);
  const part = decodeAudio(mp4, { fromSec: 0.2, durationSec: 2 });
  assert.ok(Math.abs(onsetSec(part) - 1.3) < 0.002, `после fromSec 0,2 тон на 1,3 с, а не ${onsetSec(part)} с`);
  assert.equal(part.length, 16000);
});

// Резкая атака щелчка ровно на границе блока (0,5 с): AAC даёт предэхо в предыдущем блоке
// (около −47 дБФС, громче порога −60), и без запаса headSec этот блок засчитывался бы как звук вне
// эффектов у совершенно чистого слоя.
test('a real AAC click starting on a block boundary has no audible sound outside its span with defaults', (t) => {
  if (!toolAvailable('ffmpeg')) { t.skip('ffmpeg не найден в PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-audio-click-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const m4a = path.join(dir, 'click.m4a');
  runTool('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
    "aevalsrc='0.8*sin(2*PI*3000*t)*between(t,0.5,0.52)':s=48000:d=1.5", '-c:a', 'aac', m4a], dir);
  const envelope = envelopeDb(decodeAudio(m4a));
  const spans = [[0.5, 0.52]];
  assert.ok(envelope[9] > -60, `сценарий должен реально давать слышимое предэхо в блоке 9: ${envelope[9]} дБФС`);
  assert.equal(audibleOutside(envelope, spans, { headSec: 0 }).seconds, 0.05);
  assert.deepEqual(audibleOutside(envelope, spans), { seconds: 0, stretches: [] });
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
