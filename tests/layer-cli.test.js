const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HELP, main, parseArgs } = require('../scripts/layer/cli');
const {
  nextLayerName, projectFrom, readJson, readLayerJson, relative, resolveLayer, sha256File, writeJson,
} = require('../scripts/layer/common');
const { hashFile } = require('../scripts/pult/files');
const { createOrOpenProject } = require('../scripts/project/workspace');

const cli = path.resolve(__dirname, '../scripts/cli.js');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

function makeProjectFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.mp4');
  fs.writeFileSync(sourcePath, 'video');
  const workspace = createOrOpenProject({
    baseDir: path.join(dir, 'projects'),
    name: 'Layer CLI fixture',
    sourcePath,
    now: new Date('2026-09-01T00:00:00Z'),
  });
  return { dir, projectDir: workspace.dir };
}

// Фейковая подкоманда для тестов роутера: поведение управляется флагом --mode, а не process.env —
// так параллельные тесты не делят глобальное состояние. Файл живёт во временной папке и требуется
// по абсолютному пути через commands-override main(), а не подменой Module._resolveFilename.
function makeFakeCommand(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-fake-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fake-cmd.js');
  fs.writeFileSync(file, `
    module.exports = {
      FLAGS: { mode: 'value' },
      async run(options) {
        const mode = options.mode;
        if (mode === 'undef') return undefined;
        if (mode === 'throwstr') throw 'plain string';
        if (mode === 'throwundef') throw undefined;
        if (mode === 'throw') throw new Error('boom');
        if (mode === 'two') return 2;
        return 0;
      },
    };
  `);
  return file;
}

async function captureConsoleError(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = original;
  }
}

test('public CLI advertises layer commands and routes them to their own script', () => {
  const help = run('--help');
  for (const line of ['automontage layer new --project-dir', 'automontage layer check', 'automontage layer render', 'automontage layer import', 'automontage layer brief']) {
    assert.match(help.stdout, new RegExp(line));
  }
  assert.match(help.stdout, /automontage layer --help/);
  const usage = run('layer');
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: automontage layer new\|words\|check\|render\|import\|brief\|stock\|sheet/);
  assert.doesNotMatch(usage.stderr, /build\.js|ENOENT/);
  const unknown = run('layer', 'bogus');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /неизвестная команда layer bogus/);
  const help2 = run('layer', '--help');
  assert.equal(help2.status, 0);
  assert.match(help2.stdout, /usage: automontage layer/);
});

test('layer flags are strict: unknown, repeated and valueless flags fail', () => {
  const flags = { 'project-dir': 'value', wait: 'bool' };
  assert.deepEqual(parseArgs(['--project-dir', 'p', '--wait'], flags), { 'project-dir': 'p', wait: true });
  assert.throws(() => parseArgs(['--nope', '1'], flags), /неизвестный флаг --nope/);
  assert.throws(() => parseArgs(['--project-dir', 'a', '--project-dir', 'b'], flags), /повторяется/);
  assert.throws(() => parseArgs(['--project-dir', '--wait'], flags), /требует значение/);
  assert.throws(() => parseArgs(['stray'], flags), /лишний аргумент «stray»/);
});

test('parseArgs rejects --flag=value with a hint, but keeps a leading-dash value given as a separate argument', () => {
  const flags = { 'project-dir': 'value', 'music-gain-db': 'value' };
  assert.throws(() => parseArgs(['--project-dir=p'], flags), /пишите --project-dir p \(без =\)/);
  assert.throws(() => parseArgs(['--music-gain-db=-16'], flags), /пишите --music-gain-db -16 \(без =\)/);
  assert.deepEqual(parseArgs(['--music-gain-db', '-16'], flags), { 'music-gain-db': '-16' });
});

test('parseArgs checks the key before = first: unknown key, bool flag and an empty value get their own message', () => {
  const flags = { 'project-dir': 'value', wait: 'bool' };
  // Неизвестный ключ — та же ошибка, что без =, а не совет «пишите --nope 1».
  assert.throws(() => parseArgs(['--nope=1'], flags), (error) => {
    assert.equal(error.message, 'неизвестный флаг --nope');
    return true;
  });
  // Булев флаг значения не принимает вовсе — совет «пишите --wait 1» был бы неверным.
  assert.throws(() => parseArgs(['--wait=1'], flags), (error) => {
    assert.equal(error.message, 'флаг --wait не принимает значения');
    return true;
  });
  assert.throws(() => parseArgs(['--wait='], flags), /флаг --wait не принимает значения/);
  // Пустое значение после = — подсказка без двойного пробела.
  assert.throws(() => parseArgs(['--project-dir='], flags), (error) => {
    assert.equal(error.message, 'пишите --project-dir <значение> (без =)');
    assert.doesNotMatch(error.message, / {2}/);
    return true;
  });
});

test('parseArgs reports help only at a flag position: -h right after a value flag is its value', () => {
  const flags = { title: 'value', wait: 'bool' };
  assert.deepEqual(parseArgs(['--title', '-h'], flags), { title: '-h' });
  assert.equal(parseArgs(['--title', 'T', '-h'], flags), HELP);
  assert.equal(parseArgs(['--wait', '-h'], flags), HELP);
  assert.equal(parseArgs(['--help'], flags), HELP);
});

test('main() treats --help/-h anywhere in argv as the top-level usage, without touching subcommand modules', async () => {
  const outputs = [];
  const original = console.log;
  console.log = (...args) => outputs.push(args.join(' '));
  try {
    // 'new' и 'render' ничего не реализуют (задачи 29+), но --help не должен требовать их модуль.
    assert.equal(await main(['new', '--project-dir', 'p', '--help']), 0);
    assert.equal(await main(['-h']), 0);
    assert.equal(await main(['render', '-h', '--layer', 'motion-v01']), 0);
  } finally {
    console.log = original;
  }
  assert.equal(outputs.length, 3);
  for (const out of outputs) assert.match(out, /usage: automontage layer/);
});

test('main() does not take a -h value for help, but a standalone --help still wins', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-help-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'title-cmd.js');
  fs.writeFileSync(file, `
    module.exports = {
      FLAGS: { title: 'value', wait: 'bool' },
      async run(options) { module.exports.seen = options; return 0; },
    };
  `);
  const outputs = [];
  const original = console.log;
  console.log = (...args) => outputs.push(args.join(' '));
  try {
    // «-h» — значение --title: подкоманда получает заголовок, помощь не печатается.
    assert.equal(await main(['brief', '--title', '-h'], { commands: { brief: file } }), 0);
    assert.deepEqual(require(file).seen, { title: '-h' });
    assert.equal(outputs.length, 0);
    // После булева флага -h стоит на месте флага — это помощь.
    assert.equal(await main(['brief', '--wait', '-h'], { commands: { brief: file } }), 0);
    assert.equal(await main(['brief', '--title', 'T', '--help'], { commands: { brief: file } }), 0);
  } finally {
    console.log = original;
  }
  assert.equal(outputs.length, 2);
  for (const out of outputs) assert.match(out, /usage: automontage layer/);
});

test('router extracts a message from a thrown string or undefined instead of crashing', async (t) => {
  const file = makeFakeCommand(t);
  const strThrow = await captureConsoleError(() => main(['import', '--mode', 'throwstr'], { commands: { import: file } }));
  assert.equal(strThrow.result, 1);
  assert.match(strThrow.lines[0], /❌ layer import отменён: plain string/);

  const undefThrow = await captureConsoleError(() => main(['import', '--mode', 'throwundef'], { commands: { import: file } }));
  assert.equal(undefThrow.result, 1);
  assert.match(undefThrow.lines[0], /❌ layer import отменён: undefined/);
});

test('router treats a non-integer return value from a subcommand as an error, not a silent success', async (t) => {
  const file = makeFakeCommand(t);
  const { result, lines } = await captureConsoleError(() => main(['import', '--mode', 'undef'], { commands: { import: file } }));
  assert.equal(result, 1);
  assert.match(lines[0], /❌ layer import отменён:.*код возврата/);
});

test('router promotes a thrown error from the gate commands check/render to exit 2, keeps 1 for others', async (t) => {
  const file = makeFakeCommand(t);
  assert.equal(await main(['check', '--mode', 'throw'], { commands: { check: file } }), 2);
  assert.equal(await main(['render', '--mode', 'throw'], { commands: { render: file } }), 2);
  assert.equal(await main(['import', '--mode', 'throw'], { commands: { import: file } }), 1);
  // Успешный возврат кода не переопределяется: gate-команда может честно вернуть 1 (STOP отчёта).
  assert.equal(await main(['check', '--mode', 'two'], { commands: { check: file } }), 2);
});

test('the real CLI promotes a gate-command router failure to exit 2 through scripts/cli.js', () => {
  for (const command of ['check', 'render']) {
    const result = run('layer', command, '--bogus');
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`❌ layer ${command} отменён`));
  }
  // У остальных команд отчёта нет, поэтому любой отказ роутера — код 1, а не 2. Модуля import ещё нет
  // (Task 35): здесь отказ — «Cannot find module», а не неизвестный флаг; код от этого не зависит.
  const other = run('layer', 'import', '--bogus');
  assert.equal(other.status, 1, other.stderr);
  assert.match(other.stderr, /❌ layer import отменён/);
});

test('sha256File streams the file in chunks and matches crypto over its bytes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-hash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.bin');
  const bytes = Buffer.from('automontage layer hash sample');
  fs.writeFileSync(file, bytes);
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256File(file), expected);
  // Потоковое чтение кусками — это hashFile пульта, а не своя копия, читающая файл целиком.
  assert.equal(sha256File, hashFile);
});

test('readJson names the file in a broken-JSON error, using a custom label when given', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-readjson-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'weird-name.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => readJson(file), /weird-name\.json: неверный JSON/);
  assert.throws(() => readJson(file, 'project.json'), /project\.json: неверный JSON/);
});

test('writeJson writes atomically through a nested, not-yet-existing directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-writejson-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'motion-v01', 'out', 'manifest.json');
  writeJson(file, { version: 1, ok: true });
  const text = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(text), { version: 1, ok: true });
  assert.match(text, /\n$/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['manifest.json']);
});

test('readLayerJson validates sfxMasterDb the same way SfxTrack does, and rejects a non-object layer.json', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const layerDir = path.join(dir, 'motion-v01');
  fs.mkdirSync(layerDir, { recursive: true });
  const layerFile = path.join(layerDir, 'layer.json');
  const writeLayer = (value, { omit = false } = {}) => {
    const layer = { version: 1, composition: 'motion-v01', fps: 25, width: 1080, height: 1920 };
    if (!omit) layer.sfxMasterDb = value;
    fs.writeFileSync(layerFile, JSON.stringify(layer));
  };

  writeLayer(3);
  assert.throws(() => readLayerJson(layerDir), /layer\.json/);
  assert.throws(() => readLayerJson(layerDir), /sfxMasterDb/);

  writeLayer(null);
  assert.throws(() => readLayerJson(layerDir), /layer\.json/);
  assert.throws(() => readLayerJson(layerDir), /sfxMasterDb/);

  writeLayer(undefined, { omit: true });
  assert.throws(() => readLayerJson(layerDir), /layer\.json/);
  assert.throws(() => readLayerJson(layerDir), /sfxMasterDb/);

  writeLayer(-5);
  const layer = readLayerJson(layerDir);
  assert.equal(layer.sfxMasterDb, -5);
  assert.equal(layer.composition, 'motion-v01');

  fs.writeFileSync(layerFile, '{"sfxMasterDb": -5,');
  assert.throws(() => readLayerJson(layerDir), /layer\.json: неверный JSON/);

  fs.writeFileSync(layerFile, '[]');
  assert.throws(() => readLayerJson(layerDir), /layer\.json должен быть объектом/);

  fs.writeFileSync(layerFile, 'null');
  assert.throws(() => readLayerJson(layerDir), /layer\.json должен быть объектом/);
});

test('resolveLayer accepts a real layer directory and rejects names failing the motion-vNN pattern', (t) => {
  const { projectDir } = makeProjectFixture(t);
  fs.mkdirSync(path.join(projectDir, 'motion-v01'));

  const resolved = resolveLayer({ 'project-dir': projectDir, layer: 'motion-v01' });
  assert.equal(resolved.layerName, 'motion-v01');
  assert.equal(resolved.layerDir, path.join(projectDir, 'motion-v01'));
  assert.equal(resolved.projectDir, projectDir);

  assert.throws(() => resolveLayer({ 'project-dir': projectDir, layer: 'foo' }), /--layer должен быть вида motion-v01/);
  assert.throws(() => resolveLayer({ 'project-dir': projectDir, layer: 'motion-v1' }), /--layer должен быть вида motion-v01/);
  // Путь вида «../x» не совпадает с motion-vNN и отклоняется раньше, чем дошёл бы до файловой
  // системы — вторая линия защиты (resolveProjectPath) не вызывается вовсе.
  assert.throws(() => resolveLayer({ 'project-dir': projectDir, layer: '../x' }), /--layer должен быть вида motion-v01/);
  assert.throws(() => resolveLayer({ 'project-dir': projectDir, layer: '../motion-v01' }), /--layer должен быть вида motion-v01/);
});

test('resolveLayer gives a friendly message for a missing layer and wraps other resolveProjectPath errors with --layer <name>', (t) => {
  const { projectDir } = makeProjectFixture(t);

  assert.throws(
    () => resolveLayer({ 'project-dir': projectDir, layer: 'motion-v99' }),
    (error) => {
      assert.match(error.message, /папка слоя motion-v99 не найдена — создайте: automontage layer new/);
      // Подсказка готова к копированию: настоящая папка проекта в кавычках (пути с пробелами), а не <p>.
      assert.ok(error.message.endsWith(`--project-dir "${projectDir}"`), error.message);
      assert.doesNotMatch(error.message, /<p>/);
      return true;
    },
  );

  fs.writeFileSync(path.join(projectDir, 'motion-v03'), 'x');
  assert.throws(
    () => resolveLayer({ 'project-dir': projectDir, layer: 'motion-v03' }),
    /--layer motion-v03: layer must be a directory/,
  );

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(projectDir, 'motion-v01'));
  assert.throws(
    () => resolveLayer({ 'project-dir': projectDir, layer: 'motion-v01' }),
    /--layer motion-v01: layer escapes through a symbolic link/,
  );

  // resolveProjectPath не делает исключения для симлинка, указывающего ВНУТРЬ проекта — тоже отказ.
  fs.mkdirSync(path.join(projectDir, 'real'));
  fs.symlinkSync(path.join(projectDir, 'real'), path.join(projectDir, 'motion-v02'));
  assert.throws(
    () => resolveLayer({ 'project-dir': projectDir, layer: 'motion-v02' }),
    /--layer motion-v02: layer escapes through a symbolic link/,
  );
});

test('nextLayerName is the highest existing number + 1 and never reuses one, even for a file or a dangling symlink', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-next-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(nextLayerName(dir), 'motion-v01');
  fs.mkdirSync(path.join(dir, 'motion-v01'));
  assert.equal(nextLayerName(dir), 'motion-v02');
  fs.mkdirSync(path.join(dir, 'motion-v03'));
  // v02 занят, v03 тоже — следующий номер идёт после максимума, а не в дыру: старые qa-отчёты и
  // pult-card.json могут ссылаться на уже использованные имена, их нельзя выдать повторно.
  assert.equal(nextLayerName(dir), 'motion-v04');

  fs.writeFileSync(path.join(dir, 'motion-v04'), 'x');
  assert.equal(nextLayerName(dir), 'motion-v05');

  fs.symlinkSync(path.join(dir, 'nope'), path.join(dir, 'motion-v05'));
  assert.equal(nextLayerName(dir), 'motion-v06');
});

test('projectFrom names the flag for a missing project folder and the file for a broken project.json', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-project-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, 'no-such-project');
  assert.throws(() => projectFrom({ 'project-dir': missing }), (error) => {
    assert.equal(error.message, `--project-dir ${missing}: папка не найдена`);
    return true;
  });
  const file = path.join(dir, 'plain-file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => projectFrom({ 'project-dir': file }), /--project-dir .*plain-file: папка не найдена/);

  const { projectDir } = makeProjectFixture(t);
  assert.equal(projectFrom({ 'project-dir': projectDir }).projectDir, projectDir);
  fs.writeFileSync(path.join(projectDir, 'project.json'), '{"version": 1,');
  assert.throws(() => projectFrom({ 'project-dir': projectDir }), /^Error: project\.json: неверный JSON \(/);
  fs.writeFileSync(path.join(projectDir, 'project.json'), '{"version": 1}');
  assert.throws(() => projectFrom({ 'project-dir': projectDir }), /^Error: project\.json: /);
  fs.rmSync(path.join(projectDir, 'project.json'));
  assert.throws(() => projectFrom({ 'project-dir': projectDir }), /^Error: project\.json не найден/);
});

test('top-level help lines keep one description column, including automontage layer --help', () => {
  const lines = run('--help').stdout.split('\n');
  const column = (prefix) => {
    const line = lines.find((item) => item.startsWith(prefix));
    assert.ok(line, prefix);
    return line.slice(prefix.length).search(/\S/) + prefix.length;
  };
  assert.equal(column('  automontage layer --help'), column('  automontage --help'));
});

test('relative uses forward slashes for a nested layer path', () => {
  const projectDir = path.join('a', 'b', 'project');
  const file = path.join(projectDir, 'motion-v01', 'out', 'manifest.json');
  assert.equal(relative(projectDir, file), 'motion-v01/out/manifest.json');
});
