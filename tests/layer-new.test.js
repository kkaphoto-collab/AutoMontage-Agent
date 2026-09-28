const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { buildLayerManifest } = require('../scripts/motion-kit-node');
const { hashFile } = require('../scripts/pult/files');
const { getProfile } = require('../scripts/qa/profiles');
const { runTimelineGates } = require('../scripts/qa/timeline-gates');
const newLayer = require('../scripts/layer/new');
const layerWords = require('../scripts/layer/words');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const TEMPLATE = path.join(__dirname, '..', 'templates', 'motion-layer');

test('layer new scaffolds a renderable layer that matches the source geometry', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = path.join(projectDir, 'no-library');
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  assert.equal(await newLayer.run({ 'project-dir': projectDir }), 0);
  const dir = path.join(projectDir, 'motion-v01');
  const layer = JSON.parse(fs.readFileSync(path.join(dir, 'layer.json'), 'utf8'));
  assert.deepEqual([layer.fps, layer.width, layer.height, layer.durationInFrames, layer.profile], [25, 540, 960, 150, 'avatar']);
  assert.deepEqual(layer.face, { x: 270, y: 394 });
  assert.equal(layer.speaker.lastFrame, 149);
  for (const file of ['src/index.jsx', 'src/Root.jsx', 'src/plan.js', 'src/scenes.jsx', 'src/words.js', 'src/sfx-library.js',
    'spelling.json', 'README.md', 'public/speaker.mp4', 'public/fonts/Onest.ttf', 'public/fonts/OFL-Onest.txt',
    'public/stock/placeholder.mp4', 'public/shots/placeholder.png', 'public/SOURCE.md']) {
    assert.ok(fs.existsSync(path.join(dir, file)), file);
  }
  assert.match(fs.readFileSync(path.join(dir, 'src/words.js'), 'utf8'), /"t":"Привет,"/);
  assert.equal(await newLayer.run({ 'project-dir': projectDir }), 0);
  assert.ok(fs.existsSync(path.join(projectDir, 'motion-v02')));
  await assert.rejects(newLayer.run({ 'project-dir': projectDir, dir: 'motion-v01' }), /уже существует/);
});

test('layer words re-applies spelling.json', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = path.join(projectDir, 'no-library');
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  await newLayer.run({ 'project-dir': projectDir });
  const dir = path.join(projectDir, 'motion-v01');
  fs.writeFileSync(path.join(dir, 'spelling.json'), JSON.stringify({ 'привет': 'Здравствуйте' }));
  assert.equal(await layerWords.run({ 'project-dir': projectDir, layer: 'motion-v01' }), 0);
  assert.match(fs.readFileSync(path.join(dir, 'src/words.js'), 'utf8'), /"t":"Здравствуйте,"/);
});

// --- Контракт слоя подробнее; вывод команды собирается через deps, а не в консоль теста ---

function quiet() {
  const out = { log: [], warn: [] };
  return { out, deps: { log: (line) => out.log.push(String(line)), warn: (line) => out.warn.push(String(line)) } };
}

function useSfxDir(t, dir) {
  process.env.AUTOMONTAGE_SFX_DIR = dir;
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
}

const motionDirs = (projectDir) => fs.readdirSync(projectDir).filter((name) => name.startsWith('motion-')).sort();

test('the scaffolded layer follows the contract: layer.json, template copies, speaker copy, template fonts, provenance', { skip: !hasFfmpeg }, async (t) => {
  const { root, projectDir, workspace, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const { deps, out } = quiet();
  assert.equal(await newLayer.run({ 'project-dir': projectDir, profile: 'live' }, deps), 0);
  const dir = path.join(projectDir, 'motion-v01');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'layer.json'), 'utf8')), {
    version: 1, composition: 'Layer', fps: 25, width: 540, height: 960, durationInFrames: 150,
    face: { x: 270, y: 394 }, profile: 'live', sfxMasterDb: -5, speaker: { src: 'speaker.mp4', lastFrame: 149 },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'spelling.json'), 'utf8')), {});
  // Стартовые файлы — побайтовые копии шаблона.
  for (const file of ['src/index.jsx', 'src/Root.jsx', 'src/plan.js', 'src/scenes.jsx', 'README.md']) {
    assert.ok(fs.readFileSync(path.join(dir, file)).equals(fs.readFileSync(path.join(TEMPLATE, file))), file);
  }
  // speaker.mp4 — копия исходника проекта.
  assert.equal(hashFile(path.join(dir, 'public', 'speaker.mp4')), hashFile(workspace.sourcePath));
  // Каждый шрифт, который выбирает scenes.jsx шаблона (FONTS), лежит в public/ слоя, с лицензией OFL.
  const fonts = [...fs.readFileSync(path.join(TEMPLATE, 'src', 'scenes.jsx'), 'utf8').matchAll(/file: '(fonts\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(fonts.length >= 1);
  for (const font of fonts) {
    assert.ok(fs.existsSync(path.join(dir, 'public', font)), font);
    assert.ok(fs.existsSync(path.join(dir, 'public', 'fonts', `OFL-${path.basename(font, '.ttf')}.txt`)), `лицензия ${font}`);
  }
  // Пустая библиотека: пустая public/sfx и пустой набор звуков, без предупреждений.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'public', 'sfx')), []);
  assert.match(fs.readFileSync(path.join(dir, 'src', 'sfx-library.js'), 'utf8'), /export default \{"sounds":\{\}\};/);
  assert.deepEqual(out.warn, []);
  assert.match(out.log.join('\n'), /слой motion-v01: 150 кадров 540×960@25/);
  // SOURCE.md: исходник назван путём внутри проекта, личного абсолютного пути в нём нет.
  const source = fs.readFileSync(path.join(dir, 'public', 'SOURCE.md'), 'utf8');
  assert.match(source, /\| `speaker\.mp4` \| исходник проекта \| `input\/source\.mp4` \|/);
  assert.match(source, /`stock\/placeholder\.mp4`, `shots\/placeholder\.png`/);
  assert.ok(!source.includes(root), 'в SOURCE.md нет абсолютного пути машины');
});

test('the fresh layer builds its manifest and fails no timeline gate on the fixture', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, quiet().deps), 0);
  const manifest = buildLayerManifest(path.join(projectDir, 'motion-v01'));
  assert.deepEqual([manifest.fps, manifest.width, manifest.height, manifest.durationInFrames], [25, 540, 960, 150]);
  assert.equal(manifest.camera.s.length, 150);
  const gates = runTimelineGates(manifest, getProfile('avatar'));
  assert.deepEqual(gates.filter((g) => g.status === 'fail').map((g) => `${g.id}: ${g.hint}`), []);
});

test('the sound library is copied into public/sfx with provenance, and skipped files and unknown meta each print one warning', { skip: !hasFfmpeg }, async (t) => {
  const { root, projectDir } = makeLayerProject(t);
  const library = path.join(root, 'sfx-library');
  fs.mkdirSync(library);
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.8*sin(2*PI*900*t)*exp(-8*t)':s=48000:d=0.15", path.join(library, 'pop.wav')]);
  fs.writeFileSync(path.join(library, 'UPPER.WAV'), 'x');
  fs.writeFileSync(path.join(library, 'library.json'), JSON.stringify({ license: 'Test license', sourceUrl: 'https://example.com/sfx',
    sounds: { pop: { role: 'pop' }, popp: { role: 'pop' } } }));
  useSfxDir(t, library);
  const { deps, out } = quiet();
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, deps), 0);
  const dir = path.join(projectDir, 'motion-v01');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'public', 'sfx')), ['pop.wav']);
  const sfxModule = fs.readFileSync(path.join(dir, 'src', 'sfx-library.js'), 'utf8');
  assert.match(sfxModule, /"pop":\{"file":"sfx\/pop\.wav"/);
  assert.match(sfxModule, /"sha256":"[a-f0-9]{64}"/);
  assert.match(fs.readFileSync(path.join(dir, 'public', 'SOURCE.md'), 'utf8'), /\| `sfx\/pop\.wav` \| Test license \| https:\/\/example\.com\/sfx \| [a-f0-9]{64} \|/);
  assert.equal(out.warn.length, 2, out.warn.join('\n'));
  assert.equal(out.warn.filter((line) => line.includes('UPPER.WAV')).length, 1);
  assert.equal(out.warn.filter((line) => line.includes('popp')).length, 1);
  assert.match(out.log.join('\n'), /звуков в библиотеке: 1/);
});

// --- Папка слоя занимается атомарно, отказ не оставляет половины слоя ---

// Одновременный второй `layer new`: подменённый fs.mkdirSync создаёт ту же папку слоя «чужим»
// процессом прямо перед нашим mkdir — ровно окно между выбором имени и захватом папки.
function raceOnClaim(t, projectDir, names) {
  const original = fs.mkdirSync;
  const pending = new Set(names.map((name) => path.join(projectDir, name)));
  t.mock.method(fs, 'mkdirSync', (target, ...rest) => {
    const key = path.resolve(String(target));
    if (!rest[0]?.recursive && pending.has(key)) {
      pending.delete(key);
      original.call(fs, key);
    }
    return original.call(fs, target, ...rest);
  });
  return () => pending.size;
}

test('a concurrent run that takes the auto name first makes layer new retry once with the next name', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const left = raceOnClaim(t, projectDir, ['motion-v01']);
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, quiet().deps), 0);
  assert.equal(left(), 0, 'гонка сработала');
  assert.deepEqual(motionDirs(projectDir), ['motion-v01', 'motion-v02']);
  // Чужая папка не тронута (пуста, как её создал «другой процесс»), слой собран в следующей.
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'motion-v01')), []);
  assert.ok(fs.existsSync(path.join(projectDir, 'motion-v02', 'layer.json')));
});

test('losing the claim twice, or losing an explicit --dir, is a clear error and leaves the other runs\' folders alone', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  raceOnClaim(t, projectDir, ['motion-v01', 'motion-v02', 'motion-v07']);
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, quiet().deps), /папка motion-v02 уже существует/);
  await assert.rejects(newLayer.run({ 'project-dir': projectDir, dir: 'motion-v07' }, quiet().deps), /папка motion-v07 уже существует/);
  assert.deepEqual(motionDirs(projectDir), ['motion-v01', 'motion-v02', 'motion-v07']);
  for (const name of motionDirs(projectDir)) assert.deepEqual(fs.readdirSync(path.join(projectDir, name)), [], name);
});

test('a failure after the claim removes only the half-built folder of this run', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, quiet().deps), 0);
  const before = fs.readdirSync(path.join(projectDir, 'motion-v01'), { recursive: true }).sort();
  // Битый library.json читается уже после захвата motion-v02 — посередине сборки слоя.
  fs.writeFileSync(path.join(sfxDir, 'library.json'), '{ not json');
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, quiet().deps), /library\.json: неверный JSON/);
  assert.deepEqual(motionDirs(projectDir), ['motion-v01']);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'motion-v01'), { recursive: true }).sort(), before);
  assert.equal(fs.readFileSync(path.join(sfxDir, 'library.json'), 'utf8'), '{ not json');
  assert.ok(fs.existsSync(path.join(projectDir, 'project.json')));
  assert.ok(fs.existsSync(path.join(projectDir, 'input', 'source.mp4')));
});

test('a folder swapped in place of the claimed one during the run is never deleted', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const layerDir = path.join(projectDir, 'motion-v01');
  const deps = { ...quiet().deps, runToolImpl: () => {
    fs.renameSync(layerDir, `${layerDir}-moved`);
    fs.mkdirSync(layerDir);
    fs.writeFileSync(path.join(layerDir, 'user.txt'), 'чужое');
    throw new Error('ffmpeg упал');
  } };
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, deps), /ffmpeg упал/);
  assert.equal(fs.readFileSync(path.join(layerDir, 'user.txt'), 'utf8'), 'чужое');
});

test('bad flags, a missing transcript or a mistyped sound folder are refused before any layer folder appears', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir, workspace } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  await assert.rejects(newLayer.run({ 'project-dir': projectDir, dir: 'layer-1' }, quiet().deps), /--dir должен быть вида motion-v01/);
  await assert.rejects(newLayer.run({ 'project-dir': projectDir, profile: 'studio' }, quiet().deps), /--profile: avatar или live/);
  process.env.AUTOMONTAGE_SFX_DIR = path.join(projectDir, 'no-such-library');
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, quiet().deps), /AUTOMONTAGE_SFX_DIR указывает на несуществующую папку/);
  process.env.AUTOMONTAGE_SFX_DIR = sfxDir;
  fs.rmSync(path.join(projectDir, workspace.manifest.transcript.words));
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, quiet().deps), /нет транскрипта transcript\/words\.json/);
  assert.deepEqual(motionDirs(projectDir), []);
});

test('layer words names a broken spelling.json and keeps the previous words.js', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  await newLayer.run({ 'project-dir': projectDir }, quiet().deps);
  const words = path.join(projectDir, 'motion-v01', 'src', 'words.js');
  const before = fs.readFileSync(words, 'utf8');
  const spelling = path.join(projectDir, 'motion-v01', 'spelling.json');
  for (const [text, message] of [['{ nope', /spelling\.json: неверный JSON/], ['null', /spelling\.json должен быть объектом/],
    ['["Claude"]', /spelling\.json должен быть объектом/], ['{"клод": 5}', /spelling\.json → «клод» должно быть строкой/]]) {
    fs.writeFileSync(spelling, text);
    await assert.rejects(layerWords.run({ 'project-dir': projectDir, layer: 'motion-v01' }, quiet().deps), message);
    assert.equal(fs.readFileSync(words, 'utf8'), before);
  }
});
