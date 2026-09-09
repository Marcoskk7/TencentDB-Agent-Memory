export interface EvaluationConfig { evaluation_group_id:string; code_version:'before_evidence'|'after_evidence'; asset_mode:'without_assets'|'with_assets'; asset_selection_mode?:'automatic'|'oracle'|'none'; }
export interface EvaluationManifest { task_id:string; repo:string; base_commit:string; model_fingerprint:string; environment_fingerprint:string; timeout_ms:number; test_command:string; cells:EvaluationConfig[]; }
export function validateManifest(m: EvaluationManifest): void {
  if (!m.task_id || !m.repo || !m.base_commit || !m.model_fingerprint || !m.environment_fingerprint || !m.test_command.trim()) throw new Error('manifest is missing fixed comparability inputs');
  if (!Number.isFinite(m.timeout_ms) || m.timeout_ms <= 0) throw new Error('manifest timeout must be positive');
  if (m.cells.length !== 4) throw new Error('manifest must contain four cells');
  const expected = new Set(['before_evidence:without_assets', 'before_evidence:with_assets', 'after_evidence:without_assets', 'after_evidence:with_assets']);
  const keys = new Set(m.cells.map(c=>`${c.code_version}:${c.asset_mode}`));
  if (keys.size !== 4 || [...expected].some(key => !keys.has(key))) throw new Error('manifest cells must contain the four required combinations');
  if (m.cells.some(c=>!c.evaluation_group_id || c.evaluation_group_id !== m.cells[0]!.evaluation_group_id)) throw new Error('evaluation group mismatch');
  if (m.cells.some(c => c.asset_mode === 'without_assets' && c.asset_selection_mode && c.asset_selection_mode !== 'none')) throw new Error('control cells cannot select assets');
  if (m.cells.some(c => c.asset_mode === 'with_assets' && c.asset_selection_mode === 'none')) throw new Error('asset cells must record a selection mode');
}
export function comparisonReport(rows: Array<{cell:EvaluationConfig; metrics:Record<string,number>}>): Record<string,unknown> {
  const mean = (subset: typeof rows, metric: string) => { const values = subset.map(r => r.metrics[metric]).filter((v): v is number => Number.isFinite(v)); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined; };
  const metrics = [...new Set(rows.flatMap(r => Object.keys(r.metrics)))];
  const cell = (code_version: EvaluationConfig['code_version'], asset_mode: EvaluationConfig['asset_mode']) => rows.filter(r => r.cell.code_version === code_version && r.cell.asset_mode === asset_mode);
  const delta = (left: typeof rows, right: typeof rows) => Object.fromEntries(metrics.map(metric => [metric, { left: mean(left, metric), right: mean(right, metric), delta: (mean(right, metric) ?? 0) - (mean(left, metric) ?? 0) }]));
  const interaction = Object.fromEntries(metrics.map(metric => {
    const beforeWith = mean(cell('before_evidence', 'with_assets'), metric) ?? 0;
    const afterWith = mean(cell('after_evidence', 'with_assets'), metric) ?? 0;
    const beforeWithout = mean(cell('before_evidence', 'without_assets'), metric) ?? 0;
    const afterWithout = mean(cell('after_evidence', 'without_assets'), metric) ?? 0;
    return [metric, { delta: (afterWith - beforeWith) - (afterWithout - beforeWithout) }];
  }));
  return {
    cells: rows, preliminary: true,
    asset_effect: rows.filter(r => r.cell.asset_mode === 'with_assets'),
    instrumentation_effect: rows.filter(r => r.cell.code_version === 'after_evidence'),
    asset_effect_summary: delta(cell('before_evidence', 'without_assets'), cell('before_evidence', 'with_assets')),
    instrumentation_effect_summary: delta(cell('before_evidence', 'without_assets'), cell('after_evidence', 'without_assets')),
    interaction_effect: interaction,
  };
}
export function prepareManifest(task_id:string, repo:string, base_commit:string, model_fingerprint:string, environment_fingerprint:string, timeout_ms:number, test_command:string): EvaluationManifest {
  const group=`swebench:${task_id}:${base_commit}`; const cells:EvaluationConfig[]=[];
  for (const code_version of ['before_evidence','after_evidence'] as const) for (const asset_mode of ['without_assets','with_assets'] as const) cells.push({evaluation_group_id:group,code_version,asset_mode,asset_selection_mode:asset_mode==='with_assets'?'automatic':'none'});
  return {task_id,repo,base_commit,model_fingerprint,environment_fingerprint,timeout_ms,test_command,cells};
}
