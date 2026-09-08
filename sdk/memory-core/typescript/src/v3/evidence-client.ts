import { ParamError } from "../errors.js";
import { V3HttpTransport } from "./http.js";
import type { Transport } from "../client.js";
import type { AssetAccess, AssetEvidenceReceipt, AgentUsageClaim, CreateTaskRunRequest, EvidenceSnapshot, TaskRun } from "./evidence-types.js";

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
  appendEvent(runId: string, type: string, data: Record<string, unknown>, idempotencyKey: string): Promise<unknown> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/events`, { type, data, idempotency_key: idempotencyKey }); }
  recordClaim(runId: string, p: Omit<AgentUsageClaim, "claim_id" | "run_id">): Promise<AgentUsageClaim> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/claims`, clean(p)); }
  recordReview(runId: string, p: Record<string, unknown>): Promise<unknown> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/reviews`, clean(p)); }
  recordValidation(runId: string, p: Record<string, unknown>): Promise<unknown> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/validations`, clean(p)); }
  recordEvaluation(runId: string, p: Record<string, unknown>): Promise<unknown> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/evaluations`, clean(p)); }
  recordCorrection(runId: string, p: Record<string, unknown>): Promise<unknown> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/corrections`, clean(p)); }
  private get<T>(path: string): Promise<T> {
    if (!this.http.get) throw new ParamError("EvidenceClient transport must implement GET for receipt queries");
    return this.http.get<T>(path);
  }
  getTaskRun(runId: string): Promise<EvidenceSnapshot> { return this.get(`/v3/evidence/task-runs/${encodeURIComponent(runId)}`); }
  getReceipt(runId: string): Promise<AssetEvidenceReceipt> { return this.get(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/receipt`); }
  closeTaskRun(runId: string, close_reason?: string): Promise<AssetEvidenceReceipt> { return this.http.post(`/v3/evidence/task-runs/${encodeURIComponent(runId)}/close`, clean({ close_reason })); }
}
