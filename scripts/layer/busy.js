// Занятость машины — только по настоящим процессам node (shell-обёртки с текстом скрипта не в счёт).
// knowledge/render-queue-pgrep-deadlock.md: `pgrep -f "remotion render"` однажды поймал zsh-обёртку,
// которая просто держала текст скрипта в своей командной строке — очереди ждали друг друга 4 часа.
// Здесь сначала берём только процессы, у которых сам исполняемый файл (`comm=`) — node, и лишь потом
// смотрим на их полную командную строку.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MARKERS = ['remotion render', 'remotion/cli.js render', 'cli.js preview', 'scripts/build.js'];
const REMOTION_CLI = /@remotion[\\/]cli[\\/]\S*\s.*\brender\b/u;
const defaultPs = (args) => execFileSync('ps', args, { encoding: 'utf8', shell: false });

// Нарочно нет маркера для «automontage layer render» / «scripts/layer/cli.js render»: до того, как
// такой процесс сам дождался свободной машины и запустил настоящий Remotion, он — просто ждущий node,
// неотличимый по командной строке от другого такого же ждущего процесса. Если бы это считалось
// занятостью, два одновременно запущенных `automontage layer render` видели бы друг друга занятыми и
// ждали бы вечно — та же взаимная блокировка, что в knowledge/render-queue-pgrep-deadlock.md, только на
// этом модуле вместо pgrep -f. Настоящий рендер слоя всё равно ловит REMOTION_CLI ниже, когда он
// реально стартует.
function busyRenders({ psImpl = defaultPs, selfPids = [process.pid, process.ppid], platform = process.platform } = {}) {
  if (platform === 'win32') return []; // на Windows нет `ps` — не подключаем ради этого wmic/tasklist
  const nodes = psImpl(['-ax', '-o', 'pid=,comm='])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split(/\s+/u);
      return { pid: Number(pid), comm: rest.join(' ') };
    })
    .filter((p) => path.basename(p.comm) === 'node' && !selfPids.includes(p.pid));
  const busy = [];
  for (const p of nodes) {
    let command;
    try {
      command = psImpl(['-o', 'command=', '-p', String(p.pid)]).trim().replace(/\s+/gu, ' ');
    } catch (_) {
      continue; // процесс успел завершиться между двумя вызовами ps — не в счёт
    }
    if (MARKERS.some((m) => command.includes(m)) || REMOTION_CLI.test(command)
      || (command.includes('scripts/cli.js') && command.includes('--template'))) {
      busy.push({ pid: p.pid, command: command.slice(0, 160) });
    }
  }
  return busy;
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
    log('проверка занятости машины недоступна на Windows — рендер начнётся сразу');
    return;
  }
  const started = now();
  for (;;) {
    const busy = busyImpl();
    if (!busy.length) return;
    if (now() - started >= timeoutMs) {
      throw new Error(`машина занята дольше ${Math.round(timeoutMs / 60_000)} мин: ${busy[0].command}`);
    }
    log(`⏳ идёт другой рендер (pid ${busy[0].pid}), жду ${Math.round(pollMs / 1000)} с…`);
    await sleep(pollMs);
  }
}

module.exports = { busyRenders, waitUntilFree };
