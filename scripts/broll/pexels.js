'use strict';
const { requestRemote, validateUrl, LIMITS, failure } = require('./remote');
// Exact documented Pexels rendition hosts; undocumented redirect CDNs fail closed.
const IMAGE_HOSTS = Object.freeze([
  'images.pexels.com',
  'static-videos.pexels.com',
]);
const VIDEO_HOSTS = Object.freeze(['videos.pexels.com', 'player.vimeo.com']);
const MEDIA_HOSTS = Object.freeze([...IMAGE_HOSTS, ...VIDEO_HOSTS]);
const PAGE_HOSTS = ['www.pexels.com', 'pexels.com'];
const CONTROL = /[\p{Cc}\p{Cf}]/u;
function normalizedText(value, maxBytes) {
  if (typeof value !== 'string' || CONTROL.test(value)) return null;
  const normalized = value.normalize('NFKC').trim();
  return normalized && !CONTROL.test(normalized) && Buffer.byteLength(normalized, 'utf8') <= maxBytes
    ? normalized : null;
}
function safeUrl(value, hosts, extension, maxBytes = 2048) {
  try {
    if (typeof value !== 'string' || CONTROL.test(value) || Buffer.byteLength(value, 'utf8') > maxBytes) return null;
    const url = validateUrl(value, hosts);
    return Buffer.byteLength(url.href, 'utf8') <= maxBytes && (!extension || extension.test(url.pathname)) ? url.href : null;
  } catch {
    return null;
  }
}
function normalizeSearch(input) {
  const queryEnglish = normalizedText(input?.queryEnglish, 200);
  const queryOriginal = normalizedText(input?.queryOriginal, 500);
  if (
    !input ||
    !queryEnglish ||
    !queryOriginal ||
    !['image', 'video'].includes(input.mediaKind) ||
    (input.orientation &&
      !['landscape', 'portrait', 'square'].includes(input.orientation))
  )
    throw failure('BROLL_SEARCH_INVALID');
  const search = { ...input, page: input.page ?? 1 };
  for (const key of ['minDurationSec', 'minWidth', 'minHeight'])
    if (
      search[key] !== undefined &&
      (!Number.isFinite(search[key]) || search[key] < 0 || search[key] > 100000)
    )
      throw failure('BROLL_SEARCH_INVALID');
  if (!Number.isInteger(search.page) || search.page < 1 || search.page > 1000)
    throw failure('BROLL_SEARCH_INVALID');
  search.queryEnglish = queryEnglish;
  search.queryOriginal = queryOriginal;
  return search;
}
function eligible(width, height, search) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 32768 ||
    height > 32768 ||
    width < (search.minWidth || 0) ||
    height < (search.minHeight || 0)
  )
    return false;
  return (
    !search.orientation ||
    (search.orientation === 'landscape'
      ? width > height
      : search.orientation === 'portrait'
        ? height > width
        : width === height)
  );
}
function normalizeCandidate(item, search, preferSize = null, videoHosts = VIDEO_HOSTS) {
  if (!Number.isSafeInteger(item?.id) || item.id <= 0) return null;
  const sourcePage = safeUrl(item.url, PAGE_HOSTS, undefined, 500);
  const author =
    search.mediaKind === 'image'
      ? { name: item.photographer, url: item.photographer_url }
      : item.user;
  const authorUrl = safeUrl(author?.url, PAGE_HOSTS, undefined, 500);
  const authorName = normalizedText(author?.name, 300);
  if (!sourcePage || !authorUrl || !authorName) return null;
  const source = new URL(sourcePage),
    profile = new URL(authorUrl);
  if (
    source.search ||
    profile.search ||
    !source.pathname.startsWith(
      search.mediaKind === 'image' ? '/photo/' : '/video/',
    ) ||
    !profile.pathname.startsWith('/@')
  )
    return null;
  let rendition,
    thumbnailUrl,
    previewUrl,
    durationSec = null;
  if (search.mediaKind === 'image') {
    if (!eligible(item.width, item.height, search)) return null;
    const downloadUrl = safeUrl(
      item.src?.original,
      IMAGE_HOSTS,
      /\.(?:jpg|jpeg|png|webp)$/i,
    );
    thumbnailUrl = safeUrl(
      item.src?.tiny || item.src?.small,
      IMAGE_HOSTS,
      /\.(?:jpg|jpeg|png|webp)$/i,
    );
    previewUrl = safeUrl(
      item.src?.medium,
      IMAGE_HOSTS,
      /\.(?:jpg|jpeg|png|webp)$/i,
    );
    rendition = {
      id: 'original',
      width: item.width,
      height: item.height,
      mimeType:
        downloadUrl && /\.png$/i.test(new URL(downloadUrl).pathname)
          ? 'image/png'
          : downloadUrl && /\.webp$/i.test(new URL(downloadUrl).pathname)
            ? 'image/webp'
            : 'image/jpeg',
      downloadUrl,
    };
  } else {
    durationSec = item.duration;
    if (
      !Number.isFinite(durationSec) ||
      durationSec <= 0 ||
      durationSec > 1800 ||
      durationSec < (search.minDurationSec || 0)
    )
      return null;
    const files = (
      Array.isArray(item.video_files) ? item.video_files : []
    ).filter(
      (f) =>
        f &&
        Number.isSafeInteger(f.id) &&
        f.file_type === 'video/mp4' &&
        safeUrl(f.link, videoHosts, /\.mp4$/i) &&
        eligible(f.width, f.height, {}) &&
        f.width <= 4096 && f.height <= 4096 &&
        f.width * f.height <= 8847360,
    );
    const fitting = files
      .filter((f) => eligible(f.width, f.height, search))
      .sort((a, b) => b.width * b.height - a.width * a.height);
    // preferSize (слой motion-kit): самый маленький mp4, покрывающий кадр сторона к стороне; иначе самый большой.
    const covers = (f) => Math.min(f.width, f.height) >= Math.min(preferSize.width, preferSize.height)
      && Math.max(f.width, f.height) >= Math.max(preferSize.width, preferSize.height);
    const selected = (preferSize && fitting.filter(covers).at(-1)) || fitting[0];
    if (!selected) return null;
    rendition = {
      id: String(selected.id),
      width: selected.width,
      height: selected.height,
      mimeType: 'video/mp4',
      downloadUrl: selected.link,
    };
    thumbnailUrl =
      safeUrl(item.image, IMAGE_HOSTS, /\.(?:jpg|jpeg|png|webp)$/i) ||
      safeUrl(
        item.video_pictures?.[0]?.picture,
        IMAGE_HOSTS,
        /\.(?:jpg|jpeg|png|webp)$/i,
      );
    const preview = files
      .filter(
        (f) =>
          f.link !== selected.link &&
          f.width * f.height < selected.width * selected.height &&
          f.width <= 960 &&
          f.height <= 960,
      )
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    previewUrl = preview?.link || null;
  }
  if (!rendition.downloadUrl || !thumbnailUrl) return null;
  const { downloadUrl, ...identity } = rendition;
  return {
    provider: 'pexels',
    providerAssetId: String(item.id),
    sourcePage,
    author: { name: authorName, url: authorUrl },
    license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' },
    queryOriginal: search.queryOriginal,
    queryEnglish: search.queryEnglish,
    retrievedAt: new Date().toISOString(),
    rendition: identity,
    mediaKind: search.mediaKind,
    width: identity.width,
    height: identity.height,
    durationSec,
    hasAudio: null,
    thumbnailUrl,
    previewUrl,
    downloadUrl,
  };
}
const validSize = (size) => size !== null && typeof size === 'object'
  && [size.width, size.height].every((side) => Number.isSafeInteger(side) && side > 0 && side <= 32768);
function createPexelsProvider({ apiKey, request = requestRemote, preferSize, videoHosts = VIDEO_HOSTS } = {}) {
  return {
    async search(input) {
      if (!apiKey) throw failure('BROLL_KEY_MISSING');
      const search = normalizeSearch(input);
      if (preferSize !== undefined && !validSize(preferSize)) throw failure('BROLL_SEARCH_INVALID');
      const url = new URL(
        search.mediaKind === 'image'
          ? 'https://api.pexels.com/v1/search'
          : 'https://api.pexels.com/v1/videos/search',
      );
      url.searchParams.set('query', search.queryEnglish);
      url.searchParams.set('page', String(search.page));
      url.searchParams.set('per_page', '12');
      if (search.orientation)
        url.searchParams.set('orientation', search.orientation);
      try {
        const response = await request({
          url: url.href,
          allowedHosts: ['api.pexels.com'],
          headers: { Authorization: apiKey, Accept: 'application/json' },
          signal: search.signal,
          maxBytes: LIMITS.api,
          timeoutMs: 15000,
          expectedMimeTypes: ['application/json'],
          maxRedirects: 0,
        });
        const data = JSON.parse(response.bytes.toString('utf8'));
        const items = data[search.mediaKind === 'image' ? 'photos' : 'videos'];
        if (!Array.isArray(items)) throw failure();
        const candidates = [],
          seen = new Set();
        for (const item of items.slice(0, 80)) {
          const candidate = normalizeCandidate(item, search, preferSize ?? null, videoHosts);
          if (
            candidate &&
            !JSON.stringify(candidate).includes(apiKey) &&
            !seen.has(candidate.providerAssetId)
          ) {
            seen.add(candidate.providerAssetId);
            candidates.push(candidate);
          }
          if (candidates.length === 12) break;
        }
        let nextPage = null;
        const next = safeUrl(data.next_page, ['api.pexels.com']);
        if (next) {
          const parsed = new URL(next);
          if (
            parsed.pathname === url.pathname &&
            Number(parsed.searchParams.get('page')) === search.page + 1 &&
            search.page < 1000
          )
            nextPage = search.page + 1;
        }
        return { candidates, nextPage };
      } catch (error) {
        throw failure(
          error?.code === 'BROLL_REMOTE_ABORTED'
            ? 'BROLL_REMOTE_ABORTED'
            : 'BROLL_PROVIDER_FAILED',
        );
      }
    },
  };
}
module.exports = {
  createPexelsProvider,
  normalizeSearch,
  IMAGE_HOSTS,
  VIDEO_HOSTS,
  MEDIA_HOSTS,
};
