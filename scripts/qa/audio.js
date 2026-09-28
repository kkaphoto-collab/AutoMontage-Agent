// Звук для гейтов: моно 8 кГц s16le из ffmpeg, огибающая по 50 мс в dBFS, корреляция Пирсона.
const { spawnSync } = require('node:child_process');

const SAMPLE_RATE = 8000;
const BLOCK = 400; // 50 мс при 8 кГц
const FLOOR_DB = -90;

function pcmFromFfmpeg(inputArgs, { maxBuffer = 256 * 1024 * 1024, spawnImpl = spawnSync } = {}) {
  const result = spawnImpl('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', ...inputArgs,
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', '-',
  ], { encoding: 'buffer', maxBuffer, shell: false });
  // Молчаливый провал здесь означал бы «звука нет» вместо «ffmpeg не смог его отдать» — гейт принял
  // бы пустой PCM за тишину и дал бы ложный pass. Сообщение ffmpeg обрезаем: он иногда пишет длинный
  // banner даже с -hide_banner, а отчёту гейта нужна короткая понятная причина.
  if (result.error || result.status !== 0) {
    const reason = String(result.stderr || result.error?.message || '').trim().slice(0, 300);
    throw new Error(`ffmpeg не смог отдать звук: ${reason}`);
  }
  const bytes = result.stdout;
  const samples = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(i * 2);
  return samples;
}

// -ss перед -i — быстрый seek по контейнеру (до декодирования), -map 0:a:0 берёт первую звуковую
// дорожку явно (нет аудио вообще — ffmpeg сам откажет понятной ошибкой, а не молчащим видео-выводом).
function decodeAudio(file, { fromSec = 0, durationSec = null, spawnImpl } = {}) {
  return pcmFromFfmpeg([
    '-ss', String(fromSec), ...(durationSec ? ['-t', String(durationSec)] : []), '-i', file, '-map', '0:a:0', '-vn',
  ], { spawnImpl });
}

function blockDb(samples, start, end) {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, end - start)) / 32768;
  return Math.max(FLOOR_DB, 20 * Math.log10(rms + 1e-12));
}

function envelopeDb(samples, block = BLOCK) {
  const n = Math.floor(samples.length / block);
  const out = new Float64Array(n);
  for (let b = 0; b < n; b += 1) out[b] = blockDb(samples, b * block, (b + 1) * block);
  return out;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; }
  ma /= n;
  mb /= n;
  let num = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    va += x * x;
    vb += y * y;
  }
  if (va === 0 || vb === 0) return null;
  return num / Math.sqrt(va * vb);
}

// Самое похожее окно, где звук первого сигнала вообще есть (короткая утечка голоса). Отклонение от
// плана (оркестраторская правка): по умолчанию окна скользят внахлёст на 50 % (hop = windowBlocks/2),
// а не впритык друг к другу. Короткая утечка ровно в размер окна, которая физически легла на границу
// двух соседних непересекающихся окон, иначе досталась бы каждому окну лишь наполовину — средняя
// громкость обеих половинок падает ниже minDbA, и окно целиком пропускается мимо проверки, хотя
// утечка на записи реально была. Внахлёст гарантирует окно, которое застаёт всю утечку целиком.
function windowedMax(a, b, windowBlocks, { minDbA = -60, hop = Math.max(1, Math.floor(windowBlocks / 2)) } = {}) {
  let best = null;
  const n = Math.min(a.length, b.length);
  for (let start = 0; start + windowBlocks <= n; start += hop) {
    const wa = a.subarray(start, start + windowBlocks);
    const mean = wa.reduce((sum, v) => sum + v, 0) / windowBlocks;
    if (mean < minDbA) continue;
    const r = pearson(wa, b.subarray(start, start + windowBlocks));
    if (r !== null && (best === null || r > best.r)) best = { r, startBlock: start };
  }
  return best;
}

module.exports = {
  BLOCK, FLOOR_DB, SAMPLE_RATE, blockDb, decodeAudio, envelopeDb, pcmFromFfmpeg, pearson, windowedMax,
};
