const fs = require('node:fs');
const path = require('node:path');
const { floatPcmFromFfmpeg } = require('../qa/audio');
const { readJson, sha256File } = require('./common');

const ENGINE_ROOT = path.join(__dirname, '..', '..');
const SOUND_NAME = /^[a-z0-9][a-z0-9-]*\.wav$/u;

// Дефолтная папка вправе молча отсутствовать (обычный клон без приватного пакета звуков), но явная
// AUTOMONTAGE_SFX_DIR на несуществующую папку — это опечатка в пути, а не «звуков нет»: остальной
// код молча получил бы пустую библиотеку и никто не узнал бы, что путь вообще не тот.
function sfxLibraryDir(env = process.env) {
  if (!env.AUTOMONTAGE_SFX_DIR) return path.join(ENGINE_ROOT, 'projects', '.library', 'sfx');
  const resolved = path.resolve(env.AUTOMONTAGE_SFX_DIR);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    throw new Error(`AUTOMONTAGE_SFX_DIR указывает на несуществующую папку: ${resolved}`);
  }
  return resolved;
}

// Измерение — полная полоса, 48 кГц, стерео: decodeAudio (8 кГц моно, используется гейтами ритма и
// громкости) режет антиалиасингом всё выше ~4 кГц, а у многих эффектов (импакт, шаттер, некоторые
// вжухи) самый громкий момент именно там (ревью Task 30 на реальном пакете: impact-ring — 0,823 с
// вместо истинных ~0,44 с). Сумма МОЩНОСТЕЙ каналов (L²+R², а не наивный (L+R)/2-даунмикс) — иначе
// противофазный стерео-эффект гасится почти в тишину ещё до всякого измерения пика.
const MEASURE_SAMPLE_RATE = 48000;
const MEASURE_CHANNELS = 2;
// 30 мс — компромисс из рекомендованного диапазона 20–50 мс: короче ловит резкие «тук»-транзиенты,
// не размывая их обратно к тихому пред-туку; длиннее уже усредняет соседние отдельные события.
// Шаг сетки 5 мс — не грубее самой короткой огибающей эффекта, которую есть смысл различать.
const PEAK_WINDOW_SEC = 0.03;
const PEAK_HOP_SEC = 0.005;
// Тише — эффект на практике не будет слышен в миксе; отдельная явная ошибка лучше, чем peakSec на
// случайном шуме квантования.
const SILENT_PEAK_DB = -60;

function peakWindowDb(peakPower, windowSamples) {
  const rms = Math.sqrt(Math.max(0, peakPower) / Math.max(1, windowSamples));
  return 20 * Math.log10(rms + 1e-12);
}

// Длина и пик по звуку. Пик — центр самого громкого скользящего окна (средняя энергия окна), а не
// один сэмпл: так резкий ВЧ-удар честно выигрывает у случайного мгновенного всплеска соседнего шума,
// и короткий щелчок длиной в пару миллисекунд не перевешивает более длинное и громкое «тело» звука.
function measure(file) {
  const full = floatPcmFromFfmpeg(['-i', file, '-map', '0:a:0'], { sampleRate: MEASURE_SAMPLE_RATE, channels: MEASURE_CHANNELS });
  const n = Math.floor(full.length / MEASURE_CHANNELS);
  if (n === 0) throw new Error('в файле нет звука');
  const power = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let c = 0; c < MEASURE_CHANNELS; c += 1) { const v = full[i * MEASURE_CHANNELS + c]; sum += v * v; }
    power[i] = sum;
  }
  const win = Math.max(1, Math.min(n, Math.round(PEAK_WINDOW_SEC * MEASURE_SAMPLE_RATE)));
  const hop = Math.max(1, Math.round(PEAK_HOP_SEC * MEASURE_SAMPLE_RATE));
  let windowSum = 0;
  for (let i = 0; i < win; i += 1) windowSum += power[i];
  let best = windowSum;
  let bestStart = 0;
  for (let start = hop; start + win <= n; start += hop) {
    for (let i = start - hop; i < start; i += 1) windowSum -= power[i];
    for (let i = start + win - hop; i < start + win; i += 1) windowSum += power[i];
    // Строгое «>»: при точной ничьей побеждает ПЕРВОЕ (самое раннее) окно. С «>=» повторяющийся по
    // громкости звук (два одинаковых всплеска) «уезжал» бы на последнее вхождение вместо настоящего
    // первого удара (мутационный тест ревью Task 30, «out-last-max»).
    if (windowSum > best) { best = windowSum; bestStart = start; }
  }
  if (peakWindowDb(best, win) < SILENT_PEAK_DB) {
    throw new Error(`звук беззвучный — самое громкое окно тише ${SILENT_PEAK_DB} дБФС`);
  }
  return {
    lengthSec: Number((n / MEASURE_SAMPLE_RATE).toFixed(3)),
    peakSec: Number(((bestStart + win / 2) / MEASURE_SAMPLE_RATE).toFixed(3)),
  };
}

// `|` и переносы строк ломают ячейку Markdown-таблицы SOURCE.md: экранируем `|`, переносы
// схлопываем в пробел — как обычная однострочная ячейка.
function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');
}

// library.json необязателен: без него звуки просто копируются без role/notable/volume/peakSec.
// Форма проверяется здесь же, чтобы опечатка (строка вместо числа, объект вместо boolean) стала
// понятной русской ошибкой на layer new/layer check, а не тихо испортила сгенерированный
// src/sfx-library.js слоя или всплыла непонятным исключением где-то внутри kit (resolveSound/cueVolume).
function readLibraryMeta(metaPath) {
  if (!fs.existsSync(metaPath)) return {};
  const meta = readJson(metaPath, 'library.json');
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('library.json должен быть объектом');
  }
  if (meta.license !== undefined && typeof meta.license !== 'string') {
    throw new Error('library.json → license должен быть строкой');
  }
  if (meta.sourceUrl !== undefined && typeof meta.sourceUrl !== 'string') {
    throw new Error('library.json → sourceUrl должен быть строкой');
  }
  if (meta.sounds !== undefined && (meta.sounds === null || typeof meta.sounds !== 'object' || Array.isArray(meta.sounds))) {
    throw new Error('library.json → sounds должен быть объектом {имя: {role, notable, volume, peakSec}}');
  }
  for (const [name, own] of Object.entries(meta.sounds || {})) {
    if (own === null || typeof own !== 'object' || Array.isArray(own)) {
      throw new Error(`library.json → sounds.${name} должен быть объектом {role, notable, volume, peakSec}`);
    }
    if (own.role !== undefined) {
      if (typeof own.role !== 'string') throw new Error(`library.json → sounds.${name}.role должен быть строкой`);
      if (own.role.trim() === '') throw new Error(`library.json → sounds.${name}.role не может быть пустой строкой`);
    }
    if (own.volume !== undefined && !(typeof own.volume === 'number' && Number.isFinite(own.volume) && own.volume > 0 && own.volume <= 1)) {
      throw new Error(`library.json → sounds.${name}.volume должен быть числом в диапазоне (0, 1]`);
    }
    if (own.notable !== undefined && typeof own.notable !== 'boolean') {
      throw new Error(`library.json → sounds.${name}.notable должен быть true или false`);
    }
    if (own.peakSec !== undefined && !(typeof own.peakSec === 'number' && Number.isFinite(own.peakSec) && own.peakSec >= 0)) {
      throw new Error(`library.json → sounds.${name}.peakSec должен быть числом ≥ 0`);
    }
  }
  return meta;
}

// Копирует звуки в public/sfx слоя, измеряет и хеширует каждый на СКОПИРОВАННОМ файле (провенанс —
// то, что реально попадёт в слой, а не исходник, который теоретически мог бы отличаться), и
// возвращает библиотеку для src/sfx-library.js и строки таблицы public/SOURCE.md.
//
// targetDir приводится к актуальному состоянию: старые *.wav от предыдущего запуска (звук
// переименован или убран из library.json, прошлый запуск прервался на середине) удаляются, а не
// копятся в public/sfx слоя навсегда.
//
// Имена вне ^[a-z0-9][a-z0-9-]*\.wav$ (кроме самого library.json) не копируются молча: подозрительно
// похожие на звук с опечаткой или чужим форматом попадают в `skipped`, чтобы вызывающий код мог
// предупредить о них; дотфайлы (.DS_Store и т.п.) и обычные папки — обычный «мусор» ОС и служебные
// подпапки, они игнорируются тихо и не засоряют `skipped`. Ключ library.json → sounds без
// соответствующего файла (опечатка в имени) попадает в `unknownMeta`.
//
// Битый файл (папка с именем *.wav, битая символическая ссылка, беззвучный или пустой поток) —
// явная ошибка, названная по имени файла (`library/sfx <имя>: …`), и после неё ничего не остаётся
// в targetDir.
function copySfxLibrary(libraryDir, targetDir) {
  if (!fs.existsSync(libraryDir)) return { library: { sounds: {} }, sourceRows: [], skipped: [], unknownMeta: [] };
  const meta = readLibraryMeta(path.join(libraryDir, 'library.json'));

  const names = [];
  const skipped = [];
  for (const dirent of fs.readdirSync(libraryDir, { withFileTypes: true })) {
    const entryName = dirent.name;
    if (entryName === 'library.json') continue;
    if (SOUND_NAME.test(entryName)) { names.push(entryName); continue; }
    // Не подошло под имя звука: дотфайлы и обычные папки — молча игнорируем (не опечатка, а
    // обычный «мусор» ОС или служебная подпапка); остальное подозрительно похоже на звук.
    if (entryName.startsWith('.') || dirent.isDirectory()) continue;
    skipped.push(entryName);
  }
  names.sort();
  skipped.sort();

  fs.mkdirSync(targetDir, { recursive: true });
  for (const existing of fs.readdirSync(targetDir)) {
    if (existing.toLowerCase().endsWith('.wav')) fs.rmSync(path.join(targetDir, existing), { force: true });
  }

  const sounds = {};
  const sourceRows = [];
  for (const fileName of names) {
    try {
      const name = fileName.slice(0, -4);
      const source = path.join(libraryDir, fileName);
      // fs.copyFileSync на битой символической ссылке или на папке даёт голый ENOENT/EISDIR/ENOTSUP
      // без единого слова о причине — статим цель (следует за ссылкой) и называем её по-русски сами.
      const stat = fs.statSync(source, { throwIfNoEntry: false });
      if (!stat) throw new Error('файл недоступен — возможно, битая символическая ссылка');
      if (!stat.isFile()) throw new Error('не обычный файл (папка с этим именем?)');
      const destination = path.join(targetDir, fileName);
      fs.copyFileSync(source, destination);
      try {
        const sha256 = sha256File(destination);
        const { lengthSec, peakSec: measuredPeak } = measure(destination);
        const own = meta.sounds?.[name] || {};
        let peakSec = measuredPeak;
        // Необязательный ручной peakSec — автор точно знает, где удар (или хочет его сдвинуть), и
        // не обязан полагаться на автодетект; форма (число ≥ 0) уже проверена в readLibraryMeta,
        // здесь — единственная проверка, которую можно сделать только после измерения lengthSec.
        if (own.peakSec !== undefined) {
          if (!(own.peakSec < lengthSec)) {
            throw new Error(`library.json → sounds.${name}.peakSec (${own.peakSec} с) должен быть меньше lengthSec (${lengthSec} с)`);
          }
          peakSec = own.peakSec;
        }
        sounds[name] = {
          file: `sfx/${fileName}`, lengthSec, peakSec, sha256,
          ...(own.role !== undefined ? { role: own.role } : {}),
          ...(own.notable !== undefined ? { notable: own.notable } : {}),
          ...(own.volume !== undefined ? { volume: own.volume } : {}),
        };
        sourceRows.push(`| \`sfx/${fileName}\` | ${escapeCell(meta.license || 'лицензия не указана в library.json')} | ${escapeCell(meta.sourceUrl || '—')} | ${sha256} |`);
      } catch (error) {
        // Ничего битого не остаётся в target: половинная копия хуже отсутствия звука вовсе.
        fs.rmSync(destination, { force: true });
        throw error;
      }
    } catch (error) {
      throw new Error(`library/sfx ${fileName}: ${error.message}`, { cause: error });
    }
  }

  const processedNames = new Set(names.map((fileName) => fileName.slice(0, -4)));
  const unknownMeta = Object.keys(meta.sounds || {}).filter((name) => !processedNames.has(name));

  return { library: { sounds }, sourceRows, skipped, unknownMeta };
}

module.exports = { copySfxLibrary, sfxLibraryDir };
