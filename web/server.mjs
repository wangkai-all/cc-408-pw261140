import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/lib/db.mjs';
import { addDays, localDay, dayRange, assertTimeZone } from '../src/lib/time.mjs';
import {
  listRuleVersions,
  getRuleVersion,
  createRuleVersion,
  publishRuleVersion,
  retireRuleVersion,
  latestPublishedRule,
  listEvidence,
  addEvidence,
  EVIDENCE_KINDS,
  enqueueJob,
  listJobs,
  getJob,
  runsForDays,
  headRunForDay,
  getRun,
  runTotals,
  reasonBreakdown,
  settlementForDay,
  listSettlements,
  sealSettlement,
  createDraftSettlement,
  computeSettlement,
  sessionSummary,
  verdictCountsByType,
} from '../src/lib/store.mjs';
import { normalizeRules, validateRules, RULE_CATALOG, DEFAULT_RULES } from '../src/engine/rules.mjs';
import { getReport, listReports, approveReport, rejectReport } from '../src/engine/diff.mjs';
import { summary, reasonReport, eventDetail, sessionDetail, excludedEvents, auditTrail } from '../src/analysis/reports.mjs';
import { DEFAULT_TIMEZONE } from '../src/ingest/ingest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, 'public');
const ROOT = resolve(HERE, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function parseIntParam(value, name, { min = 0, max = 1_000_000, fallback = null } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} 参数无效`);
  return n;
}

function requireDay(value, name = 'day') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new HttpError(400, `${name} 必须是 YYYY-MM-DD`);
  return String(value);
}

function operator() {
  // Demo build: no auth. Every mutation is attributed to this label so the
  // audit trail is still meaningful.
  return process.env.EQS_OPERATOR || 'web:operator';
}

function api(handler) {
  return async (req, res, url) => {
    try {
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const result = await handler({ req, url, body, params: url.searchParams });
      if (result === undefined) return;
      // Only a numeric `status` means "HTTP status + body wrapper"; domain rows
      // carry their own string `status` (draft / succeeded) and must not be
      // mistaken for a status code.
      if (typeof result.status === 'number') return sendJson(res, result.status, result.body ?? result);
      return sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      // Domain validation errors thrown by the store are user-facing 400s; the
      // rest are unexpected and stay 500 (and are logged).
      const status = /不是|必须|不存在|无效|不能|缺失|请先|已|未知|晚于|早于|超出|不受支持|为空/.test(err.message) ? 400 : 500;
      if (status === 500) console.error(err);
      return sendJson(res, status, { error: err.message });
    }
  };
}

export function buildRoutes(db) {
  const routes = [];

  const on = (method, pattern, handler) => routes.push({ method, pattern, handler: api(handler) });

  on('GET', /^\/api\/meta$/, () => {
    const tz = db.prepare("SELECT value FROM meta WHERE key = 'event_timezone'").get()?.value || DEFAULT_TIMEZONE;
    const today = localDay(new Date(), tz);
    const latest = latestPublishedRule(db);
    return {
      timezone: tz,
      today,
      defaultFrom: addDays(today, -6),
      defaultTo: addDays(today, -1),
      latestRule: latest ? { id: latest.id, label: latest.label, status: latest.status } : null,
      operator: operator(),
      ruleCatalog: RULE_CATALOG,
      evidenceKinds: Object.entries(EVIDENCE_KINDS).map(([key, v]) => ({ key, ...v })),
      defaultRules: DEFAULT_RULES,
    };
  });

  on('GET', /^\/api\/summary$/, ({ params }) => {
    const from = requireDay(params.get('from'), 'from');
    const to = requireDay(params.get('to'), 'to');
    dayRange(from, to);
    return summary(db, { from, to });
  });

  on('GET', /^\/api\/rules$/, () => ({ versions: listRuleVersions(db), catalog: RULE_CATALOG }));

  on('POST', /^\/api\/rules$/, ({ body }) => {
    const incoming = body.rules || {};
    const rules = normalizeRules({ ...incoming, version_label: body.label || incoming.version_label });
    const label = String(body.label || rules.version_label).trim();
    if (!label) throw new HttpError(400, '规则版本必须有名称');
    const row = createRuleVersion(db, {
      rules,
      label,
      notes: body.notes || null,
      actor: operator(),
      status: 'draft',
    });
    return { status: 201, body: { id: row.id, label: row.label, status: row.status, digest: row.digest, reused: Boolean(row.reused) } };
  });

  on('POST', /^\/api\/rules\/(\d+)\/publish$/, ({ params: q, url }) => {
    const id = Number(url.pathname.split('/')[3]);
    return publishRuleVersion(db, id, operator());
  });

  on('POST', /^\/api\/rules\/(\d+)\/retire$/, ({ url }) => {
    const id = Number(url.pathname.split('/')[3]);
    return retireRuleVersion(db, id, operator());
  });

  on('POST', /^\/api\/rules\/validate$/, ({ body }) => {
    try {
      const rules = normalizeRules(body.rules || {});
      validateRules(rules);
      return { valid: true, rules };
    } catch (err) {
      return { valid: false, problems: err.problems || [err.message] };
    }
  });

  on('GET', /^\/api\/evidence$/, ({ params }) => ({
    rows: listEvidence(db, { activeAt: params.get('at') || null }),
    kinds: Object.entries(EVIDENCE_KINDS).map(([key, v]) => ({ key, ...v })),
  }));

  on('POST', /^\/api\/evidence$/, ({ body }) => {
    const row = addEvidence(db, {
      kind: body.kind,
      key: body.key,
      value: body.value ?? null,
      label: body.label,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo || null,
      source: body.source,
      note: body.note || null,
      actor: operator(),
    });
    return { status: 201, body: row };
  });

  on('GET', /^\/api\/jobs$/, ({ params }) => ({
    jobs: listJobs(db, { limit: parseIntParam(params.get('limit'), 'limit', { fallback: 40, max: 200 }) }),
  }));

  on('GET', /^\/api\/jobs\/([\w:-]+)$/, ({ url }) => {
    const id = url.pathname.split('/').pop();
    const job = getJob(db, id);
    if (!job) throw new HttpError(404, '任务不存在');
    return job;
  });

  on('POST', /^\/api\/jobs$/, ({ body }) => {
    const kind = body.kind;
    if (!['evaluate', 'compare', 'correction', 'settle'].includes(kind)) throw new HttpError(400, '任务类型无效');
    const from = requireDay(body.from, 'from');
    const to = requireDay(body.to, 'to');
    dayRange(from, to);
    const params = {};
    if (body.baselineRuleId) params.baselineRuleId = Number(body.baselineRuleId);
    if (body.candidateRuleId) params.candidateRuleId = Number(body.candidateRuleId);
    if (body.includeSuspect) params.includeSuspect = true;
    if (body.note) params.note = String(body.note);
    const job = enqueueJob(db, {
      kind,
      ruleVersionId: body.ruleVersionId ? Number(body.ruleVersionId) : null,
      scopeFrom: from,
      scopeTo: to,
      priority: Number(body.priority || 100),
      processDelayMs: Number(body.processDelayMs || 0),
      params,
      actor: operator(),
    });
    return {
      status: 201,
      body: {
        id: job.id,
        sequence: job.sequence,
        kind: job.kind,
        hint:
          kind === 'settle'
            ? '已投递，由分析进程消费（npm run worker:analysis 或 npm run demo）'
            : '已投递，由判定进程消费（npm run worker:decisions）',
      },
    };
  });

  on('GET', /^\/api\/runs$/, ({ params }) => {
    const from = requireDay(params.get('from'), 'from');
    const to = requireDay(params.get('to'), 'to');
    return { runs: runsForDays(db, from, to) };
  });

  on('GET', /^\/api\/runs\/(\d+)$/, ({ url }) => {
    const id = Number(url.pathname.split('/')[3]);
    const run = getRun(db, id);
    if (!run) throw new HttpError(404, '运行不存在');
    return {
      run,
      totals: runTotals(db, id),
      reasons: reasonBreakdown(db, id),
      byType: verdictCountsByType(db, id),
      sessions: sessionSummary(db, id),
    };
  });

  on('GET', /^\/api\/runs\/(\d+)\/report$/, ({ url }) => {
    const id = Number(url.pathname.split('/')[3]);
    return reasonReport(db, id);
  });

  on('GET', /^\/api\/runs\/(\d+)\/excluded$/, ({ url, params }) => {
    const id = Number(url.pathname.split('/')[3]);
    return excludedEvents(db, {
      runId: id,
      ruleId: params.get('rule') || null,
      verdict: params.get('verdict') || null,
      onlyExcluded: params.get('only') === 'excluded',
      day: params.get('day') || null,
      limit: parseIntParam(params.get('limit'), 'limit', { fallback: 60, max: 500 }),
      offset: parseIntParam(params.get('offset'), 'offset', { fallback: 0 }),
    });
  });

  on('GET', /^\/api\/events\/([\w:-]+)$/, ({ url, params }) =>
    eventDetail(db, {
      eventId: url.pathname.split('/').pop(),
      runId: parseIntParam(params.get('run'), 'run', { fallback: null, max: 1e9 }),
    }),
  );

  on('GET', /^\/api\/sessions\/([\w:-]+)$/, ({ url, params }) => {
    const sessionId = url.pathname.split('/').pop();
    const runId = parseIntParam(params.get('run'), 'run', { min: 1, max: 1e9 });
    if (!runId) throw new HttpError(400, '需要 run 参数');
    const detail = sessionDetail(db, { sessionId, runId });
    if (!detail) throw new HttpError(404, '会话不存在');
    return detail;
  });

  on('GET', /^\/api\/settlements$/, ({ params }) => {
    const from = requireDay(params.get('from'), 'from');
    const to = requireDay(params.get('to'), 'to');
    dayRange(from, to);
    return { rows: listSettlements(db, from, to), days: dayRange(from, to).map((d) => settlementForDay(db, d)), day: dayRange(from, to).map((d) => ({ day: d, ...settlementForDay(db, d) })) };
  });

  on('GET', /^\/api\/settlements\/(\d{4}-\d{2}-\d{2})$/, ({ url }) => {
    const day = requireDay(url.pathname.split('/').pop());
    return { day, ...settlementForDay(db, day) };
  });

  on('POST', /^\/api\/settlements\/seal$/, ({ body }) => {
    const day = requireDay(body.day);
    const row = sealSettlement(db, day, { actor: operator() });
    return { status: 201, body: row };
  });

  on('POST', /^\/api\/settlements\/draft$/, ({ body }) => {
    const day = requireDay(body.day);
    const run = headRunForDay(db, day);
    if (!run) throw new HttpError(400, `${day} 没有已提交的运行，无法生成结算`);
    const totals = computeSettlement(db, { day, run, includeSuspect: Boolean(body.includeSuspect) });
    const row = createDraftSettlement(db, totals, { actor: operator() });
    return { status: 201, body: row };
  });

  on('GET', /^\/api\/reports$/, ({ params }) => ({
    reports: listReports(db, { status: params.get('status') || null, limit: 40 }),
  }));

  on('GET', /^\/api\/reports\/(\d+)$/, ({ url }) => {
    const id = Number(url.pathname.split('/')[3]);
    const report = getReport(db, id);
    if (!report) throw new HttpError(404, '报告不存在');
    const events = db
      .prepare(
        `SELECT de.*, r.verdict AS current_verdict, r.primary_detail AS current_detail
         FROM diff_events de LEFT JOIN decisions r ON r.event_id = de.event_id AND r.run_id = (
           SELECT run_id FROM run_heads WHERE local_day = de.local_day AND stream = 'production')
         WHERE de.report_id = ? ORDER BY ABS(de.delta_amount_cents) DESC, de.event_id LIMIT 300`,
      )
      .all(id);
    return { ...report, events };
  });

  on('GET', /^\/api\/reports\/(\d+)\/events$/, ({ url, params }) => {
    const id = Number(url.pathname.split('/')[3]);
    const day = params.get('day');
    const limit = parseIntParam(params.get('limit'), 'limit', { fallback: 100, max: 500 });
    const offset = parseIntParam(params.get('offset'), 'offset', { fallback: 0 });
    const where = ['report_id = ?'];
    const args = [id];
    if (day) {
      where.push('local_day = ?');
      args.push(requireDay(day));
    }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM diff_events WHERE ${where.join(' AND ')}`).get(...args).n;
    const rows = db
      .prepare(`SELECT * FROM diff_events WHERE ${where.join(' AND ')} ORDER BY ABS(delta_amount_cents) DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
    return { total, rows };
  });

  on('POST', /^\/api\/reports\/(\d+)\/approve$/, ({ url, body }) => {
    const id = Number(url.pathname.split('/')[3]);
    return approveReport(db, id, { actor: operator(), note: body.note || null, applyAdjustments: body.applyAdjustments !== false });
  });

  on('POST', /^\/api\/reports\/(\d+)\/reject$/, ({ url, body }) => {
    const id = Number(url.pathname.split('/')[3]);
    return rejectReport(db, id, { actor: operator(), note: body.note || null });
  });

  on('GET', /^\/api\/audit$/, ({ params }) => ({
    rows: auditTrail(db, { limit: parseIntParam(params.get('limit'), 'limit', { fallback: 60, max: 300 }) }),
  }));

  return routes;
}

function serveStatic(res, urlPath) {
  let path = decodeURIComponent(urlPath);
  if (path === '/' || path === '') path = '/index.html';
  const full = normalize(join(WEB_ROOT, path));
  if (!full.startsWith(WEB_ROOT)) return false;
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  const ext = extname(full);
  const body = readFileSync(full);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
  return true;
}

export function createAppServer({ timezone = DEFAULT_TIMEZONE, db: existingDb = null } = {}) {
  const db = existingDb || openDb();
  const tz = db.prepare("SELECT value FROM meta WHERE key = 'event_timezone'").get()?.value || timezone;
  assertTimeZone(tz);
  const routes = buildRoutes(db);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (serveStatic(res, url.pathname)) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('未找到资源');
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      sendJson(res, 405, { error: '方法不允许' });
      return;
    }
    for (const route of routes) {
      if (route.method !== req.method) continue;
      if (!route.pattern.test(url.pathname)) continue;
      return route.handler(req, res, url);
    }
    sendJson(res, 404, { error: '接口不存在' });
  });
  return { server, db, timezone: tz };
}

export async function startServer({ port = 4317, host = '127.0.0.1', timezone = DEFAULT_TIMEZONE } = {}) {
  const { server, timezone: tz } = createAppServer({ timezone });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolvePromise);
  });
  const address = server.address();
  console.log(`网页控制台: http://${host}:${address.port}`);
  console.log(`事件时区: ${tz}`);
  console.log('按 Ctrl+C 停止');
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}
