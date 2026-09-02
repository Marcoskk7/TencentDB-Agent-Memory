import { describe, expect, it } from "vitest";
import { EvidenceService } from "./evidence-service.js";

describe("evidence chain", () => {
  it("derives independent recalled/selected/injected/used states", async () => {
    const svc = new EvidenceService();
    const run = await svc.createTaskRun({ team_id: "team", agent_id: "agent", user_id: "user", agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "retry" });
    const access = await svc.recordAccess(run.run_id, { asset_id: "asset", asset_type: "skill", version: 3, content_digest: "sha256:x", mode: "search", reader_team_id: "team", reader_agent_id: "agent", reader_user_id: "user" });
    let receipt = await svc.getReceipt(run.run_id);
    expect(receipt.assets[0].evidence).toMatchObject({ recalled: true, selected: false, injected: false, used: false });
    await svc.appendEvent(run.run_id, "asset_selected", { access_id: access.access_id, reason: "relevant" }, "select-1");
    await svc.appendEvent(run.run_id, "asset_injected", { access_id: access.access_id }, "inject-1");
    const claim = await svc.recordClaim(run.run_id, { access_id: access.access_id, declared_usage: "used", purpose: "backoff", files: ["src/api.ts"] });
    await svc.recordDiff(run.run_id, { files: ["src/api.ts"], diff_digest: "sha256:d" });
    const behavior = await svc.recordBehavior(run.run_id, { tool_name: "edit", target_files: ["src/api.ts"] });
    await svc.recordReview(run.run_id, { access_id: access.access_id, decision: "support", reason: "matches", behavior_refs: [behavior.behavior_id], reviewer_user_id: "user" });
    await svc.recordValidation(run.run_id, { command: "pnpm test", passed: true, validation_type: "test", claim_refs: [claim.claim_id] });
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
});
