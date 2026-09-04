import { randomUUID } from "node:crypto";

export type AssetType = "skill" | "llm_wiki" | "code_graph" | "chat_memory";
export type RunVariant = "with_assets" | "without_assets" | "oracle";
export type RunKind = "main" | "fork" | "subagent" | "retry" | "control" | "oracle";
export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "abandoned";
export type AccessMode = "search" | "read" | "inject";
export type DeclaredUsage = "used" | "not_used" | "uncertain";
export type ReviewDecision = "support" | "not_support" | "uncertain";

export interface TaskRun {
  run_id: string; team_id: string; task_id?: string; agent_id: string; user_id: string;
  agent_source: string; session_id: string; request_id: string; execution_id: string;
  task_goal: string; repo?: string; branch?: string; base_commit?: string; head_commit?: string;
  variant?: RunVariant; evaluation_group_id?: string; parent_run_id?: string; run_kind?: RunKind;
  model_fingerprint?: string; environment_fingerprint?: string;
  status: RunStatus; close_reason?: string; last_heartbeat_at?: string; created_at: string;
  closed_at?: string; receipt_revision?: number;
}

export type CreateTaskRunInput = Omit<TaskRun, "run_id" | "status" | "created_at" | "closed_at" | "receipt_revision"> & { status?: RunStatus; idempotency_key?: string };

export interface AssetAccess {
  access_id: string; run_id: string; asset_id: string; asset_type: AssetType; version: number;
  source_ref?: string; mode: AccessMode; reader_team_id: string;
  reader_agent_id: string; reader_user_id: string; adapter?: string; read_at?: string;
  selection_score?: number; selection_reason?: string; token_estimate?: number;
  compatibility_risk?: string; applicability?: string; name?: string; idempotency_key?: string; created_at: string;
}

export interface AgentUsageClaim {
  claim_id: string; run_id: string; access_id: string; declared_usage: DeclaredUsage; purpose: string;
  decision_refs?: string[]; behavior_refs?: string[]; diff_refs?: string[]; validation_refs?: string[];
  files?: string[]; reason?: string; idempotency_key?: string; created_at: string;
}

export type EvidenceEventType = "task_run_started" | "asset_recalled" | "asset_selected" | "asset_injected" | "asset_read" | "intent_declared" | "agent_declared" | "behavior_observed" | "diff_recorded" | "diff_unavailable" | "validation_recorded" | "review_recorded" | "correction_recorded" | "evaluation_recorded" | "candidate_generated" | "candidate_reviewed" | "task_close_prompted" | "task_close_decision" | "task_run_closed";
export interface EvidenceEvent { event_id: string; run_id: string; sequence: number; type: EvidenceEventType; data: Record<string, unknown>; schema_version: number; actor?: { type: "proxy" | "agent" | "user" | "system"; id?: string }; occurred_at: string; received_at: string; idempotency_key: string; }

export interface Behavior { behavior_id: string; run_id: string; tool_name: string; target_files?: string[]; command_summary?: string; result_summary?: string; external_tool_use_id?: string; phase?: "intent" | "execution"; parent_behavior_id?: string; idempotency_key?: string; created_at: string; }
export interface CodeDiff { diff_id: string; run_id: string; base_commit?: string; head_commit?: string; files: string[]; additions?: number; deletions?: number; idempotency_key?: string; created_at: string; }
export interface Validation { validation_id: string; run_id: string; command: string; exit_code?: number; passed: boolean; validation_type: string; claim_refs?: string[]; behavior_refs?: string[]; diff_refs?: string[]; verifier?: string; idempotency_key?: string; created_at: string; }
export interface Review { review_id: string; run_id: string; access_id: string; decision: ReviewDecision; reason: string; behavior_refs?: string[]; diff_refs?: string[]; decision_refs?: string[]; reviewer_user_id: string; created_at: string; }
export interface Evaluation { evaluation_id: string; run_id: string; control_run_id?: string; baseline_commit?: string; environment_fingerprint?: string; passed?: boolean; gain?: number; contamination?: boolean; independent_causal_evidence?: boolean; metrics?: Record<string, number>; created_at: string; }
export interface CandidateAsset { candidate_id: string; source_run_id: string; source_diff_ids: string[]; source_validation_ids: string[]; proposed_kind: string; content: string; confidence: number; review_required: true; status: "candidate" | "rejected" | "approved"; created_at: string; }

export interface EvidenceState { recalled: boolean; selected: boolean; injected: boolean; declared_used: boolean; used: boolean; validation_passed: boolean; contributed: boolean; not_used: boolean; rejected: boolean; corrected: boolean; }
export interface DerivedAssetEvidence { access_id: string; asset_id: string; asset_type: AssetType; name?: string; version: number; source_ref?: string; applicability?: string; evidence: EvidenceState; decision_refs: string[]; file_refs: string[]; validation_refs: string[]; risks: string[]; evidence_gaps: string[]; }
export interface AssetEvidenceReceipt { run_id: string; revision: number; summary: { recalled: number; selected: number; injected: number; used: number; validation_passed: number; contributed: number }; assets: DerivedAssetEvidence[]; metrics: { tokens?: number; latency_ms?: number; tool_calls?: number; error_attempts?: number }; contribution_evidence: "insufficient" | "suggestive" | "causal"; generated_at: string; }

export interface EvidenceSnapshot { run: TaskRun; accesses: AssetAccess[]; claims: AgentUsageClaim[]; events: EvidenceEvent[]; behaviors: Behavior[]; diffs: CodeDiff[]; validations: Validation[]; reviews: Review[]; evaluations: Evaluation[]; candidates: CandidateAsset[]; receipt?: AssetEvidenceReceipt; }

export function id(prefix: string): string { return `${prefix}_${randomUUID()}`; }
export function isoNow(): string { return new Date().toISOString(); }
