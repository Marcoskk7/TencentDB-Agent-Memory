import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, StatusTip, TabPanel, Tabs } from 'tea-component';
import {
  evidenceApi,
  type AssetAccess,
  type AssetEvidenceReceipt,
  type EvidenceSnapshot,
} from '@/lib/api/evidence';
import { AccessReview, CandidateReview } from './EvidenceReview';
import { EvaluationComparison } from './EvaluationComparison';

function RawRecord({ label, value }: { label: string; value: unknown }) {
  return (
    <details>
      <summary>{label}</summary>
      <pre className="_evidence-pre">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function EvidenceRunDetail({
  runId,
  assetId,
  assetType,
  initialTab = 'assets',
  onChanged,
}: {
  runId: string;
  assetId?: string;
  assetType?: AssetAccess['asset_type'];
  initialTab?: string;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<EvidenceSnapshot>();
  const [receipt, setReceipt] = useState<AssetEvidenceReceipt>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState(initialTab);
  const reload = () => {
    setRefresh((v) => v + 1);
    onChanged();
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([evidenceApi.getRun(runId), evidenceApi.getReceipt(runId)])
      .then(([s, r]) => {
        if (active) {
          setSnapshot(s);
          setReceipt(r);
        }
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [runId, refresh]);

  if (loading)
    return (
      <div role="status">
        <StatusTip status="loading" />
      </div>
    );
  if (error)
    return (
      <Alert type="error">
        <div role="alert">{error}</div>
        <Button onClick={() => setRefresh((v) => v + 1)}>{t('evidence.retry')}</Button>
      </Alert>
    );
  if (!snapshot || !receipt) return null;
  const { run } = snapshot;
  const accesses = snapshot.accesses.filter(
    (a) => (!assetId || a.asset_id === assetId) && (!assetType || a.asset_type === assetType),
  );
  const facts: [string, ReactNode][] = [
    ['runId', <code>{run.run_id}</code>],
    ['taskId', run.task_id ?? '—'],
    ['agent', run.agent_id],
    ['status', t(`evidence.status.${run.status}`)],
    ['variant', run.variant ? t(`evidence.variant.${run.variant}`) : '—'],
    ['group', run.evaluation_group_id ?? '—'],
    ['baseCommit', <code>{run.base_commit ?? '—'}</code>],
    ['receiptRevision', String(receipt.revision)],
    ['contributionEvidence', t(`evidence.contribution.${receipt.contribution_evidence}`)],
  ];

  return (
    <article className="_evidence-detail">
      <header>
        <h2>{run.task_goal}</h2>
        <p>
          {t(`evidence.status.${run.status}`)} · {t('evidence.receiptRevision')}: {receipt.revision}{' '}
          · {t('evidence.contributionEvidence')}:{' '}
          {t(`evidence.contribution.${receipt.contribution_evidence}`)}
        </p>
        <details>
          <summary>{t('evidence.runMetadata')}</summary>
          <dl className="_evidence-facts">
            {facts.map(([key, value]) => (
              <Fragment key={key}>
                <dt>{t(`evidence.${key}`)}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
          </dl>
        </details>
        <p className="_evidence-note">{t('evidence.stateHint')}</p>
      </header>
      <Tabs
        activeId={tab}
        onActive={(v) => setTab(v.id)}
        tabs={['assets', 'timeline', 'candidates', 'evaluations'].map((id) => ({
          id,
          label: t(`evidence.tab.${id}`),
        }))}
      >
        <TabPanel id="assets">
          {tab === 'assets' && (
            <>
              {!accesses.length && (
                <StatusTip status="empty" emptyText={t('evidence.noAccesses')} />
              )}
              {accesses.map((access) => {
                const derived = receipt.assets.find((a) => a.access_id === access.access_id);
                const claims = snapshot.claims.filter((c) => c.access_id === access.access_id);
                const validationIds = new Set(derived?.validation_refs ?? []);
                return (
                  <section key={access.access_id} className="_evidence-section">
                    <h3>
                      {access.name ?? access.asset_id}{' '}
                      <span className="_evidence-note">
                        {access.asset_type} · v{access.version}
                      </span>
                    </h3>
                    <dl className="_evidence-facts">
                      <dt>{t('evidence.assetId')}</dt>
                      <dd>
                        <code>{access.asset_id}</code>
                      </dd>
                      <dt>{t('evidence.accessId')}</dt>
                      <dd>
                        <code>{access.access_id}</code>
                      </dd>
                      <dt>{t('evidence.version')}</dt>
                      <dd>
                        <code>{access.version}</code>
                      </dd>
                      <dt>{t('evidence.source')}</dt>
                      <dd>{access.source_ref ?? '—'}</dd>
                      <dt>{t('evidence.selection')}</dt>
                      <dd>{access.selection_reason ?? '—'}</dd>
                    </dl>
                    {derived && (
                      <>
                        <div className="_evidence-states">
                          {Object.entries(derived.evidence).map(([state, active]) => (
                            <span className="_evidence-state" data-active={active} key={state}>
                              {t(`evidence.state.${state}`)}:{' '}
                              {t(active ? 'evidence.yes' : 'evidence.no')}
                            </span>
                          ))}
                        </div>
                        {!!derived.evidence_gaps.length && (
                          <p>
                            {t('evidence.gaps')}:{' '}
                            {derived.evidence_gaps
                              .map((gap) => t(`evidence.gap.${gap}`, { defaultValue: gap }))
                              .join(' · ')}
                          </p>
                        )}
                        {!!derived.risks.length && (
                          <p>
                            {t('evidence.risks')}: {derived.risks.join(' · ')}
                          </p>
                        )}
                      </>
                    )}
                    <h4>{t('evidence.claims')}</h4>
                    {claims.length ? (
                      claims.map((claim) => (
                        <div key={claim.claim_id}>
                          <p>
                            <strong>{t(`evidence.declared.${claim.declared_usage}`)}</strong> ·{' '}
                            {claim.purpose}
                          </p>
                          {claim.reason && <p>{claim.reason}</p>}
                          <RawRecord label={t('evidence.claimReferences')} value={claim} />
                        </div>
                      ))
                    ) : (
                      <p className="_evidence-note">{t('evidence.noClaims')}</p>
                    )}
                    <h4>{t('evidence.validations')}</h4>
                    {snapshot.validations
                      .filter((v) => validationIds.has(v.validation_id))
                      .map((v) => (
                        <p key={v.validation_id}>
                          <strong>{t(v.passed ? 'evidence.passed' : 'evidence.failed')}</strong> ·{' '}
                          <code>{v.command}</code> · {t('evidence.exitCode')}: {v.exit_code ?? '—'}
                        </p>
                      ))}
                    {!validationIds.size && (
                      <p className="_evidence-note">{t('evidence.noValidations')}</p>
                    )}
                    <h4>{t('evidence.reviews')}</h4>
                    <AccessReview
                      snapshot={snapshot}
                      accessId={access.access_id}
                      onSaved={reload}
                    />
                  </section>
                );
              })}
              <RawRecord label={t('evidence.receipt')} value={receipt} />
            </>
          )}
        </TabPanel>
        <TabPanel id="timeline">
          {tab === 'timeline' && (
            <>
              <p className="_evidence-note">{t('evidence.timelineHint')}</p>
              <ul className="_evidence-timeline">
                {snapshot.events.map((event) => (
                  <li key={event.event_id}>
                    <strong>
                      {event.sequence}.{' '}
                      {t(`evidence.event.${event.type}`, { defaultValue: event.type })}
                    </strong>
                    <p className="_evidence-note">
                      <time dateTime={event.occurred_at}>
                        {new Date(event.occurred_at).toLocaleString()}
                      </time>{' '}
                      · {event.actor?.type ?? '—'} {event.actor?.id ?? ''}
                    </p>
                    <RawRecord label={t('evidence.eventData')} value={event.data} />
                  </li>
                ))}
              </ul>
              <RawRecord label={t('evidence.behaviors')} value={snapshot.behaviors} />
              <RawRecord label={t('evidence.diffs')} value={snapshot.diffs} />
              <RawRecord label={t('evidence.allValidations')} value={snapshot.validations} />
            </>
          )}
        </TabPanel>
        <TabPanel id="candidates">
          {tab === 'candidates' && (
            <>
              <p className="_evidence-note">{t('evidence.candidateReviewHint')}</p>
              {!snapshot.candidates.length && (
                <StatusTip status="empty" emptyText={t('evidence.noCandidates')} />
              )}
              {snapshot.candidates.map((candidate) => (
                <section key={candidate.candidate_id} className="_evidence-section">
                  <h3>
                    {candidate.proposed_kind} · {t(`evidence.lifecycle.${candidate.status}`)}
                  </h3>
                  <code>{candidate.candidate_id}</code>
                  <pre className="_evidence-pre">{candidate.content}</pre>
                  <dl className="_evidence-facts">
                    <dt>{t('evidence.confidence')}</dt>
                    <dd>{candidate.confidence}</dd>
                    <dt>{t('evidence.sourceRun')}</dt>
                    <dd>
                      <code>{candidate.source_run_id}</code>
                    </dd>
                  </dl>
                  <RawRecord
                    label={t('evidence.sourceDiffs')}
                    value={snapshot.diffs.filter((d) =>
                      candidate.source_diff_ids.includes(d.diff_id),
                    )}
                  />
                  <RawRecord
                    label={t('evidence.sourceValidations')}
                    value={snapshot.validations.filter((v) =>
                      candidate.source_validation_ids.includes(v.validation_id),
                    )}
                  />
                  <CandidateReview candidate={candidate} runId={runId} onSaved={reload} />
                  <h4>{t('evidence.candidateAudit')}</h4>
                  {snapshot.events
                    .filter(
                      (event) =>
                        event.type === 'candidate_reviewed' &&
                        event.data.candidate_id === candidate.candidate_id,
                    )
                    .map((event) => (
                      <div key={event.event_id}>
                        <p>
                          <strong>{t(`evidence.lifecycle.${String(event.data.status)}`)}</strong> ·{' '}
                          {event.actor?.id ?? '—'} ·{' '}
                          <time dateTime={event.occurred_at}>
                            {new Date(event.occurred_at).toLocaleString()}
                          </time>
                        </p>
                        <p>{typeof event.data.reason === 'string' ? event.data.reason : '—'}</p>
                      </div>
                    ))}
                  {candidate.status === 'candidate' && (
                    <p className="_evidence-note">{t('evidence.noCandidateReview')}</p>
                  )}
                  <RawRecord label={t('evidence.candidateRecord')} value={candidate} />
                </section>
              ))}
            </>
          )}
        </TabPanel>
        <TabPanel id="evaluations">
          {tab === 'evaluations' && <EvaluationComparison snapshot={snapshot} receipt={receipt} />}
        </TabPanel>
      </Tabs>
    </article>
  );
}
