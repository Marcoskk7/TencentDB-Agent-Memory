import { describe, expect, it } from 'vitest';
import { hasMatchingControl, metricDelta } from '../web/src/components/evidence/comparison';
import type { TaskRun } from '../web/src/lib/api/evidence';

const run: TaskRun = {
  run_id: 'with', team_id: 'team', task_id: 'task', agent_id: 'agent', user_id: 'user',
  agent_source: 'test', session_id: 'session', request_id: 'request', execution_id: 'execution',
  task_goal: 'test', status: 'completed', created_at: '2026-09-03T00:00:00Z',
  variant: 'with_assets', evaluation_group_id: 'group', base_commit: 'base', model_fingerprint: 'model',
  environment_fingerprint: 'environment',
};
const control: TaskRun = { ...run, run_id: 'without', variant: 'without_assets' };

describe('evidence comparison', () => {
  it('requires all controlled inputs and variants to match', () => {
    expect(hasMatchingControl(run, control)).toBe(true);
    for (const key of ['team_id', 'task_id', 'evaluation_group_id', 'base_commit', 'model_fingerprint', 'environment_fingerprint'] as const) {
      expect(hasMatchingControl(run, { ...control, [key]: 'different' })).toBe(false);
    }
    for (const key of ['task_id', 'evaluation_group_id', 'base_commit', 'model_fingerprint', 'environment_fingerprint'] as const) {
      expect(hasMatchingControl({ ...run, [key]: undefined }, { ...control, [key]: undefined })).toBe(false);
    }
    expect(hasMatchingControl(control, run)).toBe(false);
    expect(hasMatchingControl(run, run)).toBe(false);
  });
  it('does not turn missing or invalid measurements into a zero', () => {
    expect(metricDelta(0, 5)).toBe(-5);
    expect(metricDelta(5, 0)).toBe(5);
    expect(metricDelta(undefined, 5)).toBeUndefined();
    expect(metricDelta(5, undefined)).toBeUndefined();
    expect(metricDelta(null, 5)).toBeUndefined();
    expect(metricDelta(NaN, 5)).toBeUndefined();
    expect(metricDelta(5, Infinity)).toBeUndefined();
  });
});
