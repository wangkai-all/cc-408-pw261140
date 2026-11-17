import {
  currentWatermarks,
  dayEvents,
  evidenceRows,
  orderFirstSeq,
  sessionContext,
} from './store.mjs';

/**
 * Freeze the job's inputs: the ingest watermark and the evidence set visible
 * at the instant the job starts. A later batch or a piece of evidence added
 * while the job runs must not leak into it, otherwise two sides of a
 * comparison could see different data and the delta would no longer be
 * attributable to the rule change.
 */
export function captureSnapshot(db) {
  const { ingest } = currentWatermarks(db);
  const asOf = new Date().toISOString();
  const evidence = evidenceRows(db, asOf);
  return {
    ingestWatermark: ingest,
    evidenceWatermark: evidence.reduce((max, e) => Math.max(max, Number(e.id) || 0), 0),
    evidence,
    asOf,
  };
}

/**
 * Build the frozen input snapshot for one day under one rule version.
 *
 * The target set depends on the attribution mode:
 *  - attribution-day: every event that occurred on the local day.
 *  - session-day: every event of a session that started on the local day,
 *    even when it occurred after midnight.
 * Session context always includes the whole session (within the lookback
 * window), so cross-day evidence is available to the checks.
 */
export function loadEvaluationInputs(db, day, rule, snapshot = captureSnapshot(db)) {
  const ctx = sessionContext(db, day, snapshot.ingestWatermark, rule.rules.lookback_days);
  const attribution = rule.rules.cross_day?.attribution || 'attribution-day';
  const occurrences = dayEvents(db, day, snapshot.ingestWatermark);

  let target;
  if (attribution === 'session-day') {
    const startDayBySession = new Map();
    for (const ev of ctx.events) {
      if (!startDayBySession.has(ev.session_id)) startDayBySession.set(ev.session_id, ev.local_day);
    }
    target = ctx.events.filter((ev) => startDayBySession.get(ev.session_id) === day);
  } else {
    target = occurrences;
  }

  return {
    events: target,
    sessionEvents: ctx.events,
    sessionInfo: ctx.info,
    evidence: snapshot.evidence,
    orderFirst: orderFirstSeq(db, snapshot.ingestWatermark),
    ingestWatermark: snapshot.ingestWatermark,
    evidenceWatermark: snapshot.evidenceWatermark,
    asOf: snapshot.asOf,
    attribution,
    truncatedSessions: ctx.truncated.size,
  };
}
