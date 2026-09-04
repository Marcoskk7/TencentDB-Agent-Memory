import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, StatusTip } from 'tea-component';
import { evidenceApi, type AssetEvidenceReceipt, type EvidenceSnapshot } from '@/lib/api/evidence';
import { hasMatchingControl, metricDelta } from './comparison';

/** Report observed differences; the UI never derives or submits causal flags. */
export function EvaluationComparison({
  snapshot,
  receipt,
}: {
  snapshot: EvidenceSnapshot;
  receipt: AssetEvidenceReceipt;
}) {
  const { t } = useTranslation();
  const [controlId, setControlId] = useState(
    snapshot.evaluations.find((e) => e.control_run_id)?.control_run_id ?? '',
  );
  const [peers, setPeers] = useState<EvidenceSnapshot['run'][]>([]);
  const [control, setControl] = useState<EvidenceSnapshot>();
  const [controlReceipt, setControlReceipt] = useState<AssetEvidenceReceipt>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [peerError, setPeerError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [peerPage, setPeerPage] = useState(0);
  const [peerTotal, setPeerTotal] = useState(0);
  const [peerLoading, setPeerLoading] = useState(false);
  const run = snapshot.run;
  useEffect(() => {
    let active = true;
    setPeerError('');
    if (!run.evaluation_group_id) return;
    setPeerLoading(true);
    evidenceApi
      .listRuns({
        team_id: run.team_id,
        evaluation_group_id: run.evaluation_group_id,
        variant: 'without_assets',
        limit: 100,
        offset: peerPage * 100,
      })
      .then((result) => {
        if (active) {
          setPeers(result.items);
          setPeerTotal(result.total);
          if (result.items[0])
            setControlId((current) =>
              peerPage ? result.items[0].run_id : current || result.items[0].run_id,
            );
        }
      })
      .catch((err: unknown) => {
        if (active) setPeerError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setPeerLoading(false);
      });
    return () => {
      active = false;
    };
  }, [run.team_id, run.evaluation_group_id, refresh, peerPage]);
  useEffect(() => {
    let active = true;
    setControl(undefined);
    setControlReceipt(undefined);
    setError('');
    if (!controlId) return;
    setLoading(true);
    Promise.all([evidenceApi.getRun(controlId), evidenceApi.getReceipt(controlId)])
      .then(([s, r]) => {
        if (active) {
          setControl(s);
          setControlReceipt(r);
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
  }, [controlId, refresh]);

  const rows =
    control && controlReceipt
      ? ([
          ['runId', run.run_id, control.run.run_id],
          ['variant', run.variant, control.run.variant],
          ['taskId', run.task_id, control.run.task_id],
          ['baseCommit', run.base_commit, control.run.base_commit],
          ['model', run.model_fingerprint, control.run.model_fingerprint],
          ['environment', run.environment_fingerprint, control.run.environment_fingerprint],
          ['status', run.status, control.run.status],
          [
            'passedValidations',
            snapshot.validations.filter((v) => v.passed).length,
            control.validations.filter((v) => v.passed).length,
          ],
          ['tokens', receipt.metrics.tokens, controlReceipt.metrics.tokens],
          ['latency', receipt.metrics.latency_ms, controlReceipt.metrics.latency_ms],
          ['toolCalls', receipt.metrics.tool_calls, controlReceipt.metrics.tool_calls],
          ['errorAttempts', receipt.metrics.error_attempts, controlReceipt.metrics.error_attempts],
        ] as const)
      : [];
  const comparable = control && hasMatchingControl(run, control.run);
  const evaluation = snapshot.evaluations.find((e) => e.control_run_id === controlId);

  return (
    <section className="_evidence-section">
      <p>{t('evidence.evaluationHint')}</p>
      {(peerError || error) && (
        <Alert type="error">
          <div role="alert">{peerError || error}</div>
          <Button onClick={() => setRefresh((v) => v + 1)}>{t('evidence.retry')}</Button>
        </Alert>
      )}
      {!!peers.length && (
        <label className="_evidence-field">
          {t('evidence.controlRun')}
          <select
            disabled={peerLoading}
            value={controlId}
            onChange={(e) => setControlId(e.target.value)}
          >
            {!peers.some((p) => p.run_id === controlId) && controlId && (
              <option value={controlId}>{controlId}</option>
            )}
            {peers.map((p) => (
              <option key={p.run_id} value={p.run_id}>
                {p.run_id} · {new Date(p.created_at).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      )}
      {(peerTotal > 100 || peerPage > 0) && (
        <nav className="_evidence-actions" aria-label={t('evidence.controlPagination')}>
          <Button
            disabled={peerLoading || peerPage === 0}
            onClick={() => setPeerPage((v) => v - 1)}
          >
            {t('evidence.previous')}
          </Button>
          <span>{t('evidence.page', { page: peerPage + 1, total: peerTotal })}</span>
          <Button
            disabled={peerLoading || (peerPage + 1) * 100 >= peerTotal}
            onClick={() => setPeerPage((v) => v + 1)}
          >
            {t('evidence.next')}
          </Button>
        </nav>
      )}
      {(loading || peerLoading) && <StatusTip status="loading" />}
      {!loading && !peerLoading && !peerError && !controlId && (
        <StatusTip status="empty" emptyText={t('evidence.noControl')} />
      )}
      {control && !loading && (
        <>
          <Alert type={comparable ? 'info' : 'warning'}>
            {t(comparable ? 'evidence.matchingControls' : 'evidence.mismatchedControls')}
          </Alert>
          <p>
            {t('evidence.contamination')}:{' '}
            {t(
              evaluation?.contamination === true
                ? 'evidence.contaminated'
                : evaluation?.contamination === false
                  ? 'evidence.reportedClean'
                  : 'evidence.unknown',
            )}
          </p>
          <div className="_evidence-table-scroll">
            <table className="_evidence-table">
              <caption>{t('evidence.comparisonCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('evidence.metric')}</th>
                  <th scope="col">{t('evidence.currentRun')}</th>
                  <th scope="col">{t('evidence.controlRun')}</th>
                  <th scope="col">{t('evidence.delta')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([key, a, b]) => (
                  <tr key={key}>
                    <th scope="row">{t(`evidence.${key}`)}</th>
                    <td>{a ?? '—'}</td>
                    <td>{b ?? '—'}</td>
                    <td>{metricDelta(a, b) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {snapshot.evaluations.map((e) => (
        <details key={e.evaluation_id}>
          <summary>
            {t('evidence.evaluationRecord')} · {new Date(e.created_at).toLocaleString()}
          </summary>
          <pre className="_evidence-pre">{JSON.stringify(e, null, 2)}</pre>
        </details>
      ))}
      <p className="_evidence-note">{t('evidence.noEvaluationLaunch')}</p>
    </section>
  );
}
