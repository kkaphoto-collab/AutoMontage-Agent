import { useEffect, useRef, useState } from 'react';
import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';

// Чистая (при внедрённых зависимостях) загрузка набора шрифтов — тестируется в Node через
// фейковые FontFaceImpl/fontSet/toUrl, а компонент ниже передаёт настоящие
// window.FontFace/document.fonts/staticFile. Пустой faces — не ошибка, ждать нечего.
export function loadFontFaces(faces, { FontFaceImpl, fontSet, toUrl }) {
  if (!faces || faces.length === 0) return Promise.resolve();
  return Promise.all(faces.map((face) => new FontFaceImpl(
    face.family, `url(${toUrl(face.file)})`, { weight: face.weight || '100 900' },
  ).load().then((loaded) => fontSet.add(loaded)))).then(() => undefined);
}

// Шрифты слоя из public/fonts (OFL с кириллицей); рендер ждёт их загрузки. Эффект завязан на
// стабильную строку из faces, а не на идентичность массива, — новый литерал faces в каждом рендере
// plan.js/Root.jsx не должен перезапускать загрузку заново. continueRender/cancelRender вызываются
// не больше одного раза на handle (ref-флаг): повторный continueRender на уже продолженный handle —
// ошибка самого Remotion.
export function FontLoader({ faces }) {
  const [handle] = useState(() => delayRender('motion-kit: шрифты'));
  const settled = useRef(false);
  const key = JSON.stringify(faces || []);
  useEffect(() => {
    loadFontFaces(faces, { FontFaceImpl: FontFace, fontSet: document.fonts, toUrl: staticFile })
      .then(() => { if (!settled.current) { settled.current = true; continueRender(handle); } })
      .catch((error) => { if (!settled.current) { settled.current = true; cancelRender(error); } });
    // key — стабильный слепок faces; сам faces читается из замыкания последнего рендера с этим key.
  }, [key, handle]);
  return null;
}
