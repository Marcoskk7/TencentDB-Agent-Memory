import type { AssetAccess, AgentUsageClaim, Behavior, CodeDiff, Evaluation, EvidenceEvent, EvidenceState, Review, Validation } from "./types.js";

const refs = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const has = (arr: string[], value: string) => arr.includes(value);

export function deriveEvidenceState(access: AssetAccess, events: EvidenceEvent[], claims: AgentUsageClaim[], reviews: Review[], validations: Validation[], behaviors: Behavior[] = [], diffs: CodeDiff[] = [], evaluations: Evaluation[] = []): EvidenceState {
  const forAccess = (e: EvidenceEvent) => e.data.access_id === access.access_id;
  const recalled = events.some(e => (e.type === "asset_recalled" || e.type === "asset_read" || e.type === "asset_injected") && forAccess(e));
  const selected = events.some(e => e.type === "asset_selected" && forAccess(e));
  const injected = events.some(e => e.type === "asset_injected" && forAccess(e));
  const ownClaims = claims.filter(c => c.access_id === access.access_id);
  const declared_used = ownClaims.some(c => c.declared_usage === "used");
  const not_used = ownClaims.some(c => c.declared_usage === "not_used");
  const ownReviews = reviews.filter(r => r.access_id === access.access_id);
  const rejected = ownReviews.some(r => r.decision === "not_support");
  const corrected = events.some(e => e.type === "correction_recorded" && forAccess(e));
  const support = ownReviews.some(r => r.decision === "support" && !rejected);
  const behaviorIds = new Set(behaviors.filter(b => b.run_id === access.run_id).map(b => b.behavior_id));
  const diffIds = new Set(diffs.filter(d => d.run_id === access.run_id).map(d => d.diff_id));
  const linkedClaim = ownClaims.some(c => c.behavior_refs?.some(x => behaviorIds.has(x)) || c.diff_refs?.some(x => diffIds.has(x)) || (c.decision_refs?.length ?? 0) > 0 || (c.files?.length ?? 0) > 0);
  const linkedReview = ownReviews.some(r => r.decision === "support" && (r.behavior_refs?.some(x => behaviorIds.has(x)) || r.diff_refs?.some(x => diffIds.has(x)) || (r.decision_refs?.length ?? 0) > 0));
  const relatedClaims = new Set(ownClaims.map(c => c.claim_id));
  const validation_passed = validations.some(v => v.passed && (v.claim_refs?.some(x => relatedClaims.has(x)) || v.behavior_refs?.some(x => behaviorIds.has(x)) || v.diff_refs?.some(x => diffIds.has(x))));
  const causal = evaluations.some(e => e.independent_causal_evidence === true && e.contamination !== true && (e.gain ?? 0) > 0);
  return { recalled, selected, injected, declared_used, used: support && !not_used && linkedReview && linkedClaim, validation_passed, contributed: support && !not_used && linkedReview && linkedClaim && validation_passed && causal, not_used, rejected, corrected };
}

export function deriveAllEvidence(...args: Parameters<typeof deriveEvidenceState>) { return deriveEvidenceState(...args); }
