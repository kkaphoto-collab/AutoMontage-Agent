// Задача 27: G8 «Голос и музыка» – разрыв громкости (LU, K-взвешивание BS.1770) между голосом после
// finish.js и музыкой после того же sidechain, что в mix-music.js; только на участках речи.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { MIX_AUDIO_FORMAT, buildMusicFilter, mixMusicCommand, mixMusicInputArgs, parseMixOptions } = require('../scripts/mix-music');
const { floatPcmFromFfmpeg } = require('../scripts/qa/audio');
const {
  K_WEIGHTING, blockPowers, gateVoiceMusic, loudnessGap, measureVoiceMusic, speechWindows,
} = require('../scripts/qa/mix-gates');
const { getProfile } = require('../scripts/qa/profiles');

const avatar = getProfile('avatar');
const hasFfmpeg = toolAvailable('ffmpeg');
// Явный тестовый коридор для проверок логики G8: они не зависят от откалиброванного числа профиля avatar.
const corridor = { ...avatar, voiceMusic: { stopLow: 3, warnLow: 9, target: 12, warnHigh: 15, stopHigh: 20 } };
// Замер утверждённого эталонного preview (Task 47, 29.09.2026): разрыв голоса и музыки под речью, LU.
const REFERENCE_GAP_LU = 37.95;

// Параметры музыки, как их собирает buildLessonMusicMixArgs для preview.
const BRIEF_ARGS = ['--gain', '-22', '--start', '24', '--rate', '1.06', '--fade-in', '0.15', '--fade-out', '0.8',
  '--duration', '53.6', '--threshold', '0.0398', '--ratio', '8', '--attack', '5', '--release', '300'];

// Подмена ffmpeg: запоминает argv и отдаёт немного тишины (float PCM).
function spawnSpy() {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: Buffer.alloc(16000), stderr: Buffer.alloc(0) };
  };
  return { calls, spawnImpl };
}

test('music stem graph keeps the real sidechain and drops the voice mix', () => {
  const options = parseMixOptions(['--gain', '-16', '--threshold', '0.0100', '--ratio', '4', '--duration', '10']);
  const stem = buildMusicFilter(options, { stem: 'music' });
  assert.match(stem, /sidechaincompress=threshold=0\.01:ratio=4/);
  assert.match(stem, /\[aout\]$/);
  assert.doesNotMatch(stem, /amix/);
  assert.match(buildMusicFilter(options), /amix=inputs=2/);
});

test('the normal preview/final graph stays byte-identical', () => {
  assert.equal(
    buildMusicFilter(parseMixOptions(['--gain', '-16', '--threshold', '0.0100', '--ratio', '4', '--duration', '10'])),
    '[1:a]volume=-16dB,aformat=sample_rates=44100:channel_layouts=stereo[m];'
    + '[0:a]aformat=sample_rates=44100:channel_layouts=stereo,asplit=2[v][sc];'
    + '[m][sc]sidechaincompress=threshold=0.01:ratio=4:attack=5:release=300:level_sc=1[duck];'
    + '[v][duck]amix=inputs=2:duration=first:normalize=0,apad[aout]',
  );
  assert.equal(
    buildMusicFilter(parseMixOptions(BRIEF_ARGS)),
    '[1:a]atrim=start=24,asetpts=PTS-STARTPTS,atempo=1.06,volume=-22dB,afade=t=in:st=0:d=0.15,'
    + 'afade=t=out:st=52.8:d=0.8,aformat=sample_rates=44100:channel_layouts=stereo[m];'
    + '[0:a]aformat=sample_rates=44100:channel_layouts=stereo,asplit=2[v][sc];'
    + '[m][sc]sidechaincompress=threshold=0.0398:ratio=8:attack=5:release=300:level_sc=1[duck];'
    + '[v][duck]amix=inputs=2:duration=first:normalize=0,apad[aout]',
  );
  assert.deepEqual(mixMusicCommand('voice.mp4', 'music.mp3', 'out.mp4', 'GRAPH').args, [
    '-y', '-i', path.resolve('voice.mp4'), '-stream_loop', '-1', '-i', path.resolve('music.mp3'),
    '-filter_complex', 'GRAPH', '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-shortest', '-movflags', '+faststart', path.resolve('out.mp4'),
  ]);
});

test('the music stem reuses the exact music chain and sidechain of the preview graph', () => {
  const options = parseMixOptions(BRIEF_ARGS);
  const [normalMusic, , normalSidechain] = buildMusicFilter(options).split(';');
  const stem = buildMusicFilter(options, { stem: 'music' }).split(';');
  assert.deepEqual(stem, [
    normalMusic,
    '[0:a]aformat=sample_rates=44100:channel_layouts=stereo[sc]',
    normalSidechain.replace(/\[duck\]$/, '[aout]'),
  ]);
  assert.throws(() => buildMusicFilter(options, { stem: 'voice' }), /stem/);
});

test('the music stem is measured with the same ffmpeg inputs as the preview music mix', () => {
  const { calls, spawnImpl } = spawnSpy();
  const mixOptions = parseMixOptions(BRIEF_ARGS);
  measureVoiceMusic({ voicePath: 'stage/finished.mp4', musicPath: 'assets/music.mp3', mixOptions,
    durationSec: 0.1 + 0.2, windows: [{ s: 0, e: 1 }], spawnImpl });
  assert.equal(calls.length, 2);
  const production = mixMusicCommand('stage/finished.mp4', 'assets/music.mp3', 'out.mp4', buildMusicFilter(mixOptions)).args;
  const inputs = (args) => args.slice(args.indexOf('-i'), args.indexOf('-filter_complex'));
  const output = ['-ac', '2', '-ar', '48000', '-f', 'f32le', '-acodec', 'pcm_f32le', '-'];
  const stem = calls.find((call) => call.args.includes('-filter_complex')).args;
  // Входы и их опции (порядок, -stream_loop, абсолютные пути) – один в один; граф – stem без
  // изменений, к которому дописано только K-взвешивание на 48 кГц во float.
  assert.deepEqual(inputs(stem), inputs(production));
  assert.equal(stem[stem.indexOf('-filter_complex') + 1],
    `${buildMusicFilter(mixOptions, { stem: 'music' })};[aout]aresample=48000,aformat=sample_fmts=fltp,${K_WEIGHTING}[k]`);
  assert.deepEqual(stem.slice(stem.indexOf('-map')), ['-map', '[k]', '-t', '0.3', ...output]);
  // Голос проходит тот же формат, что ветка [v] в графе микса, и то же K-взвешивание.
  const voice = calls.find((call) => !call.args.includes('-filter_complex')).args;
  assert.deepEqual(voice.slice(voice.indexOf('-i')), ['-i', path.resolve('stage/finished.mp4'), '-map', '0:a:0', '-vn',
    '-af', `${MIX_AUDIO_FORMAT},aresample=48000,aformat=sample_fmts=fltp,${K_WEIGHTING}`, '-t', '0.3', ...output]);
  assert.ok(buildMusicFilter(mixOptions).split(';')[1].startsWith(`[0:a]${MIX_AUDIO_FORMAT},asplit=2[v]`));
  assert.ok(calls.every((call) => call.command === 'ffmpeg'));
});

// Интегральная громкость ebur128 (I, LUFS) ровного стерео-сигнала – эталон ffmpeg для сравнения.
function ebur128(inputArgs, filter) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...inputArgs, ...filter, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const summary = result.stderr.split('Summary:')[1] || '';
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)[1]);
}
const lufsOf = (powers) => -0.691 + 10 * Math.log10(powers.reduce((sum, p) => sum + p, 0) / powers.length);

// Точные коэффициенты BS.1770 для 48 кГц. Приближение highshelf+highpass (RBJ) расходится с ebur128
// до 0,46 LU у полки 1,7 кГц – тест это ловит.
test('K weighting reproduces ffmpeg ebur128 across the band', { skip: !hasFfmpeg }, () => {
  for (const frequency of [40, 1000, 1682, 8000]) {
    const input = ['-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=4,pan=stereo|c0=c0|c1=c0`];
    const reference = ebur128(input, ['-af', 'ebur128']);
    const ours = lufsOf(blockPowers(floatPcmFromFfmpeg([...input, '-af', `aresample=48000,${K_WEIGHTING}`], { sampleRate: 48000, channels: 2 })));
    assert.ok(Math.abs(ours - reference) <= 0.1, `${frequency} Гц: K-взвешивание ${ours.toFixed(2)} против ebur128 ${reference} LUFS`);
  }
});

// Главное обещание замера: музыка в нём – ровно то, что микс preview прибавляет к голосу, с ducking
// и зацикленной музыкой. Настоящая команда mix-music, только звук без потерь (PCM в MOV вместо AAC),
// чтобы сравнить по сэмплам: микс = голос + музыка замера (K-взвешивание линейно).
test('the measured music is exactly what the preview mix adds to the voice', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mix-equal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const voice = path.join(dir, 'finished.mp4');
  const music = path.join(dir, 'music.wav');
  const mixed = path.join(dir, 'mixed.mov');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25:d=6',
    '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*220*t)*gt(sin(2*PI*0.5*t),0)':s=48000:d=6",
    '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', voice]);
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=2.3', '-ac', '2', music]);
  const mixOptions = parseMixOptions(['--gain', '-6', '--threshold', '0.0398', '--ratio', '8', '--duration', '6']);
  const production = mixMusicCommand(voice, music, mixed, buildMusicFilter(mixOptions)).args;
  const aac = production.indexOf('aac');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...production.slice(0, aac), 'pcm_s16le', ...production.slice(aac + 3, -1), mixed]);

  const captured = [];
  const spawnImpl = (command, args, options) => {
    const result = spawnSync(command, args, options);
    captured.push(result.stdout);
    return result;
  };
  measureVoiceMusic({ voicePath: voice, musicPath: music, mixOptions, durationSec: 6, windows: [{ s: 0, e: 6 }], spawnImpl });
  const floats = (bytes) => Float32Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
  const [voicePcm, musicPcm] = captured.map(floats);
  const mixedPcm = floatPcmFromFfmpeg(['-i', mixed, '-map', '0:a:0', '-vn', '-af', `aresample=48000,${K_WEIGHTING}`, '-t', '6'],
    { sampleRate: 48000, channels: 2 });
  for (const pcm of [voicePcm, musicPcm, mixedPcm]) assert.equal(pcm.length, 6 * 48000 * 2);
  let worst = 0;
  for (let i = 0; i < mixedPcm.length; i += 1) worst = Math.max(worst, Math.abs(mixedPcm[i] - voicePcm[i] - musicPcm[i]));
  assert.ok(worst < 5e-4, `микс отличается от голоса + музыки замера на ${worst}`);
  // Сценарий действительно проверяет sidechain: под речью (0,5 с) музыка заметно тише, чем в паузе (3,5 с).
  const powers = blockPowers(musicPcm);
  assert.ok(10 * Math.log10(powers[70] / powers[10]) > 8, `ducking: ${powers[10]} под речью, ${powers[70]} в паузе`);
});

test('measureVoiceMusic refuses missing music options, a bad duration and an empty decode', () => {
  const { spawnImpl } = spawnSpy();
  const base = { voicePath: 'v.mp4', musicPath: 'm.mp3', mixOptions: parseMixOptions([]), durationSec: 10, windows: [], spawnImpl };
  assert.throws(() => measureVoiceMusic({ ...base, mixOptions: null }), /measureVoiceMusic: нужны mixOptions/);
  for (const durationSec of [0, -1, NaN, Infinity]) {
    assert.throws(() => measureVoiceMusic({ ...base, durationSec }), /measureVoiceMusic: durationSec/);
  }
  assert.throws(() => measureVoiceMusic({ ...base, windows: null }), /measureVoiceMusic: windows/);
  // Пустой PCM – это «ffmpeg ничего не отдал», а не «музыки нет»: иначе замер тихо пропустил бы G8.
  const empty = () => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  assert.throws(() => measureVoiceMusic({ ...base, spawnImpl: empty }), /нет звука голоса/);
  const noMusic = (command, args) => (args.includes('-filter_complex') ? empty() : spawnSpy().spawnImpl(command, args));
  assert.throws(() => measureVoiceMusic({ ...base, spawnImpl: noMusic }), /нет звука музыки после sidechain/);
  // Сообщение уходит в подсказку G8 и отчёт preview: только имя файла, без папки проекта.
  const deep = { ...base, voicePath: path.join(os.tmpdir(), 'project-x', 'stage', 'finished.mp4'), musicPath: path.join(os.tmpdir(), 'project-x', 'music.mp3') };
  assert.throws(() => measureVoiceMusic({ ...deep, spawnImpl: empty }), (error) => error.message === 'нет звука голоса в finished.mp4');
  assert.throws(() => measureVoiceMusic({ ...deep, spawnImpl: noMusic }), (error) => error.message === 'нет звука музыки после sidechain: music.mp3');
});

test('speech windows merge close words, drop blips and follow the preview range', () => {
  const words = [{ s: 1, e: 1.4 }, { s: 1.5, e: 2 }, { s: 3, e: 3.1 }, { s: 5, e: 6 }];
  assert.deepEqual(speechWindows(words, { fromSec: 0.5, toSec: 5.5 }), [{ s: 0.5, e: 1.5 }, { s: 4.5, e: 5 }]);
  assert.deepEqual(speechWindows([]), []);
  // Слово, начатое до начала preview, обрезается по fromSec, а не уходит в минус.
  assert.deepEqual(speechWindows([{ s: 0.2, e: 1 }], { fromSec: 0.5, toSec: 3 }), [{ s: 0, e: 0.5 }]);
  // Пауза ровно 0,25 с сливает слова, хотя 0,55 − 0,3 в двоичной арифметике чуть больше 0,25.
  assert.deepEqual(speechWindows([{ s: 0, e: 0.3 }, { s: 0.55, e: 0.7 }]), [{ s: 0, e: 0.7 }]);
  // Окно ровно 0,3 с остаётся (2,4 − 2,1 в двоичной арифметике чуть меньше 0,3), 0,29 с – нет.
  assert.deepEqual(speechWindows([{ s: 2.1, e: 2.4 }]), [{ s: 2.1, e: 2.4 }]);
  assert.deepEqual(speechWindows([{ s: 2.1, e: 2.39 }]), []);
});

test('block powers sum both channels over 50 ms blocks at 48 kHz', () => {
  // 2,5 блока стерео: L = 0,5 и R = 0 в первом блоке, L = R = 0,5 во втором; хвост отбрасывается.
  const frames = 2400 * 2 + 1200;
  const pcm = Float32Array.from({ length: frames * 2 }, (_, i) => (i % 2 === 0 || i >= 4800 ? 0.5 : 0));
  const powers = blockPowers(pcm);
  assert.equal(powers.length, 2);
  assert.ok(Math.abs(powers[0] - 0.25) < 1e-9, `блок 0: ${powers[0]}`);
  assert.ok(Math.abs(powers[1] - 0.5) < 1e-9, `блок 1: ${powers[1]}`);
});

test('the loudness gap is the power ratio over whole speech-window blocks', () => {
  const voice = new Float64Array(40).fill(1e-2);
  const music = Float64Array.from({ length: 40 }, (_, b) => (b < 20 ? 1e-4 : 1e-3));
  const quiet = loudnessGap(voice, music, [{ s: 0, e: 1 }]);
  assert.ok(Math.abs(quiet.gapLu - 20) < 1e-9, `разрыв ${quiet.gapLu}`);
  assert.equal(quiet.blocks, 20);
  assert.ok(Math.abs(quiet.voiceLufs - (-20.691)) < 1e-9);
  assert.ok(Math.abs(quiet.musicLufs - (-40.691)) < 1e-9);
  // Два окна: мощности складываются, а не усредняются по окнам.
  const both = loudnessGap(voice, music, [{ s: 0.9, e: 1 }, { s: 1, e: 2 }]);
  assert.ok(Math.abs(both.gapLu - 10 * Math.log10((22 * 1e-2) / (2 * 1e-4 + 20 * 1e-3))) < 1e-9);
  // Только целые блоки внутри окна: 0,93–1,07 с берёт один блок 0,95–1,00 (−20 LU) и 1,00–1,05 (−10 LU).
  const edges = loudnessGap(voice, music, [{ s: 0.93, e: 1.07 }]);
  assert.equal(edges.blocks, 2);
  assert.ok(Math.abs(edges.gapLu - 10 * Math.log10(2e-2 / 1.1e-3)) < 1e-9);
  // Граница блока с шумом плавающей точки (0,1 + 0,2 и 1,4 − 0,1 чуть в стороне от 0,3 и 1,3) – всё
  // равно граница блока.
  assert.equal(loudnessGap(voice, music, [{ s: 0.1 + 0.2, e: 1.4 - 0.1 }]).blocks, 20);
  // Блоки считаются только там, где есть обе дорожки.
  assert.equal(loudnessGap(voice, music.subarray(0, 30), [{ s: 0, e: 2 }]).blocks, 30);
  assert.equal(loudnessGap(voice.subarray(0, 25), music, [{ s: 0, e: 2 }]).blocks, 25);
  // Без окон и за концом дорожки – нет речи; цифровая тишина музыки – Infinity.
  assert.equal(loudnessGap(voice, music, []), null);
  assert.equal(loudnessGap(voice, music, [{ s: 5, e: 6 }]), null);
  const silent = loudnessGap(voice, new Float64Array(40), [{ s: 0, e: 2 }]);
  assert.equal(silent.gapLu, Infinity);
  assert.equal(silent.musicLufs, -Infinity);
  for (const broken of [[{ s: NaN, e: 1 }], [{ s: -0.5, e: 1 }], [{ s: 1, e: 0.5 }], [{ s: 0, e: Infinity }], [null]]) {
    assert.throws(() => loudnessGap(voice, music, broken), /окна речи повреждены/);
  }
});

// Голос и музыка оба в цифровой тишине: сначала вердикт про голос – без голоса разрыв не значит ничего,
// а «музыки под речью нет» отправило бы чинить музыку.
test('silent voice and silent music read as a silent voice, not as missing music', () => {
  const zeros = new Float64Array(40);
  const both = loudnessGap(zeros, zeros, [{ s: 0, e: 2 }]);
  assert.equal(both.gapLu, -Infinity);
  assert.equal(both.voiceLufs, -Infinity);
  assert.equal(both.musicLufs, -Infinity);
  const g = gateVoiceMusic(both, avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 'голос не звучит');
  assert.doesNotMatch(g.hint, /музык/);
  // Замер, собранный не нашим loudnessGap, с тихим голосом и gapLu Infinity – тоже вердикт про голос.
  assert.equal(gateVoiceMusic({ gapLu: Infinity, voiceLufs: -Infinity, musicLufs: -Infinity, blocks: 40 }, avatar).value,
    'голос не звучит');
});

// Старая медиана по блокам со слышимой музыкой здесь давала 0 дБ и «музыка громкая»: музыка звучит
// вровень с голосом всего в 2 блоках из 400, в остальных её нет.
test('music audible in a few blocks only reads as barely audible, never as loud', () => {
  const voice = new Float64Array(400).fill(1e-2);
  const music = Float64Array.from(voice, (p, b) => (b === 100 || b === 300 ? p : 0));
  const result = loudnessGap(voice, music, [{ s: 0, e: 20 }]);
  assert.ok(Math.abs(result.gapLu - 23.01) < 0.01, `разрыв ${result.gapLu}`);
  const g = gateVoiceMusic(result, corridor);
  assert.equal(g.status, 'fail');
  assert.match(g.hint, /почти не слышно/);
  assert.doesNotMatch(g.hint, /громк/);
});

test('G8 statuses follow the profile corridor and speak in LU with commas', () => {
  const profile = { ...avatar, voiceMusic: { stopLow: 3, warnLow: 7.5, target: 10.5, warnHigh: 13.5, stopHigh: 18.5 } };
  const at = (gapLu) => gateVoiceMusic({ gapLu, voiceLufs: -14, musicLufs: -14 - gapLu, blocks: 100 }, profile);
  assert.deepEqual([2.9, 3, 7.4, 7.5, 10.5, 13.5, 13.6, 18.5, 18.6].map((m) => at(m).status),
    ['fail', 'warn', 'warn', 'pass', 'pass', 'pass', 'warn', 'warn', 'fail']);
  const good = at(10.54);
  assert.equal(good.id, 'G8');
  assert.equal(good.title, 'Голос и музыка');
  assert.equal(good.value, 10.5);
  assert.equal(good.unit, 'LU');
  assert.equal(good.threshold, '7,5–13,5 LU, стоп < 3 или > 18,5');
  assert.equal(good.hint, 'музыка на 10,5 LU тише голоса');
  assert.equal(at(2).hint, 'музыка на 2 LU тише голоса: слишком громко под речью – уменьшите music.gainDb примерно на 8,5 дБ (цель 10,5 LU)');
  assert.equal(at(-3.26).hint, 'музыка на 3,3 LU громче голоса: слишком громко под речью – уменьшите music.gainDb примерно на 13,8 дБ (цель 10,5 LU)');
  assert.equal(at(0.01).hint.split(':')[0], 'музыка вровень с голосом');
  assert.equal(at(16).hint, 'музыка на 16 LU тише голоса: музыку почти не слышно – увеличьте music.gainDb примерно на 5,5 дБ (цель 10,5 LU)');
  const none = gateVoiceMusic({ gapLu: Infinity, voiceLufs: -14, musicLufs: -Infinity, blocks: 100 }, profile);
  assert.equal(none.status, 'fail');
  assert.equal(none.value, 'музыки под речью нет');
  assert.equal(none.unit, '');
  assert.match(none.hint, /музыки под речью нет/);
  const mute = gateVoiceMusic({ gapLu: -Infinity, voiceLufs: -Infinity, musicLufs: -20, blocks: 100 }, profile);
  assert.equal(mute.status, 'fail');
  assert.equal(mute.value, 'голос не звучит');
  const noSpeech = gateVoiceMusic(null, profile);
  assert.equal(noSpeech.status, 'skipped');
  assert.match(noSpeech.hint, /нет речи/);
  assert.match(gateVoiceMusic(null, profile, { hasMusic: false }).hint, /нет музыки/);
  // Замер старой формы ({ median }) – ошибка вызова, а не тихий pass.
  assert.throws(() => gateVoiceMusic({ median: 0.5, blocks: 100 }, profile), /gapLu/);
});

// Решение владельца 29.09.2026 «по эталону»: коридор avatar – замер утверждённого эталонного preview
// ±3 LU (стоп < 3 или > эталон + 8). Просьба «музыку слышнее» снижает разрыв на 6–8 LU и даёт
// предупреждение, а не стоп.
test('the avatar corridor is calibrated on the approved reference preview', () => {
  assert.deepEqual({ ...avatar.voiceMusic }, { stopLow: 3, warnLow: 35, target: 38, warnHigh: 41, stopHigh: 46 });
  const at = (gapLu) => gateVoiceMusic({ gapLu, voiceLufs: -14.6, musicLufs: -14.6 - gapLu, blocks: 1605 }, avatar, { gainDb: -16 });
  const reference = at(REFERENCE_GAP_LU);
  assert.equal(reference.status, 'pass');
  assert.equal(reference.hint, 'музыка на 38 LU тише голоса');
  assert.equal(reference.threshold, '35–41 LU, стоп < 3 или > 46');
  for (const louder of [6, 8]) assert.equal(at(REFERENCE_GAP_LU - louder).status, 'warn', `музыка слышнее на ${louder} LU`);
  assert.equal(at(2.9).status, 'fail');
  assert.equal(at(46.1).status, 'fail');
});

// Коридор live не откалиброван (D-035: шкалы старого qa:preview и G8 расходятся на десятки единиц):
// выход из него – предупреждение без совета по music.gainDb, стоп остаётся только у avatar.
test('the uncalibrated live corridor never stops and gives no gain advice', () => {
  const live = getProfile('live');
  assert.equal(live.voiceMusic.calibrated, false);
  assert.notEqual(avatar.voiceMusic.calibrated, false);
  const at = (gapLu) => gateVoiceMusic({ gapLu, voiceLufs: -14, musicLufs: -14 - gapLu, blocks: 100 }, live, { gainDb: -12 });
  for (const gapLu of [30, 2, 20, -1]) {
    const g = at(gapLu);
    assert.equal(g.status, 'warn', `${gapLu} LU`);
    assert.match(g.hint, /коридор live не откалиброван/u);
    assert.doesNotMatch(g.hint, /music\.gainDb|увеличьте|уменьшите/u);
  }
  assert.equal(at(15).status, 'pass');
  assert.equal(at(30).value, 30);
  // Поломки звука – не вопрос коридора: они по-прежнему стоп.
  assert.equal(gateVoiceMusic({ gapLu: -Infinity, voiceLufs: -Infinity, musicLufs: -20, blocks: 100 }, live).status, 'fail');
  assert.equal(gateVoiceMusic({ gapLu: Infinity, voiceLufs: -14, musicLufs: -Infinity, blocks: 100 }, live).status, 'fail');
  // Тот же разрыв на avatar – стоп, как раньше.
  assert.equal(gateVoiceMusic({ gapLu: 2, voiceLufs: -14, musicLufs: -16, blocks: 100 }, avatar).status, 'fail');
});

// Схема brief ограничивает music.gainDb диапазоном −60…0 дБ: совет не выводит за край, а когда края
// не хватает – предлагает трек громче/тише или мягче/сильнее ducking.
test('G8 advice never pushes music.gainDb outside −60…0 dB', () => {
  const profile = { ...avatar, voiceMusic: { stopLow: 3, warnLow: 7.5, target: 10.5, warnHigh: 13.5, stopHigh: 18.5 } };
  const at = (gapLu, gainDb) => gateVoiceMusic({ gapLu, voiceLufs: -14, musicLufs: -14 - gapLu, blocks: 100 }, profile,
    { gainDb }).hint;
  // Запаса хватает – совет прежний.
  assert.equal(at(16, -22), 'музыка на 16 LU тише голоса: музыку почти не слышно – увеличьте music.gainDb примерно на 5,5 дБ (цель 10,5 LU)');
  assert.equal(at(2, -20), 'музыка на 2 LU тише голоса: слишком громко под речью – уменьшите music.gainDb примерно на 8,5 дБ (цель 10,5 LU)');
  // Ровно до края – ещё обычный совет.
  assert.match(at(16, -5.5), /увеличьте music\.gainDb примерно на 5,5 дБ/);
  assert.match(at(2, -51.5), /уменьшите music\.gainDb примерно на 8,5 дБ/);
  // Край не даёт всего шага: до края и что делать дальше.
  assert.equal(at(16, -2), 'музыка на 16 LU тише голоса: музыку почти не слышно – увеличьте music.gainDb до 0 дБ (выше схема не даёт); '
    + 'не хватит ещё ~3,5 дБ – возьмите трек громче или ослабьте ducking: выше ducking.thresholdDb или меньше ducking.ratio (цель 10,5 LU)');
  assert.equal(at(2, -55), 'музыка на 2 LU тише голоса: слишком громко под речью – уменьшите music.gainDb до −60 дБ (ниже схема не даёт); '
    + 'не хватит ещё ~3,5 дБ – возьмите трек тише или усильте ducking: ниже ducking.thresholdDb или больше ducking.ratio (цель 10,5 LU)');
  // Уже на краю – только трек и ducking.
  assert.equal(at(16, 0), 'музыка на 16 LU тише голоса: музыку почти не слышно – music.gainDb уже 0 дБ (максимум схемы): '
    + 'возьмите трек громче или ослабьте ducking: выше ducking.thresholdDb или меньше ducking.ratio (цель 10,5 LU)');
  assert.equal(at(2, -60), 'музыка на 2 LU тише голоса: слишком громко под речью – music.gainDb уже −60 дБ (минимум схемы): '
    + 'возьмите трек тише или усильте ducking: ниже ducking.thresholdDb или больше ducking.ratio (цель 10,5 LU)');
  for (const hint of [at(16, -2), at(16, 0)]) assert.doesNotMatch(hint, /до [1-9]/);
  // В коридоре gainDb не нужен и не мешает; сломанное значение – ошибка вызова.
  assert.equal(at(10.5, 0), 'музыка на 10,5 LU тише голоса');
  for (const gainDb of [NaN, Infinity, '−16']) assert.throws(() => at(16, gainDb), /gateVoiceMusic: gainDb/);
});

// Две «музыки» с совсем разными спектрами: низкий гул и яркие хэты (шум выше 5 кГц щелчками).
// Медиана разрывов по блокам на 8 кГц расходилась с LUFS на +0,4…+9 дБ; K-взвешенный разрыв обязан
// совпасть с разницей ebur128 тех же дорожек на участке речи.
test('the K-weighted gap matches the ebur128 loudness gap on a low and a bright track', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mix-spectra-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const voice = path.join(dir, 'voice.wav');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.25*(sin(2*PI*200*t)+0.5*sin(2*PI*400*t)+0.3*sin(2*PI*1200*t))*(0.6+0.4*sin(2*PI*4.7*t))':s=48000:d=10", '-ac', '2', voice]);
  const tracks = {
    low: ['anoisesrc=color=brown:sample_rate=48000:duration=10:amplitude=0.5:seed=4', 'lowpass=f=150'],
    bright: ["aevalsrc='(random(0)*2-1)*exp(-mod(t,0.25)/0.03)':s=48000:d=10", 'highpass=f=5000'],
  };
  const windows = [{ s: 0.5, e: 9.5 }];
  const mixOptions = parseMixOptions(['--gain', '-12', '--threshold', '0.0398', '--ratio', '8', '--duration', '10']);
  const cut = 'atrim=0.5:9.5,asetpts=N/SR/TB,ebur128';
  for (const [name, [source, filter]] of Object.entries(tracks)) {
    const music = path.join(dir, `${name}.wav`);
    runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source, '-af', filter, '-ac', '2', music]);
    const result = measureVoiceMusic({ voicePath: voice, musicPath: music, mixOptions, durationSec: 10, windows });
    const voiceLufs = ebur128(['-i', voice], ['-af', `${MIX_AUDIO_FORMAT},${cut}`]);
    const musicLufs = ebur128([...mixMusicInputArgs(voice, music)],
      ['-filter_complex', `${buildMusicFilter(mixOptions, { stem: 'music' })};[aout]${cut}[e]`, '-map', '[e]']);
    const reference = voiceLufs - musicLufs;
    assert.ok(Math.abs(result.gapLu - reference) <= 0.5, `${name}: разрыв ${result.gapLu.toFixed(2)} LU, ebur128 ${reference.toFixed(1)} LU`);
    assert.ok(Math.abs(result.voiceLufs - voiceLufs) <= 0.5, `${name}: голос ${result.voiceLufs.toFixed(2)} против ${voiceLufs} LUFS`);
  }
});

test('BAD CASE: music at the voice level stops the preview; a gap at the corridor target passes', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mix-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const voice = path.join(dir, 'voice.wav');
  const music = path.join(dir, 'music.wav');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=10', '-af', 'volume=-6dB', voice]);
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-af', 'volume=-6dB', music]);
  const windows = [{ s: 0.5, e: 9.5 }];
  const measure = (gain) => measureVoiceMusic({ voicePath: voice, musicPath: music, durationSec: 10, windows,
    mixOptions: parseMixOptions(['--gain', String(gain), '--threshold', '1', '--ratio', '1', '--duration', '10']) });
  const level = gateVoiceMusic(measure(0), corridor);
  assert.equal(level.status, 'fail');
  assert.equal(level.unit, 'LU');
  assert.ok(Math.abs(level.value) < 1, `музыка вровень с голосом: ${level.value} LU`);
  assert.match(level.hint, /уменьшите music\.gainDb/);
  const quiet = gateVoiceMusic(measure(-12), corridor);
  assert.equal(quiet.status, 'pass');
  assert.ok(Math.abs(quiet.value - 12) < 1, `разрыв 12 LU: ${quiet.value} LU`);
});

test('inaudible music (gain −60) under ducking stops as barely audible, never as loud', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mix-quiet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const voice = path.join(dir, 'voice.wav');
  const music = path.join(dir, 'music.wav');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.3*sin(2*PI*220*t)*gt(sin(2*PI*0.5*t),0)':s=48000:d=4", '-ac', '2', voice]);
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=4:amplitude=0.5:seed=2', '-ac', '2', music]);
  const result = measureVoiceMusic({ voicePath: voice, musicPath: music, durationSec: 4, windows: [{ s: 0.1, e: 0.9 }, { s: 2.1, e: 2.9 }],
    mixOptions: parseMixOptions(['--gain', '-60', '--threshold', '0.0501', '--ratio', '6', '--duration', '4']) });
  assert.ok(result.gapLu > corridor.voiceMusic.stopHigh, `разрыв ${result.gapLu} LU`);
  const g = gateVoiceMusic(result, corridor);
  assert.equal(g.status, 'fail');
  assert.match(g.hint, /почти не слышно/);
  assert.doesNotMatch(g.hint, /громк/);
});

// Моно-голос микс играет как его стерео-копию (aformat: −3 дБ на канал), и замер должен слышать
// то же самое. finish.js и так отдаёт стерео – это страховка на случай моно-голоса.
test('a mono voice measures like the stereo copy the mix actually plays', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mix-channels-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tone = (file, frequency, channels) => runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `sine=frequency=${frequency}:sample_rate=48000:duration=4`, '-af', 'volume=-6dB', '-ac', String(channels), path.join(dir, file)]);
  tone('mono.wav', 220, 1);
  tone('stereo.wav', 220, 2);
  tone('music.wav', 220, 1);
  const measure = (voice) => measureVoiceMusic({ voicePath: path.join(dir, voice), musicPath: path.join(dir, 'music.wav'),
    durationSec: 4, windows: [{ s: 0.5, e: 3.5 }], mixOptions: parseMixOptions(['--gain', '-10', '--threshold', '1', '--ratio', '1', '--duration', '4']) });
  const mono = measure('mono.wav').gapLu;
  const stereo = measure('stereo.wav').gapLu;
  assert.ok(Math.abs(stereo - 10) < 0.2, `стерео-голос: ${stereo} LU`);
  assert.ok(Math.abs(mono - stereo) < 0.2, `моно ${mono} LU против стерео ${stereo} LU`);
});

// ffmpeg ведёт фильтры в формате входа: s16-исходник шёл через K-взвешивание как s16p, и полка
// +4 дБ обрезала пики громкого верха внутри biquad ещё до float-выхода. Громкий 6 кГц s16 обязан
// читаться как его float-копия.
test('a full-scale s16 voice is not clipped inside the K weighting', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mix-s16-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = "aevalsrc='sin(2*PI*6000*t)':s=48000:d=3";
  for (const [file, codec] of [['s16.wav', 'pcm_s16le'], ['f32.wav', 'pcm_f32le']]) {
    runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source, '-ac', '2', '-c:a', codec, path.join(dir, file)]);
  }
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=3', '-ac', '2',
    path.join(dir, 'music.wav')]);
  const measure = (voice) => measureVoiceMusic({ voicePath: path.join(dir, voice), musicPath: path.join(dir, 'music.wav'),
    durationSec: 3, windows: [{ s: 0.5, e: 2.5 }], mixOptions: parseMixOptions(['--gain', '-10', '--threshold', '1', '--ratio', '1', '--duration', '3']) });
  const s16 = measure('s16.wav');
  const f32 = measure('f32.wav');
  assert.ok(Math.abs(s16.voiceLufs - f32.voiceLufs) <= 0.05, `s16 ${s16.voiceLufs.toFixed(2)} против float ${f32.voiceLufs.toFixed(2)} LUFS`);
  assert.ok(Math.abs(s16.gapLu - f32.gapLu) <= 0.05, `разрыв s16 ${s16.gapLu.toFixed(2)} против float ${f32.gapLu.toFixed(2)} LU`);
});

test('a preview with silent voice and silent music says the voice is silent', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mix-silent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of ['voice.wav', 'music.wav']) {
    runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2', path.join(dir, file)]);
  }
  const result = measureVoiceMusic({ voicePath: path.join(dir, 'voice.wav'), musicPath: path.join(dir, 'music.wav'), durationSec: 2,
    windows: [{ s: 0.2, e: 1.8 }], mixOptions: parseMixOptions(['--gain', '-16', '--duration', '2']) });
  const g = gateVoiceMusic(result, avatar, { gainDb: -16 });
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 'голос не звучит');
});
