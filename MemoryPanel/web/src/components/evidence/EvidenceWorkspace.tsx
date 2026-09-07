import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, StatusTip, Text } from 'tea-component';
import { evidenceApi, type TaskRun, type AssetAccess } from '@/lib/api/evidence';
import { EvidenceRunDetail } from './EvidenceRunDetail';
import './evidence.css';

export interface EvidenceWorkspaceProps {
  teamId: string;
  taskId?: string;
  assetId?: string;
  assetType?: AssetAccess['asset_type'];
  mode?: 'runs' | 'candidates' | 'evaluations';
}

/** Scoped views share one discovery API; evidence never changes the asset's lifecycle. */
export function EvidenceWorkspace(props: EvidenceWorkspaceProps) {
  const key = JSON.stringify(props);
  return <ScopedWorkspace key={key} {...props} />;
}

const runTitle = (goal: string) => {
  const compact = goal.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
};

function ScopedWorkspace({
  teamId,
  taskId,
  assetId,
  assetType,
  mode = 'runs',
}: EvidenceWorkspaceProps) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [candidateStatus, setCandidateStatus] = useState<'candidate' | 'approved' | 'rejected'>(
    'candidate',
  );
  const [groupInput, setGroupInput] = useState('');
  const [group, setGroup] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setRuns([]);
    if (!teamId) {
      setLoading(false);
      return;
    }
    evidenceApi
      .listRuns({
        team_id: teamId,
        task_id: taskId,
        asset_id: assetId,
        asset_type: assetType,
        limit: 12,
        offset: page * 12,
        ...(mode === 'runs' ? { review_status: 'pending' as const } : {}),
        ...(mode === 'candidates' ? { candidate_status: candidateStatus } : {}),
        ...(mode === 'evaluations' ? { variant: 'with_assets' as const } : {}),
        ...(group ? { evaluation_group_id: group } : {}),
      })
      .then((result) => {
        if (active) {
          setRuns(result.items);
          setTotal(result.total);
          if (!result.items.length && page > 0) setPage((v) => v - 1);
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
  }, [teamId, taskId, assetId, assetType, page, refresh, mode, candidateStatus, group]);

  if (!teamId) return <StatusTip status="empty" emptyText={t('evidence.selectTeam')} />;
  if (selectedId)
    return (
      <section className="_evidence-workspace">
        <div>
          <Button onClick={() => setSelectedId(undefined)}>{t('evidence.backToRuns')}</Button>
        </div>
        <EvidenceRunDetail
          key={selectedId}
          runId={selectedId}
          assetId={assetId}
          assetType={assetType}
          initialTab={mode === 'runs' ? 'assets' : mode}
          onChanged={() => setRefresh((v) => v + 1)}
        />
      </section>
    );

  return (
    <section className="_evidence-workspace" aria-label={t('evidence.title')}>
      <div className="_evidence-toolbar">
        <Text theme="weak">{t(`evidence.${mode}Hint`)}</Text>
        <Button disabled={loading} onClick={() => setRefresh((v) => v + 1)}>
          {t('evidence.refresh')}
        </Button>
      </div>
      {mode === 'candidates' && (
        <label className="_evidence-field">
          {t('evidence.candidateStatus')}
          <select
            value={candidateStatus}
            onChange={(e) => {
              setCandidateStatus(e.target.value as typeof candidateStatus);
              setPage(0);
            }}
          >
            {(['candidate', 'approved', 'rejected'] as const).map((status) => (
              <option key={status} value={status}>
                {t(`evidence.lifecycle.${status}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {mode === 'evaluations' && (
        <form
          className="_evidence-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            setGroup(groupInput.trim());
            setPage(0);
          }}
        >
          <label className="_evidence-field">
            {t('evidence.group')}
            <input
              value={groupInput}
              onChange={(e) => setGroupInput(e.target.value)}
              placeholder={t('evidence.groupPlaceholder')}
            />
          </label>
          <Button htmlType="submit">{t('evidence.filter')}</Button>
        </form>
      )}
      {error && (
        <Alert type="error">
          <div role="alert">{error}</div>
          <Button onClick={() => setRefresh((v) => v + 1)}>{t('evidence.retry')}</Button>
        </Alert>
      )}
      {loading ? (
        <div role="status">
          <StatusTip status="loading" />
        </div>
      ) : !error && runs.length === 0 ? (
        <StatusTip status="empty" emptyText={t(`evidence.${mode}Empty`)} />
      ) : (
        !error && (
          <>
            <ul className="_evidence-run-list">
              {runs.map((run) => (
                <li key={run.run_id}>
                  <button
                    type="button"
                    className="_evidence-run-row"
                    onClick={() => setSelectedId(run.run_id)}
                  >
                    <span className="_evidence-run-main">
                      <strong>{runTitle(run.task_goal)}</strong>
                      <code>{run.run_id}</code>
                    </span>
                    <span className="_evidence-run-meta">
                      <span>{t(`evidence.status.${run.status}`)}</span>
                      <span>
                        {run.variant
                          ? t(`evidence.variant.${run.variant}`)
                          : t('evidence.noVariant')}
                      </span>
                      <time dateTime={run.created_at}>
                        {new Date(run.created_at).toLocaleString()}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <nav className="_evidence-toolbar" aria-label={t('evidence.pagination')}>
              <Text theme="weak">{t('evidence.page', { page: page + 1, total })}</Text>
              <div className="_evidence-actions">
                <Button disabled={page === 0} onClick={() => setPage((v) => v - 1)}>
                  {t('evidence.previous')}
                </Button>
                <Button disabled={(page + 1) * 12 >= total} onClick={() => setPage((v) => v + 1)}>
                  {t('evidence.next')}
                </Button>
              </div>
            </nav>
          </>
        )
      )}
    </section>
  );
}
