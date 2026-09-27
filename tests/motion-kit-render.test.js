const test = require('node:test');
const assert = require('node:assert/strict');

// Round 2 (ревью minor 4/regression): настоящий Remotion-рендер с concurrency>1 обнаружил, что
// подгонка ширины субтитров была недетерминирована между «вкладками» рендера — какой кадр браузер
// откроет первым, недетерминировано, и Subtitles мог измерить текст ДО того, как FontLoader успел
// догрузить шрифт. Юнит-тесты на renderToStaticMarkup не могут это поймать: layout-эффекты (и
// document.fonts) там вообще не выполняются (см. tests/helpers/remotion-stub.js). Этот тест — как
// последний тест в tests/motion-render.test.js: настоящий бандл + настоящий headless Chromium,
// пропускается по умолчанию и включается только явным флагом (`npm test` его не трогает).
test('Subtitles reports the same fontSize on every frame of a wide caption, and never clips, across a real concurrent Remotion render', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 180_000,
}, async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderFrames, selectComposition } = require('@remotion/renderer');
  const { withMotionKitAlias } = require('../scripts/remotion-webpack');

  const root = path.join(__dirname, '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-kit-render-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // Композиция-фикстура: FontLoader-гейт + Subtitles с широкой ЗАГЛАВНОЙ фразой (тот же класс
  // текста из измерений ревью — «28 caps worst»), видимой С ПЕРВОГО кадра. Только шрифт, уже
  // отслеженный в ASSETS.md (public/fonts/Onest.ttf) — новых бинарников не добавляем.
  const srcDir = path.join(work, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const entryPoint = path.join(srcDir, 'index.jsx');
  fs.writeFileSync(entryPoint, `
import { useLayoutEffect } from 'react';
import { AbsoluteFill, Composition, registerRoot, useCurrentFrame, delayRender, continueRender } from 'remotion';
import { FontLoader, Subtitles } from '@automontage/motion-kit';

const FONTS = [{ family: 'KitOnest', file: 'fonts/Onest.ttf' }];
const units = (text, s) => text.split(' ').map((t, i) => ({ t, s: s + i * 0.1, e: s + i * 0.1 + 0.1 }));
const chunk = (text, s, show) => ({ units: units(text, s), s, e: s + 0.4, show, text });
const CHUNKS = [chunk('ШИРОКОМАСШТАБНЫЕ ЖЖЁНЫЕ МЫШИ', 0, 2.4)];
const LANE = { x: 70, y: 1398, w: 880, h: 84 };

function Probe() {
  const frame = useCurrentFrame();
  useLayoutEffect(() => {
    const handle = delayRender('probe');
    // Опрашиваем, пока не появится сама коробка субтитров (гейт FontLoader может ещё не открыться
    // на первом кадре, который эта вкладка рендерит) — иначе Probe снял бы состояние ДО того, как
    // тот же delayRender FontLoader-а разрешил Remotion сделать реальный скриншот, и увидел бы
    // гонку, которой в самом сохранённом кадре нет.
    let tries = 0;
    const tick = () => {
      const box = document.querySelector('[data-kit-text="captions"]');
      if (!box && tries++ < 200) { setTimeout(tick, 10); return; }
      const span = box && box.firstElementChild;
      console.log('PROBE ' + JSON.stringify({
        frame,
        fontSize: span ? span.style.fontSize : null,
        scrollWidth: span ? span.scrollWidth : null,
        clientWidth: box ? box.clientWidth : null,
      }));
      continueRender(handle);
    };
    tick();
  }, [frame]);
  return null;
}

function Layer() {
  return (
    <AbsoluteFill style={{ backgroundColor: '#222' }}>
      <FontLoader faces={FONTS}>
        <Subtitles chunks={CHUNKS} lane={LANE} fontFamily="KitOnest" />
      </FontLoader>
      <Probe />
    </AbsoluteFill>
  );
}

registerRoot(() => (
  <Composition id="Layer" component={Layer} durationInFrames={40} fps={25} width={1080} height={1920} />
));
`);

  const serveUrl = await bundle({
    entryPoint, publicDir: path.join(root, 'public'), outDir: path.join(work, 'bundle'),
    webpackOverride: withMotionKitAlias,
  });
  const browser = await openBrowser('chrome', { logLevel: 'error' });
  t.after(() => browser.close({ silent: true }));

  const probes = [];
  const onBrowserLog = (l) => {
    const text = l.text || '';
    const marker = 'PROBE ';
    if (text.includes(marker)) probes.push(JSON.parse(text.slice(text.indexOf(marker) + marker.length)));
  };

  const composition = await selectComposition({ serveUrl, id: 'Layer', puppeteerInstance: browser });
  const outputDir = path.join(work, 'frames');
  fs.mkdirSync(outputDir, { recursive: true });
  // concurrency>1 — то самое условие ревью (несколько «вкладок» рендерят разные кадры параллельно,
  // и то, какой кадр откроется первым внутри одной вкладки, недетерминировано между прогонами).
  await renderFrames({
    serveUrl, composition, outputDir, imageFormat: 'jpeg', inputProps: {},
    puppeteerInstance: browser, concurrency: 4, onBrowserLog,
    onStart: () => {}, onFrameUpdate: () => {},
  });

  assert.equal(probes.length, 40, `ожидали ровно один PROBE-лог на кадр (0..39), получили ${probes.length}`);
  // Probe сам ждёт появления коробки (см. tick() выше), поэтому к моменту лога гейт FontLoader уже
  // обязан быть открыт на КАЖДОМ кадре, включая самый первый кадр, который рендерит каждая из
  // параллельных вкладок (именно они воспроизводили баг из ревью) — ни одного null не ожидаем.
  const missing = probes.filter((p) => p.fontSize === null);
  assert.deepEqual(missing, [], `на этих кадрах субтитр так и не появился за отведённое время опроса: ${JSON.stringify(missing)}`);

  const sizes = new Set(probes.map((p) => p.fontSize));
  assert.equal(sizes.size, 1, `fontSize обязан быть одинаковым на каждом кадре одного chunk, получили: ${JSON.stringify([...sizes])} (полные данные: ${JSON.stringify(probes)})`);

  for (const p of probes) {
    assert.ok(p.scrollWidth <= p.clientWidth + 1, `frame ${p.frame}: текст обрезан — scrollWidth=${p.scrollWidth} > clientWidth=${p.clientWidth} (fontSize=${p.fontSize})`);
  }
});
