const fs = require('node:fs');
const path = require('node:path');
const { probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { LAYER_NAME, nextLayerName, projectFrom, writeJson } = require('./common');
const { copySfxLibrary, sfxLibraryDir } = require('./sfx-library');
const { transcriptPath, writeLayerWords } = require('./words');

const FLAGS = { 'project-dir': 'value', dir: 'value', profile: 'value' };
const PROFILES = ['avatar', 'live'];
const ENGINE_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE = path.join(ENGINE_ROOT, 'templates', 'motion-layer');
const TEMPLATE_FILES = ['src/index.jsx', 'src/Root.jsx', 'src/plan.js', 'src/scenes.jsx', 'README.md'];
// Шрифты, которые выбирает scenes.jsx шаблона (FONTS), и их лицензии OFL.
const FONTS = ['Onest.ttf', 'OFL-Onest.txt', 'Oswald.ttf', 'OFL-Oswald.txt'];
// Папка слоя свежая: копия поверх уже лежащего файла — ошибка, а не тихая перезапись.
const { COPYFILE_EXCL, COPYFILE_FICLONE } = fs.constants;

// Папка слоя занимается одним mkdir без recursive (родитель — папка проекта — уже есть): из двух
// одновременных `layer new` её получает ровно один, второй видит EEXIST. Автоматическое имя при
// гонке пересчитывается один раз (max+1 уже учтёт чужую папку); явное --dir другим не подменяется.
// Имя — motion-vNN без разделителей, поэтому mkdir не выходит за папку проекта.
function claimLayerDir(projectDir, requested) {
  const attempts = requested ? 1 : 2;
  for (let attempt = 1; ; attempt += 1) {
    const name = requested || nextLayerName(projectDir);
    const layerDir = path.join(projectDir, name);
    try {
      fs.mkdirSync(layerDir);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt >= attempts) throw new Error(`папка ${name} уже существует — выберите другую через --dir`);
      continue;
    }
    const { dev, ino } = fs.lstatSync(layerDir);
    return { name, layerDir, identity: { dev, ino } };
  }
}

// Уборка после отказа: удаляется только папка, которую занял этот запуск (та же dev/ino), вместе с
// тем, что он в неё успел положить. Если на её месте уже другая папка — не трогаем ничего.
function releaseLayerDir({ name, layerDir, identity }, error) {
  const message = error?.message ?? String(error);
  const current = fs.lstatSync(layerDir, { throwIfNoEntry: false });
  if (!current || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
    return current ? new Error(`${message} (папку ${name} подменили во время layer new — не удаляю её)`, { cause: error }) : error;
  }
  try {
    fs.rmSync(layerDir, { recursive: true, force: true });
  } catch (cleanupError) {
    return new Error(`${message} (не удалось убрать недособранную папку ${name}: ${cleanupError.message})`, { cause: error });
  }
  return error;
}

function copyTemplate(layerDir) {
  for (const file of TEMPLATE_FILES) {
    fs.mkdirSync(path.dirname(path.join(layerDir, file)), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATE, file), path.join(layerDir, file), COPYFILE_EXCL);
  }
}

function placeholders(layerDir, { width, height, fps }, runToolImpl) {
  const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];
  fs.mkdirSync(path.join(layerDir, 'public', 'stock'), { recursive: true });
  fs.mkdirSync(path.join(layerDir, 'public', 'shots'), { recursive: true });
  runToolImpl('ffmpeg', [...quiet, '-f', 'lavfi', '-i', `gradients=s=${width}x${height}:r=${fps}:d=4:speed=0.03`,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(layerDir, 'public', 'stock', 'placeholder.mp4')], { stage: 'layer placeholder stock' });
  runToolImpl('ffmpeg', [...quiet, '-f', 'lavfi', '-i', 'color=c=0xF4F6FA:s=1080x2400',
    '-vf', 'drawbox=x=60:y=60:w=960:h=140:color=0xDDE3EC:t=fill,drawbox=x=60:y=260:w=640:h=60:color=0xC7D0DC:t=fill,drawbox=x=60:y=380:w=960:h=900:color=0xE7ECF3:t=fill',
    '-frames:v', '1', path.join(layerDir, 'public', 'shots', 'placeholder.png')], { stage: 'layer placeholder screenshot' });
}

// Всё содержимое свежей папки слоя. Любой отказ здесь — и run() убирает папку целиком.
function scaffold({ projectDir, manifest, sourcePath, layerDir, probe, durationInFrames, profile, libraryDir, runToolImpl }) {
  fs.mkdirSync(path.join(layerDir, 'public', 'fonts'), { recursive: true });
  copyTemplate(layerDir);
  writeJson(path.join(layerDir, 'layer.json'), {
    version: 1, composition: 'Layer', fps: probe.fps, width: probe.width, height: probe.height, durationInFrames,
    // В project.json точки лица нет — стартовая точка по умолчанию, агент уточняет её в layer.json.
    face: { x: Math.round(probe.width * 0.5), y: Math.round(probe.height * 0.41) },
    profile, sfxMasterDb: -5, speaker: { src: 'speaker.mp4', lastFrame: durationInFrames - 1 },
  });
  writeJson(path.join(layerDir, 'spelling.json'), {});
  writeLayerWords(projectDir, manifest, layerDir);
  fs.copyFileSync(sourcePath, path.join(layerDir, 'public', 'speaker.mp4'), COPYFILE_EXCL | COPYFILE_FICLONE);
  for (const font of FONTS) {
    fs.copyFileSync(path.join(ENGINE_ROOT, 'public', 'fonts', font), path.join(layerDir, 'public', 'fonts', font), COPYFILE_EXCL);
  }
  const sfx = copySfxLibrary(libraryDir, path.join(layerDir, 'public', 'sfx'));
  fs.writeFileSync(path.join(layerDir, 'src', 'sfx-library.js'), `// Сгенерировано automontage layer new.\nexport default ${JSON.stringify(sfx.library)};\n`);
  placeholders(layerDir, probe, runToolImpl);
  fs.writeFileSync(path.join(layerDir, 'public', 'SOURCE.md'), [
    '# Источники материалов слоя', '',
    '| Файл | Лицензия / автор | Источник | SHA-256 или команда |', '|---|---|---|---|',
    `| \`speaker.mp4\` | исходник проекта | \`${manifest.source.localPath}\` | копия исходника |`,
    '| `fonts/Onest.ttf`, `fonts/Oswald.ttf` | SIL OFL 1.1 (`fonts/OFL-*.txt`) | Google Fonts | копия из движка |',
    ...sfx.sourceRows,
    '| `stock/placeholder.mp4`, `shots/placeholder.png` | заглушки, заменить | ffmpeg lavfi | automontage layer new |', '',
  ].join('\n'));
  return sfx;
}

async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const warn = deps.warn || console.warn;
  const runToolImpl = deps.runToolImpl || runTool;
  const { projectDir, manifest, sourcePath } = projectFrom(options);
  if (options.dir !== undefined && !LAYER_NAME.test(options.dir)) throw new Error('--dir должен быть вида motion-v01');
  const profile = options.profile || 'avatar';
  if (!PROFILES.includes(profile)) throw new Error('--profile: avatar или live');
  // Всё, что может отказать без записи, — до захвата папки: путь к звукам, транскрипт, геометрия исходника.
  const libraryDir = sfxLibraryDir(deps.env || process.env);
  transcriptPath(projectDir, manifest);
  const probe = probeVideo(sourcePath);
  const durationInFrames = Math.round(probe.duration * probe.fps);
  if (!(durationInFrames >= 1)) throw new Error(`исходник короче одного кадра (${probe.duration} с при ${probe.fps} fps)`);

  const claim = claimLayerDir(projectDir, options.dir);
  let sfx;
  try {
    sfx = scaffold({ projectDir, manifest, sourcePath, layerDir: claim.layerDir, probe, durationInFrames, profile, libraryDir, runToolImpl });
  } catch (error) {
    throw releaseLayerDir(claim, error);
  }
  const { name } = claim;
  if (sfx.skipped.length) {
    warn(`⚠️ не скопированы из библиотеки звуков (имя не вида pop-soft.wav): ${sfx.skipped.join(', ')}`);
  }
  if (sfx.unknownMeta.length) {
    warn(`⚠️ library.json описывает звуки без файла в библиотеке: ${sfx.unknownMeta.join(', ')}`);
  }
  log(`✅ слой ${name}: ${durationInFrames} кадров ${probe.width}×${probe.height}@${probe.fps}, звуков в библиотеке: ${Object.keys(sfx.library.sounds).length}`);
  log(`Дальше: правка ${name}/src/plan.js → automontage layer check --project-dir "${projectDir}" --layer ${name}`);
  return 0;
}

module.exports = { FLAGS, run };
