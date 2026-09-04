import { describe, expect, it } from "vitest";
import { buildReceipt } from "./receipt-builder.js";
import { deriveEvidenceState } from "./state-derivation.js";
import type { AgentUsageClaim, AssetAccess, Behavior, CodeDiff, EvidenceEvent, Review, TaskRun, Validation } from "./types.js";

const access: AssetAccess = {
  access_id: "access-a", run_id: "run-1", asset_id: "asset-a", asset_type: "skill", version: 1, mode: "read", reader_team_id: "team", reader_agent_id: "agent", reader_user_id: "user", created_at: "2026-01-01T00:00:00.000Z",
};
const claim = (overrides: Partial<AgentUsageClaim> = {}): AgentUsageClaim => ({
  claim_id: "claim-a", run_id: "run-1", access_id: "access-a", declared_usage: "used", purpose: "apply retry guidance", created_at: "2026-01-01T00:00:00.000Z", ...overrides,
});
const review = (overrides: Partial<Review> = {}): Review => ({
  review_id: "review-a", run_id: "run-1", access_id: "access-a", decision: "support", reason: "matches evidence", reviewer_user_id: "reviewer", created_at: "2026-01-01T00:00:00.000Z", ...overrides,
});
const behavior = (behavior_id: string): Behavior => ({ behavior_id, run_id: "run-1", tool_name: "edit", created_at: "2026-01-01T00:00:00.000Z" });
const diff = (diff_id: string): CodeDiff => ({ diff_id, run_id: "run-1", files: ["src/retry.ts"], created_at: "2026-01-01T00:00:00.000Z" });
const validation = (overrides: Partial<Validation> = {}): Validation => ({ validation_id: "validation-a", run_id: "run-1", command: "npm test", exit_code: 0, passed: true, validation_type: "test", created_at: "2026-01-01T00:00:00.000Z", ...overrides });
const run: TaskRun = { run_id: "run-1", team_id: "team", agent_id: "agent", user_id: "user", agent_source: "test", session_id: "session", request_id: "request", execution_id: "execution", task_goal: "test", status: "completed", created_at: "2026-01-01T00:00:00.000Z" };

describe("asset evidence derivation regression", () => {
  it("does not attribute a same-run but unclaimed behavior or validation to an asset", () => {
    const result = deriveEvidenceState(
      access,
      [],
      [claim({ behavior_refs: ["behavior-a"] })],
      [review({ behavior_refs: ["behavior-b"] })],
      [validation({ behavior_refs: ["behavior-b"] })],
      [behavior("behavior-a"), behavior("behavior-b")],
    );

    expect(result).toMatchObject({ declared_used: true, used: false, validation_passed: false, contributed: false });
  });

  it("does not let arbitrary decision reference strings prove use", () => {
    const result = deriveEvidenceState(
      access, [], [claim({ decision_refs: ["decide:retry"] })], [review({ decision_refs: ["decide:retry"] })], [],
    );

    expect(result.used).toBe(false);
  });

  it("allows an actual behavior explicitly linked back through this claim's validation", () => {
    const result = deriveEvidenceState(
      access,
      [],
      [claim()],
      [review({ behavior_refs: ["behavior-collected"] })],
      [validation({ claim_refs: ["claim-a"], behavior_refs: ["behavior-collected"], passed: false, exit_code: 1 })],
      [behavior("behavior-collected")],
    );

    expect(result).toMatchObject({ used: true, validation_passed: false });
  });

  it("keeps an unretracted not_support review rejecting despite a later support review", () => {
    const result = deriveEvidenceState(
      access,
      [],
      [claim({ behavior_refs: ["behavior-a"] })],
      [review({ review_id: "reject", decision: "not_support" }), review({ review_id: "support", behavior_refs: ["behavior-a"] })],
      [],
      [behavior("behavior-a")],
    );

    expect(result).toMatchObject({ rejected: true, used: false });
  });

  it("allows a support review after the rejecting review event is corrected", () => {
    const rejectionEvent: EvidenceEvent = {
      event_id: "event-reject", run_id: "run-1", sequence: 1, type: "review_recorded", data: { review_id: "reject", access_id: "access-a", decision: "not_support" }, schema_version: 1, occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:00.000Z", idempotency_key: "reject",
    };
    const correction: EvidenceEvent = {
      event_id: "event-correction", run_id: "run-1", sequence: 2, type: "correction_recorded", data: { access_id: "access-a", original_event_id: "event-reject", reason: "review evidence was incomplete" }, schema_version: 1, occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:00.000Z", idempotency_key: "correction",
    };
    const result = deriveEvidenceState(
      access,
      [rejectionEvent, correction],
      [claim({ diff_refs: ["diff-a"] })],
      [review({ review_id: "reject", decision: "not_support" }), review({ review_id: "support", diff_refs: ["diff-a"] })],
      [], [], [diff("diff-a")],
    );

    expect(result).toMatchObject({ rejected: false, corrected: true, used: true });
  });

  it("reports observed command counts without calling an unpaired gain suggestive", () => {
    const receipt = buildReceipt(
      run, [access], [], [], [behavior("behavior-a")], [],
      [validation({ validation_id: "failed", passed: false, exit_code: 1 })], [],
      [{ evaluation_id: "eval", run_id: "run-1", gain: 1, contamination: false, metrics: { latency_ms: 42 }, created_at: "2026-01-01T00:00:00.000Z" }],
    );

    expect(receipt.metrics).toEqual({ tool_calls: 1, error_attempts: 1 });
    expect(receipt.contribution_evidence).toBe("insufficient");
  });
});
