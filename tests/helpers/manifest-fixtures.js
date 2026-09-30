// Синтетический манифест слоя: camera(f) → {s, dx, dy, blur, opacity, requested}. width/height –
// параметры со значениями по умолчанию 1080×1920 (scale=1), чтобы гейты можно было проверить на
// масштабировании порогов (например 2160×3840, scale=2).
function manifestFixture({ seconds = 10, fps = 25, width = 1080, height = 1920, camera = () => ({ s: 1 }),
  texts = [], inserts = [], cues = { kept: [], dropped: [] }, hook = 'speaker', waivers = [] } = {}) {
  const n = Math.round(seconds * fps);
  const cam = { s: [], requested: [], base: [], dx: [], dy: [], blur: [], opacity: [] };
  for (let f = 0; f < n; f += 1) {
    const c = { dx: 0, dy: 0, blur: 0, opacity: 1, ...camera(f) };
    // base по умолчанию равен s (нет клэмпа для теста, которому он не важен) – как и requested.
    cam.s.push(c.s); cam.requested.push(c.requested ?? c.s); cam.base.push(c.base ?? c.s);
    cam.dx.push(c.dx); cam.dy.push(c.dy); cam.blur.push(c.blur); cam.opacity.push(c.opacity);
  }
  return { version: 1, kitVersion: 1, fps, width, height, durationInFrames: n, maxScale: 1.25,
    camera: cam, texts, inserts, cues, hook, waivers };
}

// Смена крупности W (1,00) ↔ M (1,18) каждые everySec секунд.
const cutsEvery = (everySec, fps = 25) => (f) => ({ s: Math.floor(f / (everySec * fps)) % 2 ? 1.18 : 1 });

module.exports = { cutsEvery, manifestFixture };
