import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { getMeta, setMeta } from '../lib/db.mjs';
import { assertTimeZone, localDay } from '../lib/time.mjs';

const EVENT_TYPES = new Set(['impression', 'click', 'conversion']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,79}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

export function configuredTimezone(db) {
  const value = getMeta(db, 'event_timezone');
  if (!value) {
    setMeta(db, 'event_timezone', DEFAULT_TIMEZONE);
    return DEFAULT_TIMEZONE;
  }
  return value;
}

function fail(line, message) {
  return { ok: false, line, message };
}

/** Validate one raw record. Returns { ok, value } or { ok:false, message }. */
export function validateEvent(raw, line = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(line, '必须是 JSON 对象');
  const get = (key) => raw[key];
  if (!ID_RE.test(String(get('event_id') || ''))) return fail(line, 'event_id 缺失或格式无效');
  if (!EVENT_TYPES.has(get('event_type'))) return fail(line, 'event_type 必须是 impression/click/conversion');
  for (const key of ['session_id', 'site_id', 'placement_id', 'device_id', 'user_agent', 'ip', 'country']) {
    if (typeof get(key) !== 'string' || String(get(key)).trim() === '') {
      return fail(line, `${key} 缺失`);
    }
  }
  if (!ID_RE.test(String(get('session_id')))) return fail(line, 'session_id 格式无效');
  const ipMatch = IPV4_RE.exec(String(get('ip')));
  if (!ipMatch || ipMatch.slice(1).some((x) => Number(x) > 255)) return fail(line, 'ip 必须是合法 IPv4');
  for (const [key, label] of [
    ['occurred_at', 'occurred_at'],
    ['received_at', 'received_at'],
  ]) {
    const value = get(key);
    if (typeof value !== 'string' || !TS_RE.test(value)) return fail(line, `${label} 必须是带时区的 ISO 时间`);
    if (Number.isNaN(Date.parse(value))) return fail(line, `${label} 无法解析`);
  }
  const occurred = Date.parse(get('occurred_at'));
  const received = Date.parse(get('received_at'));
  if (occurred < Date.parse('2020-01-01T00:00:00Z') || occurred > Date.parse('2035-01-01T00:00:00Z')) {
    return fail(line, 'occurred_at 超出可接受范围');
  }
  if (received + 1000 < occurred) return fail(line, 'received_at 早于 occurred_at');

  if (get('event_type') === 'impression') {
    if (!ID_RE.test(String(get('impression_id') || ''))) return fail(line, 'impression 缺少 impression_id');
    if (get('viewable') !== 0 && get('viewable') !== 1) return fail(line, 'impression 的 viewable 必须是 0 或 1');
  }
  if (get('event_type') === 'click') {
    if (!ID_RE.test(String(get('click_id') || ''))) return fail(line, 'click 缺少 click_id');
    if (!ID_RE.test(String(get('impression_id') || ''))) return fail(line, 'click 缺少 impression_id');
    if (get('click_delay_ms') != null) {
      const d = Number(get('click_delay_ms'));
      if (!Number.isInteger(d) || d < 0 || d > 30 * 24 * 3600 * 1000) return fail(line, 'click_delay_ms 无效');
    }
  }
  if (get('event_type') === 'conversion') {
    if (!ID_RE.test(String(get('click_id') || ''))) return fail(line, 'conversion 缺少 click_id');
    if (!ID_RE.test(String(get('order_id') || ''))) return fail(line, 'conversion 缺少 order_id');
    const revenue = get('revenue_cents');
    if (!Number.isInteger(revenue) || revenue < 0) return fail(line, 'revenue_cents 必须是非负整数');
  }
  if (typeof get('revenue_cents') !== 'undefined' && get('event_type') !== 'conversion') {
    if (!Number.isInteger(get('revenue_cents'))) return fail(line, 'revenue_cents 必须是整数');
  }
  return {
    ok: true,
    line,
    value: {
      event_id: String(get('event_id')),
      event_type: get('event_type'),
      session_id: String(get('session_id')),
      occurred_at: new Date(occurred).toISOString(),
      received_at: new Date(received).toISOString(),
      site_id: String(get('site_id')),
      placement_id: String(get('placement_id')),
      device_id: String(get('device_id')),
      ip: String(get('ip')),
      country: String(get('country')),
      user_agent: String(get('user_agent')),
      referrer: get('referrer') ?? null,
      navigation_type: get('navigation_type') ?? null,
      viewable: get('event_type') === 'impression' ? get('viewable') : null,
      impression_id: get('impression_id') ?? null,
      click_id: get('click_id') ?? null,
      click_delay_ms: get('click_delay_ms') ?? null,
      order_id: get('order_id') ?? null,
      revenue_cents: get('event_type') === 'conversion' ? get('revenue_cents') : 0,
      raw,
    },
  };
}

function digestFile(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Ingest one NDJSON batch file. The whole file is validated first; a single
 * bad line rejects the file so a partially-ingested batch never exists.
 */
export function ingestFile(db, path, { actor = 'ingest', timezone = null } = {}) {
  const tz = timezone || configuredTimezone(db);
  assertTimeZone(tz);
  const name = basename(path);
  const buffer = readFileSync(path);
  const digest = digestFile(buffer);
  const size = statSync(path).size;
  const prior = db.prepare('SELECT * FROM ingest_files WHERE file_name = ?').get(name);
  if (prior) {
    if (prior.digest !== digest) throw new Error(`文件 ${name} 已摄入且内容不同（摘要 ${prior.digest.slice(0, 12)}）；请改名后重试`);
    return { skipped: true, file: prior };
  }

  const lines = buffer.toString('utf8').split(/\r?\n/);
  const parsed = [];
  const errors = [];
  lines.forEach((text, index) => {
    if (text.trim() === '') return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      errors.push({ line: index + 1, message: `JSON 解析失败: ${err.message}` });
      return;
    }
    const result = validateEvent(json, index + 1);
    if (!result.ok) errors.push({ line: result.line, message: result.message });
    else parsed.push(result.value);
  });
  const ingestedAt = new Date().toISOString();
  if (errors.length) {
    db.prepare(
      `INSERT INTO ingest_files (file_name, digest, byte_size, event_count, inserted_count, duplicate_count,
         first_received_at, last_received_at, days, status, error, ingested_at)
       VALUES (?, ?, ?, ?, 0, 0, NULL, NULL, '[]', 'failed', ?, ?)`,
    ).run(name, digest, size, parsed.length, JSON.stringify(errors.slice(0, 20)), ingestedAt);
    const err = new Error(`批次 ${name} 校验失败：第 ${errors[0].line} 行 ${errors[0].message}（共 ${errors.length} 处）`);
    err.errors = errors;
    throw err;
  }
  if (parsed.length === 0) throw new Error(`批次 ${name} 没有有效事件`);

  const insert = db.prepare(
    `INSERT INTO raw_events (event_id, event_type, session_id, occurred_at, received_at, ingest_seq, local_day,
       site_id, placement_id, device_id, ip, country, user_agent, referrer, navigation_type, viewable,
       impression_id, click_id, click_delay_ms, order_id, revenue_cents, batch_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
  );

  let inserted = 0;
  let duplicates = 0;
  let seq = Number(getMeta(db, 'ingest_watermark', '0'));
  const days = new Set();
  let minReceived = null;
  let maxReceived = null;
  let maxLateness = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const rec of parsed) {
      const day = localDay(rec.occurred_at, tz);
      seq += 1;
      const res = insert.run(
        rec.event_id,
        rec.event_type,
        rec.session_id,
        rec.occurred_at,
        rec.received_at,
        seq,
        day,
        rec.site_id,
        rec.placement_id,
        rec.device_id,
        rec.ip,
        rec.country,
        rec.user_agent,
        rec.referrer,
        rec.navigation_type,
        rec.viewable,
        rec.impression_id,
        rec.click_id,
        rec.click_delay_ms,
        rec.order_id,
        rec.revenue_cents,
        name,
        JSON.stringify(rec.raw),
      );
      if (res.changes === 0) {
        duplicates += 1;
        seq -= 1;
        continue;
      }
      inserted += 1;
      days.add(day);
      if (!minReceived || rec.received_at < minReceived) minReceived = rec.received_at;
      if (!maxReceived || rec.received_at > maxReceived) maxReceived = rec.received_at;
      maxLateness = Math.max(maxLateness, Math.round((Date.parse(rec.received_at) - Date.parse(rec.occurred_at)) / 1000));
    }
    setMeta(db, 'ingest_watermark', String(seq));
    const row = db
      .prepare(
        `INSERT INTO ingest_files (file_name, digest, byte_size, event_count, inserted_count, duplicate_count,
           first_received_at, last_received_at, days, received_after_occurrence_seconds, status, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ingested', ?) RETURNING *`,
      )
      .get(name, digest, size, parsed.length, inserted, duplicates, minReceived, maxReceived, JSON.stringify([...days].sort()), maxLateness, ingestedAt);
    db.exec('COMMIT');
    return { skipped: false, file: row, inserted, duplicates, days: [...days].sort(), maxLatenessSeconds: maxLateness };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function ingestDirectory(db, dir, { actor = 'ingest', files = null } = {}) {
  const names = files || readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort();
  const results = [];
  for (const name of names) {
    results.push(ingestFile(db, `${dir}/${name}`, { actor }));
  }
  return results;
}
