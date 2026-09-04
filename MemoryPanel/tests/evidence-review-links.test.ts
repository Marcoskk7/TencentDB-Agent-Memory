import { describe, expect, it } from 'vitest';
import { reviewableEvidenceIds } from '../web/src/components/evidence/reviewableEvidence';

describe('reviewable evidence links', () => {
  it('includes actual evidence linked back through a validation claim reference', () => {
    const links = reviewableEvidenceIds('run-a', 'access-a', {
      claims: [{ run_id: 'run-a', access_id: 'access-a', claim_id: 'claim-a' }],
      validations: [{ run_id: 'run-a', claim_refs: ['claim-a'], behavior_refs: ['behavior-collected'], diff_refs: ['diff-collected'] }],
      behaviors: [{ run_id: 'run-a', behavior_id: 'behavior-collected' }],
      diffs: [{ run_id: 'run-a', diff_id: 'diff-collected' }],
    });

    expect([...links.behaviorIds]).toEqual(['behavior-collected']);
    expect([...links.diffIds]).toEqual(['diff-collected']);
  });

  it('excludes same-run evidence unless a claim or linked validation maps it to this access', () => {
    const links = reviewableEvidenceIds('run-a', 'access-a', {
      claims: [{ run_id: 'run-a', access_id: 'access-a', claim_id: 'claim-a' }],
      validations: [{ run_id: 'run-a', claim_refs: ['other-claim'], behavior_refs: ['other-behavior'], diff_refs: ['other-diff'] }],
      behaviors: [
        { run_id: 'run-a', behavior_id: 'other-behavior' },
        { run_id: 'run-b', behavior_id: 'cross-run-behavior' },
      ],
      diffs: [
        { run_id: 'run-a', diff_id: 'other-diff' },
        { run_id: 'run-b', diff_id: 'cross-run-diff' },
      ],
    });

    expect(links.behaviorIds.size).toBe(0);
    expect(links.diffIds.size).toBe(0);
  });
});
