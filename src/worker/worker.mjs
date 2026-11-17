import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  claimJob,
  commitRun,
  computeSettlement,
  createDraftSettlement,
  fenceIntact,
  finishJob,
  getRuleVersion,
  headRunForDay,
  jobLog,
  reclaimStaleJobs,
  renewLease,
} from '../lib/store.mjs';
import { buildDiffReport } from '../engine/diff.mjs';
import { evaluateDay } from '../engine/evaluate.mjs';
import { captureSnapshot, loadEvaluationInputs } from '../lib/context.mjs';
import { tx } from '../lib/db.mjs';
import { dayRange } from '../lib/time.mjs';

/**
 * Worker lanes. Three independent processes are launched in the demo:
 *   - ingest    (no loop; writes raw events)
 *   - decisions (kind=evaluate, compare, correction)
 *   - analysis  (kind=settle)
 * They share one SQLite file and coordinate only through the job queue.
 */
export const LANES = {
  decisions: ['evaluate', 'compare', 'correction'],
  analysis: ['settle'],
  all: ['evaluate', 'compare', 'correction', 'settle'],
};

export function workerId(lane) {
  return `${lane}@${hostname()}#${randomUUID().slice(0, 6)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run one claimed job. Exported for tests. */
export async function runJob(db, job, { log = () => {} } = {}) {
  const delay = Number(job.process_delay_ms || 0);
  const params = job.params || {};
  const days = dayRange(job.scope_from, job.scope_to);

  if (job.kind === 'evaluate') {
    const rule = getRuleVersion(db, job.rule_version_id);
    if (!rule) throw new Error('规则版本不存在');
    if (rule.status === 'draft') throw new Error('草稿规则不能用于生产判定');
    // All days of this job read the same watermark and evidence set, so a
    // batch arriving mid-run cannot make later days see different data.
    const snapshot = captureSnapshot(db);
    const results = [];
    for (const day of days) {
      if (!fenceIntact(db, job.id, job.fence)) {
        jobLog(db, job.id, 'warn', '租约已被接管，停止写入');
        return { aborted: true };
      }
      if (delay > 0) await sleep(delay);
      if (!fenceIntact(db, job.id, job.fence)) {
        jobLog(db, job.id, 'warn', '处理期间租约已被接管，本次结果丢弃');
        return { aborted: true };
      }
      const inputs = loadEvaluationInputs(db, day, rule, snapshot);
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
      const commit = commitRun(db, {
        job,
        day,
        ruleVersionId: rule.id,
        decisions: result.decisions,
        asOf: inputs.asOf,
        ingestWatermark: inputs.ingestWatermark,
        evidenceWatermark: inputs.evidenceWatermark,
        note: params.note || null,
      });
      if (!commit.committed && commit.reason === 'fence') {
        jobLog(db, job.id, 'warn', '提交时租约已失效，运行未写入');
        return { aborted: true };
      }
      results.push({
        day,
        runId: commit.runId,
        committed: commit.committed,
        superseded: commit.superseded,
        digest: commit.digest,
        events: result.decisions.length,
        crossDay: result.decisions.filter((d) => d.sessionCrossDay).length,
        replacedRunId: commit.replacedRunId || null,
      });
      log(`  ${day}: ${result.decisions.length} 条判定，${commit.committed ? `已提交运行 #${commit.runId}` : '未替换当前结果（序号较旧）'}`);
    }
    return {
      days: results,
      committed: results.filter((r) => r.committed).length,
      superseded: results.filter((r) => r.superseded).length,
    };
  }

  if (job.kind === 'compare' || job.kind === 'correction') {
    const report = buildDiffReport(db, {
      job,
      kind: job.kind === 'correction' ? 'correction' : 'rule_compare',
      baselineRuleId: params.baselineRuleId ?? null,
      candidateRuleId: params.candidateRuleId ?? job.rule_version_id,
      days,
      actor: job.claimed_by || 'worker',
      processDelayMs: delay,
      log,
      fenceCheck: () => fenceIntact(db, job.id, job.fence),
    });
    if (report?.aborted) return { aborted: true };
    return { reportId: report.id, digest: report.digest, status: report.status };
  }

  if (job.kind === 'settle') {
    const includeSuspect = Boolean(params.includeSuspect);
    const drafts = [];
    for (const day of days) {
      // A worker whose lease was taken over must not draft a settlement: the
      // draft would look like the current analysis output even though the job
      // was already reassigned.
      if (!fenceIntact(db, job.id, job.fence)) {
        jobLog(db, job.id, 'warn', '租约已被接管，结算草稿未写入');
        return { aborted: true };
      }
      const run = headRunForDay(db, day);
      if (!run) {
        jobLog(db, job.id, 'warn', `${day} 没有已提交的生产运行，跳过`);
        continue;
      }
      if (delay > 0) await sleep(delay);
      if (!fenceIntact(db, job.id, job.fence)) {
        jobLog(db, job.id, 'warn', '处理期间租约已被接管，本次结算结果丢弃');
        return { aborted: true };
      }
      const totals = computeSettlement(db, { day, run, includeSuspect });
      const row = tx(db, () => createDraftSettlement(db, totals, { actor: job.claimed_by || 'analysis' }));
      drafts.push({ day, settlementId: row.id, runId: run.id, settled: row.settled_amount_cents, basisSequence: row.basis_sequence });
      log(`  ${day}: 结算草稿 #${row.id}，金额 ${(row.settled_amount_cents / 100).toFixed(2)} 元（依据运行 #${run.id}）`);
    }
    return { drafts };
  }

  throw new Error(`未知任务类型 ${job.kind}`);
}

export async function runWorker({
  db,
  lane = 'all',
  once = false,
  pollMs = 300,
  idleExitMs = 20_000,
  log = () => {},
  shouldStop = () => false,
}) {
  const kinds = LANES[lane] || LANES.all;
  const id = workerId(lane);
  reclaimStaleJobs(db, kinds);
  log(`工作者 ${id} 启动（${kinds.join(', ')}）`);
  let idleSince = Date.now();
  while (!shouldStop()) {
    const job = claimJob(db, { kinds, workerId: id });
    if (job) {
      idleSince = Date.now();
      log(`领取 ${job.id}（${job.kind}，序号 ${job.sequence}，fence ${job.fence}）`);
      const keepAlive = setInterval(() => renewLease(db, job.id, job.fence), 30_000);
      keepAlive.unref?.();
      try {
        const result = await runJob(db, job, { log });
        if (result?.aborted) {
          log(`任务 ${job.id} 的租约已易主，结果被丢弃`);
        } else {
          const done = finishJob(db, job.id, job.fence, { status: 'succeeded', result });
          if (!done) jobLog(db, job.id, 'warn', '完成时租约已易主，成功状态未写入');
          else log(`任务 ${job.id} 完成`);
        }
      } catch (err) {
        const fresh = db.prepare('SELECT fence FROM jobs WHERE id = ?').get(job.id);
        if (fresh && fresh.fence === job.fence) {
          jobLog(db, job.id, 'error', `任务失败：${err.message}`);
          finishJob(db, job.id, job.fence, { status: 'failed', error: err.message });
        }
        log(`任务 ${job.id} 失败：${err.message}`);
      } finally {
        clearInterval(keepAlive);
      }
      if (once) return;
      continue;
    }
    if (once) return;
    if (Date.now() - idleSince > idleExitMs) {
      log('队列空闲，工作者退出');
      return;
    }
    await sleep(pollMs);
  }
}
