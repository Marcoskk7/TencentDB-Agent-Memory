import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceService } from "./evidence-service.js";
import { InMemoryEvidenceStore, SqliteEvidenceStore } from "./evidence-store.js";

describe("evidence chain", () => {
  it("derives independent recalled/selected/injected/used states", async () => {
    const svc = new EvidenceService();
    const run = await svc.createTaskRun({ team_id: "team", agent_id: "agent", user_id: "user", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "retry" });
    const access = await svc.recordAccess(run.run_id, { asset_id: "asset", asset_type: "skill", version: 3, mode: "search", reader_team_id: "team", reader_agent_id: "agent", reader_user_id: "user" });
    let receipt = await svc.getReceipt(run.run_id);
    expect(receipt.assets[0].evidence).toMatchObject({ recalled: true, selected: false, injected: false, used: false });
    await svc.appendEvent(run.run_id, "asset_selected", { access_id: access.access_id, reason: "relevant" }, "select-1");
    await svc.appendEvent(run.run_id, "asset_injected", { access_id: access.access_id }, "inject-1");
    await svc.recordDiff(run.run_id, { files: ["src/api.ts"] });
    const behavior = await svc.recordBehavior(run.run_id, { tool_name: "edit", target_files: ["src/api.ts"] });
    const claim = await svc.recordClaim(run.run_id, { access_id: access.access_id, declared_usage: "used", purpose: "backoff", files: ["src/api.ts"], behavior_refs: [behavior.behavior_id] });
    await svc.recordReview(run.run_id, { access_id: access.access_id, decision: "support", reason: "matches", behavior_refs: [behavior.behavior_id], reviewer_user_id: "user" });
    await svc.recordValidation(run.run_id, { command: "pnpm test", passed: true, exit_code: 0, validation_type: "test", claim_refs: [claim.claim_id] });
    receipt = await svc.getReceipt(run.run_id);
    expect(receipt.assets[0].evidence).toMatchObject({ recalled: true, selected: true, injected: true, declared_used: true, used: true, validation_passed: true, contributed: false });
  });

  it("is idempotent and closes runs", async () => {
    const svc = new EvidenceService();
    const run = await svc.createTaskRun({ team_id: "t", agent_id: "a", user_id: "u", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "x" });
    const first = await svc.appendEvent(run.run_id, "intent_declared", { access_id: "missing" }, "same").catch(() => undefined);
    expect(first).toBeUndefined();
    const receipt = await svc.closeTaskRun(run.run_id);
    expect(receipt.run_id).toBe(run.run_id);
    await expect(svc.recordBehavior(run.run_id, { tool_name: "x" })).rejects.toThrow("closed");
  });

  it("scopes task-run idempotency to the authenticated execution and rejects conflicting retries", async () => {
    const svc = new EvidenceService();
    const base = { agent_id: "agent", user_id: "user", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "first", idempotency_key: "retry-key" };
    const first = await svc.createTaskRun({ ...base, team_id: "team-a" });
    const retry = await svc.createTaskRun({ ...base, team_id: "team-a" });
    const otherTeam = await svc.createTaskRun({ ...base, team_id: "team-b" });
    const otherExecution = await svc.createTaskRun({ ...base, team_id: "team-a", execution_id: "e-2" });
    expect(retry.run_id).toBe(first.run_id);
    expect(otherTeam.run_id).not.toBe(first.run_id);
    expect(otherExecution.run_id).not.toBe(first.run_id);
    await expect(svc.createTaskRun({ ...base, team_id: "team-a", task_goal: "changed" })).rejects.toThrow("conflicts");
  });

  it("durably de-duplicates a task run and its start audit after SQLite reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evidence-idempotency-")); const db = join(dir, "evidence.db");
    const input = { team_id: "team", agent_id: "agent", user_id: "user", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "durable", idempotency_key: "retry-key" };
    try {
      const firstStore = new SqliteEvidenceStore(db); const first = await new EvidenceService(firstStore).createTaskRun(input); firstStore.close();
      const secondStore = new SqliteEvidenceStore(db); const secondService = new EvidenceService(secondStore); const retry = await secondService.createTaskRun(input);
      expect(retry.run_id).toBe(first.run_id);
      expect((await secondService.getSnapshot(first.run_id)).events.filter(x => x.type === "task_run_started")).toHaveLength(1);
      secondStore.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("lists only the requested team and preserves reviews added after close", async () => {
    const svc = new EvidenceService(new InMemoryEvidenceStore());
    const first = await svc.createTaskRun({ team_id: "t1", agent_id: "a", user_id: "u", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "x", task_id: "task" });
    const second = await svc.createTaskRun({ team_id: "t2", agent_id: "a", user_id: "u", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "x" });
    const access = await svc.recordAccess(first.run_id, { asset_id: "asset", asset_type: "skill", version: 1, mode: "read", reader_team_id: "t1", reader_agent_id: "a", reader_user_id: "u" });
    await svc.closeTaskRun(first.run_id);
    await svc.recordReview(first.run_id, { access_id: access.access_id, decision: "uncertain", reason: "reviewed after completion", reviewer_user_id: "reviewer" });
    const page = await svc.listTaskRuns({ team_id: "t1", task_id: "task", offset: 0, limit: 10 });
    expect(page.items.map(x => x.run_id)).toEqual([first.run_id]);
    const pending = await svc.createTaskRun({ team_id: "t1", agent_id: "a", user_id: "u", agent_source: "test", session_id: "s2", request_id: "r2", execution_id: "e2", task_goal: "pending" });
    await svc.recordAccess(pending.run_id, { asset_id: "asset-2", asset_type: "skill", version: 1, mode: "read", reader_team_id: "t1", reader_agent_id: "a", reader_user_id: "u" });
    expect((await svc.listTaskRuns({ team_id: "t1", review_status: "pending" })).items.map(x => x.run_id)).toEqual([pending.run_id]);
    expect(second.team_id).toBe("t2");
    expect((await svc.getSnapshot(first.run_id)).reviews).toHaveLength(1);
  });

  it("persists ordered events, reviews and candidates after SQLite reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evidence-")); const db = join(dir, "evidence.db");
    try {
      const store = new SqliteEvidenceStore(db); const svc = new EvidenceService(store);
      const run = await svc.createTaskRun({ team_id: "t", agent_id: "a", user_id: "u", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "x" });
      const access = await svc.recordAccess(run.run_id, { asset_id: "asset", asset_type: "skill", version: 1, mode: "read", reader_team_id: "t", reader_agent_id: "a", reader_user_id: "u" });
      await svc.appendEvent(run.run_id, "asset_selected", { access_id: access.access_id }, "event-1");
      await svc.appendEvent(run.run_id, "asset_injected", { access_id: access.access_id }, "event-2");
      await svc.recordReview(run.run_id, { access_id: access.access_id, decision: "uncertain", reason: "durable", reviewer_user_id: "r" });
      const claim = await svc.recordClaim(run.run_id, { access_id: access.access_id, declared_usage: "used", purpose: "durable" });
      await svc.closeTaskRun(run.run_id); store.close();
      const reopened = new EvidenceService(new SqliteEvidenceStore(db)); const snapshot = await reopened.getSnapshot(run.run_id);
      expect(snapshot.events.map(x => x.sequence)).toEqual([...snapshot.events.keys()].map(x => x + 1));
      expect(snapshot.reviews).toHaveLength(1); expect(snapshot.candidates).toHaveLength(1); expect(claim.claim_id).toBeTruthy();
      await reopened.reviewCandidate(run.run_id, snapshot.candidates[0]!.candidate_id, "approved", "approved", "r");
      await expect(reopened.reviewCandidate(run.run_id, snapshot.candidates[0]!.candidate_id, "rejected", "no", "r")).rejects.toThrow("already reviewed");
      expect((await reopened.getSnapshot(run.run_id)).events.at(-1)?.type).toBe("candidate_reviewed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not apply a validation linked to another asset", async () => {
    const svc = new EvidenceService();
    const run = await svc.createTaskRun({ team_id: "t", agent_id: "a", user_id: "u", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "x" });
    const one = await svc.recordAccess(run.run_id, { asset_id: "one", asset_type: "skill", version: 1, mode: "read", reader_team_id: "t", reader_agent_id: "a", reader_user_id: "u" });
    const two = await svc.recordAccess(run.run_id, { asset_id: "two", asset_type: "skill", version: 1, mode: "read", reader_team_id: "t", reader_agent_id: "a", reader_user_id: "u" });
    const claim = await svc.recordClaim(run.run_id, { access_id: one.access_id, declared_usage: "used", purpose: "x" });
    await svc.recordValidation(run.run_id, { command: "test", passed: true, exit_code: 0, validation_type: "test", claim_refs: [claim.claim_id] });
    const receipt = await svc.getReceipt(run.run_id);
    expect(receipt.assets.find(x => x.asset_id === "one")?.evidence.validation_passed).toBe(true);
    expect(receipt.assets.find(x => x.asset_id === "two")?.evidence.validation_passed).toBe(false);
  });

  it("does not accept a passed validation with a non-zero exit code", async () => {
    const svc = new EvidenceService();
    const run = await svc.createTaskRun({ team_id: "t", agent_id: "a", user_id: "u", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "x" });
    await expect(svc.recordValidation(run.run_id, { command: "test", passed: true, exit_code: 1, validation_type: "test" })).rejects.toThrow("exit code");
  });

  it("keeps immutable receipt revisions after a later review", async () => {
    const svc = new EvidenceService();
    const run = await svc.createTaskRun({ team_id: "t", agent_id: "a", user_id: "u", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "x" });
    const access = await svc.recordAccess(run.run_id, { asset_id: "asset", asset_type: "skill", version: 1, mode: "read", reader_team_id: "t", reader_agent_id: "a", reader_user_id: "u" });
    await svc.closeTaskRun(run.run_id);
    const first = await svc.getReceipt(run.run_id, 1);
    await svc.recordReview(run.run_id, { access_id: access.access_id, decision: "uncertain", reason: "later review", reviewer_user_id: "r" });
    const current = await svc.getReceipt(run.run_id);
    const historical = await svc.getReceipt(run.run_id, 1);
    expect(current.revision).toBe(2);
    expect(historical).toEqual(first);
  });

  it("only allows corrections for an event belonging to the same access", async () => {
    const svc = new EvidenceService();
    const run = await svc.createTaskRun({ team_id: "t", agent_id: "a", user_id: "u", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "x" });
    const access = await svc.recordAccess(run.run_id, { asset_id: "asset", asset_type: "skill", version: 1, mode: "read", reader_team_id: "t", reader_agent_id: "a", reader_user_id: "u" });
    const events = await svc.getSnapshot(run.run_id);
    await expect(svc.recordCorrection(run.run_id, { original_event_id: events.events.find(x => x.type === "task_run_started")!.event_id, access_id: access.access_id, reason: "wrong association", actor_id: "r" })).rejects.toThrow("does not belong");
    await expect(svc.recordCorrection(run.run_id, { original_event_id: events.events.find(x => x.data.access_id === access.access_id)!.event_id, access_id: access.access_id, reason: "correct association", actor_id: "r" })).resolves.toBeTruthy();
  });

  it("filters runs by execution identity and persists linked tool behavior metadata", async () => {
    const svc = new EvidenceService();
    const one = await svc.createTaskRun({ team_id: "t", agent_id: "a", user_id: "u", agent_source: "proxy", session_id: "s1", request_id: "r", execution_id: "e", task_goal: "x" });
    await svc.createTaskRun({ team_id: "t", agent_id: "a", user_id: "u", agent_source: "proxy", session_id: "s2", request_id: "r", execution_id: "e", task_goal: "x" });
    expect((await svc.listTaskRuns({ team_id: "t", user_id: "u", agent_id: "a", session_id: "s1", agent_source: "proxy" })).items.map(x => x.run_id)).toEqual([one.run_id]);
    const intent = await svc.recordBehavior(one.run_id, { tool_name: "shell", external_tool_use_id: "tool-1", phase: "intent" });
    const execution = await svc.recordBehavior(one.run_id, { tool_name: "shell", external_tool_use_id: "tool-1", phase: "execution", parent_behavior_id: intent.behavior_id });
    expect(execution.parent_behavior_id).toBe(intent.behavior_id);
    await expect(svc.recordBehavior(one.run_id, { tool_name: "shell", parent_behavior_id: "missing" })).rejects.toThrow("parent behavior");
  });
});
