// automontage layer stock — сток Pexels в слой: поиск тем же клиентом, что B-roll discovery в Review
// (scripts/broll/pexels.js, requestRemote с разрешёнными хостами и лимитом размера), обрезка и кадрирование
// под слой без звука в public/stock/pexels-<id>.mp4 и строка источника в public/SOURCE.md.
// Ключ PEXELS_API_KEY необязателен: без него команда объясняет, как положить клип вручную.
// Ключ читается локально (окружение, затем .env движка) и никуда, кроме заголовка запроса к api.pexels.com,
// не попадает: ни в сообщения, ни в SOURCE.md, ни на CDN с видео.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadBrollConfig } = require('../broll/config');
const { createPexelsProvider, VIDEO_HOSTS } = require('../broll/pexels');
const { LIMITS, requestRemote } = require('../broll/remote');
const { probeVideo } = require('../media-probe');
const { buildLayerManifest } = require('../motion-kit-node');
const { runTool } = require('../process');
const { formatNumber, readLayerJson, resolveLayer, sha256File } = require('./common');

const ENGINE_ROOT = path.join(__dirname, '..', '..');
const FLAGS = { 'project-dir': 'value', layer: 'value', query: 'value', 'query-original': 'value', sec: 'value', insert: 'value', pick: 'value', list: 'bool' };
const DEFAULT_SEC = 2.5;
const MAX_SEC = 60;
const ASSET_ID = /^[1-9]\d{0,19}$/u;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

// Коды ошибок scripts/broll/* — по-русски и без подробностей ответа: в них никогда нет ключа.
const MESSAGES = {
  BROLL_CONFIG_INVALID: 'PEXELS_API_KEY или .env движка неверного вида (пробелы, управляющие символы, файл больше 64 КБ) — проверьте запись; значение ключа не показываем',
  BROLL_PROVIDER_UNSUPPORTED: 'BROLL_SEARCH_PROVIDER: поддерживается только pexels',
  BROLL_SEARCH_INVALID: '--query и --query-original: пустой, слишком длинный или со служебными символами запрос',
  BROLL_PROVIDER_FAILED: 'Pexels не ответил или отказал (ключ, лимит запросов или сеть) — повторите позже или положите клип вручную',
  BROLL_REMOTE_TIMEOUT: 'Pexels не ответил вовремя — повторите позже',
  BROLL_REMOTE_ABORTED: 'запрос к Pexels прерван',
  BROLL_REMOTE_REJECTED: 'скачать клип не вышло (хост не Pexels, не video/mp4, больше 256 МБ или обрыв) — выберите другой --pick',
};
function explain(error, prefix) {
  if (typeof error?.code === 'string' && Object.hasOwn(MESSAGES, error.code)) {
    return new Error(`${prefix}${MESSAGES[error.code]}`, { cause: error });
  }
  return error;
}

// Длина клипа: явный --sec, иначе длина вставки --insert (вверх до 0,1 с), иначе 2,5 с.
function clipSeconds(options, layerDir) {
  let insertSec = null;
  if (options.insert !== undefined) {
    const manifest = buildLayerManifest(layerDir);
    const stocks = manifest.inserts.filter((i) => i.kind === 'stock');
    const insert = stocks.find((i) => i.id === options.insert);
    if (!insert) {
      throw new Error(`вставки ${options.insert} нет среди stock-вставок plan.js: ${stocks.map((i) => i.id).join(', ') || 'их нет — добавьте { kind: \'stock\' } в inserts'}`);
    }
    insertSec = Math.ceil(((insert.to - insert.from) / manifest.fps) * 10 - 1e-9) / 10;
  }
  if (options.sec !== undefined) {
    const sec = Number(options.sec);
    if (!/^\d+(\.\d+)?$/u.test(options.sec) || !(sec > 0) || sec > MAX_SEC) throw new Error(`--sec: число секунд больше 0 и не больше ${MAX_SEC}`);
    return { sec, insertSec };
  }
  return { sec: insertSec ?? DEFAULT_SEC, insertSec };
}

function loadKey(env, root, { layerName, layer, sec }) {
  try {
    return loadBrollConfig({ env, root: root ?? undefined }).apiKey;
  } catch (error) {
    if (error?.code !== 'BROLL_KEY_MISSING') throw explain(error, '');
    throw new Error([
      'PEXELS_API_KEY не задан — поиск стока необязателен, монтаж работает и без него.',
      `Без ключа: положите свой клип (mp4, ${layer.width}×${layer.height}, не короче ${formatNumber(sec)} с) в ${layerName}/public/stock/,`,
      'пропишите его src во вставке { kind: \'stock\' } в src/plan.js и добавьте строку в public/SOURCE.md',
      '(файл | лицензия, автор | ссылка на источник | SHA-256).',
      'С ключом: добавьте PEXELS_API_KEY в окружение или в .env движка и повторите команду.',
    ].join(' '));
  }
}

// Ячейка Markdown-таблицы: без управляющих символов и переводов строк, | экранирован.
const cell = (value) => String(value ?? '').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim().replace(/\|/gu, '\\|');

function assertCandidate(candidate) {
  let url;
  try { url = new URL(candidate?.downloadUrl); } catch { url = null; }
  if (!ASSET_ID.test(String(candidate?.providerAssetId ?? '')) || !url || url.protocol !== 'https:'
    || !VIDEO_HOSTS.includes(url.hostname) || !/\.mp4$/iu.test(url.pathname)
    || typeof candidate.sourcePage !== 'string' || typeof candidate.author?.name !== 'string' || typeof candidate.license?.name !== 'string') {
    throw new Error('кандидат Pexels без числового id, ссылки на mp4 с videos.pexels.com или без лицензии и автора — выберите другой --pick');
  }
}

// Папки назначения — настоящие папки слоя, не симлинки наружу.
function realDir(dir, label) {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Error(`${label} должна быть папкой, а не симлинком или файлом`);
  if (!stat) fs.mkdirSync(dir);
}

// mp4 начинается с бокса ftyp: HTML-страница ошибки или пустой ответ с типом video/mp4 сюда не пройдут.
const looksLikeMp4 = (bytes) => Buffer.isBuffer(bytes) && bytes.length >= 12 && bytes.length <= LIMITS.video
  && bytes.subarray(4, 8).toString('latin1') === 'ftyp';

async function run(options, deps = {}) {
  const env = deps.env || process.env;
  const log = deps.log || console.log;
  const root = Object.hasOwn(deps, 'root') ? deps.root : ENGINE_ROOT;
  const { layerDir, layerName } = resolveLayer(options);
  if (!options.query) throw new Error('нужен --query (английский запрос для Pexels)');
  const pick = options.pick === undefined ? 1 : Number(options.pick);
  if (!Number.isSafeInteger(pick) || pick < 1 || !/^\d+$/u.test(String(options.pick ?? 1))) throw new Error('--pick: номер кандидата из --list, от 1');
  const layer = readLayerJson(layerDir);
  const { sec, insertSec } = clipSeconds(options, layerDir);
  const apiKey = loadKey(env, root, { layerName, layer, sec });
  const queryOriginal = options['query-original'] || options.query;

  const provider = (deps.createProvider || createPexelsProvider)({ apiKey });
  let candidates;
  try {
    ({ candidates } = await provider.search({ mediaKind: 'video', queryEnglish: options.query, queryOriginal,
      orientation: layer.height > layer.width ? 'portrait' : layer.height < layer.width ? 'landscape' : 'square', minDurationSec: sec }));
  } catch (error) {
    throw explain(error, 'поиск Pexels: ');
  }
  if (!Array.isArray(candidates) || !candidates.length) throw new Error('Pexels ничего не нашёл: переформулируйте --query');
  if (options.list) {
    candidates.forEach((c, i) => log(cell(`${i + 1}. ${c.providerAssetId} ${c.width}×${c.height} ${c.durationSec} с — ${c.author?.name} ${c.sourcePage}`)));
    return 0;
  }
  const candidate = candidates[pick - 1];
  if (!candidate) throw new Error(`--pick вне списка 1–${candidates.length}`);
  assertCandidate(candidate);

  const publicDir = path.join(layerDir, 'public');
  realDir(publicDir, 'public/');
  realDir(path.join(publicDir, 'stock'), 'public/stock/');
  const name = `pexels-${candidate.providerAssetId}.mp4`;
  const target = path.join(publicDir, 'stock', name);
  if (fs.existsSync(target)) {
    throw new Error(`stock/${name} уже есть (клип другой вставки) — не перезаписываем: выберите другой --pick или удалите старый файл, если он больше не нужен`);
  }

  let response;
  try {
    // Без headers: ключ уходит только на api.pexels.com, CDN с видео его не видит.
    response = await (deps.request || requestRemote)({ url: candidate.downloadUrl, allowedHosts: VIDEO_HOSTS,
      maxBytes: LIMITS.video, timeoutMs: 120_000, expectedMimeTypes: ['video/mp4'] });
  } catch (error) {
    throw explain(error, 'скачивание клипа Pexels: ');
  }
  if (response?.contentType !== 'video/mp4' || !looksLikeMp4(response.bytes)) {
    throw new Error('Pexels отдал не mp4-видео (другой тип, пустой ответ или больше 256 МБ) — выберите другой --pick');
  }

  const outDir = path.join(layerDir, 'out');
  realDir(outDir, 'out/');
  const tag = `stock-${candidate.providerAssetId}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const download = path.join(outDir, `${tag}.download.mp4`);
  const normalized = path.join(outDir, `${tag}.mp4`);
  try {
    fs.writeFileSync(download, response.bytes, { flag: 'wx' });
    let probe;
    try { probe = probeVideo(download, { stage: 'layer stock probe' }); } catch { probe = null; }
    if (!probe || probe.width > 4096 || probe.height > 4096) {
      throw new Error('скачанный файл Pexels не читается как видео до 4096 px — выберите другой --pick');
    }
    const { width, height, fps } = layer;
    runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-i', download, '-t', String(sec),
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}`,
      '-an', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', normalized], { stage: 'layer stock normalize' });
    // COPYFILE_EXCL: файл с тем же именем, появившийся за время скачивания, не перезаписывается.
    fs.copyFileSync(normalized, target, fs.constants.COPYFILE_EXCL);
  } finally {
    fs.rmSync(download, { force: true });
    fs.rmSync(normalized, { force: true });
  }

  const duration = probeVideo(target, { stage: 'layer stock result' }).duration;
  const details = [`лицензия ${candidate.license.url}`, `автор ${candidate.author.url}`, `запрос «${queryOriginal}» (${options.query})`,
    `получено ${candidate.retrievedAt}`, `${formatNumber(sec)} с из ${formatNumber(candidate.durationSec)} с`].map(cell).join('; ');
  const row = `| \`stock/${name}\` | ${cell(`${candidate.license.name}, ${candidate.author.name}`)} | ${cell(candidate.sourcePage)} | ${sha256File(target)} | ${details} |`;
  // Сторож на случай чужого провайдера: ключ не должен попасть в файл, который уходит вместе со слоем.
  if (row.includes(apiKey)) {
    fs.rmSync(target, { force: true });
    throw new Error('ответ Pexels содержит ключ — строка источника не записана, клип удалён');
  }
  const sourceFile = path.join(publicDir, 'SOURCE.md');
  const header = fs.existsSync(sourceFile) ? ''
    : '# Источники материалов слоя\n\n| Файл | Лицензия / автор | Источник | SHA-256 или команда |\n|---|---|---|---|\n';
  fs.appendFileSync(sourceFile, `${header}${row}\n`);

  const where = options.insert ? `вставке ${options.insert}` : 'вставке { kind: \'stock\' }';
  log(`✅ сток stock/${name} (${formatNumber(duration)} с): поставьте src: 'stock/${name}' ${where} в src/plan.js`);
  if (insertSec !== null && duration < insertSec - 1 / layer.fps) {
    log(`⚠️ клип ${formatNumber(duration)} с короче вставки ${options.insert} (${formatNumber(insertSec)} с) — последний кадр замрёт`);
  }
  return 0;
}

module.exports = { FLAGS, run };
