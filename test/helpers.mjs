/**
 * Shared fixtures for the test suite. Every test builds its own temporary
 * database file, so no test can see another one's rows. All events are
 * hand-written fictional records; nothing here touches the real dataset.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, setMeta } from '../src/lib/db.mjs';
import { claimJob, createRuleVersion, enqueueJob, finishJob, publishRuleVersion } from '../src/lib/store.mjs';
import { addDays } from '../src/lib/time.mjs';
import { cloneRules, DEFAULT_RULES, normalizeRules } from '../src/engine/rules.mjs';
import { ingestFile } from '../src/ingest/ingest.mjs';
import { runJob } from '../src/worker/worker.mjs';

export const CLEAN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
export const HEADLESS_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/118.0.0.0 Safari/537.36';

export function tempDb(t, { timezone = 'UTC' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eqs-test-'));
  const db = openDb({ file: join(dir, 'test.db') });
  setMeta(db, 'event_timezone', timezone);
  setMeta(db, 'ingest_watermark', '0');
  db.prepare("INSERT OR REPLACE INTO counters (name, value) VALUES ('job_sequence', 0)").run();
  t.after(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

/** An empty temporary directory for tests that spawn processes. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eqs-proc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      deepMerge(target[key], value);
    } else {
      target[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return target;
}

/** Create and publish a rule version derived from the defaults. Returns the parsed row (with `.rules`). */
export function publishRules(db, { label, slug, patch = {}, base = DEFAULT_RULES } = {}) {
  const merged = deepMerge(cloneRules(base), patch);
  const rules = normalizeRules(merged);
  const created = createRuleVersion(db, { rules, label, slug: slug || `rule-${label}`, actor: 'test' });
  const published = publishRuleVersion(db, created.id, 'test');
  return { ...published, rules };
}

export function plus(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function makeImpression({
  id,
  session,
  at,
  impression = null,
  device = 'dev_clean_1',
  ip = '10.1.2.3',
  ua = CLEAN_UA,
  viewable = 1,
}) {
  return {
    event_id: id,
    event_type: 'impression',
    session_id: session,
    occurred_at: at,
    received_at: plus(at, 1500),
    site_id: 'site_demo',
    placement_id: 'pl_demo',
    device_id: device,
    ip,
    country: 'CN',
    user_agent: ua,
    impression_id: impression || id,
    viewable,
  };
}

export function makeClick({
  id,
  session,
  at,
  impression,
  delayMs = null,
  device = 'dev_clean_1',
  ip = '10.1.2.3',
  ua = CLEAN_UA,
}) {
  const ev = {
    event_id: id,
    event_type: 'click',
    session_id: session,
    occurred_at: at,
    received_at: plus(at, 1000),
    site_id: 'site_demo',
    placement_id: 'pl_demo',
    device_id: device,
    ip,
    country: 'CN',
    user_agent: ua,
    click_id: id,
    impression_id: impression,
  };
  if (delayMs != null) ev.click_delay_ms = delayMs;
  return ev;
}

export function makeConversion({
  id,
  session,
  at,
  click,
  order,
  revenue = 20_000,
  device = 'dev_clean_1',
  ip = '10.1.2.3',
  ua = CLEAN_UA,
}) {
  return {
    event_id: id,
    event_type: 'conversion',
    session_id: session,
    occurred_at: at,
    received_at: plus(at, 2000),
    site_id: 'site_demo',
    placement_id: 'pl_demo',
    device_id: device,
    ip,
    country: 'CN',
    user_agent: ua,
    click_id: click,
    order_id: order,
    revenue_cents: revenue,
  };
}

export function writeBatch(dir, name, events) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  return path;
}

export function ingestEvents(db, dir, events, name = 'batch-001.ndjson') {
  return ingestFile(db, writeBatch(dir, name, events));
}

/** A simple, fully valid session: impression → click. Click payout is 85 cents. */
export function cleanSession({ day = '2026-02-01', session = 'ses_clean_1', device = 'dev_clean_1', ip = '10.1.2.3' } = {}) {
  const impressionId = `imp_${session}`;
  const clickId = `clk_${session}`;
  return {
    impressionId,
    clickId,
    events: [
      makeImpression({ id: impressionId, session, at: `${day}T10:00:00.000Z`, device, ip }),
      makeClick({ id: clickId, session, at: `${day}T10:00:01.000Z`, impression: impressionId, delayMs: 1000, device, ip }),
    ],
  };
}

/** Claim jobs of the given kinds until the queue is empty, executing each. */
export async function processQueue(db, kinds = ['evaluate', 'compare', 'correction', 'settle'], { workerId = 'test-worker' } = {}) {
  const processed = [];
  for (;;) {
    const job = claimJob(db, { kinds, workerId });
    if (!job) break;
    const result = await runJob(db, job, {});
    finishJob(db, job.id, job.fence, { status: 'succeeded', result });
    processed.push({ job, result });
  }
  return processed;
}

export async function enqueueAndRun(db, kinds, spec, options) {
  const job = enqueueJob(db, { actor: 'test', ...spec });
  await processQueue(db, kinds, options);
  return job;
}

export { addDays };
