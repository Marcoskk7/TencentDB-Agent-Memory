import type { AgentUsageClaim, CandidateAsset, CodeDiff, Review, TaskRun, Validation } from "./types.js";
import { id, isoNow } from "./types.js";

export interface CandidateInput { run: TaskRun; claims: AgentUsageClaim[]; diffs: CodeDiff[]; validations: Validation[]; reviews: Review[]; }

/** Deterministic first-pass classification; reviewers remain authoritative. */
export function classifyCandidateKind(input: CandidateInput): CandidateAsset["proposed_kind"] {
  const goal = input.run.task_goal.toLowerCase();
  if (/\b(convention|style guide|coding rule|standard|规范|约定)\b/.test(goal)) return "project_convention";
  if (/\b(skill|playbook|how[- ]to|recipe|技巧)\b/.test(goal)) return "skill";
  if (/\b(workflow|process|pipeline|流程|工作流)\b/.test(goal)) return "workflow";
  if (/\b(product|api|service|feature|产品|接口|服务)\b/.test(goal)) return "product_knowledge";
  if (input.diffs.length) return "code_knowledge";
  if (input.validations.some(v => !v.passed) || /\b(fail|failed|failure|bug|error|regression|失败|错误|故障)\b/.test(goal)) return "failure_experience";
  return input.reviews.length ? "project_convention" : "failure_experience";
}

/** Creates a review-gated candidate; never promotes an asset to approved. */
export function generateCandidate(input: CandidateInput): CandidateAsset | undefined {
  const supported = input.reviews.filter(r => r.decision === "support" && ((r.behavior_refs?.length ?? 0) > 0 || (r.diff_refs?.length ?? 0) > 0 || (r.decision_refs?.length ?? 0) > 0));
  // A self-report alone is insufficient: require linked execution evidence.
  const used = input.claims.filter(c => c.declared_usage === "used" && ((c.behavior_refs?.length ?? 0) > 0 || (c.diff_refs?.length ?? 0) > 0));
  if (!supported.length && !used.length) return undefined;
  const sourceDiffIds = [...new Set(input.diffs.map(d => d.diff_id))];
  const sourceValidationIds = [...new Set(input.validations.filter(v => v.passed).map(v => v.validation_id))];
  const lines = [
    `来源任务 ${input.run.run_id}`,
    ...used.map(c => `用途: ${c.purpose}${c.files?.length ? ` (${c.files.join(", ")})` : ""}`),
    ...supported.map(r => `审核: ${r.reason}`),
  ];
  const proposed_kind = classifyCandidateKind(input);
  const recommendation: CandidateAsset["recommendation"] = /\b(deprecat|obsolete|过期|废弃)\b/i.test(input.run.task_goal) ? "deprecate" : /\b(conflict|contradict|冲突)\b/i.test(input.run.task_goal) ? "conflict" : /\b(revis|update|修订|更新)\b/i.test(input.run.task_goal) ? "revise" : "publish";
  return { candidate_id: id("cand"), source_run_id: input.run.run_id, source_diff_ids: sourceDiffIds, source_validation_ids: sourceValidationIds, proposed_kind, applicability: input.run.repo, risks: [], recommendation, version: 1, content: lines.join("\n"), confidence: Math.min(0.99, 0.5 + (supported.length ? 0.2 : 0) + (sourceValidationIds.length ? 0.2 : 0) + (sourceDiffIds.length ? 0.1 : 0)), review_required: true, status: "candidate", created_at: isoNow() };
}
