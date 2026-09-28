# Motion-слой ролика

Собран командой `automontage layer new` из деталей motion-kit движка.

- `src/plan.js` — режиссура: планы камеры, карточки на словах, вставки, звуки, субтитры.
- `src/scenes.jsx` — дизайн карточек и полноэкранных вставок этого ролика.
- `public/` — speaker.mp4, шрифты, звуки, сток (`stock/`), скриншоты (`shots/`); источники — `public/SOURCE.md`.
- Заглушки `stock/placeholder.mp4` и `shots/placeholder.png` замените настоящими материалами.

Цикл: правка `plan.js` → `automontage layer check` (секунды) → `automontage layer render` →
`automontage layer import` → `automontage layer brief` → `automontage preview`.
Все тексты и цифры — только из речи (`src/words.js`); написание брендов — в `spelling.json`.
