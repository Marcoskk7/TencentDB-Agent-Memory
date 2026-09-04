import type { AssetAccess, AgentUsageClaim, Behavior, CodeDiff, Evaluation, EvidenceEvent, EvidenceState, Review, Validation } from "./types.js";

export function deriveEvidenceState(access: AssetAccess, events: EvidenceEvent[], claims: AgentUsageClaim[], reviews: Review[], validations: Validation[], behaviors: Behavior[] = [], diffs: CodeDiff[] = [], evaluations: Evaluation[] = []): EvidenceState {
  const forAccess = (e: EvidenceEvent) => e.data.access_id === access.access_id;
  const recalled = events.some(e => (e.type === "asset_recalled" || e.type === "asset_read" || e.type === "asset_injected") && forAccess(e));
  const selected = events.some(e => e.type === "asset_selected" && forAccess(e));
  const injected = events.some(e => e.type === "asset_injected" && forAccess(e));
  const ownClaims = claims.filter(c => c.access_id === access.access_id);
  const declared_used = ownClaims.some(c => c.declared_usage === "used");
  const not_used = ownClaims.some(c => c.declared_usage === "not_used");
  const ownReviews = reviews.filter(r => r.access_id === access.access_id);
  const behaviorIds = new Set(behaviors.filter(b => b.run_id === access.run_id).map(b => b.behavior_id));
  const diffIds = new Set(diffs.filter(d => d.run_id === access.run_id).map(d => d.diff_id));
  const relatedClaims = new Set(ownClaims.map(c => c.claim_id));
  const validatingLinks = validations.filter(v => v.run_id === access.run_id && v.claim_refs?.some(x => relatedClaims.has(x)));
  const linkedBehaviorIds = new Set([
    ...ownClaims.flatMap(c => c.behavior_refs ?? []),
    ...validatingLinks.flatMap(v => v.behavior_refs ?? []),
  ].filter(x => behaviorIds.has(x)));
  const linkedDiffIds = new Set([
    ...ownClaims.flatMap(c => c.diff_refs ?? []),
    ...validatingLinks.flatMap(v => v.diff_refs ?? []),
  ].filter(x => diffIds.has(x)));

  // A review can only support this asset through evidence that the asset's
  // own claim already linked. Same-run evidence and free-form decision labels
  // are not enough to attribute behavior to a particular asset access.
  const reviewIdByEventId = new Map(events
    .filter(e => e.run_id === access.run_id && e.type === "review_recorded" && typeof e.data.review_id === "string")
    .map(e => [e.event_id, e.data.review_id as string]));
  const correctedReviewIds = new Set(events
    .filter(e => e.run_id === access.run_id && e.type === "correction_recorded" && forAccess(e) && typeof e.data.original_event_id === "string")
    .map(e => reviewIdByEventId.get(e.data.original_event_id as string))
    .filter((id): id is string => typeof id === "string"));
  const effectiveReviews = ownReviews.filter(r => !correctedReviewIds.has(r.review_id));
  const rejected = effectiveReviews.some(r => r.decision === "not_support");
  const corrected = events.some(e => e.type === "correction_recorded" && forAccess(e));
  const support = effectiveReviews.some(r => r.decision === "support" && (
    r.behavior_refs?.some(x => linkedBehaviorIds.has(x)) || r.diff_refs?.some(x => linkedDiffIds.has(x))
  ));
  // A run can touch many assets.  A validation tied to an unrelated behavior
  // or diff must not mark every access as validated.
  const validation_passed = validations.some(v => v.run_id === access.run_id && v.passed === true && v.exit_code === 0 && (
    v.claim_refs?.some(x => relatedClaims.has(x)) || v.behavior_refs?.some(x => linkedBehaviorIds.has(x)) || v.diff_refs?.some(x => linkedDiffIds.has(x))
  ));
  const causal = evaluations.some(e => e.independent_causal_evidence === true && e.contamination !== true && (e.gain ?? 0) > 0);
  const used = support && !not_used && !rejected;
  return { recalled, selected, injected, declared_used, used, validation_passed, contributed: used && validation_passed && causal, not_used, rejected, corrected };
}

export function deriveAllEvidence(...args: Parameters<typeof deriveEvidenceState>) { return deriveEvidenceState(...args); }
