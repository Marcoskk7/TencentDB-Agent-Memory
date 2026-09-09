import { deriveEvidenceState } from './state-derivation.js';
import type { EvidenceSnapshot } from './types.js';

export interface AssetEffectiveness {
  asset_id: string; asset_version: number;
  recalled: number; selected: number; injected: number; used: number; validated: number; contributed: number; corrected: number;
  task_successes: number; task_failures: number; successes: number; evaluations: number;
  positive_gain: number; negative_gain: number; neutral_gain: number;
  total_tokens: number; total_latency_ms: number; tool_calls: number; error_attempts: number;
  confidence: number; last_evaluated_at?: string;
  status: 'insufficient' | 'suggestive' | 'causal' | 'degraded';
}

/** Rebuild the projection from immutable run snapshots. */
export function rebuildAssetEffectiveness(snapshots: EvidenceSnapshot[]): AssetEffectiveness[] {
  const result = new Map<string, AssetEffectiveness>();
  for (const snapshot of snapshots) for (const access of snapshot.accesses) {
    const key = `${access.asset_id}:${access.version}`;
    const current = result.get(key) ?? {
      asset_id: access.asset_id, asset_version: access.version,
      recalled: 0, selected: 0, injected: 0, used: 0, validated: 0, contributed: 0, corrected: 0,
      task_successes: 0, task_failures: 0, successes: 0, evaluations: 0, positive_gain: 0, negative_gain: 0, neutral_gain: 0,
      total_tokens: 0, total_latency_ms: 0, tool_calls: 0, error_attempts: 0, confidence: 0,
      status: 'insufficient' as const,
    };
    const state = deriveEvidenceState(access, snapshot.events, snapshot.claims, snapshot.reviews, snapshot.validations, snapshot.behaviors, snapshot.diffs, snapshot.evaluations);
    if (state.recalled) current.recalled++;
    if (state.selected) current.selected++;
    if (state.injected) current.injected++;
    if (state.used) current.used++;
    if (state.validation_passed) current.validated++;
    if (state.contributed) current.contributed++;
    if (state.corrected) current.corrected++;
    const evaluations = snapshot.evaluations.filter(e => e.access_id === access.access_id);
    for (const evaluation of evaluations) {
      current.evaluations++;
      if (evaluation.task_success === true || evaluation.passed === true) { current.task_successes++; current.successes++; }
      else if (evaluation.task_success === false || evaluation.passed === false) current.task_failures++;
      if ((evaluation.gain ?? 0) > 0) current.positive_gain++;
      else if ((evaluation.gain ?? 0) < 0) current.negative_gain++;
      else current.neutral_gain++;
      current.total_tokens += evaluation.total_tokens ?? evaluation.metrics?.total_tokens ?? 0;
      current.total_latency_ms += evaluation.repair_time_ms ?? evaluation.metrics?.latency_ms ?? 0;
      current.tool_calls += evaluation.tool_calls ?? evaluation.metrics?.tool_calls ?? 0;
      current.error_attempts += evaluation.failed_attempts ?? evaluation.metrics?.failed_attempts ?? 0;
      if (!current.last_evaluated_at || evaluation.created_at > current.last_evaluated_at) current.last_evaluated_at = evaluation.created_at;
    }
    current.confidence = current.evaluations ? Math.max(0, Math.min(1, current.task_successes / current.evaluations - current.corrected * 0.1)) : 0;
    const causal = evaluations.some(e => e.comparison_verified === true && e.independent_causal_evidence === true && e.contamination !== true && (e.gain ?? 0) > 0);
    current.status = causal && current.corrected === 0 ? 'causal' : current.corrected > 0 ? 'degraded' : current.evaluations > 0 ? 'suggestive' : 'insufficient';
    result.set(key, current);
  }
  return [...result.values()].sort((a, b) => `${a.asset_id}:${a.asset_version}`.localeCompare(`${b.asset_id}:${b.asset_version}`));
}
