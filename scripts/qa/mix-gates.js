// G8 «Голос и музыка» (D8): баланс по настоящим дорожкам preview. Голос — звук после finish.js
// (голос + эффекты слоя, нормализация), музыка — ветка музыки после того же sidechaincompress, что в
// mix-music.js. Считаются только блоки 50 мс внутри окон речи, где музыка вообще слышна.
const { BLOCK, SAMPLE_RATE, blockDb, formatSeconds, pcmFromFfmpeg } = require('./audio');
const { gate } = require('./report');
const { MIX_AUDIO_FORMAT, buildMusicFilter, mixMusicInputArgs } = require('../mix-music');
const { hostPath } = require('../process');

// Музыка тише этого — «под речью её нет», такой блок в разрыв не идёт.
const MUSIC_FLOOR_DB = -80;
const EPS = 1e-9;

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

// Разрыв голос − музыка (дБ) по целым блокам внутри окон; блоки с неслышной музыкой не считаются.
// null — в окнах нет ни одного блока (нет речи); median Infinity — речь есть, музыки под ней нет.
function voiceMusicGap(voice, music, windows) {
  const gaps = [];
  let blocks = 0;
  for (const w of windows) {
    const first = Math.ceil((w.s * SAMPLE_RATE) / BLOCK);
    const last = Math.floor((w.e * SAMPLE_RATE) / BLOCK);
    for (let b = first; b < last; b += 1) {
      const start = b * BLOCK;
      const end = start + BLOCK;
      if (end > voice.length || end > music.length) break;
      blocks += 1;
      const musicDb = blockDb(music, start, end);
      if (musicDb >= MUSIC_FLOOR_DB) gaps.push(blockDb(voice, start, end) - musicDb);
    }
  }
  if (!blocks) return null;
  if (!gaps.length) return { median: Infinity, p10: Infinity, blocks: 0 };
  gaps.sort((a, b) => a - b);
  return { median: gaps[Math.floor(gaps.length / 2)], p10: gaps[Math.floor(gaps.length * 0.1)], blocks: gaps.length };
}

// voicePath — голос после finish.js. Музыка идёт через те же входы (mixMusicInputArgs: порядок,
// -stream_loop -1, пути) и тот же граф, что в mix-music.js, только в режиме stem: 'music'. Голос
// проходит тот же aformat, что ветка [v] микса: моно-голос в миксе тоже становится стерео −3 дБ на
// канал, и без этого разрыв моно-голоса с музыкой читался бы на 3 дБ больше настоящего. Оба сигнала
// выровнены по сэмплам от начала, как их сводит sidechain/amix в самом preview.
function measureVoiceMusic({ voicePath, musicPath, mixOptions, durationSec, windows, spawnImpl }) {
  if (!mixOptions || typeof mixOptions !== 'object') {
    throw new Error('measureVoiceMusic: нужны mixOptions из parseMixOptions (параметры музыки preview)');
  }
  if (!(Number.isFinite(durationSec) && durationSec > 0)) {
    throw new Error('measureVoiceMusic: durationSec должен быть конечным положительным числом');
  }
  if (!Array.isArray(windows)) throw new Error('measureVoiceMusic: windows должен быть массивом окон речи');
  const duration = formatSeconds(durationSec);
  const voice = pcmFromFfmpeg(['-i', hostPath(voicePath), '-map', '0:a:0', '-vn', '-af', MIX_AUDIO_FORMAT, '-t', duration], { spawnImpl });
  const music = pcmFromFfmpeg([
    ...mixMusicInputArgs(voicePath, musicPath),
    '-filter_complex', buildMusicFilter(mixOptions, { stem: 'music' }), '-map', '[aout]', '-t', duration,
  ], { spawnImpl });
  // Пустой PCM — «ffmpeg ничего не отдал», а не «музыки нет»: иначе G8 тихо пропустился бы.
  if (!voice.length) throw new Error(`нет звука голоса в ${voicePath}`);
  if (!music.length) throw new Error(`нет звука музыки после sidechain: ${musicPath}`);
  return voiceMusicGap(voice, music, windows);
}

function gateVoiceMusic(result, profile, { hasMusic = true } = {}) {
  const title = 'Голос и музыка';
  const v = profile.voiceMusic;
  const threshold = `${number(v.warnLow)}–${number(v.warnHigh)} дБ, стоп < ${number(v.stopLow)} или > ${number(v.stopHigh)}`;
  if (!hasMusic) return gate('G8', title, { status: 'skipped', threshold, hint: 'в brief нет музыки' });
  if (!result) return gate('G8', title, { status: 'skipped', threshold, hint: 'в диапазоне preview нет речи' });
  const m = result.median;
  const status = m < v.stopLow || m > v.stopHigh ? 'fail' : m < v.warnLow || m > v.warnHigh ? 'warn' : 'pass';
  const hint = m < v.warnLow ? 'музыка громкая под голосом: уменьшите music.gainDb'
    : m > v.warnHigh ? 'музыку почти не слышно: увеличьте music.gainDb' : '';
  const finite = Number.isFinite(m);
  return gate('G8', title, {
    status, value: finite ? Math.round(m * 10) / 10 : 'музыки под речью нет', unit: finite ? 'дБ' : '', threshold, hint,
  });
}

module.exports = { gateVoiceMusic, measureVoiceMusic, speechWindows, voiceMusicGap };
