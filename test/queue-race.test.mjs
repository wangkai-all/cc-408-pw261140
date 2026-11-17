import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimJob,
  commitRun,
  enqueueJob,
  fenceIntact,
  finishJob,
  headRunForDay,
  reclaimStaleJobs,
  renewLease,
} from '../src/lib/store.mjs';
import { runJob } from '../src/worker/worker.mjs';
import { tempDb, ingestEvents, cleanSession, publishRules, processQueue } from './helpers.mjs';

const DAY = '2026-02-01';

function setup(db, dir) {
  const { events } = cleanSession({ day: DAY });
  ingestEvents(db, dir, events);
  return {
    v1: publishRules(db, { label: 'v1', patch: { settlement: { payout_per_valid_click_cents: 85, currency: 'CNY', include_suspect: false, payout_per_valid_conversion_ratio: 0.08 } } }),
    v2: publishRules(db, { label: 'v2', patch: { settlement: { payout_per_valid_click_cents: 120, currency: 'CNY', include_suspect: false, payout_per_valid_conversion_ratio: 0.08 } } }),
  };
}

test('a late-finishing older job is archived as superseded and cannot replace the head', async (t) => {
  const { db, dir } = tempDb(t);
  const { v1, v2 } = setup(db, dir);

  // Sequence 1 is the older job; it is claimed first and finishes last.
  const olderRow = enqueueJob(db, { kind: 'evaluate', ruleVersionId: v1.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  const older = claimJob(db, { kinds: ['evaluate'], workerId: 'slow-worker' });
  assert.equal(older.id, olderRow.id);
  assert.equal(older.rule_version_id, v1.id);
  const olderJob = { ...db.prepare('SELECT * FROM jobs WHERE id = ?').get(older.id), params: {}, fence: older.fence };

  const newerRow = enqueueJob(db, { kind: 'evaluate', ruleVersionId: v2.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  assert.ok(newerRow.sequence > olderJob.sequence);
  const newer = claimJob(db, { kinds: ['evaluate'], workerId: 'fast-worker' });
  assert.equal(newer.id, newerRow.id);
  const newerResult = await runJob(db, newer, {});
  assert.equal(finishJob(db, newer.id, newer.fence, { status: 'succeeded', result: newerResult }), true);

  const headAfterFast = headRunForDay(db, DAY);
  assert.equal(headAfterFast.rule_version_id, v2.id);
  assert.equal(headAfterFast.sequence, newerRow.sequence);

  // The old worker now finishes. Its row is history, never the head.
  const olderResult = await runJob(db, olderJob, {});
  assert.equal(olderResult.days[0].committed, false);
  assert.equal(olderResult.days[0].superseded, true);
  finishJob(db, olderJob.id, olderJob.fence, { status: 'succeeded', result: olderResult });

  const head = headRunForDay(db, DAY);
  assert.equal(head.run_id, headAfterFast.run_id, '按入队序号守住运行头，与完成时间无关');
  assert.equal(head.rule_version_id, v2.id);

  const runs = db.prepare('SELECT id, sequence, status, note FROM decision_runs WHERE scope_from = ? ORDER BY sequence').all(DAY);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].status, 'superseded');
  assert.match(runs[0].note, /更新序号/);
  assert.equal(runs[1].status, 'committed');

  const warn = db
    .prepare("SELECT * FROM job_events WHERE job_id = ? AND level = 'warn' ORDER BY id DESC LIMIT 1")
    .get(olderJob.id);
  assert.match(warn.message, /被更新序号覆盖/);
  assert.equal(JSON.parse(warn.detail_json).headSequence, newerRow.sequence);
});

test('a newer job replayed on the same day replaces the head and supersedes the old run', async (t) => {
  const { db, dir } = tempDb(t);
  const { v1, v2 } = setup(db, dir);
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: v1.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['evaluate']);
  const firstHead = headRunForDay(db, DAY);
  assert.equal(firstHead.rule_version_id, v1.id);

  enqueueJob(db, { kind: 'evaluate', ruleVersionId: v2.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['evaluate']);
  const head = headRunForDay(db, DAY);
  assert.equal(head.rule_version_id, v2.id);
  assert.notEqual(head.id, firstHead.id);

  const previous = db.prepare('SELECT * FROM decision_runs WHERE id = ?').get(firstHead.id);
  assert.equal(previous.status, 'superseded');
  assert.match(previous.note, new RegExp(`运行 #${head.id}`));
});

test('a worker that lost its lease cannot commit a run', async (t) => {
  const { db, dir } = tempDb(t);
  const { v1 } = setup(db, dir);
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: v1.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  const stolen = claimJob(db, { kinds: ['evaluate'], workerId: 'worker-a' });
  // Lease expires and another worker reclaims the job (fence increments).
  db.prepare("UPDATE jobs SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(stolen.id);
  const reclaimed = reclaimStaleJobs(db, ['evaluate']);
  assert.equal(reclaimed.length, 1);
  const reclaim = claimJob(db, { kinds: ['evaluate'], workerId: 'worker-b' });
  assert.equal(reclaim.id, stolen.id);
  assert.equal(reclaim.fence, stolen.fence + 1);

  // Worker A tries to finish with the old fence: no state change.
  assert.equal(finishJob(db, stolen.id, stolen.fence, { status: 'succeeded', result: { days: [] } }), false);
  assert.equal(fenceIntact(db, stolen.id, stolen.fence), false);
  assert.equal(renewLease(db, stolen.id, stolen.fence), false);
  assert.equal(renewLease(db, stolen.id, reclaim.fence), true);

  // Worker A's commit attempt is rejected outright.
  const job = { id: stolen.id, fence: stolen.fence, sequence: stolen.sequence, stream: 'production', params: {} };
  const result = commitRun(db, {
    job,
    day: DAY,
    ruleVersionId: v1.id,
    decisions: [],
    asOf: new Date().toISOString(),
    ingestWatermark: 2,
    evidenceWatermark: 0,
  });
  assert.deepEqual(result, { committed: false, superseded: true, reason: 'fence' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM decision_runs').get().n, 0);
});

test('runJob aborts mid-flight when the fence was taken over', async (t) => {
  const { db, dir } = tempDb(t);
  const { v1 } = setup(db, dir);
  enqueueJob(db, {
    kind: 'evaluate',
    ruleVersionId: v1.id,
    scopeFrom: DAY,
    scopeTo: DAY,
    processDelayMs: 250,
    actor: 'test',
  });
  const job = claimJob(db, { kinds: ['evaluate'], workerId: 'worker-a' });
  const pending = runJob(db, job, {});
  // Simulate another worker taking over while the slow job sleeps.
  db.prepare('UPDATE jobs SET fence = fence + 1, claimed_by = ? WHERE id = ?').run('worker-b', job.id);
  const result = await pending;
  assert.deepEqual(result, { aborted: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM decision_runs').get().n, 0);
  assert.match(
    db.prepare('SELECT message FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(job.id).message,
    /租约已被接管/,
  );
});

test('a takeover during the settle lane discards the draft', async (t) => {
  const { db, dir } = tempDb(t);
  const { v1 } = setup(db, dir);
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: v1.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['evaluate']);
  enqueueJob(db, { kind: 'settle', scopeFrom: DAY, scopeTo: DAY, processDelayMs: 250, actor: 'test' });
  const job = claimJob(db, { kinds: ['settle'], workerId: 'analysis-a' });
  const pending = runJob(db, job, {});
  db.prepare('UPDATE jobs SET fence = fence + 1, claimed_by = ? WHERE id = ?').run('analysis-b', job.id);
  const result = await pending;
  assert.deepEqual(result, { aborted: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settlements').get().n, 0);
});

test('jobs are claimed by priority first, then by enqueue sequence', async (t) => {
  const { db, dir } = tempDb(t);
  const { v1 } = setup(db, dir);
  const low = enqueueJob(db, { kind: 'evaluate', ruleVersionId: v1.id, scopeFrom: DAY, scopeTo: DAY, priority: 10, actor: 'test' });
  const high = enqueueJob(db, { kind: 'evaluate', ruleVersionId: v1.id, scopeFrom: DAY, scopeTo: DAY, priority: 900, actor: 'test' });
  const first = claimJob(db, { kinds: ['evaluate'], workerId: 'w1' });
  const second = claimJob(db, { kinds: ['evaluate'], workerId: 'w2' });
  assert.equal(first.id, high.id);
  assert.equal(second.id, low.id);
  assert.ok(high.sequence > low.sequence);
  assert.equal(claimJob(db, { kinds: ['evaluate'], workerId: 'w3' }), null);
});
