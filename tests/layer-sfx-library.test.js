const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { copySfxLibrary, sfxLibraryDir } = require('../scripts/layer/sfx-library');

function tmpDirs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-lib-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, lib: path.join(root, 'lib'), target: path.join(root, 'layer', 'public', 'sfx') };
}

// Простой моно WAV 16 бит из сырых сэмплов – для случаев, где нужен БИТ-В-БИТ контроль над
// сигналом (тест на выбор ПЕРВОГО при точной ничьей), который выражения ffmpeg lavfi не гарантируют.
function writeMonoWavInt16(file, sampleRate, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(samples[i], 44 + i * 2);
  fs.writeFileSync(file, buf);
}

test('library dir comes from AUTOMONTAGE_SFX_DIR or the hidden projects/.library/sfx', () => {
  assert.equal(sfxLibraryDir({ AUTOMONTAGE_SFX_DIR: os.tmpdir() }), os.tmpdir());
  assert.match(sfxLibraryDir({}), /projects[\\/]\.library[\\/]sfx$/);
});

// Отклонение (ревью, п.6): дефолтная папка (переменная не задана) вправе молча отсутствовать –
// это обычный клон без приватного пакета звуков. Но явная AUTOMONTAGE_SFX_DIR на несуществующую
// папку – это опечатка в пути, и она должна стать ошибкой сразу, а не тихим «звуков нет».
test('an explicit AUTOMONTAGE_SFX_DIR pointing at a missing folder is an error; the default location may be absent silently', () => {
  const missing = path.join(os.tmpdir(), 'no-such-sfx-dir-xyz-123');
  fs.rmSync(missing, { recursive: true, force: true });
  assert.throws(() => sfxLibraryDir({ AUTOMONTAGE_SFX_DIR: missing }), /AUTOMONTAGE_SFX_DIR указывает на несуществующую папку/);
  assert.doesNotThrow(() => sfxLibraryDir({}));
});

test('copying measures length and a windowed peak, keeps role/volume, hashes and copies bytes exactly', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  const source = path.join(lib, 'whoosh-in.wav');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.9*sin(2*PI*600*t)*exp(-40*abs(t-0.4))':s=48000:d=1", source]);
  fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify({ license: 'Test license', sourceUrl: 'https://example.com/sfx',
    sounds: { 'whoosh-in': { volume: 0.8, role: 'whoosh' } } }));
  const result = copySfxLibrary(lib, target);
  const sound = result.library.sounds['whoosh-in'];
  assert.equal(sound.file, 'sfx/whoosh-in.wav');
  assert.ok(Math.abs(sound.lengthSec - 1) < 0.01);
  // ±0,01 с (не ±0,03) – узкий допуск нарочно: симметричная огибающая ловит мутанты, которые
  // считают пик от НАЧАЛА окна вместо его ЦЕНТРА («no window centring» – такой сдвиг был бы виден
  // сразу как половина ширины окна, 15 мс, а не тонет в широком допуске.
  assert.ok(Math.abs(sound.peakSec - 0.4) < 0.01, `peakSec=${sound.peakSec}`);
  assert.equal(sound.volume, 0.8);
  // Тест на «пустую копию» (мутант ревью out-empty-copy): роль правда сохраняется, а не только
  // заявлена в названии теста.
  assert.equal(sound.role, 'whoosh');
  const copied = path.join(target, 'whoosh-in.wav');
  assert.ok(fs.existsSync(copied));
  // Скопированные байты – точно исходные (мутант out-empty-copy: пустая/усечённая копия).
  assert.ok(fs.readFileSync(copied).equals(fs.readFileSync(source)), 'скопированный файл должен быть побайтовой копией исходника');
  // sha256 – настоящий хеш байт (мутант out-hash-name: не «похоже на хеш», а именно хеш ЭТОГО файла).
  assert.equal(sound.sha256, crypto.createHash('sha256').update(fs.readFileSync(copied)).digest('hex'));
  assert.match(result.sourceRows[0], /\| `sfx\/whoosh-in\.wav` \| Test license \| https:\/\/example\.com\/sfx \| [a-f0-9]{64} \|/);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.unknownMeta, []);
});

test('a missing library yields an empty sound set instead of an error', () => {
  const result = copySfxLibrary(path.join(os.tmpdir(), 'no-such-sfx-lib'), path.join(os.tmpdir(), 'unused'));
  assert.deepEqual(result.library, { sounds: {} });
  assert.deepEqual(result.sourceRows, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.unknownMeta, []);
});

// Отклонение (п.1, ВАЖНО): argmax одного сэмпла на 8 кГц моно (старое измерение) теряет удары
// выше ~4 кГц – антиалиасинг при передискретизации на 8 кГц режет именно то, что и есть сам «удар».
// Ниже – синтетические фикстуры (НЕ сам реальный пакет – тот только читается read-only отдельным
// разовым замером для отчёта), воспроизводящие паттерны, из-за которых старое измерение давало
// неверный peakSec на реальных impact-ring/click/стерео-свистах: тихий низкий предудар + громкое
// ВЧ-тело, щелчок перед телом звука, противофазный стерео. Новое измерение (полная полоса 48 кГц,
// сумма МОЩНОСТЕЙ каналов, скользящее окно 30 мс/шаг 5 мс) находит верный момент во всех трёх.
test('an impact-like sound (a quiet low pre-thump, then a loud high-frequency body) measures its peak on the loud body, not the early thump', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  const file = path.join(lib, 'impact-fx.wav');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*150*t)*exp(-30*t)':s=48000:d=0.8",
    '-f', 'lavfi', '-i', "aevalsrc='0.9*(random(0)*2-1)*exp(-80*abs(t-0.3))*gte(t,0.3)':s=48000:d=0.8",
    '-filter_complex', '[1:a]highpass=f=5000,highpass=f=5000,volume=3[h];[0:a][h]amix=inputs=2:normalize=0[a]',
    '-map', '[a]', file]);
  const { peakSec } = copySfxLibrary(lib, target).library.sounds['impact-fx'];
  assert.ok(Math.abs(peakSec - 0.3) < 0.05, `ожидали ~0.3 с (громкий ВЧ-«тук»), получили ${peakSec}`);
});

test('click-then-body: a 2 ms click is not louder in energy than the noisy body that follows it', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  const file = path.join(lib, 'click-then-body.wav');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.95*between(t,0.005,0.007)+0.6*(random(0)*2-1)*exp(-((t-0.5)^2)/(2*0.1^2))':s=48000:d=1.0", file]);
  const { peakSec } = copySfxLibrary(lib, target).library.sounds['click-then-body'];
  assert.ok(Math.abs(peakSec - 0.5) < 0.05, `ожидали ~0.5 с (тело звука), получили ${peakSec}`);
});

test('an anti-phase stereo whoosh is not cancelled by a naive downmix: the peak sums both channels\' power', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  const file = path.join(lib, 'stereo-wide.wav');
  const N = '(random(0)*2-1)';
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `aevalsrc='${N}*0.9*exp(-((t-0.6)^2)/(2*0.12^2))+0.3*between(t,0.05,0.052)|-0.95*${N}*0.9*exp(-((t-0.6)^2)/(2*0.12^2))+0.3*between(t,0.05,0.052)':c=stereo:s=48000:d=1.2`,
    file]);
  const { peakSec } = copySfxLibrary(lib, target).library.sounds['stereo-wide'];
  assert.ok(Math.abs(peakSec - 0.6) < 0.05, `ожидали ~0.6 с (свист по сумме мощностей), получили ${peakSec}`);
});

// Мутант «только левый канал»: если бы measure() суммировал мощность лишь channel 0, звук,
// существующий ЦЕЛИКОМ в правом канале (левый – полная тишина), измерился бы как беззвучный или
// нашёл бы пик по шуму квантования где угодно. Левый канал здесь буквально '0' (не тихий сигнал,
// а константный ноль), поэтому мутант не может случайно найти правильный ответ через утечку.
test('a whoosh present only in the right channel is still found (kills a "left channel only" measurement)', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  const file = path.join(lib, 'right-only.wav');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0|0.9*sin(2*PI*600*t)*exp(-40*abs(t-0.35))':c=stereo:s=48000:d=0.8", file]);
  const { peakSec } = copySfxLibrary(lib, target).library.sounds['right-only'];
  assert.ok(Math.abs(peakSec - 0.35) < 0.03, `ожидали ~0.35 с из правого канала, получили ${peakSec}`);
});

// Мутант ревью out-last-max: при точной ничьей окно должно взять ПЕРВОЕ (самое раннее) вхождение
// максимума, а не последнее – иначе повторяющийся по громкости звук (два одинаковых всплеска)
// «уезжает» на последний всплеск вместо настоящего первого удара. Сэмплы собраны вручную (Int16),
// чтобы обе вспышки были побитово идентичны на одной и той же сетке шага (hop=240=5 мс при 48 кГц).
test('the loudest window picks the first occurrence on an exact tie, never the last', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  const sr = 48000;
  const samples = new Int16Array(sr); // 1 с, тишина
  const burstLen = 240;
  const burst = new Int16Array(burstLen);
  for (let i = 0; i < burstLen; i += 1) burst[i] = Math.round(20000 * Math.sin((Math.PI * i) / burstLen));
  const placeAt = (start) => { for (let i = 0; i < burstLen; i += 1) samples[start + i] = burst[i]; };
  placeAt(9600); // 0,2 с – истинный (первый) удар
  placeAt(38400); // 0,8 с – точная копия на той же сетке (28800 = 120×240)
  writeMonoWavInt16(path.join(lib, 'twin-peak.wav'), sr, samples);
  const { peakSec } = copySfxLibrary(lib, target).library.sounds['twin-peak'];
  assert.ok(peakSec < 0.5, `ожидали первый пик (~0,2 с) при ничьей, получили ${peakSec} – похоже на «последний максимум»`);
  assert.ok(Math.abs(peakSec - 0.2) < 0.05, `peakSec=${peakSec}`);
});

// Отклонение (п.1): необязательный ручной peakSec в library.json – автор точно знает, где удар
// (или хочет его сдвинуть) и не обязан полагаться на автодетект.
test('an explicit peakSec in library.json overrides the measured one when it is a valid 0 ≤ peakSec < lengthSec', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.5*sin(2*PI*440*t)*exp(-40*abs(t-0.2))':s=48000:d=0.6", path.join(lib, 'click.wav')]);
  fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify({ sounds: { click: { peakSec: 0.01 } } }));
  const { peakSec } = copySfxLibrary(lib, target).library.sounds.click;
  assert.equal(peakSec, 0.01);
});

test('an explicit peakSec at or past lengthSec is a clear, named error', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=0.5", path.join(lib, 'click.wav')]);
  fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify({ sounds: { click: { peakSec: 0.5 } } }));
  assert.throws(() => copySfxLibrary(lib, target), /library\/sfx click\.wav.*sounds\.click\.peakSec.*lengthSec/s);
});

// Отклонение (ревью round 2, п.4): опечатка вне ^[a-z0-9][a-z0-9-]*\.wav$ не копируется молча – но
// в skipped попадают только файлы, ПОХОЖИЕ на звук (расширения .wav/.mp3/.flac/.aif/.aiff/.ogg/.m4a
// в любом регистре), которые не подошли под имя. Обычные файлы папки (Notes.txt, README.md,
// LICENSE) – не опечатка в имени звука, а нормальное содержимое папки, и не должны попадать в
// skipped вовсе; дотфайлы (.DS_Store) и обычные папки – обычный «мусор» ОС и служебные подпапки.
test('skipped only lists audio-looking near-misses; ordinary files, dotfiles and folders are ignored silently', (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'Notes.txt'), 'не звук');
  fs.writeFileSync(path.join(lib, 'README.md'), '# не звук');
  fs.writeFileSync(path.join(lib, 'LICENSE'), 'MIT');
  fs.writeFileSync(path.join(lib, 'UPPER.WAV'), 'x');
  fs.writeFileSync(path.join(lib, '-leading-dash.wav'), 'x');
  fs.writeFileSync(path.join(lib, 'take.MP3'), 'x');
  fs.writeFileSync(path.join(lib, '.DS_Store'), '');
  fs.mkdirSync(path.join(lib, 'originals'));
  fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify({ sounds: {} }));
  const result = copySfxLibrary(lib, target);
  assert.deepEqual(result.skipped.sort(), ['-leading-dash.wav', 'UPPER.WAV', 'take.MP3'].sort());
  assert.deepEqual(result.library.sounds, {});
  assert.deepEqual(fs.readdirSync(target), []);
});

// Отклонение (п.4): `|` и переносы строк в license/sourceUrl ломают ячейку Markdown-таблицы
// SOURCE.md – экранируем `|` и схлопываем переносы в пробел, как в обычной таблице.
test('a | or a newline in license or sourceUrl does not break the SOURCE.md table row', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=0.2", path.join(lib, 'click.wav')]);
  fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify({
    license: 'Attribution | required\nSee site', sourceUrl: 'https://example.com/a|b\nc', sounds: {},
  }));
  const [row] = copySfxLibrary(lib, target).sourceRows;
  assert.doesNotMatch(row, /\n/);
  assert.match(row, /Attribution \\\| required See site/);
  assert.match(row, /https:\/\/example\.com\/a\\\|b c/);
});

// Отклонение (п.2, п.6): library.json проходит через readJson (именованные ошибки) и валидируется –
// опечатка формы становится понятной русской ошибкой с именем звука, а не тихо испорченным
// src/sfx-library.js или невнятным исключением где-то ниже по пайплайну.
test('library.json is read with named errors and its shape is validated with clear Russian errors naming the sound', (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  const withMeta = (meta) => fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify(meta));

  fs.writeFileSync(path.join(lib, 'library.json'), '{ not json');
  assert.throws(() => copySfxLibrary(lib, target), /library\.json: неверный JSON/);

  withMeta({ sounds: [] });
  assert.throws(() => copySfxLibrary(lib, target), /library\.json → sounds должен быть объектом/);

  withMeta({ sounds: { 'ui-blip': 'громко' } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip должен быть объектом/);

  withMeta({ sounds: { 'ui-blip': { role: 5 } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.role должен быть строкой/);

  withMeta({ sounds: { 'ui-blip': { role: '' } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.role не может быть пустой строкой/);

  withMeta({ sounds: { 'ui-blip': { role: '   ' } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.role не может быть пустой строкой/);

  withMeta({ sounds: { 'ui-blip': { volume: 0 } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.volume должен быть числом в диапазоне \(0, 1\]/);

  withMeta({ sounds: { 'ui-blip': { volume: 1.5 } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.volume должен быть числом в диапазоне \(0, 1\]/);

  withMeta({ sounds: { 'ui-blip': { volume: '0.8' } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.volume должен быть числом в диапазоне \(0, 1\]/);

  withMeta({ sounds: { 'ui-blip': { notable: 'да' } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.notable должен быть true или false/);

  withMeta({ sounds: { 'ui-blip': { peakSec: -1 } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.peakSec должен быть числом ≥ 0/);

  withMeta({ sounds: { 'ui-blip': { peakSec: '0.1' } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.peakSec должен быть числом ≥ 0/);

  withMeta({ license: 123, sounds: {} });
  assert.throws(() => copySfxLibrary(lib, target), /library\.json → license должен быть строкой/);

  withMeta({ sourceUrl: ['a'], sounds: {} });
  assert.throws(() => copySfxLibrary(lib, target), /library\.json → sourceUrl должен быть строкой/);
});

// Отклонение (п.4): library.json может назвать звук, для которого нет файла (опечатка в ключе) –
// это должно быть видно вызывающему коду, а не молча остаться прочитанным и неиспользованным.
test('a library.json sound key with no matching wav comes back in unknownMeta, not silently ignored', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=0.2", path.join(lib, 'pop.wav')]);
  fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify({ sounds: { popp: { role: 'impact' } } }));
  const result = copySfxLibrary(lib, target);
  assert.deepEqual(result.unknownMeta, ['popp']);
  assert.equal('role' in result.library.sounds.pop, false, 'опечатка не должна была «подтянуться» к похожему имени');
});

// Отклонение (п.3): битая символическая ссылка и папка с именем *.wav – не звук; сообщение
// называет файл и по-русски объясняет причину, а не голый ENOENT/EISDIR из fs.
test('a dangling symlink named *.wav is rejected with a Russian message naming the file, nothing is left in target', (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  fs.symlinkSync(path.join(lib, 'missing-target.wav'), path.join(lib, 'dead.wav'));
  assert.throws(() => copySfxLibrary(lib, target), /library\/sfx dead\.wav: .*(символическ|ссылк)/i);
  assert.ok(!fs.existsSync(path.join(target, 'dead.wav')));
});

test('a directory named *.wav is rejected with a Russian message naming the file, nothing is left in target', (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(path.join(lib, 'folder.wav'));
  assert.throws(() => copySfxLibrary(lib, target), /library\/sfx folder\.wav: .*(папк|обычный файл)/i);
  assert.ok(!fs.existsSync(path.join(target, 'folder.wav')));
});

// Отклонение (п.3): тишина или пустой поток – явная ошибка с именем файла, а не «пик на нулевой
// секунде» без единого предупреждения (звук, который потом не будет слышно вообще).
test('a completely silent wav is a clear, named error, not a silent peakSec: 0', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'anullsrc=r=48000:cl=mono', '-t', '0.5', path.join(lib, 'silent.wav')]);
  assert.throws(() => copySfxLibrary(lib, target), /library\/sfx silent\.wav: .*беззвучн/);
  assert.ok(!fs.existsSync(path.join(target, 'silent.wav')));
});

test('a zero-length wav is a clear, named error naming the file', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'anullsrc=r=48000:cl=mono', '-t', '0.0001', path.join(lib, 'blank.wav')]);
  assert.throws(() => copySfxLibrary(lib, target), /library\/sfx blank\.wav: /);
  assert.ok(!fs.existsSync(path.join(target, 'blank.wav')));
});

// ============================================================================================
// КРИТИЧЕСКОЕ ревью round 2: прошлая версия «очищала» targetDir от старых *.wav перед копированием
// (см. git history) – а на любом пересечении путей library и target это стирало ЧУЖИЕ файлы:
// саму библиотеку (target === library, симлинк на неё, вариант по регистру на нечувствительной к
// регистру ФС, AUTOMONTAGE_SFX_DIR старого слоя, ре-синхронизированного в самого себя) или файлы
// пользователя (target – родитель библиотеки, или вовсе не та папка). Библиотека не в Git –
// потеря невосстановима. Вместо очистки copySfxLibrary теперь ОТКАЗЫВАЕТ на непустой targetDir:
// это закрывает все перечисленные пересечения разом (совпадающая папка непуста, если в библиотеке
// вообще есть файлы; библиотека ВНУТРИ target делает target непустым; target ВНУТРИ library
// безопасен, потому что папки при сканировании library пропускаются). Каждый тест ниже проверяет
// и отказ, и то, что состав и байты всех файлов не изменились.
function snapshotFiles(dir) {
  const map = new Map();
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) map.set(name, fs.readFileSync(full));
  }
  return map;
}
function assertFilesUnchanged(dir, before) {
  const after = snapshotFiles(dir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `состав файлов в ${dir} изменился`);
  for (const [name, buf] of before) {
    assert.ok(after.get(name)?.equals(buf), `${dir}/${name} изменился побайтово`);
  }
}
function genPop(dir, name = 'pop.wav') {
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=0.2", path.join(dir, name)]);
}
function isCaseInsensitiveFs(dir) {
  const lower = path.join(dir, 'case-probe-xyz');
  fs.writeFileSync(lower, '');
  const insensitive = fs.existsSync(path.join(dir, 'CASE-PROBE-XYZ'));
  fs.rmSync(lower, { force: true });
  return insensitive;
}

test('CRITICAL: refuses when the target equals the library – nothing in it is touched', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  genPop(lib);
  const before = snapshotFiles(lib);
  assert.throws(() => copySfxLibrary(lib, lib), /не пуста/);
  assertFilesUnchanged(lib, before);
});

test('CRITICAL: refuses when the target is a symlink to the library – nothing in it is touched', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { root, lib } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  genPop(lib);
  const link = path.join(root, 'link-to-lib');
  fs.symlinkSync(lib, link);
  const before = snapshotFiles(lib);
  assert.throws(() => copySfxLibrary(lib, link), /не пуста/);
  assertFilesUnchanged(lib, before);
});

test('CRITICAL: refuses when the target differs from the library only by case, on a case-insensitive filesystem', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { root, lib } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  if (!isCaseInsensitiveFs(root)) { t.skip('файловая система чувствительна к регистру – сценарий неприменим'); return; }
  genPop(lib);
  const caseVariantTarget = path.join(path.dirname(lib), path.basename(lib).toUpperCase());
  const before = snapshotFiles(lib);
  assert.throws(() => copySfxLibrary(lib, caseVariantTarget), /не пуста/);
  assertFilesUnchanged(lib, before);
});

test('CRITICAL: refuses when the target is the library\'s own parent folder – the user\'s own file next to it survives', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { root } = tmpDirs(t);
  const parent = path.join(root, 'parent');
  const lib = path.join(parent, 'sfx');
  fs.mkdirSync(lib, { recursive: true });
  genPop(lib);
  fs.writeFileSync(path.join(parent, 'my-own-recording.wav'), 'не трогать');
  const beforeParent = snapshotFiles(parent);
  const beforeLib = snapshotFiles(lib);
  assert.throws(() => copySfxLibrary(lib, parent), /не пуста/);
  assertFilesUnchanged(parent, beforeParent);
  assertFilesUnchanged(lib, beforeLib);
});

test('CRITICAL: refuses to copy into a non-empty user folder – podcast-master.WAV and voice take 3.wav are not touched', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { root, lib } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  genPop(lib);
  const music = path.join(root, 'Music');
  fs.mkdirSync(music, { recursive: true });
  fs.writeFileSync(path.join(music, 'podcast-master.WAV'), 'важная запись пользователя');
  fs.writeFileSync(path.join(music, 'voice take 3.wav'), 'другая запись пользователя');
  const before = snapshotFiles(music);
  assert.throws(() => copySfxLibrary(lib, music), /не пуста/);
  assertFilesUnchanged(music, before);
});

// Позитивный случай, чтобы отказ не был случайным «падает на всём»: НОВАЯ пустая (ещё
// не существующая) папка public/sfx слоя копируется как обычно, без единого предупреждения.
test('a fresh, not-yet-existing target still copies normally', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  genPop(lib);
  assert.ok(!fs.existsSync(target));
  const result = copySfxLibrary(lib, target);
  assert.deepEqual(Object.keys(result.library.sounds), ['pop']);
  assert.deepEqual(fs.readdirSync(target), ['pop.wav']);
});

// Правило «только пустая папка» закреплено с обеих сторон: любой файл (не только *.wav) – отказ,
// уже существующая, но пустая папка – обычное копирование.
test('a target holding only notes.txt is refused and the note is not touched', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  genPop(lib);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'notes.txt'), 'заметка пользователя');
  const before = snapshotFiles(target);
  assert.throws(() => copySfxLibrary(lib, target), /не пуста/);
  assertFilesUnchanged(target, before);
});

test('an existing empty target copies normally', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  genPop(lib);
  fs.mkdirSync(target, { recursive: true });
  const result = copySfxLibrary(lib, target);
  assert.deepEqual(Object.keys(result.library.sounds), ['pop']);
  assert.deepEqual(fs.readdirSync(target), ['pop.wav']);
});

test('a target path that is an existing file is a Russian error, not a raw EEXIST, and the file survives', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { root, lib } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  genPop(lib);
  const file = path.join(root, 'sfx');
  fs.writeFileSync(file, 'не папка');
  assert.throws(() => copySfxLibrary(lib, file), (error) => {
    assert.match(error.message, /папка звуков слоя .* – это файл/);
    assert.doesNotMatch(error.message, /EEXIST/);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), 'не папка');
});

// Гонка между проверкой пустоты и копированием: файл или символическая ссылка, появившиеся в target
// ПОСЛЕ проверки, не перезаписываются (COPYFILE_EXCL → EEXIST), а уборка не удаляет то, что создал не
// этот вызов. Момент «после проверки» воспроизводим подменой fs.readdirSync: настоящий ответ
// (пустой список) возвращается, а файл подкладывается сразу за ним.
function plantAfterEmptinessCheck(t, target, plant) {
  const original = fs.readdirSync;
  let planted = false;
  t.mock.method(fs, 'readdirSync', (dir, ...rest) => {
    const result = original.call(fs, dir, ...rest);
    if (!planted && path.resolve(String(dir)) === path.resolve(target)) {
      planted = true;
      plant();
    }
    return result;
  });
  return () => planted;
}

test('a file planted in the target after the emptiness check is not overwritten and not deleted', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  genPop(lib);
  const planted = plantAfterEmptinessCheck(t, target, () => fs.writeFileSync(path.join(target, 'pop.wav'), 'чужой файл'));
  assert.throws(() => copySfxLibrary(lib, target), /library\/sfx pop\.wav: .*уже (есть|появился)/);
  assert.ok(planted(), 'подмена сработала после проверки пустоты');
  assert.equal(fs.readFileSync(path.join(target, 'pop.wav'), 'utf8'), 'чужой файл');
});

test('a symlink planted in the target after the emptiness check is not followed: the file it points to is untouched', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { root, lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  genPop(lib);
  const outside = path.join(root, 'outside.wav');
  fs.writeFileSync(outside, 'файл вне слоя');
  const link = path.join(target, 'pop.wav');
  plantAfterEmptinessCheck(t, target, () => fs.symlinkSync(outside, link));
  assert.throws(() => copySfxLibrary(lib, target), /library\/sfx pop\.wav: .*уже (есть|появился)/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'файл вне слоя');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'чужую ссылку уборка не удаляет');
});

// Копия, оборвавшаяся не на EEXIST (например ENOSPC на середине), оставила бы в public/sfx половину
// звука: её убираем. Это всегда файл этого вызова – с COPYFILE_EXCL чужой файл дал бы EEXIST.
test('a copy that fails half-way (ENOSPC) leaves no partial sound in the target', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  genPop(lib);
  const original = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, destination, mode) => {
    if (path.dirname(path.resolve(String(destination))) !== path.resolve(target)) return original.call(fs, source, destination, mode);
    fs.writeFileSync(destination, 'половина звука');
    throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
  });
  assert.throws(() => copySfxLibrary(lib, target), /library\/sfx pop\.wav: ENOSPC/);
  assert.deepEqual(fs.readdirSync(target), []);
});
