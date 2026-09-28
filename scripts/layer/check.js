// automontage layer check — гейты по плану слоя за секунды, без рендера: plan.js → манифест kit →
// G1–G5, G9–G11. Пишет <слой>/out/manifest.json (по нему layer render судит звук) и qa-отчёт.
// Код: 0 — пройдено или только предупреждения, 1 — стоп, 2 — оценить нельзя.
const path = require('node:path');
const { buildLayerManifest } = require('../motion-kit-node');
const { getProfile } = require('../qa/profiles');
const { buildReport, exitCodeFor, formatReport, writeReport } = require('../qa/report');
const { runTimelineGates } = require('../qa/timeline-gates');
const { assertLayerSource, readLayerJson, resolveLayer, writeJson } = require('./common');

const FLAGS = { 'project-dir': 'value', layer: 'value', profile: 'value' };

// deps.buildLayerManifest — подмена сборки в тестах (испорченный манифест, брошенный не-Error).
async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const buildManifest = deps.buildLayerManifest || buildLayerManifest;
  const target = resolveLayer(options);
  const { projectDir, layerDir, layerName } = target;
  let profileName = options.profile || 'avatar';
  let report;
  // Всё, что может отказать после выбора слоя, — внутри try: испорченный layer.json, другой исходник
  // проекта, сборка и граница plan.js, «манифест повреждён» из гейтов. Такой отказ — отчёт с error
  // (код 2), а не «layer check отменён» без отчёта; брошено может быть и не Error.
  try {
    const layer = readLayerJson(layerDir);
    profileName = options.profile || layer.profile || 'avatar';
    const profile = getProfile(profileName);
    assertLayerSource(target, layer);
    const manifest = buildManifest(layerDir);
    writeJson(path.join(layerDir, 'out', 'manifest.json'), manifest);
    const gates = runTimelineGates(manifest, profile);
    // Исключение, которое ничего не сняло (гейт прошёл или дал только warn), показываем автору.
    const waivers = Array.isArray(manifest.waivers) ? manifest.waivers : [];
    const unusedWaivers = waivers.filter((w) => !gates.some((g) => g.id === w.gate && g.status === 'waived'));
    report = buildReport({ kind: 'layer-check', layer: layerName, profile: profileName, gates, unusedWaivers });
  } catch (error) {
    report = buildReport({ kind: 'layer-check', layer: layerName, profile: profileName, gates: [], error: error?.message ?? String(error) });
  }
  const paths = writeReport(projectDir, `layer-${layerName}-check`, report);
  log(formatReport(report));
  log(`Отчёт: ${paths.textPath}`);
  return exitCodeFor(report);
}

module.exports = { FLAGS, run };
