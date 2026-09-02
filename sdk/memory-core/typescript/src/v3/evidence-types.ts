export type EvidenceAssetType = "skill" | "llm_wiki" | "code_graph" | "chat_memory";
export type EvidenceAccessMode = "search" | "read" | "inject";
export interface TaskRun { run_id: string; team_id: string; agent_id: string; user_id: string; task_goal: string; status: string; [key: string]: unknown; }
export interface AssetAccess { access_id: string; run_id: string; asset_id: string; asset_type: EvidenceAssetType; version: number; content_digest: string; mode: EvidenceAccessMode; [key: string]: unknown; }
export interface AgentUsageClaim { claim_id: string; run_id: string; access_id: string; declared_usage: "used" | "not_used" | "uncertain"; purpose: string; [key: string]: unknown; }
export interface AssetEvidenceReceipt { run_id: string; revision: number; summary: Record<string, number>; assets: unknown[]; [key: string]: unknown; }
export interface EvidenceSnapshot { run: TaskRun; accesses: AssetAccess[]; claims: AgentUsageClaim[]; events: unknown[]; behaviors: unknown[]; diffs: unknown[]; validations: unknown[]; reviews: unknown[]; evaluations: unknown[]; candidates: unknown[]; [key: string]: unknown; }
export interface CreateTaskRunRequest { team_id: string; agent_id: string; user_id: string; task_goal: string; [key: string]: unknown; }
