// Задача 27: G8 «Голос и музыка» — баланс по настоящим дорожкам preview: голос после finish.js и
// музыка после того же sidechain, что в mix-music.js; считаются только блоки внутри окон речи.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { MIX_AUDIO_FORMAT, buildMusicFilter, mixMusicCommand, parseMixOptions } = require('../scripts/mix-music');
const { decodeAudio, envelopeDb } = require('../scripts/qa/audio');
const { gateVoiceMusic, measureVoiceMusic, speechWindows, voiceMusicGap } = require('../scripts/qa/mix-gates');
const { getProfile } = require('../scripts/qa/profiles');

const avatar = getProfile('avatar');
const hasFfmpeg = toolAvailable('ffmpeg');

// Параметры музыки, как их собирает buildLessonMusicMixArgs для preview.
const BRIEF_ARGS = ['--gain', '-22', '--start', '24', '--rate', '1.06', '--fade-in', '0.15', '--fade-out', '0.8',
  '--duration', '53.6', '--threshold', '0.0398', '--ratio', '8', '--attack', '5', '--release', '300'];

// Подмена ffmpeg: запоминает argv и отдаёт секунду тишины PCM 8 кГц.
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
  const stem = calls.find((call) => call.args.includes('-filter_complex')).args;
  // Входы и их опции (порядок, -stream_loop, абсолютные пути) — один в один; отличаются только
  // граф (stem) и выход.
  assert.deepEqual(inputs(stem), inputs(production));
  assert.equal(stem[stem.indexOf('-filter_complex') + 1], buildMusicFilter(mixOptions, { stem: 'music' }));
  assert.deepEqual(stem.slice(stem.indexOf('-map'), stem.indexOf('-map') + 4), ['-map', '[aout]', '-t', '0.3']);
  // Голос проходит тот же формат, что ветка [v] в графе микса.
  const voice = calls.find((call) => !call.args.includes('-filter_complex')).args;
  assert.deepEqual(voice.slice(voice.indexOf('-i'), voice.indexOf('-i') + 10),
    ['-i', path.resolve('stage/finished.mp4'), '-map', '0:a:0', '-vn', '-af', MIX_AUDIO_FORMAT, '-t', '0.3', '-ac']);
  assert.ok(buildMusicFilter(mixOptions).split(';')[1].startsWith(`[0:a]${MIX_AUDIO_FORMAT},asplit=2[v]`));
  assert.ok(calls.every((call) => call.command === 'ffmpeg'));
});

// Главное обещание замера: музыка в нём — ровно то, что микс preview прибавляет к голосу, с ducking
// и зацикленной музыкой. Настоящая команда mix-music, только звук без потерь (PCM в MOV вместо AAC),
// чтобы сравнить по сэмплам: микс = голос + музыка замера.
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
  const pcm = (bytes) => Int16Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readInt16LE(i * 2));
  const [voicePcm, musicPcm] = captured.map(pcm);
  const mixedPcm = decodeAudio(mixed, { durationSec: 6 });
  assert.equal(voicePcm.length, 48000);
  assert.equal(musicPcm.length, 48000);
  assert.equal(mixedPcm.length, 48000);
  let worst = 0;
  for (let i = 0; i < mixedPcm.length; i += 1) worst = Math.max(worst, Math.abs(mixedPcm[i] - voicePcm[i] - musicPcm[i]));
  assert.ok(worst <= 3, `микс отличается от голоса + музыки замера на ${worst} LSB`);
  // Сценарий действительно проверяет sidechain: под речью музыка заметно тише, чем в паузе.
  const envelope = envelopeDb(musicPcm);
  assert.ok(envelope[70] - envelope[10] > 8, `ducking: ${envelope[10]} дБ под речью, ${envelope[70]} дБ в паузе`);
});

test('measureVoiceMusic refuses missing music options, a bad duration and an empty decode', () => {
  const { spawnImpl } = spawnSpy();
  const base = { voicePath: 'v.mp4', musicPath: 'm.mp3', mixOptions: parseMixOptions([]), durationSec: 10, windows: [], spawnImpl };
  assert.throws(() => measureVoiceMusic({ ...base, mixOptions: null }), /measureVoiceMusic: нужны mixOptions/);
  for (const durationSec of [0, -1, NaN, Infinity]) {
    assert.throws(() => measureVoiceMusic({ ...base, durationSec }), /measureVoiceMusic: durationSec/);
  }
  assert.throws(() => measureVoiceMusic({ ...base, windows: null }), /measureVoiceMusic: windows/);
  // Пустой PCM — это «ffmpeg ничего не отдал», а не «музыки нет»: иначе замер тихо пропустил бы G8.
  const empty = () => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  assert.throws(() => measureVoiceMusic({ ...base, spawnImpl: empty }), /нет звука голоса/);
  const noMusic = (command, args) => (args.includes('-filter_complex') ? empty() : spawnSpy().spawnImpl(command, args));
  assert.throws(() => measureVoiceMusic({ ...base, spawnImpl: noMusic }), /нет звука музыки после sidechain/);
});

test('speech windows merge close words, drop blips and follow the preview range', () => {
  const words = [{ s: 1, e: 1.4 }, { s: 1.5, e: 2 }, { s: 3, e: 3.1 }, { s: 5, e: 6 }];
  assert.deepEqual(speechWindows(words, { fromSec: 0.5, toSec: 5.5 }), [{ s: 0.5, e: 1.5 }, { s: 4.5, e: 5 }]);
  assert.deepEqual(speechWindows([]), []);
  // Пауза ровно 0,25 с сливает слова, хотя 0,55 − 0,3 в двоичной арифметике чуть больше 0,25.
  assert.deepEqual(speechWindows([{ s: 0, e: 0.3 }, { s: 0.55, e: 0.7 }]), [{ s: 0, e: 0.7 }]);
});

test('gap statistics use only blocks with audible music', () => {
  const tone = (amp) => Int16Array.from({ length: 8000 }, (_, i) => Math.round(amp * 32767 * Math.sin(i / 3)));
  const r = voiceMusicGap(tone(0.5), tone(0.05), [{ s: 0, e: 1 }]);
  assert.ok(Math.abs(r.median - 20) < 0.1);
  assert.equal(voiceMusicGap(tone(0.5), new Int16Array(8000), [{ s: 0, e: 1 }]).median, Infinity);
  assert.equal(gateVoiceMusic({ median: Infinity, p10: Infinity, blocks: 0 }, avatar).status, 'fail');
  assert.equal(gateVoiceMusic(null, avatar, { hasMusic: false }).status, 'skipped');
});

test('gap statistics skip silent-music blocks and report the low tail as p10', () => {
  const tone = (amp, from, to) => Int16Array.from({ length: 8000 }, (_, i) => (i >= from && i < to ? Math.round(amp * 32767 * Math.sin(i / 3)) : 0));
  const voice = tone(0.5, 0, 8000);
  // Первые 0,1 с музыка громкая (разрыв 6 дБ), затем 0,5 с тихая (20 дБ), последние 0,4 с музыки нет.
  const music = Int16Array.from(voice, (_, i) => (i < 800 ? Math.round(voice[i] / 2) : i < 4800 ? Math.round(voice[i] / 10) : 0));
  const r = voiceMusicGap(voice, music, [{ s: 0, e: 1 }]);
  assert.equal(r.blocks, 12);
  assert.ok(Math.abs(r.median - 20) < 0.1, `медиана ${r.median}`);
  assert.ok(Math.abs(r.p10 - 6) < 0.1, `p10 ${r.p10}`);
  // Окна вне блоков тона и за концом дорожки не считаются; без окон — нет речи.
  assert.equal(voiceMusicGap(voice, music, [{ s: 5, e: 6 }]), null);
  assert.equal(voiceMusicGap(voice, music, []), null);
});

test('G8 statuses follow the profile corridor and print the threshold with commas', () => {
  const profile = { ...avatar, voiceMusic: { stopLow: 3, warnLow: 7.5, target: 10.5, warnHigh: 13.5, stopHigh: 18.5 } };
  const at = (median) => gateVoiceMusic({ median, p10: median - 2, blocks: 100 }, profile);
  assert.deepEqual([2.9, 3, 7.4, 7.5, 10.5, 13.5, 13.6, 18.5, 18.6].map((m) => at(m).status),
    ['fail', 'warn', 'warn', 'pass', 'pass', 'pass', 'warn', 'warn', 'fail']);
  const good = at(10.54);
  assert.equal(good.id, 'G8');
  assert.equal(good.title, 'Голос и музыка');
  assert.equal(good.value, 10.5);
  assert.equal(good.unit, 'дБ');
  assert.equal(good.threshold, '7,5–13,5 дБ, стоп < 3 или > 18,5');
  assert.match(at(2).hint, /музыка громкая под голосом: уменьшите music\.gainDb/);
  assert.match(at(16).hint, /музыку почти не слышно: увеличьте music\.gainDb/);
  assert.equal(at(10).hint, '');
  const none = gateVoiceMusic({ median: Infinity, p10: Infinity, blocks: 0 }, profile);
  assert.equal(none.value, 'музыки под речью нет');
  assert.equal(none.unit, '');
  const noSpeech = gateVoiceMusic(null, profile);
  assert.equal(noSpeech.status, 'skipped');
  assert.match(noSpeech.hint, /нет речи/);
  assert.match(gateVoiceMusic(null, profile, { hasMusic: false }).hint, /нет музыки/);
});

test('BAD CASE: music at the voice level stops the preview; a 12 dB gap passes', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mix-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const voice = path.join(dir, 'voice.wav');
  const music = path.join(dir, 'music.wav');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=10', '-af', 'volume=-6dB', voice]);
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-af', 'volume=-6dB', music]);
  const windows = [{ s: 0.5, e: 9.5 }];
  const measure = (gain) => measureVoiceMusic({ voicePath: voice, musicPath: music, durationSec: 10, windows,
    mixOptions: parseMixOptions(['--gain', String(gain), '--threshold', '1', '--ratio', '1', '--duration', '10']) });
  const level = gateVoiceMusic(measure(0), avatar);
  assert.equal(level.status, 'fail');
  assert.ok(Math.abs(level.value) < 1, `музыка вровень с голосом: ${level.value} дБ`);
  const quiet = gateVoiceMusic(measure(-12), avatar);
  assert.equal(quiet.status, 'pass');
  assert.ok(Math.abs(quiet.value - 12) < 1, `разрыв 12 дБ: ${quiet.value} дБ`);
  assert.ok(decodeAudio(voice).length > 70000);
});

// Моно-голос микс играет как его стерео-копию (aformat: −3 дБ на канал), и замер должен слышать
// то же самое: разрыв моно-голоса равен разрыву его стерео-копии, а не на 3 дБ больше.
test('a mono voice measures like the stereo copy the mix actually plays', { skip: !hasFfmpeg }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mix-channels-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tone = (file, frequency, channels) => runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `sine=frequency=${frequency}:sample_rate=48000:duration=4`, '-af', 'volume=-6dB', '-ac', String(channels), path.join(dir, file)]);
  tone('mono.wav', 220, 1);
  tone('stereo.wav', 220, 2);
  tone('music.wav', 440, 1);
  const measure = (voice) => measureVoiceMusic({ voicePath: path.join(dir, voice), musicPath: path.join(dir, 'music.wav'),
    durationSec: 4, windows: [{ s: 0.5, e: 3.5 }], mixOptions: parseMixOptions(['--gain', '-10', '--threshold', '1', '--ratio', '1', '--duration', '4']) });
  const mono = measure('mono.wav').median;
  const stereo = measure('stereo.wav').median;
  assert.ok(Math.abs(stereo - 10) < 0.5, `стерео-голос: ${stereo} дБ`);
  assert.ok(Math.abs(mono - stereo) < 0.5, `моно ${mono} дБ против стерео ${stereo} дБ`);
});
