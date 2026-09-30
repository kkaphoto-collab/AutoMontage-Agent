// Занятость машины – только по настоящим процессам node и их полной командной строке (не по тексту
// script-обёрток). knowledge/render-queue-pgrep-deadlock.md: `pgrep -f "remotion render"` однажды
// поймал zsh-обёртку, которая просто держала текст скрипта в своей командной строке – очереди ждали
// друг друга 4 часа. Здесь сначала берём только процессы, у которых сам исполняемый файл (`comm=`) –
// node, и лишь потом смотрим на их полную командную строку.
//
// Диагностика «на глаз», а не блокировка: между двумя проверками занятости два процесса могут увидеть
// свободную машину одновременно и оба начать рендер – файлового лока или другого взаимного исключения
// здесь нет. Более того, нормализация ffmpeg и декодирование PCM для G7 внутри `layer render` (уже
// после самого Remotion-рендера) не матчат ни один маркер и не попадают под REMOTION_CLI – свой же
// долгий хвост рендера другой процесс не увидит как занятость.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 'scripts/cli.js preview' – не голое 'cli.js preview': тот бы совпал и с «remotion-cli.js preview»,
// v4-алиасом Remotion Studio (ничего не рендерит, ложная занятость – ровно то, чего требует избегать
// «нет ложных срабатываний от … Studio …»).
// 'scripts/project/build-master.js' – automontage master: полное перекодирование исходника ffmpeg,
// такой же тяжёлый процесс, как рендер.
const MARKERS = ['remotion render', 'scripts/cli.js preview', 'scripts/build.js', 'scripts/preview.js', 'scripts/motion/build.js',
  'scripts/project/build-master.js'];
// «@remotion/cli/<файл>» ИЛИ «/.bin/remotion», затем любые токены, затем «render» отдельным словом
// (пробел до и пробел/конец строки после): не «studio»/«still»/«preview» (алиасы v4 studio), не
// «…/render-farm/…» и не «src/render.tsx» (перед «render» не пробел), не «…-render-01.png» и не
// «renderfoo». Любые токены, а не только «--флаги»: путь движка с пробелом («--env-file=…/my projects/…»)
// разрывал группу флагов, и настоящий рендер слоя не считался занятостью. Цена (редкая): если в пути
// движка есть « render » отдельным словом («…/my render tools/…» в --env-file), Studio и still этого
// движка тоже покажутся занятостью – ложное ожидание, а не пропущенный рендер.
const REMOTION_CLI = /(?:@remotion[\\/]cli[\\/]\S+|[\\/]\.bin[\\/]remotion)\s(?:.*\s)?render(?:\s|$)/u;
const defaultPs = (args) => execFileSync('ps', args, { encoding: 'utf8', shell: false });
// «--template» раньше ловился отдельной проверкой снаружи (scripts/cli.js + --template): это просто
// аргумент build.js (automontage <видео> --template lesson доходит до execFileSync с scripts/build.js),
// и его ребёнок scripts/build.js уже сам попадает под маркер выше. Отдельная проверка была лишней.

function parseTriples(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [pid, ppid, ...rest] = line.split(/\s+/u);
    return { pid: Number(pid), ppid: Number(ppid), comm: rest.join(' ') };
  });
}

// Цепочка предков текущего процесса от process.pid до 1 (launchd/init) по уже снятому снимку ps –
// без отдельного ps-вызова. Раньше «свои» pid были жёстко [process.pid, process.ppid]: если между
// automontage и слоем стоит ещё один узел-обёртка (например codex exec "…cli.js preview…" – дед
// процесса, текст промпта которого случайно совпал с маркером), layer render ждал бы собственного деда
// часами. Теперь исключается КАЖДЫЙ предок, а не только прямой родитель.
function ancestorChain(rows, pid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const chain = [];
  const seen = new Set();
  let current = pid;
  while (Number.isInteger(current) && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    if (current === 1) break;
    const row = byPid.get(current);
    if (!row) break; // процесс уже пропал из снимка – дальше цепочку не знаем, но что нашли – исключаем
    current = row.ppid;
  }
  return chain;
}

function parsePidCommand(line) {
  const match = /^(\d+)\s+(.*)$/u.exec(line.trim());
  return match ? { pid: Number(match[1]), command: match[2].replace(/\s+/gu, ' ') } : null;
}

// Два вызова ps на один опрос: (1) снимок ВСЕХ pid/ppid/comm – по нему строится цепочка предков и
// список node-кандидатов; (2) один пакетный запрос полных командных строк только этих кандидатов.
// Нарочно нет маркера для «automontage layer render» / «scripts/layer/cli.js render»: до того, как
// такой процесс сам дождался свободной машины и запустил настоящий Remotion, он – просто ждущий node,
// неотличимый по командной строке от другого такого же ждущего процесса. Если бы это считалось
// занятостью, два одновременно запущенных `automontage layer render` видели бы друг друга занятыми и
// ждали бы вечно – та же взаимная блокировка, что в knowledge/render-queue-pgrep-deadlock.md, только на
// этом модуле вместо pgrep -f. Настоящий рендер слоя всё равно ловит REMOTION_CLI ниже, когда он
// реально стартует.
function busyRenders({ psImpl = defaultPs, selfPids = null, platform = process.platform } = {}) {
  if (platform === 'win32') return []; // на Windows нет `ps` – не подключаем ради этого wmic/tasklist
  const rows = parseTriples(psImpl(['-A', '-o', 'pid=,ppid=,comm=']));
  const excluded = selfPids || ancestorChain(rows, process.pid);
  const nodePids = rows
    .filter((r) => path.basename(r.comm) === 'node' && !excluded.includes(r.pid))
    .map((r) => r.pid);
  if (!nodePids.length) return [];
  let lines;
  try {
    lines = psImpl(['-o', 'pid=,command=', '-p', nodePids.join(',')]).split('\n');
  } catch (_) {
    return []; // список пропал между двумя снимками (гонка) – этот раунд без результата, опрос повторится
  }
  const busy = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const parsed = parsePidCommand(raw);
    if (!parsed) continue;
    if (MARKERS.some((m) => parsed.command.includes(m)) || REMOTION_CLI.test(parsed.command)) {
      busy.push({ pid: parsed.pid, command: parsed.command }); // полная строка; укорачивает только показ
    }
  }
  return busy;
}

// Для человека (лог ожидания и текст таймаута): без ведущего исполняемого файла – пользователю полезен
// хвост («scripts/preview.js --project-dir p»), а не путь до node; длинный хвост – последние 160
// символов, там имя скрипта, проект и выходной файл.
const SHOWN_CHARS = 160;
function shownCommand(command) {
  const match = /^\S+\s+(.*)$/u.exec(command);
  const tail = match ? match[1] : command;
  return tail.length > SHOWN_CHARS ? `…${tail.slice(-SHOWN_CHARS)}` : tail;
}

async function waitUntilFree({
  busyImpl = busyRenders,
  pollMs = 30_000,
  timeoutMs = 3 * 3600_000,
  log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  platform = process.platform,
} = {}) {
  if (platform === 'win32') {
    log('проверка занятости машины недоступна на Windows – рендер начнётся сразу');
    return;
  }
  const started = now();
  let lastLoggedPid = null;
  for (;;) {
    let busy;
    try {
      busy = busyImpl();
    } catch (error) {
      if (error?.code === 'ENOENT') {
        log('проверка занятости недоступна: нет команды ps – рендер начнётся сразу');
        return;
      }
      throw error;
    }
    if (!busy.length) return;
    if (now() - started >= timeoutMs) {
      throw new Error(`машина занята дольше ${Math.round(timeoutMs / 60_000)} мин: ${shownCommand(busy[0].command)}`);
    }
    if (busy[0].pid !== lastLoggedPid) {
      lastLoggedPid = busy[0].pid;
      log(`⏳ идёт другой рендер (pid ${busy[0].pid}: ${shownCommand(busy[0].command)}), жду ${Math.round(pollMs / 1000)} с…`);
    }
    await sleep(pollMs);
  }
}

module.exports = { busyRenders, waitUntilFree };
