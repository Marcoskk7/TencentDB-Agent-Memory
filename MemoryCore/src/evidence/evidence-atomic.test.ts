import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EvidenceService } from './evidence-service.js';
import { SqliteEvidenceStore } from './evidence-store.js';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((fn) => fn()); });

async function fixture(close = true) {
  const directory = mkdtempSync(join(tmpdir(), 'evidence-atomic-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'evidence.db');
  const store = new SqliteEvidenceStore(file);
  cleanup.push(() => store.close());
  const sql = new DatabaseSync(file);
  cleanup.push(() => sql.close());
  const service = new EvidenceService(store);
  const run = await service.createTaskRun({ team_id: 't', agent_id: 'a', user_id: 'u', agent_source: 'test', session_id: 's', request_id: 'r', execution_id: 'e', task_goal: 'atomic audit' });
  const access = await service.recordAccess(run.run_id, { asset_id: 'asset', asset_type: 'skill', version: 1, mode: 'read', reader_team_id: 't', reader_agent_id: 'a', reader_user_id: 'u' });
  const behavior = await service.recordBehavior(run.run_id, { tool_name: 'edit', target_files: ['src/atomic.ts'] });
  await service.recordClaim(run.run_id, { access_id: access.access_id, declared_usage: 'used', purpose: 'test candidate generation', behavior_refs: [behavior.behavior_id] });
  if (close) await service.closeTaskRun(run.run_id);
  return { store, sql, file, service, run, access };
}

describe('durable evidence audit transactions', () => {
  it('atomically de-duplicates caller-keyed ingest across reopen and rejects a changed retry', async () => {
    const { service, file, run } = await fixture(false);
    const accessInput = { asset_id: 'asset-retry', asset_type: 'skill' as const, version: 1, mode: 'read' as const, reader_team_id: 't', reader_agent_id: 'a', reader_user_id: 'u', idempotency_key: 'access-1' };
    const access = await service.recordAccess(run.run_id, accessInput);
    const retry = await service.recordAccess(run.run_id, accessInput);
    expect(retry.access_id).toBe(access.access_id);
    await expect(service.recordAccess(run.run_id, { ...accessInput, mode: 'inject' })).rejects.toThrow('conflicts');
    const behavior = await service.recordBehavior(run.run_id, { tool_name: 'shell', idempotency_key: 'behavior-1' });
    expect((await service.recordBehavior(run.run_id, { tool_name: 'shell', idempotency_key: 'behavior-1' })).behavior_id).toBe(behavior.behavior_id);
    const diff = await service.recordDiff(run.run_id, { files: ['a.ts'], idempotency_key: 'diff-1' });
    expect((await service.recordDiff(run.run_id, { files: ['a.ts'], idempotency_key: 'diff-1' })).diff_id).toBe(diff.diff_id);
    const claim = await service.recordClaim(run.run_id, { access_id: access.access_id, declared_usage: 'used', purpose: 'retry', idempotency_key: 'claim-1' });
    expect((await service.recordClaim(run.run_id, { access_id: access.access_id, declared_usage: 'used', purpose: 'retry', idempotency_key: 'claim-1' })).claim_id).toBe(claim.claim_id);
    const validation = await service.recordValidation(run.run_id, { command: 'test', passed: false, exit_code: 1, validation_type: 'test', claim_refs: [claim.claim_id], behavior_refs: [behavior.behavior_id], diff_refs: [diff.diff_id], idempotency_key: 'validation-1' });
    expect((await service.recordValidation(run.run_id, { command: 'test', passed: false, exit_code: 1, validation_type: 'test', claim_refs: [claim.claim_id], behavior_refs: [behavior.behavior_id], diff_refs: [diff.diff_id], idempotency_key: 'validation-1' })).validation_id).toBe(validation.validation_id);
    const snapshot = await service.getSnapshot(run.run_id);
    expect(snapshot.accesses.filter(x => x.asset_id === 'asset-retry')).toHaveLength(1);
    expect(snapshot.behaviors.filter(x => x.idempotency_key === 'behavior-1')).toHaveLength(1);
    expect(snapshot.diffs.filter(x => x.idempotency_key === 'diff-1')).toHaveLength(1);
    expect(snapshot.claims.filter(x => x.idempotency_key === 'claim-1')).toHaveLength(1);
    expect(snapshot.validations.filter(x => x.idempotency_key === 'validation-1')).toHaveLength(1);
    const reopenedStore = new SqliteEvidenceStore(file); cleanup.push(() => reopenedStore.close());
    const reopened = new EvidenceService(reopenedStore);
    expect((await reopened.recordAccess(run.run_id, accessInput)).access_id).toBe(access.access_id);
  });

  it('rolls back object ingest when its audit event fails', async () => {
    const { sql, service, run } = await fixture(false);
    sql.exec("CREATE TRIGGER reject_behavior_audit BEFORE INSERT ON evidence_docs WHEN NEW.kind='event' AND json_extract(NEW.data_json,'$.type')='behavior_observed' BEGIN SELECT RAISE(ABORT, 'test behavior audit failure'); END");
    await expect(service.recordBehavior(run.run_id, { tool_name: 'shell', idempotency_key: 'behavior-1' })).rejects.toThrow('test behavior audit failure');
    expect((await service.getSnapshot(run.run_id)).behaviors).toHaveLength(1);
    sql.exec('DROP TRIGGER reject_behavior_audit');
    await service.recordBehavior(run.run_id, { tool_name: 'shell', idempotency_key: 'behavior-1' });
    expect((await service.getSnapshot(run.run_id)).behaviors).toHaveLength(2);
  });

  it('allows an idempotent close retry after the run is closed', async () => {
    const { service, run } = await fixture(false);
    const first = await service.closeTaskRun(run.run_id, 'done', 'close-1');
    const retry = await service.closeTaskRun(run.run_id, 'done', 'close-1');
    expect(retry.run_id).toBe(first.run_id);
    await expect(service.closeTaskRun(run.run_id, 'different', 'close-1')).rejects.toThrow('closed');
  });

  it('rolls back candidate, close audit, and run state when close audit insertion fails', async () => {
    const { sql, service, run } = await fixture(false);
    sql.exec("CREATE TRIGGER reject_close_audit BEFORE INSERT ON evidence_docs WHEN NEW.kind='event' AND json_extract(NEW.data_json,'$.type')='task_run_closed' BEGIN SELECT RAISE(ABORT, 'test close audit failure'); END");
    await expect(service.closeTaskRun(run.run_id, 'done', 'close-failure')).rejects.toThrow('test close audit failure');
    const rolledBack = await service.getSnapshot(run.run_id);
    expect(rolledBack.run.status).toBe('running');
    expect(rolledBack.candidates).toHaveLength(0);
    expect(rolledBack.events.some(x => x.type === 'task_run_closed' || x.type === 'candidate_generated')).toBe(false);
    sql.exec('DROP TRIGGER reject_close_audit');
    await service.closeTaskRun(run.run_id, 'done', 'close-failure');
    const closed = await service.getSnapshot(run.run_id);
    expect(closed.candidates).toHaveLength(1);
    expect(closed.events.filter(x => x.type === 'task_run_closed')).toHaveLength(1);
    expect(closed.events.filter(x => x.type === 'candidate_generated')).toHaveLength(1);
  });
  it('rolls back a candidate transition and revision if audit insertion fails', async () => {
    const { sql, service, run } = await fixture();
    const before = await service.getSnapshot(run.run_id);
    const candidate = before.candidates[0]!;
    sql.exec("CREATE TRIGGER reject_candidate_audit BEFORE INSERT ON evidence_docs WHEN NEW.kind='event' AND json_extract(NEW.data_json,'$.type')='candidate_reviewed' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END");
    await expect(service.reviewCandidate(run.run_id, candidate.candidate_id, 'approved', 'reason', 'reviewer')).rejects.toThrow('test audit failure');
    const after = await service.getSnapshot(run.run_id);
    expect(after.candidates[0]!.status).toBe('candidate');
    expect(after.run.receipt_revision).toBe(before.run.receipt_revision);
    expect(after.events).toEqual(before.events);
    sql.exec('DROP TRIGGER reject_candidate_audit');
    await service.reviewCandidate(run.run_id, candidate.candidate_id, 'approved', 'reason', 'reviewer');
    await expect(service.reviewCandidate(run.run_id, candidate.candidate_id, 'rejected', 'stale reviewer', 'other')).rejects.toThrow('already reviewed');
    expect((await service.getSnapshot(run.run_id)).events.filter((e) => e.type === 'candidate_reviewed')).toHaveLength(1);
  });

  it('rolls back a usage review if its audit insertion fails', async () => {
    const { sql, service, run, access } = await fixture();
    const before = await service.getSnapshot(run.run_id);
    sql.exec("CREATE TRIGGER reject_usage_audit BEFORE INSERT ON evidence_docs WHEN NEW.kind='event' AND json_extract(NEW.data_json,'$.type')='review_recorded' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END");
    await expect(service.recordReview(run.run_id, { access_id: access.access_id, decision: 'uncertain', reason: 'insufficient evidence', reviewer_user_id: 'reviewer' })).rejects.toThrow('test audit failure');
    const after = await service.getSnapshot(run.run_id);
    expect(after.reviews).toEqual(before.reviews);
    expect(after.events).toEqual(before.events);
    expect(after.run.receipt_revision).toBe(before.run.receipt_revision);
  });
});
