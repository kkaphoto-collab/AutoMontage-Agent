// automontage layer check — гейты по плану слоя за секунды, без рендера: plan.js → манифест kit →
// G1–G5, G9–G11. Пишет <слой>/out/manifest.json (по нему layer render судит звук) и qa-отчёт.
// Код: 0 — пройдено или только предупреждения, 1 — стоп, 2 — оценить нельзя.
const fs = require('node:fs');
const path = require('node:path');
const { buildLayerManifest } = require('../motion-kit-node');
const { getProfile } = require('../qa/profiles');
const { buildReport, exitCodeFor, formatReport, writeReport } = require('../qa/report');
const { runTimelineGates } = require('../qa/timeline-gates');
const { assertLayerSource, readLayerJson, relative, resolveLayer, sha256File, writeJson } = require('./common');

const FLAGS = { 'project-dir': 'value', layer: 'value', profile: 'value' };

// Манифест прошлой проверки убирается до новой: после отказа out/manifest.json не должен выглядеть
// результатом этой проверки. Только в настоящей папке out — через симлинк не удаляем (запись манифеста
// туда откажет сама, writeJsonAtomic).
function removeOldManifest(layerDir) {
  const outDir = path.join(layerDir, 'out');
  if (fs.lstatSync(outDir, { throwIfNoEntry: false })?.isDirectory()) fs.rmSync(path.join(outDir, 'manifest.json'), { force: true });
}

// deps.buildLayerManifest — подмена сборки в тестах (испорченный манифест, брошенный не-Error).
async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const buildManifest = deps.buildLayerManifest || buildLayerManifest;
  const target = resolveLayer(options);
  const { projectDir, layerDir, layerName } = target;
  let profileName = options.profile || 'avatar';
  // inputs — манифест, по которому судили гейты (путь от папки проекта и sha256): отчёт привязан к нему.
  let inputs = [];
  let report;
  // Всё, что может отказать после выбора слоя, — внутри try: испорченный layer.json, другой исходник
  // проекта, сборка и граница plan.js, «манифест повреждён» из гейтов. Такой отказ — отчёт с error
  // (код 2), а не «layer check отменён» без отчёта; брошено может быть и не Error.
  try {
    removeOldManifest(layerDir);
    const layer = readLayerJson(layerDir);
    profileName = options.profile || layer.profile || 'avatar';
    const profile = getProfile(profileName);
    assertLayerSource(target, layer);
    const manifest = buildManifest(layerDir);
    const manifestPath = path.join(layerDir, 'out', 'manifest.json');
    writeJson(manifestPath, manifest);
    inputs = [{ path: relative(projectDir, manifestPath), sha256: sha256File(manifestPath) }];
    const gates = runTimelineGates(manifest, profile);
    // Исключение, которое ничего не сняло (гейт прошёл или дал только warn), показываем автору.
    const waivers = Array.isArray(manifest.waivers) ? manifest.waivers : [];
    const unusedWaivers = waivers.filter((w) => !gates.some((g) => g.id === w.gate && g.status === 'waived'));
    report = buildReport({ kind: 'layer-check', layer: layerName, profile: profileName, gates, inputs, unusedWaivers });
  } catch (error) {
    report = buildReport({ kind: 'layer-check', layer: layerName, profile: profileName, gates: [], inputs, error: error?.message ?? String(error) });
  }
  const paths = writeReport(projectDir, `layer-${layerName}-check`, report);
  log(formatReport(report));
  log(`Отчёт: ${paths.textPath}`);
  return exitCodeFor(report);
}

module.exports = { FLAGS, run };
