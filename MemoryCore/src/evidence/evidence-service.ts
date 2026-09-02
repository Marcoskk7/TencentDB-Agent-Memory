import { buildReceipt } from "./receipt-builder.js";
import { generateCandidate } from "./candidate-generator.js";
import { InMemoryEvidenceStore, type EvidenceStore } from "./evidence-store.js";
import type { AccessMode, AgentUsageClaim, AssetAccess, AssetEvidenceReceipt, AssetType, Behavior, CandidateAsset, CodeDiff, CreateTaskRunInput, EvidenceEvent, EvidenceEventType, EvidenceSnapshot, Evaluation, Review, TaskRun, Validation } from "./types.js";
import { id, isoNow } from "./types.js";

const MAX = 10000;
function checkText(name: string, value: unknown, max = MAX) { if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`invalid ${name}`); }

export class EvidenceService {
  private readonly runIdempotency = new Map<string, string>();
  constructor(public readonly store: EvidenceStore = new InMemoryEvidenceStore()) {}

  async createTaskRun(input: CreateTaskRunInput): Promise<TaskRun> {
    checkText("team_id", input.team_id, 200); checkText("agent_id", input.agent_id, 200); checkText("user_id", input.user_id, 200); checkText("task_goal", input.task_goal, 20000);
    if (input.idempotency_key) { const existingId = this.runIdempotency.get(input.idempotency_key); if (existingId) return (await this.run(existingId)); }
    const run: TaskRun = { ...input, run_id: id("run"), status: input.status ?? "running", created_at: isoNow(), run_kind: input.run_kind ?? "main", receipt_revision: 0 };
    if (input.idempotency_key) this.runIdempotency.set(input.idempotency_key, run.run_id);
    await this.store.createRun(run);
    await this.store.appendEvent({ run_id: run.run_id, type: "task_run_started", data: { run_id: run.run_id }, schema_version: 1, actor: { type: "system" }, occurred_at: run.created_at, idempotency_key: `start:${run.run_id}` });
    return run;
  }

  private async run(runId: string) { const run = await this.store.getRun(runId); if (!run) throw new Error("run not found"); return run; }
  private async open(runId: string) { const run = await this.run(runId); if (run.status !== "running") throw new Error("run is closed"); return run; }
  private async ensureAccess(runId: string, accessId: string) { const a = await this.store.getAccess(accessId); if (!a || a.run_id !== runId) throw new Error("access does not belong to run"); return a; }

  async recordAccess(runId: string, input: Omit<AssetAccess, "access_id" | "run_id" | "created_at">): Promise<AssetAccess> {
    const run = await this.open(runId); checkText("content_digest", input.content_digest, 300); if (!Number.isInteger(input.version) || input.version < 0) throw new Error("invalid version");
    if (input.reader_team_id !== run.team_id || input.reader_agent_id !== run.agent_id || input.reader_user_id !== run.user_id) throw new Error("reader does not belong to run");
    const access: AssetAccess = { ...input, access_id: id("acc"), run_id: runId, created_at: isoNow() };
    await this.store.addAccess(access);
    const eventType: EvidenceEventType = input.mode === "inject" ? "asset_injected" : input.mode === "read" ? "asset_read" : "asset_recalled";
    await this.appendEvent(runId, eventType, { access_id: access.access_id, asset_id: access.asset_id, version: access.version, content_digest: access.content_digest }, `access:${access.access_id}`);
    return access;
  }
  recordAssetAccess(runId: string, input: Omit<AssetAccess, "access_id" | "run_id" | "created_at">) { return this.recordAccess(runId, input); }
  recordSelection(runId: string, accessId: string, reason?: string, tokenEstimate?: number) { return this.appendEvent(runId, "asset_selected", { access_id: accessId, reason, token_estimate: tokenEstimate }, `select:${accessId}:${tokenEstimate ?? ""}`); }
  recordInjection(runId: string, accessId: string, mode: "summary" | "full" | "tool" = "summary") { return this.appendEvent(runId, "asset_injected", { access_id: accessId, mode }, `inject:${accessId}:${mode}`); }

  async appendEvent(runId: string, type: EvidenceEventType, data: Record<string, unknown>, idempotencyKey: string, actor: EvidenceEvent["actor"] = { type: "proxy" }): Promise<EvidenceEvent> {
    const run = await this.run(runId); if (run.status !== "running" && type !== "correction_recorded") throw new Error("run is closed"); checkText("idempotency_key", idempotencyKey, 500);
    if (!data || typeof data !== "object" || Array.isArray(data) || JSON.stringify(data).length > 100_000) throw new Error("invalid event data");
    const required = (key: string) => { if (typeof data[key] !== "string" || !(data[key] as string).trim()) throw new Error(`${key} required`); };
    if (["asset_selected", "asset_injected", "asset_read", "asset_recalled", "agent_declared", "intent_declared"].includes(type)) required("access_id");
    if (["behavior_observed"].includes(type)) required("behavior_id");
    if (["diff_recorded"].includes(type)) required("diff_id");
    if (["validation_recorded"].includes(type)) required("validation_id");
    if (["review_recorded"].includes(type)) required("review_id");
    if (["evaluation_recorded"].includes(type)) required("evaluation_id");
    if (["candidate_generated"].includes(type)) required("candidate_id");
    if (["asset_selected", "asset_injected", "asset_read", "asset_recalled", "agent_declared", "intent_declared", "correction_recorded"].includes(type)) { const accessId = data.access_id; if (typeof accessId !== "string") throw new Error("access_id required"); const access = await this.ensureAccess(runId, accessId); if (data.asset_id !== undefined && data.asset_id !== access.asset_id) throw new Error("asset snapshot mismatch"); if (data.version !== undefined && data.version !== access.version) throw new Error("asset snapshot mismatch"); if (data.content_digest !== undefined && data.content_digest !== access.content_digest) throw new Error("asset snapshot mismatch"); }
    if (type === "correction_recorded" && typeof data.original_event_id !== "string") throw new Error("original_event_id required");
    return this.store.appendEvent({ run_id: runId, type, data, schema_version: 1, actor, occurred_at: typeof data.occurred_at === "string" ? data.occurred_at : isoNow(), idempotency_key: idempotencyKey });
  }
  appendEvidenceEvent(runId: string, type: EvidenceEventType, data: Record<string, unknown>, idempotencyKey: string, actor?: EvidenceEvent["actor"]) { return this.appendEvent(runId, type, data, idempotencyKey, actor); }

  async recordClaim(runId: string, input: Omit<AgentUsageClaim, "claim_id" | "run_id" | "created_at">): Promise<AgentUsageClaim> {
    await this.open(runId); await this.ensureAccess(runId, input.access_id); checkText("purpose", input.purpose, 4000);
    for (const ref of [...(input.behavior_refs ?? []), ...(input.diff_refs ?? []), ...(input.validation_refs ?? []), ...(input.decision_refs ?? [])]) checkText("reference", ref, 300);
    const claim = { ...input, claim_id: id("claim"), run_id: runId, created_at: isoNow() }; await this.store.addClaim(claim);
    await this.appendEvent(runId, "agent_declared", { access_id: claim.access_id, claim_id: claim.claim_id, declared_usage: claim.declared_usage }, `claim:${claim.claim_id}`, { type: "agent" }); return claim;
  }

  async recordBehavior(runId: string, input: Omit<Behavior, "behavior_id" | "run_id" | "created_at">) { await this.open(runId); checkText("tool_name", input.tool_name, 500); const v = { ...input, behavior_id: id("beh"), run_id: runId, created_at: isoNow() }; await this.store.addBehavior(v); await this.appendEvent(runId, "behavior_observed", { behavior_id: v.behavior_id }, `behavior:${v.behavior_id}`); return v; }
  async recordDiff(runId: string, input: Omit<CodeDiff, "diff_id" | "run_id" | "created_at">) { await this.open(runId); checkText("diff_digest", input.diff_digest, 300); const v = { ...input, diff_id: id("diff"), run_id: runId, created_at: isoNow() }; await this.store.addDiff(v); await this.appendEvent(runId, "diff_recorded", { diff_id: v.diff_id }, `diff:${v.diff_id}`); return v; }
  async recordValidation(runId: string, input: Omit<Validation, "validation_id" | "run_id" | "created_at">) {
    await this.open(runId); checkText("command", input.command, 4000);
    const [claims, behaviors, diffs] = await Promise.all([this.store.listClaims(runId), this.store.listBehaviors(runId), this.store.listDiffs(runId)]);
    if ((input.claim_refs ?? []).some((r) => !claims.some((x) => x.claim_id === r)) || (input.behavior_refs ?? []).some((r) => !behaviors.some((x) => x.behavior_id === r)) || (input.diff_refs ?? []).some((r) => !diffs.some((x) => x.diff_id === r))) throw new Error("validation reference does not belong to run");
    const v = { ...input, validation_id: id("val"), run_id: runId, created_at: isoNow() }; await this.store.addValidation(v); await this.appendEvent(runId, "validation_recorded", { validation_id: v.validation_id, passed: v.passed }, `validation:${v.validation_id}`); return v;
  }
  async recordReview(runId: string, input: Omit<Review, "review_id" | "run_id" | "created_at">) { await this.open(runId); await this.ensureAccess(runId, input.access_id); checkText("reason", input.reason, 10000); const [behaviors, diffs] = await Promise.all([this.store.listBehaviors(runId), this.store.listDiffs(runId)]); if ((input.behavior_refs ?? []).some((r) => !behaviors.some((x) => x.behavior_id === r)) || (input.diff_refs ?? []).some((r) => !diffs.some((x) => x.diff_id === r))) throw new Error("review reference does not belong to run"); const v = { ...input, review_id: id("review"), run_id: runId, created_at: isoNow() }; await this.store.addReview(v); await this.appendEvent(runId, "review_recorded", { review_id: v.review_id, access_id: v.access_id, decision: v.decision }, `review:${v.review_id}`, { type: "user", id: input.reviewer_user_id }); return v; }
  async recordEvaluation(runId: string, input: Omit<Evaluation, "evaluation_id" | "run_id" | "created_at">) { await this.open(runId); const v = { ...input, evaluation_id: id("eval"), run_id: runId, created_at: isoNow() }; await this.store.addEvaluation(v); await this.appendEvent(runId, "evaluation_recorded", { evaluation_id: v.evaluation_id }, `evaluation:${v.evaluation_id}`); return v; }
  async recordCorrection(runId: string, input: { original_event_id: string; access_id: string; reason: string; actor_id: string }) {
    const events = await this.store.listEvents(runId); if (!events.some(e => e.event_id === input.original_event_id)) throw new Error("original event not found");
    await this.ensureAccess(runId, input.access_id); checkText("reason", input.reason, 10000);
    const event = await this.appendEvent(runId, "correction_recorded", input, `correction:${input.original_event_id}:${input.actor_id}`, { type: "user", id: input.actor_id });
    const run = await this.run(runId); await this.store.updateRun(runId, { receipt_revision: (run.receipt_revision ?? 0) + 1 }); return event;
  }

  async getSnapshot(runId: string): Promise<EvidenceSnapshot> { const run = await this.run(runId); return { run, accesses: await this.store.listAccesses(runId), claims: await this.store.listClaims(runId), events: await this.store.listEvents(runId), behaviors: await this.store.listBehaviors(runId), diffs: await this.store.listDiffs(runId), validations: await this.store.listValidations(runId), reviews: await this.store.listReviews(runId), evaluations: await this.store.listEvaluations(runId), candidates: await this.store.listCandidates(runId), receipt: undefined }; }
  async getReceipt(runId: string): Promise<AssetEvidenceReceipt> { const s = await this.getSnapshot(runId); return buildReceipt(s.run, s.accesses, s.claims, s.events, s.behaviors, s.diffs, s.validations, s.reviews, s.evaluations, s.run.receipt_revision || 1); }
  getEvidenceReceipt(runId: string) { return this.getReceipt(runId); }
  async closeTaskRun(runId: string, closeReason?: string): Promise<AssetEvidenceReceipt> { const run = await this.open(runId); const candidate = generateCandidate({ run, claims: await this.store.listClaims(runId), diffs: await this.store.listDiffs(runId), validations: await this.store.listValidations(runId), reviews: await this.store.listReviews(runId) }); if (candidate) { await this.store.addCandidate(candidate); await this.appendEvent(runId, "candidate_generated", { candidate_id: candidate.candidate_id }, `candidate:${candidate.candidate_id}`); } await this.appendEvent(runId, "task_run_closed", { close_reason: closeReason }, `close:${runId}`); const receipt = await this.getReceipt(runId); await this.store.updateRun(runId, { status: "completed", close_reason: closeReason, closed_at: isoNow(), receipt_revision: receipt.revision }); return receipt; }
}
