const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { copySfxLibrary, sfxLibraryDir } = require('../scripts/layer/sfx-library');

function tmpDirs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-lib-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { lib: path.join(root, 'lib'), target: path.join(root, 'layer', 'public', 'sfx') };
}

test('library dir comes from AUTOMONTAGE_SFX_DIR or the hidden projects/.library/sfx', () => {
  assert.equal(sfxLibraryDir({ AUTOMONTAGE_SFX_DIR: '/x/sfx' }), '/x/sfx');
  assert.match(sfxLibraryDir({}), /projects[\\/]\.library[\\/]sfx$/);
});

test('copying measures length, peak and hash, keeps roles and writes provenance rows', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.9*sin(2*PI*600*t)*exp(-40*abs(t-0.4))':s=48000:d=1", path.join(lib, 'whoosh-in.wav')]);
  fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify({ license: 'Test license', sourceUrl: 'https://example.com/sfx',
    sounds: { 'whoosh-in': { volume: 0.8 } } }));
  const result = copySfxLibrary(lib, target);
  const sound = result.library.sounds['whoosh-in'];
  assert.equal(sound.file, 'sfx/whoosh-in.wav');
  assert.ok(Math.abs(sound.lengthSec - 1) < 0.01);
  assert.ok(Math.abs(sound.peakSec - 0.4) < 0.02);
  assert.equal(sound.volume, 0.8);
  assert.match(sound.sha256, /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(path.join(target, 'whoosh-in.wav')));
  assert.match(result.sourceRows[0], /\| `sfx\/whoosh-in\.wav` \| Test license \| https:\/\/example\.com\/sfx \| [a-f0-9]{64} \|/);
  assert.deepEqual(result.skipped, []);
});

test('a missing library yields an empty sound set instead of an error', () => {
  const result = copySfxLibrary(path.join(os.tmpdir(), 'no-such-sfx-lib'), path.join(os.tmpdir(), 'unused'));
  assert.deepEqual(result.library, { sounds: {} });
  assert.deepEqual(result.sourceRows, []);
  assert.deepEqual(result.skipped, []);
});

// Отклонение от плана (оркестратор, п.1): library.json может пометить звук заметным (notable)
// независимо от роли — resolveSound/sfxFromItems в src/motion-kit/sfx.js читают именно это поле
// (tests/motion-kit-sfx.test.js проверяет применение внутри kit). Здесь — что поле доходит из
// library.json до src/sfx-library.js слоя без искажений и не появляется, если не было задано.
test('a notable field in library.json is copied through to the layer library; absent stays absent', { skip: !toolAvailable('ffmpeg') }, (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  const gen = (name, freq) => runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `aevalsrc='0.5*sin(2*PI*${freq}*t)':s=48000:d=0.3`, path.join(lib, name)]);
  gen('ui-select.wav', 900);
  gen('whoosh-quiet.wav', 300);
  gen('pop-plain.wav', 500);
  fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify({ sounds: {
    'ui-select': { role: 'ui', notable: true },
    'whoosh-quiet': { notable: false },
    // pop-plain: без notable в library.json — поле не должно появиться в выходе.
  } }));
  const { sounds } = copySfxLibrary(lib, target).library;
  assert.equal(sounds['ui-select'].notable, true);
  assert.equal(sounds['whoosh-quiet'].notable, false);
  assert.equal('notable' in sounds['pop-plain'], false);
});

// Отклонение (п.3): файл с именем вне ^[a-z0-9][a-z0-9-]*\.wav$ не копируется молча — он должен
// быть виден вызывающему коду (layer new предупредит об опечатке), а не просто отсутствовать в
// библиотеке без единого следа. Ни один из этих файлов не требует ffmpeg: они отсеиваются по
// имени до попытки что-либо декодировать.
test('files that do not match the sound name pattern come back in skipped, not silently ignored', (t) => {
  const { lib, target } = tmpDirs(t);
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'Notes.txt'), 'не звук');
  fs.writeFileSync(path.join(lib, 'UPPER.WAV'), 'x');
  fs.writeFileSync(path.join(lib, '-leading-dash.wav'), 'x');
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

// Отклонение (п.2): library.json проходит через readJson (именованные ошибки) и валидируется —
// опечатка формы должна стать понятной русской ошибкой с именем звука, а не тихо испорченным
// src/sfx-library.js или невнятным исключением парсера/undefined где-то ниже по пайплайну.
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

  withMeta({ sounds: { 'ui-blip': { volume: 0 } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.volume должен быть числом в диапазоне \(0, 1\]/);

  withMeta({ sounds: { 'ui-blip': { volume: 1.5 } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.volume должен быть числом в диапазоне \(0, 1\]/);

  withMeta({ sounds: { 'ui-blip': { volume: '0.8' } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.volume должен быть числом в диапазоне \(0, 1\]/);

  withMeta({ sounds: { 'ui-blip': { notable: 'да' } } });
  assert.throws(() => copySfxLibrary(lib, target), /sounds\.ui-blip\.notable должен быть true или false/);
});
