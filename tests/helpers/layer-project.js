// Маленький проект движка для тестов команд `automontage layer`: исходник lavfi 540×960/25 fps с
// голосоподобным звуком и транскрипт (слово каждые 0,5 с, первое — «Привет,»).
// 540×960 — половина рабочего кадра: анимации kit заданы в пикселях кадра 1080×1920 и в совсем
// крошечном кадре честно вылетали бы за safe-зону.
//
//   const { root, projectDir, workspace, sfxDir } = makeLayerProject(t, { seconds = 6, size = '540x960' });
//
// Необязательные особые исходники (по умолчанию — обычный 25 fps, звук той же длины, без поворота):
// fps (число или '30000/1001'), audioSeconds (звук длиннее видео), rotation (90/270 — телефонный
// .mov с матрицей поворота: кадр хранится size, показывается повёрнутым).
//
// root       — временная папка теста (удаляется в t.after), в ней source.mp4 и projects/kit-fixture;
// projectDir — папка проекта с project.json, input/source.mp4 и transcript/words.json;
// sfxDir     — уже созданная ПУСТАЯ папка библиотеки звуков <projectDir>/no-library. Тест ставит
//              process.env.AUTOMONTAGE_SFX_DIR = sfxDir (и убирает в t.after): явная переменная на
//              несуществующую папку — ошибка sfxLibraryDir, а без переменной layer new взял бы
//              настоящую локальную библиотеку машины.
// Геометрия исходника задаётся только здесь (size); фальшивые рендеры слоя берут ту же 540×960.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrOpenProject } = require('../../scripts/project/workspace');
const { runTool } = require('./media-fixtures');

function makeLayerProject(t, { seconds = 6, size = '540x960', fps = 25, audioSeconds = seconds, rotation = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const encoded = path.join(root, rotation ? 'encoded.mov' : 'source.mp4');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${fps}:d=${seconds}`,
    '-f', 'lavfi', '-i', `aevalsrc='0.4*sin(2*PI*220*t)*gt(sin(2*PI*1.3*t),0)':s=48000:d=${audioSeconds}`,
    ...(audioSeconds > seconds ? [] : ['-shortest']), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', encoded]);
  let source = encoded;
  if (rotation) {
    source = path.join(root, 'source.mov');
    runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation', String(rotation), '-i', encoded, '-c', 'copy', source]);
  }
  const projectDir = path.join(root, 'projects', 'kit-fixture');
  const workspace = createOrOpenProject({ projectDir, name: 'kit fixture', sourcePath: source });
  const words = Array.from({ length: Math.floor(seconds * 2) - 1 }, (_, i) => ({ w: i === 0 ? ' Привет,' : ` слово${i}`, s: i * 0.5, e: i * 0.5 + 0.4 }));
  fs.mkdirSync(path.join(projectDir, 'transcript'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, workspace.manifest.transcript.words), JSON.stringify([{ start: 0, end: seconds, text: '', words }]));
  const sfxDir = path.join(projectDir, 'no-library');
  fs.mkdirSync(sfxDir);
  return { root, projectDir, workspace, sfxDir };
}

module.exports = { makeLayerProject };
