#!/usr/bin/env node
/**
 * One command surface for the four processes. The demo script spawns these as
 * separate OS processes; nothing relies on in-process shared memory.
 */
import { openDb, closeDb } from '../src/lib/db.mjs';
import { localDay, addDays } from '../src/lib/time.mjs';
import { ingestAll, seedDataset, initDatabase, DATA_DIR } from '../src/ingest/pipeline.mjs';
import { runWorker, LANES } from '../src/worker/worker.mjs';
import {
  enqueueJob,
  listJobs,
  sealSettlement,
  addEvidence,
  publishRuleVersion,
  retireRuleVersion,
  listRuleVersions,
  getRuleVersion,
} from '../src/lib/store.mjs';
import { getReport, approveReport } from '../src/engine/diff.mjs';
import { summary } from '../src/analysis/reports.mjs';
import { DEFAULT_TIMEZONE } from '../src/ingest/ingest.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

const log = (...args) => console.log(...args);

function usage() {
  console.log(`用法: node scripts/cli.mjs <命令> [选项]

  init        初始化数据库和默认规则
  seed        生成虚构数据并写入规则版本
  ingest      原始接入进程：校验并写入 NDJSON 批次
  worker      判定/分析工作进程（--lane decisions|analysis|all）
  enqueue     投递任务：evaluate | compare | correction | settle
  settle      生成结算草稿（--day，或 --from/--to；等价于投递 settle 任务后由分析进程处理）
  seal        封存某日结算（--day YYYY-MM-DD）
  evidence    追加证据
  rules       规则版本：list | create --file rules.json | publish --id N | retire --id N
  status      查看队列、运行头、结算状态
  demo        从零跑完整演示（多进程）
  web         启动网页控制台
  reset       删除数据库文件与批次数据
`);
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const cmd = argv._[0];
  const timezone = argv.timezone || DEFAULT_TIMEZONE;

  switch (cmd) {
    case 'init': {
      const db = initDatabase({ timezone, reset: Boolean(argv.reset) });
      log(`数据库已初始化：${db.prepare('PRAGMA database_list').get().file}`);
      log(`事件时区：${timezone}`);
      closeDb();
      return;
    }
    case 'seed': {
      const from = argv.from;
      const to = argv.to;
      if (!from || !to) throw new Error('seed 需要 --from 与 --to（YYYY-MM-DD）');
      const { db, dataset, ruleVersions } = seedDataset({
        from,
        to,
        timezone,
        sessionsPerDay: Number(argv.sessions || 48),
        seed: Number(argv.seed || 20261117),
        log,
      });
      log(`批次目录：${DATA_DIR}`);
      log(`场景统计：${JSON.stringify(dataset.fixtures.scenarioCounts)}`);
      closeDb();
      return;
    }
    case 'ingest': {
      const db = openDb();
      const result = ingestAll({ dir: argv.dir ? String(argv.dir) : DATA_DIR, reset: Boolean(argv.reset), log });
      log(`接入完成：${result.files} 个文件，新增 ${result.inserted} 条`);
      closeDb();
      return;
    }
    case 'worker': {
      const db = openDb();
      if (argv.reclaim) {
        const { reclaimStaleJobs } = await import('../src/lib/store.mjs');
        const rows = reclaimStaleJobs(db, LANES[argv.lane] || LANES.all);
        if (rows.length) log(`回收 ${rows.length} 个过期任务`);
      }
      await runWorker({
        db,
        lane: argv.lane || 'all',
        once: Boolean(argv.once),
        idleExitMs: Number(argv['idle-exit-ms'] || 20_000),
        log,
      });
      closeDb();
      return;
    }
    case 'enqueue': {
      const kind = argv._[1];
      if (!['evaluate', 'compare', 'correction', 'settle'].includes(kind)) {
        throw new Error('enqueue 需要任务类型：evaluate | compare | correction | settle');
      }
      const db = openDb();
      const from = argv.from || addDays(localDay(new Date(), timezone), -1);
      const to = argv.to || from;
      const params = {};
      if (argv.baseline) params.baselineRuleId = Number(argv.baseline);
      if (argv.candidate) params.candidateRuleId = Number(argv.candidate);
      if (argv.includeSuspect) params.includeSuspect = true;
      if (argv.note) params.note = String(argv.note);
      const ruleVersionId = argv.rule ? Number(argv.rule) : null;
      const job = enqueueJob(db, {
        kind,
        ruleVersionId,
        scopeFrom: from,
        scopeTo: to,
        priority: Number(argv.priority || 100),
        processDelayMs: Number(argv.delay || 0),
        params,
        actor: argv.actor || 'cli',
      });
      log(`已投递 ${kind} 任务 ${job.id}（序号 ${job.sequence}）范围 ${from}..${to}`);
      closeDb();
      return;
    }
    case 'settle': {
      // Convenience wrapper: drains settle jobs through the same analysis path
      // the separate process uses, so a CLI run cannot diverge from worker
      // behaviour (draft settlement guarded by the head run).
      const db = openDb();
      const from = argv.day ? String(argv.day) : argv.from || addDays(localDay(new Date(), timezone), -1);
      const to = argv.day ? String(argv.day) : argv.to || from;
      await enqueueJob(db, { kind: 'settle', scopeFrom: from, scopeTo: to, params: argv.includeSuspect ? { includeSuspect: true } : {}, actor: argv.actor || 'cli' });
      closeDb();
      await runWorker({ db: openDb(), lane: 'analysis', once: false, idleExitMs: 400, log });
      closeDb();
      return;
    }
    case 'seal': {
      const db = openDb();
      const days = argv.day ? [String(argv.day)] : [];
      if (!days.length) throw new Error('seal 需要 --day');
      for (const day of days) {
        const row = sealSettlement(db, day, { actor: argv.actor || 'cli' });
        log(`${day} 已封存：结算 #${row.id}，金额 ${(row.settled_amount_cents / 100).toFixed(2)} 元`);
      }
      closeDb();
      return;
    }
    case 'evidence': {
      const db = openDb();
      const kind = argv.kind;
      if (!kind) throw new Error('evidence 需要 --kind');
      const row = addEvidence(db, {
        kind,
        key: String(argv.key || ''),
        value: argv.value || null,
        label: String(argv.label || kind),
        effectiveFrom: String(argv.from || new Date().toISOString()),
        effectiveTo: argv.to || null,
        source: String(argv.source || 'cli'),
        note: argv.note || null,
        actor: argv.actor || 'cli',
      });
      log(`证据 #${row.id} 已写入：${kind} ${row.key}`);
      closeDb();
      return;
    }
    case 'rules': {
      const db = openDb();
      const sub = argv._[1];
      if (sub === 'list' || !sub) {
        for (const r of listRuleVersions(db)) log(`#${r.id} [${r.status}] ${r.label} — ${r.digest.slice(0, 10)}`);
      } else if (sub === 'publish') {
        const row = publishRuleVersion(db, Number(argv.id), argv.actor || 'cli');
        log(`#${row.id} 已发布`);
      } else if (sub === 'retire') {
        const row = retireRuleVersion(db, Number(argv.id), argv.actor || 'cli');
        log(`#${row.id} 已退役`);
      } else if (sub === 'show') {
        log(JSON.stringify(getRuleVersion(db, Number(argv.id)), null, 2));
      } else {
        throw new Error(`未知 rules 子命令 ${sub}`);
      }
      closeDb();
      return;
    }
    case 'status': {
      const db = openDb();
      const jobs = listJobs(db, { limit: 12 });
      log('最近任务：');
      for (const j of jobs) log(`  ${j.id} ${j.kind.padEnd(10)} ${j.status.padEnd(9)} seq=${j.sequence} ${j.scope_from}..${j.scope_to} ${j.rule_label || ''}`);
      const heads = db.prepare('SELECT * FROM run_heads ORDER BY local_day DESC LIMIT 12').all();
      log('当前运行头：');
      for (const h of heads) log(`  ${h.local_day} run#${h.run_id} seq=${h.sequence} rule#${h.rule_version_id}`);
      const st = db.prepare('SELECT * FROM settlements ORDER BY local_day DESC LIMIT 12').all();
      log('结算：');
      for (const s of st) log(`  ${s.local_day} #${s.id} ${s.status} ${(s.settled_amount_cents / 100).toFixed(2)} 元`);
      closeDb();
      return;
    }
    case 'report': {
      const db = openDb();
      const id = Number(argv.id);
      const r = getReport(db, id);
      log(JSON.stringify(r ? { ...r, summary: { totals: r.summary.totals, reasons: r.summary.reasons } } : null, null, 2));
      closeDb();
      return;
    }
    case 'demo': {
      const { runDemo } = await import('./demo.mjs');
      await runDemo({ timezone, reset: !argv.keep });
      return;
    }
    case 'web': {
      const { startServer } = await import('../web/server.mjs');
      await startServer({ port: Number(argv.port || 4317), timezone });
      return;
    }
    case 'reset': {
      const { clearDataset } = await import('../src/ingest/synthesize.mjs');
      const { resetDatabaseFile } = await import('../src/lib/db.mjs');
      resetDatabaseFile();
      clearDataset(DATA_DIR);
      log('已删除数据库与批次目录');
      return;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`错误：${err.message}`);
  if (process.env.EQS_DEBUG) console.error(err.stack);
  process.exit(1);
});
