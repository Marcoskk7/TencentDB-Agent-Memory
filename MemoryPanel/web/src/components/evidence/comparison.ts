import type { TaskRun } from '../../lib/api/evidence';

/** Comparable inputs are necessary, but never sufficient to establish causality. */
export function hasMatchingControl(run: TaskRun, control: TaskRun): boolean {
  return (
    run.team_id === control.team_id &&
    !!run.task_id &&
    !!run.evaluation_group_id &&
    run.task_id === control.task_id &&
    run.evaluation_group_id === control.evaluation_group_id &&
    run.variant === 'with_assets' &&
    control.variant === 'without_assets' &&
    (
      [
        'base_commit',
        'model_fingerprint',
        'environment_fingerprint',
      ] as const
    ).every((field) => !!run[field] && run[field] === control[field])
  );
}

export function metricDelta(current: unknown, control: unknown): number | undefined {
  return typeof current === 'number' &&
    Number.isFinite(current) &&
    typeof control === 'number' &&
    Number.isFinite(control)
    ? current - control
    : undefined;
}
