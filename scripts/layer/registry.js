// qa/layer-imports.json: какие импортированные ассеты — проверенные слои kit (по SHA-256). Реестр пишет
// только layer import, а читают layer brief и барьер preview: слою из реестра гейты доверяют (D2).
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('./common');

const LABEL = 'qa/layer-imports.json';
const file = (projectDir) => path.join(projectDir, 'qa', 'layer-imports.json');
const RENDER_REPORT = /^layer-.+-render-(\d+)\.json$/u;

function readRegistry(projectDir) {
  if (!fs.existsSync(file(projectDir))) return { version: 1, imports: [] };
  const registry = readJson(file(projectDir), LABEL);
  if (registry === null || typeof registry !== 'object' || !Array.isArray(registry.imports)) {
    throw new Error(`${LABEL}: нет списка imports — файл повреждён`);
  }
  return registry;
}

// Одна запись на рендер, на ассет и на ссылку: повторный импорт того же рендера заменяет прежнюю запись.
// Запись атомарная (временный файл + rename в writeJson).
function appendRegistry(projectDir, entry) {
  const registry = readRegistry(projectDir);
  registry.imports = registry.imports.filter((e) => !(e?.renderSha256 === entry.renderSha256
    || e?.canonicalSha256 === entry.canonicalSha256 || e?.reference === entry.reference)).concat(entry);
  writeJson(file(projectDir), registry);
}

const findBy = (key) => (projectDir, value) => readRegistry(projectDir).imports.find((e) => e?.[key] === value) || null;
const findByCanonical = findBy('canonicalSha256');
const findByReference = findBy('reference');
const findByRender = findBy('renderSha256');

// Самый свежий отчёт layer render, в котором этот файл проверялся именно как слой: только вход role 'layer'.
// Входы исходника и манифеста не считаются — иначе исходник-аватар нашёл бы проходящий отчёт через свой
// вход 'source' и попал бы в реестр как «проверенный слой kit». Номер рендера может быть занят заново
// после дыры, поэтому свежесть — по createdAt, при равенстве — больший номер (числом, не строкой).
function findRenderReport(projectDir, sha256) {
  const dir = path.join(projectDir, 'qa');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const time = (report) => {
    const value = Date.parse(report.createdAt);
    return Number.isFinite(value) ? value : -Infinity;
  };
  const newer = (a, b) => (time(a) !== time(b) ? time(a) > time(b)
    : a.renderNumber !== b.renderNumber ? a.renderNumber > b.renderNumber : a.fileName > b.fileName);
  let best = null;
  for (const name of names) {
    const match = RENDER_REPORT.exec(name);
    if (!match) continue;
    const report = readJson(path.join(dir, name), `qa/${name}`);
    const inputs = Array.isArray(report?.inputs) ? report.inputs : [];
    if (!inputs.some((input) => input?.role === 'layer' && input.sha256 === sha256)) continue;
    const candidate = { ...report, fileName: name, renderNumber: Number(match[1]) };
    if (!best || newer(candidate, best)) best = candidate;
  }
  return best;
}

// Слой прошёл layer render: без ошибки и итог «пройдено» или «только предупреждения».
const renderPassed = (report) => Boolean(report) && (report.error === null || report.error === undefined)
  && ['pass', 'warn'].includes(report.summary?.status);

module.exports = { appendRegistry, findByCanonical, findByReference, findByRender, findRenderReport, readRegistry, renderPassed };
