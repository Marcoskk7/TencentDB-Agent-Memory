-- Asset evidence MVP schema (SQLite/PostgreSQL compatible with minor type edits).
-- The runtime EvidenceStore may use another backend; this migration documents the
-- durable schema and the constraints required by the evidence contract.

CREATE TABLE IF NOT EXISTS evidence_task_runs (
  run_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  task_goal TEXT NOT NULL,
  repo TEXT,
  branch TEXT,
  base_commit TEXT,
  head_commit TEXT,
  variant TEXT,
  evaluation_group_id TEXT,
  parent_run_id TEXT,
  run_kind TEXT,
  model_fingerprint TEXT,
  environment_fingerprint TEXT,
  prompt_config_digest TEXT,
  status TEXT NOT NULL,
  close_reason TEXT,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  receipt_revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS evidence_asset_accesses (
  access_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evidence_task_runs(run_id),
  asset_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  source_ref TEXT,
  mode TEXT NOT NULL,
  reader_team_id TEXT NOT NULL,
  reader_agent_id TEXT NOT NULL,
  reader_user_id TEXT NOT NULL,
  adapter TEXT,
  read_at TEXT,
  selection_score REAL,
  selection_reason TEXT,
  token_estimate INTEGER,
  compatibility_risk TEXT,
  applicability TEXT,
  name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evidence_task_runs(run_id),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE(run_id, sequence),
  UNIQUE(run_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_evidence_events_run_seq
  ON evidence_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_evidence_access_run
  ON evidence_asset_accesses(run_id, created_at);

-- The remaining records are intentionally normalized so references can be
-- checked against the same TaskRun before a claim/review/validation is stored.
CREATE TABLE IF NOT EXISTS evidence_claims (
  claim_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evidence_task_runs(run_id),
  access_id TEXT NOT NULL REFERENCES evidence_asset_accesses(access_id),
  declared_usage TEXT NOT NULL,
  purpose TEXT NOT NULL,
  decision_refs_json TEXT,
  behavior_refs_json TEXT,
  diff_refs_json TEXT,
  validation_refs_json TEXT,
  files_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_behaviors (
  behavior_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evidence_task_runs(run_id),
  tool_name TEXT NOT NULL,
  target_files_json TEXT,
  command_summary TEXT,
  result_summary TEXT,
  digest TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_diffs (
  diff_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evidence_task_runs(run_id),
  base_commit TEXT,
  head_commit TEXT,
  files_json TEXT NOT NULL,
  additions INTEGER,
  deletions INTEGER,
  diff_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_validations (
  validation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evidence_task_runs(run_id),
  command TEXT NOT NULL,
  exit_code INTEGER,
  passed INTEGER NOT NULL,
  validation_type TEXT NOT NULL,
  claim_refs_json TEXT,
  behavior_refs_json TEXT,
  diff_refs_json TEXT,
  verifier TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_reviews (
  review_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evidence_task_runs(run_id),
  access_id TEXT NOT NULL REFERENCES evidence_asset_accesses(access_id),
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  behavior_refs_json TEXT,
  diff_refs_json TEXT,
  decision_refs_json TEXT,
  reviewer_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evidence_task_runs(run_id),
  control_run_id TEXT REFERENCES evidence_task_runs(run_id),
  baseline_commit TEXT,
  environment_fingerprint TEXT,
  passed INTEGER,
  gain REAL,
  contamination INTEGER,
  independent_causal_evidence INTEGER,
  metrics_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_candidate_assets (
  candidate_id TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL REFERENCES evidence_task_runs(run_id),
  source_diff_ids_json TEXT NOT NULL,
  source_validation_ids_json TEXT NOT NULL,
  proposed_kind TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL,
  review_required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL
);
