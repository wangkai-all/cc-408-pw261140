import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { enqueueJob } from '../src/lib/store.mjs';
import { tempDb, tempDir, ingestEvents, cleanSession, publishRules } from './helpers.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'scripts', 'cli.mjs');
const DAY = '2026-02-01';

function runCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, out }));
  });
}

test('two separate worker processes race on one queue and the newer sequence wins', async (t) => {
  const { db, dir } = tempDb(t);
  const dataDir = tempDir(t);
  const { events } = cleanSession({ day: DAY });
  ingestEvents(db, dataDir, events);
  const v1 = publishRules(db, {
    label: 'proc-v1',
    patch: { settlement: { payout_per_valid_click_cents: 85, currency: 'CNY', include_suspect: false, payout_per_valid_conversion_ratio: 0.08 } },
  });
  const v2 = publishRules(db, {
    label: 'proc-v2',
    patch: { settlement: { payout_per_valid_click_cents: 120, currency: 'CNY', include_suspect: false, payout_per_valid_conversion_ratio: 0.08 } },
  });
  const slow = enqueueJob(db, {
    kind: 'evaluate',
    ruleVersionId: v1.id,
    scopeFrom: DAY,
    scopeTo: DAY,
    processDelayMs: 1500,
    actor: 'test',
  });
  const fast = enqueueJob(db, {
    kind: 'evaluate',
    ruleVersionId: v2.id,
    scopeFrom: DAY,
    scopeTo: DAY,
    actor: 'test',
  });
  const env = { EQS_DB: join(dir, 'test.db'), EQS_DATA_DIR: dataDir };
  const started = Date.now();
  const [a, b] = await Promise.all([
    runCli(['worker', '--lane', 'decisions', '--once'], env),
    runCli(['worker', '--lane', 'decisions', '--once'], env),
  ]);
  for (const r of [a, b]) assert.equal(r.code, 0, r.out);
  assert.ok(Date.now() - started >= 1000, '慢任务应当真的等待');

  const head = db.prepare("SELECT * FROM run_heads WHERE local_day = ?").get(DAY);
  assert.ok(head, '必须有提交的运行');
  assert.equal(head.sequence, fast.sequence, '头必须属于较新序号，而不是较晚完成的任务');
  assert.equal(head.rule_version_id, v2.id);

  const runs = db.prepare('SELECT * FROM decision_runs WHERE scope_from = ? ORDER BY sequence').all(DAY);
  const oldRun = runs.find((r) => r.sequence === slow.sequence);
  const newRun = runs.find((r) => r.sequence === fast.sequence);
  assert.equal(oldRun.status, 'superseded');
  assert.equal(newRun.status, 'committed');
});

test('the CLI settle command drains through the analysis lane and drafts a settlement', async (t) => {
  const { db, dir } = tempDb(t);
  const dataDir = tempDir(t);
  const { events } = cleanSession({ day: DAY });
  ingestEvents(db, dataDir, events);
  const rule = publishRules(db, { label: 'cli-v1' });
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: rule.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  const env = { EQS_DB: join(dir, 'test.db'), EQS_DATA_DIR: dataDir };
  const evalRun = await runCli(['worker', '--lane', 'decisions', '--once'], env);
  assert.equal(evalRun.code, 0, evalRun.out);

  const settle = await runCli(['settle', '--day', DAY], env);
  assert.equal(settle.code, 0, settle.out);
  const draft = db.prepare("SELECT * FROM settlements WHERE local_day = ? AND status = 'draft'").get(DAY);
  assert.ok(draft);
  assert.equal(draft.settled_amount_cents, 85);
});
