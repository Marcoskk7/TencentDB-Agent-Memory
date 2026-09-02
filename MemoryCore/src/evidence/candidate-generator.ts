import type { AgentUsageClaim, CandidateAsset, CodeDiff, Review, TaskRun, Validation } from "./types.js";
import { id, isoNow } from "./types.js";

export interface CandidateInput { run: TaskRun; claims: AgentUsageClaim[]; diffs: CodeDiff[]; validations: Validation[]; reviews: Review[]; }

/** Creates a review-gated candidate; never promotes an asset to approved. */
export function generateCandidate(input: CandidateInput): CandidateAsset | undefined {
  const supported = input.reviews.filter(r => r.decision === "support");
  const used = input.claims.filter(c => c.declared_usage === "used");
  if (!supported.length && !used.length) return undefined;
  const sourceDiffIds = [...new Set(input.diffs.map(d => d.diff_id))];
  const sourceValidationIds = [...new Set(input.validations.filter(v => v.passed).map(v => v.validation_id))];
  const lines = [
    `来源任务 ${input.run.run_id}`,
    ...used.map(c => `用途: ${c.purpose}${c.files?.length ? ` (${c.files.join(", ")})` : ""}`),
    ...supported.map(r => `审核: ${r.reason}`),
  ];
  return { candidate_id: id("cand"), source_run_id: input.run.run_id, source_diff_ids: sourceDiffIds, source_validation_ids: sourceValidationIds, proposed_kind: "failure_experience", content: lines.join("\n"), confidence: Math.min(0.99, 0.5 + (supported.length ? 0.2 : 0) + (sourceValidationIds.length ? 0.2 : 0) + (sourceDiffIds.length ? 0.1 : 0)), review_required: true, status: "candidate", created_at: isoNow() };
}
