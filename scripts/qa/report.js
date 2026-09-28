const fs = require('node:fs');
const path = require('node:path');
const { WAIVABLE } = require('./profiles');

const ICONS = { pass: '✅', warn: '⚠️', fail: '❌', waived: '☑️', skipped: '⏭️' };
const KIND_TITLES = { 'layer-check': 'план слоя', 'layer-render': 'рендер слоя', preview: 'preview' };
const REPORT_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/u;

function gate(id, title, fields = {}) {
  return { id, title, status: 'pass', value: null, threshold: null, unit: '', spans: [], hint: '', ...fields };
}

function summarize(gates) {
  const fail = gates.filter((g) => g.status === 'fail').length;
  const warn = gates.filter((g) => g.status === 'warn').length;
  return { status: fail ? 'fail' : warn ? 'warn' : 'pass', fail, warn };
}

function applyWaivers(gates, waivers = [], waivable = WAIVABLE) {
  return gates.map((g) => {
    const waiver = waivers.find((w) => w.gate === g.id && String(w.reason || '').trim());
    if (g.status !== 'fail' || !waivable.includes(g.id) || !waiver) return g;
    return { ...g, status: 'waived', hint: `исключение: ${waiver.reason.trim()}` };
  });
}

function buildReport({ kind, profile, gates, inputs = [], layer = null, now = new Date(), error = null }) {
  return { version: 1, kind, layer, profile, createdAt: now.toISOString(), inputs, gates, summary: summarize(gates), error };
}

function exitCodeFor(report) {
  if (report.error) return 2;
  return report.summary.status === 'fail' ? 1 : 0;
}

const number = (value) => (typeof value === 'number' ? String(Number(value.toFixed(2))).replace('.', ',') : String(value));

// Сначала округляем секунды до сантисекунд, только потом делим на минуты. Обратный порядок
// (сперва отделить минуты, потом .toFixed(2) остатка) даёт для 59.999 с минуты = 0, остаток
// 59.999.toFixed(2) = "60.00" — печатался бы обман «0:60,00» вместо «1:00,00».
const clock = (sec) => {
  const cs = Math.round(sec * 100);
  const minutes = Math.floor(cs / 6000);
  const rest = (cs - minutes * 6000) / 100;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0').replace('.', ',')}`;
};

function formatReport(report) {
  const verdict = report.summary.status === 'fail' ? 'СТОП' : report.summary.status === 'warn' ? 'есть предупреждения' : 'всё хорошо';
  const lines = [`Проверки (${KIND_TITLES[report.kind] || report.kind}): ${verdict}`];
  if (report.error) lines.push(`❌ Оценить нельзя: ${report.error}`);
  for (const g of report.gates) {
    const value = g.value === null || g.value === undefined ? '' : `: ${number(g.value)}${g.unit ? ` ${g.unit}` : ''}`;
    const threshold = g.threshold ? ` (порог ${g.threshold})` : '';
    lines.push(`${ICONS[g.status]} ${g.id} ${g.title}${value}${threshold}`);
    for (const span of g.spans.slice(0, 3)) lines.push(`   ${clock(span.fromSec)}–${clock(span.toSec)} ${span.note || ''}`.trimEnd());
    if (g.hint && g.status !== 'pass') lines.push(`   → ${g.hint}`);
  }
  return lines.join('\n');
}

function writeAtomic(file, text, fileSystem) {
  const temporary = `${file}.${process.pid}.tmp`;
  fileSystem.writeFileSync(temporary, text);
  try {
    fileSystem.renameSync(temporary, file);
  } catch (error) {
    // Переименование не удалось (диск, права, антивирус держит файл) — не оставляем .tmp в qa/,
    // иначе следующий запуск копит мусор рядом с настоящими отчётами.
    try {
      fileSystem.unlinkSync(temporary);
    } catch {
      // временный файл уже не убрать — сообщаем исходную причину сбоя, а не эту
    }
    throw error;
  }
}

function writeReport(projectDir, name, report, fileSystem = fs) {
  if (!REPORT_NAME.test(name)) throw new Error(`имя отчёта «${name}» недопустимо`);
  const dir = path.join(projectDir, 'qa');
  fileSystem.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${name}.json`);
  const textPath = path.join(dir, `${name}.txt`);
  writeAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`, fileSystem);
  writeAtomic(textPath, `${formatReport(report)}\n`, fileSystem);
  return { jsonPath, textPath };
}

module.exports = { applyWaivers, buildReport, exitCodeFor, formatReport, gate, summarize, writeReport };
