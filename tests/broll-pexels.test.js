const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPexelsProvider } = require('../scripts/broll/pexels');
const photo = {
  id: 1,
  width: 1920,
  height: 1080,
  url: 'https://www.pexels.com/photo/cat-1/',
  photographer: 'Author',
  photographer_url: 'https://www.pexels.com/@author',
  src: {
    original: 'https://images.pexels.com/photos/1/full.jpg',
    tiny: 'https://images.pexels.com/photos/1/tiny.jpg',
    medium: 'https://images.pexels.com/photos/1/medium.jpg',
  },
};
const video = {
  id: 2,
  width: 1920,
  height: 1080,
  duration: 10,
  url: 'https://www.pexels.com/video/cat-2/',
  user: { name: 'Author', url: photo.photographer_url },
  image: photo.src.tiny,
  video_files: [
    {
      id: 21,
      width: 1920,
      height: 1080,
      file_type: 'video/mp4',
      link: 'https://videos.pexels.com/video-files/2/full.mp4',
    },
    {
      id: 22,
      width: 640,
      height: 360,
      file_type: 'video/mp4',
      link: 'https://player.vimeo.com/external/2.sd.mp4',
    },
  ],
};
const search = {
  queryOriginal: 'кот',
  queryEnglish: 'cat',
  mediaKind: 'image',
  orientation: 'landscape',
  minWidth: 1000,
};
test('missing key and upstream secret errors sanitized', async () => {
  await assert.rejects(createPexelsProvider({}).search(search), {
    code: 'BROLL_KEY_MISSING',
  });
  await assert.rejects(
    createPexelsProvider({
      apiKey: 'secret',
      request: async () => {
        throw new Error('secret');
      },
    }).search(search),
    (e) => e.message === 'BROLL_PROVIDER_FAILED',
  );
});
test('official photo path, bounded JSON, normalization dedupe filter pagination', async () => {
  const provider = createPexelsProvider({
    apiKey: 'secret',
    request: async (options) => {
      const url = new URL(options.url);
      assert.equal(url.pathname, '/v1/search');
      assert.equal(url.searchParams.get('per_page'), '12');
      assert.equal(options.maxBytes, 2097152);
      return {
        bytes: Buffer.from(
          JSON.stringify({
            photos: [
              photo,
              photo,
              { ...photo, id: 3, width: 30 },
              { ...photo, id: 4, url: 'https://evil.test/a' },
            ],
            next_page: 'https://evil.test/secret',
          }),
        ),
      };
    },
  });
  const result = await provider.search(search);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.nextPage, null);
  assert.equal(result.candidates[0].queryOriginal, 'кот');
});
test('video documented path, rendition filtering and distinct SD preview', async () => {
  const provider = createPexelsProvider({
    apiKey: 'key',
    request: async (o) => {
      assert.equal(new URL(o.url).pathname, '/v1/videos/search');
      return {
        bytes: Buffer.from(
          JSON.stringify({
            videos: [video],
            next_page: 'https://api.pexels.com/v1/videos/search?page=2',
          }),
        ),
      };
    },
  });
  const result = await provider.search({
    ...search,
    mediaKind: 'video',
    minDurationSec: 9,
  });
  assert.equal(result.candidates[0].width, 1920);
  assert.equal(result.candidates[0].previewUrl, video.video_files[1].link);
  assert.equal(result.nextPage, 2);
  assert.equal(
    (
      await provider.search({
        ...search,
        mediaKind: 'video',
        minDurationSec: 11,
      })
    ).candidates.length,
    0,
  );
});
test('video never previews full-only rendition and rejects hostile media', async () => {
  const request = async () => ({
    bytes: Buffer.from(
      JSON.stringify({
        videos: [
          { ...video, video_files: [video.video_files[0]] },
          {
            ...video,
            id: 3,
            video_files: [
              {
                ...video.video_files[0],
                link: 'https://127.0.0.1/private.mp4',
              },
            ],
          },
        ],
      }),
    ),
  });
  const { candidates } = await createPexelsProvider({
    apiKey: 'key',
    request,
  }).search({ ...search, mediaKind: 'video' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].previewUrl, null);
});
test('default video search selects full quality and keeps a distinct bounded preview', async () => {
  const provider = createPexelsProvider({
    apiKey: 'fixture-api-secret',
    request: async () => ({ bytes: Buffer.from(JSON.stringify({ videos: [{
      ...video,
      video_files: [
        ...video.video_files,
        { ...video.video_files[0], id: 23, width: 7680, height: 4320,
          link: 'https://videos.pexels.com/video-files/2/oversized.mp4' },
      ],
    }] })) }),
  });
  const { candidates } = await provider.search({
    queryOriginal: 'кот', queryEnglish: 'cat', mediaKind: 'video',
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rendition.id, '21');
  assert.equal(candidates[0].width, 1920);
  assert.equal(candidates[0].downloadUrl, video.video_files[0].link);
  assert.equal(candidates[0].previewUrl, video.video_files[1].link);
});
test('video search rejects renditions outside local importer geometry and duration limits', async () => {
  const provider = createPexelsProvider({
    apiKey: 'fixture-api-secret',
    request: async () => ({ bytes: Buffer.from(JSON.stringify({ videos: [
      { ...video, duration: 1801 },
      { ...video, id: 3, video_files: [{ ...video.video_files[0], width: 4096, height: 4096 }] },
      { ...video, id: 4, video_files: [{ ...video.video_files[0], width: 4097, height: 1000 }] },
    ] })) }),
  });
  assert.deepEqual((await provider.search({
    queryOriginal: 'кот', queryEnglish: 'cat', mediaKind: 'video',
  })).candidates, []);
});
test('successful provider payload cannot echo key through metadata', async () => {
  const secret = 'do-not-echo-secret';
  const provider = createPexelsProvider({
    apiKey: secret,
    request: async () => ({
      bytes: Buffer.from(
        JSON.stringify({ photos: [{ ...photo, photographer: secret }] }),
      ),
    }),
  });
  assert.deepEqual((await provider.search(search)).candidates, []);
});

const { validateProvenance } = require('../scripts/broll/provenance');
function provenanceOf(candidate) {
  const keys = ['provider', 'providerAssetId', 'sourcePage', 'author', 'license',
    'queryOriginal', 'queryEnglish', 'retrievedAt', 'rendition'];
  return Object.fromEntries(keys.map(key => [key, candidate[key]]));
}
function fixtureProvider(override = {}) {
  return createPexelsProvider({apiKey: 'fixture-api-secret', request: async () => ({
    bytes: Buffer.from(JSON.stringify({photos: [{...photo, ...override}]})),
  })});
}
test('provider emits NFKC Unicode metadata accepted by provenance contract', async () => {
  const { candidates } = await fixtureProvider({photographer: ' Jose\u0301 '}).search({
    ...search, queryOriginal: ' Cafe\u0301 ', queryEnglish: ' Ｃａｆｅ ',
  });
  assert.equal(candidates.length, 1);
  const provenance = validateProvenance(provenanceOf(candidates[0]));
  assert.equal(provenance.author.name, 'José');
  assert.equal(provenance.queryOriginal, 'Café');
  assert.equal(provenance.queryEnglish, 'Cafe');
});
test('provider text UTF8 byte boundaries match immutable provenance', async () => {
  const {candidates} = await fixtureProvider({photographer: 'é'.repeat(150)}).search({
    ...search, queryOriginal: 'é'.repeat(250), queryEnglish: 'é'.repeat(100),
  });
  assert.equal(candidates.length, 1);
  assert.doesNotThrow(() => validateProvenance(provenanceOf(candidates[0])));
  assert.equal((await fixtureProvider({photographer:'é'.repeat(150)+'a'}).search(search)).candidates.length, 0);
  for (const field of ['queryOriginal', 'queryEnglish']) {
    const value = 'é'.repeat(field === 'queryOriginal' ? 250 : 100) + 'a';
    await assert.rejects(fixtureProvider().search({...search,[field]:value}),{code:'BROLL_SEARCH_INVALID'});
  }
});
test('provider rejects Unicode control/format characters in text and raw URLs', async () => {
  for (const control of ['\u0000', '\n', '\t', '\u200b', '\u202e']) {
    await assert.rejects(fixtureProvider().search({...search,queryEnglish:`cat${control}`}),{code:'BROLL_SEARCH_INVALID'});
    assert.equal((await fixtureProvider({photographer:`Author${control}`}).search(search)).candidates.length, 0);
    assert.equal((await fixtureProvider({url:`https://www.pexels.com/photo/${control}cat-1/`}).search(search)).candidates.length, 0);
  }
});
test('provider canonical URL byte boundaries match provenance contract', async () => {
  const prefix = 'https://www.pexels.com/photo/';
  const url = prefix + 'a'.repeat(500 - prefix.length);
  const {candidates} = await fixtureProvider({url}).search(search);
  assert.equal(candidates.length, 1);
  assert.doesNotThrow(() => validateProvenance(provenanceOf(candidates[0])));
  assert.equal((await fixtureProvider({url:url+'a'}).search(search)).candidates.length, 0);
});
test('URL cap is checked after canonical percent encoding', async () => {
  const prefix = 'https://www.pexels.com/photo/';
  const url = prefix + 'é'.repeat(70);
  assert.ok(Buffer.byteLength(url) < 500);
  assert.ok(new URL(url).href.length < 500);
  const {candidates} = await fixtureProvider({url}).search(search);
  assert.equal(candidates.length, 1);
  assert.doesNotThrow(() => validateProvenance(provenanceOf(candidates[0])));
  const oversized = prefix + 'é'.repeat(80);
  assert.ok(Buffer.byteLength(oversized) < 500);
  assert.ok(new URL(oversized).href.length > 500);
  assert.equal((await fixtureProvider({url:oversized}).search(search)).candidates.length, 0);
});
// preferSize – для слоя motion-kit: самый маленький mp4, у которого обе стороны не меньше кадра слоя
// (короткая к короткой, длинная к длинной); если такого нет – самый большой, как по умолчанию.
const portraitVideo = {
  ...video,
  id: 5,
  url: 'https://www.pexels.com/video/cat-5/',
  width: 2160,
  height: 3840,
  video_files: [
    [2160, 3840, 51], [1080, 1920, 52], [720, 1280, 53], [540, 960, 54], [360, 640, 55],
  ].map(([width, height, id]) => ({ id, width, height, file_type: 'video/mp4', link: `https://videos.pexels.com/video-files/5/${id}.mp4` })),
};
const portraitSearch = { queryOriginal: 'кот', queryEnglish: 'cat', mediaKind: 'video', orientation: 'portrait' };
const videoProvider = (options) => createPexelsProvider({
  apiKey: 'key',
  request: async () => ({ bytes: Buffer.from(JSON.stringify({ videos: [portraitVideo] })) }),
  ...options,
});
test('preferSize picks the smallest mp4 rendition that still covers the layer frame', async () => {
  const [candidate] = (await videoProvider({ preferSize: { width: 600, height: 1000 } }).search(portraitSearch)).candidates;
  assert.equal(candidate.downloadUrl, 'https://videos.pexels.com/video-files/5/53.mp4');
  assert.deepEqual([candidate.width, candidate.height, candidate.rendition.id], [720, 1280, '53']);
  // Сторона к стороне по ориентации: горизонтальный кадр 1000×600 покрывает тот же 720×1280.
  const [landscape] = (await videoProvider({ preferSize: { width: 1000, height: 600 } }).search(portraitSearch)).candidates;
  assert.equal(landscape.rendition.id, '53');
  const [exact] = (await videoProvider({ preferSize: { width: 540, height: 960 } }).search(portraitSearch)).candidates;
  assert.equal(exact.rendition.id, '54');
});
test('preferSize falls back to the largest rendition when none covers the frame', async () => {
  const [candidate] = (await videoProvider({ preferSize: { width: 4320, height: 7680 } }).search(portraitSearch)).candidates;
  assert.equal(candidate.rendition.id, '51');
});
test('without preferSize the largest rendition is still selected', async () => {
  const [candidate] = (await videoProvider({}).search(portraitSearch)).candidates;
  assert.equal(candidate.rendition.id, '51');
  assert.equal(candidate.previewUrl, 'https://videos.pexels.com/video-files/5/55.mp4');
});
test('a malformed preferSize is refused as an invalid search', async () => {
  for (const preferSize of [{ width: 0, height: 960 }, { width: 540 }, { width: 540.5, height: 960 }, 'big']) {
    await assert.rejects(videoProvider({ preferSize }).search(portraitSearch), { code: 'BROLL_SEARCH_INVALID' });
  }
});

// videoHosts (слой motion-kit): renditions вне списка отсекаются ДО preferSize/fallback, поэтому
// зеркало на стороннем хосте (player.vimeo.com у самого Pexels API) не может «победить» подходящий
// по размеру прямой mp4 и увести весь кандидат в него – scripts/layer/stock.js после этого ещё раз
// сверяет итоговую ссылку со своим DIRECT_HOSTS, это первая линия защиты.
const mixedHostVideo = {
  ...video,
  id: 6,
  url: 'https://www.pexels.com/video/cat-6/',
  width: 2160,
  height: 3840,
  video_files: [
    { id: 61, width: 2160, height: 3840, file_type: 'video/mp4', link: 'https://videos.pexels.com/video-files/6/61.mp4' },
    { id: 62, width: 540, height: 960, file_type: 'video/mp4', link: 'https://player.vimeo.com/external/62.sd.mp4' },
  ],
};
const mixedHostProvider = (options) => createPexelsProvider({
  apiKey: 'key',
  request: async () => ({ bytes: Buffer.from(JSON.stringify({ videos: [mixedHostVideo] })) }),
  ...options,
});
test('videoHosts restricted to Pexels keeps the direct rendition even when a smaller mirror would otherwise win preferSize', async () => {
  const [candidate] = (await mixedHostProvider({ preferSize: { width: 540, height: 960 }, videoHosts: ['videos.pexels.com'] }).search(portraitSearch)).candidates;
  assert.equal(candidate.rendition.id, '61');
  assert.equal(candidate.downloadUrl, 'https://videos.pexels.com/video-files/6/61.mp4');
});
test('videoHosts falls back to default hosts when videoHosts is omitted (byte-identical behaviour)', async () => {
  // Без videoHosts поведение как раньше: preferSize видит оба файла, меньший (зеркало) выигрывает.
  const [candidate] = (await mixedHostProvider({ preferSize: { width: 540, height: 960 } }).search(portraitSearch)).candidates;
  assert.equal(candidate.rendition.id, '62');
  assert.equal(candidate.downloadUrl, 'https://player.vimeo.com/external/62.sd.mp4');
});
test('videoHosts restricted to Pexels falls back to the direct file when the largest rendition is a mirror', async () => {
  const largerMirror = {
    ...video, id: 7, url: 'https://www.pexels.com/video/cat-7/',
    video_files: [
      { id: 71, width: 2160, height: 3840, file_type: 'video/mp4', link: 'https://player.vimeo.com/external/71.sd.mp4' },
      { id: 72, width: 720, height: 1280, file_type: 'video/mp4', link: 'https://videos.pexels.com/video-files/7/72.mp4' },
    ],
  };
  const provider = createPexelsProvider({ apiKey: 'key', videoHosts: ['videos.pexels.com'],
    request: async () => ({ bytes: Buffer.from(JSON.stringify({ videos: [largerMirror] })) }) });
  const [candidate] = (await provider.search(portraitSearch)).candidates;
  assert.equal(candidate.rendition.id, '72');
  assert.equal(candidate.downloadUrl, 'https://videos.pexels.com/video-files/7/72.mp4');
});
