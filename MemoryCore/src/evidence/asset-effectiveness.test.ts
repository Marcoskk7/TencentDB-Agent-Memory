import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { rebuildAssetEffectiveness, type AssetEffectiveness } from "./asset-effectiveness.js";
import { EvidenceService } from "./evidence-service.js";
import { InMemoryEvidenceStore, SqliteEvidenceStore } from "./evidence-store.js";
import type { AgentUsageClaim, AssetAccess, Behavior, CodeDiff, EvidenceEvent, EvidenceSnapshot, Evaluation, Review, TaskRun, Validation } from "./types.js";

const run = (run_id: string, status: TaskRun["status"] = "completed"): TaskRun => ({
  run_id, team_id: "team", agent_id: "agent", user_id: "user", agent_source: "test",
  session_id: run_id, request_id: run_id, execution_id: run_id, task_goal: "repair", status,
  created_at: "2026-01-01T00:00:00.000Z",
});
const access = (asset_id: string, version: number, access_id = `${asset_id}-${version}`): AssetAccess => ({
  access_id, run_id: "run-1", asset_id, asset_type: "skill", version, mode: "read",
  reader_team_id: "team", reader_agent_id: "agent", reader_user_id: "user", token_estimate: 24,
  created_at: "2026-01-01T00:00:00.000Z",
});
const event = (event_id: string, type: EvidenceEvent["type"], data: Record<string, unknown>, sequence: number): EvidenceEvent => ({
  event_id, run_id: "run-1", sequence, type, data, schema_version: 1,
  actor: { type: "system" }, occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:00.000Z", idempotency_key: event_id,
});
const behavior: Behavior = { behavior_id: "behavior-1", run_id: "run-1", tool_name: "edit", created_at: "2026-01-01T00:00:00.000Z" };
const diff: CodeDiff = { diff_id: "diff-1", run_id: "run-1", files: ["src/retry.ts"], created_at: "2026-01-01T00:00:00.000Z" };
const claim: AgentUsageClaim = { claim_id: "claim-1", run_id: "run-1", access_id: "asset-a-1", declared_usage: "used", purpose: "apply repair", behavior_refs: ["behavior-1"], diff_refs: ["diff-1"], created_at: "2026-01-01T00:00:00.000Z" };
const review: Review = { review_id: "review-1", run_id: "run-1", access_id: "asset-a-1", decision: "support", reason: "linked change", behavior_refs: ["behavior-1"], reviewer_user_id: "reviewer", created_at: "2026-01-01T00:00:00.000Z" };
const validation: Validation = { validation_id: "validation-1", run_id: "run-1", command: "npm test", passed: true, exit_code: 0, validation_type: "test", claim_refs: ["claim-1"], behavior_refs: ["behavior-1"], created_at: "2026-01-01T00:00:00.000Z" };
const evaluation = (overrides: Partial<Evaluation> = {}): Evaluation => ({
  evaluation_id: "evaluation-1", run_id: "run-1", access_id: "asset-a-1", task_success: true,
  passed: true, gain: 1, comparison_verified: true, independent_causal_evidence: true,
  contamination: false, total_tokens: 100, repair_time_ms: 20, tool_calls: 2, failed_attempts: 1,
  created_at: "2026-01-02T00:00:00.000Z", ...overrides,
});
const snapshot = (overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot => ({
  run: run("run-1"), accesses: [access("asset-a", 1)],
  events: [
    event("recalled", "asset_recalled", { access_id: "asset-a-1" }, 1),
    event("selected", "asset_selected", { access_id: "asset-a-1" }, 2),
    event("injected", "asset_injected", { access_id: "asset-a-1" }, 3),
  ], claims: [claim], reviews: [review], validations: [validation], behaviors: [behavior], diffs: [diff], evaluations: [evaluation()], candidates: [], ...overrides,
});

describe("asset effectiveness projection", () => {
  it("rebuilds lifecycle counts and aggregate metrics", () => {
    const [result] = rebuildAssetEffectiveness([snapshot()]);
    expect(result).toMatchObject<Partial<AssetEffectiveness>>({
      asset_id: "asset-a", asset_version: 1, recalled: 1, selected: 1, injected: 1,
      used: 1, validated: 1, contributed: 1, evaluations: 1, task_successes: 1,
      successes: 1, positive_gain: 1, total_tokens: 100, total_latency_ms: 20,
      tool_calls: 2, error_attempts: 1, status: "causal",
    });
  });

  it("keeps effectiveness history isolated by asset version", () => {
    const versionTwo = snapshot({ accesses: [access("asset-a", 2, "asset-a-2")] });
    const results = rebuildAssetEffectiveness([snapshot(), versionTwo]);
    expect(results.map(item => `${item.asset_id}:${item.asset_version}`)).toEqual(["asset-a:1", "asset-a:2"]);
    expect(results.find(item => item.asset_version === 1)?.evaluations).toBe(1);
    expect(results.find(item => item.asset_version === 2)?.evaluations).toBe(0);
  });

  it("degrades confidence after a correction while retaining provenance", () => {
    const corrected = snapshot({ events: [
      event("recalled", "asset_recalled", { access_id: "asset-a-1" }, 1),
      event("correction", "correction_recorded", { access_id: "asset-a-1", original_event_id: "recalled", reason: "wrong source", actor_id: "reviewer" }, 2),
    ] });
    const [result] = rebuildAssetEffectiveness([corrected]);
    expect(result).toMatchObject({ corrected: 1, status: "degraded" });
    expect(result!.confidence).toBeLessThan(1);
    expect(corrected.events.some(item => item.event_id === "recalled")).toBe(true);
  });

  it("requires every causal gate and rejects corrected evidence", () => {
    const [causal] = rebuildAssetEffectiveness([snapshot()]);
    const [suggestive] = rebuildAssetEffectiveness([snapshot({ evaluations: [evaluation({ independent_causal_evidence: false })] })]);
    const [degraded] = rebuildAssetEffectiveness([snapshot({ events: [
      event("recalled", "asset_recalled", { access_id: "asset-a-1" }, 1),
      event("correction", "correction_recorded", { access_id: "asset-a-1", original_event_id: "recalled", reason: "wrong", actor_id: "reviewer" }, 2),
    ] })]);
    expect(causal!.status).toBe("causal");
    expect(suggestive!.status).toBe("suggestive");
    expect(degraded!.status).toBe("degraded");
  });

  it("persists and refreshes the projection through close, review, and reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asset-effectiveness-"));
    const db = join(dir, "evidence.db");
    try {
      const store = new SqliteEvidenceStore(db);
      const service = new EvidenceService(store);
      const task = await service.createTaskRun({ team_id: "team", agent_id: "agent", user_id: "user", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "repair" });
      const usedAccess = await service.recordAccess(task.run_id, { asset_id: "asset-published", asset_type: "skill", version: 1, mode: "read", reader_team_id: "team", reader_agent_id: "agent", reader_user_id: "user" });
      await service.appendEvent(task.run_id, "asset_selected", { access_id: usedAccess.access_id }, "selected");
      await service.appendEvent(task.run_id, "asset_injected", { access_id: usedAccess.access_id }, "injected");
      const usedBehavior = await service.recordBehavior(task.run_id, { tool_name: "edit", target_files: ["src/retry.ts"] });
      const usedClaim = await service.recordClaim(task.run_id, { access_id: usedAccess.access_id, declared_usage: "used", purpose: "apply repair", behavior_refs: [usedBehavior.behavior_id] });
      await service.recordReview(task.run_id, { access_id: usedAccess.access_id, decision: "support", reason: "verified", behavior_refs: [usedBehavior.behavior_id], reviewer_user_id: "reviewer" });
      await service.recordValidation(task.run_id, { command: "npm test", passed: true, exit_code: 0, validation_type: "test", claim_refs: [usedClaim.claim_id], behavior_refs: [usedBehavior.behavior_id] });
      await service.recordEvaluation(task.run_id, { access_id: usedAccess.access_id, task_success: true, passed: true, gain: 1, total_tokens: 40 });
      const receipt = await service.closeTaskRun(task.run_id, "done");
      expect(receipt.run_id).toBe(task.run_id);
      const candidate = (await service.getSnapshot(task.run_id)).candidates[0];
      expect(candidate).toBeDefined();
      await service.reviewCandidate(task.run_id, candidate!.candidate_id, "approved", "publish", "reviewer", { asset_id: "asset-published" });
      expect(await service.getAssetEffectiveness("asset-published", 1)).toMatchObject([{ used: 1, validated: 1, evaluations: 1 }]);
      store.close();
      const reopened = new EvidenceService(new SqliteEvidenceStore(db));
      expect(await reopened.getAssetEffectiveness("asset-published")).toMatchObject([{ used: 1, validated: 1, evaluations: 1 }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
