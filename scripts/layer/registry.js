// qa/layer-imports.json: какие импортированные ассеты — проверенные слои kit (по SHA-256). Реестр пишет
// только layer import, а читают layer brief и барьер preview: слою из реестра гейты доверяют (D2).
const fs = require('node:fs');
const path = require('node:path');
const { readJsonIfExists } = require('../pult/files');
const { inspectImportedAssetBundle } = require('../review/imported-assets');
const { summarize } = require('../qa/report');
const { sha256File, writeJson } = require('./common');

const LABEL = 'qa/layer-imports.json';
const RENDER_REPORT = /^layer-.+-render-(\d+)\.json$/u;
// projects/ не в Git, копии реестра нет: битый реестр удаляют и импортируют слои заново.
const broken = (reason) => new Error(`${LABEL} повреждён (${reason}) — удалите qa/layer-imports.json и импортируйте слои заново`);

// Папка qa/ проекта или null, если её ещё нет. Ссылка или файл на её месте — ошибка: иначе отчёты и
// реестр читались бы из чужой папки, а запись реестра после импорта упала бы и оставила ассет без записи.
function qaDir(projectDir) {
  const dir = path.join(projectDir, 'qa');
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('qa/ должна быть папкой проекта, а не ссылкой или файлом — уберите её и повторите layer render');
  }
  return dir;
}

// Чтение без прохода по ссылке (readJsonIfExists): подменённый реестр не читается незаметно.
function readRegistry(projectDir) {
  const dir = qaDir(projectDir);
  let registry;
  try {
    registry = dir ? readJsonIfExists(path.join(dir, 'layer-imports.json'), LABEL) : undefined;
  } catch (error) {
    throw broken(/неверный JSON/u.test(error.message) ? 'неверный JSON' : 'не читается');
  }
  if (registry === undefined) return { version: 1, imports: [] };
  if (registry === null || typeof registry !== 'object' || !Array.isArray(registry.imports)) throw broken('нет списка imports');
  return registry;
}

// Одна запись на рендер, на ассет и на ссылку: повторный импорт того же рендера заменяет прежнюю запись.
// Запись атомарная (временный файл + rename в writeJson).
function appendRegistry(projectDir, entry) {
  const registry = readRegistry(projectDir);
  registry.imports = registry.imports.filter((e) => !(e?.renderSha256 === entry.renderSha256
    || e?.canonicalSha256 === entry.canonicalSha256 || e?.reference === entry.reference)).concat(entry);
  writeJson(path.join(projectDir, 'qa', 'layer-imports.json'), registry);
}

// Ассет записи реестра, если он цел целиком — так, как его проверяет preview (media.mp4, VP8-прокси и asset.json
// с их sha256), — и это именно он (та же ссылка и тот же sha256): запись об ассете бывает правлена руками.
// Иначе null. Повторный импорт того же рендера переиспользует такой ассет, layer brief берёт из него длину.
function layerAsset(projectDir, entry) {
  if (typeof entry?.reference !== 'string') return null;
  try {
    const record = inspectImportedAssetBundle({ projectDir, assetDirectory: path.join(projectDir, path.posix.dirname(entry.reference)) });
    return record && record.reference === entry.reference && record.canonicalSha256 === entry.canonicalSha256 ? record : null;
  } catch {
    return null;
  }
}

const findBy = (key) => (projectDir, value) => readRegistry(projectDir).imports.find((e) => e?.[key] === value) || null;
const findByCanonical = findBy('canonicalSha256');
const findByReference = findBy('reference');
const findByRender = findBy('renderSha256');

// Самый свежий отчёт layer render, в котором этот файл проверялся именно как слой: только вход role 'layer'
// (с options.path — ещё и по этому пути в проекте). Входы исходника и манифеста не считаются — иначе
// исходник-аватар нашёл бы проходящий отчёт через свой вход 'source'. Номер рендера может быть занят заново
// после дыры, поэтому свежесть — по createdAt, при равенстве — больший номер (числом, не строкой).
function findRenderReport(projectDir, sha256, { path: layerPath } = {}) {
  const dir = qaDir(projectDir);
  if (!dir) return null;
  const time = (report) => {
    const value = Date.parse(report.createdAt);
    return Number.isFinite(value) ? value : -Infinity;
  };
  const newer = (a, b) => (time(a) !== time(b) ? time(a) > time(b)
    : a.renderNumber !== b.renderNumber ? a.renderNumber > b.renderNumber : a.fileName > b.fileName);
  let best = null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const match = RENDER_REPORT.exec(entry.name);
    if (!match) continue;
    if (!entry.isFile()) throw new Error(`qa/${entry.name}: это не файл отчёта (папка или ссылка) — уберите его из qa/`);
    const report = readJsonIfExists(path.join(dir, entry.name), `qa/${entry.name}`);
    const inputs = Array.isArray(report?.inputs) ? report.inputs : [];
    const input = inputs.find((i) => i?.role === 'layer' && i.sha256 === sha256 && (layerPath === undefined || i.path === layerPath));
    if (!input) continue;
    const candidate = { ...report, fileName: entry.name, renderNumber: Number(match[1]), layerPath: input.path };
    if (!best || newer(candidate, best)) best = candidate;
  }
  return best;
}

// Почему отчёту layer render (из findRenderReport) нельзя доверять, или null. Дёшево сверяем, что это целый
// отчёт рендера: kind, слой (options.layer — слой проверяемого файла), итог равен итогу по его гейтам (итог,
// переправленный руками, не проходит) и есть оба гейта рендера G6 и G7.
function renderReportProblem(report, { layer } = {}) {
  const name = `qa/${report.fileName}`;
  const rebuild = 'пересоберите слой: automontage layer render';
  if (report.kind !== 'layer-render') return `${name} — не отчёт layer render (kind «${report.kind}»)`;
  if (layer !== undefined && report.layer !== layer) return `${name}: отчёт о слое ${report.layer}, а файл из ${layer}`;
  if (report.error !== null && report.error !== undefined) {
    return `слой не прошёл проверки: ${name} (ошибка: ${report.error}) — исправьте слой и повторите layer render`;
  }
  const gates = Array.isArray(report.gates) && report.gates.every((g) => g !== null && typeof g === 'object') ? report.gates : null;
  if (!gates) return `${name}: нет списка гейтов — отчёт повреждён; ${rebuild}`;
  const expected = summarize(gates);
  const summary = report.summary || {};
  if (summary.status !== expected.status || summary.fail !== expected.fail || summary.warn !== expected.warn) {
    return `${name}: итог «${summary.status}» не совпадает с гейтами («${expected.status}») — отчёт правили вручную; ${rebuild}`;
  }
  const missing = ['G6', 'G7'].filter((id) => !gates.some((g) => g.id === id));
  if (missing.length) return `${name}: в отчёте нет ${missing.join(' и ')} — это не полный отчёт layer render; ${rebuild}`;
  if (expected.status === 'fail') return `слой не прошёл проверки: ${name} (итог «fail») — исправьте слой и повторите layer render`;
  return null;
}

// Отчёт layer render собран для текущего исходника проекта: sha256 входа «source» равен sha256 исходника сейчас.
// Старый рендер до замены исходника не проходит; перерендер того же слоя не поможет (layer render откажет в
// assertLayerSource) — нужен новый слой. Проверяют layer import и layer brief.
function assertReportSource(report, { projectDir, sourcePath }) {
  const source = (Array.isArray(report.inputs) ? report.inputs : []).find((input) => input?.role === 'source');
  if (typeof source?.sha256 !== 'string') {
    throw new Error(`qa/${report.fileName}: в отчёте нет sha256 исходника — пересоберите: automontage layer render --project-dir "${projectDir}" --layer ${report.layer}`);
  }
  if (source.sha256 !== sha256File(sourcePath)) {
    throw new Error(`слой собран для другого исходника (отчёт qa/${report.fileName}) — создайте новый слой: `
      + `automontage layer new --project-dir "${projectDir}" → layer render → layer import`);
  }
}

// Слой прошёл layer render: целый отчёт без ошибки, итог «пройдено» или «только предупреждения».
const renderPassed = (report, options) => Boolean(report) && renderReportProblem(report, options) === null;

module.exports = {
  appendRegistry, assertReportSource, findByCanonical, findByReference, findByRender, findRenderReport, layerAsset, readRegistry, renderPassed, renderReportProblem,
};
