const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { probeVideo } = require('../scripts/media-probe');
const { failure } = require('../scripts/broll/remote');
const { hashFile } = require('../scripts/pult/files');
const newLayer = require('../scripts/layer/new');
const stock = require('../scripts/layer/stock');

// Сеть в тестах не трогаем: поиск (createProvider) и скачивание (request) — подмены; root: null — не читать
// .env движка (на машине разработчика в нём может лежать настоящий PEXELS_API_KEY).
const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const KEY = 'not-a-real-key';
const candidate = { providerAssetId: '12345', sourcePage: 'https://www.pexels.com/video/12345/', author: { name: 'Автор', url: 'https://www.pexels.com/@a' },
  license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' }, width: 1080, height: 1920, durationSec: 8,
  downloadUrl: 'https://videos.pexels.com/video-files/12345/a.mp4', queryOriginal: 'люди за ноутбуком', queryEnglish: 'people laptop', retrievedAt: '2026-01-01T00:00:00.000Z' };

async function scaffold(t) {
  const project = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = project.sfxDir;
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  await newLayer.run({ 'project-dir': project.projectDir }, { log: () => {}, warn: () => {} });
  const downloaded = path.join(project.root, 'download.mp4');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=4',
    '-f', 'lavfi', '-i', 'sine=duration=4', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', downloaded]);
  const layerDir = path.join(project.projectDir, 'motion-v01');
  const out = [];
  const deps = (extra = {}) => ({ env: { PEXELS_API_KEY: KEY }, root: null, log: (line) => out.push(String(line)),
    createProvider: () => ({ search: async () => ({ candidates: [candidate] }) }),
    request: async () => ({ bytes: fs.readFileSync(downloaded), contentType: 'video/mp4' }), ...extra });
  const runStock = (options = {}, extra = {}) => stock.run({ 'project-dir': project.projectDir, layer: 'motion-v01', query: 'people laptop', ...options }, deps(extra));
  const clip = path.join(layerDir, 'public', 'stock', 'pexels-12345.mp4');
  const sourceMd = () => fs.readFileSync(path.join(layerDir, 'public', 'SOURCE.md'), 'utf8');
  const leftovers = () => (fs.existsSync(path.join(layerDir, 'out')) ? fs.readdirSync(path.join(layerDir, 'out')) : []);
  return { ...project, layerDir, downloaded, out, deps, runStock, clip, sourceMd, leftovers };
}

test('without PEXELS_API_KEY the command explains that stock search is optional', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir } = await scaffold(t);
  const before = fs.readFileSync(path.join(layerDir, 'public', 'SOURCE.md'), 'utf8');
  await assert.rejects(stock.run({ 'project-dir': projectDir, layer: 'motion-v01', query: 'people laptop', insert: 'stock-1' }, { env: {}, root: null }),
    (error) => {
      assert.match(error.message, /PEXELS_API_KEY не задан/);
      assert.match(error.message, /необязател/);
      // Как обойтись без ключа: свой клип в public/stock/ и строка источника в SOURCE.md, длина — по вставке.
      assert.match(error.message, /public\/stock\//);
      assert.match(error.message, /SOURCE\.md/);
      assert.match(error.message, /не короче 2 с/);
      return true;
    });
  assert.equal(fs.readFileSync(path.join(layerDir, 'public', 'SOURCE.md'), 'utf8'), before);
});

test('a picked Pexels clip is cropped to the layer, muted and recorded with its provenance', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip, sourceMd, downloaded, leftovers } = await scaffold(t);
  let providerConfig;
  const extra = {
    createProvider: (config) => { providerConfig = config; return { search: async (input) => {
      assert.equal(input.orientation, 'portrait');
      assert.equal(input.mediaKind, 'video');
      assert.equal(input.queryEnglish, 'people laptop');
      assert.equal(input.queryOriginal, 'люди за ноутбуком');
      assert.equal(input.minDurationSec, 2);
      return { candidates: [candidate] };
    } }; },
    request: async (req) => {
      assert.equal(req.url, candidate.downloadUrl);
      assert.deepEqual(req.expectedMimeTypes, ['video/mp4']);
      assert.ok(req.allowedHosts.includes('videos.pexels.com'));
      assert.equal(req.headers, undefined, 'ключ не уходит на CDN');
      return { bytes: fs.readFileSync(downloaded), contentType: 'video/mp4' };
    } };
  assert.equal(await runStock({ 'query-original': 'люди за ноутбуком', sec: '2' }, extra), 0);
  assert.equal(providerConfig.apiKey, KEY);
  const probe = probeVideo(clip);
  assert.deepEqual([probe.width, probe.height, probe.fps], [540, 960, 25]);
  assert.ok(Math.abs(probe.duration - 2) < 0.1);
  const source = sourceMd();
  assert.match(source, /\| `stock\/pexels-12345\.mp4` \| Pexels License, Автор \| https:\/\/www\.pexels\.com\/video\/12345\/ \| [a-f0-9]{64} \|/);
  assert.ok(source.includes(hashFile(clip)), 'sha256 — от готового клипа в public/stock');
  assert.match(source, /https:\/\/www\.pexels\.com\/license\//);
  assert.match(source, /https:\/\/www\.pexels\.com\/@a/);
  assert.match(source, /«люди за ноутбуком»/);
  assert.match(source, /2026-01-01T00:00:00\.000Z/);
  assert.ok(!source.includes(KEY), 'ключ не попадает в SOURCE.md');
  assert.deepEqual(leftovers(), [], 'временные файлы скачивания убраны');
});

test('--insert stock-1 without --sec cuts the clip to the length of that insert', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip, out } = await scaffold(t);
  let asked;
  const extra = { createProvider: () => ({ search: async (input) => { asked = input.minDurationSec; return { candidates: [candidate] }; } }) };
  assert.equal(await runStock({ insert: 'stock-1' }, extra), 0);
  // Вставка шаблона stock-1 длится 2 с (3,6–5,6 с на 6-секундном исходнике).
  assert.equal(asked, 2);
  assert.ok(Math.abs(probeVideo(clip).duration - 2) < 0.1, String(probeVideo(clip).duration));
  assert.ok(out.some((line) => /stock-1/.test(line) && /stock\/pexels-12345\.mp4/.test(line)), out.join('\n'));
});

test('BAD CASE: an unknown --insert names the stock inserts of the plan', { skip: !hasFfmpeg }, async (t) => {
  const { runStock } = await scaffold(t);
  await assert.rejects(runStock({ insert: 'stock-9' }), /вставки stock-9 нет.*stock-1/s);
});

test('BAD CASE: bad --sec and --pick are refused before any request', { skip: !hasFfmpeg }, async (t) => {
  const { runStock } = await scaffold(t);
  const never = { createProvider: () => { throw new Error('поиск не должен начаться'); } };
  await assert.rejects(runStock({ sec: '0' }, never), /--sec/);
  await assert.rejects(runStock({ sec: 'abc' }, never), /--sec/);
  await assert.rejects(runStock({ pick: '0' }, never), /--pick/);
  await assert.rejects(runStock({ query: undefined }, never), /--query/);
});

test('--list prints candidates and downloads nothing', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip, out } = await scaffold(t);
  const request = async () => { throw new Error('--list ничего не скачивает'); };
  assert.equal(await runStock({ list: true }, { request }), 0);
  assert.ok(out.some((line) => line.includes('12345') && line.includes('Автор')), out.join('\n'));
  assert.ok(!fs.existsSync(clip));
});

test('BAD CASE: a second fetch of the same clip does not overwrite the existing file', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip, sourceMd } = await scaffold(t);
  assert.equal(await runStock({ sec: '2' }), 0);
  const sha = hashFile(clip);
  const rows = sourceMd().split('\n').filter((line) => line.includes('pexels-12345')).length;
  await assert.rejects(runStock({ sec: '3' }), /stock\/pexels-12345\.mp4 уже есть/);
  assert.equal(hashFile(clip), sha);
  assert.equal(sourceMd().split('\n').filter((line) => line.includes('pexels-12345')).length, rows);
});

test('BAD CASE: a download that is not an mp4 video is refused and leaves nothing behind', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip, sourceMd, leftovers } = await scaffold(t);
  const before = sourceMd();
  await assert.rejects(runStock({}, { request: async () => ({ bytes: Buffer.from('<html>nope</html>'), contentType: 'text/html' }) }), /не mp4/);
  await assert.rejects(runStock({}, { request: async () => ({ bytes: Buffer.from('<html>nope</html>'), contentType: 'video/mp4' }) }), /не mp4/);
  await assert.rejects(runStock({}, { request: async () => ({ bytes: Buffer.alloc(0), contentType: 'video/mp4' }) }), /не mp4/);
  assert.ok(!fs.existsSync(clip));
  assert.equal(sourceMd(), before);
  assert.deepEqual(leftovers(), []);
});

test('BAD CASE: a candidate with an unsafe id or a non-mp4 link is refused', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, layerDir } = await scaffold(t);
  const searchWith = (patch) => ({ createProvider: () => ({ search: async () => ({ candidates: [{ ...candidate, ...patch }] }) }) });
  await assert.rejects(runStock({}, searchWith({ providerAssetId: '../../evil' })), /кандидат Pexels/);
  await assert.rejects(runStock({}, searchWith({ downloadUrl: 'https://videos.pexels.com/video-files/12345/a.mov' })), /кандидат Pexels/);
  assert.deepEqual(fs.readdirSync(path.join(layerDir, 'public', 'stock')), ['placeholder.mp4']);
});

test('SECURITY: provider and download failures never echo the key', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, out } = await scaffold(t);
  const failing = (code) => ({ createProvider: () => ({ search: async () => { throw failure(code); } }) });
  for (const code of ['BROLL_PROVIDER_FAILED', 'BROLL_REMOTE_TIMEOUT', 'BROLL_SEARCH_INVALID']) {
    await assert.rejects(runStock({}, failing(code)), (error) => {
      assert.ok(!error.message.includes(KEY));
      assert.doesNotMatch(error.message, /^BROLL_/);
      return true;
    });
  }
  await assert.rejects(runStock({}, { request: async () => { throw failure('BROLL_REMOTE_REJECTED'); } }), (error) => {
    assert.match(error.message, /скачать клип/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
  // Ключ с пробелами или управляющими символами — отказ без его значения.
  await assert.rejects(runStock({}, { env: { PEXELS_API_KEY: `${KEY} bad` } }), (error) => {
    assert.match(error.message, /PEXELS_API_KEY/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
  assert.ok(!out.join('\n').includes(KEY));
});

test('BAD CASE: nothing found asks to rephrase the query', { skip: !hasFfmpeg }, async (t) => {
  const { runStock } = await scaffold(t);
  await assert.rejects(runStock({}, { createProvider: () => ({ search: async () => ({ candidates: [] }) }) }), /ничего не нашёл/);
});
