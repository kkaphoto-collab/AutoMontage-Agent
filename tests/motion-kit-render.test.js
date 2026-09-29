const test = require('node:test');
const assert = require('node:assert/strict');

// Round 2 (ревью minor 4/regression): настоящий Remotion-рендер с concurrency>1 обнаружил, что
// подгонка ширины субтитров была недетерминирована между «вкладками» рендера – какой кадр браузер
// откроет первым, недетерминировано, и Subtitles мог измерить текст ДО того, как FontLoader успел
// догрузить шрифт. Юнит-тесты на renderToStaticMarkup не могут это поймать: layout-эффекты (и
// document.fonts) там вообще не выполняются (см. tests/helpers/remotion-stub.js). Эти тесты – как
// последний тест в tests/motion-render.test.js: настоящий бандл + настоящий headless Chromium,
// пропускаются по умолчанию и включаются только явным флагом (`npm test` их не трогает).
//
// Round 3 (ревью, важно): исходная версия этого теста проходила и на добаговом коде – субтитр был
// виден С ПЕРВОГО кадра, поэтому у любой «вкладки» рендера самый первый кадр уже требовал замера, и
// ВСЕ вкладки попадали в одну и ту же (пусть и неверную) гонку одинаково – расхождения между кадрами
// не возникало. К тому же у ЗАГЛАВНОЙ фразы фолбэк-шрифт шире Onest, поэтому даже неверный замер не
// обрезался. Теперь: (1) chunk начинается на кадре 2 (0.08с), а не 0 – часть вкладок (round-robin по
// concurrency) успевают отрендерить свой первый кадр ДО начала chunk и получают его позже (на «тёплом»
// кадре), другие упираются в chunk сразу на своём первом кадре («холодный старт») – расхождение между
// ними и было бы видно; (2) второй вариант – строчная фраза на fontSize 60, где фолбэк-шрифт УЖЕ Onest
// (при неверном раннем замере код решил бы, что 60px влезает, и НЕ обрезал бы – но настоящий Onest
// шире, и обрезка стала бы видна); (3) проверяем не только «одинаковость», но и АБСОЛЮТНУЮ
// правильность: независимый эталонный бинарный поиск на клоне с гарантированно загруженным Onest
// должен дать то же число, что показал реальный рендер.

const FIXTURE = (text, fontSize) => `
import { useLayoutEffect } from 'react';
import { AbsoluteFill, Composition, registerRoot, useCurrentFrame, delayRender, continueRender } from 'remotion';
import { FontLoader, Subtitles } from '@automontage/motion-kit';

const FONTS = [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }];
const TEXT = ${JSON.stringify(text)};
const FONT_SIZE = ${fontSize === undefined ? 'undefined' : fontSize};
const units = (s) => TEXT.split(' ').map((t, i) => ({ t, s: s + i * 0.1, e: s + i * 0.1 + 0.1 }));
// chunk начинается на 0.08с (кадр 2 при fps=25) – НЕ на кадре 0, см. комментарий round 3 выше.
const CHUNKS = [{ units: units(0.08), s: 0.08, e: 0.08 + 0.4, show: 10, text: TEXT }];
const LANE = { x: 70, y: 1398, w: 880, h: 84 };
const BASE = FONT_SIZE ?? 44; // width=1080 => k=1, тот же расчёт, что делает сам Subtitles
const onestLoaded = () => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'KitOnest' && f.status === 'loaded');

// Независимый эталон: своя копия бинарного поиска (не импортирует fitCaptionWidth) на скрытом
// клоне с уже загруженным Onest – если реальный рендер сверяется сам с собой, это не проверка;
// сверяем с ЗАНОВО посчитанным числом.
function referenceFit() {
  const shadowBlur = BASE * (12 / 44);
  const available = LANE.w - 2 * shadowBlur;
  const clone = document.createElement('span');
  clone.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-weight:800;left:-9999px;top:-9999px;';
  clone.style.fontFamily = '"KitOnest"';
  clone.textContent = TEXT;
  document.body.appendChild(clone);
  const fits = (size) => { clone.style.fontSize = size + 'px'; return clone.scrollWidth <= available; };
  let result = BASE;
  if (!fits(BASE)) {
    let low = BASE * 0.6;
    let high = BASE;
    while (high - low > 0.25) {
      const mid = (low + high) / 2;
      if (fits(mid)) low = mid; else high = mid;
    }
    result = Math.floor(low * 4) / 4;
  }
  document.body.removeChild(clone);
  return Math.round(result * 10) / 10;
}

function Probe() {
  const frame = useCurrentFrame();
  useLayoutEffect(() => {
    const handle = delayRender('probe');
    // Опрашиваем, пока не появится сама коробка субтитров И Onest не отчитается статусом "loaded"
    // (гейт FontLoader может ещё не открыться на первом кадре, который эта вкладка рендерит) –
    // иначе Probe снял бы состояние ДО того, как реальный скриншот вообще случится, и увидел бы
    // гонку, которой в самом сохранённом кадре нет. После этого – два requestAnimationFrame: React
    // обязан успеть закоммитить пост-подгоночное состояние (Subtitles применяет фактический размер
    // синхронной DOM-мутацией по завершении своего async-эффекта, но сам этот эффект и его await
    // резолвятся отдельным тиком от layout-эффекта Probe).
    let tries = 0;
    const tick = () => {
      const box = document.querySelector('[data-kit-text="captions"]');
      if ((!box || !onestLoaded()) && tries++ < 200) { setTimeout(tick, 10); return; }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const span = box && box.firstElementChild;
        console.log('PROBE ' + JSON.stringify({
          frame,
          fontSize: span ? span.style.fontSize : null,
          referenceFontSize: span ? referenceFit() : null,
          scrollWidth: span ? span.scrollWidth : null,
          clientWidth: box ? box.clientWidth : null,
        }));
        continueRender(handle);
      }));
    };
    tick();
  }, [frame]);
  return null;
}

function Layer() {
  return (
    <AbsoluteFill style={{ backgroundColor: '#222' }}>
      <FontLoader faces={FONTS}>
        <Subtitles chunks={CHUNKS} lane={LANE} fontFamily="KitOnest" fontSize={FONT_SIZE} />
      </FontLoader>
      <Probe />
    </AbsoluteFill>
  );
}

registerRoot(() => (
  <Composition id="Layer" component={Layer} durationInFrames={40} fps={25} width={1080} height={1920} />
));
`;

// Прогоняет одну фикстуру (текст + fontSize) через настоящий concurrency-рендер и возвращает
// собранные PROBE-логи. Общая часть для обоих вариантов (заглавного и строчного-60) и для ручной
// A/B-проверки против кита ДО этого исправления (см. отчёт).
async function renderFixture(t, { text, fontSize, motionKitDir } = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderFrames, selectComposition } = require('@remotion/renderer');
  const { withMotionKitAlias } = require('../scripts/remotion-webpack');

  const root = path.join(__dirname, '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-kit-render-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  const srcDir = path.join(work, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const entryPoint = path.join(srcDir, 'index.jsx');
  fs.writeFileSync(entryPoint, FIXTURE(text, fontSize));

  const serveUrl = await bundle({
    entryPoint, publicDir: path.join(root, 'public'), outDir: path.join(work, 'bundle'),
    webpackOverride: (config) => withMotionKitAlias(config, motionKitDir),
  });
  const browser = await openBrowser('chrome', { logLevel: 'error' });
  t.after(() => browser.close({ silent: true }));

  const probes = [];
  const onBrowserLog = (l) => {
    const text_ = l.text || '';
    const marker = 'PROBE ';
    if (text_.includes(marker)) probes.push(JSON.parse(text_.slice(text_.indexOf(marker) + marker.length)));
  };

  const composition = await selectComposition({ serveUrl, id: 'Layer', puppeteerInstance: browser });
  const outputDir = path.join(work, 'frames');
  fs.mkdirSync(outputDir, { recursive: true });
  // concurrency>1 – то самое условие ревью (несколько «вкладок» рендерят разные кадры параллельно;
  // какой кадр каждая вкладка откроет первой – фиксированное round-robin распределение Remotion, но
  // ПОРЯДОК готовности шрифта относительно этого распределения – нет).
  await renderFrames({
    serveUrl, composition, outputDir, imageFormat: 'jpeg', inputProps: {},
    puppeteerInstance: browser, concurrency: 4, onBrowserLog,
    onStart: () => {}, onFrameUpdate: () => {},
  });
  return probes;
}

// Общие проверки для одного варианта фикстуры: uniformity (одинаковый fontSize на каждом кадре),
// correctness (совпадает с независимым эталоном) и отсутствие обрезки.
function assertVariant(probes, label) {
  assert.equal(probes.length, 40, `${label}: ожидали ровно один PROBE-лог на кадр (0..39), получили ${probes.length}`);
  // Кадры 0 и 1 – до начала chunk (s=0.08=кадр 2) – субтитра там нет по плану, это не гонка.
  const withCaption = probes.filter((p) => p.frame >= 2);
  const missing = withCaption.filter((p) => p.fontSize === null);
  assert.deepEqual(missing, [], `${label}: на этих кадрах (>=2) субтитр так и не появился за отведённое время опроса: ${JSON.stringify(missing)}`);

  const sizes = new Set(withCaption.map((p) => p.fontSize));
  assert.equal(sizes.size, 1, `${label}: fontSize обязан быть одинаковым на каждом кадре одного chunk, получили: ${JSON.stringify([...sizes])} (полные данные: ${JSON.stringify(withCaption)})`);

  for (const p of withCaption) {
    assert.ok(p.scrollWidth <= p.clientWidth + 1, `${label} frame ${p.frame}: текст обрезан – scrollWidth=${p.scrollWidth} > clientWidth=${p.clientWidth} (fontSize=${p.fontSize})`);
    const actual = parseFloat(p.fontSize);
    // Эталон ищет тем же бинарным поиском; разница только в round1 эталона (шаг поиска 0,25 →
    // до 0,05 px), поэтому допуск 0,1 px: заметно другой кегль значит замер другим шрифтом.
    assert.ok(Math.abs(actual - p.referenceFontSize) <= 0.1,
      `${label} frame ${p.frame}: фактический кегль ${actual}px разошёлся с независимым эталоном ${p.referenceFontSize}px (замер, вероятно, случился до готовности Onest)`);
  }
}

test('Subtitles reports the same, correct fontSize on every frame of a wide all-caps caption, and never clips, across a real concurrent Remotion render', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 180_000,
}, async (t) => {
  // Тот же класс текста, что и в измерениях ревью – «28 caps worst». Только шрифт, уже отслеженный
  // в ASSETS.md (public/fonts/Onest.ttf) – новых бинарников не добавляем.
  const probes = await renderFixture(t, { text: 'ШИРОКОМАСШТАБНЫЕ ЖЖЁНЫЕ МЫШИ' });
  assertVariant(probes, 'caps');
});

test('Subtitles reports the same, correct fontSize on every frame of a lowercase fontSize:60 caption, and never clips', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 180_000,
}, async (t) => {
  // Строчная фраза при явном fontSize:60 – «сильная» фикстура ревью: фолбэк-шрифт здесь УЖЕ Onest,
  // поэтому неверный ранний замер решил бы «влезает, 60px», не сжимая – и обрезка стала бы видна,
  // как только настоящий (более широкий для этого текста) Onest реально нарисовался бы.
  const probes = await renderFixture(t, { text: 'и вот оно автоматизированное', fontSize: 60 });
  assertVariant(probes, 'lowercase-60');
});

// Round 3 (важно, ревью п.2б): FontLoader рядом с Subtitles (а не оборачивающий его) – та самая
// ошибка использования из ревью, которая раньше молча возвращала гонку. Теперь FontLoader без
// children в браузере бросает явную ошибку – проверяем это в НАСТОЯЩЕМ Remotion-рендере (юнит-тест
// на throw – отдельно, в tests/motion-kit-components.test.js, с фейковым document).
test('using FontLoader as a sibling of Subtitles (not wrapping it) fails the real render loudly instead of racing silently', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 180_000,
}, async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderStill, selectComposition } = require('@remotion/renderer');
  const { withMotionKitAlias } = require('../scripts/remotion-webpack');

  const root = path.join(__dirname, '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-kit-render-sibling-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const srcDir = path.join(work, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const entryPoint = path.join(srcDir, 'index.jsx');
  fs.writeFileSync(entryPoint, `
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { FontLoader, Subtitles } from '@automontage/motion-kit';

const FONTS = [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }];
const CHUNKS = [{ units: [{ t: 'x', s: 0, e: 0.3 }], s: 0, e: 0.3, show: 10, text: 'x' }];
const LANE = { x: 70, y: 1398, w: 880, h: 84 };

function Layer() {
  return (
    <AbsoluteFill style={{ backgroundColor: '#222' }}>
      <FontLoader faces={FONTS} />
      <Subtitles chunks={CHUNKS} lane={LANE} fontFamily="KitOnest" />
    </AbsoluteFill>
  );
}

registerRoot(() => (
  <Composition id="Layer" component={Layer} durationInFrames={10} fps={25} width={1080} height={1920} />
));
`);

  const serveUrl = await bundle({ entryPoint, publicDir: path.join(root, 'public'), outDir: path.join(work, 'bundle'), webpackOverride: withMotionKitAlias });
  const browser = await openBrowser('chrome', { logLevel: 'error' });
  t.after(() => browser.close({ silent: true }));
  const composition = await selectComposition({ serveUrl, id: 'Layer', puppeteerInstance: browser });
  await assert.rejects(
    () => renderStill({ serveUrl, composition, frame: 5, output: path.join(work, 'still.png'), puppeteerInstance: browser, logLevel: 'error' }),
    /FontLoader/,
    'a FontLoader with no children next to Subtitles must fail the render, not silently race',
  );
});

// Проба Task 49: заливка краёв (fill) за резким спикером давала жёсткий шов – на боковых L/R
// вертикальный, на пресетах со сдвигом dy горизонтальный: резкая копия обрывалась, дальше – полоса
// размытой затемнённой копии ~110 px. Кадр однотонный, поэтому любой перепад в профиле яркости –
// это шов, а не содержимое. Меряем средний профиль поперёк бывшего шва (по столбцам для L/R, по
// строкам для dy) и требуем, чтобы соседние столбцы/строки отличались не больше чем на 4 уровня из
// 255, а заливка при этом действительно была видна (край темнее центра хотя бы на 20 уровней).
const SEAM_FIXTURE = `
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { SpeakerLayer, compileCamera } from '@automontage/motion-kit';

const CFG = { fps: 25, width: 1080, height: 1920, durationInFrames: 100 };
const PRESETS = { low: { s: 1.1, dy: -260, fill: true } };

function Layer({ preset, src }) {
  const track = compileCamera({ face: { x: 540, y: 787 }, presets: PRESETS, shots: [{ at: 0, preset, drift: 'none' }] }, CFG);
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <SpeakerLayer src={src} track={track} />
    </AbsoluteFill>
  );
}

registerRoot(() => (
  <Composition id="Layer" component={Layer} defaultProps={{ preset: 'L', src: 'speaker.mp4' }} {...CFG} />
));
`;

// Общая часть кадров спикера: бандл фикстуры, однотонные исходники (speaker.mp4 в размер кадра и
// tall.mp4 другой пропорции, 1080×1350), кадр → яркость по пикселям и средние профили.
async function speakerStills(t) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderStill, selectComposition } = require('@remotion/renderer');
  const { withMotionKitAlias } = require('../scripts/remotion-webpack');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-kit-render-seam-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const srcDir = path.join(work, 'src');
  const publicDir = path.join(work, 'public');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.jsx'), SEAM_FIXTURE);
  for (const [file, size] of [['speaker.mp4', '1080x1920'], ['tall.mp4', '1080x1350']]) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xD0B090:s=${size}:r=25:d=4`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(publicDir, file)], { shell: false });
  }
  const serveUrl = await bundle({
    entryPoint: path.join(srcDir, 'index.jsx'), publicDir, outDir: path.join(work, 'bundle'),
    webpackOverride: (config) => withMotionKitAlias(config),
  });
  const browser = await openBrowser('chrome', { logLevel: 'error' });
  t.after(() => browser.close({ silent: true }));

  const gray = (file) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { shell: false, maxBuffer: 16 * 1024 * 1024 });
  let n = 0;
  const still = async ({ preset, src = 'speaker.mp4', frame = 0 }) => {
    const inputProps = { preset, src };
    const composition = await selectComposition({ serveUrl, id: 'Layer', inputProps, puppeteerInstance: browser });
    const output = path.join(work, `still-${n += 1}.png`);
    await renderStill({ serveUrl, composition, frame, output, inputProps, imageFormat: 'png', puppeteerInstance: browser, logLevel: 'error' });
    return gray(output);
  };
  // across: 'x' – профиль по столбцам (шов вертикальный), 'y' – по строкам (шов горизонтальный);
  // усредняем по полосе в середине другой оси, чтобы не задеть углы кадра.
  const profile = (pixels, across) => {
    const [w, h] = [1080, 1920];
    const out = [];
    if (across === 'x') {
      for (let x = 0; x < w; x += 1) { let sum = 0; for (let y = 700; y < 1300; y += 1) sum += pixels[y * w + x]; out.push(sum / 600); }
    } else {
      for (let y = 0; y < h; y += 1) { let sum = 0; for (let x = 300; x < 780; x += 1) sum += pixels[y * w + x]; out.push(sum / 480); }
    }
    return out;
  };
  return { still, profile };
}

test('fill presets (L, R, top, custom dy) blend the sharp speaker into the fill without a hard seam in real stills', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 300_000,
}, async (t) => {
  const { still, profile } = await speakerStills(t);
  const cases = [['L', 'x', 1079], ['R', 'x', 0], ['top', 'y', 0], ['low', 'y', 1919]];
  const report = [];
  for (const [preset, across, edge] of cases) {
    const p = profile(await still({ preset }), across);
    let maxStep = 0;
    let at = 0;
    for (let i = 1; i < p.length; i += 1) if (Math.abs(p[i] - p[i - 1]) > maxStep) { maxStep = Math.abs(p[i] - p[i - 1]); at = i; }
    const center = p[Math.floor(p.length / 2)];
    report.push({ preset, maxStep: Number(maxStep.toFixed(2)), at, center: Number(center.toFixed(1)), edge: Number(p[edge].toFixed(1)) });
  }
  t.diagnostic(JSON.stringify(report));
  for (const r of report) {
    assert.ok(r.center - r.edge >= 20, `${r.preset}: заливка у края не видна (центр ${r.center}, край ${r.edge}) – кадр ничего не проверяет`);
    assert.ok(r.maxStep <= 4, `${r.preset}: жёсткий шов – соседние ${r.preset === 'L' || r.preset === 'R' ? 'столбцы' : 'строки'} ${r.at - 1}/${r.at} отличаются на ${r.maxStep} уровней`);
  }
});

// Ревью мягкого края: вложенный блок маски без стиля на планах без заливки ломал cover-кадрирование –
// height: 100% видео считался от блока с высотой auto, и исходник другой пропорции (1080×1350 в
// кадре 1080×1920) оставлял снизу чёрную полосу ~570 px. Видео обязано закрывать весь кадр.
test('a speaker file of another aspect is still cover-cropped to the whole frame on shots without fill', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 300_000,
}, async (t) => {
  const { still, profile } = await speakerStills(t);
  for (const preset of ['W', 'M', 'L']) {
    const rows = profile(await still({ preset, src: 'tall.mp4' }), 'y');
    const darkest = Math.min(...rows);
    t.diagnostic(`${preset}: самая тёмная строка ${darkest.toFixed(1)}, строка 1919 ${rows[1919].toFixed(1)}`);
    assert.ok(darkest >= 170, `${preset}: в кадре чёрная полоса – самая тёмная строка ${darkest.toFixed(1)} (строка ${rows.indexOf(darkest)})`);
  }
});
