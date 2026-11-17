import { tx } from '../lib/db.mjs';
import {
  currentWatermarks,
  dayEvents,
  evidenceRows,
  getRuleVersion,
  jobLog,
  orderFirstSeq,
  sessionContext,
} from '../lib/store.mjs';
import { evaluateDay } from './evaluate.mjs';
import { RULE_LABELS } from './rules.mjs';
import { digestOf, parseJson } from '../lib/util.mjs';
import { captureSnapshot, loadEvaluationInputs } from '../lib/context.mjs';

function amountFor(verdict, amountCents, includeSuspect) {
  if (verdict === 'valid') return amountCents;
  if (verdict === 'suspect') return includeSuspect ? amountCents : 0;
  return 0;
}

/**
 * Evaluate both rule versions over the same frozen input snapshot.
 *
 * The snapshot is the ingest watermark and evidence set read once at the start
 * of the job. Comparing two runs that saw different inputs would attribute
 * data growth to the rule change, so both sides are recomputed here rather
 * than reusing whatever happened to be the current head.
 */
function evaluateSnapshot(db, { ruleVersionId, days, includeSuspect, snapshot }) {
  const rule = getRuleVersion(db, ruleVersionId);
  if (!rule) throw new Error(`规则版本 ${ruleVersionId} 不存在`);
  const perDay = new Map();
  const byEvent = new Map();
  const frozen = snapshot || captureSnapshot(db);
  const ingestWatermark = frozen.ingestWatermark;
  const evidenceWatermark = frozen.evidenceWatermark;
  for (const day of days) {
    const inputs = loadEvaluationInputs(db, day, rule, frozen);
    const result = evaluateDay({
      rules: rule.rules,
      day,
      events: inputs.events,
      sessionEvents: inputs.sessionEvents,
      sessionInfo: inputs.sessionInfo,
      evidence: inputs.evidence,
      orderFirst: inputs.orderFirst,
      asOf: inputs.asOf,
    });
    perDay.set(day, result.decisions);
    for (const d of result.decisions) byEvent.set(d.event.event_id, d);
  }
  return {
    rule,
    decisionsByDay: perDay,
    decisionsByEvent: byEvent,
    ingestWatermark,
    evidenceWatermark,
    includeSuspect,
  };
}

function dayTotals(decisions, includeSuspect) {
  let valid = 0;
  let invalid = 0;
  let suspect = 0;
  let amount = 0;
  let gross = 0;
  for (const d of decisions) {
    if (d.verdict === 'valid') valid += 1;
    else if (d.verdict === 'invalid') invalid += 1;
    else suspect += 1;
    gross += d.amountCents;
    amount += amountFor(d.verdict, d.amountCents, includeSuspect);
  }
  return { events: decisions.length, valid, invalid, suspect, amount, gross };
}

function reasonKey(d) {
  return d.primaryReason || '';
}

/**
 * Stored decisions, shaped like evaluator output. Used as the correction
 * baseline: those are the numbers that were actually settled, so the report
 * compares "what we paid" against "what today's evidence says", not two
 * re-evaluations that both already see the new evidence.
 */
export function loadStoredDecisions(db, runId) {
  const rows = db
    .prepare(
      `SELECT event_id, verdict, primary_reason, primary_detail, amount_cents, local_day
       FROM decisions WHERE run_id = ?`,
    )
    .all(runId);
  return rows.map((r) => ({
    event: { event_id: r.event_id },
    verdict: r.verdict,
    primaryReason: r.primary_reason,
    primaryDetail: r.primary_detail,
    amountCents: r.amount_cents,
    local_day: r.local_day,
  }));
}

export function buildComparison(db, { baseline, candidate, days }) {
  const summary = {
    baseline: { ruleVersionId: baseline.rule.id, label: baseline.rule.label, digest: baseline.rule.digest },
    candidate: { ruleVersionId: candidate.rule.id, label: candidate.rule.label, digest: candidate.rule.digest },
    totals: {},
    days: [],
    reasons: new Map(),
  };
  const directions = new Map();
  let oldAll = { events: 0, valid: 0, invalid: 0, suspect: 0, amount: 0, gross: 0 };
  let newAll = { events: 0, valid: 0, invalid: 0, suspect: 0, amount: 0, gross: 0 };
  let changedEvents = 0;

  for (const day of days) {
    const oldD = baseline.decisionsByDay.get(day) || [];
    const newD = candidate.decisionsByDay.get(day) || [];
    const oldTotals = dayTotals(oldD, baseline.includeSuspect);
    const newTotals = dayTotals(newD, candidate.includeSuspect);
    let changed = 0;
    const newById = new Map(newD.map((d) => [d.event.event_id, d]));
    for (const o of oldD) {
      const n = newById.get(o.event.event_id);
      if (!n) continue;
      if (o.verdict !== n.verdict || reasonKey(o) !== reasonKey(n)) {
        changed += 1;
        const direction =
          o.verdict === n.verdict ? 'reason_changed' : n.verdict === 'invalid' ? 'became_invalid' : n.verdict === 'valid' ? 'became_valid' : n.verdict === 'suspect' ? 'became_suspect' : 'became_other';
        const reasonForAgg = n.primaryReason || o.primaryReason || 'none';
        const key = `${direction}\u0000${reasonForAgg}`;
        const entry = directions.get(key) || {
          direction,
          rule_id: reasonForAgg,
          rule_label: RULE_LABELS[reasonForAgg] || n.primaryDetail || o.primaryDetail || '无主要理由变化',
          events: 0,
          delta_amount_cents: 0,
        };
        entry.events += 1;
        entry.delta_amount_cents += amountFor(n.verdict, n.amountCents, candidate.includeSuspect) - amountFor(o.verdict, o.amountCents, baseline.includeSuspect);
        directions.set(key, entry);
      }
    }
    oldAll = addTotals(oldAll, oldTotals);
    newAll = addTotals(newAll, newTotals);
    changedEvents += changed;
    summary.days.push({ day, old: oldTotals, new: newTotals, changed, deltaAmount: newTotals.amount - oldTotals.amount });
  }
  summary.totals = {
    old: oldAll,
    new: newAll,
    deltaValid: newAll.valid - oldAll.valid,
    deltaInvalid: newAll.invalid - oldAll.invalid,
    deltaSuspect: newAll.suspect - oldAll.suspect,
    deltaAmount: newAll.amount - oldAll.amount,
    changedEvents,
  };
  summary.reasons = [...directions.values()].sort((a, b) => b.events - a.events);
  return summary;
}

function addTotals(a, b) {
  return {
    events: a.events + b.events,
    valid: a.valid + b.valid,
    invalid: a.invalid + b.invalid,
    suspect: a.suspect + b.suspect,
    amount: a.amount + b.amount,
    gross: a.gross + b.gross,
  };
}

/**
 * Build a diff report row set.
 *
 * - `rule_compare`: two rule versions re-evaluated over one frozen snapshot,
 *   so the delta is attributable to the rule change alone.
 * - `correction`: the baseline is the *stored* decision set of the run that was
 *   settled (immutable history); the candidate is a fresh evaluation under the
 *   same rule with today's evidence. That is what makes newly arrived evidence
 *   show up as a delta instead of cancelling itself out.
 */
export function buildDiffReport(db, { job, kind, baselineRuleId, candidateRuleId, days, actor, processDelayMs = 0, log = () => {}, fenceCheck = () => true }) {
  if (!fenceCheck()) return { aborted: true };
  // Read the inputs once: both sides and every day see the same watermark and
  // evidence set even if ingestion or evidence entry continues meanwhile.
  const snapshot = captureSnapshot(db);
  const includeSuspect = Boolean(job.params?.includeSuspect);
  let baseId = baselineRuleId;
  if (baseId == null) {
    const first = db
      .prepare("SELECT rule_version_id FROM run_heads WHERE stream = ? AND local_day BETWEEN ? AND ? ORDER BY local_day LIMIT 1")
      .get(job.stream, job.scope_from, job.scope_to);
    if (!first) throw new Error('范围内没有已提交的运行，无法确定基线');
    baseId = first.rule_version_id;
  }

  let baseline;
  let baselineRunIds = [];
  let candidateRunIds = [];
  if (kind === 'correction') {
    const perDay = new Map();
    for (const day of days) {
      const head = db
        .prepare("SELECT run_id FROM run_heads WHERE stream = ? AND local_day = ?")
        .get(job.stream, day);
      if (!head) continue;
      baselineRunIds.push(head.run_id);
      perDay.set(day, loadStoredDecisions(db, head.run_id));
    }
    const baselineRule = getRuleVersion(db, baseId);
    if (!baselineRule) throw new Error(`规则版本 ${baseId} 不存在`);
    baseline = {
      rule: baselineRule,
      decisionsByDay: perDay,
      includeSuspect,
    };
  } else {
    baseline = evaluateSnapshot(db, { ruleVersionId: baseId, days, includeSuspect, snapshot });
  }
  const candidate = evaluateSnapshot(db, { ruleVersionId: candidateRuleId, days, includeSuspect, snapshot });
  if (processDelayMs > 0) {
    // Simulated slow process for the race demonstration; the fence is
    // rechecked after the sleep so a stale worker cannot write.
    const until = Date.now() + processDelayMs;
    while (Date.now() < until) {
      if (!fenceCheck()) return { aborted: true };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  if (!fenceCheck()) return { aborted: true };

  const summary = buildComparison(db, { baseline, candidate, days });
  const title =
    kind === 'correction'
      ? `${days[0]}${days.length > 1 ? `～${days[days.length - 1]}` : ''} 证据补录后的更正`
      : `${summary.baseline.label} → ${summary.candidate.label} 规则差异`;
  const digestInput = {
    kind,
    baseline: summary.baseline,
    candidate: summary.candidate,
    days: summary.days,
    reasons: summary.reasons,
    totals: summary.totals,
  };
  const digest = digestOf(digestInput);
  const at = new Date().toISOString();

  return tx(db, () => {
    const report = db
      .prepare(
        `INSERT INTO diff_reports (kind, status, title, baseline_rule_version_id, candidate_rule_version_id,
           baseline_run_ids_json, candidate_run_ids_json, scope_from, scope_to, summary_json, digest, job_id, created_at, created_by)
         VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        kind,
        title,
        baseline.rule.id,
        candidate.rule.id,
        JSON.stringify(baselineRunIds),
        JSON.stringify(candidateRunIds),
        days[0],
        days[days.length - 1],
        JSON.stringify(summary),
        digest,
        job.id,
        at,
        actor,
      );

    const insertDay = db.prepare(
      `INSERT INTO diff_days (report_id, local_day, old_valid, old_invalid, old_suspect, new_valid, new_invalid, new_suspect,
         old_amount_cents, new_amount_cents, changed_events, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertReason = db.prepare(
      `INSERT INTO diff_reasons (report_id, direction, rule_id, rule_label, events, delta_amount_cents) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO diff_events (report_id, event_id, local_day, old_verdict, new_verdict, old_reason, new_reason, delta_amount_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertJobLog = (msg, detail) => jobLog(db, job.id, 'info', msg, detail);

    for (const d of summary.days) {
      const sealed = db.prepare("SELECT 1 AS x FROM settlements WHERE local_day = ? AND status = 'sealed'").get(d.day);
      insertDay.run(
        report.id,
        d.day,
        d.old.valid,
        d.old.invalid,
        d.old.suspect,
        d.new.valid,
        d.new.invalid,
        d.new.suspect,
        d.old.amount,
        d.new.amount,
        d.changed,
        sealed ? 1 : 0,
      );
      const oldD = baseline.decisionsByDay.get(d.day) || [];
      const newD = candidate.decisionsByDay.get(d.day) || [];
      const newById = new Map(newD.map((x) => [x.event.event_id, x]));
      for (const o of oldD) {
        const n = newById.get(o.event.event_id);
        if (!n) continue;
        if (o.verdict === n.verdict && reasonKey(o) === reasonKey(n)) continue;
        insertEvent.run(
          report.id,
          o.event.event_id,
          d.day,
          o.verdict,
          n.verdict,
          o.primaryDetail || o.primaryReason,
          n.primaryDetail || n.primaryReason,
          amountFor(n.verdict, n.amountCents, candidate.includeSuspect) - amountFor(o.verdict, o.amountCents, baseline.includeSuspect),
        );
      }
    }
    for (const r of summary.reasons) {
      insertReason.run(report.id, r.direction, r.rule_id, r.rule_label, r.events, r.delta_amount_cents);
    }
    insertJobLog(`差异报告 #${report.id} 已生成：${summary.totals.changedEvents} 条变化`, {
      reportId: report.id,
      digest,
      deltaAmount: summary.totals.deltaAmount,
      sealedDays: summary.days.filter((d) => d.sealed).map((d) => d.day),
    });
    log(`  报告 #${report.id}：${summary.totals.changedEvents} 条变化，金额差 ${(summary.totals.deltaAmount / 100).toFixed(2)}`);
    return report;
  });
}

export function getReport(db, id) {
  const report = db.prepare('SELECT * FROM diff_reports WHERE id = ?').get(id);
  if (!report) return null;
  return {
    ...report,
    summary: parseJson(report.summary_json, {}),
    days: db.prepare('SELECT * FROM diff_days WHERE report_id = ? ORDER BY local_day').all(id),
    reasons: db.prepare('SELECT * FROM diff_reasons WHERE report_id = ? ORDER BY events DESC').all(id),
    sampleEvents: db
      .prepare('SELECT * FROM diff_events WHERE report_id = ? ORDER BY ABS(delta_amount_cents) DESC, event_id LIMIT 200')
      .all(id),
    eventCount: db.prepare('SELECT COUNT(*) AS n FROM diff_events WHERE report_id = ?').get(id).n,
  };
}

export function listReports(db, { status = null, limit = 30 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM diff_reports WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM diff_reports ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({
    ...r,
    summary: parseJson(r.summary_json, {}),
    days: db.prepare('SELECT * FROM diff_days WHERE report_id = ? ORDER BY local_day').all(r.id),
  }));
}

export function approveReport(db, id, { actor, note = null, applyAdjustments = true }) {
  return tx(db, () => {
    const report = db.prepare('SELECT * FROM diff_reports WHERE id = ?').get(id);
    if (!report) throw new Error('报告不存在');
    if (report.status !== 'draft') throw new Error(`报告已${report.status === 'approved' ? '批准' : '驳回'}，不能重复处理`);
    const days = db.prepare('SELECT * FROM diff_days WHERE report_id = ? ORDER BY local_day').all(id);
    const at = new Date().toISOString();
    const applied = [];
    const restate = [];
    if (applyAdjustments) {
      for (const d of days) {
        const sealed = db.prepare("SELECT * FROM settlements WHERE local_day = ? AND status = 'sealed'").get(d.local_day);
        const deltaValid = d.new_valid - d.old_valid;
        const deltaInvalid = d.new_invalid - d.old_invalid;
        const deltaSuspect = d.new_suspect - d.old_suspect;
        const deltaAmount = d.new_amount_cents - d.old_amount_cents;
        const changed = deltaValid !== 0 || deltaInvalid !== 0 || deltaSuspect !== 0 || deltaAmount !== 0;
        if (!sealed) {
          // Not settled yet: the honest fix is to re-decide the day under the
          // new evidence, not to bolt an adjustment onto a figure nobody froze.
          if (changed) {
            db.prepare("DELETE FROM settlements WHERE local_day = ? AND status = 'draft'").run(d.local_day);
            restate.push(d.local_day);
          }
          continue;
        }
        const existing = db.prepare('SELECT 1 AS x FROM settlement_adjustments WHERE report_id = ? AND settlement_id = ?').get(id, sealed.id);
        if (existing) continue;
        if (!changed) continue;
        const digest = digestOf({ reportId: id, settlementId: sealed.id, deltaValid, deltaInvalid, deltaSuspect, deltaAmount });
        db.prepare(
          `INSERT INTO settlement_adjustments (settlement_id, report_id, local_day, delta_event_count, delta_valid_count,
             delta_invalid_count, delta_suspect_count, delta_amount_cents, basis_run_id, reason, applied_at, applied_by, digest)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          sealed.id,
          id,
          d.local_day,
          (d.new_valid + d.new_invalid + d.new_suspect) - (d.old_valid + d.old_invalid + d.old_suspect),
          deltaValid,
          deltaInvalid,
          deltaSuspect,
          deltaAmount,
          sealed.basis_run_id,
          `${report.kind === 'correction' ? '证据补录更正' : '规则差异'} 报告 #${id}`,
          at,
          actor,
          digest,
        );
        db.prepare('UPDATE diff_days SET adjustment_applied = 1 WHERE report_id = ? AND local_day = ?').run(id, d.local_day);
        applied.push({ day: d.local_day, deltaAmount });
      }
    }
    const updated = db
      .prepare("UPDATE diff_reports SET status = 'approved', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'draft' RETURNING *")
      .get(at, actor, note, id);
    db.prepare(
      "INSERT INTO audit_log (at, actor, action, entity, entity_id, detail_json) VALUES (?, ?, 'report.approve', 'diff_report', ?, ?)",
    ).run(at, actor, String(id), JSON.stringify({ note, applied, restate }));
    return { report: updated, applied, restate };
  });
}

export function rejectReport(db, id, { actor, note = null }) {
  return tx(db, () => {
    const report = db.prepare('SELECT * FROM diff_reports WHERE id = ?').get(id);
    if (!report) throw new Error('报告不存在');
    if (report.status !== 'draft') throw new Error('只有草稿报告可以驳回');
    const at = new Date().toISOString();
    const updated = db
      .prepare("UPDATE diff_reports SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'draft' RETURNING *")
      .get(at, actor, note, id);
    db.prepare(
      "INSERT INTO audit_log (at, actor, action, entity, entity_id, detail_json) VALUES (?, ?, 'report.reject', 'diff_report', ?, ?)",
    ).run(at, actor, String(id), JSON.stringify({ note }));
    return updated;
  });
}
