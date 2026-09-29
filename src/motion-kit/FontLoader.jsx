import { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';

// «once»-обёртка вокруг continueRender: не потому, что повторный continueRender на уже
// продолженный handle бросает исключение (в Remotion 4.0.504 это не так – он просто no-op), а как
// защита от React StrictMode, который в dev-режиме монтирует/размонтирует/снова монтирует эффект
// при первом рендере – общий на все эти прогоны guard не даёт continueRender выстрелить дважды на
// один handle. Отклонение round 3 (ревью minor 5): guard оборачивает ТОЛЬКО continueRender –
// cancelRender вызывается напрямую, без settle, при любой реальной ошибке, сколько бы раз она ни
// произошла (даже после того как settle уже «использован» для continueRender): реальный сбой не
// должен быть молча проглочен только потому, что guard уже сработал на успешном пути. Чистая
// функция – тестируется без React.
export function settleOnce() {
  let done = false;
  return (fn) => {
    if (done) return false;
    done = true;
    fn();
    return true;
  };
}

// Один и тот же family, повторённый без явного weight, – коллизия: у статических (не variable)
// начертаний нет своего диапазона весов, оба FontFace заявят весь '100 900', и браузеру нечем их
// различить. Разные явные weight на одном family – штатный способ подключить несколько начертаний
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
      throw new Error(`шрифт «${family}» повторяется без явного weight – статическим (не variable) начертаниям нужен свой weight, иначе один перекроет другой в fontSet`);
    }
  }
}

// Реестр зарегистрированных лиц по fontSet: ключ family+file+weight → промис загрузки. Второй
// одинаковый FontFace в document.fonts не появляется, повторная регистрация ждёт ту же загрузку.
// WeakMap по самому fontSet: у каждого документа (и у каждого фейка в тестах) свой реестр.
const REGISTERED = new WeakMap();

// Синхронная часть: конструирует каждый FontFace, СРАЗУ кладёт его в fontSet (до load(), а не
// после) и запускает load(). «Сразу» – не деталь стиля, а сама суть исправления ревью round 3:
// FontLoader вызывает эту функцию из lazy-инициализатора useState – во время рендера, до ЛЮБОГО
// layout-эффекта в дереве, будь то его собственные children или посторонний сосед. Раньше
// document.fonts.add происходил только ПОСЛЕ загрузки, внутри useEffect: если Subtitles стоял
// РЯДОМ с FontLoader (а не внутри него), его собственный document.fonts.load('KitOnest') не
// находил в document.fonts вообще никакой записи с этим именем, и браузер резолвил такой load()
// немедленно – ждать нечего, шрифт вообще не зарегистрирован. Subtitles измерял текст фолбэк-
// шрифтом. Регистрируя FontFace здесь и сразу добавляя её в fontSet, мы гарантируем: к моменту,
// когда любой layout-эффект где-либо в дереве впервые выполнится, document.fonts уже содержит
// запись для каждого face (пусть ещё не загруженную) – и чей угодно document.fonts.load(того же
// семейства) дождётся её настоящей загрузки, а не зарезолвится в пустоту.
//
// Регистрация идёт в фазе рендера и повторяется на каждом монтировании FontLoader (ремаунт, второй
// FontLoader с теми же шрифтами) – уже зарегистрированное лицо берётся из REGISTERED.
export function registerFontFaces(faces, { FontFaceImpl, fontSet, toUrl }) {
  if (!faces || faces.length === 0) return [];
  assertNoWeightlessDuplicates(faces);
  if (!REGISTERED.has(fontSet)) REGISTERED.set(fontSet, new Map());
  const registry = REGISTERED.get(fontSet);
  return faces.map((face) => {
    const weight = face.weight || '100 900';
    const key = JSON.stringify([face.family, face.file, weight]);
    if (!registry.has(key)) {
      const fontFace = new FontFaceImpl(face.family, `url("${toUrl(face.file)}")`, { weight });
      fontSet.add(fontFace);
      registry.set(key, fontFace.load());
    }
    return { face, promise: registry.get(key) };
  });
}

// Асинхронная часть: ждёт все load(), уже запущенные registerFontFaces, оборачивает ошибку каждого
// лица его family/file. Намеренно отделена от registerFontFaces: сама регистрация обязана быть
// синхронной (см. выше), а не отложенной хотя бы на один тик микрозадачи.
export function settleFontFaces(registered) {
  return Promise.all(registered.map(({ face, promise }) => promise
    .catch((error) => { throw new Error(`шрифт «${face.family}» (${face.file}) не загрузился: ${error.message}`); })))
    .then(() => undefined);
}

// Утилита «зарегистрировать и дождаться разом» – то же самое, что registerFontFaces +
// settleFontFaces, одним промисом; используется тестами и любым кодом, которому точный момент
// регистрации не важен. Обёрнута в Promise.resolve().then(...), поэтому синхронный throw из
// toUrl/FontFaceImpl (например, staticFile на плохом пути) тоже становится отклонением промиса, а
// не необработанным исключением из самого вызова.
export function loadFontFaces(faces, deps) {
  return Promise.resolve().then(() => settleFontFaces(registerFontFaces(faces, deps)));
}

// Эффект монтирования гейта – чистая функция (в renderToStaticMarkup эффекты не выполняются, так
// её можно проверить без DOM). Ждёт уже зарегистрированные лица: готово → onReady, сбой → onError.
// Возвращает очистку эффекта: после неё поздняя загрузка или ошибка ничего не трогают, а release
// отпускает delayRender-handle – если гейт размонтирован раньше, чем шрифты загрузились, Remotion
// иначе ждал бы этот handle до таймаута. Дети остаются закрытыми: ready так и не станет true.
export function watchFontFaces(registered, { onReady, onError, release }) {
  let cancelled = false;
  settleFontFaces(registered)
    .then(() => { if (!cancelled) onReady(); })
    .catch((error) => { if (!cancelled) onError(error); });
  return () => {
    cancelled = true;
    release();
  };
}

// Шрифты слоя из public/fonts (OFL с кириллицей). FontLoader – ГЕЙТ: он обязан ОБОРАЧИВАТЬ то, что
// ждёт эти шрифты – <FontLoader faces={faces}>{children}</FontLoader>, а не стоять РЯДОМ с ним
// отдельным элементом. children не рисуются, пока faces не загрузились и не попали в document.fonts
// (весь это время Remotion держит рендер через delayRender); в браузере (не в SSR/тестах)
// отсутствие children – однозначная ошибка использования (гейту нечего гейтить, и почти наверняка
// кто-то поставил его рядом с Subtitles вместо того, чтобы обернуть) – бросаем сразу и явно.
//
// В SSR/тестах (нет document) – рендерим children сразу: измерять DOM всё равно негде, а блокировка
// forever сломала бы каждый существующий тест, который рендерит компоненты кита в изоляции. Плановый
// тест (`calls.delay === 1`) продолжает выполняться – delayRender зовётся всегда, независимо от среды.
//
// faces – иммутабельный набор экземпляра: передавайте один и тот же модульный литерал (например,
// экспортированную константу из layer.json-обёртки), а не новый массив на каждый рендер Root.jsx –
// регистрация и загрузка происходят один раз при монтировании и не отслеживают изменения faces.
export function FontLoader({ faces, children }) {
  if (typeof document !== 'undefined' && children === undefined) {
    throw new Error('FontLoader: не передан children – это гейт, он должен ОБОРАЧИВАТЬ то, что ждёт шрифт (<FontLoader faces={faces}>{children}</FontLoader>), а не стоять рядом с ним отдельным элементом');
  }
  const [handle] = useState(() => delayRender('motion-kit: шрифты'));
  const [settle] = useState(() => settleOnce());
  // Лениво: в SSR/тестах document не существует – считаем шрифты «готовыми» сразу же, дети
  // рисуются в первом же (и единственном для SSR) рендере.
  const [ready, setReady] = useState(() => typeof document === 'undefined');
  // Регистрация – тоже в lazy-инициализаторе useState, а не в эффекте: инициализатор выполняется
  // синхронно во время САМОГО ПЕРВОГО рендера, до того как commit-фаза дойдёт до layout-эффектов
  // (см. комментарий у registerFontFaces выше).
  const [registered] = useState(() => {
    if (typeof document === 'undefined' || !document.fonts) return [];
    return registerFontFaces(faces, { FontFaceImpl: FontFace, fontSet: document.fonts, toUrl: staticFile });
  });

  useEffect(() => {
    if (typeof document === 'undefined') { setReady(true); return undefined; }
    return watchFontFaces(registered, {
      onReady: () => setReady(true),
      // cancelRender – НЕ через settle: реальная ошибка обязана репортиться всегда, даже если
      // settle уже «использован» где-то на успешном пути (см. комментарий у settleOnce).
      onError: (error) => cancelRender(error),
      // Размонтирование до загрузки: handle отпускается здесь; после успешной загрузки settle
      // уже использован эффектом ниже, и повторного continueRender не будет.
      release: () => settle(() => continueRender(handle)),
    });
    // [] – намеренно: faces иммутабельны, регистрация и загрузка происходят один раз на mount.
  }, []);

  // Отдельный passive-эффект на ready, а не requestAnimationFrame (отклонение round 3, ревью
  // minor 3): React гарантирует, что passive-эффекты во всём дереве выполняются ПОСЛЕ
  // layout-эффектов детей и после того, как браузер закоммитил кадр с ready=true – то есть
  // children с уже готовым шрифтом точно отрисованы прежде, чем Remotion получит разрешение снять
  // скриншот; requestAnimationFrame был угадыванием одного кадра вперёд, а не гарантией.
  useEffect(() => {
    if (ready) settle(() => continueRender(handle));
  }, [ready]);

  return ready ? (children ?? null) : null;
}
