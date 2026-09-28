// automontage layer import — импорт отрендеренного слоя kit тем же путём, что и в Review (importReviewMedia:
// перекодирование в assets/broll/video/<id>/media.mp4 с sha256), и запись в реестр проверенных слоёв
// qa/layer-imports.json. Принимается только файл внутри проекта, чей sha256 стоит во входе «layer» самого
// свежего отчёта layer render, и только если этот отчёт без ошибки и не «стоп».
const fs = require('node:fs');
const path = require('node:path');
const { configureMediaToolPath } = require('../env');
const { openReadOnlyFlags } = require('../filesystem-capabilities');
const { probeVideo } = require('../media-probe');
const { resolveProjectPath } = require('../project/workspace');
const { createImportController, importReviewMedia } = require('../review/media-import');
const { runMediaProcess } = require('../review/media-process');
const { projectFrom, relative, sha256File } = require('./common');
const { appendRegistry, findByRender, findRenderReport, renderPassed } = require('./registry');

const FLAGS = { 'project-dir': 'value', file: 'value' };
const HINT = 'motion-vNN/renders/layer-NN.mp4';

const isInside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

// Файл слоя: внутри проекта по настоящим путям (папка-ссылка наружу не проходит, ссылки в предках самого
// проекта не мешают), сам не ссылка и обычный файл.
function resolveLayerFile(projectDir, option) {
  const absolute = path.resolve(option);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) throw new Error(`--file ${option}: файл не найден`);
  const projectReal = fs.realpathSync(projectDir);
  const real = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  if (!isInside(projectReal, real)) throw new Error(`--file ${option}: файл вне проекта — импортируется только слой из папки проекта (${HINT})`);
  if (stat.isSymbolicLink()) throw new Error(`--file ${option}: это ссылка — укажите сам файл слоя (${HINT})`);
  if (!stat.isFile()) throw new Error(`--file ${option}: это не обычный файл — укажите файл слоя (${HINT})`);
  return { file: real, stat, relativePath: relative(projectReal, real) };
}

// Ассет прошлого импорта на месте и с теми же байтами — повторный импорт того же рендера его переиспользует.
function assetIntact(projectDir, entry) {
  try {
    const target = resolveProjectPath(projectDir, entry.reference, { label: 'reference', mustExist: true, type: 'file' });
    return sha256File(target) === entry.canonicalSha256;
  } catch {
    return false;
  }
}

// Поток читается из того же дескриптора, что проверен (O_NOFOLLOW, где он есть): подмена файла ссылкой
// или другим файлом после проверки и хеша не пройдёт.
async function importLayerFile({ projectDir, sourcePath, file, stat, option }) {
  if (typeof configureMediaToolPath === 'function') configureMediaToolPath();
  const outputFps = probeVideo(sourcePath).fps;
  const descriptor = fs.openSync(file, openReadOnlyFlags());
  let request = null;
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) {
      throw new Error(`--file ${option}: файл изменился во время импорта — повторите команду`);
    }
    request = fs.createReadStream(file, { fd: descriptor, start: 0 });
    return await importReviewMedia({
      request,
      signal: new AbortController().signal,
      projectDir,
      outputFps,
      headers: {
        'content-length': String(opened.size),
        'content-type': 'video/mp4',
        'x-automontage-filename': encodeURIComponent(path.basename(file)),
      },
      controller: createImportController(),
      runMediaProcessImpl: runMediaProcess,
    });
  } finally {
    // Поток закрывает дескриптор сам (autoClose) и дожидается незаконченного чтения.
    if (request) request.destroy();
    else fs.closeSync(descriptor);
  }
}

// deps.log — вывод (тихий в тестах).
async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const { projectDir, sourcePath } = projectFrom(options);
  if (!options.file) throw new Error(`нужен --file <${HINT}>`);
  const { file, stat, relativePath } = resolveLayerFile(projectDir, options.file);
  const renderSha256 = sha256File(file);
  const report = findRenderReport(projectDir, renderSha256);
  if (!report) {
    throw new Error('этот файл не проходил layer render: импортируется только проверенный слой — '
      + `его sha256 нет во входе «layer» ни одного отчёта qa/layer-<слой>-render-NN.json (${relativePath})`);
  }
  if (!renderPassed(report)) {
    const why = report.error ? `ошибка: ${report.error}` : `итог «${report.summary?.status ?? 'нет'}»`;
    throw new Error(`слой не прошёл проверки: qa/${report.fileName} (${why}) — исправьте слой и повторите layer render`);
  }

  const existing = findByRender(projectDir, renderSha256);
  let asset;
  if (existing && assetIntact(projectDir, existing)) {
    asset = existing;
    log(`Этот рендер уже импортирован: ${existing.reference} — новый ассет не создан`);
  } else {
    asset = await importLayerFile({ projectDir, sourcePath, file, stat, option: options.file });
  }
  const entry = {
    layer: report.layer,
    render: report.renderNumber,
    renderFile: relativePath,
    renderReport: `qa/${report.fileName}`,
    renderSha256,
    profile: report.profile,
    assetId: path.posix.basename(path.posix.dirname(asset.reference)),
    reference: asset.reference,
    canonicalSha256: asset.canonicalSha256,
    createdAt: asset === existing ? existing.createdAt : new Date().toISOString(),
  };
  appendRegistry(projectDir, entry);
  log(JSON.stringify({ reference: entry.reference, canonicalSha256: entry.canonicalSha256 }, null, 2));
  log(`Дальше: automontage layer brief --project-dir "${projectDir}" --asset ${entry.reference} --title … --head-cream … --head-orange …`);
  return 0;
}

module.exports = { FLAGS, run };
