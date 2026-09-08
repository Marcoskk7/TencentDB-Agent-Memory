import { z } from "zod";

const text = z.string().min(1).max(4000);
const ref = z.string().min(1).max(300);
const refs = z.array(ref).max(128).optional();
const key = z.string().min(1).max(500).optional();
const common = { idempotency_key: key };
const links = { behavior_refs: refs, diff_refs: refs, decision_refs: refs };
export const runSchema = z.object({
  team_id: ref, agent_id: ref, user_id: ref, task_id: ref.optional(),
  agent_source: ref, session_id: ref, request_id: ref, execution_id: ref,
  task_goal: text, repo: text.optional(), branch: text.optional(), base_commit: ref.optional(), head_commit: ref.optional(),
  variant: z.enum(["with_assets", "without_assets", "oracle"]).optional(), evaluation_group_id: ref.optional(), parent_run_id: ref.optional(),
  run_kind: z.enum(["main", "fork", "subagent", "retry", "control", "oracle"]).optional(),
  model_fingerprint: ref.optional(), environment_fingerprint: ref.optional(),
  workspace_id: text.optional(), last_heartbeat_at: z.iso.datetime().optional(), ...common,
}).strict();
export const accessSchema = z.object({
  asset_id: ref, asset_type: z.enum(["skill", "llm_wiki", "code_graph", "chat_memory"]), version: z.number().int().nonnegative(),
  source_ref: text.optional(), mode: z.enum(["search", "read", "inject"]),
  reader_team_id: ref, reader_agent_id: ref, reader_user_id: ref, adapter: ref.optional(), read_at: z.iso.datetime().optional(),
  selection_score: z.number().finite().optional(), selection_reason: text.optional(), token_estimate: z.number().int().nonnegative().optional(),
  compatibility_risk: text.optional(), applicability: text.optional(), name: text.optional(), ...common,
}).strict();
export const behaviorSchema = z.object({
  tool_name: ref, target_files: refs, command_summary: text.optional(), result_summary: text.optional(),
  external_tool_use_id: ref.optional(), phase: z.enum(["intent", "execution"]).optional(), parent_behavior_id: ref.optional(), ...common,
}).strict();
export const diffSchema = z.object({
  base_commit: ref.optional(), head_commit: ref.optional(), files: z.array(ref).max(512),
  additions: z.number().int().nonnegative().optional(), deletions: z.number().int().nonnegative().optional(), ...common,
}).strict();
export const claimSchema = z.object({
  access_id: ref, declared_usage: z.enum(["used", "not_used", "uncertain"]), purpose: text,
  ...links, validation_refs: refs, files: refs, reason: text.optional(), ...common,
}).strict();
export const validationSchema = z.object({
  command: text, exit_code: z.number().int().nonnegative().optional(), passed: z.boolean(), validation_type: ref,
  claim_refs: refs, behavior_refs: refs, diff_refs: refs, verifier: ref.optional(), ...common,
}).strict();
export const reviewSchema = z.object({
  access_id: ref, decision: z.enum(["support", "not_support", "uncertain"]), reason: text,
  ...links, reviewer_user_id: ref, ...common,
}).strict();
export const evaluationSchema = z.object({
  control_run_id: ref.optional(), access_id: ref.optional(), baseline_commit: ref.optional(), environment_fingerprint: ref.optional(),
  passed: z.boolean().optional(), gain: z.number().finite().optional(), contamination: z.boolean().optional(),
  metrics: z.record(ref, z.number().finite()).refine(v => Object.keys(v).length <= 32).optional(), ...common,
}).strict();
const assetEvent = { access_id: ref, asset_id: ref.optional(), version: z.number().int().nonnegative().optional(), occurred_at: z.iso.datetime().optional() };
export const eventSchemas = {
  asset_recalled: z.object(assetEvent).strict(), asset_read: z.object(assetEvent).strict(),
  asset_selected: z.object({ ...assetEvent, reason: text.optional(), token_estimate: z.number().int().nonnegative().optional() }).strict(),
  asset_injected: z.object({ ...assetEvent, mode: z.enum(["summary", "full", "tool"]).optional() }).strict(),
  intent_declared: z.object({ ...assetEvent, purpose: text.optional(), ...links, files: refs }).strict(),
  diff_unavailable: z.object({ reason: text }).strict(),
  task_close_prompted: z.object({ reason: text.optional() }).strict(),
  task_close_decision: z.object({ decision: z.enum(["complete", "continue", "cancel"]) }).strict(),
  correction_recorded: z.object({ original_event_id: ref, access_id: ref, reason: text, actor_id: ref }).strict(),
};

/** Summaries only. Reject extra fields before redacting credential-shaped values. */
export function sanitize<T>(value: T): T {
  if (typeof value === "string") return value
    .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{16,}\b/g, "[REDACTED]")
    .replace(/(\b(?:api[_-]?key|password|secret|access[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]") as T;
  if (Array.isArray(value)) return value.map(sanitize) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)])) as T;
  return value;
}
