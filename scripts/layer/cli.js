// scripts/layer/cli.js — запускается из scripts/cli.js через `node`, поэтому без shebang
const USAGE = `usage: automontage layer new|words|check|render|import|brief|stock|sheet --project-dir <папка> [...]

  layer new    --project-dir P [--dir motion-v01] [--profile avatar|live]    слой из деталей motion-kit
  layer words  --project-dir P --layer motion-v01                             слова и написание заново
  layer check  --project-dir P --layer motion-v01 [--profile avatar|live]     гейты по плану, секунды
  layer render --project-dir P --layer motion-v01 [--no-wait]                 рендер слоя + гейты длины и звука
  layer import --project-dir P --file <motion-v01/renders/layer-01.mp4>       импорт проверенного слоя
  layer brief  --project-dir P --asset <assets/broll/video/…/media.mp4> --title T --head-cream C --head-orange O
               [--audio mix|mute] [--music <файл> --music-gain-db -16 --music-start-sec 0]
  layer stock  --project-dir P --layer motion-v01 --query "english" --query-original "фраза" [--sec 2.5] [--pick 1] [--list]
  layer sheet  --project-dir P                                                контакт-лист preview и кадры правок пульта`;

const COMMANDS = Object.freeze({
  new: './new', words: './words', check: './check', render: './render',
  import: './import', brief: './brief', stock: './stock', sheet: './sheet',
});

// check/render пишут qa-отчёт (`<проект>/qa/<имя>.json`) только когда сами дошли до его записи.
// Если роутер поймал исключение — значит отчёт не написан, и результат нельзя путать с честным
// «стоп» отчёта (код 1, см. scripts/qa/report.js exitCodeFor): это «оценить нельзя», код 2.
// У остальных команд отчёта нет вовсе, поэтому их ошибки остаются кодом 1.
const GATE_COMMANDS = new Set(['check', 'render']);

function parseArgs(argv, flags) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`лишний аргумент «${flag}»`);
    const eq = flag.indexOf('=');
    if (eq !== -1) {
      throw new Error(`пишите --${flag.slice(2, eq)} ${flag.slice(eq + 1)} (без =)`);
    }
    const key = flag.slice(2);
    if (!Object.hasOwn(flags, key)) throw new Error(`неизвестный флаг ${flag}`);
    if (Object.hasOwn(options, key)) throw new Error(`флаг ${flag} повторяется`);
    if (flags[key] === 'bool') {
      options[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`флаг ${flag} требует значение`);
    options[key] = value;
    i += 1;
  }
  return options;
}

// commands — необязательный override для тестов (передаёт абсолютный путь к тестовому модулю
// вместо реальной подкоманды из COMMANDS), продакшен всегда использует дефолт.
async function main(argv = process.argv.slice(2), { commands = COMMANDS } = {}) {
  // Ошибка plan.js покажет строку src/plan.js, а не строку бандла (Task 19).
  process.setSourceMapsEnabled(true);
  // --help/-h где угодно в argv — не только первым токеном: `layer new --project-dir p --help`
  // не должен требовать модуль new.js (пока не реализован) только чтобы показать помощь.
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const [command, ...rest] = argv;
  if (!command) {
    console.error(USAGE);
    return 1;
  }
  if (!Object.hasOwn(commands, command)) {
    console.error(`❌ неизвестная команда layer ${command}\n${USAGE}`);
    return 1;
  }
  try {
    const mod = require(commands[command]);
    const code = await mod.run(parseArgs(rest, mod.FLAGS));
    if (!Number.isInteger(code)) {
      throw new Error(`подкоманда вернула не код возврата: ${String(code)}`);
    }
    return code;
  } catch (error) {
    // error?.message ?? … переживает throw 'строка' и throw undefined — не только throw new Error.
    const message = error?.message ?? String(error);
    console.error(`❌ layer ${command} отменён: ${message}`);
    return GATE_COMMANDS.has(command) ? 2 : 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { USAGE, main, parseArgs };
