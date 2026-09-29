const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJson } = require('../scripts/layer/common');
const { buildReport, gate } = require('../scripts/qa/report');
const { readProjectWords, runPreviewGates } = require('../scripts/qa/preview-gates');
const { getProfile } = require('../scripts/qa/profiles');

const SOURCE = 's'.repeat(64);
const sha = (letter) => letter.repeat(64);

// Слой kit: запись реестра, как её пишет layer import, и отчёт layer render настоящей формы (buildReport/gate).
function addLayer(dir, { layer = 'motion-v01', render = sha('r'), canonical = sha('c'), gates, sourceSha = SOURCE, edit = (r) => r, report = true, profile = 'avatar' } = {}) {
  const renderFile = `${layer}/renders/layer-01.mp4`;
  const entry = {
    layer, render: 1, renderFile, renderReport: `qa/layer-${layer}-render-01.json`, renderSha256: render, profile,
    assetId: `id-${layer}`, reference: `assets/broll/video/id-${layer}/media.mp4`, canonicalSha256: canonical, createdAt: '2026-09-29T10:00:00.000Z',
  };
  const file = path.join(dir, 'qa', 'layer-imports.json');
  const registry = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, imports: [] };
  registry.imports.push(entry);
  writeJson(file, registry);
  if (report) {
    const built = buildReport({
      kind: 'layer-render', layer, profile: 'avatar',
      gates: gates || [gate('G6', 'Длина слоя'), gate('G7', 'Голос в звуке слоя')],
      inputs: [{ role: 'layer', path: renderFile, sha256: render }, { role: 'source', path: 'source/speaker.mp4', sha256: sourceSha }],
    });
    writeJson(path.join(dir, 'qa', `layer-${layer}-render-01.json`), edit(built));
  }
  return entry;
}

function project(t, { registered = false, ...layer } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-gates-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (registered) addLayer(dir, layer);
  return dir;
}

const videoScene = (canonical = sha('c'), id = 'id-motion-v01') => ({
  scene: 'broll', start: 0, end: 10, brollMedia: { kind: 'video', src: `assets/broll/video/${id}/media.mp4`, sha256: canonical, trimStartSec: 0, fit: 'cover', audioMode: 'mix' },
});
const brief = { scenes: [videoScene()], music: { gainDb: -16 } };
const words = [{ s: 1, e: 3 }, { s: 4, e: 6 }];
const range = { fromSec: 0, toSec: 10 };
const loud = () => ({ gapLu: 0.5, voiceLufs: -14, musicLufs: -14.5, blocks: 100 });
// Разрыв ровно в цели коридора avatar: тесты барьера не зависят от откалиброванного числа.
const AVATAR_TARGET = getProfile('avatar').voiceMusic.target;
const good = () => ({ gapLu: AVATAR_TARGET, voiceLufs: -14, musicLufs: -14 - AVATAR_TARGET, blocks: 100 });
const base = (projectDir, extra = {}) => ({ projectDir, brief, hasMusic: true, words, range, sourceSha256: SOURCE,
  finishedPath: 'finished.mp4', musicPath: 'music.mp3', mixArgs: ['--gain', '-16'], ...extra });
const statuses = (result) => result.report.gates.map((g) => [g.id, g.status]);
const NO_ADVICE = /music\.gainDb|увеличьте|уменьшите/u;

test('a kit layer with music at the voice level blocks the preview', (t) => {
  let seen = null;
  const result = runPreviewGates(base(project(t, { registered: true })), { measureImpl: (input) => { seen = input; return loud(); } });
  assert.equal(result.block, true);
  assert.deepEqual(statuses(result), [['L', 'pass'], ['G8', 'fail']]);
  assert.equal(result.report.kind, 'preview');
  assert.equal(result.report.profile, 'avatar');
  assert.equal(result.report.layer, 'motion-v01');
  assert.equal(result.report.gates[0].title, 'Слой прошёл layer render и импорт');
  // Замер получает настоящие входы preview: окна речи от начала диапазона и разобранные параметры музыки.
  assert.deepEqual(seen.windows, [{ s: 1, e: 3 }, { s: 4, e: 6 }]);
  assert.equal(seen.voicePath, 'finished.mp4');
  assert.equal(seen.musicPath, 'music.mp3');
  assert.equal(seen.durationSec, 10);
  assert.equal(seen.mixOptions.gain, -16);
  assert.ok(fs.existsSync(result.paths.jsonPath) && fs.existsSync(result.paths.textPath));
});

test('a kit layer with balanced music passes and is not blocked', (t) => {
  const result = runPreviewGates(base(project(t, { registered: true })), { measureImpl: good });
  assert.equal(result.block, false);
  assert.deepEqual(statuses(result), [['L', 'pass'], ['G8', 'pass']]);
});

test('a kit layer whose render failed blocks even with good music', (t) => {
  const dir = project(t, { registered: true, gates: [gate('G6', 'Длина слоя'), gate('G7', 'Голос в звуке слоя', { status: 'fail' })] });
  const result = runPreviewGates(base(dir), { measureImpl: good });
  assert.equal(result.block, true);
  assert.deepEqual(statuses(result), [['L', 'fail'], ['G8', 'pass']]);
  assert.match(result.report.gates[0].hint, /слой не прошёл проверки/u);
});

test('a hand-edited render report summary does not pass gate L', (t) => {
  const dir = project(t, { registered: true, gates: [gate('G6', 'Длина слоя'), gate('G7', 'Голос в звуке слоя', { status: 'fail' })],
    edit: (r) => ({ ...r, summary: { status: 'pass', fail: 0, warn: 0 } }) });
  const result = runPreviewGates(base(dir), { measureImpl: good });
  assert.equal(result.block, true);
  assert.equal(result.report.gates[0].status, 'fail');
  assert.match(result.report.gates[0].hint, /правили вручную/u);
});

test('a render report without G6 and G7 or with a missing report does not pass gate L', (t) => {
  const partial = runPreviewGates(base(project(t, { registered: true, gates: [gate('G6', 'Длина слоя')] })), { measureImpl: good });
  assert.equal(partial.block, true);
  assert.match(partial.report.gates[0].hint, /нет G7/u);
  const missing = runPreviewGates(base(project(t, { registered: true, report: false })), { measureImpl: good });
  assert.equal(missing.block, true);
  assert.match(missing.report.gates[0].hint, /нет отчёта layer render/u);
});

test('a layer rendered for another source does not pass gate L', (t) => {
  const dir = project(t, { registered: true, sourceSha: sha('9') });
  const result = runPreviewGates(base(dir), { measureImpl: good });
  assert.equal(result.block, true);
  assert.match(result.report.gates[0].hint, /другого исходника/u);
  // Барьер preview не кладёт абсолютный путь проекта в отчёт: подсказка называет команду без --project-dir.
  assert.match(result.report.gates[0].hint, /создайте новый слой: automontage layer new → layer render → layer import/u);
  assert.doesNotMatch(result.report.gates[0].hint, /--project-dir/u);
  assert.doesNotMatch(result.report.gates[0].hint, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
});

test('a broken registry blocks: the project has kit layers but the barrier cannot trust them', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, 'qa'));
  fs.writeFileSync(path.join(dir, 'qa', 'layer-imports.json'), '{broken');
  const result = runPreviewGates(base(dir), { measureImpl: good });
  assert.equal(result.block, true);
  assert.equal(result.report.gates[0].id, 'L');
  assert.match(result.report.gates[0].hint, /^реестр слоёв повреждён: qa\/layer-imports\.json \(неверный JSON\) – почините или удалите его/u);
  assert.doesNotMatch(result.report.gates[0].hint, /layer render/u);
});

test('qa/ as a link blocks a brief with video and says so', (t) => {
  const dir = project(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-gates-qa-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.symlinkSync(elsewhere, path.join(dir, 'qa'), 'dir');
  const result = runPreviewGates(base(dir), { measureImpl: good, write: false });
  assert.equal(result.block, true);
  assert.match(result.report.gates[0].hint, /^qa\/ – ссылка или файл, а не папка проекта/u);
  assert.doesNotMatch(result.report.gates[0].hint, /layer render/u);
});

test('other projects get G8 for reference only: no stop, no warning, no gain advice', (t) => {
  for (const measureImpl of [loud, () => ({ gapLu: 38.2, voiceLufs: -14, musicLufs: -52.2, blocks: 100 })]) {
    const result = runPreviewGates(base(project(t)), { measureImpl });
    assert.equal(result.block, false);
    assert.deepEqual(statuses(result), [['G8', 'skipped']]);
    assert.equal(result.report.summary.status, 'pass');
    assert.equal(result.report.profile, 'live');
    assert.equal(result.report.layer, null);
    assert.equal(result.report.gates[0].threshold, null);
    assert.match(result.report.gates[0].hint, /^для справки: разница голос\/музыка [\d,]+ LU; без слоя kit G8 не оценивает баланс – музыку ведёт утверждённый рецепт$/u);
    assert.doesNotMatch(result.report.gates[0].hint, NO_ADVICE);
  }
});

test('other previews longer than 180 s are not measured; kit layers still are', (t) => {
  const longWords = [{ s: 1, e: 3 }];
  // Граница справочного замера: 179 с меряется, 181 с – нет, и замер даже не вызывается.
  let calls = 0;
  const short = runPreviewGates(base(project(t), { range: { fromSec: 0, toSec: 179 }, words: longWords }),
    { measureImpl: () => { calls += 1; return good(); }, write: false });
  assert.equal(calls, 1);
  assert.match(short.report.gates[0].hint, /^для справки: разница голос\/музыка/u);
  const long = { fromSec: 0, toSec: 181 };
  const result = runPreviewGates(base(project(t), { range: long, words: longWords }),
    { measureImpl: () => { throw new Error('не должен мерить'); }, write: false });
  assert.deepEqual(statuses(result), [['G8', 'skipped']]);
  assert.equal(result.block, false);
  assert.match(result.report.gates[0].hint, /^для справки: preview длиннее 3 мин – баланс голоса и музыки не замерялся/u);
  let measured = false;
  const kit = runPreviewGates(base(project(t, { registered: true }), { range: { fromSec: 0, toSec: 601 }, words: longWords }),
    { measureImpl: () => { measured = true; return loud(); } });
  assert.equal(measured, true);
  assert.equal(kit.block, true);
});

test('every video scene is checked: one bad layer of two blocks and is named', (t) => {
  const dir = project(t);
  addLayer(dir, { layer: 'motion-v01', render: sha('1'), canonical: sha('a') });
  addLayer(dir, { layer: 'motion-v02', render: sha('2'), canonical: sha('b'), report: false });
  const twoLayers = { scenes: [videoScene(sha('a'), 'id-motion-v01'), { scene: 'fullscreen', start: 10, end: 12 }, videoScene(sha('b'), 'id-motion-v02')], music: { gainDb: -16 } };
  let calls = 0;
  const result = runPreviewGates(base(dir, { brief: twoLayers }), { measureImpl: () => { calls += 1; return good(); } });
  assert.equal(result.block, true);
  assert.deepEqual(statuses(result), [['L', 'fail'], ['G8', 'pass']]);
  assert.match(result.report.gates[0].hint, /motion-v02/u);
  assert.doesNotMatch(result.report.gates[0].hint, /motion-v01/u);
  assert.equal(result.report.layer, 'motion-v01, motion-v02');
  assert.equal(calls, 1);

  addLayer(dir, { layer: 'motion-v02', render: sha('2'), canonical: sha('b') });
  const fixed = runPreviewGates(base(dir, { brief: twoLayers }), { measureImpl: good });
  assert.equal(fixed.block, false);
  assert.deepEqual(statuses(fixed), [['L', 'pass'], ['G8', 'pass']]);
});

test('an unregistered video that looks like a kit layer render only warns to run layer import', (t) => {
  const dir = project(t);
  writeJson(path.join(dir, 'assets', 'broll', 'video', 'id-review', 'asset.json'), { label: 'layer-03.mp4' });
  const viaReview = { scenes: [videoScene(sha('d'), 'id-review')], music: { gainDb: -16 } };
  const result = runPreviewGates(base(dir, { brief: viaReview }), { measureImpl: loud });
  assert.equal(result.block, false);
  assert.deepEqual(statuses(result), [['L', 'warn'], ['G8', 'skipped']]);
  assert.match(result.report.gates[0].hint, /layer import/u);

  // Рядом с проверенным слоем такая сцена тоже только предупреждение и не блокирует.
  addLayer(dir);
  const mixed = { scenes: [videoScene(), videoScene(sha('d'), 'id-review')], music: { gainDb: -16 } };
  const both = runPreviewGates(base(dir, { brief: mixed }), { measureImpl: good });
  assert.equal(both.block, false);
  assert.deepEqual(statuses(both), [['L', 'warn'], ['G8', 'pass']]);

  // Обычный сток B-roll без признаков слоя – без гейта L.
  const plain = project(t);
  writeJson(path.join(plain, 'assets', 'broll', 'video', 'id-stock', 'asset.json'), { label: 'city-night.mp4' });
  const stock = runPreviewGates(base(plain, { brief: { scenes: [videoScene(sha('e'), 'id-stock')] } }), { measureImpl: good });
  assert.deepEqual(statuses(stock), [['G8', 'skipped']]);
});

test('a failed measurement stops a kit layer and is reference-only for other projects', (t) => {
  const boom = () => { throw new Error('ffmpeg упал'); };
  const kit = runPreviewGates(base(project(t, { registered: true })), { measureImpl: boom });
  assert.equal(kit.block, true);
  assert.deepEqual(statuses(kit), [['L', 'pass'], ['G8', 'fail']]);
  assert.match(kit.report.gates[1].hint, /замер не удался: ffmpeg упал/u);

  const other = runPreviewGates(base(project(t)), { measureImpl: boom });
  assert.equal(other.block, false);
  assert.deepEqual(statuses(other), [['G8', 'skipped']]);
  assert.match(other.report.gates[0].hint, /^для справки: замер не удался: ffmpeg упал/u);
  assert.doesNotMatch(other.report.gates[0].hint, NO_ADVICE);

  // Замер старой формы гейт отклоняет – это тоже «замер не удался», а не пропуск.
  const oldShape = runPreviewGates(base(project(t, { registered: true })), { measureImpl: () => ({ median: 12, p10: 9 }) });
  assert.equal(oldShape.block, true);
  assert.match(oldShape.report.gates[1].hint, /замер не удался: .*gapLu/u);
});

test('the gain advice stays inside the music.gainDb schema range', (t) => {
  const nearFloor = { ...brief, music: { gainDb: -55 } };
  const result = runPreviewGates(base(project(t, { registered: true }), { brief: nearFloor }), { measureImpl: loud });
  assert.match(result.report.gates[1].hint, /до −60 дБ/u);
});

test('without music G8 is skipped and nothing is measured', (t) => {
  const result = runPreviewGates(base(project(t, { registered: true }), { hasMusic: false, words: undefined, manifest: {} }),
    { measureImpl: () => { throw new Error('не должен мерить'); } });
  assert.equal(result.block, false);
  assert.deepEqual(statuses(result), [['L', 'pass'], ['G8', 'skipped']]);
});

test('speech words come from the project transcript; a missing transcript stops a kit layer', (t) => {
  const dir = project(t, { registered: true });
  const manifest = { transcript: { words: 'transcript/words.json' } };
  const missing = runPreviewGates(base(dir, { words: undefined, manifest }), { measureImpl: good });
  assert.equal(missing.block, true);
  assert.match(missing.report.gates[1].hint, /замер не удался: нет транскрипта/u);

  writeJson(path.join(dir, 'transcript', 'words.json'), [
    { start: 0, end: 5, text: 'раз два', words: [{ w: 'раз', s: 2, e: 2.6 }, { w: 'два', s: 2.7, e: 3.5 }, { w: 'битое', s: 'x', e: 1 }] },
    { start: 8, end: 12, text: 'три', words: [{ w: 'три', s: 11, e: 12 }] },
  ]);
  assert.deepEqual(readProjectWords(dir, manifest), [{ s: 2, e: 2.6 }, { s: 2.7, e: 3.5 }, { s: 11, e: 12 }]);
  let seen = null;
  runPreviewGates(base(dir, { words: undefined, manifest, range: { fromSec: 2, toSec: 10 } }), { measureImpl: (input) => { seen = input; return good(); } });
  assert.deepEqual(seen.windows, [{ s: 0, e: 1.5 }]);
  assert.equal(seen.durationSec, 8);

  // Нет речи в диапазоне – замер не нужен, G8 пропущен.
  const silent = runPreviewGates(base(dir, { words: undefined, manifest, range: { fromSec: 5, toSec: 8 } }),
    { measureImpl: () => { throw new Error('не должен мерить'); } });
  assert.deepEqual(statuses(silent), [['L', 'pass'], ['G8', 'skipped']]);
});

test('two previews in the same millisecond write two separate reports', (t) => {
  const dir = project(t, { registered: true });
  const now = () => new Date('2026-09-29T12:00:00.000Z');
  const first = runPreviewGates(base(dir), { measureImpl: loud, now });
  const second = runPreviewGates(base(dir), { measureImpl: good, now });
  assert.notEqual(first.paths.jsonPath, second.paths.jsonPath);
  assert.equal(path.basename(first.paths.jsonPath), 'preview-20260929-120000-01.json');
  assert.equal(path.basename(second.paths.jsonPath), 'preview-20260929-120000-02.json');
  assert.equal(JSON.parse(fs.readFileSync(first.paths.jsonPath, 'utf8')).summary.status, 'fail');
  assert.equal(JSON.parse(fs.readFileSync(second.paths.jsonPath, 'utf8')).summary.status, 'pass');
  assert.equal(runPreviewGates(base(dir), { measureImpl: good, write: false }).paths, null);

  // Имя занято и одним .txt (JSON потерян) – берётся следующее.
  fs.writeFileSync(path.join(dir, 'qa', 'preview-20260929-120001-01.txt'), 'старый отчёт');
  const third = runPreviewGates(base(dir), { measureImpl: good, now: () => new Date('2026-09-29T12:00:01.000Z') });
  assert.equal(path.basename(third.paths.jsonPath), 'preview-20260929-120001-02.json');
  assert.equal(fs.readFileSync(path.join(dir, 'qa', 'preview-20260929-120001-01.txt'), 'utf8'), 'старый отчёт');
});

test('a report that cannot be written is still returned with a short reason', (t) => {
  // Ролик без слоя kit: qa/ – обычный файл, отчёт не записан, но вердикт есть и ничего не блокируется.
  const plain = project(t);
  fs.writeFileSync(path.join(plain, 'qa'), 'не папка');
  const other = runPreviewGates(base(plain, { brief: { scenes: [], music: { gainDb: -16 } } }), { measureImpl: loud });
  assert.equal(other.enforced, false);
  assert.equal(other.block, false);
  assert.equal(other.paths, null);
  assert.equal(other.report.kind, 'preview');
  assert.match(other.writeError, /qa\//u);
  assert.equal(other.writeError.includes(plain), false);

  // Бриф с видео: реестр за файлом qa/ не прочитать – барьер закрыт, причина записи тоже без абсолютных путей.
  const kit = project(t);
  fs.writeFileSync(path.join(kit, 'qa'), 'не папка');
  const closed = runPreviewGates(base(kit), { measureImpl: good });
  assert.equal(closed.enforced, true);
  assert.equal(closed.block, true);
  assert.equal(closed.paths, null);
  assert.match(closed.writeError, /qa\//u);
  assert.equal(closed.writeError.includes(kit), false);
  assert.match(closed.report.gates[0].hint, /^qa\/ – ссылка или файл/u);
});

// Ошибка замера (сырой stderr ffmpeg с полным путём, сообщения mix-gates) становится подсказкой G8 и уходит
// в qa/preview-*.json и .txt: папки проекта и временных файлов там быть не должно – только имена файлов.
test('a failed G8 measurement never writes the project path into the preview report', (t) => {
  for (const registered of [true, false]) {
    const dir = project(t, { registered });
    const finished = path.join(dir, 'tmp', 'preview-stage', 'finished.mp4');
    const boom = () => { throw new Error(`ffmpeg не смог отдать звук: ${finished}: No such file or directory; `
      + `Error opening input file '${path.join(dir, 'music.mp3')}'. C:\\Users\\someone\\project\\voice.wav`); };
    const result = runPreviewGates(base(dir, { finishedPath: finished }), { measureImpl: boom });
    const hint = result.report.gates.find((g) => g.id === 'G8').hint;
    assert.match(hint, /замер не удался: ffmpeg не смог отдать звук: finished\.mp4: No such file or directory/u);
    for (const file of [result.paths.jsonPath, result.paths.textPath]) {
      const written = fs.readFileSync(file, 'utf8');
      assert.equal(written.includes(dir), false, `${registered ? 'слой kit' : 'без слоя'}: ${written}`);
      assert.equal(written.includes(os.tmpdir()), false);
      assert.doesNotMatch(written, /Users/u);
    }
  }
});

// Ролик без видео-сцен и qa/ – ссылка: отчёт сквозь неё не пишется, но preview такого ролика публикуется
// (барьер не строгий, сбой записи – только предупреждение).
test('a symlinked qa/ gets no preview report written through it; a plain preview still publishes', (t) => {
  const dir = project(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-gates-qa-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.symlinkSync(elsewhere, path.join(dir, 'qa'), 'dir');
  const result = runPreviewGates(base(dir, { brief: { scenes: [], music: { gainDb: -16 } } }), { measureImpl: good });
  assert.equal(result.enforced, false);
  assert.equal(result.block, false);
  assert.equal(result.paths, null);
  assert.match(result.writeError, /qa\/ должна быть папкой проекта, а не ссылкой/u);
  assert.equal(result.writeError.includes(dir), false);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('layers with different profiles: G8 uses the profile of the first layer in scene order', (t) => {
  const dir = project(t);
  addLayer(dir, { layer: 'motion-v01', render: sha('1'), canonical: sha('a'), profile: 'live' });
  addLayer(dir, { layer: 'motion-v02', render: sha('2'), canonical: sha('b'), profile: 'avatar' });
  const scenes = [videoScene(sha('a'), 'id-motion-v01'), videoScene(sha('b'), 'id-motion-v02')];
  // Цель avatar различает профили: в коридоре avatar – pass, выше стоп-границы live – предупреждение
  // (коридор live не откалиброван и не останавливает).
  assert.ok(AVATAR_TARGET > getProfile('live').voiceMusic.stopHigh);
  const first = runPreviewGates(base(dir, { brief: { scenes, music: { gainDb: -16 } } }), { measureImpl: good });
  assert.equal(first.report.profile, 'live');
  assert.deepEqual(statuses(first), [['L', 'pass'], ['G8', 'warn']]);
  assert.equal(first.block, false);
  const swapped = runPreviewGates(base(dir, { brief: { scenes: [...scenes].reverse(), music: { gainDb: -16 } } }), { measureImpl: good });
  assert.equal(swapped.report.profile, 'avatar');
  assert.deepEqual(statuses(swapped), [['L', 'pass'], ['G8', 'pass']]);
});

test('the preview report records its inputs with project-relative paths: source, brief and each checked layer', (t) => {
  const dir = project(t);
  addLayer(dir, { layer: 'motion-v01', render: sha('1'), canonical: sha('a') });
  addLayer(dir, { layer: 'motion-v02', render: sha('2'), canonical: sha('b') });
  const scenes = [videoScene(sha('a'), 'id-motion-v01'), videoScene(sha('b'), 'id-motion-v02')];
  // preview отдаёт абсолютные пути – в отчёт они попадают относительными к проекту, как в отчётах layer.
  const result = runPreviewGates(base(dir, {
    brief: { scenes, music: { gainDb: -16 } },
    sourcePath: path.join(dir, 'source', 'speaker.mp4'),
    briefPath: path.join(dir, 'brief', 'lesson-brief.json'), briefSha256: sha('f'),
  }), { measureImpl: good });
  const expected = [
    { role: 'source', path: 'source/speaker.mp4', sha256: SOURCE },
    { role: 'brief', path: 'brief/lesson-brief.json', sha256: sha('f') },
    { role: 'layer', path: 'assets/broll/video/id-motion-v01/media.mp4', sha256: sha('a') },
    { role: 'layer', path: 'assets/broll/video/id-motion-v02/media.mp4', sha256: sha('b') },
  ];
  assert.deepEqual(result.report.inputs, expected);
  const written = fs.readFileSync(result.paths.jsonPath, 'utf8');
  assert.deepEqual(JSON.parse(written).inputs, expected);
  assert.equal(written.includes(dir), false);

  // Ролик без слоя kit: только исходник и brief. Без путей и sha256 входов нет – вход без sha256 не пишется.
  const plain = runPreviewGates(base(project(t), {
    brief: { scenes: [], music: { gainDb: -16 } },
    sourcePath: path.join(dir, 'source', 'speaker.mp4'), briefPath: path.join(dir, 'brief', 'b.json'), briefSha256: sha('f'),
  }), { measureImpl: good, write: false });
  assert.deepEqual(plain.report.inputs.map((i) => i.role), ['source', 'brief']);
  assert.deepEqual(runPreviewGates(base(project(t), { brief: { scenes: [], music: { gainDb: -16 } }, sourceSha256: undefined }),
    { measureImpl: good, write: false }).report.inputs, []);
});

test('a preview report with layer inputs is never taken for a layer render report', (t) => {
  const dir = project(t, { registered: true, render: sha('r'), canonical: sha('c') });
  const { findRenderReport } = require('../scripts/layer/registry');
  runPreviewGates(base(dir, { sourcePath: path.join(dir, 'source', 'speaker.mp4') }), { measureImpl: good });
  // Вход «layer» preview-отчёта – импортированный ассет (canonicalSha256): поиск рендера по нему ничего не находит.
  assert.equal(findRenderReport(dir, sha('c')), null);
  assert.equal(findRenderReport(dir, sha('r')).kind, 'layer-render');
});
