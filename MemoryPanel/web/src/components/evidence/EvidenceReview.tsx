import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button } from 'tea-component';
import {
  evidenceApi,
  type EvidenceSnapshot,
  type ReviewDecision,
  type CandidateAsset,
} from '@/lib/api/evidence';
import { useCurrentRole } from '@/services/useCurrentRole';
import { reviewableEvidenceIds } from './reviewableEvidence';

export function AccessReview({
  snapshot,
  accessId,
  onSaved,
}: {
  snapshot: EvidenceSnapshot;
  accessId: string;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const role = useCurrentRole();
  const [decision, setDecision] = useState<ReviewDecision>('uncertain');
  const [reason, setReason] = useState('');
  const [behaviorRefs, setBehaviorRefs] = useState<string[]>([]);
  const [diffRefs, setDiffRefs] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const { behaviorIds: reviewableBehaviorIds, diffIds: reviewableDiffIds } = reviewableEvidenceIds(
    snapshot.run.run_id,
    accessId,
    snapshot,
  );
  const reviewableBehaviors = snapshot.behaviors.filter((behavior) =>
    reviewableBehaviorIds.has(behavior.behavior_id),
  );
  const reviewableDiffs = snapshot.diffs.filter((diff) => reviewableDiffIds.has(diff.diff_id));
  const toggle = (values: string[], value: string) =>
    values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  const missingProof =
    decision === 'support' && behaviorRefs.length + diffRefs.length === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !reason.trim() || missingProof) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await evidenceApi.review(snapshot.run.run_id, {
        access_id: accessId,
        decision,
        reason: reason.trim(),
        behavior_refs: behaviorRefs,
        diff_refs: diffRefs,
      });
      setSaved(true);
      setReason('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {snapshot.reviews
        .filter((r) => r.access_id === accessId)
        .map((review) => (
          <div className="_evidence-section" key={review.review_id}>
            <strong>{t(`evidence.decision.${review.decision}`)}</strong>
            <p>{review.reason}</p>
            <p className="_evidence-note">
              {review.reviewer_user_id} · {new Date(review.created_at).toLocaleString()}
            </p>
            <code>
              {[
                ...(review.behavior_refs ?? []),
                ...(review.diff_refs ?? []),
                ...(review.decision_refs ?? []),
              ].join(' · ')}
            </code>
          </div>
        ))}
      {saved && (
        <div role="status">
          <Alert type="success">{t('evidence.reviewSaved')}</Alert>
        </div>
      )}
      {role !== 'admin' && role !== 'reviewer' ? (
        <p className="_evidence-note">{t('evidence.readOnly')}</p>
      ) : (
        <details>
          <summary>{t('evidence.addReview')}</summary>
          <form className="_evidence-review-form" onSubmit={submit}>
            <p className="_evidence-note">{t('evidence.reviewHint')}</p>
            <label className="_evidence-field">
              {t('evidence.decision')}
              <select
                value={decision}
                disabled={saving}
                onChange={(e) => setDecision(e.target.value as ReviewDecision)}
              >
                {(['uncertain', 'support', 'not_support'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`evidence.decision.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset disabled={saving}>
              <legend>{t('evidence.linkedProof')}</legend>
              {reviewableBehaviors.map((b) => (
                <label key={b.behavior_id} className="_evidence-check">
                  <input
                    type="checkbox"
                    checked={behaviorRefs.includes(b.behavior_id)}
                    onChange={() => setBehaviorRefs(toggle(behaviorRefs, b.behavior_id))}
                  />
                  <span>
                    {b.tool_name}: {b.command_summary ?? b.result_summary ?? b.behavior_id}
                  </span>
                </label>
              ))}
              {reviewableDiffs.map((d) => (
                <label key={d.diff_id} className="_evidence-check">
                  <input
                    type="checkbox"
                    checked={diffRefs.includes(d.diff_id)}
                    onChange={() => setDiffRefs(toggle(diffRefs, d.diff_id))}
                  />
                  <span>
                    {t('evidence.diff')}: {d.files.join(', ')} <code>{d.diff_id}</code>
                  </span>
                </label>
              ))}
              {!reviewableBehaviors.length && !reviewableDiffs.length && (
                <p>{t('evidence.noProof')}</p>
              )}
            </fieldset>
            {missingProof && <p className="_evidence-note">{t('evidence.supportNeedsProof')}</p>}
            <label className="_evidence-field">
              {t('evidence.reason')}
              <textarea
                required
                maxLength={10000}
                rows={3}
                value={reason}
                disabled={saving}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {error && (
              <div role="alert">
                <Alert type="error">{error}</Alert>
              </div>
            )}
            <div>
              <Button
                type="primary"
                htmlType="submit"
                loading={saving}
                disabled={saving || !reason.trim() || missingProof}
              >
                {t('evidence.submitReview')}
              </Button>
            </div>
          </form>
        </details>
      )}
    </div>
  );
}

export function CandidateReview({
  candidate,
  runId,
  onSaved,
}: {
  candidate: CandidateAsset;
  runId: string;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const role = useCurrentRole();
  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (candidate.status !== 'candidate' || (role !== 'admin' && role !== 'reviewer')) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !reason.trim()) return;
    setSaving(true);
    setError('');
    try {
      await evidenceApi.reviewCandidate(runId, {
        candidate_id: candidate.candidate_id,
        decision,
        reason: reason.trim(),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="_evidence-review-form" onSubmit={submit}>
      <p className="_evidence-note">{t('evidence.candidateReviewHint')}</p>
      <label className="_evidence-field">
        {t('evidence.candidateDecision')}
        <select
          value={decision}
          disabled={saving}
          onChange={(e) => setDecision(e.target.value as typeof decision)}
        >
          <option value="approved">{t('evidence.lifecycle.approved')}</option>
          <option value="rejected">{t('evidence.lifecycle.rejected')}</option>
        </select>
      </label>
      <label className="_evidence-field">
        {t('evidence.reason')}
        <textarea
          required
          rows={3}
          maxLength={10000}
          value={reason}
          disabled={saving}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {error && (
        <div role="alert">
          <Alert type="error">{error}</Alert>
        </div>
      )}
      <div>
        <Button
          htmlType="submit"
          type="primary"
          disabled={saving || !reason.trim()}
          loading={saving}
        >
          {t('evidence.submitCandidateReview')}
        </Button>
      </div>
    </form>
  );
}
