PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Append-only raw events. Evidence can change quality decisions, never the raw facts.
CREATE TABLE IF NOT EXISTS raw_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'click', 'conversion')),
  session_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  ingest_seq INTEGER NOT NULL,
  local_day TEXT NOT NULL,
  site_id TEXT NOT NULL,
  placement_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  country TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  referrer TEXT,
  navigation_type TEXT,
  viewable INTEGER,
  impression_id TEXT,
  click_id TEXT,
  click_delay_ms INTEGER,
  order_id TEXT,
  revenue_cents INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_raw_events_day ON raw_events (local_day, received_at);
CREATE INDEX IF NOT EXISTS ix_raw_events_session ON raw_events (session_id, occurred_at, ingest_seq);
CREATE INDEX IF NOT EXISTS ix_raw_events_impression ON raw_events (impression_id);
CREATE INDEX IF NOT EXISTS ix_raw_events_click ON raw_events (click_id);
CREATE INDEX IF NOT EXISTS ix_raw_events_order ON raw_events (order_id);

CREATE TRIGGER IF NOT EXISTS raw_events_no_update
BEFORE UPDATE ON raw_events
BEGIN
  SELECT RAISE(ABORT, 'raw_events 为追加事实，不可修改');
END;

CREATE TRIGGER IF NOT EXISTS raw_events_no_delete
BEFORE DELETE ON raw_events
BEGIN
  SELECT RAISE(ABORT, 'raw_events 为追加事实，不可删除');
END;

CREATE TABLE IF NOT EXISTS ingest_files (
  id INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  inserted_count INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL,
  first_received_at TEXT,
  last_received_at TEXT,
  days TEXT NOT NULL,
  received_after_occurrence_seconds INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ingested', 'failed')),
  error TEXT,
  ingested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_versions (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  rules_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  published_at TEXT,
  retired_at TEXT
);

CREATE TRIGGER IF NOT EXISTS rule_versions_freeze
BEFORE UPDATE OF rules_json ON rule_versions
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, '已发布的规则版本不可修改，请创建草稿');
END;

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ua_token', 'ip_prefix', 'device_flag', 'order_reversal', 'policy_note')),
  key TEXT NOT NULL,
  value TEXT,
  label TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_evidence_kind_key_start
  ON evidence (kind, key, effective_from);

CREATE TRIGGER IF NOT EXISTS evidence_no_update
BEFORE UPDATE ON evidence
BEGIN
  SELECT RAISE(ABORT, '证据为追加记录，不可修改；请追加新证据');
END;

CREATE TRIGGER IF NOT EXISTS evidence_no_delete
BEFORE DELETE ON evidence
BEGIN
  SELECT RAISE(ABORT, '证据为追加记录，不可删除');
END;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('evaluate', 'compare', 'correction', 'settle')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'superseded', 'canceled')),
  stream TEXT NOT NULL,
  rule_version_id INTEGER REFERENCES rule_versions (id),
  scope_from TEXT NOT NULL,
  scope_to TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  sequence INTEGER NOT NULL,
  fence INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claimed_at TEXT,
  lease_until TEXT,
  started_at TEXT,
  finished_at TEXT,
  process_delay_ms INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  params_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_jobs_claim ON jobs (status, priority DESC, sequence);
CREATE INDEX IF NOT EXISTS ix_jobs_created ON jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  detail_json TEXT
);

CREATE TRIGGER IF NOT EXISTS job_events_no_update
BEFORE UPDATE ON job_events
BEGIN
  SELECT RAISE(ABORT, '任务日志不可修改');
END;

CREATE TABLE IF NOT EXISTS decision_runs (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL,
  run_key TEXT NOT NULL,
  rule_version_id INTEGER NOT NULL REFERENCES rule_versions (id),
  stream TEXT NOT NULL,
  scope_from TEXT NOT NULL,
  scope_to TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  as_of TEXT NOT NULL,
  ingest_watermark INTEGER NOT NULL DEFAULT 0,
  evidence_watermark INTEGER NOT NULL DEFAULT 0,
  attribution TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'committed', 'superseded', 'failed')),
  event_count INTEGER NOT NULL DEFAULT 0,
  cross_day_count INTEGER NOT NULL DEFAULT 0,
  digest TEXT,
  started_at TEXT NOT NULL,
  committed_at TEXT,
  note TEXT
);

CREATE INDEX IF NOT EXISTS ix_runs_scope ON decision_runs (stream, scope_from, scope_to, sequence);
CREATE INDEX IF NOT EXISTS ix_runs_job ON decision_runs (job_id, run_key);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES decision_runs (id),
  event_id TEXT NOT NULL REFERENCES raw_events (event_id),
  rule_version_id INTEGER NOT NULL,
  stream TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('valid', 'invalid', 'suspect')),
  primary_reason TEXT,
  primary_detail TEXT,
  invalid_reasons_json TEXT NOT NULL DEFAULT '[]',
  suspect_reasons_json TEXT NOT NULL DEFAULT '[]',
  local_day TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_start_day TEXT NOT NULL,
  session_days_json TEXT NOT NULL,
  session_cross_day INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  revenue_cents INTEGER NOT NULL DEFAULT 0,
  decided_at TEXT NOT NULL,
  UNIQUE (run_id, event_id)
);

CREATE INDEX IF NOT EXISTS ix_decisions_run ON decisions (run_id, verdict);
CREATE INDEX IF NOT EXISTS ix_decisions_event ON decisions (event_id, run_id);
CREATE INDEX IF NOT EXISTS ix_decisions_day ON decisions (local_day, run_id);

CREATE TABLE IF NOT EXISTS decision_contributions (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL REFERENCES decisions (id),
  check_order INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  rule_label TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('event', 'session', 'evidence')),
  severity TEXT NOT NULL CHECK (severity IN ('hard', 'soft', 'info')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'skip', 'note')),
  observed TEXT,
  comparator TEXT,
  threshold TEXT,
  detail TEXT,
  evidence_ref TEXT
);

CREATE INDEX IF NOT EXISTS ix_contrib_decision ON decision_contributions (decision_id);
CREATE INDEX IF NOT EXISTS ix_contrib_rule ON decision_contributions (rule_id, outcome);

CREATE TRIGGER IF NOT EXISTS decisions_no_update
BEFORE UPDATE ON decisions
BEGIN
  SELECT RAISE(ABORT, '判定为追加历史，不可修改');
END;

CREATE TRIGGER IF NOT EXISTS decisions_no_delete
BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, '判定为追加历史，不可删除');
END;

CREATE TRIGGER IF NOT EXISTS contributions_no_update
BEFORE UPDATE ON decision_contributions
BEGIN
  SELECT RAISE(ABORT, '判定贡献不可修改');
END;

CREATE TRIGGER IF NOT EXISTS contributions_no_delete
BEFORE DELETE ON decision_contributions
BEGIN
  SELECT RAISE(ABORT, '判定贡献不可删除');
END;

-- Latest committed production run per day. The guard is by job sequence, never by finish time.
CREATE TABLE IF NOT EXISTS run_heads (
  stream TEXT NOT NULL,
  local_day TEXT NOT NULL,
  run_id INTEGER NOT NULL REFERENCES decision_runs (id),
  sequence INTEGER NOT NULL,
  rule_version_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (stream, local_day)
);

CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY,
  local_day TEXT NOT NULL,
  rule_version_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'sealed')),
  basis_run_id INTEGER NOT NULL REFERENCES decision_runs (id),
  basis_sequence INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  valid_count INTEGER NOT NULL,
  invalid_count INTEGER NOT NULL,
  suspect_count INTEGER NOT NULL,
  gross_amount_cents INTEGER NOT NULL,
  settled_amount_cents INTEGER NOT NULL,
  excluded_amount_cents INTEGER NOT NULL,
  digest TEXT NOT NULL,
  sealed_at TEXT,
  sealed_by TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_settlements_sealed_day
  ON settlements (local_day) WHERE status = 'sealed';

CREATE UNIQUE INDEX IF NOT EXISTS ux_settlements_draft_day
  ON settlements (local_day) WHERE status = 'draft';

CREATE TRIGGER IF NOT EXISTS settlements_sealed_no_update
BEFORE UPDATE ON settlements
WHEN OLD.status = 'sealed'
BEGIN
  SELECT RAISE(ABORT, '已封存结算不可改写；请追加更正分录');
END;

CREATE TRIGGER IF NOT EXISTS settlements_sealed_no_delete
BEFORE DELETE ON settlements
WHEN OLD.status = 'sealed'
BEGIN
  SELECT RAISE(ABORT, '已封存结算不可删除');
END;

CREATE TABLE IF NOT EXISTS settlement_adjustments (
  id INTEGER PRIMARY KEY,
  settlement_id INTEGER NOT NULL REFERENCES settlements (id),
  report_id INTEGER NOT NULL,
  local_day TEXT NOT NULL,
  delta_event_count INTEGER NOT NULL,
  delta_valid_count INTEGER NOT NULL,
  delta_invalid_count INTEGER NOT NULL,
  delta_suspect_count INTEGER NOT NULL,
  delta_amount_cents INTEGER NOT NULL,
  basis_run_id INTEGER NOT NULL REFERENCES decision_runs (id),
  reason TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  applied_by TEXT NOT NULL,
  digest TEXT NOT NULL,
  UNIQUE (report_id, settlement_id)
);

CREATE TRIGGER IF NOT EXISTS adjustments_no_update
BEFORE UPDATE ON settlement_adjustments
BEGIN
  SELECT RAISE(ABORT, '结算更正分录不可修改');
END;

CREATE TRIGGER IF NOT EXISTS adjustments_no_delete
BEFORE DELETE ON settlement_adjustments
BEGIN
  SELECT RAISE(ABORT, '结算更正分录不可删除');
END;

CREATE TABLE IF NOT EXISTS diff_reports (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rule_compare', 'correction')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected')),
  title TEXT NOT NULL,
  baseline_rule_version_id INTEGER NOT NULL,
  candidate_rule_version_id INTEGER NOT NULL,
  baseline_run_ids_json TEXT NOT NULL,
  candidate_run_ids_json TEXT NOT NULL,
  scope_from TEXT NOT NULL,
  scope_to TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  job_id TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_note TEXT
);

CREATE INDEX IF NOT EXISTS ix_reports_status ON diff_reports (status, created_at DESC);

CREATE TRIGGER IF NOT EXISTS reports_final_no_update
BEFORE UPDATE ON diff_reports
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, '差异报告已定稿，不可修改');
END;

CREATE TABLE IF NOT EXISTS diff_days (
  report_id INTEGER NOT NULL REFERENCES diff_reports (id),
  local_day TEXT NOT NULL,
  baseline_run_id INTEGER,
  candidate_run_id INTEGER,
  old_valid INTEGER NOT NULL,
  old_invalid INTEGER NOT NULL,
  old_suspect INTEGER NOT NULL,
  new_valid INTEGER NOT NULL,
  new_invalid INTEGER NOT NULL,
  new_suspect INTEGER NOT NULL,
  old_amount_cents INTEGER NOT NULL,
  new_amount_cents INTEGER NOT NULL,
  changed_events INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0,
  adjustment_applied INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, local_day)
);

CREATE TABLE IF NOT EXISTS diff_reasons (
  report_id INTEGER NOT NULL REFERENCES diff_reports (id),
  direction TEXT NOT NULL CHECK (direction IN ('became_invalid', 'became_valid', 'became_suspect', 'became_other', 'reason_changed')),
  rule_id TEXT NOT NULL,
  rule_label TEXT NOT NULL,
  events INTEGER NOT NULL,
  delta_amount_cents INTEGER NOT NULL,
  PRIMARY KEY (report_id, direction, rule_id)
);

CREATE TABLE IF NOT EXISTS diff_events (
  report_id INTEGER NOT NULL REFERENCES diff_reports (id),
  event_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  old_verdict TEXT NOT NULL,
  new_verdict TEXT NOT NULL,
  old_reason TEXT,
  new_reason TEXT,
  delta_amount_cents INTEGER NOT NULL,
  PRIMARY KEY (report_id, event_id)
);

CREATE INDEX IF NOT EXISTS ix_diff_events_report ON diff_events (report_id, local_day);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail_json TEXT
);

CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log (at DESC);

CREATE TRIGGER IF NOT EXISTS audit_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, '审计日志不可修改');
END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, '审计日志不可删除');
END;
