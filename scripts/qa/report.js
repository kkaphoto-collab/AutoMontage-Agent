const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WAIVABLE } = require('./profiles');

const ICONS = { pass: '✅', warn: '⚠️', fail: '❌', waived: '☑️', skipped: '⏭️' };
const STATUSES = Object.keys(ICONS);
const KIND_TITLES = { 'layer-check': 'план слоя', 'layer-render': 'рендер слоя', preview: 'preview', sheet: 'контакт-лист' };
const REPORT_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/u;
const NO_ERROR_TEXT = 'неизвестная ошибка';

function gate(id, title, fields = {}) {
  const g = { id, title, status: 'pass', value: null, threshold: null, unit: '', spans: [], hint: '', ...fields };
  if (!STATUSES.includes(g.status)) {
    throw new Error(`gate ${id}: status должен быть одним из ${STATUSES.join('|')}, получено «${g.status}»`);
  }
  // Явный gate(..., { spans: undefined }) перекрыл бы дефолт через spread и уронил бы formatReport
  // на .slice() ниже – подстраховываемся уже здесь, а не в каждом месте, что читает spans.
  if (!Array.isArray(g.spans)) g.spans = [];
  return g;
}

function summarize(gates) {
  const fail = gates.filter((g) => g.status === 'fail').length;
  const warn = gates.filter((g) => g.status === 'warn').length;
  return { status: fail ? 'fail' : warn ? 'warn' : 'pass', fail, warn };
}

function applyWaivers(gates, waivers = [], waivable = WAIVABLE) {
  // waivers сюда может прийти не только из уже провалидированного compileLayer (src/motion-kit/
  // compile.js), а прямо из manifest.json на диске или из ручного вызова – форма входа доверия не
  // заслуживает, но падать на ней applyWaivers не должен: просто не находим исключение.
  const list = Array.isArray(waivers) ? waivers : [];
  return gates.map((g) => {
    const waiver = list.find((w) => w && w.gate === g.id && typeof w.reason === 'string' && w.reason.trim());
    if (g.status !== 'fail' || !waivable.includes(g.id) || !waiver) return g;
    return { ...g, status: 'waived', hint: `исключение: ${waiver.reason.trim()}` };
  });
}

// unusedWaivers – исключения плана, которые ничего не сняли (их гейт прошёл или дал только warn):
// автору видно, что их пора убрать. На вердикт и код выхода они не влияют.
function buildReport({ kind, profile, gates, inputs = [], layer = null, now = new Date(), error = null, unusedWaivers = [] }) {
  const hasError = error !== null && error !== undefined;
  const summary = summarize(gates);
  const unused = (Array.isArray(unusedWaivers) ? unusedWaivers : []).filter((w) => w && typeof w === 'object')
    .map((w) => ({ gate: w.gate, reason: String(w.reason ?? '').trim() }));
  return {
    version: 1, kind, layer, profile, createdAt: now.toISOString(), inputs, gates, unusedWaivers: unused,
    // Ошибка сборки/чтения важнее гейтов: отчёт нельзя читать как «всё хорошо», даже если gates
    // пуст (сборка упала раньше, чем появился хоть один гейт) или в нём случайно только pass.
    summary: hasError ? { ...summary, status: 'error' } : summary,
    error: hasError ? (String(error).trim() || NO_ERROR_TEXT) : null,
  };
}

function exitCodeFor(report) {
  if (report.error !== null && report.error !== undefined) return 2;
  return report.summary.status === 'fail' ? 1 : 0;
}

const number = (value) => (typeof value === 'number' ? String(Number(value.toFixed(2))).replace('.', ',') : String(value));

// Сначала округляем секунды до сантисекунд, только потом делим на минуты (иначе 59.999 печаталось
// бы как «0:60,00» – отдельная минутная часть уже отрезана до .toFixed(2) остатка). Отрицательные
// секунды (округление на границе нуля, опечатка в плане) зажимаем в 0 – «-1:55,00» ничего не
// говорит человеку, который не думает во внутренних кадрах.
const clock = (sec) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const minutes = Math.floor(cs / 6000);
  const rest = (cs - minutes * 6000) / 100;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0').replace('.', ',')}`;
};

function formatReport(report) {
  const waivedCount = report.gates.filter((g) => g.status === 'waived').length;
  const verdict = report.summary.status === 'error' ? 'оценить нельзя'
    : report.summary.status === 'fail' ? 'СТОП'
      : report.summary.status === 'warn' ? 'есть предупреждения'
        : waivedCount ? `всё хорошо (исключений: ${waivedCount})`
          : 'всё хорошо';
  const lines = [`Проверки (${KIND_TITLES[report.kind] || report.kind}): ${verdict}`];
  if (report.error) lines.push(`❌ Оценить нельзя: ${report.error}`);
  for (const g of report.gates) {
    const value = g.value === null || g.value === undefined ? '' : `: ${number(g.value)}${g.unit ? ` ${g.unit}` : ''}`;
    const threshold = g.threshold == null ? '' : ` (порог ${typeof g.threshold === 'number' ? number(g.threshold) : g.threshold})`;
    lines.push(`${ICONS[g.status]} ${g.id} ${g.title}${value}${threshold}`);
    for (const span of g.spans.slice(0, 3)) lines.push(`   ${clock(span.fromSec)}–${clock(span.toSec)} ${span.note || ''}`.trimEnd());
    // Настоящее имя JSON-файла выбирает writeReport, а не formatReport – здесь нечего подставить
    // вместо него, кроме выдуманного плейсхолдера. Указываем на файл рядом, не называя его.
    if (g.spans.length > 3) lines.push(`   …и ещё ${g.spans.length - 3} – полный список в JSON-отчёте рядом`);
    if (g.hint && g.status !== 'pass') lines.push(`   → ${g.hint}`);
  }
  // Отчёт, прочитанный с диска, может быть старше поля unusedWaivers. ℹ️, а не ☑️: ☑️ – гейт, который
  // исключение действительно сняло. Гейт с warn исключение не трогает – объясняем, почему оно лишнее.
  for (const w of report.unusedWaivers || []) {
    lines.push(`ℹ️ исключение ${w.gate} не понадобилось: ${w.reason} – уберите его из plan.js`);
    if (report.gates.some((g) => g.id === w.gate && g.status === 'warn')) {
      lines.push(`   → ${w.gate} даёт только предупреждение – исключение снимает лишь стоп`);
    }
  }
  return lines.join('\n');
}

// Запись и rename в одном try – тот же приём, что writeJsonAtomic в scripts/pult/files.js:
// randomUUID вместо PID (PID переиспользуют разные процессы и контейнеры), 'wx' не даёт молча
// затереть чужой недописанный временный файл, force-rm подчищает temp при любом сбое записи или
// переименования. Не переиспользуем саму writeJsonAtomic: она пишет только JSON и не принимает
// fileSystem, а здесь нужен и текстовый .txt-отчёт, и инъекционный fs для детерминированного
// теста сбоя rename.
function writeAtomic(file, text, fileSystem) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    fileSystem.writeFileSync(temporary, text, { flag: 'wx' });
    fileSystem.renameSync(temporary, file);
  } catch (error) {
    fileSystem.rmSync(temporary, { force: true });
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
