import { ParamError } from "../errors.js";
import { V3HttpTransport } from "./http.js";
import type { Transport } from "../client.js";
import type { AssetAccess, AssetEffectiveness, AssetEvidenceReceipt, AgentUsageClaim, CreateTaskRunRequest, EvidenceSnapshot, TaskRun } from "./evidence-types.js";

export interface EvidenceClientConfig { endpoint: string; apiKey: string; serviceId: string; userKey?: string; timeout?: number; rejectUnauthorized?: boolean; }
const clean = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
export class EvidenceClient {
  private readonly http: Transport;
  constructor(config: EvidenceClientConfig); constructor(transport: Transport);
  constructor(c: EvidenceClientConfig | Transport) { if ("post" in c) this.http = c; else { if (!c.apiKey || !c.serviceId) throw new ParamError("apiKey and serviceId must be provided"); this.http = new V3HttpTransport(c); } }
  createTaskRun(p: CreateTaskRunRequest): Promise<TaskRun> { return this.http.post("/v3/evidence/task-runs", clean(p)); }
  recordAccess(runId: string, p: Omit<AssetAccess, "access_id" | "run_id">): Promise<AssetAccess> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/accesses`, clean(p)); }
  recordBehavior(runId: string, p: Record<string, unknown>): Promise<unknown> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/behaviors`, clean(p)); }
  recordDiff(runId: string, p: Record<string, unknown>): Promise<unknown> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/diffs`, clean(p)); }
  appendEvent(runId: string, type: string, data: Record<string, unknown>, idempotencyKey: string): Promise<unknown> {
    if (!runId || !type || !idempotencyKey || !data || typeof data !== "object") throw new ParamError("runId, type, data and idempotencyKey are required");
    return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/events`, { type, data, idempotency_key: idempotencyKey });
  }
  recordClaim(runId: string, p: Omit<AgentUsageClaim, "claim_id" | "run_id">): Promise<AgentUsageClaim> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/claims`, clean(p)); }
  recordReview(runId: string, p: Record<string, unknown>): Promise<unknown> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/reviews`, clean(p)); }
  recordValidation(runId: string, p: Record<string, unknown>): Promise<unknown> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/validations`, clean(p)); }
  recordEvaluation(runId: string, p: Record<string, unknown>): Promise<unknown> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/evaluations`, clean(p)); }
  recordCorrection(runId: string, p: Record<string, unknown>): Promise<unknown> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/corrections`, clean(p)); }
  reviewCandidate(runId: string, p: { candidate_id: string; status: "approved" | "rejected"; reason: string; published_asset_id?: string; name?: string }): Promise<unknown> { return this.http.post("/v3/evidence/candidates/review", clean({ run_id: runId, ...p })); }
  private get<T>(path: string): Promise<T> {
    if (!this.http.get) throw new ParamError("EvidenceClient transport must implement GET for receipt queries");
    return this.http.get<T>(path);
  }
  getTaskRun(runId: string): Promise<EvidenceSnapshot> { return this.get(`/v3/evidence/task-runs/${encodeURIComponent(runId)}`); }
  getReceipt(runId: string): Promise<AssetEvidenceReceipt> { return this.get(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/receipt`); }
  getAssetEffectiveness(assetId: string, version?: number): Promise<AssetEffectiveness[]> { if (!assetId.trim()) throw new ParamError("assetId must be provided"); return this.http.post("/v3/evidence/assets/effectiveness", clean({ asset_id: assetId, version })); }
  closeTaskRun(runId: string, close_reason?: string, options?: { idempotency_key?: string; final_status?: "completed" | "cancelled" | "abandoned" }): Promise<AssetEvidenceReceipt> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/close`, clean({ close_reason, ...options })); }
}

/** CodeBuddy/Proxy lifecycle facade; keeps the CLI integration transport-agnostic. */
export class CodeBuddyEvidence {
  constructor(readonly client: EvidenceClient, readonly runId: string) {}
  access(p: Omit<AssetAccess, "access_id" | "run_id">) { return this.client.recordAccess(this.runId, p); }
  event(type: string, data: Record<string, unknown>, idempotencyKey: string) { return this.client.appendEvent(this.runId, type, data, idempotencyKey); }
  behavior(p: Record<string, unknown>) { return this.client.recordBehavior(this.runId, p); }
  diff(p: Record<string, unknown>) { return this.client.recordDiff(this.runId, p); }
  claim(p: Omit<AgentUsageClaim, "claim_id" | "run_id">) { return this.client.recordClaim(this.runId, p); }
  validation(p: Record<string, unknown>) { return this.client.recordValidation(this.runId, p); }
  async close(reason?: string, options?: { idempotency_key?: string; final_status?: "completed" | "cancelled" | "abandoned" }) { return this.client.closeTaskRun(this.runId, reason, options); }
  receipt() { return this.client.getReceipt(this.runId); }
  /** Run the complete lifecycle; failures remain explicit to callers. */
  async finish(reason?: string) { const receipt = await this.close(reason); return { receipt, text: formatEvidenceReceipt(receipt) }; }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortJson(v)]));
  return value;
}

/** Deterministic human receipt; pass `json=true` for stable machine output. */
export const formatEvidenceReceipt = (r: AssetEvidenceReceipt, json = false) => {
  if (json) return JSON.stringify(sortJson(r));
  if (!r.assets?.length) return `run=${r.run_id} revision=${r.revision}\nassets=0 used=0 validated=0 contributed=0\nNo assets used.`;
  return [`run=${r.run_id} revision=${r.revision}`, ...r.assets.map((raw: any) => {
    const a = raw ?? {}, e = a.evidence ?? {};
    const refs = [a.file_refs, a.decision_refs, a.validation_refs].filter(Boolean).flat().join(",");
    const gaps = Array.isArray(a.evidence_gaps) && a.evidence_gaps.length ? ` gaps=${a.evidence_gaps.join(";")}` : "";
    const risks = Array.isArray(a.risks) && a.risks.length ? ` risks=${a.risks.join(";")}` : "";
    const reason = a.selection_reason ? ` reason=${a.selection_reason}` : "";
    const source = a.source_ref ? ` source=${a.source_ref}` : "";
    return `${a.name ?? a.asset_id ?? "unknown"} type=${a.asset_type ?? a.type ?? "unknown"} version=${a.version ?? "?"}${source}${reason} token_estimate=${a.token_estimate ?? "?"} injected=${!!e.injected} used=${!!e.used} validated=${!!(e.validated ?? e.validation_passed)} contributed=${e.contribution_status ?? (e.contributed ? "causal" : "insufficient")}${refs ? ` refs=${refs}` : ""}${risks}${gaps}`;
  }), `summary recalled=${r.summary?.recalled ?? 0} selected=${r.summary?.selected ?? 0} injected=${r.summary?.injected ?? 0} used=${r.summary?.used ?? 0} validated=${r.summary?.validation_passed ?? 0} contributed=${r.summary?.contributed ?? 0}`].join("\n");
};
