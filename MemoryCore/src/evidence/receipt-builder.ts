import type { AssetAccess, AgentUsageClaim, AssetEvidenceReceipt, Behavior, CandidateAsset, CodeDiff, Evaluation, EvidenceEvent, Review, TaskRun, Validation } from "./types.js";
import { deriveEvidenceState } from "./state-derivation.js";

export function buildReceipt(run: TaskRun, accesses: AssetAccess[], claims: AgentUsageClaim[], events: EvidenceEvent[], behaviors: Behavior[] = [], diffs: CodeDiff[] = [], validations: Validation[] = [], reviews: Review[] = [], evaluations: Evaluation[] = [], revision = run.receipt_revision ?? 1): AssetEvidenceReceipt {
  const assets = accesses.map(access => {
    const evidence = deriveEvidenceState(access, events, claims, reviews, validations, behaviors, diffs, evaluations);
    const ownClaims = claims.filter(c => c.access_id === access.access_id);
    const ownReviews = reviews.filter(r => r.access_id === access.access_id);
    const decision_refs = [...new Set(ownClaims.flatMap(c => c.decision_refs ?? []).concat(ownReviews.flatMap(r => r.decision_refs ?? [])))];
    const file_refs = [...new Set(ownClaims.flatMap(c => c.files ?? []))];
    const validation_refs = [...new Set(validations.filter(v => v.passed && (v.claim_refs ?? []).some(id => ownClaims.some(c => c.claim_id === id))).map(v => v.validation_id))];
    const risks = access.compatibility_risk ? [access.compatibility_risk] : [];
    const evidence_gaps: string[] = [];
    if (!evidence.selected) evidence_gaps.push("未记录通过筛选的选择事实");
    if (!evidence.injected) evidence_gaps.push("未记录上下文注入事实");
    if (evidence.declared_used && !evidence.used) evidence_gaps.push("缺少具有关联证据的人工 support 审核");
    if (evidence.used && !evidence.validation_passed) evidence_gaps.push("缺少与该资产关联的通过验证");
    if (evidence.validation_passed && !evidence.contributed) evidence_gaps.push("没有满足条件的独立因果/对照证据");
    return { access_id: access.access_id, asset_id: access.asset_id, asset_type: access.asset_type, name: access.name, version: access.version, source_ref: access.source_ref, applicability: access.applicability, evidence, decision_refs, file_refs, validation_refs, risks, evidence_gaps };
  });
  const summary = { recalled: assets.filter(a => a.evidence.recalled).length, selected: assets.filter(a => a.evidence.selected).length, injected: assets.filter(a => a.evidence.injected).length, used: assets.filter(a => a.evidence.used).length, validation_passed: assets.filter(a => a.evidence.validation_passed).length, contributed: assets.filter(a => a.evidence.contributed).length };
  const causalCount = assets.filter(a => a.evidence.contributed).length;
  const suggestive = evaluations.some(e => e.contamination !== true && (e.gain ?? 0) > 0);
  return { run_id: run.run_id, revision, summary, assets, metrics: {}, contribution_evidence: causalCount ? "causal" : suggestive ? "suggestive" : "insufficient", generated_at: new Date().toISOString() };
}
