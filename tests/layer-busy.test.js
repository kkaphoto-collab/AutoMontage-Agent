const test = require('node:test');
const assert = require('node:assert/strict');
const { busyRenders, waitUntilFree } = require('../scripts/layer/busy');
const { remotionLayerRenderCommand } = require('../scripts/build-commands');

function fakePs(table) {
  return (args) => {
    if (args[0] === '-ax') return table.map((p) => `${p.pid} ${p.comm}`).join('\n');
    const pid = Number(args[args.indexOf('-p') + 1]);
    return `${table.find((p) => p.pid === pid).command}\n`;
  };
}

test('only real node render processes count as busy, not shell wrappers holding script text', () => {
  const table = [
    { pid: 10, comm: '/bin/zsh', command: "zsh -c 'cat > q.sh <<EOF remotion render EOF'" },
    { pid: 11, comm: '/opt/homebrew/bin/node', command: 'node node_modules/@remotion/cli/remotion-cli.js --env-file=x render src/index.js Lesson out.mp4' },
    { pid: 12, comm: 'node', command: 'node scripts/cli.js preview --project-dir p' },
    { pid: 13, comm: 'node', command: 'node some-server.js' },
  ];
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [] }).map((p) => p.pid), [11, 12]);
  assert.deepEqual(busyRenders({ psImpl: fakePs(table.slice(0, 1)), selfPids: [] }), []);
});

// knowledge/render-queue-pgrep-deadlock.md: до фактического запуска Remotion (после layer check и
// waitUntilFree) «layer render» — это просто ждущий node-процесс, неотличимый по командной строке от
// другого такого же ждущего процесса. Если бы busyRenders считал такой процесс «занятостью», два
// одновременно запущенных `automontage layer render` увидели бы друг друга занятыми и ждали бы вечно —
// та же взаимная блокировка, что была с `pgrep -f "remotion render"`, только на этом модуле.
test('two waiting `layer render` invocations never see each other as busy (that would deadlock forever)', () => {
  const table = [
    { pid: 20, comm: 'node', command: 'node /repo/scripts/cli.js layer render --project-dir /a --layer motion-v01' },
    { pid: 21, comm: 'node', command: 'node /repo/scripts/layer/cli.js render --project-dir /a --layer motion-v01' },
    { pid: 22, comm: 'node', command: 'node /repo/scripts/cli.js layer render --project-dir /b --layer motion-v01' },
    { pid: 23, comm: 'node', command: 'node /repo/scripts/layer/cli.js render --project-dir /b --layer motion-v01' },
  ];
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [20, 21] }), []);
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [22, 23] }), []);
  // Настоящий Remotion-рендер слоя (после ожидания) всё равно ловится — это не дыра в детекции,
  // а только отсутствие маркера у самого ожидания.
  const rendering = [...table, {
    pid: 24, comm: 'node', command: 'node /repo/node_modules/@remotion/cli/remotion-cli.js --env-file=x render /a/motion-v01/src/index.jsx Layer out.mp4',
  }];
  assert.deepEqual(busyRenders({ psImpl: fakePs(rendering), selfPids: [22, 23] }).map((p) => p.pid), [24]);
});

test('waitUntilFree polls until the machine is free and times out with the blocking command', async () => {
  let calls = 0;
  const logs = [];
  await waitUntilFree({ busyImpl: () => (calls++ < 2 ? [{ pid: 1, command: 'render' }] : []), sleep: async () => {}, log: (m) => logs.push(m) });
  assert.equal(calls, 3);
  assert.equal(logs.length, 2);
  let t = 0;
  await assert.rejects(waitUntilFree({ busyImpl: () => [{ pid: 1, command: 'node render' }], sleep: async () => { t += 60_000; }, now: () => t, timeoutMs: 120_000, log: () => {} }),
    /машина занята дольше 2 мин: node render/);
});

// На Windows нет `ps` — ни wmic, ни tasklist не подключаем ради этого; проверка занятости там просто
// не работает, и рендер стартует сразу с одной предупреждающей строкой.
test('on win32 there is no ps: busyRenders returns nothing and waitUntilFree logs one line and starts immediately', async () => {
  assert.deepEqual(busyRenders({
    platform: 'win32',
    psImpl: () => { throw new Error('ps: command not found (как на настоящем Windows)'); },
  }), []);

  const logs = [];
  await waitUntilFree({
    platform: 'win32',
    log: (m) => logs.push(m),
    busyImpl: () => { throw new Error('на Windows busyImpl вызываться не должен'); },
    sleep: async () => { throw new Error('на Windows sleep вызываться не должен'); },
  });
  assert.deepEqual(logs, ['проверка занятости машины недоступна на Windows — рендер начнётся сразу']);
});

test('layer render command keeps the empty env-file first and never needs props', () => {
  const command = remotionLayerRenderCommand({ command: 'node', argsPrefix: ['cli.js', '--env-file=empty.env'] },
    { entry: 'layer/src/index.jsx', composition: 'Layer', output: 'out.mp4', publicDir: 'layer/public' });
  assert.deepEqual(command.args.slice(0, 5), ['cli.js', '--env-file=empty.env', 'render', 'layer/src/index.jsx', 'Layer']);
  assert.ok(command.args.includes('--public-dir'));
  assert.ok(!command.args.includes('--props'));
});
