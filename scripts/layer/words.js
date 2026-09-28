const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { resolveProjectPath } = require('../project/workspace');
const { loadKitCore } = require('../motion-kit-node');
const { ensureDirectory } = require('../pult/files');
const { assertLayerSource, formatNumber, readJson, readLayerJson, resolveLayer } = require('./common');

const FLAGS = { 'project-dir': 'value', layer: 'value' };

// Транскрипт проекта: путь из project.json, обязан существовать. layer new проверяет его ещё до
// создания папки слоя, чтобы отказ не оставлял половины слоя.
function transcriptPath(projectDir, manifest) {
  const stored = manifest.transcript?.words;
  let file;
  try {
    file = resolveProjectPath(projectDir, stored, { label: 'manifest.transcript.words', mustExist: false, type: 'file' });
  } catch (error) {
    throw new Error(`транскрипт проекта: ${error.message}`);
  }
  if (!fs.existsSync(file)) throw new Error(`нет транскрипта ${stored} — сначала расшифруйте исходник проекта`);
  return file;
}

// spelling.json — {как услышал Whisper: как писать на экране}. Форма проверяется до записи words.js:
// null или массив иначе дали бы невнятный TypeError внутри kit, а старый words.js остаётся целым.
function readSpelling(layerDir) {
  const file = path.join(layerDir, 'spelling.json');
  if (!fs.existsSync(file)) return {};
  const spelling = readJson(file, 'spelling.json');
  if (spelling === null || typeof spelling !== 'object' || Array.isArray(spelling)) {
    throw new Error('spelling.json должен быть объектом {"как слышно": "как писать"}');
  }
  for (const [key, value] of Object.entries(spelling)) {
    if (typeof value !== 'string') throw new Error(`spelling.json → «${key}» должно быть строкой`);
  }
  return spelling;
}

const quoted = (items, limit = 5) => `${items.slice(0, limit).map((item) => `«${item}»`).join(', ')}${items.length > limit ? ', …' : ''}`;

// Что автору стоит знать о написании и словах: ключ spelling, который ничего не заменил (опечатка
// или ключ из нескольких слов — kit сверяет слова по одному), и слова после конца исходника.
function wordNotes(words, spelling, durationSec, normWord) {
  const notes = [];
  const heard = new Set(words.map((word) => normWord(word.w)));
  const keys = Object.keys(spelling);
  const multi = keys.filter((key) => /\s/u.test(key.trim()));
  const missing = keys.filter((key) => !/\s/u.test(key.trim()) && !heard.has(normWord(key)));
  if (multi.length) notes.push(`⚠️ spelling.json: ключи из нескольких слов не поддерживаются — kit сверяет слова по одному: ${quoted(multi)}`);
  if (missing.length) notes.push(`⚠️ spelling.json: этих слов нет в транскрипте — написание не применилось: ${quoted(missing)}`);
  if (Number.isFinite(durationSec)) {
    const late = words.filter((word) => word.s >= durationSec);
    if (late.length) notes.push(`⚠️ слова транскрипта после конца исходника (${formatNumber(durationSec)} с) — в слое их не будет: ${quoted(late.map((word) => word.w))}`);
  }
  return notes;
}

// Временный файл + rename: оборванная запись не оставит половины words.js, а симлинк на месте
// words.js заменяется новым файлом, а не пишется насквозь (папка src сама не может быть симлинком).
function writeTextAtomic(file, text) {
  ensureDirectory(path.dirname(file));
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

// Слова транскрипта проекта → src/words.js слоя с написанием из spelling.json. durationSec — длина
// исходника слоя (для предупреждения о хвосте), warn — куда писать предупреждения.
function writeLayerWords(projectDir, manifest, layerDir, { durationSec, warn = () => {} } = {}) {
  const transcript = transcriptPath(projectDir, manifest);
  const spelling = readSpelling(layerDir);
  const core = loadKitCore();
  const words = core.flattenTranscript(readJson(transcript, manifest.transcript.words), { spelling });
  for (const note of wordNotes(words, spelling, durationSec, core.normWord)) warn(note);
  writeTextAtomic(path.join(layerDir, 'src', 'words.js'), `// Сгенерировано automontage layer words — не править руками.\nexport default ${JSON.stringify(words)};\n`);
  return words.length;
}

async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const warn = deps.warn || console.warn;
  const target = resolveLayer(options);
  const layer = readLayerJson(target.layerDir);
  assertLayerSource(target, layer);
  const count = writeLayerWords(target.projectDir, target.manifest, target.layerDir, { durationSec: layer.durationInFrames / layer.fps, warn });
  log(`✅ слов: ${count} → ${path.join(target.layerName, 'src', 'words.js')}`);
  return 0;
}

module.exports = { FLAGS, run, transcriptPath, writeLayerWords };
