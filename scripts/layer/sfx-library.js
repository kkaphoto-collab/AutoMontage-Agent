const fs = require('node:fs');
const path = require('node:path');
const { SAMPLE_RATE, decodeAudio } = require('../qa/audio');
const { readJson, sha256File } = require('./common');

const ENGINE_ROOT = path.join(__dirname, '..', '..');
const SOUND_NAME = /^[a-z0-9][a-z0-9-]*\.wav$/u;

function sfxLibraryDir(env = process.env) {
  return env.AUTOMONTAGE_SFX_DIR ? path.resolve(env.AUTOMONTAGE_SFX_DIR) : path.join(ENGINE_ROOT, 'projects', '.library', 'sfx');
}

function measure(file) {
  const samples = decodeAudio(file);
  let peak = 0;
  let at = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i]);
    if (v > peak) { peak = v; at = i; }
  }
  return { lengthSec: Number((samples.length / SAMPLE_RATE).toFixed(3)), peakSec: Number((at / SAMPLE_RATE).toFixed(3)) };
}

// `|` и переносы строк ломают ячейку Markdown-таблицы SOURCE.md: экранируем `|`, переносы
// схлопываем в пробел — как обычная однострочная ячейка.
function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');
}

// library.json необязателен: без него звуки просто копируются без role/notable/volume. Форма
// проверяется здесь же, чтобы опечатка (строка вместо числа, объект вместо boolean) стала понятной
// русской ошибкой на layer new/layer check, а не тихо испортила сгенерированный src/sfx-library.js
// слоя или всплыла непонятным исключением где-то внутри kit (resolveSound/cueVolume).
function readLibraryMeta(metaPath) {
  if (!fs.existsSync(metaPath)) return {};
  const meta = readJson(metaPath, 'library.json');
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('library.json должен быть объектом');
  }
  if (meta.sounds !== undefined && (meta.sounds === null || typeof meta.sounds !== 'object' || Array.isArray(meta.sounds))) {
    throw new Error('library.json → sounds должен быть объектом {имя: {role, notable, volume}}');
  }
  for (const [name, own] of Object.entries(meta.sounds || {})) {
    if (own === null || typeof own !== 'object' || Array.isArray(own)) {
      throw new Error(`library.json → sounds.${name} должен быть объектом {role, notable, volume}`);
    }
    if (own.role !== undefined && typeof own.role !== 'string') {
      throw new Error(`library.json → sounds.${name}.role должен быть строкой`);
    }
    if (own.volume !== undefined && !(typeof own.volume === 'number' && Number.isFinite(own.volume) && own.volume > 0 && own.volume <= 1)) {
      throw new Error(`library.json → sounds.${name}.volume должен быть числом в диапазоне (0, 1]`);
    }
    if (own.notable !== undefined && typeof own.notable !== 'boolean') {
      throw new Error(`library.json → sounds.${name}.notable должен быть true или false`);
    }
  }
  return meta;
}

// Копирует звуки в public/sfx слоя, измеряет каждый (длина, пик, sha256) и возвращает библиотеку
// для src/sfx-library.js и строки таблицы public/SOURCE.md. Имена вне
// ^[a-z0-9][a-z0-9-]*\.wav$ (кроме самого library.json) не копируются молча — они попадают в
// skipped, чтобы вызывающий код мог предупредить об опечатке или чужом формате, а не оставить
// звук просто «не появившимся» без единого следа.
function copySfxLibrary(libraryDir, targetDir) {
  if (!fs.existsSync(libraryDir)) return { library: { sounds: {} }, sourceRows: [], skipped: [] };
  const meta = readLibraryMeta(path.join(libraryDir, 'library.json'));
  const entries = fs.readdirSync(libraryDir).sort();
  const names = entries.filter((name) => SOUND_NAME.test(name));
  const skipped = entries.filter((name) => name !== 'library.json' && !SOUND_NAME.test(name));
  fs.mkdirSync(targetDir, { recursive: true });
  const sounds = {};
  const sourceRows = [];
  for (const fileName of names) {
    const name = fileName.slice(0, -4);
    const source = path.join(libraryDir, fileName);
    fs.copyFileSync(source, path.join(targetDir, fileName));
    const sha256 = sha256File(source);
    const own = meta.sounds?.[name] || {};
    sounds[name] = {
      file: `sfx/${fileName}`, ...measure(source), sha256,
      ...(own.role !== undefined ? { role: own.role } : {}),
      ...(own.notable !== undefined ? { notable: own.notable } : {}),
      ...(own.volume !== undefined ? { volume: own.volume } : {}),
    };
    sourceRows.push(`| \`sfx/${fileName}\` | ${escapeCell(meta.license || 'лицензия не указана в library.json')} | ${escapeCell(meta.sourceUrl || '—')} | ${sha256} |`);
  }
  return { library: { sounds }, sourceRows, skipped };
}

module.exports = { copySfxLibrary, sfxLibraryDir };
