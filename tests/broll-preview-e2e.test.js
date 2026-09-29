const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { expect } = require('playwright/test');
const {
  createOrOpenProject,
  publishBriefRevision,
  readProjectManifest,
} = require('../scripts/project/workspace');
const { startReviewServer } = require('../scripts/review/server');
const { resolveRemotionCommand } = require('../scripts/env');
const ROOT = path.resolve(__dirname, '..');
// Ждём само preview-задание, а не косвенный признак в интерфейсе: сбой виден сразу и с причиной.
const PREVIEW_JOB_TIMEOUT_MS = 180000;
// Хвост вывода preview.js. Если процесс уже закрылся, сначала дожидаемся записи лога до конца.
async function outputTail(log) {
  if (!log) return '(preview.js не запускался)';
  if (log.closed) await log.finished;
  try {
    return fs.readFileSync(log.file, 'utf8').slice(-4000);
  } catch (_) {
    return '(вывода нет)';
  }
}
function run(command, args) {
  return execFileSync(command, args, {
    cwd: ROOT,
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const heavy = process.env.npm_lifecycle_event === 'test';
test(
  'real discovery browser Save, excerpt/full Remotion, explicit approval and approved final full decode',
  {
    timeout: 600000,
    skip: heavy
      ? 'Dedicated sequential Remotion acceptance; run node --test tests/broll-preview-e2e.test.js'
      : false,
  },
  async (t) => {
    const dir = path.join(
      ROOT,
      'tmp',
      'broll-preview-e2e',
      `${Date.now()}-${process.pid}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    // Свежая установка качает браузер Remotion при первом рендере. Делаем это здесь, до
    // ожидания preview: иначе скорость сети съедает таймаут первого preview-задания.
    const remotion = resolveRemotionCommand(ROOT);
    run(remotion.command, [...remotion.argsPrefix, 'browser', 'ensure']);
    const source = path.join(dir, 'source.mp4');
    const clip = path.join(dir, 'clip.mp4');
    const poster = path.join(dir, 'poster.jpg');
    for (const [file, color] of [
      [source, 'red'],
      [clip, 'blue'],
    ])
      run('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=320x180:r=25:d=2`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        file,
      ]);
    run('ffmpeg', ['-v', 'error', '-i', clip, '-frames:v', '1', poster]);
    const workspace = createOrOpenProject({
      projectDir: path.join(dir, 'project'),
      name: 'Preview acceptance',
      sourcePath: source,
    });
    const brief = {
      version: 1,
      status: 'draft',
      source: workspace.sourcePath,
      theme: 'lesson-neutral',
      title: 'ЦВЕТ',
      brollReviewPolicy: 'preview-required',
      output: {
        aspect: 'horizontal',
        width: 320,
        height: 180,
        fps: 25,
        durationInFrames: 50,
      },
      corrections: [],
      scenes: [
        {
          scene: 'broll',
          start: 0,
          end: 2,
          headCream: 'СИНИЙ',
          headOrange: 'ЦВЕТ',
          brollIntent: {
            goal: 'Показать синий цвет',
            sourceText: 'Синий цвет',
            queryOriginal: 'синий цвет',
            queryEnglish: 'blue color',
          },
        },
      ],
    };
    publishBriefRevision(workspace, { brief, markdown: '# Color' });
    fs.writeFileSync(
      path.join(workspace.dir, 'transcript', 'words.json'),
      JSON.stringify([
        {
          start: 0,
          end: 2,
          text: 'Синий цвет',
          words: [
            { w: 'Синий', s: 0, e: 0.5 },
            { w: 'цвет', s: 0.6, e: 1.3 },
          ],
        },
      ]),
    );
    const candidate = {
      provider: 'pexels',
      providerAssetId: '123',
      sourcePage: 'https://www.pexels.com/video/blue-123/',
      author: { name: 'Example', url: 'https://www.pexels.com/@example/' },
      license: {
        name: 'Pexels License',
        url: 'https://www.pexels.com/license/',
      },
      queryOriginal: 'синий цвет',
      queryEnglish: 'blue color',
      retrievedAt: '2026-09-08T00:00:00.000Z',
      rendition: { id: '123', width: 320, height: 180, mimeType: 'video/mp4' },
      mediaKind: 'video',
      width: 320,
      height: 180,
      durationSec: 2,
      hasAudio: null,
      thumbnailUrl: 'https://images.pexels.com/poster.jpg',
      previewUrl: null,
      downloadUrl: 'https://videos.pexels.com/clip.mp4',
    };
    let fullDownloads = 0;
    // Настоящий spawn preview.js; тест лишь сохраняет его вывод, чтобы показать его при сбое.
    const previewLogs = [];
    const previewSpawnImpl = (command, args, options) => {
      const child = spawn(command, args, options);
      const file = path.join(dir, `preview-job-${previewLogs.length + 1}.log`);
      const stream = fs.createWriteStream(file);
      const log = {
        file,
        closed: false,
        finished: new Promise((resolve) => stream.once('close', resolve)),
      };
      previewLogs.push(log);
      child.stdout?.on('data', (chunk) => stream.write(chunk));
      child.stderr?.on('data', (chunk) => stream.write(chunk));
      child.once('close', (code, signal) => {
        log.closed = true;
        stream.end(`\n[preview.js: ${signal || code}]\n`);
      });
      return child;
    };
    const session = await startReviewServer({
      root: ROOT,
      projectDir: workspace.dir,
      editable: true,
      open: false,
      previewSpawnImpl,
      brollProvider: {
        search: async () => ({ candidates: [candidate], nextPage: null }),
      },
      brollDownload: async ({ url }) => {
        const full = url.endsWith('clip.mp4');
        if (full) fullDownloads++;
        return {
          bytes: fs.readFileSync(full ? clip : poster),
          contentType: full ? 'video/mp4' : 'image/jpeg',
        };
      },
    });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    t.after(async () => {
      await browser.close();
      await new Promise((resolve) => session.server.close(resolve));
      await session.waitForActiveImports();
    });
    page.on('dialog', (dialog) => dialog.accept());
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const previewJobs = new Map();
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (url.pathname !== '/api/broll/preview-job') return;
      // Ключ – id из запроса: у ответа с ошибкой нет jobId, а интерфейс после такого ответа
      // опрос прекращает, поэтому ожидание должно закончиться сразу.
      const id = url.searchParams.get('id');
      let body = null;
      try {
        body = await response.json();
      } catch (_) {
        /* тело без JSON: код HTTP всё равно попадёт в сообщение */
      }
      if (!response.ok()) {
        previewJobs.set(id, { status: 'poll-failed', http: response.status(), error: body?.error });
        return;
      }
      const { state: _state, ...job } = body || {};
      previewJobs.set(id, job.status ? job : { status: 'poll-failed', http: response.status() });
    });
    async function runPreview(buttonName) {
      const started = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/broll/preview' &&
          response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: buttonName, exact: true }).click();
      const response = await started;
      const body = await response.json();
      assert.equal(response.status(), 202, `preview не запущен: ${JSON.stringify(body)}`);
      try {
        await expect
          .poll(() => previewJobs.get(body.jobId)?.status ?? 'running', {
            timeout: PREVIEW_JOB_TIMEOUT_MS,
          })
          .not.toBe('running');
      } catch (error) {
        throw new Error(
          `preview-задание не завершилось за ${PREVIEW_JOB_TIMEOUT_MS / 1000} с; вывод preview.js:\n${await outputTail(previewLogs.at(-1))}`,
          { cause: error },
        );
      }
      const job = previewJobs.get(body.jobId);
      if (job.status !== 'complete') {
        const where = job.status === 'poll-failed' ? `опрос вернул HTTP ${job.http}` : 'задание упало';
        assert.fail(
          `preview: ${where}, ${job.error || 'без кода'}${job.reason ? `: ${job.reason}` : ''}; вывод preview.js:\n${await outputTail(previewLogs.at(-1))}`,
        );
      }
    }
    await page.goto(session.url);
    await expect(page.locator('main')).toHaveAttribute('data-review-ready', '');
    await expect(
      page.getByRole('button', { name: 'Утвердить', exact: true }),
    ).toBeDisabled();
    // Pending intent must use the real draft placeholder, never approval.
    await runPreview('Полный preview');
    await expect(page.getByLabel('Я посмотрел полный preview')).toBeEnabled({timeout:15000});
    const pendingHeaders = {Authorization:`Bearer ${session.token}`,Origin:session.origin};
    const pendingState = await (await page.request.get(session.origin+'/api/state',{headers:pendingHeaders})).json();
    const pendingApproval = await page.request.post(session.origin+'/api/broll/approve',{headers:pendingHeaders,data:{baseRevision:pendingState.session.baseRevision,baseHash:pendingState.session.baseHash,manifestHash:pendingState.session.manifestHash,confirmPreviewViewed:true}});
    assert.equal(pendingApproval.status(),422);
    assert.equal(fullDownloads,0);
    const pendingPreview = readProjectManifest(workspace.dir).currentPreview;
    assert.equal(pendingPreview.kind,'full');
    run('ffmpeg',['-v','error','-i',path.join(workspace.dir,pendingPreview.filePath),'-f','null','-']);
    await page
      .getByRole('button', { name: 'Подобрать B-roll', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Выбрать', exact: true }),
    ).toBeVisible();
    assert.equal(fullDownloads, 0);
    await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Сохранить', exact: true }),
    ).toBeEnabled({ timeout: 60000 });
    assert.equal(fullDownloads, 1);
    const ack = page.getByLabel('Разрешить встроенный текст');
    if (await ack.count()) await ack.check();
    await expect(
      page.getByRole('button', { name: 'Полный preview', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Полный preview', exact: true }),
    ).toBeEnabled();
    assert.equal(
      readProjectManifest(workspace.dir).briefs.at(-1).status,
      'draft',
    );
    await runPreview('Preview фрагмента');
    await expect(
      page.getByRole('button', { name: 'Полный preview', exact: true }),
    ).toBeEnabled({ timeout: 15000 });
    assert.equal(
      readProjectManifest(workspace.dir).currentPreview?.kind,
      'excerpt',
    );
    await expect(page.getByLabel('Я посмотрел полный preview')).toBeDisabled();
    await runPreview('Полный preview');
    await expect(page.getByLabel('Я посмотрел полный preview')).toBeEnabled({
      timeout: 15000,
    });
    assert.equal(
      readProjectManifest(workspace.dir).currentPreview.kind,
      'full',
    );
    assert.equal(
      readProjectManifest(workspace.dir).briefs.at(-1).status,
      'draft',
    );
    await expect(
      page.getByRole('button', { name: 'Утвердить', exact: true }),
    ).toBeDisabled();
    const mounted = page.locator('video[data-preview-video]');
    await expect
      .poll(() => mounted.evaluate((video) => video.readyState), {
        timeout: 15000,
      })
      .toBeGreaterThanOrEqual(2);
    await mounted.evaluate(async (video) => {
      video.muted = true;
      await video.play();
    });
    await expect
      .poll(() => mounted.evaluate((video) => video.currentTime))
      .toBeGreaterThan(0.5);
    await mounted.evaluate((video) => {
      video.pause();
      video.currentTime = 1;
    });
    await expect
      .poll(() =>
        mounted.evaluate((video) => !video.seeking && video.readyState >= 2),
      )
      .toBe(true);
    await page.getByLabel('Я посмотрел полный preview').check();
    await page.getByRole('button', { name: 'Утвердить', exact: true }).click();
    await expect(
      page.getByText('Утверждено. Финальный рендер запускается отдельно.'),
    ).toBeVisible();
    await expect(page.locator('[data-preview-kind]')).toHaveText(
      'ПОЛНЫЙ РОЛИК',
    );
    await page.screenshot({
      path: path.join(dir, 'approved-review.png'),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    const approvedManifest = readProjectManifest(workspace.dir);
    assert.equal(approvedManifest.renders.length, 0);
    const approved = JSON.parse(
      fs.readFileSync(path.join(workspace.dir, approvedManifest.currentBrief)),
    );
    assert.ok(approved.brollApproval);
    assert.equal(approved.scenes[0].brollIntent, undefined);
    run(process.execPath, [
      path.join(ROOT, 'scripts', 'build.js'),
      workspace.sourcePath,
      '--template',
      'lesson',
      '--project-dir',
      workspace.dir,
      '--brief',
      approvedManifest.currentBrief,
      '--version-label',
      'preview-acceptance',
    ]);
    const manifest = readProjectManifest(workspace.dir);
    const final = path.join(workspace.dir, manifest.final);
    run('ffmpeg', ['-v', 'error', '-i', final, '-f', 'null', '-']);
    const pixels = run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      '1',
      '-i',
      final,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    let blue = 0;
    for (let i = 0; i < pixels.length; i += 3)
      if (pixels[i + 2] > pixels[i] + 40 && pixels[i + 2] > pixels[i + 1] + 40)
        blue++;
    assert.ok(
      blue > 320 * 180 * 0.15,
      'chosen blue media must appear in actual final',
    );
    assert.equal(manifest.renders.at(-1).status, 'complete');
    // A later edit of this newly approved discovery brief must require a fresh viewing.
    // A hash-only navigation would keep the stale pre-render manifest in the old page.
    await page.goto('about:blank');
    await page.goto(session.url);
    await expect(page.locator('main')).toHaveAttribute('data-review-ready', '');
    await page.locator('[data-broll-fit]').selectOption('cover');
    await expect(
      page.getByRole('button', { name: 'Сохранить', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Полный preview', exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel('Я посмотрел полный preview')).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Утвердить', exact: true }),
    ).toBeDisabled();
    await expect(page.locator('[data-preview-kind]')).toContainText('УСТАРЕЛ');
    const changedManifest = readProjectManifest(workspace.dir);
    const changed = JSON.parse(
      fs.readFileSync(path.join(workspace.dir, changedManifest.currentBrief)),
    );
    assert.equal(changed.status, 'draft');
    assert.equal(changed.brollApproval, undefined);
    assert.equal(changed.brollReviewPolicy, 'preview-required');
    assert.equal(changedManifest.renders.length, manifest.renders.length);
    await page.screenshot({
      path: path.join(dir, 'edited-draft-review.png'),
      fullPage: true,
    });
    fs.writeFileSync(
      path.join(dir, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          fullDownloads,
          bluePixels: blue,
          preview: manifest.currentPreview,
          final,
        },
        null,
        2,
      ),
    );
    console.log(`Real preview acceptance artifacts: ${dir}`);
  },
);
