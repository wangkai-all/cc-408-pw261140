import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEvaluationInputs } from '../src/lib/context.mjs';
import { evaluateDay } from '../src/engine/evaluate.mjs';
import { tempDb, ingestEvents, makeClick, makeImpression, publishRules } from './helpers.mjs';

/**
 * One session straddles local midnight: impression + click before it, the
 * conversion after it. Under UTC the split is a clean midnight boundary.
 */
const D1 = '2026-03-01';
const D2 = '2026-03-02';

function crossDayEvents() {
  return [
    makeImpression({ id: 'imp_x1', session: 'ses_cross', at: `${D1}T23:55:00.000Z` }),
    makeClick({ id: 'clk_x1', session: 'ses_cross', at: `${D1}T23:56:00.000Z`, impression: 'imp_x1', delayMs: 60_000 }),
    {
      event_id: 'cnv_x1',
      event_type: 'conversion',
      session_id: 'ses_cross',
      occurred_at: `${D2}T00:20:00.000Z`,
      received_at: `${D2}T00:20:02.000Z`,
      site_id: 'site_demo',
      placement_id: 'pl_demo',
      device_id: 'dev_clean_1',
      ip: '10.1.2.3',
      country: 'CN',
      user_agent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/119.0.0.0 Safari/537.36',
      click_id: 'clk_x1',
      order_id: 'ord_x1',
      revenue_cents: 30_000,
    },
  ];
}

function evaluateDayWith(db, day, rules) {
  const inputs = loadEvaluationInputs(db, day, rules);
  const result = evaluateDay({
    rules: rules.rules,
    day,
    events: inputs.events,
    sessionEvents: inputs.sessionEvents,
    sessionInfo: inputs.sessionInfo,
    evidence: inputs.evidence,
    orderFirst: inputs.orderFirst,
    asOf: inputs.asOf,
  });
  return { inputs, result };
}

test('attribution-day assigns each event to the local day it occurred on', async (t) => {
  const { db, dir } = tempDb(t);
  ingestEvents(db, dir, crossDayEvents());
  const rule = publishRules(db, {
    label: 'attr-day',
    patch: { cross_day: { attribution: 'attribution-day', escalate_to_suspect: false } },
  });

  const first = evaluateDayWith(db, D1, rule);
  assert.deepEqual(first.result.decisions.map((d) => d.event.event_id).sort(), ['clk_x1', 'imp_x1']);
  assert.equal(first.result.decisions.length, 2);

  const second = evaluateDayWith(db, D2, rule);
  assert.deepEqual(second.result.decisions.map((d) => d.event.event_id), ['cnv_x1']);

  // The conversion still sees the previous day's click because the whole
  // session is context, so it is valid rather than orphaned.
  assert.equal(second.result.decisions[0].verdict, 'valid');
  const crossNote = second.result.decisions[0].contributions.find((c) => c.rule_id === 'cross_day_session');
  assert.equal(crossNote.outcome, 'note');
  assert.match(crossNote.observed, /2 个自然日/);

  // Under attribution-day the two days together decide every event exactly once.
  const all = [...first.result.decisions, ...second.result.decisions].map((d) => d.event.event_id).sort();
  assert.deepEqual(all, ['clk_x1', 'cnv_x1', 'imp_x1']);
});

test('session-day moves the whole session onto its start day', async (t) => {
  const { db, dir } = tempDb(t);
  ingestEvents(db, dir, crossDayEvents());
  const rule = publishRules(db, {
    label: 'session-day',
    patch: { cross_day: { attribution: 'session-day', escalate_to_suspect: false } },
  });

  const first = evaluateDayWith(db, D1, rule);
  assert.deepEqual(first.result.decisions.map((d) => d.event.event_id).sort(), ['clk_x1', 'cnv_x1', 'imp_x1']);
  for (const d of first.result.decisions) {
    assert.equal(d.attributionDay, D1);
    assert.equal(d.attributionDay, d.sessionStartDay);
    assert.equal(d.sessionCrossDay, true);
    assert.deepEqual(d.sessionDays, [D1, D2]);
  }

  const second = evaluateDayWith(db, D2, rule);
  assert.deepEqual(second.result.decisions, [], '会话日模式下 D2 不再重复判定同一会话');
});

test('escalate_to_suspect turns a cross-day note into a suspect verdict', async (t) => {
  const { db, dir } = tempDb(t);
  ingestEvents(db, dir, crossDayEvents());
  const rule = publishRules(db, {
    label: 'attr-escalate',
    patch: {
      cross_day: { attribution: 'attribution-day', escalate_to_suspect: true },
      // The synthetic conversion UA would otherwise trip no hard rule either.
      hard_checks: { datacenter_ip: { enabled: false } },
    },
  });
  const { result } = evaluateDayWith(db, D1, rule);
  assert.ok(result.decisions.length > 0);
  for (const d of result.decisions) {
    assert.equal(d.sessionCrossDay, true);
    const c = d.contributions.find((x) => x.rule_id === 'cross_day_session');
    assert.equal(c.severity, 'soft');
    assert.equal(c.outcome, 'fail');
  }
  const conversionDay = evaluateDayWith(db, D2, rule).result.decisions[0];
  assert.equal(conversionDay.verdict, 'suspect');
  assert.ok(conversionDay.suspectReasons.some((r) => r.rule_id === 'cross_day_session'));
});

test('a single-day session reports pass and no attribution drift', async (t) => {
  const { db, dir } = tempDb(t);
  ingestEvents(db, dir, [
    makeImpression({ id: 'imp_s1', session: 'ses_single', at: `${D1}T08:00:00.000Z` }),
    makeClick({ id: 'clk_s1', session: 'ses_single', at: `${D1}T08:00:30.000Z`, impression: 'imp_s1', delayMs: 30_000 }),
  ]);
  const rule = publishRules(db, { label: 'single', patch: { cross_day: { attribution: 'attribution-day' } } });
  const { result } = evaluateDayWith(db, D1, rule);
  assert.equal(result.decisions.length, 2);
  for (const d of result.decisions) {
    assert.equal(d.sessionCrossDay, false);
    assert.equal(d.attributionDay, D1);
    assert.equal(d.contributions.find((c) => c.rule_id === 'cross_day_session').outcome, 'pass');
  }
});

test('the lookback window carries earlier session events into the target day', async (t) => {
  const { db, dir } = tempDb(t);
  // The click happened two days before the conversion, inside lookback_days=7.
  ingestEvents(db, dir, [
    makeImpression({ id: 'imp_lb', session: 'ses_lb', at: '2026-03-01T09:00:00.000Z' }),
    makeClick({ id: 'clk_lb', session: 'ses_lb', at: '2026-03-01T09:00:05.000Z', impression: 'imp_lb', delayMs: 5000 }),
    {
      event_id: 'cnv_lb',
      event_type: 'conversion',
      session_id: 'ses_lb',
      occurred_at: '2026-03-03T09:00:00.000Z',
      received_at: '2026-03-03T09:00:01.000Z',
      site_id: 'site_demo',
      placement_id: 'pl_demo',
      device_id: 'dev_clean_1',
      ip: '10.1.2.3',
      country: 'CN',
      user_agent: 'Mozilla/5.0 (Macintosh) Version/17.1 Safari/605.1.15',
      click_id: 'clk_lb',
      order_id: 'ord_lb',
      revenue_cents: 12_000,
    },
  ]);
  const rule = publishRules(db, { label: 'lookback', patch: { cross_day: { attribution: 'attribution-day' } } });
  const { inputs, result } = evaluateDayWith(db, '2026-03-03', rule);
  assert.equal(inputs.events.length, 1);
  assert.equal(inputs.sessionEvents.length, 3, '回溯窗口内应包含整段会话');
  assert.equal(result.decisions[0].verdict, 'valid');
  assert.equal(result.decisions[0].sessionStartDay, '2026-03-01');
});

test('a session cut by the lookback window is reported as truncated', async (t) => {
  const { db, dir } = tempDb(t);
  ingestEvents(db, dir, [
    makeImpression({ id: 'imp_old', session: 'ses_long', at: '2026-01-01T00:00:00.000Z' }),
    makeImpression({ id: 'imp_new', session: 'ses_long', at: '2026-03-01T00:00:30.000Z' }),
  ]);
  const rule = publishRules(db, { label: 'trunc', patch: { lookback_days: 1 } });
  const { inputs, result } = evaluateDayWith(db, '2026-03-01', rule);
  assert.equal(inputs.truncatedSessions, 1);
  assert.equal(inputs.sessionInfo.get('ses_long').truncated, true);
  // The visible part is still evaluated; the truncation is explicit metadata.
  assert.ok(result.decisions.length >= 1);
  assert.equal(result.decisions[0].sessionTruncated, true);
});
