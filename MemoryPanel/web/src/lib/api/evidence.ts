/** Browser client for the evidence Panel BFF (never calls `/v3/evidence` directly). */
import { getPanelSession } from '../panelSession';
import { ApiError, request } from './base';
import type { MetaEnvelope } from './types';

export type AssetType = 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory';
export type RunVariant = 'with_assets' | 'without_assets' | 'oracle';
export type RunKind = 'main' | 'fork' | 'subagent' | 'retry' | 'control' | 'oracle';
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'abandoned';
export type AccessMode = 'search' | 'read' | 'inject';
export type DeclaredUsage = 'used' | 'not_used' | 'uncertain';
export type ReviewDecision = 'support' | 'not_support' | 'uncertain';
export type CandidateDecision = 'approved' | 'rejected';

export interface TaskRun {
  run_id: string;
  team_id: string;
  task_id?: string;
  agent_id: string;
  user_id: string;
  task_goal: string;
  agent_source: string;
  session_id: string;
  request_id: string;
  execution_id: string;
  repo?: string;
  branch?: string;
  base_commit?: string;
  head_commit?: string;
  status: RunStatus;
  variant?: RunVariant;
  evaluation_group_id?: string;
  parent_run_id?: string;
  run_kind?: RunKind;
  model_fingerprint?: string;
  environment_fingerprint?: string;
  close_reason?: string;
  last_heartbeat_at?: string;
  created_at: string;
  closed_at?: string;
  receipt_revision?: number;
}

export interface AssetAccess {
  access_id: string;
  run_id: string;
  asset_id: string;
  asset_type: AssetType;
  version: number;
  source_ref?: string;
  mode: AccessMode;
  reader_team_id: string;
  reader_agent_id: string;
  reader_user_id: string;
  adapter?: string;
  read_at?: string;
  selection_score?: number;
  selection_reason?: string;
  token_estimate?: number;
  compatibility_risk?: string;
  applicability?: string;
  name?: string;
  created_at: string;
}

export interface AgentUsageClaim {
  claim_id: string;
  run_id: string;
  access_id: string;
  declared_usage: DeclaredUsage;
  purpose: string;
  decision_refs?: string[];
  behavior_refs?: string[];
  diff_refs?: string[];
  validation_refs?: string[];
  files?: string[];
  reason?: string;
  created_at: string;
}

export type EvidenceEventType = 'task_run_started' | 'asset_recalled' | 'asset_selected' | 'asset_injected' | 'asset_read' | 'intent_declared' | 'agent_declared' | 'behavior_observed' | 'diff_recorded' | 'validation_recorded' | 'review_recorded' | 'correction_recorded' | 'evaluation_recorded' | 'candidate_generated' | 'candidate_reviewed' | 'task_run_closed';
export interface EvidenceEvent { event_id: string; run_id: string; sequence: number; type: EvidenceEventType; data: Record<string, unknown>; schema_version: number; actor?: { type: 'proxy' | 'agent' | 'user' | 'system'; id?: string }; occurred_at: string; received_at: string; idempotency_key: string; }
export interface Behavior { behavior_id: string; run_id: string; tool_name: string; target_files?: string[]; command_summary?: string; result_summary?: string; created_at: string; }
export interface CodeDiff { diff_id: string; run_id: string; base_commit?: string; head_commit?: string; files: string[]; additions?: number; deletions?: number; created_at: string; }
export interface Validation { validation_id: string; run_id: string; command: string; exit_code?: number; passed: boolean; validation_type: string; claim_refs?: string[]; behavior_refs?: string[]; diff_refs?: string[]; verifier?: string; created_at: string; }

export interface EvidenceReview {
  review_id: string;
  run_id: string;
  access_id: string;
  decision: ReviewDecision;
  reason: string;
  behavior_refs?: string[];
  diff_refs?: string[];
  decision_refs?: string[];
  reviewer_user_id: string;
  created_at: string;
}

export interface CandidateAsset {
  candidate_id: string;
  source_run_id: string;
  source_diff_ids: string[];
  source_validation_ids: string[];
  proposed_kind: string;
  content: string;
  confidence: number;
  review_required: true;
  status: 'candidate' | 'rejected' | 'approved';
  created_at: string;
}

export interface AssetEvidenceReceipt {
  run_id: string;
  revision: number;
  summary: Record<string, number>;
  assets: Array<{
    access_id: string;
    asset_id: string;
    asset_type: AssetType;
    name?: string;
    version: number;
    source_ref?: string;
    applicability?: string;
    evidence: { recalled: boolean; selected: boolean; injected: boolean; declared_used: boolean; used: boolean; validation_passed: boolean; contributed: boolean; not_used: boolean; rejected: boolean; corrected: boolean };
    decision_refs: string[];
    file_refs: string[];
    validation_refs: string[];
    risks: string[];
    evidence_gaps: string[];
  }>;
  metrics: { tokens?: number; latency_ms?: number; tool_calls?: number; error_attempts?: number };
  contribution_evidence: 'insufficient' | 'suggestive' | 'causal';
  generated_at: string;
}

export interface Evaluation {
  evaluation_id: string;
  run_id: string;
  control_run_id?: string;
  baseline_commit?: string;
  environment_fingerprint?: string;
  passed?: boolean;
  gain?: number;
  contamination?: boolean;
  independent_causal_evidence?: boolean;
  metrics?: Record<string, number>;
  created_at: string;
}

export interface EvidenceSnapshot {
  run: TaskRun;
  accesses: AssetAccess[];
  claims: AgentUsageClaim[];
  events: EvidenceEvent[];
  behaviors: Behavior[];
  diffs: CodeDiff[];
  validations: Validation[];
  reviews: EvidenceReview[];
  evaluations: Evaluation[];
  candidates: CandidateAsset[];
  receipt?: AssetEvidenceReceipt;
}

export interface EvidenceRunListParams {
  team_id?: string;
  task_id?: string;
  asset_id?: string;
  asset_type?: AssetType;
  status?: RunStatus;
  variant?: RunVariant;
  candidate_status?: CandidateAsset['status'];
  review_status?: 'pending' | 'reviewed';
  evaluation_group_id?: string;
  limit?: number;
  offset?: number;
}

export interface EvidenceRunListResult {
  items: TaskRun[];
  total: number;
  limit?: number;
  offset?: number;
}

export type EvidenceReviewInput = {
  access_id: string;
  decision: ReviewDecision;
  reason: string;
  behavior_refs?: string[];
  diff_refs?: string[];
  decision_refs?: string[];
};

async function evidencePost<T>(action: string, body: object): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>('POST', `/api/v1/evidence/runs/${action}`, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
  if (envelope.code !== 0 || envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || 'empty evidence response', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || 'empty evidence response',
    });
  }
  return envelope.data;
}

export const evidenceApi = {
  listRuns: async (params: EvidenceRunListParams = {}): Promise<EvidenceRunListResult> => {
    const data = await evidencePost<EvidenceRunListResult>('list', params);
    return { items: data.items ?? [], total: data.total ?? 0, limit: data.limit, offset: data.offset };
  },
  getRun: (runId: string) => evidencePost<EvidenceSnapshot>('get', { run_id: runId }),
  getReceipt: (runId: string) => evidencePost<AssetEvidenceReceipt>('receipt', { run_id: runId }),
  review: (runId: string, input: EvidenceReviewInput) => evidencePost<EvidenceReview>('review', { run_id: runId, ...input }),
  reviewCandidate: (runId: string, input: { candidate_id: string; decision: CandidateDecision; reason: string }) =>
    evidencePost<CandidateAsset>('candidates/review', { run_id: runId, candidate_id: input.candidate_id, status: input.decision, reason: input.reason }),
};
