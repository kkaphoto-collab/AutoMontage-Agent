// Задача 25: звук для гейтов в Node — PCM из ffmpeg, огибающая по 50 мс, корреляция Пирсона.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  blockDb, decodeAudio, envelopeDb, pcmFromFfmpeg, pearson, windowedMax,
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

test('ffmpeg failures are errors, never a silent pass', () => {
  const failing = () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('No such file') });
  assert.throws(() => pcmFromFfmpeg(['-i', 'missing.wav'], { spawnImpl: failing }), /ffmpeg не смог отдать звук: No such file/);
  const ok = () => ({ status: 0, stdout: Buffer.from([1, 0, 255, 255]), stderr: Buffer.alloc(0) });
  assert.deepEqual([...pcmFromFfmpeg([], { spawnImpl: ok })], [1, -1]);
});

// Отклонение от плана (оркестраторская правка): windowedMax теперь скользит внахлёст (по умолчанию
// hop = windowBlocks/2), а не окно-в-окно. Короткая утечка звука, которая физически попадает на
// границу двух соседних НЕперекрывающихся окон, размывается между ними — средняя громкость каждой
// половинки падает ниже minDbA, и окно целиком пропускается, хотя утечка на экране реально была.
// С нахлёстом появляется окно, которое ловит всю утечку целиком.
test('windowedMax finds a loud correlated leak straddling a non-overlapping window boundary only with the default overlap', () => {
  // Утечка — блоки 2..5 (4 блока, ровно размер окна), a и b на ней связаны линейно (аффинно) —
  // pearson должен дать ровно 1, если утечка попадёт в окно целиком.
  const a = Float64Array.from([-90, -90, -50, -30, -50, -30, -90, -90]);
  const b = Float64Array.from([-90, -90, -45, -35, -45, -35, -90, -90]);
  // Без нахлёста (hop = размер окна) окна 0..4 и 4..8 берут утечку только наполовину каждое:
  // среднее -65 дБФС в обоих — ниже дефолтного minDbA (-60), оба окна пропускаются, утечка не найдена.
  assert.equal(windowedMax(a, b, 4, { hop: 4 }), null);
  // С дефолтным hop (50 % внахлёст, hop=2) окно, стартующее с блока 2, ловит утечку целиком.
  const found = windowedMax(a, b, 4);
  assert.ok(found, 'внахлёст обязан найти утечку, которую нашёл шаг без перекрытия');
  assert.equal(found.startBlock, 2);
  assert.ok(Math.abs(found.r - 1) < 1e-9);
});

// Реальный ffmpeg: генерируем 1 с полношкального синуса через lavfi (aevalsrc — у источника sine
// нет параметра amplitude, его выход заметно тише полной шкалы) во временный WAV, декодируем через
// decodeAudio и проверяем настоящую огибающую: ~-3 дБФС на весь секундный клип и 20 полусекундных...
// 50-мс блоков (8000 сэмплов / 400 = 20). Чисто и без сети — временная папка ОС, файл не попадает в Git.
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
