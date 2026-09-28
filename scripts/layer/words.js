const fs = require('node:fs');
const path = require('node:path');
const { resolveProjectPath } = require('../project/workspace');
const { loadKitCore } = require('../motion-kit-node');
const { readJson, resolveLayer } = require('./common');

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

// Слова транскрипта проекта → src/words.js слоя с написанием из spelling.json.
function writeLayerWords(projectDir, manifest, layerDir) {
  const transcript = transcriptPath(projectDir, manifest);
  const spelling = readSpelling(layerDir);
  const words = loadKitCore().flattenTranscript(readJson(transcript, manifest.transcript.words), { spelling });
  fs.mkdirSync(path.join(layerDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'src', 'words.js'), `// Сгенерировано automontage layer words — не править руками.\nexport default ${JSON.stringify(words)};\n`);
  return words.length;
}

async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const { projectDir, manifest, layerDir, layerName } = resolveLayer(options);
  const count = writeLayerWords(projectDir, manifest, layerDir);
  log(`✅ слов: ${count} → ${path.join(layerName, 'src', 'words.js')}`);
  return 0;
}

module.exports = { FLAGS, run, transcriptPath, writeLayerWords };
