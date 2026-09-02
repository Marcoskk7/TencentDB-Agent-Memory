import type { AssetAccess, AgentUsageClaim, Behavior, CandidateAsset, CodeDiff, Evaluation, EvidenceEvent, Review, TaskRun, Validation } from "./types.js";
import { id, isoNow } from "./types.js";

export interface EvidenceStore {
  createRun(run: TaskRun): Promise<TaskRun>;
  getRun(runId: string): Promise<TaskRun | undefined>;
  updateRun(runId: string, patch: Partial<TaskRun>): Promise<TaskRun>;
  addAccess(access: AssetAccess): Promise<AssetAccess>;
  getAccess(accessId: string): Promise<AssetAccess | undefined>;
  listAccesses(runId: string): Promise<AssetAccess[]>;
  addClaim(claim: AgentUsageClaim): Promise<AgentUsageClaim>;
  listClaims(runId: string): Promise<AgentUsageClaim[]>;
  addBehavior(behavior: Behavior): Promise<Behavior>;
  listBehaviors(runId: string): Promise<Behavior[]>;
  addDiff(diff: CodeDiff): Promise<CodeDiff>;
  listDiffs(runId: string): Promise<CodeDiff[]>;
  addValidation(validation: Validation): Promise<Validation>;
  listValidations(runId: string): Promise<Validation[]>;
  addReview(review: Review): Promise<Review>;
  listReviews(runId: string): Promise<Review[]>;
  addEvaluation(evaluation: Evaluation): Promise<Evaluation>;
  listEvaluations(runId: string): Promise<Evaluation[]>;
  appendEvent(input: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">): Promise<EvidenceEvent>;
  listEvents(runId: string): Promise<EvidenceEvent[]>;
  addCandidate(candidate: CandidateAsset): Promise<CandidateAsset>;
  listCandidates(runId: string): Promise<CandidateAsset[]>;
}

const clone = <T>(value: T): T => structuredClone(value);

/** In-process store. The service API is persistence-neutral and can be backed by SQLite later. */
export class InMemoryEvidenceStore implements EvidenceStore {
  readonly runs = new Map<string, TaskRun>();
  readonly accesses = new Map<string, AssetAccess>();
  readonly claims = new Map<string, AgentUsageClaim>();
  readonly behaviors = new Map<string, Behavior>();
  readonly diffs = new Map<string, CodeDiff>();
  readonly validations = new Map<string, Validation>();
  readonly reviews = new Map<string, Review>();
  readonly evaluations = new Map<string, Evaluation>();
  readonly events = new Map<string, EvidenceEvent[]>();
  readonly candidates = new Map<string, CandidateAsset>();

  async createRun(run: TaskRun) { if (this.runs.has(run.run_id)) throw new Error("run already exists"); this.runs.set(run.run_id, clone(run)); return clone(run); }
  async getRun(runId: string) { const v = this.runs.get(runId); return v && clone(v); }
  async updateRun(runId: string, patch: Partial<TaskRun>) { const old = this.runs.get(runId); if (!old) throw new Error("run not found"); const next = { ...old, ...clone(patch) }; this.runs.set(runId, next); return clone(next); }
  async addAccess(v: AssetAccess) { if (this.accesses.has(v.access_id)) throw new Error("access already exists"); this.accesses.set(v.access_id, clone(v)); return clone(v); }
  async getAccess(id: string) { const v = this.accesses.get(id); return v && clone(v); }
  async listAccesses(runId: string) { return [...this.accesses.values()].filter(v => v.run_id === runId).map(clone); }
  async addClaim(v: AgentUsageClaim) { if (this.claims.has(v.claim_id)) throw new Error("claim already exists"); this.claims.set(v.claim_id, clone(v)); return clone(v); }
  async listClaims(runId: string) { return [...this.claims.values()].filter(v => v.run_id === runId).map(clone); }
  async addBehavior(v: Behavior) { this.behaviors.set(v.behavior_id, clone(v)); return clone(v); }
  async listBehaviors(runId: string) { return [...this.behaviors.values()].filter(v => v.run_id === runId).map(clone); }
  async addDiff(v: CodeDiff) { this.diffs.set(v.diff_id, clone(v)); return clone(v); }
  async listDiffs(runId: string) { return [...this.diffs.values()].filter(v => v.run_id === runId).map(clone); }
  async addValidation(v: Validation) { this.validations.set(v.validation_id, clone(v)); return clone(v); }
  async listValidations(runId: string) { return [...this.validations.values()].filter(v => v.run_id === runId).map(clone); }
  async addReview(v: Review) { this.reviews.set(v.review_id, clone(v)); return clone(v); }
  async listReviews(runId: string) { return [...this.reviews.values()].filter(v => v.run_id === runId).map(clone); }
  async addEvaluation(v: Evaluation) { this.evaluations.set(v.evaluation_id, clone(v)); return clone(v); }
  async listEvaluations(runId: string) { return [...this.evaluations.values()].filter(v => v.run_id === runId).map(clone); }
  async appendEvent(input: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">) {
    const list = this.events.get(input.run_id) ?? [];
    const duplicate = list.find(e => e.idempotency_key === input.idempotency_key);
    if (duplicate) return clone(duplicate);
    const event: EvidenceEvent = { ...clone(input), event_id: id("evt"), sequence: list.length + 1, received_at: isoNow() };
    list.push(event); this.events.set(input.run_id, list); return clone(event);
  }
  async listEvents(runId: string) { return (this.events.get(runId) ?? []).map(clone); }
  async addCandidate(v: CandidateAsset) { this.candidates.set(v.candidate_id, clone(v)); return clone(v); }
  async listCandidates(runId: string) { return [...this.candidates.values()].filter(v => v.source_run_id === runId).map(clone); }
}

/** Backwards-compatible descriptive alias. */
export class MemoryEvidenceStore extends InMemoryEvidenceStore {}
