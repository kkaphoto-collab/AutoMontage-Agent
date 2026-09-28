// Дизайн карточек и полноэкранных вставок этого ролика: палитра, шрифты и композиции — свои для каждой темы.
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { BrowserFrame, REVEAL_FRAMES, ScrollShot, closeWindow, ref25, revealCard } from '@automontage/motion-kit';

// id вставки screen → адрес страницы в окне браузера (у скомпилированной вставки нет props).
const SCREEN_URLS = {};

export function SceneContent({ item }) {
  const { fps, width, height } = useVideoConfig();
  // Тот же масштаб, что у box в plan.js: кегль, скругление и отступ растут и сжимаются вместе с карточкой.
  const k = Math.min(width, height) / 1080;
  const { view } = item.props;
  if (view === 'title') {
    // border-box и overflow: карточка не шире своего box — G5 проверяет именно box.
    return (
      <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center',
        justifyContent: 'center', overflow: 'hidden', background: 'rgba(12,16,24,.82)', borderRadius: Math.round(28 * k),
        color: '#ffffff', fontFamily: 'KitOswald', fontSize: Math.round(64 * k), fontWeight: 700, lineHeight: 1.1,
        textAlign: 'center', padding: `0 ${Math.round(32 * k)}px` }}>{item.props.text}</div>
    );
  }
  if (view === 'browser') {
    // Прокрутка — после входа карточки (mask, 8 эталонных кадров) и до начала выхода (5 кадров).
    return (
      <BrowserFrame url={item.props.url}>
        <ScrollShot src={item.props.src} from={item.from + ref25(8, fps)} to={item.until - ref25(5, fps)} scroll={item.props.scroll ?? 1} />
      </BrowserFrame>
    );
  }
  return null;
}

// Содержимое полноэкранных вставок screen/scene (сток StockInsert рисует сам). Скриншот на весь кадр —
// окно браузера внутри safe-зоны (revealCard), иначе в 9:16 хром окна уходит под интерфейс площадки.
export function InsertContent({ insert }) {
  const { fps, width, height } = useVideoConfig();
  // Оверлей без cover (донор поверх спикера) ролик рисует сам — в своей рамке и в своём окне времени:
  // заливка на весь кадр здесь закрыла бы спикера на весь ролик.
  if (!insert.cover) return null;
  if (insert.kind === 'screen' && insert.src) {
    const card = revealCard(width, height);
    return (
      <AbsoluteFill style={{ backgroundColor: '#0c1018' }}>
        <div style={{ position: 'absolute', top: card.top, right: card.right, bottom: card.bottom, left: card.left }}>
          <BrowserFrame url={SCREEN_URLS[insert.id] || ''}>
            <ScrollShot src={insert.src} from={insert.from + ref25(REVEAL_FRAMES, fps)} to={closeWindow(insert, fps).start} scroll={1} />
          </BrowserFrame>
        </div>
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill style={{ backgroundColor: '#0c1018' }} />;
}
