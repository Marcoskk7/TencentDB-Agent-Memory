type Claim = {
  run_id: string;
  access_id: string;
  claim_id: string;
  behavior_refs?: string[];
  diff_refs?: string[];
};
type Validation = {
  run_id: string;
  claim_refs?: string[];
  behavior_refs?: string[];
  diff_refs?: string[];
};
type Behavior = { run_id: string; behavior_id: string };
type Diff = { run_id: string; diff_id: string };

export function reviewableEvidenceIds(
  runId: string,
  accessId: string,
  snapshot: { claims: Claim[]; validations: Validation[]; behaviors: Behavior[]; diffs: Diff[] },
) {
  const claims = snapshot.claims.filter(
    (claim) => claim.run_id === runId && claim.access_id === accessId,
  );
  const claimIds = new Set(claims.map((claim) => claim.claim_id));
  const validationLinks = snapshot.validations.filter(
    (validation) =>
      validation.run_id === runId &&
      (validation.claim_refs ?? []).some((claimId) => claimIds.has(claimId)),
  );
  const behaviorIds = new Set([
    ...claims.flatMap((claim) => claim.behavior_refs ?? []),
    ...validationLinks.flatMap((validation) => validation.behavior_refs ?? []),
  ]);
  const diffIds = new Set([
    ...claims.flatMap((claim) => claim.diff_refs ?? []),
    ...validationLinks.flatMap((validation) => validation.diff_refs ?? []),
  ]);

  return {
    behaviorIds: new Set(
      snapshot.behaviors
        .filter((behavior) => behavior.run_id === runId && behaviorIds.has(behavior.behavior_id))
        .map((behavior) => behavior.behavior_id),
    ),
    diffIds: new Set(
      snapshot.diffs
        .filter((diff) => diff.run_id === runId && diffIds.has(diff.diff_id))
        .map((diff) => diff.diff_id),
    ),
  };
}
