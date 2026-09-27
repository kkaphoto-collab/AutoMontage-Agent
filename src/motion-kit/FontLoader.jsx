import { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';

// «once»-обёртка вокруг continueRender/cancelRender: не потому, что повторный continueRender на
// уже продолженный handle бросает исключение (в Remotion 4.0.504 это не так — он просто no-op),
// а как защита от React StrictMode, который в dev-режиме монтирует/размонтирует/снова монтирует
// эффект при первом рендере: без guard'а это запустило бы loadFontFaces дважды и дважды дёрнуло бы
// continueRender/cancelRender на один и тот же handle. Чистая функция — тестируется без React.
export function settleOnce() {
  let done = false;
  return (fn) => {
    if (done) return false;
    done = true;
    fn();
    return true;
  };
}

// Один и тот же family, повторённый без явного weight, — коллизия: у статических (не variable)
// начертаний нет своего диапазона весов, оба FontFace заявят весь '100 900', и браузеру нечем их
// различить. Разные явные weight на одном family — штатный способ подключить несколько начертаний
// (regular/bold и т. п.), это не коллизия.
function assertNoWeightlessDuplicates(faces) {
  const byFamily = new Map();
  for (const face of faces) {
    const list = byFamily.get(face.family) || [];
    list.push(face);
    byFamily.set(face.family, list);
  }
  for (const [family, list] of byFamily) {
    if (list.length > 1 && list.some((f) => !f.weight)) {
      throw new Error(`шрифт «${family}» повторяется без явного weight — статическим (не variable) начертаниям нужен свой weight, иначе один перекроет другой в fontSet`);
    }
  }
}

// Чистая (при внедрённых зависимостях) загрузка набора шрифтов — тестируется в Node через
// фейковые FontFaceImpl/fontSet/toUrl, а компонент ниже передаёт настоящие
// window.FontFace/document.fonts/staticFile. Пустой faces — не ошибка, ждать нечего. Вся работа —
// внутри Promise.resolve().then(...), поэтому синхронный throw из toUrl/FontFaceImpl (например,
// staticFile на плохом пути) тоже становится отклонением промиса, а не необработанным исключением
// из самого вызова loadFontFaces(...) — иначе .catch() в FontLoader его бы не увидел.
export function loadFontFaces(faces, { FontFaceImpl, fontSet, toUrl }) {
  return Promise.resolve().then(() => {
    if (!faces || faces.length === 0) return undefined;
    assertNoWeightlessDuplicates(faces);
    return Promise.all(faces.map((face) => new FontFaceImpl(
      face.family, `url("${toUrl(face.file)}")`, { weight: face.weight || '100 900' },
    ).load()
      .then((loaded) => fontSet.add(loaded))
      .catch((error) => { throw new Error(`шрифт «${face.family}» (${face.file}) не загрузился: ${error.message}`); })))
      .then(() => undefined);
  });
}

// Шрифты слоя из public/fonts (OFL с кириллицей); рендер ждёт их загрузки. faces — иммутабельный
// набор экземпляра: передавайте один и тот же модульный литерал (например, экспортированную
// константу из layer.json-обёртки), а не новый массив на каждый рендер Root.jsx — эффект грузит
// шрифты один раз при монтировании ([] в зависимостях, как componentDidMount) и не отслеживает
// изменения faces.
export function FontLoader({ faces }) {
  const [handle] = useState(() => delayRender('motion-kit: шрифты'));
  useEffect(() => {
    const settle = settleOnce();
    loadFontFaces(faces, { FontFaceImpl: FontFace, fontSet: document.fonts, toUrl: staticFile })
      .then(() => settle(() => continueRender(handle)))
      .catch((error) => settle(() => cancelRender(error)));
    // [] — намеренно: faces иммутабельны, грузим один раз на mount (см. комментарий выше).
  }, []);
  return null;
}
