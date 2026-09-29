const test = require('node:test');
const assert = require('node:assert/strict');

// Настоящий Remotion-рендер шаблона слоя (опт-ин, npm test его не трогает): на каждом контрольном
// кадре проверяет, что ОЖИДАЕМЫЕ [data-kit-text] действительно в разметке (регрессия, которая тихо
// роняет или сжимает титул до невидимости, иначе прошла бы — кадр 5 держит только субтитры, а кадр
// 40 совпал бы «случайно»), и что каждый найденный бокс — и текстовый, и субтитровый по ширине/высоте
// — не выходит за safe-zone контракта слоя. Перехват page.close — тот же приём, что в
// tests/motion-render.test.js:100-140: измерить ровно тот DOM, который renderStill только что
// сфотографировал (renderStill сам ждёт все delayRender — гейт FontLoader и подгонку кегля
// Subtitles, — так что разметка уже готова; см. tests/motion-kit-render.test.js, Task 18, про то же
// ожидание в настоящем браузере).
test('real Remotion stills of the template show the expected kit texts inside the safe zone', {
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
  // очищаем, чтобы «кадр без текста» не подхватил боксы предыдущего кадра по ошибке. texts —
  // [data-kit-text] (титул, карточка, полоса субтитров), bleeds — id полноэкранных вставок
  // (FullscreenReveal/StockInsert рисуют data-kit-bleed=insert.id, не data-kit-text).
  const measured = [];
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    const close = page.close.bind(page);
    page.close = async (...closeArgs) => {
      try {
        const result = await page.evaluate(() => ({
          texts: [...document.querySelectorAll('[data-kit-text]')].map((box) => {
            const rect = box.getBoundingClientRect();
            return {
              id: box.getAttribute('data-kit-text'),
              rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              scrollWidth: box.scrollWidth, clientWidth: box.clientWidth,
              scrollHeight: box.scrollHeight, clientHeight: box.clientHeight,
            };
          }),
          bleeds: [...document.querySelectorAll('[data-kit-bleed]')].map((el) => el.getAttribute('data-kit-bleed')),
        }));
        if (result.texts.length || result.bleeds.length) measured.push(result);
      } finally { await close(...closeArgs); }
    };
    return page;
  };

  // Кадры реального 10-секундного шаблона (fps=25, templates/motion-layer/src/plan.js): титул
  // (at:0.2, pop-вход) полностью непрозрачен уже на 15-м кадре (0,6 с) — на 5-м (0,2 с, ровно
  // item.from) его opacity ещё точно 0 по анимации входа, виден только caption; 40 (1,6 с) — тоже
  // внутри окна титула (0,2–2,4 с) и субтитров; 90 (3,6 с) — середина скриншот-карточки (окно
  // 3,0–5,6 с) и субтитров; 160 (6,4 с) — сток (окно 6–8 с, раскрытие закончилось к кадру 159):
  // по plan.js captions.hide на это время субтитры спрятаны, поэтому [data-kit-text] там не должно
  // быть вовсе, а сама вставка обязана быть на экране (data-kit-bleed).
  const FRAMES = [
    { frame: 15, mustInclude: ['title', 'captions'] },
    { frame: 40, mustInclude: ['title', 'captions'] },
    { frame: 90, mustInclude: ['screenshot', 'captions'] },
    { frame: 160, mustInclude: [] },
  ];
  for (const { frame, mustInclude } of FRAMES) {
    measured.length = 0;
    const output = path.join(layerDir, 'out', `still-${frame}.png`);
    await renderStill({ serveUrl, composition, frame, output, puppeteerInstance: browser, onBrowserLog: () => {}, overwrite: true });
    assert.ok(fs.statSync(output).size > 1000, `frame ${frame}: пустой PNG`);
    const { texts, bleeds } = measured.at(-1) || { texts: [], bleeds: [] };
    const ids = texts.map((box) => box.id);
    for (const id of mustInclude) {
      assert.ok(ids.includes(id), `frame ${frame}: ожидали [data-kit-text="${id}"], в разметке ${JSON.stringify(ids)}`);
    }
    if (mustInclude.length === 0) {
      // Только кадр 160 в этом наборе: под стоковой вставкой не должно остаться ни одного текстового
      // бокса (субтитры спрятаны planом), а сама вставка обязана быть видна на экране.
      assert.equal(texts.length, 0, `frame ${frame}: под вставкой не должно быть [data-kit-text], нашли ${JSON.stringify(ids)}`);
      assert.ok(bleeds.length, `frame ${frame}: сток должен быть виден ([data-kit-bleed]), элементов нет`);
    }
    for (const box of texts) {
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
