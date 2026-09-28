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

function parseArgs(argv, flags) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`лишний аргумент «${flag}»`);
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

async function main(argv = process.argv.slice(2)) {
  // Ошибка plan.js покажет строку src/plan.js, а не строку бандла (Task 19).
  process.setSourceMapsEnabled(true);
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (!command) {
    console.error(USAGE);
    return 1;
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    console.error(`❌ неизвестная команда layer ${command}\n${USAGE}`);
    return 1;
  }
  try {
    const mod = require(COMMANDS[command]);
    return await mod.run(parseArgs(rest, mod.FLAGS));
  } catch (error) {
    console.error(`❌ layer ${command} отменён: ${error.message}`);
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { USAGE, main, parseArgs };
