// Звук для гейтов: моно 8 кГц s16le из ffmpeg (и float полной полосы для громкости G8), огибающая
// по 50 мс в dBFS, корреляция Пирсона, поиск короткой/сдвинутой утечки голоса в звуке слоя (окно +
// лаг) и доля звука слоя вне известных вставок (G7, Task 26).
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const SAMPLE_RATE = 8000;
const BLOCK = 400; // 50 мс при 8 кГц
const BLOCK_SEC = BLOCK / SAMPLE_RATE;
const FLOOR_DB = -90;

// Причина сбоя ffmpeg по приоритету: свой stderr, иначе message самой ошибки spawn (ENOENT,
// ETIMEDOUT – Node кладёт их в result.error, а result.stdout/stderr при этом остаются пустым
// Buffer, а не null; пустой Buffer сам по себе truthy, поэтому `result.stderr || result.error?.
// message` раньше ВСЕГДА выбирал пустой Buffer и терял настоящую причину), и только в последнюю
// очередь голый сигнал/статус – если процесс убит до единой строки в stderr.
function reasonFor(result) {
  const stderr = String(result.stderr || '').trim();
  if (stderr) return stderr.slice(0, 300);
  const message = result.error && result.error.message;
  if (message) return String(message).trim().slice(0, 300);
  if (result.signal) return `процесс убит сигналом ${result.signal}`;
  return `процесс завершился со статусом ${String(result.status)}`;
}

// Запуск ffmpeg с PCM в stdout: общая обработка сбоев для pcmFromFfmpeg и floatPcmFromFfmpeg.
function ffmpegPcmBytes(inputArgs, outputArgs, { maxBuffer, spawnImpl }) {
  const result = spawnImpl('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', ...inputArgs, ...outputArgs, '-',
  ], { encoding: 'buffer', maxBuffer, shell: false });
  // Молчаливый провал здесь означал бы «звука нет» вместо «ffmpeg не смог его отдать» – гейт принял
  // бы пустой PCM за тишину и дал бы ложный pass.
  if (result.error || result.status !== 0) {
    if (result.error && result.error.code === 'ENOENT') {
      throw new Error('ffmpeg не найден; запусти npm run doctor');
    }
    const reason = reasonFor(result);
    // «Stream map '...' matches no streams» – ffmpeg так отказывает -map 0:a:0 на файле без единой
    // звуковой дорожки; отдельное явное сообщение полезнее, чем сырой текст ffmpeg с именем опции.
    if (/matches no streams/.test(reason)) {
      const at = inputArgs.indexOf('-i');
      // Только имя файла: сообщение попадает в отчёты гейтов, абсолютный путь проекта там не нужен.
      const file = at >= 0 ? path.basename(String(inputArgs[at + 1])) : 'входном файле';
      throw new Error(`в ${file} нет звуковой дорожки`);
    }
    throw new Error(`ffmpeg не смог отдать звук: ${reason}`);
  }
  return result.stdout;
}

function pcmFromFfmpeg(inputArgs, { maxBuffer = 256 * 1024 * 1024, spawnImpl = spawnSync } = {}) {
  const bytes = ffmpegPcmBytes(inputArgs, ['-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le'],
    { maxBuffer, spawnImpl });
  const samples = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(i * 2);
  return samples;
}

// Полная полоса для громкости (G8): float32, каналы чередуются, без округления до 16 бит на выходе.
// Формат ВЫХОДА не меняет формат фильтров: ffmpeg ведёт цепочку в формате входа (s16-исходник идёт
// через biquad как s16p и обрезается уже там), поэтому перед фильтрами, поднимающими уровень,
// вызывающий код сам ставит aformat=sample_fmts=fltp (mix-gates.js).
function floatPcmFromFfmpeg(inputArgs, { sampleRate, channels, maxBuffer = 256 * 1024 * 1024, spawnImpl = spawnSync } = {}) {
  if (!(Number.isInteger(sampleRate) && sampleRate > 0 && Number.isInteger(channels) && channels > 0)) {
    throw new Error('floatPcmFromFfmpeg: sampleRate и channels должны быть целыми числами > 0');
  }
  const bytes = ffmpegPcmBytes(inputArgs, ['-ac', String(channels), '-ar', String(sampleRate), '-f', 'f32le', '-acodec', 'pcm_f32le'],
    { maxBuffer, spawnImpl });
  const count = Math.floor(bytes.length / 4);
  // Буфер ffmpeg обычно выровнен: читаем его видом без копии; иначе – побайтно.
  if (bytes.byteOffset % 4 === 0 && os.endianness() === 'LE') return new Float32Array(bytes.buffer, bytes.byteOffset, count);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = bytes.readFloatLE(i * 4);
  return samples;
}

// ffmpeg понимает -ss/-t только как обычную десятичную запись: «1e-7» (так JS String() печатает
// очень маленькие числа) он не разбирает как секунды, а длинный хвост плавающей точки (0.1+0.2 →
// «0.30000000000000004») просто мусорит команду. Округление до микросекунд (6 знаков) для звука с
// огромным запасом достаточно; обратный Number(...) убирает хвостовые нули без ручного regex.
function formatSeconds(value) {
  return String(Number(value.toFixed(6)));
}

// -ss и -t стоят ПОСЛЕ -i (выходные опции): ffmpeg декодирует звук с начала и отбрасывает сэмплы
// до fromSec точно по сэмплу. -ss перед -i (seek по контейнеру) на AAC в MP4/M4A/MOV без видео и на
// части перемуксованных файлов сдвигал звук раньше на задержку кодека – до ~21 мс, то есть почти на
// целый блок огибающей (повторное ревью задачи 25). Декодировать 8 кГц моно с начала дёшево; при
// fromSec 0 -ss не нужен вовсе. -map 0:a:0 берёт первую звуковую дорожку явно (нет аудио вообще –
// ffmpeg сам откажет понятной ошибкой, а не молчащим видео-выводом). aresample=async=1:first_pts=0
// кладёт звук на глобальный таймкод: если дорожка в контейнере начинается позже 0 (start_time 0,48 с)
// или в ней есть разрыв, недостающее заполняется тишиной, а не сдвигает всё звучание раньше.
function decodeAudio(file, { fromSec = 0, durationSec = null, spawnImpl } = {}) {
  if (!(Number.isFinite(fromSec) && fromSec >= 0)) {
    throw new Error('decodeAudio: fromSec должен быть конечным числом ≥ 0');
  }
  if (durationSec !== null && durationSec !== undefined
    && !(Number.isFinite(durationSec) && durationSec > 0)) {
    throw new Error('decodeAudio: durationSec должен быть конечным положительным числом');
  }
  const samples = pcmFromFfmpeg([
    '-i', file,
    ...(fromSec > 0 ? ['-ss', formatSeconds(fromSec)] : []),
    ...(durationSec ? ['-t', formatSeconds(durationSec)] : []),
    '-map', '0:a:0', '-vn', '-af', 'aresample=async=1:first_pts=0',
  ], { spawnImpl });
  // fromSec за концом файла (или отрезок целиком после последнего сэмпла) ffmpeg молча отдаёт
  // пустой поток – гейт иначе принял бы «нет данных» за «полная тишина» и разрешил бы то, что на
  // самом деле не проверил.
  if (samples.length === 0) {
    const range = durationSec
      ? `${formatSeconds(fromSec)}–${formatSeconds(fromSec + durationSec)} с`
      : `с ${formatSeconds(fromSec)} с до конца`;
    throw new Error(`нет звука в заданном отрезке: ${file}, ${range}`);
  }
  return samples;
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

// Меньше трёх точек Pearson не отвергает сам (n>=2), но ровно 2 точки ВСЕГДА идеально «коррелируют»
// (любые две точки лежат на одной прямой) – это не сигнал, а артефакт слишком короткого перекрытия
// после сдвига. На реальных окнах (windowBlocks порядка 40 блоков, maxLagBlocks по умолчанию 6) это
// не задевает ни одного лага, но на маленьком windowBlocks (близком к maxLagBlocks) такой мусорный
// r=1 иначе выигрывал бы у настоящей корреляции на lag=0.
const MIN_LAG_OVERLAP = 3;

// Лучшая корреляция при сдвиге b относительно a в пределах ±maxLagBlocks блоков. lag > 0 значит:
// a отстаёт от b (событие в a происходит на lag блоков ПОЗЖЕ, чем в b) – обычная причина, задержка
// хвоста, буферизация муксера или микрофона на записи. При каждом лаге обрезаем несовпадающий
// край массива (Pearson требует равной длины) – при маленьком maxLagBlocks относительно длины
// входа это теряет незначительную долю сэмплов.
function bestLagPearson(a, b, maxLagBlocks) {
  let best = null;
  for (let lag = -maxLagBlocks; lag <= maxLagBlocks; lag += 1) {
    const aa = lag >= 0 ? a.subarray(lag) : a;
    const bb = lag >= 0 ? b : b.subarray(-lag);
    if (Math.min(aa.length, bb.length) < MIN_LAG_OVERLAP) continue;
    const r = pearson(aa, bb);
    if (r !== null && (best === null || r > best.r)) best = { r, lag };
  }
  return best;
}

// Самое похожее окно, где звук первого сигнала вообще слышен (короткая утечка голоса в звуке слоя).
// Гейт по ДОЛЕ слышимых блоков окна (Task 25 review, п.1), а не по средней громкости окна: короткая
// утечка размывает среднее ниже порога даже там, где сама утечка звучит в полную силу – например
// 3-секундная утечка в 5-секундном окне с фоном −90 дБФС часто не набирала −60 дБФС в среднем, и
// гейт целиком пропускал такое окно, хотя утечка внутри него реально слышна. Шаг по умолчанию –
// windowBlocks/4 (не /2): более грубый шаг чаще ставил утечку короче окна на границу двух соседних
// положений сетки. Это НЕ гарантирует, что окно целиком совпадёт с короткой утечкой (даже при
// мелком шаге утечка ровно в размер окна может лечь так, что ни одно положение сетки не берёт её
// целиком) – гарантия только в том, что окно теряет от неё не больше hop блоков с любого края, а
// гейт по доле (не по среднему) терпим именно к такому частичному захвату. Последнее окно у самого
// конца сигнала (start = n − windowBlocks) проверяется всегда, даже если сетка шагом туда не
// попадает – иначе хвост короче одного шага от предыдущего окна остаётся непроверенным. Сдвиг слоя
// относительно исходника (задержка микрофона/муксера, Task 25 review, п.2) ищется отдельно, лагом
// bestLagPearson внутри каждого окна – корреляция без лага быстро проседает уже на 100–300 мс сдвига.
function windowedMax(a, b, windowBlocks, {
  minDbA = -60, minAudibleShare = 0.4, maxLagBlocks = 6,
  hop = Math.max(1, Math.floor(windowBlocks / 4)),
} = {}) {
  // hop 0 или отрицательный зацикливал бы сетку навсегда (start += 0), NaN молча давал бы null.
  if (!(Number.isInteger(hop) && hop >= 1)) throw new Error('windowedMax: hop должен быть целым числом ≥ 1');
  const n = Math.min(a.length, b.length);
  const lastStart = n - windowBlocks;
  if (lastStart < 0) return null;
  let best = null;
  const consider = (start) => {
    const wa = a.subarray(start, start + windowBlocks);
    let audible = 0;
    for (let i = 0; i < wa.length; i += 1) if (wa[i] > minDbA) audible += 1;
    if (audible / windowBlocks < minAudibleShare) return;
    const found = bestLagPearson(wa, b.subarray(start, start + windowBlocks), maxLagBlocks);
    if (found !== null && (best === null || found.r > best.r)) {
      best = { r: found.r, startBlock: start, lag: found.lag };
    }
  };
  for (let start = 0; start <= lastStart; start += hop) consider(start);
  if (lastStart % hop !== 0) consider(lastStart);
  return best;
}

// Секунды слышимых блоков слоя (> minDb) вне известных окон звука (например cues.kept слоя,
// пересчитанные вызывающим кодом в секунды по [startFrame, startFrame+durationFrames)/fps) –
// сигнал G7 «в звуке слоя есть не только эффекты» (Task 26; сама проверка порога – там). Реверберация
// тут ни при чём: kit обрезает звук ровно на durationFrames. Запасы покрывают кодек AAC (окно MDCT
// 1024 сэмпла ≈ 21 мс на каждое из двух поколений: рендер Remotion → layer normalize): headSec до
// начала span – предэхо резкой атаки, которое AAC размазывает в предыдущий блок; tailSec после
// конца – такое же смазывание обреза и затухания.
function audibleOutside(envelope, spans, {
  minDb = -60, blockSec = BLOCK_SEC, headSec = 0.1, tailSec = 0.15,
} = {}) {
  const round6 = (value) => Math.round(value * 1e6) / 1e6;
  const extended = (spans || []).map(([from, to]) => [round6(from - headSec), round6(to + tailSec)]);
  let seconds = 0;
  const stretches = [];
  let openFrom = null;
  for (let i = 0; i < envelope.length; i += 1) {
    const t0 = round6(i * blockSec);
    const t1 = round6(t0 + blockSec);
    const inside = extended.some(([from, to]) => t1 > from && t0 < to);
    if (envelope[i] > minDb && !inside) {
      seconds += blockSec;
      if (openFrom === null) openFrom = t0;
    } else if (openFrom !== null) {
      stretches.push({ fromSec: openFrom, toSec: t0 });
      openFrom = null;
    }
  }
  if (openFrom !== null) stretches.push({ fromSec: openFrom, toSec: round6(envelope.length * blockSec) });
  return { seconds: Math.round(seconds * 100) / 100, stretches };
}

module.exports = {
  BLOCK, BLOCK_SEC, FLOOR_DB, SAMPLE_RATE,
  audibleOutside, bestLagPearson, blockDb, decodeAudio, envelopeDb, floatPcmFromFfmpeg, formatSeconds, pcmFromFfmpeg,
  pearson, windowedMax,
};
