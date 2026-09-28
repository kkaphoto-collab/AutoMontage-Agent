const fs = require('node:fs');
const path = require('node:path');
const { loadKitCore } = require('../motion-kit-node');
const { readProjectManifest, resolveProjectPath } = require('../project/workspace');
const { hashFile, writeJsonAtomic } = require('../pult/files');

const LAYER_NAME = /^motion-v\d{2,3}$/u;

// Ошибки называют флаг или файл: голые ENOENT с lstat и SyntaxError без имени файла не говорят, что чинить.
function projectFrom(options) {
  if (!options['project-dir']) throw new Error('нужен --project-dir');
  const projectDir = path.resolve(options['project-dir']);
  if (!fs.statSync(projectDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`--project-dir ${options['project-dir']}: папка не найдена`);
  }
  let manifest;
  try {
    manifest = readProjectManifest(projectDir);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`project.json: неверный JSON (${error.message})`);
    if (String(error?.message).startsWith('project.json')) throw error;
    throw new Error(`project.json: ${error?.message ?? String(error)}`);
  }
  const sourcePath = resolveProjectPath(projectDir, manifest.source.localPath, { label: 'manifest.source.localPath', mustExist: true, type: 'file' });
  return { projectDir, manifest, sourcePath };
}

// Проверка папки идёт в два шага. Сначала простое «есть ли она вообще» человеческим сообщением с
// подсказкой команды — это самый частый случай (опечатка в номере или слой ещё не создан).
// Затем resolveProjectPath — вторая линия защиты (симлинк наружу или внутрь проекта, файл вместо
// папки): её английские сообщения оборачиваем «--layer <имя>: …», чтобы было видно, о каком флаге
// речь, не переводя каждое дословно (текст остаётся источником истины самой workspace.js).
function resolveLayer(options) {
  const project = projectFrom(options);
  const name = options.layer;
  if (!LAYER_NAME.test(name || '')) throw new Error('--layer должен быть вида motion-v01');
  if (!fs.existsSync(path.join(project.projectDir, name))) {
    throw new Error(`папка слоя ${name} не найдена — создайте: automontage layer new --project-dir "${project.projectDir}"`);
  }
  let layerDir;
  try {
    layerDir = resolveProjectPath(project.projectDir, name, { label: 'layer', mustExist: true, type: 'directory' });
  } catch (error) {
    throw new Error(`--layer ${name}: ${error.message}`);
  }
  return { ...project, layerName: name, layerDir };
}

// Следующее свободное имя слоя — максимум существующих + 1, номера никогда не переиспользуются:
// на них могут ссылаться уже написанные qa-отчёты и pult-card.json. Считаем по именам записей
// каталога (readdir), а не циклом fs.existsSync по номерам от 1: битый (dangling) симлинк с именем
// motion-vNN existsSync считает несуществующим, и старая версия отдавала уже занятый номер
// повторно — readdir видит запись по имени независимо от того, что за ней (файл, папка, симлинк
// любого рода).
function nextLayerName(projectDir) {
  let entries;
  try {
    entries = fs.readdirSync(projectDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') entries = [];
    else throw error;
  }
  let max = 0;
  for (const entry of entries) {
    if (LAYER_NAME.test(entry)) max = Math.max(max, Number(entry.slice('motion-v'.length)));
  }
  return `motion-v${String(max + 1).padStart(2, '0')}`;
}

// Тот же стиль сообщения, что у readJsonIfExists (scripts/pult/files.js): называем файл, а не
// печатаем голый SyntaxError с путём целиком.
function readJson(file, label) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label || path.basename(file)}: неверный JSON (${error.message})`);
  }
}

// Неверный sfxMasterDb ловится при чтении, а не на рендере: та же проверка, что в SfxTrack.
// Отдельно отсекаем не-объект (массив, null, примитив через валидный JSON) — иначе assertMasterDb
// упал бы на «Cannot read properties of null» вместо понятного сообщения про сам layer.json.
//
// Папка без layer.json — след оборванного layer new (layer.json он пишет последним, а SIGKILL уборку
// не даёт): вместо голого ENOENT с абсолютным путём говорим, что это и что делать.
function readLayerJson(layerDir) {
  const file = path.join(layerDir, 'layer.json');
  let layer;
  try {
    layer = readJson(file, 'layer.json');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error(`${path.basename(layerDir)} собран не до конца (нет layer.json) — удалите папку или создайте новый слой: `
      + `automontage layer new --project-dir "${path.dirname(layerDir)}"`, { cause: error });
  }
  if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) {
    throw new Error('layer.json должен быть объектом');
  }
  loadKitCore().assertMasterDb(layer.sfxMasterDb);
  return layer;
}

// Стриминг кусками по 1 МиБ (renders весят сотни МБ) — та же hashFile, что уже считает sha256
// превью и финалов в пульте, вместо повторного чтения всего файла в память.
const sha256File = hashFile;

const SHA256 = /^[a-f0-9]{64}$/u;

// Размер и mtime исходника те же, что записал layer new, — байты считаем теми же (как make и rsync) и
// не хешируем исходник на сотни МБ при каждой команде. Старый layer.json без них — всегда sha256.
const sameStat = (recorded, stat) => Number.isFinite(recorded.size) && Number.isFinite(recorded.mtimeMs)
  && recorded.size === stat.size && recorded.mtimeMs === stat.mtimeMs;

// Слой живёт с одним исходником: кадры speaker.mp4, длина слоя, слова и манифест гейтов должны быть
// от одного файла. layer.json.source записывает layer new; если в проекте теперь другой исходник
// (путь, ревизия или байты), слой разошёлся бы с ним — нужен новый слой. project — результат
// resolveLayer.
function assertLayerSource({ projectDir, manifest, sourcePath, layerName }, layer) {
  const recorded = layer.source;
  if (recorded === null || typeof recorded !== 'object' || typeof recorded.localPath !== 'string' || !SHA256.test(String(recorded.sha256))) {
    throw new Error(`layer.json: нет source (путь и sha256 исходника) — не видно, от какого исходника слой ${layerName}; создайте новый слой: automontage layer new --project-dir "${projectDir}"`);
  }
  const current = { localPath: manifest.source.localPath, revision: manifest.source.revision };
  let sha = null;
  let same = recorded.localPath === current.localPath && (recorded.revision === undefined || recorded.revision === current.revision);
  if (same && !sameStat(recorded, fs.statSync(sourcePath))) {
    sha = sha256File(sourcePath);
    same = sha === recorded.sha256;
  }
  if (same) return;
  const describe = ({ localPath, revision }, hash) => [localPath, Number.isInteger(revision) ? `ревизия ${revision}` : null,
    hash ? `sha256 ${hash.slice(0, 12)}…` : null].filter(Boolean).join(', ');
  throw new Error(`исходник проекта сменился после создания слоя ${layerName}: слой собран на ${describe(recorded, recorded.sha256)}, `
    + `а в проекте сейчас ${describe(current, sha)} — кадры и слова слоя разошлись бы с ним; создайте новый слой: automontage layer new --project-dir "${projectDir}"`);
}

// writeJsonAtomic (scripts/pult/files.js) уже даёт: временный файл + rename (обрыв записи не
// оставит половинчатый JSON), проверку, что папка назначения не симлинк, и chmod. Название и
// сигнатура writeJson(file, value) остаются прежними для будущих команд слоя.
function writeJson(file, value) {
  writeJsonAtomic(file, value);
}

const relative = (projectDir, file) => path.relative(projectDir, file).split(path.sep).join('/');

// Число для сообщений по-русски: до сотых, с запятой (29,97 fps, 6,3 с).
const formatNumber = (value) => String(Number(Number(value).toFixed(2))).replace('.', ',');

module.exports = {
  LAYER_NAME, assertLayerSource, formatNumber, nextLayerName, projectFrom, readJson, readLayerJson, relative, resolveLayer, sha256File, writeJson,
};
