const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { toolAvailable } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { buildLayerManifest } = require('../scripts/motion-kit-node');
const newLayer = require('../scripts/layer/new');
const check = require('../scripts/layer/check');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const cli = path.resolve(__dirname, '../scripts/cli.js');
const STATIC_PLAN = "export default function buildPlan({ face }) { return { camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }] }, items: [] }; }\n";

// Вывод команды — в массив, а не в консоль теста.
function quiet() {
  const out = [];
  return { out, deps: { log: (line) => out.push(String(line)) } };
}

async function scaffold(t) {
  const project = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = project.sfxDir;
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  await newLayer.run({ 'project-dir': project.projectDir }, { log: () => {}, warn: () => {} });
  const layerDir = path.join(project.projectDir, 'motion-v01');
  const runCheck = (options = {}, deps = quiet().deps) => check.run({ 'project-dir': project.projectDir, layer: 'motion-v01', ...options }, deps);
  const report = () => JSON.parse(fs.readFileSync(path.join(project.projectDir, 'qa', 'layer-motion-v01-check.json'), 'utf8'));
  const reportText = () => fs.readFileSync(path.join(project.projectDir, 'qa', 'layer-motion-v01-check.txt'), 'utf8');
  const writePlan = (text) => fs.writeFileSync(path.join(layerDir, 'src', 'plan.js'), text);
  const editLayer = (edit) => {
    const file = path.join(layerDir, 'layer.json');
    const layer = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(layer);
    fs.writeFileSync(file, JSON.stringify(layer));
  };
  return { ...project, layerDir, runCheck, report, reportText, writePlan, editLayer };
}

test('the fresh template passes every stop gate and writes manifest and report', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir, runCheck, report, reportText } = await scaffold(t);
  const { out, deps } = quiet();
  assert.equal(await runCheck({}, deps), 0);
  const manifestFile = path.join(layerDir, 'out', 'manifest.json');
  assert.ok(fs.existsSync(manifestFile));
  // Манифест на диске — ровно то, что собрал kit из plan.js, записанный целиком (temp + rename).
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), JSON.parse(JSON.stringify(buildLayerManifest(layerDir))));
  assert.deepEqual(fs.readdirSync(path.join(layerDir, 'out')), ['manifest.json']);
  const json = report();
  assert.equal(json.kind, 'layer-check');
  assert.equal(json.layer, 'motion-v01');
  assert.equal(json.profile, 'avatar');
  assert.equal(json.error, null);
  assert.equal(json.summary.fail, 0);
  // Нейтральный шаблон проходит: в худшем случае предупреждения, стопов нет.
  assert.ok(['pass', 'warn'].includes(json.summary.status), json.summary.status);
  assert.deepEqual(json.gates.map((g) => g.id), ['G1', 'G2', 'G3', 'G4', 'G5', 'G9', 'G10', 'G11']);
  assert.deepEqual(json.unusedWaivers, []);
  assert.match(reportText(), /^Проверки \(план слоя\): /);
  assert.ok(out.some((line) => line.includes(path.join(projectDir, 'qa', 'layer-motion-v01-check.txt'))), out.join('\n'));
});

test('BAD CASE: one static shot for the whole layer exits 1, a broken plan exits 2', { skip: !hasFfmpeg }, async (t) => {
  const { runCheck, report, writePlan } = await scaffold(t);
  writePlan(STATIC_PLAN);
  assert.equal(await runCheck(), 1);
  assert.equal(report().summary.status, 'fail');
  assert.equal(report().gates.find((g) => g.id === 'G1').status, 'fail');
  writePlan('export default function buildPlan( {\n');
  assert.equal(await runCheck(), 2);
  const json = report();
  assert.equal(json.summary.status, 'error');
  assert.deepEqual(json.gates, []);
  assert.match(json.error, /не собирается plan\.js/);
});

test('BAD CASE: a bad sfxMasterDb in layer.json exits 2 and names the field', { skip: !hasFfmpeg }, async (t) => {
  const { runCheck, report, editLayer } = await scaffold(t);
  editLayer((layer) => { layer.sfxMasterDb = 3; });
  assert.equal(await runCheck(), 2);
  assert.match(report().error, /layer\.json/);
  assert.match(report().error, /sfxMasterDb/);
  assert.equal(report().profile, 'avatar');
});

test('BAD CASE: a plan.js that imports node:fs is refused at the boundary with exit 2', { skip: !hasFfmpeg }, async (t) => {
  const { runCheck, report, writePlan } = await scaffold(t);
  writePlan(`import fs from 'node:fs';\n${STATIC_PLAN.replace('return {', 'fs.existsSync("x"); return {')}`);
  assert.equal(await runCheck(), 2);
  assert.match(report().error, /src\/plan\.js импортирует «node:fs»/);
});

test('BAD CASE: the project source changed after layer new — exit 2, the layer is not judged', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, workspace, runCheck, report } = await scaffold(t);
  fs.appendFileSync(workspace.sourcePath, Buffer.from([0]));
  assert.equal(await runCheck(), 2);
  assert.match(report().error, /исходник проекта сменился после создания слоя motion-v01.*automontage layer new/s);
  assert.deepEqual(report().gates, []);
  assert.ok(!fs.existsSync(path.join(layerDir, 'out', 'manifest.json')), 'манифест для чужого исходника не пишется');
});

test('a folder left without layer.json by a killed layer new gives an error report with exit 2', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, runCheck, report } = await scaffold(t);
  fs.rmSync(path.join(layerDir, 'layer.json'));
  assert.equal(await runCheck(), 2);
  assert.match(report().error, /^motion-v01 собран не до конца \(нет layer\.json\)/);
});

test('a corrupted manifest and a thrown non-Error both become an error report with exit 2', { skip: !hasFfmpeg }, async (t) => {
  const { runCheck, report } = await scaffold(t);
  const truncated = (dir) => {
    const manifest = buildLayerManifest(dir);
    manifest.camera.s = manifest.camera.s.slice(0, 10);
    return manifest;
  };
  assert.equal(await runCheck({}, { ...quiet().deps, buildLayerManifest: truncated }), 2);
  assert.match(report().error, /манифест повреждён/);
  assert.equal(report().summary.status, 'error');
  assert.equal(await runCheck({}, { ...quiet().deps, buildLayerManifest: () => { throw 'строка вместо Error'; } }), 2);
  assert.equal(report().error, 'строка вместо Error');
  assert.equal(await runCheck({}, { ...quiet().deps, buildLayerManifest: () => { throw undefined; } }), 2);
  assert.equal(report().error, 'undefined');
});

test('the profile comes from --profile, then layer.json, then avatar; an unknown one is an error report', { skip: !hasFfmpeg }, async (t) => {
  const { runCheck, report, editLayer } = await scaffold(t);
  assert.equal(await runCheck(), 0);
  assert.equal(report().profile, 'avatar');
  editLayer((layer) => { layer.profile = 'live'; });
  assert.equal(await runCheck(), 0);
  assert.equal(report().profile, 'live');
  assert.equal(await runCheck({ profile: 'avatar' }), 0);
  assert.equal(report().profile, 'avatar');
  editLayer((layer) => { delete layer.profile; });
  assert.equal(await runCheck(), 0);
  assert.equal(report().profile, 'avatar');
  assert.equal(await runCheck({ profile: 'studio' }), 2);
  assert.match(report().error, /неизвестный профиль проверок «studio»/);
});

test('a G1 waiver on a layer where G1 passes exits 0 and is reported as not needed', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, runCheck, report, reportText } = await scaffold(t);
  const plan = path.join(layerDir, 'src', 'plan.js');
  const text = fs.readFileSync(plan, 'utf8');
  assert.ok(text.includes('    captions: {'));
  fs.writeFileSync(plan, text.replace('    captions: {', "    waivers: [{ gate: 'G1', reason: 'длинный план экрана' }],\n    captions: {"));
  assert.equal(await runCheck(), 0);
  const json = report();
  assert.equal(json.gates.find((g) => g.id === 'G1').status, 'pass');
  assert.deepEqual(json.unusedWaivers, [{ gate: 'G1', reason: 'длинный план экрана' }]);
  assert.match(reportText(), /^☑️ исключение G1 не понадобилось: длинный план экрана — уберите его из plan\.js$/m);
});

test('a G1 waiver that softens a real G1 stop is used, not reported as unneeded', { skip: !hasFfmpeg }, async (t) => {
  const { runCheck, report, reportText, writePlan } = await scaffold(t);
  writePlan(STATIC_PLAN.replace("items: [] }", "items: [], waivers: [{ gate: 'G1', reason: 'демонстрация экрана без склеек' }] }"));
  assert.equal(await runCheck(), 0);
  assert.equal(report().gates.find((g) => g.id === 'G1').status, 'waived');
  assert.deepEqual(report().unusedWaivers, []);
  assert.doesNotMatch(reportText(), /не понадобилось/);
});

test('the real CLI shows the src/plan.js line of an exception thrown by buildPlan and exits 2', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, report, writePlan } = await scaffold(t);
  writePlan("export default function buildPlan() {\n  throw new Error('план сломан на второй строке');\n}\n");
  const result = spawnSync(process.execPath, [cli, 'layer', 'check', '--project-dir', projectDir, '--layer', 'motion-v01'], { encoding: 'utf8' });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /\(src\/plan\.js:2:/);
  assert.match(report().error, /план сломан на второй строке/);
});
