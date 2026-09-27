const TAIL = /[.,!?…:;»"]+$/u;

export function normWord(value) {
  return String(value ?? '').trim().toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}%+#]/gu, '');
}

// transcript/words.json движка: [{start, end, text, words: [{w, s, e}]}] → [{w, t, s, e}]
// w — как услышал Whisper (по нему ищутся якоря), t — написание на экране.
export function flattenTranscript(segments, { spelling = {} } = {}) {
  if (!Array.isArray(segments)) throw new Error('transcript: ожидается массив сегментов');
  // Ключи spelling пишут как удобно человеку («CloudCode», «Ёлка»), а не в normWord-форме —
  // строим таблицу один раз, чтобы искать по той же нормализации, что и сами слова.
  const spellingByNorm = Object.fromEntries(
    Object.entries(spelling).map(([key, value]) => [normWord(key), value]),
  );
  const words = [];
  for (const segment of segments) {
    for (const word of segment.words || []) {
      const w = String(word.w ?? '').trim();
      if (!normWord(w) || !Number.isFinite(word.s) || !Number.isFinite(word.e)) continue;
      const key = normWord(w);
      const tail = w.match(TAIL)?.[0] || '';
      const t = Object.hasOwn(spellingByNorm, key) ? `${spellingByNorm[key]}${tail}` : w;
      words.push({ w, t, s: word.s, e: Math.max(word.s, word.e) });
    }
  }
  return words.sort((a, b) => a.s - b.s);
}

// Один канон якорей: монотонный курсор (переживает повторы слов) + необязательная
// страховка near (слово должно быть в пределах tolerance секунд от подсказки).
export function makeAnchors(words, { tolerance = 1.2 } = {}) {
  let cursor = 0;
  const matches = (word, key) => {
    const n = normWord(word.w);
    // Точное совпадение — всегда. Совпадение по началу слова — только для ключей от 4 символов:
    // короткий ключ («это») иначе цепляет соседнее слово («этот») и сбивает курсор якорей.
    return n === key || (key.length >= 4 && n.startsWith(key));
  };
  function locate(spec, near) {
    const key = normWord(spec);
    if (!key) throw new Error(`якорь «${spec}» пустой`);
    for (let i = cursor; i < words.length; i += 1) {
      if (!matches(words[i], key)) continue;
      if (near !== null && Math.abs(words[i].s - near) > tolerance) {
        if (words[i].s > near + tolerance) break;
        continue;
      }
      return i;
    }
    const where = near === null ? '' : ` около ${near} с`;
    throw new Error(`якорь «${spec}» не найден после слова №${cursor}${where}`);
  }
  return {
    at(spec, { near = null, d = 0, edge = 'start', free = false } = {}) {
      const index = locate(spec, near);
      if (!free) cursor = index + 1;
      const word = words[index];
      return Number(((edge === 'end' ? word.e : word.s) + d).toFixed(3));
    },
    index: () => cursor,
    reset(index = 0) { cursor = index; },
  };
}
