const test = require('node:test');
const assert = require('node:assert/strict');

// Настоящий Remotion-рендер шаблона слоя (опт-ин, npm test его не трогает): измеряет каждый
// [data-kit-text] в реальном headless Chromium и сверяет с safe-zone контракта слоя. Перехват
// page.close — тот же приём, что в tests/motion-render.test.js:100-140: измерить ровно тот DOM,
// который renderStill только что сфотографировал (renderStill сам ждёт все delayRender — гейт
// FontLoader и подгонку кегля Subtitles, — так что [data-kit-text] уже в разметке; см.
// tests/motion-kit-render.test.js, Task 18, про то же ожидание в настоящем браузере).
test('real Remotion stills of the template keep every kit text inside the safe zone', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 300_000,
}, async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderStill, selectComposition } = require('@remotion/renderer');
  const { withMotionKitAlias } = require('../scripts/remotion-webpack');
  const { safeRect } = require('../scripts/qa/safe-rect');
  const { makeLayerProject } = require('./helpers/layer-project');
  const newLayer = require('../scripts/layer/new');

  const { projectDir, sfxDir } = makeLayerProject(t, { seconds: 10, size: '1080x1920' });
  process.env.AUTOMONTAGE_SFX_DIR = sfxDir;
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  assert.equal(await newLayer.run({ 'project-dir': projectDir }), 0);
  const layerDir = path.join(projectDir, 'motion-v01');

  const serveUrl = await bundle({
    entryPoint: path.join(layerDir, 'src', 'index.jsx'), publicDir: path.join(layerDir, 'public'),
    webpackOverride: (config) => withMotionKitAlias(config),
  });
  const browser = await openBrowser('chrome', { logLevel: 'error' });
  t.after(() => browser.close({ silent: true }));
  const composition = await selectComposition({ serveUrl, id: 'Layer', puppeteerInstance: browser });
  const safe = safeRect(1080, 1920);

  // measured копится по вкладкам, которые renderStill открывает и закрывает; перед каждым кадром её
  // очищаем, чтобы «сток без текста» не подхватил боксы предыдущего (ненулевого) кадра по ошибке.
  const measured = [];
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    const close = page.close.bind(page);
    page.close = async (...closeArgs) => {
      try {
        const boxes = await page.evaluate(() => [...document.querySelectorAll('[data-kit-text]')].map((box) => {
          const rect = box.getBoundingClientRect();
          return {
            id: box.getAttribute('data-kit-text'),
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            scrollWidth: box.scrollWidth, clientWidth: box.clientWidth,
            scrollHeight: box.scrollHeight, clientHeight: box.clientHeight,
          };
        }));
        if (boxes.length) measured.push(boxes);
      } finally { await close(...closeArgs); }
    };
    return page;
  };

  // Кадры реального 10-секундного шаблона (fps=25, templates/motion-layer/src/plan.js): 5 (0,2 с) и
  // 40 (1,6 с) — титул и субтитры; 90 (3,6 с) — середина скриншот-карточки (окно 3,0–5,6 с); 160
  // (6,4 с) — сток (окно 6–8 с, раскрытие закончилось к кадру 159). На 160-м кадре субтитры по плану
  // скрыты под вставкой (plan.js: captions.hide) — там проверяем только сам PNG, без текстовых боксов.
  const FRAMES = [
    { frame: 5, expectText: true },
    { frame: 40, expectText: true },
    { frame: 90, expectText: true },
    { frame: 160, expectText: false },
  ];
  for (const { frame, expectText } of FRAMES) {
    measured.length = 0;
    const output = path.join(layerDir, 'out', `still-${frame}.png`);
    await renderStill({ serveUrl, composition, frame, output, puppeteerInstance: browser, onBrowserLog: () => {}, overwrite: true });
    assert.ok(fs.statSync(output).size > 1000, `frame ${frame}: пустой PNG`);
    const boxes = measured.at(-1) || [];
    if (expectText) assert.ok(boxes.length, `frame ${frame}: ни один [data-kit-text] не измерен — пустой DOM не должен проходить`);
    for (const box of boxes) {
      const { rect } = box;
      assert.ok(rect.left >= safe.left - 0.5 && rect.right <= safe.right + 0.5
        && rect.top >= safe.top - 0.5 && rect.bottom <= safe.bottom + 0.5,
      `frame ${frame} (${box.id}): выход за safe-zone ${JSON.stringify({ rect, safe })}`);
      if (box.id === 'captions') {
        assert.ok(box.scrollWidth <= box.clientWidth + 1, `frame ${frame}: субтитры обрезаны по ширине ${JSON.stringify(box)}`);
        assert.ok(box.scrollHeight <= box.clientHeight + 1, `frame ${frame}: субтитры обрезаны по высоте ${JSON.stringify(box)}`);
      }
    }
  }
});
