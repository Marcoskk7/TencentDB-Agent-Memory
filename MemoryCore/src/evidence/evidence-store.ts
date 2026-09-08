import type { AssetAccess, AgentUsageClaim, AssetEvidenceReceipt, Behavior, CandidateAsset, CodeDiff, Evaluation, EvidenceEvent, Review, TaskRun, Validation } from "./types.js";
import { id, isoNow } from "./types.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

export interface EvidenceStore {
  createRun(run: TaskRun): Promise<TaskRun>;
  /** Creates the run and its audit-start event as one durable operation. */
  createRunIdempotent(run: TaskRun, idempotencyScope?: string, payloadJson?: string): Promise<{ run: TaskRun; created: boolean }>;
  commitIngest(kind: "access" | "behavior" | "diff" | "claim" | "validation" | "evaluation", value: AssetAccess | Behavior | CodeDiff | AgentUsageClaim | Validation | Evaluation, event: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">, idempotencyKey?: string, payloadJson?: string): Promise<{ value: AssetAccess | Behavior | CodeDiff | AgentUsageClaim | Validation | Evaluation; created: boolean }>;
  commitClose(runId: string, candidate: CandidateAsset | undefined, events: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">[], patch: Partial<TaskRun>): Promise<void>;
  saveReceipt(receipt: AssetEvidenceReceipt): Promise<AssetEvidenceReceipt>;
  getReceipt(runId: string, revision: number): Promise<AssetEvidenceReceipt | undefined>;
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
  listRuns(filter: EvidenceRunFilter): Promise<EvidenceRunPage>;
  updateCandidate(candidateId: string, patch: Pick<CandidateAsset, "status">): Promise<CandidateAsset>;
  transitionCandidate(candidateId: string, status: "approved" | "rejected"): Promise<CandidateAsset>;
  commitReview(review: Review, event: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">): Promise<Review>;
  commitCandidateReview(runId: string, candidateId: string, status: "approved" | "rejected", event: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">): Promise<CandidateAsset>;
}

export interface EvidenceRunFilter { team_id: string; task_id?: string; user_id?: string; agent_id?: string; session_id?: string; agent_source?: string; asset_id?: string; asset_type?: string; status?: TaskRun["status"]; variant?: TaskRun["variant"]; evaluation_group_id?: string; candidate_status?: CandidateAsset["status"]; review_status?: "pending" | "reviewed"; offset?: number; limit?: number; }
export interface EvidenceRunPage { items: TaskRun[]; total: number; offset: number; limit: number; }

const clone = <T>(value: T): T => structuredClone(value);
type IngestKind = "access" | "behavior" | "diff" | "claim" | "validation" | "evaluation";
type IngestValue = AssetAccess | Behavior | CodeDiff | AgentUsageClaim | Validation | Evaluation;
function ingestRecordId(kind: IngestKind, value: IngestValue): string {
  switch (kind) {
    case "access": return (value as AssetAccess).access_id;
    case "behavior": return (value as Behavior).behavior_id;
    case "diff": return (value as CodeDiff).diff_id;
    case "claim": return (value as AgentUsageClaim).claim_id;
    case "validation": return (value as Validation).validation_id;
    case "evaluation": return (value as Evaluation).evaluation_id;
  }
}

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
  readonly receipts = new Map<string, AssetEvidenceReceipt>();
  readonly runIdempotency = new Map<string, { runId: string; payloadJson: string }>();
  readonly ingestIdempotency = new Map<string, { recordId: string; payloadJson: string }>();

  async createRun(run: TaskRun) { if (this.runs.has(run.run_id)) throw new Error("run already exists"); this.runs.set(run.run_id, clone(run)); return clone(run); }
  async createRunIdempotent(run: TaskRun, scope?: string, payloadJson = "") {
    if (scope) {
      const existing = this.runIdempotency.get(scope);
      if (existing) {
        if (existing.payloadJson !== payloadJson) throw new Error("idempotency key conflicts with a different task-run payload");
        return { run: await this.getRun(existing.runId) as TaskRun, created: false };
      }
    }
    await this.createRun(run);
    await this.appendEvent({ run_id: run.run_id, type: "task_run_started", data: { run_id: run.run_id }, schema_version: 1, actor: { type: "system" }, occurred_at: run.created_at, idempotency_key: `start:${run.run_id}` });
    if (scope) this.runIdempotency.set(scope, { runId: run.run_id, payloadJson });
    return { run: clone(run), created: true };
  }
  async commitIngest(kind: "access" | "behavior" | "diff" | "claim" | "validation" | "evaluation", value: AssetAccess | Behavior | CodeDiff | AgentUsageClaim | Validation | Evaluation, event: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">, key?: string, payloadJson = "") {
    const recordId = ingestRecordId(kind, value);
    const scope = key && `${kind}:${value.run_id}:${key}`;
    if (scope) { const existing = this.ingestIdempotency.get(scope); if (existing) { if (existing.payloadJson !== payloadJson) throw new Error("idempotency key conflicts with a different payload"); return { value: this.recordFor(kind, existing.recordId), created: false }; } }
    this.storeRecord(kind, value); await this.appendEvent(event); if (scope) this.ingestIdempotency.set(scope, { recordId, payloadJson }); return { value: clone(value), created: true };
  }
  async commitClose(runId: string, candidate: CandidateAsset | undefined, events: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">[], patch: Partial<TaskRun>) { if (candidate) await this.addCandidate(candidate); for (const event of events) await this.appendEvent(event); await this.updateRun(runId, patch); }
  async saveReceipt(receipt: AssetEvidenceReceipt) { const key = `${receipt.run_id}:${receipt.revision}`; if (this.receipts.has(key)) throw new Error("receipt revision already exists"); this.receipts.set(key, clone(receipt)); return clone(receipt); }
  async getReceipt(runId: string, revision: number) { const receipt = this.receipts.get(`${runId}:${revision}`); return receipt && clone(receipt); }
  private storeRecord(kind: "access" | "behavior" | "diff" | "claim" | "validation" | "evaluation", value: AssetAccess | Behavior | CodeDiff | AgentUsageClaim | Validation | Evaluation) { const map = kind === "access" ? this.accesses : kind === "behavior" ? this.behaviors : kind === "diff" ? this.diffs : kind === "claim" ? this.claims : kind === "evaluation" ? this.evaluations : this.validations; const recordId = ingestRecordId(kind, value); if (map.has(recordId)) throw new Error(`${kind} already exists`); map.set(recordId, clone(value) as never); }
  private recordFor(kind: "access" | "behavior" | "diff" | "claim" | "validation" | "evaluation", recordId: string) { const map = kind === "access" ? this.accesses : kind === "behavior" ? this.behaviors : kind === "diff" ? this.diffs : kind === "claim" ? this.claims : kind === "evaluation" ? this.evaluations : this.validations; const value = map.get(recordId); if (!value) throw new Error("idempotency record references a missing object"); return clone(value) as AssetAccess | Behavior | CodeDiff | AgentUsageClaim | Validation | Evaluation; }
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
  async updateCandidate(candidateId: string, patch: Pick<CandidateAsset, "status">) { const v = this.candidates.get(candidateId); if (!v) throw new Error("candidate not found"); const next = { ...v, ...patch }; this.candidates.set(candidateId, next); return clone(next); }
  async transitionCandidate(candidateId: string, status: "approved" | "rejected") { const v = this.candidates.get(candidateId); if (!v) throw new Error("candidate not found"); if (v.status !== "candidate") throw new Error("candidate already reviewed"); return this.updateCandidate(candidateId, { status }); }
  async commitReview(review: Review, event: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">) { const prior = (await this.listEvents(review.run_id)).find(e => e.idempotency_key === event.idempotency_key); if (prior) return clone(this.reviews.get(prior.data.review_id as string)!); await this.addReview(review); await this.appendEvent(event); await this.updateRun(review.run_id, { receipt_revision: ((await this.getRun(review.run_id))?.receipt_revision ?? 0) + 1 }); return clone(review); }
  async commitCandidateReview(runId: string, candidateId: string, status: "approved" | "rejected", event: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">) { const next = await this.transitionCandidate(candidateId, status); await this.appendEvent(event); await this.updateRun(runId, { receipt_revision: ((await this.getRun(runId))?.receipt_revision ?? 0) + 1 }); return next; }
  async listRuns(filter: EvidenceRunFilter): Promise<EvidenceRunPage> {
    const offset = Math.max(0, filter.offset ?? 0), limit = Math.min(100, Math.max(1, filter.limit ?? 50));
    const matching = [...this.runs.values()].filter(run => {
      if (run.team_id !== filter.team_id || (filter.task_id && run.task_id !== filter.task_id) || (filter.user_id && run.user_id !== filter.user_id) || (filter.agent_id && run.agent_id !== filter.agent_id) || (filter.session_id && run.session_id !== filter.session_id) || (filter.agent_source && run.agent_source !== filter.agent_source) || (filter.status && run.status !== filter.status) || (filter.variant && run.variant !== filter.variant) || (filter.evaluation_group_id && run.evaluation_group_id !== filter.evaluation_group_id)) return false;
      const accesses = [...this.accesses.values()].filter(x => x.run_id === run.run_id);
      if (filter.asset_id && !accesses.some(x => x.asset_id === filter.asset_id)) return false;
      if (filter.asset_type && !accesses.some(x => x.asset_type === filter.asset_type)) return false;
      if (filter.review_status) {
        const reviewed = new Set([...this.reviews.values()].filter(x => x.run_id === run.run_id).map(x => x.access_id));
        if (filter.review_status === "pending" && !accesses.some(x => !reviewed.has(x.access_id))) return false;
        if (filter.review_status === "reviewed" && (!accesses.length || accesses.some(x => !reviewed.has(x.access_id)))) return false;
      }
      return !filter.candidate_status || [...this.candidates.values()].some(x => x.source_run_id === run.run_id && x.status === filter.candidate_status);
    }).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { items: matching.slice(offset, offset + limit).map(clone), total: matching.length, offset, limit };
  }
}

/** Backwards-compatible descriptive alias. */
export class MemoryEvidenceStore extends InMemoryEvidenceStore {}

/** SQLite-backed evidence documents.  The small JSON envelope keeps evidence
 * records append-only while indexed columns make the panel list query cheap. */
export class SqliteEvidenceStore implements EvidenceStore {
  private readonly db: DatabaseSync;
  constructor(dbPath: string) {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath); this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS evidence_docs (kind TEXT NOT NULL, id TEXT PRIMARY KEY, run_id TEXT, team_id TEXT, task_id TEXT, created_at TEXT NOT NULL, event_sequence INTEGER, event_key TEXT, data_json TEXT NOT NULL);");
    try { this.db.exec("ALTER TABLE evidence_docs ADD COLUMN event_sequence INTEGER"); } catch { /* already present */ }
    try { this.db.exec("ALTER TABLE evidence_docs ADD COLUMN event_key TEXT"); } catch { /* already present */ }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_evidence_docs_runs ON evidence_docs(kind, team_id, task_id, created_at); CREATE INDEX IF NOT EXISTS idx_evidence_docs_run ON evidence_docs(run_id, kind, created_at); CREATE UNIQUE INDEX IF NOT EXISTS ux_evidence_event_sequence ON evidence_docs(run_id,event_sequence) WHERE kind='event'; CREATE UNIQUE INDEX IF NOT EXISTS ux_evidence_event_key ON evidence_docs(run_id,event_key) WHERE kind='event';");
  }
  close() { this.db.close(); }
  private put(kind: string, id0: string, value: any, runId = value.run_id) { this.db.prepare("INSERT INTO evidence_docs(kind,id,run_id,team_id,task_id,created_at,data_json) VALUES(?,?,?,?,?,?,?)").run(kind, id0, runId ?? null, value.team_id ?? null, value.task_id ?? null, value.created_at ?? isoNow(), JSON.stringify(value)); return clone(value); }
  private one<T>(kind: string, id0: string): T | undefined { const r = this.db.prepare("SELECT data_json FROM evidence_docs WHERE kind=? AND id=?").get(kind, id0) as { data_json: string } | undefined; return r && JSON.parse(r.data_json) as T; }
  private many<T>(kind: string, runId: string): T[] { return (this.db.prepare("SELECT data_json FROM evidence_docs WHERE kind=? AND run_id=? ORDER BY created_at,id").all(kind, runId) as { data_json: string }[]).map(x => JSON.parse(x.data_json)); }
  async createRun(v: TaskRun) { return this.put("run", v.run_id, v, v.run_id); }
  async createRunIdempotent(v: TaskRun, scope?: string, payloadJson = "") {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (scope) {
        const previous = this.one<{ run_id: string; payload_json: string }>("run_idempotency", scope);
        if (previous) {
          if (previous.payload_json !== payloadJson) throw new Error("idempotency key conflicts with a different task-run payload");
          const run = this.one<TaskRun>("run", previous.run_id);
          if (!run) throw new Error("idempotency record references a missing run");
          this.db.exec("COMMIT");
          return { run, created: false };
        }
      }
      this.put("run", v.run_id, v, v.run_id);
      this.insertEvent({ run_id: v.run_id, type: "task_run_started", data: { run_id: v.run_id }, schema_version: 1, actor: { type: "system" }, occurred_at: v.created_at, idempotency_key: `start:${v.run_id}` });
      if (scope) this.put("run_idempotency", scope, { run_id: v.run_id, payload_json: payloadJson, created_at: v.created_at }, v.run_id);
      this.db.exec("COMMIT");
      return { run: clone(v), created: true };
    } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} throw e; }
  }
  async commitIngest(kind: "access" | "behavior" | "diff" | "claim" | "validation" | "evaluation", value: AssetAccess | Behavior | CodeDiff | AgentUsageClaim | Validation | Evaluation, event: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">, key?: string, payloadJson = "") {
    const recordId = ingestRecordId(kind, value);
    const scope = key && `${kind}:${value.run_id}:${key}`;
    this.db.exec("BEGIN IMMEDIATE"); try {
      if (scope) { const previous = this.one<{ record_id: string; payload_json: string }>("ingest_idempotency", scope); if (previous) { if (previous.payload_json !== payloadJson) throw new Error("idempotency key conflicts with a different task-run payload"); const prior = this.one<any>(kind, previous.record_id); if (!prior) throw new Error("idempotency record references a missing object"); this.db.exec("COMMIT"); return { value: prior, created: false }; } }
      const run = this.one<TaskRun>("run", value.run_id); if (!run || run.status !== "running") throw new Error("run is closed or missing");
      this.put(kind, recordId, value); this.insertEvent(event); if (scope) this.put("ingest_idempotency", scope, { record_id: recordId, payload_json: payloadJson, created_at: (value as any).created_at }, value.run_id);
      this.db.exec("COMMIT"); return { value: clone(value), created: true };
    } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} throw e; }
  }
  async commitClose(runId: string, candidate: CandidateAsset | undefined, events: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">[], patch: Partial<TaskRun>) { this.db.exec("BEGIN IMMEDIATE"); try { if (candidate) this.put("candidate", candidate.candidate_id, candidate, candidate.source_run_id); for (const event of events) this.insertEvent(event); const run = this.one<TaskRun>("run", runId); if (!run) throw new Error("run not found"); const next = { ...run, ...clone(patch) }; this.db.prepare("UPDATE evidence_docs SET team_id=?,task_id=?,data_json=? WHERE kind='run' AND id=?").run(next.team_id, next.task_id ?? null, JSON.stringify(next), runId); this.db.exec("COMMIT"); } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} throw e; } }
  async saveReceipt(receipt: AssetEvidenceReceipt) { this.put("receipt", `${receipt.run_id}:${receipt.revision}`, receipt, receipt.run_id); return clone(receipt); }
  async getReceipt(runId: string, revision: number) { return this.one<AssetEvidenceReceipt>("receipt", `${runId}:${revision}`); }
  async getRun(id0: string) { return this.one<TaskRun>("run", id0); }
  async updateRun(id0: string, patch: Partial<TaskRun>) { const v = await this.getRun(id0); if (!v) throw new Error("run not found"); const next = { ...v, ...clone(patch) }; this.db.prepare("UPDATE evidence_docs SET team_id=?,task_id=?,data_json=? WHERE kind='run' AND id=?").run(next.team_id, next.task_id ?? null, JSON.stringify(next), id0); return next; }
  async addAccess(v: AssetAccess) { return this.put("access", v.access_id, v); } async getAccess(id0: string) { return this.one<AssetAccess>("access", id0); } async listAccesses(r: string) { return this.many<AssetAccess>("access", r); }
  async addClaim(v: AgentUsageClaim) { return this.put("claim", v.claim_id, v); } async listClaims(r: string) { return this.many<AgentUsageClaim>("claim", r); }
  async addBehavior(v: Behavior) { return this.put("behavior", v.behavior_id, v); } async listBehaviors(r: string) { return this.many<Behavior>("behavior", r); }
  async addDiff(v: CodeDiff) { return this.put("diff", v.diff_id, v); } async listDiffs(r: string) { return this.many<CodeDiff>("diff", r); }
  async addValidation(v: Validation) { return this.put("validation", v.validation_id, v); } async listValidations(r: string) { return this.many<Validation>("validation", r); }
  async addReview(v: Review) { return this.put("review", v.review_id, v); } async listReviews(r: string) { return this.many<Review>("review", r); }
  async addEvaluation(v: Evaluation) { return this.put("evaluation", v.evaluation_id, v); } async listEvaluations(r: string) { return this.many<Evaluation>("evaluation", r); }
  async appendEvent(input: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.db.prepare("SELECT data_json FROM evidence_docs WHERE kind='event' AND run_id=? AND event_key=?").get(input.run_id, input.idempotency_key) as { data_json: string } | undefined;
      if (duplicate) { this.db.exec("COMMIT"); return JSON.parse(duplicate.data_json) as EvidenceEvent; }
      const run = this.one<TaskRun>("run", input.run_id);
      if (!run) throw new Error("run not found");
      if (run.status !== "running" && input.type !== "correction_recorded") throw new Error("run is closed");
      const result = this.insertEvent(input);
      if (input.type === "correction_recorded") this.bumpRevision(input.run_id);
      this.db.exec("COMMIT");
      return clone(result);
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  async listEvents(r: string) { return (this.db.prepare("SELECT data_json FROM evidence_docs WHERE kind='event' AND run_id=? ORDER BY event_sequence").all(r) as { data_json: string }[]).map(x => JSON.parse(x.data_json) as EvidenceEvent); }
  async addCandidate(v: CandidateAsset) { return this.put("candidate", v.candidate_id, v, v.source_run_id); } async listCandidates(r: string) { return this.many<CandidateAsset>("candidate", r); }
  async updateCandidate(id0: string, patch: Pick<CandidateAsset, "status">) { const v = this.one<CandidateAsset>("candidate", id0); if (!v) throw new Error("candidate not found"); const next = { ...v, ...patch }; this.db.prepare("UPDATE evidence_docs SET data_json=? WHERE kind='candidate' AND id=?").run(JSON.stringify(next), id0); return next; }
  async transitionCandidate(id0: string, status: "approved" | "rejected") { this.db.exec("BEGIN IMMEDIATE"); try { const v = this.one<CandidateAsset>("candidate", id0); if (!v) throw new Error("candidate not found"); if (v.status !== "candidate") throw new Error("candidate already reviewed"); const next = { ...v, status }; const result = this.db.prepare("UPDATE evidence_docs SET data_json=? WHERE kind='candidate' AND id=? AND json_extract(data_json,'$.status')='candidate'").run(JSON.stringify(next), id0); if (result.changes !== 1) throw new Error("candidate already reviewed"); this.db.exec("COMMIT"); return next; } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} throw e; } }
  async commitReview(review: Review, event: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">) { this.db.exec("BEGIN IMMEDIATE"); try {
    const prior = this.db.prepare("SELECT data_json FROM evidence_docs WHERE kind='event' AND run_id=? AND event_key=?").get(review.run_id, event.idempotency_key) as { data_json: string } | undefined;
    if (prior) { const previous = this.one<Review>("review", JSON.parse(prior.data_json).data.review_id)!; this.db.exec("COMMIT"); return previous; }
    this.put("review", review.review_id, review); const e = this.insertEvent(event); this.bumpRevision(review.run_id); this.db.exec("COMMIT"); return clone(review); } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} throw e; } }
  async commitCandidateReview(runId: string, id0: string, status: "approved" | "rejected", event: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">) { this.db.exec("BEGIN IMMEDIATE"); try { const v = this.one<CandidateAsset>("candidate", id0); if (!v || v.source_run_id !== runId) throw new Error("candidate not found"); if (v.status !== "candidate") throw new Error("candidate already reviewed"); const next = { ...v, status }; if (this.db.prepare("UPDATE evidence_docs SET data_json=? WHERE kind='candidate' AND id=? AND json_extract(data_json,'$.status')='candidate'").run(JSON.stringify(next), id0).changes !== 1) throw new Error("candidate already reviewed"); this.insertEvent(event); this.bumpRevision(runId); this.db.exec("COMMIT"); return next; } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} throw e; } }
  private insertEvent(input: Omit<EvidenceEvent, "event_id" | "sequence" | "received_at">) { const duplicate = this.db.prepare("SELECT data_json FROM evidence_docs WHERE kind='event' AND run_id=? AND event_key=?").get(input.run_id, input.idempotency_key) as { data_json: string } | undefined; if (duplicate) return JSON.parse(duplicate.data_json) as EvidenceEvent; const row = this.db.prepare("SELECT COALESCE(MAX(event_sequence),0)+1 AS sequence FROM evidence_docs WHERE kind='event' AND run_id=?").get(input.run_id) as { sequence: number }; const v: EvidenceEvent = { ...clone(input), event_id: id("evt"), sequence: row.sequence, received_at: isoNow() }; this.db.prepare("INSERT INTO evidence_docs(kind,id,run_id,team_id,task_id,created_at,event_sequence,event_key,data_json) VALUES('event',?,?,?,?,?,?,?,?)").run(v.event_id, v.run_id, null, null, v.received_at, v.sequence, v.idempotency_key, JSON.stringify(v)); return v; }
  private bumpRevision(runId: string) { const run = this.one<TaskRun>("run", runId); if (!run) throw new Error("run not found"); const next = { ...run, receipt_revision: (run.receipt_revision ?? 0) + 1 }; this.db.prepare("UPDATE evidence_docs SET data_json=? WHERE kind='run' AND id=?").run(JSON.stringify(next), runId); }
  async listRuns(f: EvidenceRunFilter): Promise<EvidenceRunPage> { const offset = Math.max(0, f.offset ?? 0), limit = Math.min(100, Math.max(1, f.limit ?? 50)); const all = (this.db.prepare("SELECT data_json FROM evidence_docs WHERE kind='run' AND team_id=? ORDER BY created_at DESC").all(f.team_id) as { data_json: string }[]).map(x => JSON.parse(x.data_json) as TaskRun); const items = []; for (const r of all) { if ((f.task_id && r.task_id !== f.task_id) || (f.user_id && r.user_id !== f.user_id) || (f.agent_id && r.agent_id !== f.agent_id) || (f.session_id && r.session_id !== f.session_id) || (f.agent_source && r.agent_source !== f.agent_source) || (f.status && r.status !== f.status) || (f.variant && r.variant !== f.variant) || (f.evaluation_group_id && r.evaluation_group_id !== f.evaluation_group_id)) continue; const ac = await this.listAccesses(r.run_id); if ((f.asset_id || f.asset_type) && !ac.some(x => (!f.asset_id || x.asset_id === f.asset_id) && (!f.asset_type || x.asset_type === f.asset_type))) continue; if (f.review_status) { const reviewed = new Set((await this.listReviews(r.run_id)).map(x => x.access_id)); if (f.review_status === "pending" && !ac.some(x => !reviewed.has(x.access_id))) continue; if (f.review_status === "reviewed" && (!ac.length || ac.some(x => !reviewed.has(x.access_id)))) continue; } if (f.candidate_status && !(await this.listCandidates(r.run_id)).some(x => x.status === f.candidate_status)) continue; items.push(r); } return { items: items.slice(offset, offset + limit), total: items.length, offset, limit }; }
}
