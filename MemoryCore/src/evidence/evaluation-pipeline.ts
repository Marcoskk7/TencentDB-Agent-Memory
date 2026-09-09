import type { TaskRun, RunVariant } from './types.js';

export interface EvaluationConfig {
  evaluation_group_id: string;
  code_version: 'before_evidence' | 'after_evidence';
  asset_mode: 'without_assets' | 'with_assets';
  asset_selection_mode?: 'automatic' | 'oracle' | 'none';
}

/** Checks the fixed inputs required for a four-cell comparison. */
export function comparableRuns(a: TaskRun, b: TaskRun): boolean {
  return a.task_goal === b.task_goal && a.repo === b.repo && a.base_commit === b.base_commit &&
    a.model_fingerprint === b.model_fingerprint && a.environment_fingerprint === b.environment_fingerprint &&
    !!a.workspace_id && !!b.workspace_id && a.workspace_id !== b.workspace_id;
}

export function variantFor(config: EvaluationConfig): RunVariant {
  return config.asset_mode === 'without_assets' ? 'without_assets' : config.asset_selection_mode === 'oracle' ? 'oracle' : 'with_assets';
}
