import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueJob, sealSettlement, settlementForDay, addEvidence } from '../src/lib/store.mjs';
import { approveReport, buildDiffReport, getReport, rejectReport } from '../src/engine/diff.mjs';
import { tempDb, ingestEvents, cleanSession, publishRules, processQueue } from './helpers.mjs';

const D1 = '2026-02-01';
const D2 = '2026-02-02';

function twoDays(db, dir, extra = () => []) {
  const a = cleanSession({ day: D1, session: 'ses_d1', device: 'dev_flag_1', ip: '10.0.0.1' });
  const b = cleanSession({ day: D2, session: 'ses_d2', device: 'dev_flag_1', ip: '10.0.0.1' });
  ingestEvents(db, dir, [...a.events, ...b.events, ...extra()], 'batch-days.ndjson');
  return { a, b };
}

async function evaluateAll(db, ruleId, from = D1, to = D2) {
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: ruleId, scopeFrom: from, scopeTo: to, actor: 'test' });
  await processQueue(db, ['evaluate']);
}

async function settleAll(db, from = D1, to = D2) {
  enqueueJob(db, { kind: 'settle', scopeFrom: from, scopeTo: to, actor: 'test' });
  await processQueue(db, ['settle']);
}

async function buildReport(db, spec) {
  const job = enqueueJob(db, { kind: spec.kind === 'correction' ? 'correction' : 'compare', scopeFrom: D1, scopeTo: D2, actor: 'test', ...spec });
  await processQueue(db, ['compare', 'correction']);
  const row = db.prepare('SELECT * FROM diff_reports WHERE job_id = ?').get(job.id);
  assert.ok(row, '报告必须由任务生成');
  return row;
}

test('a correction report compares settled history against a fresh evaluation', async (t) => {
  const { db, dir } = tempDb(t);
  twoDays(db, dir);
  const v1 = publishRules(db, { label: 'corr-v1' });
  await evaluateAll(db, v1.id);
  await settleAll(db);
  sealSettlement(db, D1, { actor: 'test' });

  // No evidence yet: correcting under the same rule must show zero changes.
  const quiet = await buildReport(db, {
    kind: 'correction',
    ruleVersionId: v1.id,
    params: { baselineRuleId: v1.id, candidateRuleId: v1.id },
  });
  assert.equal(quiet.summary_json && JSON.parse(quiet.summary_json).totals.changedEvents, 0);

  // A device flag arrived after the fact.
  addEvidence(db, {
    kind: 'device_flag',
    key: 'dev_flag_1',
    label: '人工核查：点击农场设备',
    effectiveFrom: `${D1}T00:00:00.000Z`,
    source: 'test:ops',
    actor: 'test:ops',
  });

  const report = await buildReport(db, {
    kind: 'correction',
    ruleVersionId: v1.id,
    params: { baselineRuleId: v1.id, candidateRuleId: v1.id },
  });
  const detail = getReport(db, report.id);
  assert.equal(report.kind, 'correction');
  // The device rule is session/evidence scoped, so it invalidates the whole
  // session: one impression (0 分) and one click (85 分) on each day.
  assert.equal(detail.summary.totals.changedEvents, 4, '两天各有一条曝光与一条点击从有效变为无效');
  assert.equal(detail.summary.totals.deltaAmount, -170);
  assert.equal(detail.days.find((d) => d.local_day === D1).sealed, 1);
  assert.equal(detail.days.find((d) => d.local_day === D2).sealed, 0);
  assert.deepEqual(
    detail.sampleEvents.map((e) => [e.event_id, e.old_verdict, e.new_verdict, e.new_reason]).sort(),
    [
      ['clk_ses_d1', 'valid', 'invalid', '设备 dev_flag_1 命中「人工核查：点击农场设备」'],
      ['clk_ses_d2', 'valid', 'invalid', '设备 dev_flag_1 命中「人工核查：点击农场设备」'],
      ['imp_ses_d1', 'valid', 'invalid', '设备 dev_flag_1 命中「人工核查：点击农场设备」'],
      ['imp_ses_d2', 'valid', 'invalid', '设备 dev_flag_1 命中「人工核查：点击农场设备」'],
    ],
  );
  assert.deepEqual(
    detail.reasons.map((r) => [r.direction, r.rule_id, r.events]),
    [['became_invalid', 'device_flag', 4]],
  );

  // The baseline really is the stored decision set: a rule_compare v1→v1 would
  // see the new evidence on both sides and report nothing.
  const sameRule = db.prepare('SELECT * FROM diff_reports WHERE id = ?').get(report.id);
  assert.equal(sameRule.baseline_rule_version_id, v1.id);
  assert.equal(sameRule.candidate_rule_version_id, v1.id);
});

test('approving a correction posts adjustments on sealed days and restates drafts elsewhere', async (t) => {
  const { db, dir } = tempDb(t);
  twoDays(db, dir);
  const v1 = publishRules(db, { label: 'approve-v1' });
  await evaluateAll(db, v1.id);
  await settleAll(db);
  const sealed = sealSettlement(db, D1, { actor: 'test' });
  addEvidence(db, {
    kind: 'device_flag',
    key: 'dev_flag_1',
    label: '人工核查：点击农场设备',
    effectiveFrom: `${D1}T00:00:00.000Z`,
    source: 'test:ops',
    actor: 'test:ops',
  });
  const report = await buildReport(db, {
    kind: 'correction',
    ruleVersionId: v1.id,
    params: { baselineRuleId: v1.id, candidateRuleId: v1.id },
  });

  const result = approveReport(db, report.id, { actor: 'test:reviewer', note: '确认' });
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.applied[0], { day: D1, deltaAmount: -85 });
  assert.deepEqual(result.restate, [D2]);

  const day1 = settlementForDay(db, D1);
  assert.equal(day1.sealed.id, sealed.id);
  assert.equal(day1.sealed.settled_amount_cents, 85, '封存金额本身绝不改写');
  assert.equal(day1.adjustments.length, 1);
  assert.equal(day1.adjustmentTotal, -85);
  assert.equal(day1.netSettled, 0);
  assert.equal(day1.adjustments[0].delta_invalid_count, 2);
  assert.equal(day1.adjustments[0].delta_valid_count, -2);

  const day2 = settlementForDay(db, D2);
  assert.equal(day2.sealed, null);
  assert.equal(day2.draft, null, '未封存日应丢弃草稿等待重算，而不是挂调整分录');

  const approved = db.prepare('SELECT * FROM diff_reports WHERE id = ?').get(report.id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.reviewed_by, 'test:reviewer');
  // A finalised report can no longer be updated (trigger), nor approved twice.
  assert.throws(() => db.prepare("UPDATE diff_reports SET title = 'x' WHERE id = ?").run(report.id), /已定稿/);
  assert.throws(() => approveReport(db, report.id, { actor: 'test' }), /不能重复处理/);
  assert.throws(() => rejectReport(db, report.id, { actor: 'test' }), /只有草稿/);
});

test('approval is idempotent per day: the same report cannot post two adjustments', async (t) => {
  const { db, dir } = tempDb(t);
  twoDays(db, dir);
  const v1 = publishRules(db, { label: 'idem-v1' });
  await evaluateAll(db, v1.id);
  await settleAll(db);
  sealSettlement(db, D1, { actor: 'test' });
  addEvidence(db, {
    kind: 'device_flag',
    key: 'dev_flag_1',
    label: '人工核查：点击农场设备',
    effectiveFrom: `${D1}T00:00:00.000Z`,
    source: 'test:ops',
  });
  const report = await buildReport(db, {
    kind: 'correction',
    ruleVersionId: v1.id,
    params: { baselineRuleId: v1.id, candidateRuleId: v1.id },
  });
  approveReport(db, report.id, { actor: 'reviewer' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settlement_adjustments').get().n, 1);
  // Adjustments themselves are append-only.
  assert.throws(() => db.prepare('UPDATE settlement_adjustments SET delta_amount_cents = 0').run(), /不可修改/);
  assert.throws(() => db.prepare('DELETE FROM settlement_adjustments').run(), /不可删除/);
});

test('a rejected report leaves settlements untouched and cannot be approved later', async (t) => {
  const { db, dir } = tempDb(t);
  twoDays(db, dir);
  const v1 = publishRules(db, { label: 'reject-v1' });
  await evaluateAll(db, v1.id);
  await settleAll(db);
  sealSettlement(db, D1, { actor: 'test' });
  addEvidence(db, {
    kind: 'device_flag',
    key: 'dev_flag_1',
    label: '人工核查：点击农场设备',
    effectiveFrom: `${D1}T00:00:00.000Z`,
    source: 'test:ops',
  });
  const report = await buildReport(db, {
    kind: 'correction',
    ruleVersionId: v1.id,
    params: { baselineRuleId: v1.id, candidateRuleId: v1.id },
  });
  rejectReport(db, report.id, { actor: 'reviewer', note: '证据不够' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settlement_adjustments').get().n, 0);
  assert.equal(settlementForDay(db, D1).adjustments.length, 0);
  assert.equal(settlementForDay(db, D2).draft.settled_amount_cents, 85);
  assert.throws(() => approveReport(db, report.id, { actor: 'reviewer' }), /不能重复处理/);
});

test('rule_compare recomputes both versions on one frozen snapshot and is reproducible', async (t) => {
  const { db, dir } = tempDb(t);
  twoDays(db, dir);
  const v1 = publishRules(db, { label: 'cmp-v1' });
  const v2 = publishRules(db, {
    label: 'cmp-v2',
    patch: {
      hard_checks: { datacenter_ip: { enabled: true, prefixes: ['203.0.113'] } },
      settlement: { payout_per_valid_click_cents: 120, currency: 'CNY', include_suspect: false, payout_per_valid_conversion_ratio: 0.08 },
    },
  });
  await evaluateAll(db, v1.id);

  const first = await buildReport(db, {
    kind: 'compare',
    ruleVersionId: v2.id,
    params: { baselineRuleId: v1.id, candidateRuleId: v2.id },
  });
  const second = await buildReport(db, {
    kind: 'compare',
    ruleVersionId: v2.id,
    params: { baselineRuleId: v1.id, candidateRuleId: v2.id },
  });
  assert.equal(first.digest, second.digest, '相同快照与规则必须得到相同摘要');
  assert.deepEqual(first.baseline_run_ids_json, second.baseline_run_ids_json);

  // Payout changes alone move the amount without changing any verdict.
  const detail = getReport(db, first.id);
  assert.equal(detail.summary.totals.changedEvents, 0);
  assert.equal(detail.summary.totals.deltaValid, 0);
  assert.equal(detail.summary.totals.deltaAmount, 2 * 35, '两天各一次点击，单价 85→120');
  assert.equal(detail.summary.candidate.ruleVersionId, v2.id);
  assert.equal(detail.summary.baseline.ruleVersionId, v1.id);
});

test('rule_compare attributes a rule change, not new data, to the delta', async (t) => {
  const { db, dir } = tempDb(t);
  const clean = cleanSession({ day: D1, session: 'ses_dc', device: 'dev_dc', ip: '203.0.113.9' });
  ingestEvents(db, dir, clean.events, 'batch-dc.ndjson');
  const v1 = publishRules(db, { label: 'dc-v1' });
  const v2 = publishRules(db, { label: 'dc-v2', patch: { hard_checks: { datacenter_ip: { enabled: true, prefixes: ['203.0.113'] } } } });
  await evaluateAll(db, v1.id, D1, D1);
  const report = await buildReport(db, {
    kind: 'compare',
    ruleVersionId: v2.id,
    params: { baselineRuleId: v1.id, candidateRuleId: v2.id },
  });
  const detail = getReport(db, report.id);
  // The datacenter check runs per event, so both the impression and the click
  // of the session flip; only the click carries an amount.
  assert.equal(detail.summary.totals.changedEvents, 2);
  assert.equal(detail.summary.totals.deltaAmount, -85);
  assert.deepEqual(
    detail.reasons.map((r) => [r.direction, r.rule_id, r.events, r.delta_amount_cents]),
    [['became_invalid', 'datacenter_ip', 2, -85]],
  );
  assert.ok(detail.sampleEvents.some((e) => e.new_reason === 'IP 前缀 203.0.113 属于数据中心'));
  // The production head still points at the v1 run: a comparison never
  // promotes the candidate.
  const head = db.prepare("SELECT rule_version_id FROM run_heads WHERE local_day = ?").get(D1);
  assert.equal(head.rule_version_id, v1.id);
});

test('a draft rule version cannot be used for a comparison', async (t) => {
  const { db, dir } = tempDb(t);
  twoDays(db, dir);
  const v1 = publishRules(db, { label: 'draft-base' });
  await evaluateAll(db, v1.id);
  const { createRuleVersion } = await import('../src/lib/store.mjs');
  const { DEFAULT_RULES, cloneRules } = await import('../src/engine/rules.mjs');
  const draftRules = cloneRules(DEFAULT_RULES);
  draftRules.version_label = '草稿候选';
  const draft = createRuleVersion(db, { rules: draftRules, label: '草稿候选', actor: 'test' });
  assert.equal(draft.status, 'draft');
  assert.throws(
    () => enqueueJob(db, { kind: 'compare', ruleVersionId: draft.id, scopeFrom: D1, scopeTo: D2, actor: 'test' }),
    /草稿规则不能用于/,
  );
  // A direct report build still refuses it because the evaluator loads only
  // the named version; a missing version must fail loudly rather than silently
  // falling back to something else.
  assert.throws(
    () =>
      buildDiffReport(db, {
        job: { id: 'manual', stream: 'production', scope_from: D1, scope_to: D2, params: {} },
        kind: 'rule_compare',
        baselineRuleId: v1.id,
        candidateRuleId: 9999,
        days: [D1],
        actor: 'test',
      }),
    /不存在/,
  );
});

test('the stored day rows match the event-level changes they claim', async (t) => {
  const { db, dir } = tempDb(t);
  twoDays(db, dir);
  const v1 = publishRules(db, { label: 'rows-v1' });
  const v2 = publishRules(db, { label: 'rows-v2', patch: { hard_checks: { datacenter_ip: { enabled: true, prefixes: ['10.0.0'] } } } });
  await evaluateAll(db, v1.id);
  const report = await buildReport(db, {
    kind: 'compare',
    ruleVersionId: v2.id,
    params: { baselineRuleId: v1.id, candidateRuleId: v2.id },
  });
  const detail = getReport(db, report.id);
  for (const day of detail.days) {
    const events = db.prepare('SELECT * FROM diff_events WHERE report_id = ? AND local_day = ?').all(report.id, day.local_day);
    assert.equal(events.length, day.changed_events);
    assert.equal(
      events.reduce((a, e) => a + e.delta_amount_cents, 0),
      day.new_amount_cents - day.old_amount_cents,
      `${day.local_day} 的逐事件金额差必须等于日汇总差`,
    );
    assert.equal(day.new_valid + day.new_invalid + day.new_suspect, day.old_valid + day.old_invalid + day.old_suspect);
  }
});

test('evidence added while the comparison runs does not leak into its frozen snapshot', async (t) => {
  const { db, dir } = tempDb(t);
  twoDays(db, dir);
  const v1 = publishRules(db, { label: 'snap-v1' });
  await evaluateAll(db, v1.id);
  // The evidence row is inserted after the worker captured the snapshot but
  // before the candidate evaluation begins.
  const { captureSnapshot } = await import('../src/lib/context.mjs');
  const { buildDiffReport: build } = await import('../src/engine/diff.mjs');
  const snapshot = captureSnapshot(db);
  addEvidence(db, {
    kind: 'device_flag',
    key: 'dev_flag_1',
    label: '运行中到达的证据',
    effectiveFrom: `${D1}T00:00:00.000Z`,
    source: 'late:race-test',
  });
  const job = enqueueJob(db, { kind: 'compare', scopeFrom: D1, scopeTo: D2, ruleVersionId: v1.id, params: { baselineRuleId: v1.id, candidateRuleId: v1.id }, actor: 'test' });
  const report = build(db, {
    job: { ...job, params: job.params || {}, stream: 'production' },
    kind: 'rule_compare',
    baselineRuleId: v1.id,
    candidateRuleId: v1.id,
    days: [D1, D2],
    actor: 'test',
    snapshot,
  });
  const detail = getReport(db, report.id);
  assert.equal(detail.summary.totals.changedEvents, 0, '冻结快照内证据集合一致，不应出现差异');

  // Without the frozen snapshot the same inputs do see the new evidence.
  const fresh = await buildReport(db, {
    kind: 'correction',
    ruleVersionId: v1.id,
    params: { baselineRuleId: v1.id, candidateRuleId: v1.id },
  });
  assert.ok(JSON.parse(fresh.summary_json).totals.changedEvents > 0);
});
