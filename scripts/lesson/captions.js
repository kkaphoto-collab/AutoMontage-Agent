// Группировка слов транскрипта в фразы для караоке-субтитров (CaptionsAuto).
// Правило из docs/STEP-04-captions.md: набирать пока (слов < 4) И (длительность группы < 1.6с)
// И (пауза до следующего слова < 0.45с); на разрыве закрыть группу.
const MAX_WORDS = 4;
const MAX_GROUP_DURATION_SEC = 1.6;
const MAX_GAP_SEC = 0.45;

function buildCaptionGroups(words) {
  if (!Array.isArray(words) || words.length === 0) return [];
  const groups = [];
  let buffer = [];
  for (const word of words) {
    const w = { w: String(word.w || '').trim(), s: Number(word.s), e: Number(word.e) };
    if (!w.w || !Number.isFinite(w.s) || !Number.isFinite(w.e) || w.s < 0 || w.e <= w.s) continue;
    if (buffer.length > 0) {
      const gap = w.s - buffer[buffer.length - 1].e;
      const groupDuration = w.e - buffer[0].s;
      const fits = buffer.length < MAX_WORDS
        && groupDuration < MAX_GROUP_DURATION_SEC
        && gap < MAX_GAP_SEC;
      if (!fits) {
        groups.push({ start: buffer[0].s, end: buffer[buffer.length - 1].e, words: buffer });
        buffer = [];
      }
    }
    buffer.push(w);
  }
  if (buffer.length > 0) {
    groups.push({ start: buffer[0].s, end: buffer[buffer.length - 1].e, words: buffer });
  }
  return groups;
}

module.exports = { buildCaptionGroups };
