import { createHash } from 'node:crypto';

const FORMATTERS = new Map();

function formatter(timeZone) {
  let f = FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    FORMATTERS.set(timeZone, f);
  }
  return f;
}

const PART_FORMATTERS = new Map();
function partFormatter(timeZone) {
  let f = PART_FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PART_FORMATTERS.set(timeZone, f);
  }
  return f;
}

export function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    throw new Error(`未知时区: ${timeZone}`);
  }
}

/** Local calendar day (YYYY-MM-DD) for an instant in the given zone. */
export function localDay(instant, timeZone) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new Error(`无效时间: ${instant}`);
  return formatter(timeZone).format(d);
}

function zonedParts(instant, timeZone) {
  const parts = partFormatter(timeZone).formatToParts(
    instant instanceof Date ? instant : new Date(instant),
  );
  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** Convert a wall-clock local time (day + HH:MM) in a zone to a UTC Date. */
export function zonedTimeToUtc(day, time, timeZone) {
  assertTimeZone(timeZone);
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(new Date(guess), timeZone);
    const rendered = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    const delta = target - rendered;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

export function zonedTimeIso(day, time, timeZone) {
  return zonedTimeToUtc(day, time, timeZone).toISOString();
}

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function dayRange(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('日期必须是 YYYY-MM-DD');
  }
  if (from > to) throw new Error('起始日期晚于结束日期');
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    days.push(d);
    if (days.length > 366) throw new Error('日期范围过大');
  }
  return days;
}

export function toIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`无效时间: ${value}`);
  return d.toISOString();
}

export function secondsBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
}

export function minutesBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
}

export function nowIso() {
  return new Date().toISOString();
}

export function shortHash(value, length = 10) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

export function formatDayLabel(day) {
  const [y, m, d] = day.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}
