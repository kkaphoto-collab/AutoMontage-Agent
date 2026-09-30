// Задача 26: гейты по отрендеренному слою – G6 «Длина слоя» и G7 «Голос в звуке слоя».
// G7 судит по трём сигналам: A – слышимый звук слоя ВНЕ эффектов из манифеста (главный),
// B – корреляция огибающих слоя и исходника по всей дорожке с поиском сдвига, C – самое похожее
// окно, но только если в нём тоже есть звук вне эффектов.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { probeVideo } = require('../scripts/media-probe');
const { bestLagPearson, decodeAudio, envelopeDb, windowedMax } = require('../scripts/qa/audio');
const { gateLayerDuration, gateVoiceLeak } = require('../scripts/qa/media-gates');
const { getProfile } = require('../scripts/qa/profiles');

const avatar = getProfile('avatar');
const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const FPS = 25;
const SECONDS = 10;
// Синтетическая «речь»: тон с модуляцией слогов и короткими паузами (звучит ≈80 % времени, паузы
// 0,1–0,15 с), как у настоящей речи. Голос из плана (паузы по 0,4 с через каждые 0,4 с) давал на
// 1 с утечки всего 0,45–0,65 с слышимого звука – вплотную к стопу 0,5 с.
const SYLLABLES = 'gt(sin(2*PI*1.3*t)+0.3*sin(2*PI*3.7*t),-0.8)';
const VOICE = `0.4*sin(2*PI*220*t)*(0.55+0.45*sin(2*PI*4.7*t))*${SYLLABLES}`;
const DELAYED_VOICE = `gte(t,0.3)*${VOICE.replace(/\bt\b/g, '(t-0.3)')}`;
const MINUS_18_DB = 0.126;

function work(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const ffmpeg = (args) => runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const video = (file, seconds) => ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=108x192:r=25:d=${seconds}`, '-pix_fmt', 'yuv420p', file]);

// Звук как в настоящем пайплайне: исходник – одно поколение AAC, слой – два (рендер Remotion,
// затем layer normalize).
function envelopeOf(dir, name, expr, generations) {
  let current = path.join(dir, `${name}.wav`);
  ffmpeg(['-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=${SECONDS}`, current]);
  for (let g = 1; g <= generations; g += 1) {
    const next = path.join(dir, `${name}.g${g}.m4a`);
    ffmpeg(['-i', current, '-c:a', 'aac', '-b:a', g === 1 ? '320k' : '192k', '-ar', '48000', next]);
    current = next;
  }
  return envelopeDb(decodeAudio(current));
}
// Исходник одинаковый во всех тестах на файлах: огибающая строится один раз на весь файл.
const shared = { dir: null, envelope: null };
test.after(() => { if (shared.dir) fs.rmSync(shared.dir, { recursive: true, force: true }); });
function sourceEnvelope() {
  if (!shared.envelope) {
    shared.dir = shared.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'qa-media-source-'));
    shared.envelope = envelopeOf(shared.dir, 'source', VOICE, 1);
  }
  return shared.envelope;
}
const layerEnvelope = (dir, name, expr) => envelopeOf(dir, name, expr, 2);

// Эффект kit начинается ровно на кадре startFrame и звучит durationFrames кадров.
const cue = (startFrame, durationFrames, extra = {}) => ({
  id: `pop@${startFrame}`, name: 'pop', startFrame, hitFrame: startFrame, durationFrames, notable: false, bed: false, ...extra,
});
const beep = ({ startFrame, durationFrames }) => `0.8*sin(2*PI*1000*t)*between(t,${startFrame / FPS},${(startFrame + durationFrames) / FPS - 1e-6})`;
const sounds = (cues) => cues.filter((c) => !c.bed).map(beep).join('+');
// Редкие эффекты: 0; 2,4; 4,8; 7,2; 9,6 с, по 3 кадра.
const SPARSE = [0, 60, 120, 180, 240].map((f) => cue(f, 3));
const voiceBetween = (from, to) => `${MINUS_18_DB}*${VOICE}*between(t,${from},${to})`;
const mixed = (cues, sourceEnv, layerEnv) => ({ layerEnv, sourceEnv, audioMode: 'mix', cues, fps: FPS });

// --- G6 «Длина слоя» ---

test('BAD CASE: a layer 0.2 s longer than the source stops; one frame of difference passes', { skip: !hasFfmpeg }, (t) => {
  const dir = work(t);
  video(path.join(dir, 'source.mp4'), 10);
  video(path.join(dir, 'long.mp4'), 10.2);
  video(path.join(dir, 'ok.mp4'), 10.04);
  const source = probeVideo(path.join(dir, 'source.mp4'));
  const bad = gateLayerDuration({ layer: probeVideo(path.join(dir, 'long.mp4')), source }, avatar);
  assert.equal(bad.id, 'G6');
  assert.equal(bad.status, 'fail');
  assert.equal(bad.value, 5);
  assert.equal(bad.unit, 'кадр.');
  assert.match(bad.hint, /layer new/);
  assert.equal(gateLayerDuration({ layer: probeVideo(path.join(dir, 'ok.mp4')), source }, avatar).status, 'pass');
});

test('G6 allows exactly ±toleranceFrames and stops a shorter layer too', () => {
  const source = { width: 1080, height: 1920, fps: 25, duration: 10 };
  const at = (duration) => gateLayerDuration({ layer: { ...source, duration }, source }, avatar);
  assert.deepEqual([at(10.04).status, at(9.96).status, at(10).status], ['pass', 'pass', 'pass']);
  assert.equal(at(10).value, 0);
  const short = at(9.92);
  assert.equal(short.status, 'fail');
  assert.equal(short.value, -2);
  assert.equal(at(10.08).status, 'fail');
});

test('G6 stops a layer of another size or FPS even at the same length and names both', () => {
  const source = { width: 1080, height: 1920, fps: 25, duration: 10 };
  const size = gateLayerDuration({ layer: { ...source, width: 720, height: 1280 }, source }, avatar);
  assert.equal(size.status, 'fail');
  assert.equal(size.value, 0);
  assert.match(size.hint, /720×1280@25/);
  assert.match(size.hint, /1080×1920@25/);
  assert.doesNotMatch(size.hint, /layer new/);
  const rate = gateLayerDuration({ layer: { ...source, fps: 30 }, source }, avatar);
  assert.equal(rate.status, 'fail');
  assert.match(rate.hint, /1080×1920@30/);
});

test('G6 stops a layer that differs only in height or runs 29.97 fps against 30', () => {
  const source = { width: 1080, height: 1920, fps: 30, duration: 10 };
  const tall = gateLayerDuration({ layer: { ...source, height: 1918 }, source }, avatar);
  assert.equal(tall.status, 'fail');
  assert.equal(tall.value, 0);
  assert.match(tall.hint, /слой 1080×1918@30, исходник 1080×1920@30/);
  const ntsc = gateLayerDuration({ layer: { ...source, fps: 29.97 }, source }, avatar);
  assert.equal(ntsc.status, 'fail');
  assert.equal(ntsc.value, 0);
  assert.match(ntsc.hint, /слой 1080×1920@29,97/);
  // Шум округления ffprobe (30,0004) – тот же FPS.
  assert.equal(gateLayerDuration({ layer: { ...source, fps: 30.0004 }, source }, avatar).status, 'pass');
});

// --- G7 «Голос в звуке слоя»: без звука и без проверки ---

test('muted layers skip the voice check, silent mix layers warn', () => {
  const flat = new Float64Array(200).fill(-90);
  const base = { sourceEnv: flat, cues: [], fps: FPS };
  const muted = gateVoiceLeak({ ...base, layerEnv: flat, audioMode: 'mute' }, avatar);
  assert.equal(muted.id, 'G7');
  assert.equal(muted.status, 'skipped');
  assert.equal(gateVoiceLeak({ ...base, layerEnv: flat, audioMode: 'mix' }, avatar).status, 'warn');
  assert.equal(gateVoiceLeak({ ...base, layerEnv: null, audioMode: 'mix' }, avatar).status, 'warn');
  assert.equal(gateVoiceLeak({ ...base, layerEnv: new Float64Array(0), audioMode: 'mix' }, avatar).status, 'warn');
  // «Почти беззвучный» – ни одного блока громче порога слышимости silentDb (−60 дБФС).
  const atThreshold = Float64Array.from(flat, (v, i) => (i === 50 ? -60 : v));
  assert.equal(gateVoiceLeak({ ...base, layerEnv: atThreshold, audioMode: 'mix' }, avatar).status, 'warn');
});

test('G7 refuses cues that are not a manifest array or have no fps to convert frames', () => {
  const env = new Float64Array(200).fill(-20);
  const call = (fields) => () => gateVoiceLeak({ layerEnv: env, sourceEnv: env, audioMode: 'mix', ...fields }, avatar);
  assert.throws(call({ fps: FPS }), /gateVoiceLeak: нужен cues/);
  assert.throws(call({ cues: {}, fps: FPS }), /gateVoiceLeak: нужен cues/);
  assert.throws(call({ cues: [cue(0, 3)] }), /gateVoiceLeak: нужен fps/);
  assert.throws(call({ cues: [cue(0, 3)], fps: 0 }), /gateVoiceLeak: нужен fps/);
  assert.throws(call({ cues: [cue(0, 0)], fps: FPS }), /манифест повреждён: звук pop@0/);
  assert.throws(call({ cues: [{ ...cue(0, 3), startFrame: -1 }], fps: FPS }), /манифест повреждён/);
  assert.doesNotThrow(call({ cues: [], fps: undefined }));
});

// --- G7 на синтетических огибающих: пороги сигнала A ---

// Огибающая слоя: тишина, кроме блоков loud (по 50 мс); исходник ровный – корреляция не считается,
// судит только сигнал A.
function outsideOnly(loud, n = 200) {
  const layerEnv = Float64Array.from({ length: n }, (_, i) => (loud.includes(i) ? -20 : -90));
  return { layerEnv, sourceEnv: new Float64Array(n).fill(-30), audioMode: 'mix', cues: [], fps: FPS };
}
const range = (from, count) => Array.from({ length: count }, (_, k) => from + k);

test('signal A: 0.10 s outside effects passes, 0.15 s warns, 0.45 s warns, 0.5 s stops', () => {
  const verdict = (count) => gateVoiceLeak(outsideOnly(range(40, count)), avatar);
  assert.deepEqual([2, 3, 9, 10].map((count) => verdict(count).status), ['pass', 'warn', 'warn', 'fail']);
  const stop = verdict(10);
  assert.equal(stop.value, 0.5);
  assert.equal(stop.unit, 'с');
  assert.deepEqual(stop.spans, [{ fromSec: 2, toSec: 2.5, note: 'звук вне эффектов' }]);
  assert.match(stop.hint, /посторонний звук вне эффектов/);
  assert.match(stop.hint, /muted/);
  assert.match(stop.threshold, /0,15 с/);
  assert.match(stop.threshold, /0,5 с/);
});

test('signal A reads spans from every kept cue, bed cues included, in seconds of the layer fps', () => {
  // Громкие блоки 40..49 (2,0..2,5 с) – внутри звука-подложки 50..62 кадра при 25 fps (2,0..2,48 с,
  // хвост 0,15 с). Тот же звук без подложки – стоп.
  const loud = outsideOnly(range(40, 10));
  const bed = cue(50, 12, { name: 'typing', bed: true });
  assert.equal(gateVoiceLeak({ ...loud, cues: [bed] }, avatar).status, 'pass');
  assert.equal(gateVoiceLeak({ ...loud, cues: [{ ...bed, bed: false }] }, avatar).status, 'pass');
  // При 50 fps те же кадры – это 1,0..1,24 с: звук на 2,0 с уже вне эффекта.
  assert.equal(gateVoiceLeak({ ...loud, cues: [bed], fps: 50 }, avatar).status, 'fail');
});

test('signal A pads each effect 0.1 s before and 0.15 s after (profile headSec/tailSec)', () => {
  // Эффект 2,0..2,4 с (кадры 50..60). Блок 38 (1,90..1,95) – в запасе до начала, блок 50
  // (2,50..2,55) – в запасе после конца: оба не считаются. Блоки 37 и 51 – уже снаружи.
  const inside = outsideOnly([38, 50]);
  assert.equal(gateVoiceLeak({ ...inside, cues: [cue(50, 10)] }, avatar).value, 0);
  const outside = outsideOnly([37, 38, 50, 51]);
  assert.equal(gateVoiceLeak({ ...outside, cues: [cue(50, 10)] }, avatar).value, 0.1);
});

test('signal A takes the audibility threshold and both margins from the profile', () => {
  const strict = { ...avatar, leak: { ...avatar.leak, silentDb: -30, headSec: 0, tailSec: 0 } };
  // Эффект 2,0..2,4 с. Громкие (−20 дБФС) блоки 37 и 38 перед ним, 50 – после, тихий (−40) блок 60.
  // avatar: 38 и 50 в запасах, 37 и 60 снаружи. strict: запасов нет (37, 38, 50), а −40 уже не
  // слышно. wide: запасы 0,2/0,3 с забирают 37, 38 и 50, остаётся только 60.
  const input = outsideOnly([37, 38, 50]);
  input.layerEnv[60] = -40;
  input.cues = [cue(50, 10)];
  assert.equal(gateVoiceLeak(input, avatar).value, 0.1);
  assert.equal(gateVoiceLeak(input, strict).value, 0.15);
  const wide = { ...avatar, leak: { ...avatar.leak, headSec: 0.2, tailSec: 0.3 } };
  assert.equal(gateVoiceLeak(input, wide).value, 0.05);
});

test('a source without audio leaves only signal A: effects pass, sound outside effects stops', () => {
  // Громкие блоки 40..44 (2,00..2,25 с) лежат внутри эффекта 50..56 кадра (2,00..2,24 с + запасы).
  const effects = gateVoiceLeak({ ...outsideOnly(range(40, 5)), sourceEnv: null, cues: [cue(50, 6)] }, avatar);
  assert.equal(effects.status, 'pass');
  assert.equal(effects.value, 0);
  assert.match(effects.hint, /похожесть на голос не посчитана: в исходнике нет звука/);
  for (const sourceEnv of [null, new Float64Array(0)]) {
    const leak = gateVoiceLeak({ ...outsideOnly(range(40, 10)), sourceEnv }, avatar);
    assert.equal(leak.status, 'fail');
    assert.equal(leak.value, 0.5);
    assert.match(leak.hint, /посторонний звук вне эффектов: 0,5 с/);
    assert.match(leak.hint, /похожесть на голос не посчитана: в исходнике нет звука/);
    assert.doesNotMatch(leak.hint, /повторяет голос|похожа на голос/);
  }
});

test('only the first five outside stretches are listed as spans', () => {
  const g = gateVoiceLeak(outsideOnly([10, 20, 30, 40, 50, 60, 70]), avatar);
  assert.equal(g.status, 'warn');
  assert.equal(g.value, 0.35);
  assert.equal(g.spans.length, 5);
  assert.deepEqual(g.spans.map((s) => s.fromSec), [0.5, 1, 1.5, 2, 2.5]);
});

// --- G7 на синтетических огибающих: сигналы B и C ---

// Детерминированная «речь» в дБФС: псевдослучайные блоки от −40 до −20 (32-битный LCG через
// Math.imul – точная целочисленная арифметика без потери младших битов).
function speechEnvelope(n, seed = 7) {
  let state = seed >>> 0;
  return Float64Array.from({ length: n }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return -40 + 20 * (state / 4294967296);
  });
}

test('signal B: a copy of the voice under a whole-track bed stops even with nothing outside effects', () => {
  const sourceEnv = speechEnvelope(200);
  const everything = [cue(0, 250, { name: 'ambience', bed: true })];
  const same = gateVoiceLeak({ layerEnv: sourceEnv, sourceEnv, audioMode: 'mix', cues: everything, fps: FPS }, avatar);
  assert.equal(same.status, 'fail');
  assert.equal(same.value, 0);
  assert.match(same.hint, /вся дорожка слоя похожа на голос аватара: r 1, без сдвига/);
  assert.doesNotMatch(same.hint, /по всей дорожке r/);
  // Слой отстаёт от исходника на 3 блока (150 мс).
  const delayed = Float64Array.from(sourceEnv, (_, i) => (i >= 3 ? sourceEnv[i - 3] : -90));
  const late = gateVoiceLeak({ layerEnv: delayed, sourceEnv, audioMode: 'mix', cues: everything, fps: FPS }, avatar);
  assert.equal(late.status, 'fail');
  assert.match(late.hint, /вся дорожка слоя похожа на голос аватара: r [\d,]+, звук слоя позже голоса на 150 мс/);
  // Слой опережает исходник на 2 блока – сдвиг со знаком минус.
  const early = Float64Array.from(sourceEnv, (_, i) => (i + 2 < sourceEnv.length ? sourceEnv[i + 2] : -90));
  assert.match(gateVoiceLeak({ layerEnv: early, sourceEnv, audioMode: 'mix', cues: everything, fps: FPS }, avatar).hint,
    /звук слоя раньше голоса на 100 мс/);
  // Независимая «речь» с тем же уровнем – не голос аватара.
  const other = gateVoiceLeak({ layerEnv: speechEnvelope(200, 99), sourceEnv, audioMode: 'mix', cues: everything, fps: FPS }, avatar);
  assert.equal(other.status, 'pass');
  assert.match(other.hint, /по всей дорожке r -?[\d,]+ \(стоп от 0,6\)/);
});

test('signal B stops exactly at the profile threshold', () => {
  const sourceEnv = speechEnvelope(200);
  const layerEnv = Float64Array.from(sourceEnv, (v, i) => (i % 7 === 0 ? -35 : v));
  const input = { layerEnv, sourceEnv, audioMode: 'mix', cues: [cue(0, 250, { bed: true })], fps: FPS };
  const { r } = bestLagPearson(layerEnv, sourceEnv, 6);
  assert.ok(r > 0.5 && r < 1, `сценарий: ${r}`);
  assert.equal(gateVoiceLeak(input, { ...avatar, leak: { ...avatar.leak, stop: r } }).status, 'fail');
  assert.equal(gateVoiceLeak(input, { ...avatar, leak: { ...avatar.leak, stop: r + 1e-6 } }).status, 'pass');
});

// Тихая полная утечка: копия голоса на 45 дБ ниже (−85…−65 дБФС, неслышно), громче порога только
// один пик. Ни одно окно не набирает 40 % слышимых блоков – сигнала C нет, стоп даёт одна корреляция.
test('a quiet full-length leak with no audible window still stops by correlation and names its lag', () => {
  const sourceEnv = speechEnvelope(200);
  const peak = sourceEnv.indexOf(Math.max(...sourceEnv));
  const layerEnv = Float64Array.from(sourceEnv, (_, i) => (i >= 2 ? sourceEnv[i - 2] - 45 : -90));
  layerEnv[peak + 2] = -55;
  assert.equal(windowedMax(layerEnv, sourceEnv, 40, { minDbA: -60 }), null);
  const g = gateVoiceLeak({ layerEnv, sourceEnv, audioMode: 'mix', cues: [], fps: FPS }, avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 0.05);
  assert.match(g.hint, /вся дорожка слоя похожа на голос аватара: r [\d,]+, звук слоя позже голоса на 100 мс/);
});

// Слой 20 с при 20 fps: звук только в окне 5..7 с, и там он точно повторяет голос (окно r = 1),
// по всей дорожке корреляция слабая. Два эффекта 5,0..5,6 и 5,95..7,0 с с запасами оставляют
// снаружи ровно два блока – 5,75..5,85 с (0,10 с: сигнал A сам по себе ещё не предупреждает).
function windowLeak(secondCueStart) {
  const sourceEnv = speechEnvelope(400);
  const layerEnv = Float64Array.from(sourceEnv, (v, i) => (i >= 100 && i < 140 ? v : -90));
  const cues = [cue(100, 12), cue(secondCueStart, 140 - secondCueStart)];
  return { layerEnv, sourceEnv, audioMode: 'mix', cues, fps: 20 };
}

test('signal C: a window that repeats the voice warns only when it holds 0.1 s of sound outside effects', () => {
  const input = windowLeak(119);
  const precondition = windowedMax(input.layerEnv, input.sourceEnv, 40, { minDbA: -60 });
  assert.ok(precondition.r > 0.99, `сценарий должен давать похожее окно: ${precondition.r}`);
  // Ровно на пороге окна (windowWarn = r окна) – всё ещё предупреждение.
  assert.equal(gateVoiceLeak(input, { ...avatar, leak: { ...avatar.leak, windowWarn: precondition.r } }).status, 'warn');
  assert.equal(gateVoiceLeak(input, { ...avatar, leak: { ...avatar.leak, windowWarn: precondition.r + 1e-6 } }).status, 'pass');
  const warned = gateVoiceLeak(input, avatar);
  assert.equal(warned.status, 'warn');
  assert.equal(warned.value, 0.1);
  // Окно называет свои r, время и сдвиг; r всей дорожки – отдельно и не спорит с окном.
  assert.match(warned.hint, /окно 5–7 с повторяет голос: r 1, без сдвига/);
  assert.match(warned.hint, /по всей дорожке r 0,\d+ \(стоп от 0,6\)/);
  assert.doesNotMatch(warned.hint, /вся дорожка слоя похожа/);
  assert.deepEqual(warned.spans, [
    { fromSec: 5.75, toSec: 5.85, note: 'звук вне эффектов' },
    { fromSec: 5, toSec: 7, note: 'звук слоя повторяет голос' },
  ]);
  // Второй эффект с 5,90 с: снаружи один блок (0,05 с) – мало, чтобы засчитать похожее окно.
  const single = gateVoiceLeak(windowLeak(118), avatar);
  assert.equal(single.status, 'pass');
  assert.equal(single.value, 0.05);
  // Второй эффект с 5,85 с: снаружи ничего – то же похожее окно больше не считается.
  const clean = gateVoiceLeak(windowLeak(117), avatar);
  assert.equal(clean.status, 'pass');
  assert.equal(clean.value, 0);
  assert.deepEqual(clean.spans, []);
});

test('signal C counts only sound outside effects that lies inside the matching window', () => {
  // В окне 5..7 с снаружи эффектов ничего, а 0,10 с постороннего звука – далеко, на 15,0..15,1 с.
  const input = windowLeak(117);
  input.layerEnv[300] = -20;
  input.layerEnv[301] = -20;
  const g = gateVoiceLeak(input, avatar);
  assert.equal(g.value, 0.1);
  assert.equal(g.status, 'pass');
  assert.doesNotMatch(g.hint, /окно/);
});

test('the window hint takes the lag of the window, not of the whole track', () => {
  // Окно 5..7 с: слой повторяет голос на 2 блока позже. На 15..20 с – неслышная (−45 дБ) копия на
  // 4 блока раньше: по всей дорожке корреляция слабая и её лучший сдвиг другой.
  const sourceEnv = speechEnvelope(400);
  const layerEnv = new Float64Array(400).fill(-90);
  for (let i = 100; i < 140; i += 1) layerEnv[i] = sourceEnv[i - 2];
  for (let i = 300; i < 396; i += 1) layerEnv[i] = sourceEnv[i + 4] - 45;
  const whole = bestLagPearson(layerEnv, sourceEnv, 6);
  assert.equal(whole.lag, -4, 'сценарий: у всей дорожки свой сдвиг');
  const g = gateVoiceLeak({ layerEnv, sourceEnv, audioMode: 'mix', cues: [cue(100, 12), cue(119, 21)], fps: 20 }, avatar);
  assert.equal(g.status, 'warn');
  assert.match(g.hint, /окно 5–7 с повторяет голос: r 1, звук слоя позже голоса на 100 мс/);
  assert.doesNotMatch(g.hint, /раньше голоса/);
});

test('signal C takes its window length from profile windowSec', () => {
  const g = gateVoiceLeak(windowLeak(119), { ...avatar, leak: { ...avatar.leak, windowSec: 1 } });
  assert.equal(g.status, 'warn');
  assert.deepEqual(g.spans.at(-1), { fromSec: 5, toSec: 6, note: 'звук слоя повторяет голос' });
  assert.match(g.hint, /окно 5–6 с повторяет голос/);
});

test('signal C judges the audible share of a window by profile silentDb', () => {
  // При пороге слышимости −22 дБФС в окне 5..7 с слышно меньше 40 % блоков – похожего окна нет;
  // при −60 то же окно (r ≈ 0,91) с 0,10 с звука вне эффектов предупреждало бы.
  const input = windowLeak(119);
  input.layerEnv[115] = -15;
  input.layerEnv[116] = -15;
  assert.equal(windowedMax(input.layerEnv, input.sourceEnv, 40, { minDbA: -22 }), null);
  assert.ok(windowedMax(input.layerEnv, input.sourceEnv, 40, { minDbA: -60 }).r >= avatar.leak.windowWarn);
  const g = gateVoiceLeak(input, { ...avatar, leak: { ...avatar.leak, silentDb: -22 } });
  assert.equal(g.value, 0.1);
  assert.equal(g.status, 'pass');
});

// --- G7 на настоящих файлах (lavfi → AAC → PCM) ---

test('BAD CASE: the avatar voice leaking into the layer audio stops; sparse effects pass', { skip: !hasFfmpeg }, (t) => {
  const dir = work(t);
  const sourceEnv = sourceEnvelope();
  const leak = gateVoiceLeak(mixed([], sourceEnv, layerEnvelope(dir, 'leak', `${MINUS_18_DB}*${VOICE}`)), avatar);
  assert.equal(leak.status, 'fail');
  assert.ok(leak.value > 5, `почти вся речь звучит вне эффектов: ${leak.value} с`);
  assert.match(leak.hint, /вся дорожка слоя похожа на голос аватара/);
  const effects = gateVoiceLeak(mixed(SPARSE, sourceEnv, layerEnvelope(dir, 'sfx', sounds(SPARSE))), avatar);
  assert.equal(effects.status, 'pass');
  assert.equal(effects.value, 0);
});

test('a 1 s voice leak between effects stops through sound outside effects', { skip: !hasFfmpeg }, (t) => {
  const dir = work(t);
  const layerEnv = layerEnvelope(dir, 'leak-1s', `${sounds(SPARSE)}+${voiceBetween(3, 4)}`);
  const g = gateVoiceLeak(mixed(SPARSE, sourceEnvelope(), layerEnv), avatar);
  assert.equal(g.status, 'fail');
  assert.ok(g.value >= 0.7 && g.value <= 1.1, `1 с утечки: ${g.value} с вне эффектов`);
  assert.match(g.hint, /посторонний звук вне эффектов/);
  assert.ok(g.spans.every((s) => s.fromSec >= 2.9 && s.toSec <= 4.1), JSON.stringify(g.spans));
});

test('a 0.3 s voice leak between effects warns', { skip: !hasFfmpeg }, (t) => {
  const dir = work(t);
  const layerEnv = layerEnvelope(dir, 'leak-03s', `${sounds(SPARSE)}+${voiceBetween(4, 4.3)}`);
  const g = gateVoiceLeak(mixed(SPARSE, sourceEnvelope(), layerEnv), avatar);
  assert.equal(g.status, 'warn');
  assert.ok(g.value >= 0.25 && g.value <= 0.4, `0,3 с утечки: ${g.value} с вне эффектов`);
});

test('a full voice leak delayed 300 ms stops by correlation even when a bed cue hides it from signal A', { skip: !hasFfmpeg }, (t) => {
  const dir = work(t);
  const cues = [...SPARSE, cue(0, SECONDS * FPS, { name: 'ambience', bed: true })];
  const layerEnv = layerEnvelope(dir, 'leak-d300', `${sounds(SPARSE)}+${MINUS_18_DB}*${DELAYED_VOICE}`);
  const g = gateVoiceLeak(mixed(cues, sourceEnvelope(), layerEnv), avatar);
  assert.equal(g.status, 'fail');
  assert.equal(g.value, 0);
  assert.match(g.hint, /вся дорожка слоя похожа на голос аватара: r [\d,]+, звук слоя позже голоса на 300 мс/);
});

test('a clean dense effect layer passes although one window resembles the voice', { skip: !hasFfmpeg }, (t) => {
  const dir = work(t);
  const sourceEnv = sourceEnvelope();
  // Щелчок каждую секунду, а на 4..6 с – подложка «печати», которая звучит в такт слогам.
  const clicks = range(0, 10).filter((k) => k !== 4 && k !== 5).map((k) => cue(k * FPS + 5, 3));
  const typing = cue(4 * FPS, 2 * FPS, { name: 'typing', bed: true });
  const expr = `${sounds(clicks)}+0.3*sin(2*PI*1500*t)*${SYLLABLES}*between(t,4,6)`;
  const layerEnv = layerEnvelope(dir, 'dense', expr);
  const window = windowedMax(layerEnv, sourceEnv, 40, { minDbA: -60 });
  assert.ok(window.r >= avatar.leak.windowWarn, `без условия C окно предупреждало бы: r = ${window.r}`);
  const g = gateVoiceLeak(mixed([...clicks, typing], sourceEnv, layerEnv), avatar);
  assert.equal(g.status, 'pass');
  assert.equal(g.value, 0);
});
