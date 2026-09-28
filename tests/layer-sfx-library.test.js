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

// Простой моно WAV 16 бит из сырых сэмплов — для случаев, где нужен БИТ-В-БИТ контроль над
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

// Отклонение (ревью, п.6): дефолтная папка (переменная не задана) вправе молча отсутствовать —
// это обычный клон без приватного пакета звуков. Но явная AUTOMONTAGE_SFX_DIR на несуществующую
// папку — это опечатка в пути, и она должна стать ошибкой сразу, а не тихим «звуков нет».
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
  assert.ok(Math.abs(sound.peakSec - 0.4) < 0.03, `peakSec=${sound.peakSec}`);
  assert.equal(sound.volume, 0.8);
  // Тест на «пустую копию» (мутант ревью out-empty-copy): роль правда сохраняется, а не только
  // заявлена в названии теста.
  assert.equal(sound.role, 'whoosh');
  const copied = path.join(target, 'whoosh-in.wav');
  assert.ok(fs.existsSync(copied));
  // Скопированные байты — точно исходные (мутант out-empty-copy: пустая/усечённая копия).
  assert.ok(fs.readFileSync(copied).equals(fs.readFileSync(source)), 'скопированный файл должен быть побайтовой копией исходника');
  // sha256 — настоящий хеш байт (мутант out-hash-name: не «похоже на хеш», а именно хеш ЭТОГО файла).
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
// выше ~4 кГц — антиалиасинг при передискретизации на 8 кГц режет именно то, что и есть сам «удар».
// Ниже — три конкретных случая реального пакета (impact-ring, click-подобные, противофазный
// стерео-свист), где старое измерение давало неверный peakSec, и новое (полная полоса 48 кГц,
// сумма МОЩНОСТЕЙ каналов, скользящее окно 30 мс/шаг 5 мс) — верный.
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

// Мутант ревью out-last-max: при точной ничьей окно должно взять ПЕРВОЕ (самое раннее) вхождение
// максимума, а не последнее — иначе повторяющийся по громкости звук (два одинаковых всплеска)
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
  placeAt(9600); // 0,2 с — истинный (первый) удар
  placeAt(38400); // 0,8 с — точная копия на той же сетке (28800 = 120×240)
  writeMonoWavInt16(path.join(lib, 'twin-peak.wav'), sr, samples);
  const { peakSec } = copySfxLibrary(lib, target).library.sounds['twin-peak'];
  assert.ok(peakSec < 0.5, `ожидали первый пик (~0,2 с) при ничьей, получили ${peakSec} — похоже на «последний максимум»`);
  assert.ok(Math.abs(peakSec - 0.2) < 0.05, `peakSec=${peakSec}`);
});

// Отклонение (п.1): необязательный ручной peakSec в library.json — автор точно знает, где удар
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

// Отклонение (п.3): опечатка вне ^[a-z0-9][a-z0-9-]*\.wav$ не копируется молча — она видна вызывающему
// коду (layer new предупредит), а дотфайлы (.DS_Store) и обычные папки — обычный «мусор» ОС и
// служебные подпапки, они не опечатка и не должны засорять skipped (п.4).
test('files that do not match the sound name pattern come back in skipped; dotfiles and folders are ignored silently', (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'Notes.txt'), 'не звук');
  fs.writeFileSync(path.join(lib, 'UPPER.WAV'), 'x');
  fs.writeFileSync(path.join(lib, '-leading-dash.wav'), 'x');
  fs.writeFileSync(path.join(lib, '.DS_Store'), '');
  fs.mkdirSync(path.join(lib, 'originals'));
  fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify({ sounds: {} }));
  const result = copySfxLibrary(lib, target);
  assert.deepEqual(result.skipped.sort(), ['-leading-dash.wav', 'Notes.txt', 'UPPER.WAV']);
  assert.deepEqual(result.library.sounds, {});
  assert.deepEqual(fs.readdirSync(target), []);
});

// Отклонение (п.4): `|` и переносы строк в license/sourceUrl ломают ячейку Markdown-таблицы
// SOURCE.md — экранируем `|` и схлопываем переносы в пробел, как в обычной таблице.
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

// Отклонение (п.2, п.6): library.json проходит через readJson (именованные ошибки) и валидируется —
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

// Отклонение (п.4): library.json может назвать звук, для которого нет файла (опечатка в ключе) —
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

// Отклонение (п.3): битая символическая ссылка и папка с именем *.wav — не звук; сообщение
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

// Отклонение (п.3): тишина или пустой поток — явная ошибка с именем файла, а не «пик на нулевой
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

// Отклонение (п.6): цель обязана оставаться в согласии с текущим набором звуков — старый *.wav,
// оставшийся от предыдущего запуска (сбой на середине, удалённый из library.json звук), должен
// исчезнуть, а не копиться в public/sfx слоя навсегда.
test('a stale *.wav already in the target from a previous run is cleared, not left behind', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'stale.wav'), 'старый мусор');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=0.2", path.join(lib, 'pop.wav')]);
  const result = copySfxLibrary(lib, target);
  assert.deepEqual(Object.keys(result.library.sounds), ['pop']);
  assert.deepEqual(fs.readdirSync(target).sort(), ['pop.wav']);
});
