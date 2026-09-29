const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { runTool, toolAvailable } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { buildLayerManifest } = require('../scripts/motion-kit-node');
const { hashFile } = require('../scripts/pult/files');
const newLayer = require('../scripts/layer/new');
const check = require('../scripts/layer/check');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const cli = path.resolve(__dirname, '../scripts/cli.js');
const STATIC_PLAN = "export default function buildPlan({ face }) { return { camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }] }, items: [] }; }\n";

// Вывод команды – в массив, а не в консоль теста.
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
  // Манифест на диске – ровно то, что собрал kit из plan.js, записанный целиком (temp + rename).
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
  // Отчёт привязан к своему манифесту: путь от папки проекта и sha256 записанного файла.
  assert.deepEqual(json.inputs, [{ path: 'motion-v01/out/manifest.json', sha256: hashFile(manifestFile) }]);
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
  assert.deepEqual(json.inputs, []);
});

test('a failed check does not leave the manifest of the previous green check behind', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, runCheck, report, writePlan } = await scaffold(t);
  const manifestFile = path.join(layerDir, 'out', 'manifest.json');
  assert.equal(await runCheck(), 0);
  assert.ok(fs.existsSync(manifestFile));
  writePlan('export default function buildPlan( {\n');
  assert.equal(await runCheck(), 2);
  assert.ok(!fs.existsSync(manifestFile), 'старый манифест не должен выглядеть результатом этой проверки');
  assert.deepEqual(report().inputs, []);
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

test('BAD CASE: the project source changed after layer new – exit 2, the layer is not judged', { skip: !hasFfmpeg }, async (t) => {
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
  // Испорченный манифест уже записан – отчёт называет, какой именно файл не прошёл проверку формы.
  assert.deepEqual(report().inputs.map((input) => input.path), ['motion-v01/out/manifest.json']);
  assert.equal(await runCheck({}, { ...quiet().deps, buildLayerManifest: () => { throw 'строка вместо Error'; } }), 2);
  assert.equal(report().error, 'строка вместо Error');
  assert.deepEqual(report().inputs, []);
  assert.equal(await runCheck({}, { ...quiet().deps, buildLayerManifest: () => { throw undefined; } }), 2);
  assert.equal(report().error, 'undefined');
});

test('a real plan.js that throws undefined or a string gives a readable error report, exit 2', { skip: !hasFfmpeg }, async (t) => {
  const { runCheck, report, writePlan } = await scaffold(t);
  writePlan('export default function buildPlan() {\n  throw undefined;\n}\n');
  assert.equal(await runCheck(), 2);
  assert.match(report().error, /^слой motion-v01: src\/plan\.js упал при построении плана – undefined/);
  writePlan("export default function buildPlan() {\n  throw 'строка';\n}\n");
  assert.equal(await runCheck(), 2);
  assert.match(report().error, /^слой motion-v01: src\/plan\.js упал при построении плана – строка/);
  // Геттер в объекте плана бросает уже при компиляции – мимо обёртки compilePlan вокруг buildPlan,
  // поэтому текст другой: не «упал при построении», а «бросил … при компиляции».
  writePlan("export default function buildPlan() {\n  return { get camera() { throw null; }, items: [] };\n}\n");
  assert.equal(await runCheck(), 2);
  assert.equal(report().error, 'слой motion-v01: src/plan.js бросил null при компиляции плана');
  // Брошенный не-Error объект со своим строковым message (не instanceof Error) – используем этот
  // текст напрямую, а не невнятное «бросил [object Object] при компиляции плана».
  writePlan("export default function buildPlan() {\n  return { get camera() { throw { message: 'кастомная причина' }; }, items: [] };\n}\n");
  assert.equal(await runCheck(), 2);
  assert.equal(report().error, 'слой motion-v01: кастомная причина');
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
  assert.match(reportText(), /^ℹ️ исключение G1 не понадобилось: длинный план экрана – уберите его из plan\.js$/m);
  assert.doesNotMatch(reportText(), /даёт только предупреждение/);
});

test('a G1 waiver that softens a real G1 stop is used, not reported as unneeded', { skip: !hasFfmpeg }, async (t) => {
  const { runCheck, report, reportText, writePlan } = await scaffold(t);
  writePlan(STATIC_PLAN.replace("items: [] }", "items: [], waivers: [{ gate: 'G1', reason: 'демонстрация экрана без склеек' }] }"));
  assert.equal(await runCheck(), 0);
  assert.equal(report().gates.find((g) => g.id === 'G1').status, 'waived');
  assert.deepEqual(report().unusedWaivers, []);
  assert.doesNotMatch(reportText(), /не понадобилось/);
});

test('two waivers, one used: G1 softens a real stop, the G4 waiver is the only unused one', { skip: !hasFfmpeg }, async (t) => {
  const { runCheck, report, reportText, writePlan } = await scaffold(t);
  writePlan(STATIC_PLAN.replace('items: [] }', "items: [], waivers: [{ gate: 'G1', reason: 'демонстрация экрана' }, { gate: 'G4', reason: 'уход в хуке' }] }"));
  assert.equal(await runCheck(), 0);
  const json = report();
  assert.equal(json.gates.find((g) => g.id === 'G1').status, 'waived');
  assert.equal(json.gates.find((g) => g.id === 'G4').status, 'pass');
  assert.deepEqual(json.unusedWaivers, [{ gate: 'G4', reason: 'уход в хуке' }]);
  assert.match(reportText(), /^ℹ️ исключение G4 не понадобилось: уход в хуке – уберите его из plan\.js$/m);
  assert.doesNotMatch(reportText(), /исключение G1 не понадобилось/);
});

test('a G1 waiver on a layer where G1 only warns is unused: a waiver lifts a stop, not a warning', { skip: !hasFfmpeg }, async (t) => {
  const { runCheck, report, reportText, writePlan } = await scaffold(t);
  // План каждые 2,4 с: больше 2,2 (предупреждение), но не больше 2,5 (стоп).
  writePlan("export default function buildPlan({ face }) { const shots = []; for (let at = 0; at < 6; at += 2.4) shots.push({ at: Number(at.toFixed(2)), preset: shots.length % 2 ? 'M' : 'W', drift: 'none' }); return { camera: { face, shots }, items: [], waivers: [{ gate: 'G1', reason: 'длинные планы' }] }; }\n");
  assert.equal(await runCheck(), 0);
  const json = report();
  assert.equal(json.gates.find((g) => g.id === 'G1').status, 'warn');
  assert.deepEqual(json.unusedWaivers, [{ gate: 'G1', reason: 'длинные планы' }]);
  assert.match(reportText(), /^ℹ️ исключение G1 не понадобилось: длинные планы – уберите его из plan\.js\n {3}→ G1 даёт только предупреждение – исключение снимает лишь стоп$/m);
});

// Короткий сток замирает на последнем кадре до конца вставки: layer check меряет клип ffprobe и предупреждает.
const g10 = (json) => json.gates.find((g) => g.id === 'G10');
const shortClip = (file, seconds) => runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=540x960:r=25:d=${seconds}`,
  '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);

test('a stock clip of 1 s on a 2 s insert warns in G10 with a hint to re-fetch it, exit 0', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, runCheck, report, reportText } = await scaffold(t);
  assert.equal(await runCheck(), 0);
  assert.ok(!g10(report()).spans.some((s) => /сток/.test(s.note)), 'заглушка шаблона 4 с не короче вставки 2 с');
  const placeholder = path.join(layerDir, 'public', 'stock', 'placeholder.mp4');
  fs.rmSync(placeholder);
  shortClip(placeholder, 1);
  assert.equal(await runCheck(), 0);
  const gate = g10(report());
  assert.equal(gate.status, 'warn');
  const span = gate.spans.find((s) => /сток/.test(s.note));
  assert.ok(span, JSON.stringify(gate));
  assert.equal(span.note, 'сток stock/placeholder.mp4 короче вставки stock-1 на 1 с – последний кадр замрёт');
  assert.ok(Math.abs(span.fromSec - 3.6) < 0.05 && Math.abs(span.toSec - 5.6) < 0.05, JSON.stringify(span));
  assert.match(gate.hint, /automontage layer stock --insert stock-1/);
  assert.match(reportText(), /сток stock\/placeholder\.mp4 короче вставки stock-1/);
});

test('a missing stock file warns in G10 instead of failing the check', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, runCheck, report } = await scaffold(t);
  fs.rmSync(path.join(layerDir, 'public', 'stock', 'placeholder.mp4'));
  assert.equal(await runCheck(), 0);
  const gate = g10(report());
  assert.equal(gate.status, 'warn');
  assert.ok(gate.spans.some((s) => s.note === 'нет public/stock/placeholder.mp4 – вставка stock-1 останется пустой'), JSON.stringify(gate));
});

test('G10 forgives one frame: a 49-frame clip on a 50-frame insert is fine, 48 frames warn', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, runCheck, report } = await scaffold(t);
  const placeholder = path.join(layerDir, 'public', 'stock', 'placeholder.mp4');
  const frames = (n) => {
    fs.rmSync(placeholder);
    runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=25:d=4',
      '-frames:v', String(n), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', placeholder]);
  };
  // Вставка шаблона stock-1: 3,6–5,6 с при 25 fps = 50 кадров.
  frames(49);
  assert.equal(await runCheck(), 0);
  assert.ok(!g10(report()).spans.some((s) => /сток/.test(s.note)), JSON.stringify(g10(report())));
  frames(48);
  assert.equal(await runCheck(), 0);
  assert.deepEqual(g10(report()).spans.map((s) => s.note), ['сток stock/placeholder.mp4 короче вставки stock-1 на 0,1 с – последний кадр замрёт']);
});

test('a stock file that is not a video warns in G10 instead of breaking the check', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, runCheck, report } = await scaffold(t);
  fs.writeFileSync(path.join(layerDir, 'public', 'stock', 'placeholder.mp4'), 'не видео');
  assert.equal(await runCheck(), 0);
  assert.deepEqual(g10(report()).spans.map((s) => s.note), ['public/stock/placeholder.mp4 не читается как видео – вставка stock-1 останется пустой']);
});

test('a short stock turns a passing G10 into a warning; a src outside public/ is not probed', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, runCheck, report, writePlan } = await scaffold(t);
  const plan = (src) => STATIC_PLAN.replace("items: [] }", `items: [], waivers: [{ gate: 'G1', reason: 'статичный план теста' }], inserts: [
    { id: 's1', kind: 'stock', from: 3, to: 4, src: 'stock/placeholder.mp4' }, { id: 's2', kind: 'stock', from: 4.5, to: 5.5, src: ${JSON.stringify(src)} }] }`);
  writePlan(plan('stock/placeholder.mp4'));
  assert.equal(await runCheck(), 0);
  assert.equal(g10(report()).status, 'pass');
  shortClip(path.join(layerDir, 'public', 'stock', 'half.mp4'), 0.5);
  writePlan(plan('stock/half.mp4'));
  assert.equal(await runCheck(), 0);
  assert.equal(g10(report()).status, 'warn');
  assert.deepEqual(g10(report()).spans.map((s) => s.note), ['сток stock/half.mp4 короче вставки s2 на 0,5 с – последний кадр замрёт']);
  writePlan(plan('../layer.json'));
  assert.equal(await runCheck(), 0);
  assert.deepEqual(g10(report()).spans.map((s) => s.note), ['src ../layer.json вставки s2 – вне public/ слоя']);
});

test('the real CLI shows the src/plan.js line of an exception thrown by buildPlan and exits 2', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, report, writePlan } = await scaffold(t);
  writePlan("export default function buildPlan() {\n  throw new Error('план сломан на второй строке');\n}\n");
  const result = spawnSync(process.execPath, [cli, 'layer', 'check', '--project-dir', projectDir, '--layer', 'motion-v01'], { encoding: 'utf8' });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /\(src\/plan\.js:2:/);
  assert.match(report().error, /план сломан на второй строке/);
});

// --- Публичный automontage передаёт сигнал дочернему scripts/layer/cli.js ---

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

// Тот же приём, что в review-cli.test.js: ребёнок внешнего процесса по ps.
function childProcessPid(parentPid, commandPattern) {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match && Number(match[2]) === parentPid && commandPattern.test(match[3])) return Number(match[1]);
  }
  return null;
}

async function waitFor(predicate, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  assert.fail(message);
}

// SIGINT/SIGTERM/SIGHUP – те же коды, что scripts/cli.js даёт публичной команде layer (Step 0 задачи
// 33); закрытие терминала (SIGHUP) не должно оставлять ребёнка scripts/layer/cli.js висеть так же,
// как явный Ctrl+C или kill. Цикл – по образцу tests/review-cli.test.js.
const LAYER_SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

test('signals to the public automontage CLI stop its layer child too and exit with the right code', {
  skip: !hasFfmpeg ? 'нет ffmpeg' : process.platform === 'win32' ? 'POSIX signal lifecycle' : false,
  timeout: 45_000,
}, async (t) => {
  for (const signal of Object.keys(LAYER_SIGNAL_EXIT_CODES)) {
    await t.test(signal, async (signalTest) => {
      const { projectDir, writePlan } = await scaffold(signalTest);
      // План, который никогда не заканчивается: без передачи сигнала ребёнок жил бы после смерти внешнего процесса.
      writePlan('export default function buildPlan() {\n  for (;;) { /* долгая команда */ }\n}\n');
      const outer = spawn(process.execPath, [cli, 'layer', 'check', '--project-dir', projectDir, '--layer', 'motion-v01'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      outer.stdout.on('data', (chunk) => { output += chunk; });
      outer.stderr.on('data', (chunk) => { output += chunk; });
      let childPid = null;
      signalTest.after(() => {
        for (const pid of [outer.pid, childPid]) if (pid && processIsAlive(pid)) process.kill(pid, 'SIGKILL');
      });
      await waitFor(() => Number.isInteger(childPid = childProcessPid(outer.pid, /scripts\/layer\/cli\.js/)), 'внешний CLI не запустил scripts/layer/cli.js');
      // exit, а не close: утёкший ребёнок держит унаследованные pipe открытыми, и close не пришёл бы вовсе.
      const exited = new Promise((resolve) => { outer.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal })); });
      outer.kill(signal);
      const result = await exited;
      assert.deepEqual(result, { code: LAYER_SIGNAL_EXIT_CODES[signal], signal: null }, output);
      await waitFor(() => !processIsAlive(childPid), 'scripts/layer/cli.js пережил внешний automontage', 5_000);
    });
  }
});
