import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ingestFile } from '../src/ingest/ingest.mjs';
import { tempDb, writeBatch, ingestEvents, cleanSession, makeClick, makeImpression, publishRules, processQueue, enqueueAndRun } from './helpers.mjs';
import { enqueueJob, sealSettlement, settlementForDay, addEvidence } from '../src/lib/store.mjs';

const DAY = '2026-02-01';

test('a batch with one bad line is rejected whole and writes nothing', async (t) => {
  const { db, dir } = tempDb(t);
  const { events } = cleanSession({ day: DAY });
  const bad = { ...events[1], event_id: 'x' }; // too short for the id pattern
  const path = writeBatch(dir, 'batch-bad.ndjson', [...events, bad]);
  assert.throws(() => ingestFile(db, path), /校验失败/);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_events').get().n, 0, '不得部分写入');
  const file = db.prepare('SELECT * FROM ingest_files WHERE file_name = ?').get('batch-bad.ndjson');
  assert.equal(file.status, 'failed');
  assert.equal(file.inserted_count, 0);
  assert.match(file.error, /event_id 缺失或格式无效/);
});

test('a rejected file keeps its digest, so fixed content must use a new name', async (t) => {
  const { db, dir } = tempDb(t);
  const { events } = cleanSession({ day: DAY });
  const path = writeBatch(dir, 'batch-dup.ndjson', [...events, { event_type: 'click' }]);
  assert.throws(() => ingestFile(db, path), /校验失败/);
  // Same name, valid content now: the digest changed, so re-ingest is refused.
  writeBatch(dir, 'batch-dup.ndjson', events);
  assert.throws(() => ingestFile(db, path), /已摄入且内容不同/);
  // A new name with the same bytes is accepted.
  const renamed = writeBatch(dir, 'batch-dup-fixed.ndjson', events);
  const result = ingestFile(db, renamed);
  assert.equal(result.inserted, 2);
});

test('re-ingesting the identical file is skipped rather than duplicated', async (t) => {
  const { db, dir } = tempDb(t);
  const { events } = cleanSession({ day: DAY });
  const path = writeBatch(dir, 'batch-same.ndjson', events);
  assert.equal(ingestFile(db, path).inserted, 2);
  const again = ingestFile(db, path);
  assert.equal(again.skipped, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_events').get().n, 2);
});

test('a duplicate event id inside one batch increments the ingest sequence only once', async (t) => {
  const { db, dir } = tempDb(t);
  const { events, clickId } = cleanSession({ day: DAY });
  // The same click id copied into the batch a second time: ON CONFLICT keeps
  // the first row (first ingest wins).
  const result = ingestFile(db, writeBatch(dir, 'batch-twice.ndjson', [...events, { ...events[1] }]));
  assert.equal(result.inserted, 2);
  assert.equal(result.duplicates, 1);
  const click = db.prepare('SELECT * FROM raw_events WHERE event_id = ?').get(clickId);
  assert.equal(click.ingest_seq, 2);
  assert.equal(db.prepare('SELECT value FROM meta WHERE key = ?').get('ingest_watermark').value, '2');
});

/* ------------------------------------------------------------------------- */
/* Append-only triggers                                                       */
/* ------------------------------------------------------------------------- */

function rejects(db, sql, params, pattern) {
  assert.throws(() => db.prepare(sql).run(...params), pattern);
}

test('raw facts, evidence, decisions and audit rows reject UPDATE and DELETE', async (t) => {
  const { db, dir } = tempDb(t);
  const { events } = cleanSession({ day: DAY });
  ingestEvents(db, dir, events);
  addEvidence(db, {
    kind: 'device_flag',
    key: 'dev_clean_1',
    label: '测试证据',
    effectiveFrom: `${DAY}T00:00:00.000Z`,
    source: 'test',
    actor: 'test',
  });
  const rule = publishRules(db, { label: 'immutable' });
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: rule.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['evaluate']);

  rejects(db, "UPDATE raw_events SET ip = '1.1.1.1'", [], /不可修改/);
  rejects(db, 'DELETE FROM raw_events', [], /不可删除/);
  rejects(db, "UPDATE evidence SET label = 'x'", [], /不可修改/);
  rejects(db, 'DELETE FROM evidence', [], /不可删除/);
  rejects(db, "UPDATE decisions SET verdict = 'valid'", [], /不可修改/);
  rejects(db, 'DELETE FROM decisions', [], /不可删除/);
  rejects(db, 'UPDATE decision_contributions SET detail = NULL', [], /不可修改/);
  rejects(db, 'DELETE FROM decision_contributions', [], /不可删除/);
  rejects(db, "UPDATE audit_log SET actor = 'x'", [], /不可修改/);
  rejects(db, "UPDATE job_events SET message = 'x'", [], /不可修改/);
});

test('a published rule version cannot be edited, and a draft cannot be published twice', async (t) => {
  const { db } = tempDb(t);
  const rule = publishRules(db, { label: 'frozen' });
  rejects(db, 'UPDATE rule_versions SET rules_json = ?', ['{}'], /不可修改/);
  // Retiring is allowed; re-publishing a retired version is refused in code.
  const { retireRuleVersion, publishRuleVersion } = await import('../src/lib/store.mjs');
  retireRuleVersion(db, rule.id, 'test');
  assert.throws(() => publishRuleVersion(db, rule.id, 'test'), /已退役/);
});

/* ------------------------------------------------------------------------- */
/* Duplicate order ids: first ingest wins                                     */
/* ------------------------------------------------------------------------- */

test('the first ingested copy of an order is valid and later copies are invalid', async (t) => {
  const { db, dir } = tempDb(t);
  const sessionA = cleanSession({ day: DAY, session: 'ses_first', device: 'dev_a', ip: '10.0.0.1' });
  const first = [...sessionA.events];
  const conversion = {
    event_id: 'cnv_first',
    event_type: 'conversion',
    session_id: 'ses_first',
    occurred_at: `${DAY}T10:02:00.000Z`,
    received_at: `${DAY}T10:02:02.000Z`,
    site_id: 'site_demo',
    placement_id: 'pl_demo',
    device_id: 'dev_a',
    ip: '10.0.0.1',
    country: 'CN',
    user_agent: 'Mozilla/5.0 (Macintosh) Version/17.1 Safari/605.1.15',
    click_id: sessionA.clickId,
    order_id: 'ord_reused_1',
    revenue_cents: 50_000,
  };
  ingestFile(db, writeBatch(dir, 'batch-1.ndjson', [...first, conversion]));

  // A second, later-ingested session books the very same order id.
  const sessionB = cleanSession({ day: DAY, session: 'ses_second', device: 'dev_b', ip: '10.0.0.2' });
  ingestFile(
    db,
    writeBatch(dir, 'batch-2.ndjson', [
      ...sessionB.events,
      { ...conversion, event_id: 'cnv_second', session_id: 'ses_second', click_id: sessionB.clickId, received_at: `${DAY}T11:00:00.000Z`, occurred_at: `${DAY}T11:00:00.000Z` },
    ]),
  );

  const rule = publishRules(db, { label: 'dup' });
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: rule.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['evaluate']);
  const head = db.prepare("SELECT run_id FROM run_heads WHERE local_day = ?").get(DAY);
  const rows = db
    .prepare('SELECT event_id, verdict, primary_reason FROM decisions WHERE run_id = ? AND event_id LIKE ? ORDER BY event_id')
    .all(head.run_id, 'cnv_%')
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { event_id: 'cnv_first', verdict: 'valid', primary_reason: null },
    { event_id: 'cnv_second', verdict: 'invalid', primary_reason: 'duplicate_order' },
  ]);
});

/* ------------------------------------------------------------------------- */
/* Sealed settlements                                                         */
/* ------------------------------------------------------------------------- */

async function settleDay(t, { includeSuspect = false } = {}) {
  const { db, dir } = tempDb(t);
  const { events } = cleanSession({ day: DAY });
  ingestEvents(db, dir, events);
  const rule = publishRules(db, { label: 'settle' });
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: rule.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['evaluate']);
  enqueueJob(db, { kind: 'settle', scopeFrom: DAY, scopeTo: DAY, params: includeSuspect ? { includeSuspect: true } : {}, actor: 'test' });
  await processQueue(db, ['settle']);
  return { db, dir, rule };
}

test('a draft settlement drafts once and seals only against the current head run', async (t) => {
  const { db, rule } = await settleDay(t);
  const draft = db.prepare("SELECT * FROM settlements WHERE local_day = ? AND status = 'draft'").get(DAY);
  assert.ok(draft);
  assert.equal(draft.settled_amount_cents, 85, '一次有效点击按 85 分结算');
  assert.equal(draft.gross_amount_cents, 85);
  assert.equal(draft.valid_count, 2);

  const sealed = sealSettlement(db, DAY, { actor: 'test' });
  assert.equal(sealed.status, 'sealed');
  assert.equal(sealed.sealed_amount_cents, undefined);
  assert.equal(sealed.settled_amount_cents, 85);
  const after = settlementForDay(db, DAY);
  assert.equal(after.sealed.id, sealed.id);
  assert.equal(after.netSettled, 85);
  assert.throws(() => sealSettlement(db, DAY, { actor: 'test' }), /没有可封存的结算草稿/);
  assert.equal(rule.status, 'published');
});

test('a sealed settlement rejects UPDATE and DELETE, and a new draft cannot replace it', async (t) => {
  const { db } = await settleDay(t);
  const sealed = sealSettlement(db, DAY, { actor: 'test' });
  rejects(db, 'UPDATE settlements SET settled_amount_cents = 0 WHERE id = ?', [sealed.id], /不可改写/);
  rejects(db, 'DELETE FROM settlements WHERE id = ?', [sealed.id], /不可删除/);

  // A newer run does not unseal anything; re-drafting leaves the sealed row.
  const rule2 = publishRules(db, { label: 'settle-v2', patch: { settlement: { payout_per_valid_click_cents: 100, currency: 'CNY', include_suspect: false, payout_per_valid_conversion_ratio: 0.08 } } });
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: rule2.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['evaluate']);
  enqueueJob(db, { kind: 'settle', scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['settle']);
  const rows = db.prepare('SELECT status, settled_amount_cents FROM settlements WHERE local_day = ? ORDER BY id').all(DAY);
  assert.equal(rows.filter((r) => r.status === 'sealed').length, 1);
  assert.equal(rows.find((r) => r.status === 'sealed').settled_amount_cents, 85);
  assert.equal(rows.filter((r) => r.status === 'draft').length, 1);
  assert.equal(rows.find((r) => r.status === 'draft').settled_amount_cents, 100);
});

test('suspect events are excluded unless include_suspect is set', async (t) => {
  const { db, dir } = tempDb(t);
  // Twenty evenly spaced impressions make the session suspect (soft): the
  // coefficient of variation of the gaps is 0, below the 0.05 threshold.
  const events = [];
  const start = Date.parse(`${DAY}T09:00:00.000Z`);
  for (let i = 0; i < 20; i += 1) {
    const at = new Date(start + i * 5000).toISOString();
    events.push(makeImpression({ id: `imp_burst_${String(i).padStart(2, '0')}`, session: 'ses_burst', at }));
  }
  events.push({
    ...makeClick({ id: 'clk_burst', session: 'ses_burst', at: new Date(start + 20 * 5000).toISOString(), impression: 'imp_burst_00', delayMs: 100_000 }),
  });
  ingestEvents(db, dir, events);
  const rule = publishRules(db, { label: 'suspect-rules' });
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: rule.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['evaluate']);

  enqueueJob(db, { kind: 'settle', scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['settle']);
  const strict = db.prepare("SELECT * FROM settlements WHERE local_day = ? AND status = 'draft'").get(DAY);
  assert.ok(strict.suspect_count > 0);
  assert.equal(strict.settled_amount_cents, 0, '可疑事件默认不结算');

  enqueueJob(db, { kind: 'settle', scopeFrom: DAY, scopeTo: DAY, params: { includeSuspect: true }, actor: 'test' });
  await processQueue(db, ['settle']);
  const loose = db.prepare("SELECT * FROM settlements WHERE local_day = ? AND status = 'draft'").get(DAY);
  assert.equal(loose.settled_amount_cents, 85);
});

test('sealing refuses when the draft was built on a superseded run', async (t) => {
  const { db } = await settleDay(t);
  // Commit a newer run without asking for a new draft.
  const rule2 = publishRules(db, { label: 'settle-v3' });
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: rule2.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['evaluate']);
  assert.throws(() => sealSettlement(db, DAY, { actor: 'test' }), /已被更新结果替代/);
});
