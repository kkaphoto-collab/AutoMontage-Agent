const test = require('node:test');
const assert = require('node:assert/strict');
const { busyRenders, waitUntilFree } = require('../scripts/layer/busy');
const { remotionLayerRenderCommand } = require('../scripts/build-commands');

// Имитирует настоящий ps: первый вызов — снимок ВСЕХ pid/ppid/comm (`-A -o pid=,ppid=,comm=`), второй —
// пакетный запрос командных строк только запрошенных pid (`-o pid=,command= -p <список>`). Как и
// настоящий ps на этой машине, пропавший между двумя снимками pid просто не попадает во вторую выборку
// (не бросает) — если конкретному тесту нужен именно бросок (гонка), он подменяет psImpl сам.
function fakePs(table) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  return (args) => {
    if (args[0] === '-A') return table.map((p) => `${p.pid} ${p.ppid} ${p.comm}`).join('\n');
    const pids = args[args.indexOf('-p') + 1].split(',').map(Number);
    return pids.filter((pid) => byPid.has(pid)).map((pid) => `${pid} ${byPid.get(pid).command}`).join('\n');
  };
}

test('only real node render processes count as busy, not shell wrappers holding script text', () => {
  const table = [
    { pid: 1, ppid: 0, comm: 'launchd', command: '/sbin/launchd' },
    { pid: 10, ppid: 1, comm: '/bin/zsh', command: "zsh -c 'cat > q.sh <<EOF remotion render EOF'" },
    { pid: 11, ppid: 10, comm: '/opt/homebrew/bin/node', command: 'node node_modules/@remotion/cli/remotion-cli.js --env-file=x render src/index.js Lesson out.mp4' },
    { pid: 12, ppid: 10, comm: 'node', command: 'node scripts/cli.js preview --project-dir p' },
    { pid: 13, ppid: 10, comm: 'node', command: 'node some-server.js' },
    { pid: 14, ppid: 10, comm: 'node', command: 'node scripts/build.js v.mp4 --project-dir p' },
    { pid: 15, ppid: 10, comm: 'node', command: 'node node_modules/.bin/remotion render src/index.ts Comp out.mp4' },
  ];
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [] }).map((p) => p.pid), [11, 12, 14, 15]);
  assert.deepEqual(busyRenders({ psImpl: fakePs(table.slice(0, 2)), selfPids: [] }), []);
});

// knowledge/render-queue-pgrep-deadlock.md: до фактического запуска Remotion (после layer check и
// waitUntilFree) «layer render» — это просто ждущий node-процесс, неотличимый по командной строке от
// другого такого же ждущего процесса. Если бы busyRenders считал такой процесс «занятостью», два
// одновременно запущенных `automontage layer render` увидели бы друг друга занятыми и ждали бы вечно —
// та же взаимная блокировка, что была с `pgrep -f "remotion render"`, только на этом модуле.
test('two waiting `layer render` invocations never see each other as busy (that would deadlock forever)', () => {
  const table = [
    { pid: 1, ppid: 0, comm: 'launchd', command: '/sbin/launchd' },
    { pid: 20, ppid: 1, comm: 'node', command: 'node /repo/scripts/cli.js layer render --project-dir /a --layer motion-v01' },
    { pid: 21, ppid: 20, comm: 'node', command: 'node /repo/scripts/layer/cli.js render --project-dir /a --layer motion-v01' },
    { pid: 22, ppid: 1, comm: 'node', command: 'node /repo/scripts/cli.js layer render --project-dir /b --layer motion-v01' },
    { pid: 23, ppid: 22, comm: 'node', command: 'node /repo/scripts/layer/cli.js render --project-dir /b --layer motion-v01' },
  ];
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [20, 21] }), []);
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [22, 23] }), []);
  // Настоящий Remotion-рендер слоя (после ожидания) всё равно ловится — это не дыра в детекции,
  // а только отсутствие маркера у самого ожидания.
  const rendering = [...table, {
    pid: 24, ppid: 23, comm: 'node', command: 'node /repo/node_modules/@remotion/cli/remotion-cli.js --env-file=x render /a/motion-v01/src/index.jsx Layer out.mp4',
  }];
  assert.deepEqual(busyRenders({ psImpl: fakePs(rendering), selfPids: [22, 23] }).map((p) => p.pid), [24]);
});

// Важный фикс код-ревью: selfPids раньше был статичным [pid, ppid] — если между automontage и слоем
// стоит ещё один узел-обёртка (например `codex exec "…cli.js preview…"` как дед процесса), его текст в
// argv совпадал бы с маркером, и layer render ждал бы собственного деда 3 часа (воспроизведено в ревью).
// Теперь по умолчанию (без явного selfPids) busyRenders сам строит цепочку предков от process.pid до 1
// по единственному снимку ps -A и исключает КАЖДОГО предка, а не только прямого родителя.
test('without an explicit selfPids, busyRenders walks every ancestor up to 1 — a grandparent that merely mentions a marker in its own argv is never "busy"', () => {
  const grandparent = 424242;
  const table = [
    { pid: 1, ppid: 0, comm: 'launchd', command: '/sbin/launchd' },
    // Дед — узел-обёртка вида «codex exec "<промпт>"», текст промпта случайно содержит маркер.
    { pid: grandparent, ppid: 1, comm: 'node', command: 'node codex-companion.mjs task "Смонтируй: node scripts/cli.js preview --project-dir p"' },
    { pid: process.ppid, ppid: grandparent, comm: 'node', command: 'node some-wrapper.js' },
    { pid: process.pid, ppid: process.ppid, comm: 'node', command: 'node scripts/layer/cli.js render --project-dir p' },
    // Посторонний, по-настоящему занятый процесс — не предок, должен остаться занятым.
    { pid: 555, ppid: 1, comm: 'node', command: 'node scripts/cli.js preview --project-dir other' },
  ];
  const busy = busyRenders({ psImpl: fakePs(table) }); // selfPids не передан — считается по цепочке предков
  assert.deepEqual(busy.map((p) => p.pid), [555]);
});

// Явный selfPids (как в тестах выше) по-прежнему работает даже когда «свой» процесс сам держит
// маркерный текст — раньше был бы риск считать себя же занятым, если бы фильтр исключения потерялся.
test('an explicit selfPids excludes a process even if its own command line carries a marker', () => {
  const table = [
    { pid: 1, ppid: 0, comm: 'launchd', command: '/sbin/launchd' },
    { pid: 30, ppid: 1, comm: 'node', command: 'node scripts/cli.js preview --project-dir p' },
  ];
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [30] }), []);
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [] }).map((p) => p.pid), [30]);
});

// path.basename(comm) === 'node' — точное совпадение, а не подстрока: comm вроде «node_repl» не node,
// даже если полная командная строка рядом содержит маркерный текст.
test('a comm that only contains "node" as a substring (e.g. node_repl) is not treated as a node process', () => {
  const table = [
    { pid: 1, ppid: 0, comm: 'launchd', command: '/sbin/launchd' },
    { pid: 40, ppid: 1, comm: 'node_repl', command: 'node_repl scripts/cli.js preview --project-dir p' },
  ];
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [] }), []);
});

// ps иногда отдаёт командную строку с задвоенными пробелами; маркер ищется подстрокой, поэтому без
// нормализации пробелов «cli.js  preview» (два пробела) не совпал бы с «cli.js preview».
test('repeated whitespace in the command line is normalised before matching markers', () => {
  const table = [
    { pid: 1, ppid: 0, comm: 'launchd', command: '/sbin/launchd' },
    { pid: 50, ppid: 1, comm: 'node', command: 'node   scripts/cli.js   preview  --project-dir   p' },
  ];
  const busy = busyRenders({ psImpl: fakePs(table), selfPids: [] });
  assert.deepEqual(busy.map((p) => p.pid), [50]);
  assert.equal(busy[0].command, 'node scripts/cli.js preview --project-dir p');
});

// Процесс пропал между первым снимком и пакетным запросом команд (гонка) — этот раунд просто без
// результата, а не падение всего вызова (следующий опрос — ещё через 30 с).
test('a pid that vanishes between the two ps calls is skipped, not thrown', () => {
  const table = [
    { pid: 1, ppid: 0, comm: 'launchd', command: '/sbin/launchd' },
    { pid: 60, ppid: 1, comm: 'node', command: 'node scripts/build.js v.mp4' },
  ];
  const vanishing = (args) => {
    if (args[0] === '-A') return table.map((p) => `${p.pid} ${p.ppid} ${p.comm}`).join('\n');
    throw new Error('ps: no such process (успел завершиться)');
  };
  assert.deepEqual(busyRenders({ psImpl: vanishing, selfPids: [] }), []);
});

test('waitUntilFree polls until the machine is free and times out with the blocking command', async () => {
  let calls = 0;
  const logs = [];
  await waitUntilFree({ busyImpl: () => (calls++ < 2 ? [{ pid: 1, command: 'render' }] : []), sleep: async () => {}, log: (m) => logs.push(m) });
  assert.equal(calls, 3);
  // Тот же pid оба раза занятости — лог печатается один раз (при смене занятого pid), не на каждый опрос.
  assert.equal(logs.length, 1);
  let t = 0;
  await assert.rejects(waitUntilFree({ busyImpl: () => [{ pid: 1, command: 'node render' }], sleep: async () => { t += 60_000; }, now: () => t, timeoutMs: 120_000, log: () => {} }),
    /машина занята дольше 2 мин: node render/);
});

// Ревью: лог не должен повторяться на каждый 30-секундный опрос, если занят тот же самый pid — только
// когда занятость сменилась на другой процесс. Плюс «полезный хвост» команды — без исполняемого файла.
test('waitUntilFree logs only when the blocking pid changes, showing the command tail without the executable', async () => {
  const sequence = [
    { pid: 42, command: 'node /opt/render/scripts/preview.js --project-dir p' },
    { pid: 42, command: 'node /opt/render/scripts/preview.js --project-dir p' },
    { pid: 43, command: 'node /opt/render/node_modules/@remotion/cli/remotion-cli.js render out.mp4' },
    null,
  ];
  let i = 0;
  const logs = [];
  await waitUntilFree({
    busyImpl: () => { const row = sequence[i++]; return row ? [row] : []; },
    sleep: async () => {},
    log: (m) => logs.push(m),
  });
  assert.deepEqual(logs, [
    '⏳ идёт другой рендер (pid 42: /opt/render/scripts/preview.js --project-dir p), жду 30 с…',
    '⏳ идёт другой рендер (pid 43: /opt/render/node_modules/@remotion/cli/remotion-cli.js render out.mp4), жду 30 с…',
  ]);
});

// По умолчанию (без переданного pollMs) sleep должен получать именно 30000, а не быть проигнорирован —
// mutant, зовущий sleep(0), тестами выше не ловится, потому что фейковый sleep не смотрит на аргумент.
test('waitUntilFree calls sleep with the real pollMs (30000 by default)', async () => {
  let calls = 0;
  const sleeps = [];
  await waitUntilFree({
    busyImpl: () => (calls++ < 1 ? [{ pid: 1, command: 'render' }] : []),
    sleep: async (ms) => sleeps.push(ms),
    log: () => {},
  });
  assert.deepEqual(sleeps, [30_000]);
});

// Порог таймаута — «>=», не «>»: рендер должен остановиться РОВНО на границе, без лишнего опроса.
test('waitUntilFree times out exactly at the timeout boundary (>=), not one poll later', async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(waitUntilFree({
    busyImpl: () => { calls += 1; return [{ pid: 1, command: 'node render' }]; },
    sleep: async (ms) => sleeps.push(ms),
    now: () => sleeps.length * 30_000,
    timeoutMs: 60_000,
    pollMs: 30_000,
    log: () => {},
  }), /машина занята дольше 1 мин: node render/);
  assert.equal(calls, 3);
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

// Не только Windows: если самой команды `ps` нет вовсе (ENOENT — редкий, но настоящий случай на POSIX
// в урезанном окружении), ведём себя так же — одна строка и старт без ожидания, а не падение.
test('no ps binary at all (ENOENT) is treated like win32: one warning line, then the render proceeds', async () => {
  const enoent = Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' });
  assert.throws(() => busyRenders({ psImpl: () => { throw enoent; } }), (error) => error.code === 'ENOENT');

  const logs = [];
  await waitUntilFree({
    busyImpl: () => { throw enoent; },
    log: (m) => logs.push(m),
    sleep: async () => { throw new Error('без ps не должны ждать — сразу старт'); },
  });
  assert.deepEqual(logs, ['проверка занятости недоступна: нет команды ps — рендер начнётся сразу']);
});

test('layer render command keeps the empty env-file first and never needs props', () => {
  const command = remotionLayerRenderCommand({ command: 'node', argsPrefix: ['cli.js', '--env-file=empty.env'] },
    { entry: 'layer/src/index.jsx', composition: 'Layer', output: 'out.mp4', publicDir: 'layer/public' });
  assert.deepEqual(command.args.slice(0, 5), ['cli.js', '--env-file=empty.env', 'render', 'layer/src/index.jsx', 'Layer']);
  assert.ok(command.args.includes('--public-dir'));
  assert.ok(!command.args.includes('--props'));
});

// POSIX-only дым-тест: настоящий busyRenders против настоящей таблицы процессов этой машины не должен
// падать — на Windows ps нет вовсе, там достаточно уже проверенной ветки platform === 'win32'.
test('the real busyRenders() runs against this machine\'s actual process table without throwing', { skip: process.platform === 'win32' }, () => {
  const result = busyRenders();
  assert.ok(Array.isArray(result));
});

// REMOTION_CLI анкорится на «@remotion/cli/<файл>» или «/.bin/remotion», затем необязательные флаги
// (--foo), затем именно «render» на границе слова — не «studio»/«still»/«preview» (алиасы v4), не
// «…/render-farm/…» (не начинается с якоря) и не «…-render-01.png» (после render нет пробела/конца).
test('REMOTION_CLI is anchored: catches .bin/remotion with flags before render, ignores render-farm paths and file names', () => {
  const table = [
    { pid: 1, ppid: 0, comm: 'launchd', command: '/sbin/launchd' },
    { pid: 70, ppid: 1, comm: 'node', command: 'node node_modules/.bin/remotion --log=verbose render src/index.ts Comp o.mp4' },
    { pid: 71, ppid: 1, comm: 'node', command: 'node node_modules/@remotion/cli/remotion-cli.js --env-file=x studio src/render.tsx' },
    { pid: 72, ppid: 1, comm: 'node', command: 'node node_modules/@remotion/cli/remotion-cli.js --env-file=x studio /work/render-farm/src/index.ts' },
    { pid: 73, ppid: 1, comm: 'node', command: 'node node_modules/@remotion/cli/remotion-cli.js --env-file=x still src/index.js Lesson /tmp/s.png' },
    { pid: 74, ppid: 1, comm: 'node', command: 'node node_modules/@remotion/cli/remotion-cli.js --env-file=x preview src/index.ts' },
    { pid: 75, ppid: 1, comm: 'node', command: 'node scripts/finish.js /tmp/render-01.png /tmp/out.mp4' },
  ];
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [] }).map((p) => p.pid), [70]);
});

// Remotion Studio v4 понимает «preview» как алиас «studio» (просто открывает интерактивный браузер,
// ничего не рендерит) — голый маркер 'cli.js preview' совпал бы с «remotion-cli.js preview» тоже,
// ложно считая Studio занятостью. Маркер сузили до 'scripts/cli.js preview' — только наша обёртка.
test('Remotion Studio\'s own "preview" subcommand (remotion-cli.js preview, v4 alias of studio) is never mistaken for automontage\'s own cli.js preview', () => {
  const table = [
    { pid: 1, ppid: 0, comm: 'launchd', command: '/sbin/launchd' },
    { pid: 65, ppid: 1, comm: 'node', command: 'node node_modules/@remotion/cli/remotion-cli.js preview src/index.ts' },
  ];
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [] }), []);
});

// «remotion render» без пути (глобальный `npm i -g @remotion/cli`, бинарь по имени в PATH) — маркер
// подстрокой, отдельно от анкорённого REMOTION_CLI (у него нет ни «@remotion/cli/», ни «/.bin/remotion»).
test('a global "remotion render" binary invocation (no @remotion/cli or .bin path) is still caught by the plain marker', () => {
  const table = [
    { pid: 1, ppid: 0, comm: 'launchd', command: '/sbin/launchd' },
    { pid: 80, ppid: 1, comm: 'node', command: 'node /usr/local/bin/remotion render src/index.js Comp out.mp4' },
  ];
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [] }).map((p) => p.pid), [80]);
});

// Review Workbench (npm run preview / кнопка preview) и motion-сборка — реальные рабочие процессы,
// не текст CLI-обёртки. --template больше не проверяется отдельно: любой такой запуск в конце концов
// доходит до дочернего scripts/build.js, который уже сам ловится маркером выше.
test('scripts/preview.js and scripts/motion/build.js workers count as busy', () => {
  const table = [
    { pid: 1, ppid: 0, comm: 'launchd', command: '/sbin/launchd' },
    { pid: 90, ppid: 1, comm: 'node', command: 'node scripts/preview.js --project-dir p --brief b --no-open' },
    { pid: 91, ppid: 1, comm: 'node', command: 'node scripts/motion/build.js --project x' },
    { pid: 92, ppid: 1, comm: 'node', command: 'node scripts/cli.js x.mp4 --template lesson' },
    { pid: 93, ppid: 92, comm: 'node', command: 'node scripts/build.js x.mp4 --template lesson' },
  ];
  assert.deepEqual(busyRenders({ psImpl: fakePs(table), selfPids: [] }).map((p) => p.pid), [90, 91, 93]);
});
