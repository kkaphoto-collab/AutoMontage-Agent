const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveRemotionCommand } = require('../scripts/env');
const { remotionLayerRenderCommand, remotionRenderCommand } = require('../scripts/build-commands');
const { remotionChunkCommand } = require('../scripts/render-chunks');
const { docPreviewCommand } = require('../scripts/generate-doc-preview');

const ROOT = path.resolve(__dirname, '..');
const cliDirectory = path.dirname(require.resolve('@remotion/cli/package.json'));

// Run the installed CLI parser and browser-environment loader in an isolated child.
// Match the real remotion-cli.js dotenv bootstrap without starting a render.
function browserEnvironment(t, argv, filename = '.env') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-render-env-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"synthetic-env-fixture"}');
  fs.writeFileSync(path.join(directory, filename), [
    'PEXELS_API_KEY=synthetic-provider-secret-do-not-publish',
    'ELEVENLABS_API_KEY=synthetic-narration-secret',
    'ELEVENLABS_VOICE_ID=synthetic-narration-voice',
    'UNRELATED_PRIVATE_VALUE=synthetic-private-value',
    'REMOTION_PUBLIC_FIXTURE=public-dotenv-value',
  ].join('\n'));
  const script = `
    process.argv = [process.execPath, ...JSON.parse(process.argv[1])];
    require(${JSON.stringify(require.resolve('dotenv'))}).config({ quiet: true });
    const { parsedCli } = require(${JSON.stringify(path.join(cliDirectory, 'dist/parsed-cli.js'))});
    const { getEnvironmentVariables } = require(${JSON.stringify(path.join(cliDirectory, 'dist/get-env.js'))});
    const env = getEnvironmentVariables(undefined, 'error', false);
    console.log(JSON.stringify({
      keys: Object.keys(env),
      leakedProvider: env.PEXELS_API_KEY !== undefined,
      leakedNarration: env.ELEVENLABS_API_KEY !== undefined || env.ELEVENLABS_VOICE_ID !== undefined,
      leakedPrivate: env.UNRELATED_PRIVATE_VALUE !== undefined,
      publicProcess: env.REMOTION_PUBLIC_PROCESS,
      publicDotenv: env.REMOTION_PUBLIC_FIXTURE,
      positionals: parsedCli._,
      envFile: parsedCli['env-file'],
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script, JSON.stringify(argv)], {
    cwd: directory,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, REMOTION_PUBLIC_PROCESS: 'public-process-value' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-provider-secret|synthetic-private-value/);
  return JSON.parse(result.stdout);
}

const builders = {
  final: (resolved) => remotionRenderCommand(resolved, {
    entry: 'src/index.js', composition: 'LessonSeq', output: '/tmp/final.mp4', props: '/tmp/props.json',
  }),
  preview: (resolved) => remotionRenderCommand(resolved, {
    entry: 'src/index.js', composition: 'LessonSeq', output: '/tmp/preview.mp4', props: '/tmp/props.json',
    scale: 0.5, crf: 28, frameRange: { fromFrame: 0, toFrameExclusive: 2 },
  }),
  chunk: (resolved) => remotionChunkCommand(resolved, {
    composition: 'LessonSeq', output: '/tmp/chunk.mp4', props: '/tmp/props.json', from: 0, to: 1,
  }),
  still: (resolved) => docPreviewCommand(resolved, '/tmp/still.png'),
  layer: (resolved) => remotionLayerRenderCommand(resolved, {
    entry: 'projects/p/motion-v01/src/index.jsx', composition: 'Layer', output: 'out.mp4', publicDir: 'projects/p/motion-v01/public',
  }),
};

// entry/composition реальны только для final/preview/chunk (src/index.js + LessonSeq, still впереди
// добавляет своё имя подкоманды) и для layer (свой слой, своя композиция) – у каждого builder свои.
const POSITIONALS_BY_BUILDER = {
  final: ['render', 'src/index.js', 'LessonSeq'],
  preview: ['render', 'src/index.js', 'LessonSeq'],
  chunk: ['render', 'src/index.js', 'LessonSeq'],
  still: ['still', 'src/index.js', 'LessonSeq'],
  layer: ['render', 'projects/p/motion-v01/src/index.jsx', 'Layer'],
};

test('installed Remotion loader reproduces root dotenv browser exposure without protection', (t) => {
  const result = browserEnvironment(t, [path.join(cliDirectory, 'remotion-cli.js'), 'render']);
  assert.equal(result.leakedProvider, true);
  assert.equal(result.leakedNarration, true);
  assert.equal(result.leakedPrivate, true);
  assert.equal(result.publicProcess, 'public-process-value');
});

for (const [name, build] of Object.entries(builders)) {
  for (const filename of ['.env', '.env.local']) {
    test(`${name} excludes private ${filename} keys using the installed CLI parser and loader`, (t) => {
      const command = build(resolveRemotionCommand(ROOT));
      const result = browserEnvironment(t, command.args, filename);
      assert.equal(result.leakedProvider, false);
      assert.equal(result.leakedNarration, false);
      assert.equal(result.leakedPrivate, false);
      assert.equal(result.publicProcess, 'public-process-value');
      if (filename === '.env') assert.equal(result.publicDotenv, 'public-dotenv-value');
      assert.deepEqual(result.positionals.slice(0, 3), POSITIONALS_BY_BUILDER[name]);
      assert.ok(path.isAbsolute(result.envFile));
      assert.ok(fs.readFileSync(result.envFile, 'utf8').split('\n').every((line) => !line.trim() || line.trim().startsWith('#')));
    });
  }
}

for (const filename of ['.env', '.env.local']) {
  test(`horizontal preview shell script excludes private ${filename} keys`, { skip: process.platform === 'win32' }, (t) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage shell env '));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.mkdirSync(path.join(fixture, 'config'));
    fs.mkdirSync(path.join(fixture, 'bin'));
    fs.copyFileSync(path.join(ROOT, 'scripts/run-preview-h.sh'), path.join(fixture, 'scripts/run-preview-h.sh'));
    fs.copyFileSync(path.join(ROOT, 'config/remotion-public.env'), path.join(fixture, 'config/remotion-public.env'));
    const capture = path.join(fixture, 'argv.json');
    // Stop at the first command: exercise real shell expansion but never render,
    // finish, mix user music, or download an executable through npx.
    for (const executable of ['node', 'npx']) {
      fs.writeFileSync(path.join(fixture, 'bin', executable), `#!${process.execPath}\n`
        + `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(77);\n`);
      fs.chmodSync(path.join(fixture, 'bin', executable), 0o755);
    }
    const run = spawnSync('bash', [path.join(fixture, 'scripts/run-preview-h.sh')], {
      encoding: 'utf8', env: { PATH: `${path.join(fixture, 'bin')}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(run.status, 77, run.stderr);
    const argv = JSON.parse(fs.readFileSync(capture, 'utf8'));
    const result = browserEnvironment(t, argv, filename);
    assert.equal(result.leakedProvider, false);
    assert.equal(result.leakedPrivate, false);
    assert.equal(result.publicProcess, 'public-process-value');
    assert.deepEqual(result.positionals, ['render', 'PreviewH', '/tmp/preview_h_raw.mp4']);
    assert.equal(result.envFile, path.join(fixture, 'config/remotion-public.env'));
    assert.equal(argv[0], 'node_modules/@remotion/cli/remotion-cli.js');
  });
}

// layer.json – файл проекта: composition становится позиционным аргументом Remotion. Значение вида
// «--env-file=…» Remotion прочитал бы как флаг и подключил бы в браузер рендера чужой env-файл.
test('a layer composition that looks like a flag never reaches the Remotion command', (t) => {
  const { readLayerJson } = require('../scripts/layer/common');
  const resolved = { command: 'node', argsPrefix: ['cli.js', '--env-file=empty.env'] };
  const command = (composition) => remotionLayerRenderCommand(resolved, {
    entry: 'projects/p/motion-v01/src/index.jsx', composition, output: 'out.mp4', publicDir: 'projects/p/motion-v01/public',
  });
  const layerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-layer-composition-'));
  t.after(() => fs.rmSync(layerDir, { recursive: true, force: true }));
  const writeLayer = (composition) => fs.writeFileSync(path.join(layerDir, 'layer.json'), JSON.stringify({ version: 1, composition, sfxMasterDb: -5 }));
  for (const payload of ['--env-file=../../.env', '--gl=swiftshader', '--overwrite', '-q', 'Layer --props=x', '', 'Лейер', 42, undefined]) {
    assert.throws(() => command(payload), /composition/u, String(payload));
    writeLayer(payload);
    assert.throws(() => readLayerJson(layerDir), /^Error: layer\.json: composition должен быть именем композиции Remotion/u, String(payload));
  }
  // Легитимные имена проходят и стоят ровно на месте композиции.
  for (const name of ['Layer', 'Motion_Layer-2']) {
    assert.deepEqual(command(name).args.slice(2, 5), ['render', 'projects/p/motion-v01/src/index.jsx', name]);
    writeLayer(name);
    assert.equal(readLayerJson(layerDir).composition, name);
  }
});
