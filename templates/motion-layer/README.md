# Motion-слой ролика

Собран командой `automontage layer new` из деталей motion-kit движка.

- `src/plan.js` — режиссура: планы камеры, карточки на словах, вставки, звуки, субтитры. Импортирует
  только `@automontage/motion-kit/core` и файлы внутри слоя — иначе `layer check` остановится.
- `src/scenes.jsx` — дизайн карточек и полноэкранных вставок этого ролика; адрес окна браузера для
  вставок `screen` — в `SCREEN_URLS` (id вставки → адрес). Здесь же выбираются шрифты ролика
  (`FONTS`, `CAPTION_FONT`) — кириллические OFL, свои под тему; `Root.jsx` только регистрирует их
  через `FontLoader` и не выбирает сам.
- `src/Root.jsx`, `src/index.jsx` — инфраструктура слоя (сборка из kit, та же, что у `layer check`):
  не правьте их.
- `src/words.js`, `src/sfx-library.js`, `layer.json` — сгенерированы. После правки `spelling.json`
  (написание брендов в субтитрах) запустите `automontage layer words`.
- `public/` — speaker.mp4, шрифты, звуки, сток (`stock/`), скриншоты (`shots/`); источники — `public/SOURCE.md`.
- Заглушки `stock/placeholder.mp4` и `shots/placeholder.png` замените настоящими материалами: сток по
  смыслу фразы подбирает `automontage layer stock` и пишет его источник в `public/SOURCE.md`.

Цикл: правка `plan.js` → `automontage layer check` (секунды) → `automontage layer render` →
`automontage layer import` → `automontage layer brief` → `automontage preview`.
Все тексты и цифры — только из речи (`src/words.js`).

Исключение из гейта (`waivers` в `plan.js`) возможно только для G1, G4 и G11 и только с причиной —
она видна в отчёте. Остальные стопы чинятся в плане, а не пропускаются.
