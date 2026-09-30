const test = require('node:test');
const assert = require('node:assert/strict');
const { EDGE_THRESHOLD, SHARE_THRESHOLD, emptyFrameGate, isEmptySample } = require('../scripts/qa/empty-frame-gate');

test('a share exactly at the threshold is not empty, just below it is', () => {
  assert.equal(isEmptySample({ timeSec: 1, edgeShare: SHARE_THRESHOLD }), false);
  assert.equal(isEmptySample({ timeSec: 1, edgeShare: SHARE_THRESHOLD - 0.0001 }), true);
});

test('a realistic 0.05 % edge share is empty, a realistic 0.2 % edge share is content', () => {
  assert.equal(isEmptySample({ timeSec: 1, edgeShare: 0.0005 }), true);
  assert.equal(isEmptySample({ timeSec: 1, edgeShare: 0.002 }), false);
});

test('a null sample (unreadable frame) counts as empty', () => {
  const report = emptyFrameGate([null, { timeSec: 2, edgeShare: 0.5 }]);
  assert.equal(report.value, 1);
  assert.equal(report.status, 'warn');
});

test('an all-pass set of samples yields a pass with value 0', () => {
  const report = emptyFrameGate([{ timeSec: 0.5, edgeShare: 0.5 }, { timeSec: 1.5, edgeShare: 0.2 }]);
  assert.equal(report.status, 'pass');
  assert.equal(report.value, 0);
  assert.deepEqual(report.spans, []);
});

test('value counts every empty sample exactly, not just the first five shown in spans', () => {
  const samples = Array.from({ length: 9 }, (_, i) => ({ timeSec: i, edgeShare: 0 }));
  const report = emptyFrameGate(samples);
  assert.equal(report.value, 9);
  assert.equal(report.spans.length, 5, 'spans stay capped even though value counts all nine');
});

test('spans carry the real seconds and a Russian note, unreadable samples are skipped from spans', () => {
  const report = emptyFrameGate([{ timeSec: 3.25, edgeShare: 0 }, null, { timeSec: 7.5, edgeShare: 0.0001 }]);
  assert.equal(report.value, 3);
  assert.deepEqual(report.spans, [
    { fromSec: 3.25, toSec: 3.25, note: 'пустой или однотонный кадр' },
    { fromSec: 7.5, toSec: 7.5, note: 'пустой или однотонный кадр' },
  ]);
  for (const span of report.spans) assert.match(span.note, /[а-я]/);
});

test('the gate id, title and threshold text mention both constants', () => {
  const report = emptyFrameGate([]);
  assert.equal(report.id, 'G12');
  assert.equal(report.title, 'Пустые кадры');
  assert.match(report.threshold, new RegExp(String(EDGE_THRESHOLD)));
  // Число с запятой, как у остальных гейтов (scripts/qa/timeline-gates.js), а не с точкой.
  assert.match(report.threshold, /0,1 %/);
  assert.doesNotMatch(report.threshold, /0\.1/);
  assert.equal(report.unit, 'из 0');
});
