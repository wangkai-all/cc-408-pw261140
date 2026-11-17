import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAppServer } from '../web/server.mjs';
import { enqueueJob, sealSettlement } from '../src/lib/store.mjs';
import { tempDb, ingestEvents, cleanSession, publishRules, processQueue } from './helpers.mjs';

const DAY = '2026-02-01';

async function http(server, path, { method = 'GET', body = null } = {}) {
  const address = server.address();
  const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* static asset */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function withServer(t, setup) {
  const { db, dir } = tempDb(t);
  await setup(db, dir);
  const { server } = createAppServer({ timezone: 'UTC', db });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
  return { db, server };
}

async function seedSettledDay(db, dir) {
  const { events } = cleanSession({ day: DAY });
  ingestEvents(db, dir, events);
  const rule = publishRules(db, { label: 'web-v1' });
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: rule.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['evaluate']);
  enqueueJob(db, { kind: 'settle', scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['settle']);
  return rule;
}

test('static shell and assets are served with the right content types', async (t) => {
  const { server } = await withServer(t, async () => {});
  const html = await http(server, '/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(html.text, /事件质量与结算控制台/);
  assert.match(html.text, /\/app\.js/);
  for (const asset of ['/app.css', '/app.js']) {
    const res = await http(server, asset);
    assert.equal(res.status, 200, `${asset} 必须存在`);
    assert.ok(res.text.length > 1000);
  }
  const missing = await http(server, '/nope.js');
  assert.equal(missing.status, 404);
});

test('meta and rules endpoints expose the version state the console edits', async (t) => {
  const { server } = await withServer(t, async (db2) => {
    publishRules(db2, { label: 'meta-v1' });
  });
  const meta = await http(server, '/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.json.timezone, 'UTC');
  assert.equal(meta.json.latestRule.label, 'meta-v1');
  assert.ok(meta.json.ruleCatalog.some((r) => r.id === 'duplicate_order'));

  const rules = await http(server, '/api/rules');
  assert.equal(rules.status, 200);
  assert.equal(rules.json.catalog.length, meta.json.ruleCatalog.length);
  assert.equal(rules.json.versions[0].status, 'published');
  assert.ok(rules.json.versions[0].rules.cross_day);
});

test('read models describe a committed run and a sealed settlement', async (t) => {
  const { db, server } = await withServer(t, seedSettledDay);
  const head = db.prepare("SELECT run_id FROM run_heads WHERE local_day = ?").get(DAY);
  sealSettlement(db, DAY, { actor: 'test' });

  const summary = await http(server, `/api/summary?from=${DAY}&to=${DAY}`);
  assert.equal(summary.status, 200);
  assert.equal(summary.json.days[0].totals.valid, 2);
  assert.equal(summary.json.settlements.sealedNet, 85);

  const run = await http(server, `/api/runs/${head.run_id}`);
  assert.equal(run.status, 200);
  assert.equal(run.json.totals.events, 2);
  assert.equal(run.json.totals.validAmount, 85);

  const excluded = await http(server, `/api/runs/${head.run_id}/excluded?only=excluded`);
  assert.equal(excluded.status, 200);
  assert.equal(excluded.json.total, 0, '全部有效时被排除列表为空');

  const settlement = await http(server, `/api/settlements/${DAY}`);
  assert.equal(settlement.status, 200);
  assert.equal(settlement.json.sealed.settled_amount_cents, 85);
  assert.equal(settlement.json.netSettled, 85);
});

test('the excluded list shows the concrete failing check for invalid events', async (t) => {
  const { db, dir } = tempDb(t);
  ingestEvents(db, dir, [
    {
      event_id: 'imp_dc',
      event_type: 'impression',
      session_id: 'ses_dc',
      occurred_at: `${DAY}T08:00:00.000Z`,
      received_at: `${DAY}T08:00:01.000Z`,
      site_id: 'site_demo',
      placement_id: 'pl_demo',
      device_id: 'dev_dc',
      ip: '203.0.113.7',
      country: 'CN',
      user_agent: 'Mozilla/5.0 (iPhone) Safari/604.1',
      impression_id: 'imp_dc',
      viewable: 1,
    },
  ]);
  const rule = publishRules(db, {
    label: 'dc-web',
    patch: { hard_checks: { datacenter_ip: { enabled: true, prefixes: ['203.0.113'] } } },
  });
  enqueueJob(db, { kind: 'evaluate', ruleVersionId: rule.id, scopeFrom: DAY, scopeTo: DAY, actor: 'test' });
  await processQueue(db, ['evaluate']);
  const head = db.prepare('SELECT run_id FROM run_heads WHERE local_day = ?').get(DAY);

  const { server } = createAppServer({ timezone: 'UTC', db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const res = await http(server, `/api/runs/${head.run_id}/excluded?only=excluded`);
  assert.equal(res.json.total, 1);
  const row = res.json.rows[0];
  assert.equal(row.event_id, 'imp_dc');
  assert.equal(row.verdict, 'invalid');
  assert.equal(row.failures.length, 1);
  assert.equal(row.failures[0].rule_id, 'datacenter_ip');
  assert.equal(row.failures[0].observed, '203.0.113');
  assert.equal(row.failures[0].threshold, '住宅/移动网络');
});

test('domain rows with a string status are returned as plain 200 bodies', async (t) => {
  const { db, server } = await withServer(t, seedSettledDay);
  const rules = await http(server, '/api/rules');
  assert.equal(rules.status, 200);
  assert.ok(rules.json.versions.length >= 1);
  assert.equal(rules.json.versions[0].status, 'published');

  const job = await http(server, '/api/jobs');
  assert.equal(job.status, 200);
  const detail = await http(server, `/api/jobs/${job.json.jobs[0].id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.status, 'succeeded');
  assert.ok(db);
});

test('rule creation validates, stores a draft and can be published', async (t) => {
  const { server } = await withServer(t, async () => {});
  const bad = await http(server, '/api/rules/validate', {
    method: 'POST',
    body: { rules: { lookback_days: 99 } },
  });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.valid, false);
  assert.ok(bad.json.problems.some((p) => /lookback_days/.test(p)));

  const created = await http(server, '/api/rules', {
    method: 'POST',
    body: { label: '网页草稿', rules: { version_label: '网页草稿' } },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, 'draft');
  const published = await http(server, `/api/rules/${created.json.id}/publish`, { method: 'POST' });
  assert.equal(published.status, 200);
  assert.equal(published.json.status, 'published');
});

test('evidence can be appended but never edited, and the console can list it', async (t) => {
  const { server } = await withServer(t, async () => {});
  const created = await http(server, '/api/evidence', {
    method: 'POST',
    body: {
      kind: 'device_flag',
      key: 'dev_x',
      label: '人工核查',
      effectiveFrom: `${DAY}T00:00:00.000Z`,
      source: 'web:test',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.kind, 'device_flag');
  const listed = await http(server, '/api/evidence');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.rows.length, 1);
  const invalid = await http(server, '/api/evidence', {
    method: 'POST',
    body: { kind: 'nope', key: 'x', label: 'x', effectiveFrom: `${DAY}T00:00:00.000Z`, source: 'web:test' },
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /未知证据类型/);
});

test('approving a report through the API posts adjustments and cannot be repeated', async (t) => {
  const { db, dir } = tempDb(t);
  const rule = await seedSettledDay(db, dir);
  sealSettlement(db, DAY, { actor: 'test' });
  const { addEvidence } = await import('../src/lib/store.mjs');
  addEvidence(db, {
    kind: 'device_flag',
    key: 'dev_clean_1',
    label: '点击农场设备',
    effectiveFrom: `${DAY}T00:00:00.000Z`,
    source: 'late:test',
  });
  enqueueJob(db, {
    kind: 'correction',
    ruleVersionId: rule.id,
    scopeFrom: DAY,
    scopeTo: DAY,
    params: { baselineRuleId: rule.id, candidateRuleId: rule.id },
    actor: 'test',
  });
  await processQueue(db, ['correction']);
  const report = db.prepare("SELECT * FROM diff_reports WHERE kind = 'correction'").get();

  const { server } = createAppServer({ timezone: 'UTC', db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const detail = await http(server, `/api/reports/${report.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.status, 'draft');
  assert.ok(detail.json.days[0].changed_events > 0);

  const approved = await http(server, `/api/reports/${report.id}/approve`, { method: 'POST', body: { note: '确认' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.applied.length, 1);
  const after = await http(server, `/api/settlements/${DAY}`);
  assert.equal(after.json.sealed.settled_amount_cents, 85);
  assert.equal(after.json.adjustmentTotal, -85);
  assert.equal(after.json.netSettled, 0);

  const again = await http(server, `/api/reports/${report.id}/approve`, { method: 'POST', body: {} });
  assert.equal(again.status, 400);
});

test('the same route id is parsed for every resource (no off-by-one)', async (t) => {
  const { db, server } = await withServer(t, seedSettledDay);
  const head = db.prepare('SELECT run_id FROM run_heads WHERE local_day = ?').get(DAY);
  const rule = db.prepare('SELECT id FROM rule_versions LIMIT 1').get();
  for (const path of [`/api/runs/${head.run_id}`, `/api/runs/${head.run_id}/report`, `/api/settlements/${DAY}`, `/api/rules/${rule.id}/publish`]) {
    const res = await http(server, path, { method: path.endsWith('publish') ? 'POST' : 'GET' });
    assert.notEqual(res.status, 404, `${path} 必须命中路由`);
    assert.ok(!(res.json && res.json.error === '接口不存在'));
  }
  const missing = await http(server, '/api/runs/999999');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /运行不存在/);
});

test('web assets referenced by the shell all exist on disk', async () => {
  const root = resolve(import.meta.dirname, '..', 'web', 'public');
  for (const file of ['index.html', 'app.css', 'app.js']) {
    assert.ok(existsSync(resolve(root, file)), `${file} 缺失`);
    assert.ok(readFileSync(resolve(root, file), 'utf8').length > 0);
  }
});
