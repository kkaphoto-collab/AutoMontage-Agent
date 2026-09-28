// G8 «Голос и музыка» (D8): разрыв громкости голоса и музыки на участках речи по настоящим дорожкам
// preview. Голос — звук после finish.js (голос + эффекты слоя, нормализация), музыка — ветка музыки
// после того же sidechaincompress, что в mix-music.js. Громкость — как LUFS (BS.1770): K-взвешивание
// на 48 кГц, сумма мощностей каналов, блоки 50 мс внутри окон речи; без гейтинга, потому что окна
// речи уже выбраны по транскрипту. Разрыв = 10·log10(ΣP голоса / ΣP музыки) в LU.
const { BLOCK_SEC, floatPcmFromFfmpeg, formatSeconds } = require('./audio');
const { gate } = require('./report');
const { MIX_AUDIO_FORMAT, buildMusicFilter, mixMusicInputArgs } = require('../mix-music');
const { hostPath } = require('../process');

const RATE = 48000;
const CHANNELS = 2;
const BLOCKS_PER_SEC = Math.round(1 / BLOCK_SEC);
const EPS = 1e-9;
// K-взвешивание BS.1770-4 точными коэффициентами стандарта для 48 кГц: полка +4 дБ около 1,7 кГц и
// ФВЧ около 38 Гц. Приближение highshelf/highpass (RBJ) расходилось с ebur128 до 0,46 LU у полки.
const K_WEIGHTING = [
  'biquad=b0=1.53512485958697:b1=-2.69169618940638:b2=1.19839281085285:a0=1:a1=-1.69065929318241:a2=0.73248077421585',
  'biquad=b0=1:b1=-2:b2=1:a0=1:a1=-1.99004745483398:a2=0.99007225036621',
].join(',');

const r1 = (value) => Math.round(value * 10) / 10;
const number = (value) => String(Number(value.toFixed(2))).replace('.', ',');

// Окна речи в секундах от начала preview (fromSec): соседние слова с паузой ≤ mergeGapSec
// сливаются, окна короче minSec отбрасываются.
function speechWindows(words, { fromSec = 0, toSec = Infinity, mergeGapSec = 0.25, minSec = 0.3 } = {}) {
  const inRange = words.filter((w) => w.e > fromSec && w.s < toSec)
    .map((w) => ({ s: Math.max(w.s, fromSec) - fromSec, e: Math.min(w.e, toSec) - fromSec }))
    .sort((a, b) => a.s - b.s);
  const merged = [];
  for (const w of inRange) {
    const last = merged[merged.length - 1];
    if (last && w.s - last.e <= mergeGapSec + EPS) last.e = Math.max(last.e, w.e);
    else merged.push({ ...w });
  }
  return merged.filter((w) => w.e - w.s >= minSec - EPS)
    .map((w) => ({ s: Math.round(w.s * 1000) / 1000, e: Math.round(w.e * 1000) / 1000 }));
}

// Мощность по блокам 50 мс: сумма x² по всем каналам на кадр (BS.1770: L и R с весом 1).
// Хвост короче блока отбрасывается.
function blockPowers(samples, { sampleRate = RATE, channels = CHANNELS } = {}) {
  const frames = Math.round(sampleRate * BLOCK_SEC);
  const size = frames * channels;
  const out = new Float64Array(Math.floor(samples.length / size));
  for (let b = 0; b < out.length; b += 1) {
    let sum = 0;
    for (let i = b * size; i < (b + 1) * size; i += 1) sum += samples[i] * samples[i];
    out[b] = sum / frames;
  }
  return out;
}

// Разрыв громкости по целым блокам внутри окон. null — ни одного блока (нет речи); gapLu Infinity —
// под речью цифровая тишина музыки. voiceLufs/musicLufs — громкость участков речи без гейтинга.
function loudnessGap(voicePowers, musicPowers, windows) {
  let voice = 0;
  let music = 0;
  let blocks = 0;
  for (const w of windows) {
    if (!(w && Number.isFinite(w.s) && Number.isFinite(w.e) && w.s >= 0 && w.e >= w.s)) {
      throw new Error(`окна речи повреждены: ${JSON.stringify(w)}`);
    }
    const first = Math.ceil(w.s * BLOCKS_PER_SEC - EPS);
    const last = Math.min(Math.floor(w.e * BLOCKS_PER_SEC + EPS), voicePowers.length, musicPowers.length);
    for (let b = first; b < last; b += 1) {
      voice += voicePowers[b];
      music += musicPowers[b];
      blocks += 1;
    }
  }
  if (!blocks) return null;
  const lufs = (sum) => (sum > 0 ? -0.691 + 10 * Math.log10(sum / blocks) : -Infinity);
  return {
    gapLu: music > 0 ? 10 * Math.log10(voice / music) : Infinity,
    voiceLufs: lufs(voice), musicLufs: lufs(music), blocks,
  };
}

// voicePath — голос после finish.js. Музыка идёт через те же входы (mixMusicInputArgs: порядок,
// -stream_loop -1, пути) и тот же граф, что в mix-music.js, в режиме stem: 'music'; к его выходу
// дописано только K-взвешивание. Голос проходит тот же aformat, что ветка [v] микса. Remotion и
// finish.js отдают стерео, так что это страховка: моно-голос микс сыграл бы стерео-копией −3 дБ на
// канал, и без aformat разрыв читался бы на 3 дБ больше настоящего. Оба сигнала выровнены по сэмплам
// от начала, как их сводит sidechain/amix в самом preview.
function measureVoiceMusic({ voicePath, musicPath, mixOptions, durationSec, windows, spawnImpl }) {
  if (!mixOptions || typeof mixOptions !== 'object') {
    throw new Error('measureVoiceMusic: нужны mixOptions из parseMixOptions (параметры музыки preview)');
  }
  if (!(Number.isFinite(durationSec) && durationSec > 0)) {
    throw new Error('measureVoiceMusic: durationSec должен быть конечным положительным числом');
  }
  if (!Array.isArray(windows)) throw new Error('measureVoiceMusic: windows должен быть массивом окон речи');
  const duration = formatSeconds(durationSec);
  const weighting = `aresample=${RATE},${K_WEIGHTING}`;
  const decode = (inputArgs) => floatPcmFromFfmpeg(inputArgs, {
    sampleRate: RATE, channels: CHANNELS, spawnImpl,
    maxBuffer: Math.ceil(durationSec * RATE) * CHANNELS * 4 + 1024 * 1024,
  });
  const voice = decode(['-i', hostPath(voicePath), '-map', '0:a:0', '-vn', '-af', `${MIX_AUDIO_FORMAT},${weighting}`, '-t', duration]);
  const music = decode([
    ...mixMusicInputArgs(voicePath, musicPath),
    '-filter_complex', `${buildMusicFilter(mixOptions, { stem: 'music' })};[aout]${weighting}[k]`, '-map', '[k]', '-t', duration,
  ]);
  // Пустой PCM — «ffmpeg ничего не отдал», а не «музыки нет»: иначе G8 тихо пропустился бы.
  if (!voice.length) throw new Error(`нет звука голоса в ${voicePath}`);
  if (!music.length) throw new Error(`нет звука музыки после sidechain: ${musicPath}`);
  return loudnessGap(blockPowers(voice), blockPowers(music), windows);
}

function gapWords(gapLu) {
  const amount = r1(Math.abs(gapLu));
  if (amount === 0) return 'музыка вровень с голосом';
  return `музыка на ${number(amount)} LU ${gapLu > 0 ? 'тише' : 'громче'} голоса`;
}

function gateVoiceMusic(result, profile, { hasMusic = true } = {}) {
  const title = 'Голос и музыка';
  const v = profile.voiceMusic;
  const threshold = `${number(v.warnLow)}–${number(v.warnHigh)} LU, стоп < ${number(v.stopLow)} или > ${number(v.stopHigh)}`;
  if (!hasMusic) return gate('G8', title, { status: 'skipped', threshold, hint: 'в brief нет музыки' });
  if (!result) return gate('G8', title, { status: 'skipped', threshold, hint: 'в диапазоне preview нет речи' });
  const m = result.gapLu;
  if (typeof m !== 'number' || Number.isNaN(m)) throw new Error('gateVoiceMusic: в замере нет gapLu (результат measureVoiceMusic)');
  if (m === Infinity) {
    return gate('G8', title, { status: 'fail', value: 'музыки под речью нет', threshold,
      hint: 'музыки под речью нет (цифровая тишина): проверьте файл музыки и music.gainDb' });
  }
  if (m === -Infinity) {
    return gate('G8', title, { status: 'fail', value: 'голос не звучит', threshold,
      hint: 'в окнах речи голос не звучит: проверьте звук preview после finish.js' });
  }
  const status = m < v.stopLow || m > v.stopHigh ? 'fail' : m < v.warnLow || m > v.warnHigh ? 'warn' : 'pass';
  // Sidechain сжимает музыку по уровню голоса, поэтому music.gainDb сдвигает разрыв ровно на столько же.
  const change = number(r1(Math.abs(v.target - m)));
  const advice = m < v.warnLow ? `: слишком громко под речью — уменьшите music.gainDb примерно на ${change} дБ (цель ${number(v.target)} LU)`
    : m > v.warnHigh ? `: музыку почти не слышно — увеличьте music.gainDb примерно на ${change} дБ (цель ${number(v.target)} LU)` : '';
  return gate('G8', title, { status, value: r1(m), unit: 'LU', threshold, hint: `${gapWords(m)}${advice}` });
}

module.exports = { K_WEIGHTING, blockPowers, gateVoiceMusic, loudnessGap, measureVoiceMusic, speechWindows };
