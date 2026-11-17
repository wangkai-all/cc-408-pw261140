import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getMeta, setMeta, resetDatabaseFile } from '../lib/db.mjs';
import { ingestFile } from './ingest.mjs';
import { generateDataset, clearDataset } from './synthesize.mjs';
import { DEFAULT_TIMEZONE } from './ingest.mjs';
import { assertTimeZone } from '../lib/time.mjs';
import { cloneRules, DEFAULT_RULES, normalizeRules } from '../engine/rules.mjs';
import {
  createRuleVersion,
  publishRuleVersion,
  addEvidence,
  latestPublishedRule,
} from '../lib/store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_DIR = process.env.EQS_DATA_DIR ? resolve(process.env.EQS_DATA_DIR) : join(ROOT, 'var', 'batches');

export function initDatabase({ timezone = DEFAULT_TIMEZONE, reset = false } = {}) {
  assertTimeZone(timezone);
  if (reset) {
    // The store is append-only by trigger, so a reset drops the database file
    // rather than deleting rows that are contractually immutable.
    resetDatabaseFile();
  }
  const db = openDb();
  setMeta(db, 'event_timezone', timezone);
  if (!getMeta(db, 'ingest_watermark')) setMeta(db, 'ingest_watermark', '0');
  if (!db.prepare("SELECT 1 AS x FROM counters WHERE name = 'job_sequence'").get()) {
    db.prepare("INSERT INTO counters (name, value) VALUES ('job_sequence', 0)").run();
  }
  return db;
}

export function seedRules(db) {
  const bySlug = (slug) => db.prepare('SELECT * FROM rule_versions WHERE slug = ?').get(slug);
  let v1 = bySlug('v1-baseline');
  if (!v1) {
    const rules = cloneRules(DEFAULT_RULES);
    rules.version_label = 'v1 基线';
    v1 = publishRuleVersion(db, createRuleVersion(db, {
      rules,
      slug: 'v1-baseline',
      label: 'v1 基线',
      notes: '点击 40ms–15 分钟、转化 72 小时、UA 特征、会话行为软规则。',
      actor: 'seed',
    }).id, 'seed');
  }
  let v2 = bySlug('v2-strict');
  if (!v2) {
    const rules = normalizeRules({
      version_label: 'v2 严格',
      description: '启用数据中心 IP 前缀，点击下限 120ms，转化窗口 48 小时，间隔均匀度阈值提高到 0.12。',
      hard_checks: {
        click_delay: { min_ms: 120, max_ms: 15 * 60 * 1000, treat_faster_than_min_as: 'invalid' },
        conversion_delay: { max_hours: 48 },
        datacenter_ip: { enabled: true, prefixes: ['203.0.113', '198.51.100'] },
      },
      soft_checks: {
        regular_interval: { cv_threshold: 0.12 },
        high_velocity: { events_per_minute: 24 },
      },
    });
    v2 = publishRuleVersion(db, createRuleVersion(db, {
      rules,
      slug: 'v2-strict',
      label: 'v2 严格',
      notes: '用于和 v1 对比的候选规则；不自动投入生产。',
      actor: 'seed',
    }).id, 'seed');
  }
  return [v1, v2];
}

export function seedDataset({ from, to, timezone, sessionsPerDay = 48, seed = 20261117, reset = true, log = () => {} }) {
  const db = initDatabase({ timezone, reset });
  clearDataset(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  const result = generateDataset({ dir: DATA_DIR, from, to, timezone, seed, sessionsPerDay });
  log(`生成 ${result.events} 条虚构事件，覆盖 ${result.days.length} 个自然日，${result.batches.length} 个批次`);
  const ruleVersions = seedRules(db);
  log(`规则版本：${ruleVersions.map((r) => `#${r.id} ${r.label}`).join('；')}`);
  return { db, dataset: result, ruleVersions };
}

export function readFixtures(dir = DATA_DIR) {
  const path = join(dir, 'fixtures.json');
  if (!existsSync(path)) throw new Error('缺少 fixtures.json，请先执行 seed');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function ingestAll({ dir = DATA_DIR, reset = false, log = () => {} }) {
  const db = openDb();
  if (reset) {
    db.exec('DELETE FROM raw_events');
    db.exec('DELETE FROM ingest_files');
    setMeta(db, 'ingest_watermark', '0');
  }
  const names = readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort();
  let inserted = 0;
  for (const name of names) {
    const r = ingestFile(db, join(dir, name), { actor: 'ingest' });
    inserted += r.inserted || 0;
    log(`${name}: ${r.skipped ? '已摄入，跳过' : `新增 ${r.inserted}，重复 ${r.duplicates}，最大迟到 ${r.maxLatenessSeconds}s`}`);
  }
  return { db, inserted, files: names.length };
}

/**
 * Evidence first arrives in two waves:
 *  1. before any settlement — UA automation tokens and the datacenter ranges
 *     the baseline rules already consult.
 *  2. after day 1 is sealed — device flags and an order reversal found in a
 *     late reconciliation file. This second wave is what makes the same raw
 *     events flip from valid to invalid and drives a correction report.
 */
export function seedEvidence(db, { fixtures, from, insolvent = false, log = () => {} }) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n;
  if (existing > 0) {
    log(`证据已存在（${existing} 条），跳过第一波写入`);
  } else {
    for (const token of ['headlesschrome', 'demobot']) {
      addEvidence(db, {
        kind: 'ua_token',
        key: token,
        label: `UA 自动化特征 ${token}`,
        effectiveFrom: `${from}T00:00:00+08:00`,
        source: 'seed:UA 黑名单（虚构）',
        note: '虚构的自动化浏览器特征，用于演示证据引用。',
        actor: 'seed',
      });
    }
    for (const prefix of ['203.0.113', '198.51.100']) {
      addEvidence(db, {
        kind: 'ip_prefix',
        key: prefix,
        label: `数据中心网段 ${prefix}.0/24`,
        effectiveFrom: `${from}T00:00:00+08:00`,
        source: 'seed:机房清单（虚构）',
        note: '仅用于演示的 RFC 5737 文档网段。',
        actor: 'seed',
      });
    }
    log('写入第一波证据：UA 特征 2 条、IP 前缀 2 条');
  }
  return db;
}

export function seedLateEvidence(db, { fixtures, effectiveFrom, log = () => {} }) {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE source LIKE 'late:%'").get().n;
  if (existing > 0) {
    log('迟到证据已存在，跳过');
    return { flags: 0, reversals: 0 };
  }
  let flags = 0;
  for (const device of fixtures.flagDevices || []) {
    addEvidence(db, {
      kind: 'device_flag',
      key: device,
      label: '人工核查：设备存在点击农场特征',
      effectiveFrom,
      source: 'late:人工核查（虚构）',
      note: '对账时运营发现该设备在多个站点重复点击，标记为无效来源。',
      actor: 'web:ops',
    });
    flags += 1;
  }
  let reversals = 0;
  for (const order of (fixtures.reversalOrders || []).slice(0, 5)) {
    addEvidence(db, {
      kind: 'order_reversal',
      key: order,
      label: '订单已退款',
      effectiveFrom,
      source: 'late:支付对账（虚构）',
      note: '支付通道回调为已退款，订单对应的转化不再计入。',
      actor: 'web:ops',
    });
    reversals += 1;
  }
  log(`写入迟到证据：设备标记 ${flags} 条、订单撤销 ${reversals} 条`);
  return { flags, reversals };
}

export function currentRules(db) {
  return latestPublishedRule(db);
}

export { cloneRules };
