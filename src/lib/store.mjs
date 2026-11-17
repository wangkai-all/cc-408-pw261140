import { randomUUID } from 'node:crypto';
import { audit, nextSequence, tx } from './db.mjs';
import { digestOf, parseJson } from './util.mjs';

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Rule versions
// ---------------------------------------------------------------------------

export function createRuleVersion(db, { rules, label, slug = null, notes = null, actor = 'web', status = 'draft' }) {
  const body = JSON.stringify(rules);
  const digest = digestOf(rules);
  const existing = db.prepare('SELECT * FROM rule_versions WHERE digest = ?').get(digest);
  if (existing) return { ...existing, reused: true };
  const finalSlug = slug || `rule-${digest.slice(0, 8)}`;
  const at = new Date().toISOString();
  const row = db
    .prepare(
      `INSERT INTO rule_versions (slug, label, status, rules_json, digest, notes, created_at, created_by, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(finalSlug, label, status, body, digest, notes, at, actor, status === 'published' ? at : null);
  audit(db, { actor, action: 'rule_version.create', entity: 'rule_version', entityId: row.id, detail: { label, digest } });
  return row;
}

export function publishRuleVersion(db, id, actor = 'web') {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(id);
    if (!row) throw new Error('规则版本不存在');
    if (row.status === 'published') return row;
    if (row.status === 'retired') throw new Error('已退役版本不能重新发布');
    const at = new Date().toISOString();
    const updated = db
      .prepare("UPDATE rule_versions SET status = 'published', published_at = ? WHERE id = ? RETURNING *")
      .get(at, id);
    audit(db, { actor, action: 'rule_version.publish', entity: 'rule_version', entityId: id, detail: { label: row.label } });
    return updated;
  });
}

export function retireRuleVersion(db, id, actor = 'web') {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(id);
    if (!row) throw new Error('规则版本不存在');
    if (row.status !== 'published') throw new Error('只能退役已发布版本');
    const updated = db
      .prepare("UPDATE rule_versions SET status = 'retired', retired_at = ? WHERE id = ? RETURNING *")
      .get(new Date().toISOString(), id);
    audit(db, { actor, action: 'rule_version.retire', entity: 'rule_version', entityId: id, detail: { label: row.label } });
    return updated;
  });
}

export function parseRuleRow(row) {
  if (!row) return null;
  return { ...row, rules: parseJson(row.rules_json), rules_json: undefined };
}

export function listRuleVersions(db) {
  return db.prepare('SELECT * FROM rule_versions ORDER BY id DESC').all().map(parseRuleRow);
}

export function getRuleVersion(db, id) {
  return parseRuleRow(db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(id));
}

export function latestPublishedRule(db) {
  return parseRuleRow(
    db.prepare("SELECT * FROM rule_versions WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT 1").get(),
  );
}

// ---------------------------------------------------------------------------
// Evidence (append-only, effective-dated)
// ---------------------------------------------------------------------------

export const EVIDENCE_KINDS = {
  ua_token: { label: 'UA 特征', keyLabel: 'UA 子串（不区分大小写）' },
  ip_prefix: { label: 'IP 前缀', keyLabel: 'IPv4 前缀，如 203.0.113' },
  device_flag: { label: '设备标记', keyLabel: '设备 ID' },
  order_reversal: { label: '订单撤销', keyLabel: '订单号' },
  policy_note: { label: '策略备注', keyLabel: '标题' },
};

export function addEvidence(db, { kind, key, value = null, label, effectiveFrom, effectiveTo = null, source, note = null, actor = 'web' }) {
  const meta = EVIDENCE_KINDS[kind];
  if (!meta) throw new Error(`未知证据类型: ${kind}`);
  const cleanKey = String(key || '').trim();
  if (!cleanKey) throw new Error('证据键不能为空');
  if (!label || !String(label).trim()) throw new Error('证据必须有名称');
  if (!source || !String(source).trim()) throw new Error('证据必须注明来源');
  if (!effectiveFrom) throw new Error('证据必须设置生效时间');
  if (Number.isNaN(Date.parse(effectiveFrom))) throw new Error('生效时间格式无效');
  if (effectiveTo && Number.isNaN(Date.parse(effectiveTo))) throw new Error('失效时间格式无效');
  if (effectiveTo && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) throw new Error('失效时间必须晚于生效时间');
  if (kind === 'ip_prefix' && !/^\d{1,3}(\.\d{1,3}){0,3}$/.test(cleanKey)) throw new Error('IP 前缀格式无效');
  const at = new Date().toISOString();
  const row = db
    .prepare(
      `INSERT INTO evidence (kind, key, value, label, effective_from, effective_to, added_at, added_by, source, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(kind, cleanKey, value, String(label), effectiveFrom, effectiveTo, at, actor, String(source), note);
  audit(db, {
    actor,
    action: 'evidence.add',
    entity: 'evidence',
    entityId: row.id,
    detail: { kind, key: cleanKey, label, effectiveFrom },
  });
  return row;
}

export function listEvidence(db, { activeAt = null } = {}) {
  const rows = db.prepare('SELECT * FROM evidence ORDER BY id DESC').all();
  if (!activeAt) return rows;
  const t = Date.parse(activeAt);
  return rows.filter((e) => {
    const from = Date.parse(e.effective_from);
    const to = e.effective_to ? Date.parse(e.effective_to) : Infinity;
    return t >= from && t <= to;
  });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const JOB_KINDS = new Set(['evaluate', 'compare', 'correction', 'settle']);

export function enqueueJob(db, { kind, ruleVersionId = null, stream = 'production', scopeFrom, scopeTo, priority = 100, processDelayMs = 0, params = {}, actor = 'web', createdAt = null }) {
  if (!JOB_KINDS.has(kind)) throw new Error(`未知任务类型: ${kind}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scopeFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(scopeTo)) {
    throw new Error('任务范围必须是 YYYY-MM-DD');
  }
  if (scopeFrom > scopeTo) throw new Error('任务起始日期晚于结束日期');
  if (ruleVersionId != null) {
    const rv = db.prepare('SELECT id, status FROM rule_versions WHERE id = ?').get(ruleVersionId);
    if (!rv) throw new Error('规则版本不存在');
    if (rv.status === 'draft') throw new Error('草稿规则不能用于生产或对比任务，请先发布');
  }
  const seq = nextSequence(db);
  const id = `job_${randomUUID().slice(0, 12)}`;
  const now = createdAt || new Date().toISOString();
  const row = db
    .prepare(
      `INSERT INTO jobs (id, kind, status, stream, rule_version_id, scope_from, scope_to, priority, sequence,
        process_delay_ms, params_json, created_at, created_by)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(id, kind, stream, ruleVersionId, scopeFrom, scopeTo, priority, seq, processDelayMs, JSON.stringify(params), now, actor);
  jobLog(db, id, 'info', `任务入队（序号 ${seq}，优先级 ${priority}）`, { kind, stream, scopeFrom, scopeTo, ruleVersionId });
  return row;
}

export function jobLog(db, jobId, level, message, detail = null) {
  db.prepare('INSERT INTO job_events (job_id, at, level, message, detail_json) VALUES (?, ?, ?, ?, ?)').run(
    jobId,
    new Date().toISOString(),
    level,
    message,
    detail == null ? null : JSON.stringify(detail),
  );
}

/** Requeue jobs whose lease expired (process died mid-job). */
export function reclaimStaleJobs(db, kinds) {
  const now = new Date().toISOString();
  const placeholders = kinds.map(() => '?').join(',');
  return db
    .prepare(
      `UPDATE jobs SET status = 'queued', claimed_by = NULL, lease_until = NULL
       WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ? AND kind IN (${placeholders})
       RETURNING id, kind, claimed_by`,
    )
    .all(now, ...kinds);
}

export function claimJob(db, { kinds, workerId, leaseSeconds = 120 }) {
  const placeholders = kinds.map(() => '?').join(',');
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  return tx(db, () => {
    const candidate = db
      .prepare(
        `SELECT id FROM jobs WHERE status = 'queued' AND kind IN (${placeholders})
         ORDER BY priority DESC, sequence ASC LIMIT 1`,
      )
      .get(...kinds);
    if (!candidate) return null;
    const row = db
      .prepare(
        `UPDATE jobs SET status = 'running', claimed_by = ?, claimed_at = ?, started_at = COALESCE(started_at, ?),
           lease_until = ?, fence = fence + 1, attempts = attempts + 1
         WHERE id = ? AND status = 'queued'
         RETURNING *`,
      )
      .get(workerId, now, now, lease, candidate.id);
    if (!row) return null;
    jobLog(db, row.id, 'info', `由 ${workerId} 领取（fence ${row.fence}）`, null);
    return { ...row, params: parseJson(row.params_json, {}), result: null };
  });
}

export function renewLease(db, jobId, fence, leaseSeconds = 120) {
  const lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const res = db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ? AND fence = ?').run(lease, jobId, fence);
  return res.changes === 1;
}

export function fenceIntact(db, jobId, fence) {
  const row = db.prepare('SELECT fence, status FROM jobs WHERE id = ?').get(jobId);
  return Boolean(row && row.fence === fence && row.status === 'running');
}

export function finishJob(db, jobId, fence, { status, result = null, error = null }) {
  const row = db.prepare('SELECT fence FROM jobs WHERE id = ?').get(jobId);
  if (!row) return false;
  if (row.fence !== fence) return false;
  db.prepare(
    'UPDATE jobs SET status = ?, finished_at = ?, lease_until = NULL, result_json = ?, error = ? WHERE id = ? AND fence = ?',
  ).run(status, new Date().toISOString(), result == null ? null : JSON.stringify(result), error, jobId, fence);
  return true;
}

export function listJobs(db, { limit = 40 } = {}) {
  return db
    .prepare(
      `SELECT j.*, r.label AS rule_label FROM jobs j
       LEFT JOIN rule_versions r ON r.id = j.rule_version_id
       ORDER BY j.sequence DESC LIMIT ?`,
    )
    .all(limit)
    .map((j) => ({ ...j, params: parseJson(j.params_json, {}), result: parseJson(j.result_json, null) }));
}

export function getJob(db, id) {
  const row = db
    .prepare(
      `SELECT j.*, r.label AS rule_label FROM jobs j
       LEFT JOIN rule_versions r ON r.id = j.rule_version_id WHERE j.id = ?`,
    )
    .get(id);
  if (!row) return null;
  return {
    ...row,
    params: parseJson(row.params_json, {}),
    result: parseJson(row.result_json, null),
    events: db.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY id').all(id).map((e) => ({ ...e, detail: parseJson(e.detail_json) })),
  };
}

// ---------------------------------------------------------------------------
// Runs & decision commits
// ---------------------------------------------------------------------------

/**
 * Commit one day's decision set for a run.
 *
 * The head guard compares the job *sequence* (assigned at enqueue), never the
 * finish time. A job that was enqueued under an older rule version and finishes
 * late therefore records its run as history but cannot replace the newer head.
 */
export function commitRun(db, { job, day, ruleVersionId, decisions, asOf, ingestWatermark, evidenceWatermark, crossDayCount = 0, note = null }) {
  return tx(db, () => {
    const current = db.prepare('SELECT fence, status FROM jobs WHERE id = ?').get(job.id);
    if (!current || current.fence !== job.fence || current.status !== 'running') {
      return { committed: false, superseded: true, reason: 'fence' };
    }
    const startedAt = new Date().toISOString();
    const run = db
      .prepare(
        `INSERT INTO decision_runs (job_id, run_key, rule_version_id, stream, scope_from, scope_to, sequence, as_of,
           ingest_watermark, evidence_watermark, attribution, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
         RETURNING *`,
      )
      .get(job.id, `${job.id}:${day}`, ruleVersionId, job.stream, day, day, job.sequence, asOf, ingestWatermark, evidenceWatermark, job.params?.attribution || 'attribution-day', startedAt);

    const insertDecision = db.prepare(
      `INSERT INTO decisions (run_id, event_id, rule_version_id, stream, verdict, primary_reason, primary_detail,
        invalid_reasons_json, suspect_reasons_json, local_day, occurred_at, event_type, session_id, session_start_day,
        session_days_json, session_cross_day, amount_cents, revenue_cents, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertContribution = db.prepare(
      `INSERT INTO decision_contributions (decision_id, check_order, rule_id, rule_label, scope, severity, outcome,
        observed, comparator, threshold, detail, evidence_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let crossDay = 0;
    for (const d of decisions) {
      const info = insertDecision.run(
        run.id,
        d.event.event_id,
        ruleVersionId,
        job.stream,
        d.verdict,
        d.primaryReason,
        d.primaryDetail,
        JSON.stringify(d.invalidReasons),
        JSON.stringify(d.suspectReasons),
        d.attributionDay,
        d.event.occurred_at,
        d.event.event_type,
        d.event.session_id,
        d.sessionStartDay,
        JSON.stringify(d.sessionDays),
        d.sessionCrossDay ? 1 : 0,
        d.amountCents,
        d.event.revenue_cents || 0,
        asOf,
      );
      if (d.sessionCrossDay) crossDay += 1;
      const decisionId = Number(info.lastInsertRowid);
      for (const c of d.contributions) {
        insertContribution.run(
          decisionId,
          c.check_order,
          c.rule_id,
          c.rule_label,
          c.scope,
          c.severity,
          c.outcome,
          c.observed ?? null,
          c.comparator ?? null,
          c.threshold ?? null,
          c.detail ?? null,
          c.evidence_ref ?? null,
        );
      }
    }

    const digest = digestOf(
      decisions.map((d) => ({
        event_id: d.event.event_id,
        verdict: d.verdict,
        reason: d.primaryReason,
        invalid: d.invalidReasons.map((r) => r.rule_id).sort(),
        suspect: d.suspectReasons.map((r) => r.rule_id).sort(),
        day: d.attributionDay,
        amount: d.amountCents,
      })),
    );

    const head = db
      .prepare('SELECT * FROM run_heads WHERE stream = ? AND local_day = ?')
      .get(job.stream, day);

    if (head && head.sequence >= job.sequence) {
      db.prepare(
        `UPDATE decision_runs SET status = 'superseded', event_count = ?, cross_day_count = ?, digest = ?,
           committed_at = ?, note = ? WHERE id = ?`,
      ).run(decisions.length, crossDay, digest, new Date().toISOString(), '任务完成时已有更新序号的运行，本次结果仅存档', run.id);
      jobLog(db, job.id, 'warn', `运行 #${run.id} 被更新序号覆盖，未替换 ${day} 的当前结果`, {
        runSequence: job.sequence,
        headSequence: head.sequence,
        headRunId: head.run_id,
      });
      return { committed: false, superseded: true, runId: run.id, digest, reason: 'sequence', headSequence: head.sequence };
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE decision_runs SET status = 'committed', event_count = ?, cross_day_count = ?, digest = ?, committed_at = ?, note = ?
       WHERE id = ?`,
    ).run(decisions.length, crossDay, digest, now, note, run.id);

    if (head) {
      db.prepare("UPDATE decision_runs SET status = 'superseded', note = COALESCE(note, '') || ? WHERE id = ?").run(
        `；被运行 #${run.id}（序号 ${job.sequence}）替代`,
        head.run_id,
      );
    }
    db.prepare(
      `INSERT INTO run_heads (stream, local_day, run_id, sequence, rule_version_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(stream, local_day) DO UPDATE SET run_id = excluded.run_id, sequence = excluded.sequence,
         rule_version_id = excluded.rule_version_id, updated_at = excluded.updated_at`,
    ).run(job.stream, day, run.id, job.sequence, ruleVersionId, now);

    jobLog(db, job.id, 'info', `运行 #${run.id} 提交：${day} 共 ${decisions.length} 条判定`, {
      runId: run.id,
      digest,
      supersededRun: head ? head.run_id : null,
    });
    return { committed: true, superseded: false, runId: run.id, digest, replacedRunId: head ? head.run_id : null };
  });
}

export function markRunFailed(db, job, day, message) {
  db.prepare(
    `INSERT INTO decision_runs (job_id, run_key, rule_version_id, stream, scope_from, scope_to, sequence, as_of,
       attribution, status, started_at, committed_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)`,
  ).run(
    job.id,
    `${job.id}:${day}`,
    job.rule_version_id,
    job.stream,
    day,
    day,
    job.sequence,
    new Date().toISOString(),
    job.params?.attribution || 'attribution-day',
    new Date().toISOString(),
    new Date().toISOString(),
    message,
  );
}

export function getRun(db, id) {
  const row = db.prepare('SELECT * FROM decision_runs WHERE id = ?').get(id);
  if (!row) return null;
  const rule = db.prepare('SELECT label, slug FROM rule_versions WHERE id = ?').get(row.rule_version_id);
  return { ...row, rule_label: rule?.label, rule_slug: rule?.slug };
}

export function headRunForDay(db, day, stream = 'production') {
  const head = db.prepare('SELECT * FROM run_heads WHERE stream = ? AND local_day = ?').get(stream, day);
  if (!head) return null;
  return getRun(db, head.run_id);
}

export function runsForDays(db, from, to, stream = 'production') {
  const rows = db
    .prepare(
      `SELECT h.local_day, h.run_id, h.sequence, h.rule_version_id, r.digest, r.event_count, r.committed_at
       FROM run_heads h JOIN decision_runs r ON r.id = h.run_id
       WHERE h.stream = ? AND h.local_day BETWEEN ? AND ? ORDER BY h.local_day`,
    )
    .all(stream, from, to);
  return rows;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export function runTotals(db, runId) {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS events,
         SUM(CASE WHEN verdict = 'valid' THEN 1 ELSE 0 END) AS valid,
         SUM(CASE WHEN verdict = 'invalid' THEN 1 ELSE 0 END) AS invalid,
         SUM(CASE WHEN verdict = 'suspect' THEN 1 ELSE 0 END) AS suspect,
         SUM(CASE WHEN verdict = 'valid' THEN amount_cents ELSE 0 END) AS valid_amount,
         SUM(amount_cents) AS gross_amount,
         SUM(CASE WHEN session_cross_day = 1 THEN 1 ELSE 0 END) AS cross_day_events
       FROM decisions WHERE run_id = ?`,
    )
    .get(runId);
  return {
    events: Number(row.events || 0),
    valid: Number(row.valid || 0),
    invalid: Number(row.invalid || 0),
    suspect: Number(row.suspect || 0),
    validAmount: Number(row.valid_amount || 0),
    grossAmount: Number(row.gross_amount || 0),
    crossDayEvents: Number(row.cross_day_events || 0),
  };
}

export function reasonBreakdown(db, runId, { direction = 'fail' } = {}) {
  return db
    .prepare(
      `SELECT c.rule_id, c.rule_label, c.severity, COUNT(*) AS events,
              SUM(CASE WHEN c.severity = 'hard' THEN 1 ELSE 0 END) AS hard_events,
              COUNT(DISTINCT d.session_id) AS sessions,
              SUM(CASE WHEN d.verdict <> 'valid' THEN d.amount_cents ELSE 0 END) AS at_risk_amount
       FROM decision_contributions c
       JOIN decisions d ON d.id = c.decision_id
       WHERE d.run_id = ? AND c.outcome = ?
       GROUP BY c.rule_id, c.rule_label, c.severity
       ORDER BY events DESC`,
    )
    .all(runId, direction);
}

export function verdictCountsByType(db, runId) {
  return db
    .prepare(
      `SELECT event_type, verdict, COUNT(*) AS n FROM decisions WHERE run_id = ? GROUP BY event_type, verdict ORDER BY event_type`,
    )
    .all(runId);
}

export function sessionSummary(db, runId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions,
              SUM(session_cross_day) AS cross_day_events,
              COUNT(DISTINCT CASE WHEN session_cross_day = 1 THEN session_id END) AS cross_day_sessions
       FROM decisions WHERE run_id = ?`,
    )
    .get(runId);
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export function amountForVerdict(verdict, amountCents, includeSuspect) {
  if (verdict === 'valid') return amountCents;
  if (verdict === 'suspect') return includeSuspect ? amountCents : 0;
  return 0;
}

export function computeSettlement(db, { day, run, includeSuspect }) {
  const rows = db
    .prepare('SELECT verdict, amount_cents, revenue_cents FROM decisions WHERE run_id = ?')
    .all(run.id);
  let valid = 0;
  let invalid = 0;
  let suspect = 0;
  let gross = 0;
  let settled = 0;
  for (const r of rows) {
    if (r.verdict === 'valid') valid += 1;
    else if (r.verdict === 'invalid') invalid += 1;
    else suspect += 1;
    gross += r.amount_cents;
    settled += amountForVerdict(r.verdict, r.amount_cents, includeSuspect);
  }
  return {
    day,
    ruleVersionId: run.rule_version_id,
    runId: run.id,
    sequence: run.sequence,
    eventCount: rows.length,
    valid,
    invalid,
    suspect,
    gross,
    settled,
    excluded: gross - settled,
  };
}

export function createDraftSettlement(db, totals, { actor = 'analysis' } = {}) {
  const at = new Date().toISOString();
  const digest = digestOf({ day: totals.day, runId: totals.runId, settled: totals.settled, counts: [totals.valid, totals.invalid, totals.suspect] });
  db.prepare("DELETE FROM settlements WHERE local_day = ? AND status = 'draft'").run(totals.day);
  const row = db
    .prepare(
      `INSERT INTO settlements (local_day, rule_version_id, status, basis_run_id, basis_sequence, event_count, valid_count,
         invalid_count, suspect_count, gross_amount_cents, settled_amount_cents, excluded_amount_cents, digest, created_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(totals.day, totals.ruleVersionId, totals.runId, totals.sequence, totals.eventCount, totals.valid, totals.invalid, totals.suspect, totals.gross, totals.settled, totals.excluded, digest, at);
  audit(db, { actor, action: 'settlement.draft', entity: 'settlement', entityId: row.id, detail: { day: totals.day, settled: totals.settled } });
  return row;
}

export function sealSettlement(db, day, { actor = 'web' } = {}) {
  return tx(db, () => {
    const draft = db.prepare("SELECT * FROM settlements WHERE local_day = ? AND status = 'draft'").get(day);
    if (!draft) throw new Error(`${day} 没有可封存的结算草稿`);
    const head = db.prepare("SELECT * FROM run_heads WHERE stream = 'production' AND local_day = ?").get(day);
    if (!head) throw new Error(`${day} 没有已提交的运行结果`);
    if (head.run_id !== draft.basis_run_id) {
      throw new Error('草稿依据的运行已被更新结果替代，请先重新生成结算草稿');
    }
    const at = new Date().toISOString();
    const row = db
      .prepare("UPDATE settlements SET status = 'sealed', sealed_at = ?, sealed_by = ? WHERE id = ? AND status = 'draft' RETURNING *")
      .get(at, actor, draft.id);
    audit(db, { actor, action: 'settlement.seal', entity: 'settlement', entityId: draft.id, detail: { day, runId: draft.basis_run_id, settled: draft.settled_amount_cents } });
    return row;
  });
}

export function settlementForDay(db, day) {
  const sealed = db.prepare("SELECT * FROM settlements WHERE local_day = ? AND status = 'sealed'").get(day);
  const draft = db.prepare("SELECT * FROM settlements WHERE local_day = ? AND status = 'draft'").get(day);
  const adjustments = sealed
    ? db.prepare('SELECT * FROM settlement_adjustments WHERE settlement_id = ? ORDER BY id').all(sealed.id)
    : [];
  const adjustmentTotal = adjustments.reduce((a, b) => a + b.delta_amount_cents, 0);
  return {
    sealed: sealed || null,
    draft: draft || null,
    adjustments,
    adjustmentTotal,
    netSettled: sealed ? sealed.settled_amount_cents + adjustmentTotal : draft ? draft.settled_amount_cents : 0,
  };
}

export function listSettlements(db, from, to) {
  return db
    .prepare(
      `SELECT s.*, (SELECT COALESCE(SUM(a.delta_amount_cents), 0) FROM settlement_adjustments a WHERE a.settlement_id = s.id) AS adjustment_total
       FROM settlements s WHERE s.local_day BETWEEN ? AND ? ORDER BY s.local_day, s.id`,
    )
    .all(from, to);
}

export { DAY_MS };

// ---------------------------------------------------------------------------
// Read-side context for the evaluator
// ---------------------------------------------------------------------------

export function currentWatermarks(db) {
  return {
    ingest: Number(db.prepare("SELECT value FROM meta WHERE key = 'ingest_watermark'").get()?.value || 0),
    evidence: Number(db.prepare('SELECT MAX(id) AS v FROM evidence').get()?.v || 0),
  };
}

/** Events occurring inside the target day, bounded by the ingest watermark. */
export function dayEvents(db, day, watermark) {
  return db
    .prepare(
      `SELECT * FROM raw_events
       WHERE local_day = ? AND ingest_seq <= ?
       ORDER BY occurred_at, ingest_seq`,
    )
    .all(day, watermark);
}

/**
 * All events of sessions that touch the target day, from the first event of
 * each such session up to the end of the day. `sessionInfo` reports whether a
 * session was cut by the lookback window so callers can be honest about
 * truncation: the window query cannot see earlier events, so a second lookup
 * asks whether any exist.
 */
export function sessionContext(db, day, watermark, lookbackDays) {
  const dayRows = dayEvents(db, day, watermark);
  const sessionIds = [...new Set(dayRows.map((e) => e.session_id))];
  if (sessionIds.length === 0) return { events: [], truncated: new Set(), info: new Map() };
  // Generous UTC margin so a local-time day start is always covered.
  const from = new Date(Date.parse(`${day}T00:00:00Z`) - (lookbackDays + 1) * DAY_MS).toISOString();
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM raw_events
       WHERE session_id IN (${placeholders}) AND ingest_seq <= ? AND occurred_at >= ?
       ORDER BY session_id, occurred_at, ingest_seq`,
    )
    .all(...sessionIds, watermark, from);
  const truncated = new Set(
    db
      .prepare(
        `SELECT DISTINCT session_id FROM raw_events
         WHERE session_id IN (${placeholders}) AND ingest_seq <= ? AND occurred_at < ?`,
      )
      .all(...sessionIds, watermark, from)
      .map((r) => r.session_id),
  );
  const info = new Map();
  for (const sessionId of sessionIds) {
    const list = rows.filter((r) => r.session_id === sessionId);
    info.set(sessionId, { truncated: truncated.has(sessionId), count: list.length });
  }
  return { events: rows, truncated, info };
}

/** Earliest ingest sequence per order id across the whole raw store. */
export function orderFirstSeq(db, watermark) {
  const rows = db
    .prepare(
      `SELECT order_id, MIN(ingest_seq) AS seq FROM raw_events
       WHERE order_id IS NOT NULL AND ingest_seq <= ? GROUP BY order_id`,
    )
    .all(watermark);
  return new Map(rows.map((r) => [r.order_id, r.seq]));
}

export function evidenceRows(db, asOf) {
  return db
    .prepare('SELECT * FROM evidence WHERE effective_from <= ? ORDER BY id')
    .all(asOf);
}
