import { openDb, getMeta, setMeta, tx } from '../lib/db.mjs';
import { dayRange } from '../lib/time.mjs';

/**
 * Operations console read models. Every number here is derived from committed
 * decisions or sealed settlements; nothing is estimated. When a value cannot
 * be computed (no committed run, no settlement) the API returns null and the UI
 * says so instead of showing a zero that could be mistaken for real data.
 */

export function summary(db, { from, to, ruleVersionId = null }) {
  const heads = db
    .prepare(
      `SELECT h.local_day, h.run_id, h.sequence, h.rule_version_id, rv.label AS rule_label, r.digest, r.committed_at
       FROM run_heads h
       JOIN decision_runs r ON r.id = h.run_id
       JOIN rule_versions rv ON rv.id = h.rule_version_id
       WHERE h.stream = 'production' AND h.local_day BETWEEN ? AND ?
       ORDER BY h.local_day`,
    )
    .all(from, to);
  const days = dayRange(from, to);
  const perDay = days.map((day) => {
    const head = heads.find((h) => h.local_day === day) || null;
    const settlement = db.prepare("SELECT * FROM settlements WHERE local_day = ? AND status = 'sealed'").get(day);
    const draft = db.prepare("SELECT * FROM settlements WHERE local_day = ? AND status = 'draft'").get(day);
    const adj = settlement
      ? db.prepare('SELECT COALESCE(SUM(delta_amount_cents), 0) AS a FROM settlement_adjustments WHERE settlement_id = ?').get(settlement.id).a
      : 0;
    let totals = null;
    if (head) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS events,
             SUM(CASE WHEN verdict='valid' THEN 1 ELSE 0 END) AS valid,
             SUM(CASE WHEN verdict='invalid' THEN 1 ELSE 0 END) AS invalid,
             SUM(CASE WHEN verdict='suspect' THEN 1 ELSE 0 END) AS suspect,
             SUM(CASE WHEN verdict='valid' THEN amount_cents ELSE 0 END) AS valid_amount,
             SUM(amount_cents) AS gross,
             SUM(session_cross_day) AS cross_day_events
           FROM decisions WHERE run_id = ?`,
        )
        .get(head.run_id);
      totals = {
        events: Number(row.events || 0),
        valid: Number(row.valid || 0),
        invalid: Number(row.invalid || 0),
        suspect: Number(row.suspect || 0),
        validAmount: Number(row.valid_amount || 0),
        gross: Number(row.gross || 0),
        crossDayEvents: Number(row.cross_day_events || 0),
      };
    }
    return {
      day,
      head,
      totals,
      settlement: settlement
        ? { ...settlement, adjustmentTotal: adj, netSettled: settlement.settled_amount_cents + adj }
        : null,
      draft: draft || null,
    };
  });

  const withData = perDay.filter((d) => d.totals);
  const aggregate = withData.reduce(
    (acc, d) => ({
      events: acc.events + d.totals.events,
      valid: acc.valid + d.totals.valid,
      invalid: acc.invalid + d.totals.invalid,
      suspect: acc.suspect + d.totals.suspect,
      gross: acc.gross + d.totals.gross,
      validAmount: acc.validAmount + d.totals.validAmount,
      crossDayEvents: acc.crossDayEvents + d.totals.crossDayEvents,
    }),
    { events: 0, valid: 0, invalid: 0, suspect: 0, gross: 0, validAmount: 0, crossDayEvents: 0 },
  );
  const sealedDays = perDay.filter((d) => d.settlement);
  const sealedNet = sealedDays.reduce((a, d) => a + d.settlement.netSettled, 0);
  const sealedCount = sealedDays.length;
  const qualityRate = aggregate.events > 0 ? aggregate.valid / aggregate.events : null;
  const suspectRate = aggregate.events > 0 ? aggregate.suspect / aggregate.events : null;

  return {
    from,
    to,
    days: perDay,
    totals: { ...aggregate, daysWithRuns: withData.length, daysMissingRuns: days.length - withData.length },
    settlements: { sealedDays: sealedCount, sealedNet, adjustedTotal: sealedDays.reduce((a, d) => a + d.settlement.adjustmentTotal, 0) },
    qualityRate,
    suspectRate,
    ruleVersionsOnDays: [...new Set(heads.map((h) => `${h.rule_version_id}:${h.rule_label}`))].map((s) => {
      const [id, label] = s.split(':');
      return { id: Number(id), label };
    }),
    currentRuleVersionId: ruleVersionId,
  };
}

export function reasonReport(db, runId) {
  const run = db.prepare('SELECT * FROM decision_runs WHERE id = ?').get(runId);
  if (!run) throw new Error('运行不存在');
  const rows = db
    .prepare(
      `SELECT c.rule_id, c.rule_label, c.severity, c.outcome, COUNT(*) AS occurrences,
              COUNT(DISTINCT d.event_id) AS events,
              SUM(CASE WHEN d.verdict = 'invalid' THEN 1 ELSE 0 END) AS on_invalid,
              SUM(CASE WHEN d.verdict = 'suspect' THEN 1 ELSE 0 END) AS on_suspect,
              SUM(d.amount_cents) AS amount
       FROM decision_contributions c
       JOIN decisions d ON d.id = c.decision_id
       WHERE d.run_id = ? AND c.outcome = 'fail'
       GROUP BY c.rule_id, c.rule_label, c.severity, c.outcome
       ORDER BY events DESC, c.rule_id`,
    )
    .all(runId);
  const byEventType = db
    .prepare(
      `SELECT event_type, verdict, COUNT(*) AS n FROM decisions WHERE run_id = ? GROUP BY event_type, verdict ORDER BY event_type, verdict`,
    )
    .all(runId);
  const funnel = db
    .prepare(
      `SELECT event_type, COUNT(*) AS total,
         SUM(CASE WHEN verdict='valid' THEN 1 ELSE 0 END) AS valid,
         SUM(CASE WHEN verdict='invalid' THEN 1 ELSE 0 END) AS invalid,
         SUM(CASE WHEN verdict='suspect' THEN 1 ELSE 0 END) AS suspect
       FROM decisions WHERE run_id = ? GROUP BY event_type ORDER BY
         CASE event_type WHEN 'impression' THEN 1 WHEN 'click' THEN 2 ELSE 3 END`,
    )
    .all(runId);
  return { run, reasons: rows, byEventType, funnel };
}

export function eventDetail(db, { eventId, runId = null }) {
  const event = db.prepare('SELECT * FROM raw_events WHERE event_id = ?').get(eventId);
  if (!event) return null;
  const run = runId
    ? db.prepare('SELECT * FROM decision_runs WHERE id = ?').get(runId)
    : db
        .prepare(
          `SELECT r.* FROM decision_runs r
           JOIN run_heads h ON h.run_id = r.id
           WHERE h.local_day = ? AND h.stream = 'production'`,
        )
        .get(event.local_day);
  const decision = run
    ? db.prepare('SELECT * FROM decisions WHERE run_id = ? AND event_id = ?').get(run.id, eventId)
    : null;
  const contributions = decision
    ? db.prepare('SELECT * FROM decision_contributions WHERE decision_id = ? ORDER BY check_order').all(decision.id)
    : [];
  const session = decision
    ? db
        .prepare(
          `SELECT event_id, event_type, occurred_at, verdict, primary_reason, primary_detail, amount_cents
           FROM decisions WHERE run_id = ? AND session_id = ? ORDER BY occurred_at, event_id`,
        )
        .all(run.id, decision.session_id)
    : [];
  const history = db
    .prepare(
      `SELECT d.event_id, d.verdict, d.primary_reason, d.primary_detail, d.decided_at, r.id AS run_id, r.status,
              rv.label AS rule_label, r.sequence
       FROM decisions d JOIN decision_runs r ON r.id = d.run_id JOIN rule_versions rv ON rv.id = r.rule_version_id
       WHERE d.event_id = ? ORDER BY r.sequence DESC`,
    )
    .all(eventId);
  return { event, decision, contributions, session, history, run };
}

export function sessionDetail(db, { sessionId, runId }) {
  const rows = db
    .prepare('SELECT * FROM decisions WHERE run_id = ? AND session_id = ? ORDER BY occurred_at, event_id')
    .all(runId, sessionId);
  if (rows.length === 0) return null;
  return {
    sessionId,
    runId,
    days: [...new Set(rows.map((r) => r.local_day))],
    crossDay: rows.some((r) => r.session_cross_day === 1),
    events: rows,
    totals: {
      events: rows.length,
      valid: rows.filter((r) => r.verdict === 'valid').length,
      invalid: rows.filter((r) => r.verdict === 'invalid').length,
      suspect: rows.filter((r) => r.verdict === 'suspect').length,
      amount: rows.reduce((a, r) => a + (r.verdict === 'valid' ? r.amount_cents : 0), 0),
    },
  };
}

export function excludedEvents(db, { runId, ruleId = null, verdict = null, onlyExcluded = false, day = null, limit = 100, offset = 0 }) {
  const where = ['d.run_id = ?'];
  const params = [runId];
  if (verdict) {
    where.push('d.verdict = ?');
    params.push(verdict);
  } else if (onlyExcluded) {
    where.push("d.verdict <> 'valid'");
  }
  if (day) {
    where.push('d.local_day = ?');
    params.push(day);
  }
  if (ruleId) {
    where.push('EXISTS (SELECT 1 FROM decision_contributions c WHERE c.decision_id = d.id AND c.rule_id = ? AND c.outcome = ?)');
    params.push(ruleId, 'fail');
  }
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM decisions d WHERE ${where.join(' AND ')}`)
    .get(...params).n;
  const rows = db
    .prepare(
      `SELECT d.*, e.ip, e.user_agent, e.impression_id, e.click_id, e.order_id, e.click_delay_ms, e.viewable,
              e.received_at, e.ingest_seq,
         (SELECT json_group_array(json_object('rule_id', c.rule_id, 'label', c.rule_label, 'severity', c.severity,
             'observed', c.observed, 'comparator', c.comparator, 'threshold', c.threshold, 'detail', c.detail,
             'evidence_ref', c.evidence_ref))
          FROM decision_contributions c WHERE c.decision_id = d.id AND c.outcome = 'fail') AS failures
       FROM decisions d JOIN raw_events e ON e.event_id = d.event_id
       WHERE ${where.join(' AND ')}
       ORDER BY d.occurred_at, d.event_id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return {
    total,
    rows: rows.map((r) => ({ ...r, failures: JSON.parse(r.failures) })),
    limit,
    offset,
  };
}

export function auditTrail(db, { limit = 50 } = {}) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}
