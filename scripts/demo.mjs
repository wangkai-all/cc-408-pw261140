#!/usr/bin/env node
/**
 * Full demo, executed as separate OS processes so the process boundaries are
 * real:
 *
 *   ingest       -> writes raw batches (already on disk from seed), replays a
 *                   late correction file
 *   decisions    -> evaluates jobs into versioned runs
 *   analysis     -> builds settlement drafts and diff reports
 *
 * The story:
 *   1. Seed 7 days of synthetic traffic.
 *   2. Ingest the initial batches.
 *   3. Decisions worker evaluates all days under v1.
 *   4. Analysis worker drafts settlements; days 1-3 are sealed.
 *   5. Late evidence arrives (device flags, an order reversal).
 *   6. A correction report is produced against the stored decisions.
 *   7. Approving it posts adjustment entries; sealed totals never change.
 *   8. v2 is compared to v1 over the same frozen snapshot.
 *   9. A deliberately slow v1 job is enqueued, then a v2 job; the slow one
 *      finishes last and must not replace the newer result.
 */
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../src/lib/db.mjs';
import { readFixtures, seedEvidence, seedLateEvidence } from '../src/ingest/pipeline.mjs';
import { enqueueJob, headRunForDay, sealSettlement, settlementForDay } from '../src/lib/store.mjs';
import { getReport, approveReport } from '../src/engine/diff.mjs';
import { addDays, localDay } from '../src/lib/time.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'cli.mjs');

function run(args, { label } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, EQS_CHILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(label ? `[${label}] ${d}` : d);
    });
    child.stderr.on('data', (d) => {
      out += d;
      process.stderr.write(label ? `[${label}] ${d}` : d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${args.join(' ')} 退出码 ${code}\n${out}`));
      else resolvePromise(out);
    });
  });
}

function banner(text) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`);
}

export async function runDemo({ timezone = 'Asia/Shanghai', reset = true } = {}) {
  if (reset) await run(['reset']);
  const today = localDay(new Date(), timezone);
  const to = addDays(today, -1);
  const from = addDays(to, -6);
  const sealedDays = [from, addDays(from, 1), addDays(from, 2)];

  banner(`1/9 生成虚构数据（${from} ~ ${to}）`);
  await run(['seed', '--from', from, '--to', to, '--timezone', timezone]);

  banner('2/9 原始接入进程：写入批次');
  await run(['ingest']);

  {
    const db = openDb();
    const fixtures = readFixtures();
    // The first evidence wave is dated from the earliest event so it applies
    // to every day; the late wave arrives afterwards and therefore only shows
    // up in the correction report.
    seedEvidence(db, { fixtures, from, log: (m) => console.log(`  ${m}`) });
    const v1 = db.prepare("SELECT * FROM rule_versions WHERE slug = 'v1-baseline'").get();
    closeDb();
    banner('3/9 判定工作进程：v1 基线评估 7 天');
    await enqueueJob(openDb(), { kind: 'evaluate', ruleVersionId: v1.id, scopeFrom: from, scopeTo: to, actor: 'demo' });
    closeDb();
    await run(['worker', '--lane', 'decisions', '--idle-exit-ms', '1200'], { label: 'decisions' });
  }

  banner('4/9 分析进程：生成结算草稿');
  await enqueueJob(openDb(), { kind: 'settle', scopeFrom: from, scopeTo: to, actor: 'demo' });
  closeDb();
  await run(['worker', '--lane', 'analysis', '--idle-exit-ms', '1200'], { label: 'analysis' });

  {
    const db = openDb();
    for (const day of sealedDays) sealSettlement(db, day, { actor: 'demo:finance' });
    for (const day of sealedDays) {
      const st = settlementForDay(db, day);
      console.log(`  ${day} 已封存 #${st.sealed.id}：${(st.sealed.settled_amount_cents / 100).toFixed(2)} 元`);
    }
    closeDb();
  }

  banner('5/9 补录证据（设备标记、订单撤销）');
  {
    const db = openDb();
    const fixtures = readFixtures();
    seedLateEvidence(db, { fixtures, effectiveFrom: `${from}T00:00:00+08:00`, log: (m) => console.log(`  ${m}`) });
    closeDb();
  }

  banner('6/9 更正报告（对照已封存的判定历史）');
  {
    const db = openDb();
    const v1 = db.prepare("SELECT * FROM rule_versions WHERE slug = 'v1-baseline'").get();
    closeDb();
    await enqueueJob(openDb(), {
      kind: 'correction',
      ruleVersionId: v1.id,
      scopeFrom: from,
      scopeTo: to,
      params: { baselineRuleId: v1.id, candidateRuleId: v1.id },
      actor: 'demo',
    });
    closeDb();
    await run(['worker', '--lane', 'decisions', '--idle-exit-ms', '1200'], { label: 'decisions' });
  }

  banner('7/9 审核并批准更正报告（只追加调整分录）');
  {
    const db = openDb();
    const report = db.prepare("SELECT * FROM diff_reports WHERE kind = 'correction' ORDER BY id DESC LIMIT 1").get();
    const detail = getReport(db, report.id);
    console.log(`  报告 #${report.id}：${detail.summary.totals.changedEvents} 条变化，金额差 ${(detail.summary.totals.deltaAmount / 100).toFixed(2)} 元`);
    for (const r of detail.reasons) console.log(`    ${r.rule_label}：${r.events} 条，金额 ${(r.delta_amount_cents / 100).toFixed(2)} 元`);
    const before = sealedDays.map((d) => settlementForDay(db, d).sealed.settled_amount_cents);
    const result = approveReport(db, report.id, { actor: 'demo:reviewer', note: '演示自动批准' });
    const after = sealedDays.map((d) => settlementForDay(db, d));
    for (let i = 0; i < sealedDays.length; i += 1) {
      console.log(
        `  ${sealedDays[i]} 封存金额 ${(before[i] / 100).toFixed(2)} 元保持不变；调整 ${(after[i].adjustmentTotal / 100).toFixed(2)} 元，净额 ${(after[i].netSettled / 100).toFixed(2)} 元`,
      );
    }
    console.log(`  调整分录：${result.applied.length} 条，重算草稿：${result.restate.length} 天`);
    closeDb();
  }

  banner('8/9 v1 → v2 规则差异报告（同一冻结快照）');
  {
    const db = openDb();
    const v1 = db.prepare("SELECT * FROM rule_versions WHERE slug = 'v1-baseline'").get();
    const v2 = db.prepare("SELECT * FROM rule_versions WHERE slug = 'v2-strict'").get();
    closeDb();
    await enqueueJob(openDb(), {
      kind: 'compare',
      ruleVersionId: v2.id,
      scopeFrom: from,
      scopeTo: to,
      params: { baselineRuleId: v1.id, candidateRuleId: v2.id },
      actor: 'demo',
    });
    closeDb();
    await run(['worker', '--lane', 'decisions', '--idle-exit-ms', '1200'], { label: 'decisions' });
    const db2 = openDb();
    const report = db2.prepare("SELECT * FROM diff_reports WHERE kind = 'rule_compare' ORDER BY id DESC LIMIT 1").get();
    const detail = getReport(db2, report.id);
    console.log(`  报告 #${report.id}：${detail.summary.totals.changedEvents} 条变化，金额差 ${(detail.summary.totals.deltaAmount / 100).toFixed(2)} 元`);
    for (const r of detail.reasons) console.log(`    ${r.rule_label}（${r.rule_id}）：${r.events} 条`);
    closeDb();
  }

  banner('9/9 竞态演示：晚结束的旧任务不能替换新结果');
  {
    const db = openDb();
    const v1 = db.prepare("SELECT * FROM rule_versions WHERE slug = 'v1-baseline'").get();
    const v2 = db.prepare("SELECT * FROM rule_versions WHERE slug = 'v2-strict'").get();
    const day = to;
    // The slow v1 job is enqueued first (lower sequence) but each worker is
    // started with --once so both jobs are picked up concurrently. The v1 job
    // finishes last yet must not become the day's head.
    const slow = enqueueJob(db, { kind: 'evaluate', ruleVersionId: v1.id, scopeFrom: day, scopeTo: day, processDelayMs: 2500, actor: 'demo' });
    const fast = enqueueJob(db, { kind: 'evaluate', ruleVersionId: v2.id, scopeFrom: day, scopeTo: day, actor: 'demo' });
    console.log(`  先入队 v1 慢任务 seq=${slow.sequence}（延迟 2.5s），再入队 v2 快任务 seq=${fast.sequence}`);
    closeDb();
    const started = Date.now();
    await Promise.all([
      run(['worker', '--lane', 'decisions', '--once'], { label: 'worker-1' }),
      run(['worker', '--lane', 'decisions', '--once'], { label: 'worker-2' }),
    ]);
    console.log(`  两个工作者并发处理完毕（${Date.now() - started} ms）`);
    const db2 = openDb();
    const head = headRunForDay(db2, day);
    const runs = db2.prepare('SELECT id, sequence, rule_version_id, status, note FROM decision_runs WHERE scope_from = ? ORDER BY id').all(day);
    console.log(`  ${day} 当前头：运行 #${head.id}（规则 #${head.rule_version_id}，seq ${head.sequence}）`);
    for (const r of runs) {
      console.log(`    运行 #${r.id} 规则 #${r.rule_version_id} seq=${r.sequence} ${r.status}${r.note ? ` — ${r.note}` : ''}`);
    }
    if (head.rule_version_id !== v2.id) throw new Error('竞态演示失败：晚结束的旧任务替换了新结果');
    closeDb();
  }

  banner('完成');
  console.log('启动网页控制台：npm run web  （默认 http://127.0.0.1:4317）');
}
