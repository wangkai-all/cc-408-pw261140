import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDay, decisionDigest } from '../src/engine/evaluate.mjs';
import { DEFAULT_RULES, cloneRules } from '../src/engine/rules.mjs';
import { makeClick, makeImpression, tempDb, ingestEvents, cleanSession, publishRules, processQueue } from './helpers.mjs';
import { enqueueJob } from '../src/lib/store.mjs';

const DAY = '2026-02-01';

function sessionRows() {
  const impression = { ...makeImpression({ id: 'imp_a', session: 'ses_a', at: `${DAY}T10:00:00.000Z` }), local_day: DAY, ingest_seq: 1 };
  const click = {
    ...makeClick({ id: 'clk_a', session: 'ses_a', at: `${DAY}T10:00:01.000Z`, impression: 'imp_a', delayMs: 1000 }),
    local_day: DAY,
    ingest_seq: 2,
  };
  return [impression, click];
}

function evaluate(rules, { events = sessionRows(), day = DAY } = {}) {
  return evaluateDay({
    rules,
    day,
    events,
    sessionEvents: events,
    sessionInfo: new Map(),
    evidence: [],
    orderFirst: new Map(),
    asOf: '2026-02-01T12:00:00.000Z',
  });
}

test('the same inputs always produce the same verdicts and digest', () => {
  const a = evaluate(DEFAULT_RULES);
  const b = evaluate(DEFAULT_RULES);
  assert.equal(a.decisions.length, 2);
  assert.deepEqual(
    a.decisions.map((d) => [d.event.event_id, d.verdict, d.primaryReason]),
    b.decisions.map((d) => [d.event.event_id, d.verdict, d.primaryReason]),
  );
  assert.equal(decisionDigest(a.decisions), decisionDigest(b.decisions));
  assert.ok(a.decisions.every((d) => d.verdict === 'valid'));
  for (const d of a.decisions) {
    assert.ok(d.contributions.length > 0, '每条判定都必须带贡献');
    d.contributions.forEach((c, i) => {
      assert.equal(c.check_order, i + 1);
      assert.ok(c.rule_id && c.rule_label);
      assert.ok(['pass', 'fail', 'skip', 'note'].includes(c.outcome));
      assert.ok(['event', 'session', 'evidence'].includes(c.scope));
    });
  }
});

test('two runs of the same day under the same rule commit identical run digests', async (t) => {
  const { db, dir } = tempDb(t);
  const { events } = cleanSession({ day: DAY });
  ingestEvents(db, dir, events);
  const rule = publishRules(db, { label: 'v1' });
  for (let i = 0; i < 2; i += 1) {
    enqueueJob(db, { kind: 'evaluate', ruleVersionId: rule.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
    await processQueue(db, ['evaluate']);
  }
  const runs = db.prepare('SELECT * FROM decision_runs ORDER BY id').all();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].digest, runs[1].digest);
  assert.equal(runs[0].status, 'superseded');
  assert.equal(runs[1].status, 'committed');
  assert.equal(runs[0].event_count, runs[1].event_count);
});

test('a hard failure invalidates and a soft failure only marks suspect', () => {
  const strict = evaluate(DEFAULT_RULES, {
    events: [
      { ...makeImpression({ id: 'imp_b', session: 'ses_b', at: `${DAY}T11:00:00.000Z` }), local_day: DAY, ingest_seq: 1 },
      {
        ...makeClick({ id: 'clk_b', session: 'ses_b', at: `${DAY}T11:00:00.010Z`, impression: 'imp_b', delayMs: 10 }),
        local_day: DAY,
        ingest_seq: 2,
      },
    ],
  });
  const strictClick = strict.decisions.find((d) => d.event.event_id === 'clk_b');
  assert.equal(strictClick.verdict, 'invalid');
  assert.equal(strictClick.primaryReason, 'click_delay_low');
  const fail = strictClick.contributions.find((c) => c.rule_id === 'click_delay_low');
  assert.equal(fail.severity, 'hard');
  assert.equal(fail.outcome, 'fail');
  assert.equal(fail.observed, '10 ms');
  assert.equal(fail.threshold, '40 ms');

  const lenientRules = cloneRules(DEFAULT_RULES);
  lenientRules.hard_checks.click_delay.treat_faster_than_min_as = 'suspect';
  const lenient = evaluate(lenientRules, { events: strict.decisions.map((d) => d.event) });
  const lenientClick = lenient.decisions.find((d) => d.event.event_id === 'clk_b');
  assert.equal(lenientClick.verdict, 'suspect');
  assert.equal(lenientClick.primaryReason, 'click_delay_low');
  assert.equal(lenientClick.contributions.find((c) => c.rule_id === 'click_delay_low').severity, 'soft');
});

test('an invalid verdict wins over suspect reasons and keeps both lists', () => {
  // Headless UA (hard) plus an evenly spaced burst (soft) in the same session.
  const ua = 'Mozilla/5.0 HeadlessChrome/118.0.0.0';
  const events = [];
  const start = Date.parse(`${DAY}T12:00:00.000Z`);
  for (let i = 0; i < 12; i += 1) {
    const at = new Date(start + i * 5000).toISOString();
    events.push({
      ...makeImpression({ id: `imp_burst_${String(i).padStart(2, '0')}`, session: 'ses_burst', at, ua }),
      local_day: DAY,
      ingest_seq: i + 1,
    });
  }
  const result = evaluate(DEFAULT_RULES, { events });
  const first = result.decisions[0];
  assert.equal(first.verdict, 'invalid');
  assert.ok(first.invalidReasons.some((r) => r.rule_id === 'bot_ua'));
  assert.ok(first.suspectReasons.some((r) => r.rule_id === 'regular_interval'), '软规则仍需留痕');
  assert.equal(first.primaryReason, 'bot_ua');
});
