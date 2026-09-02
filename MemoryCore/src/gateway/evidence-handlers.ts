import { EvidenceService } from "../evidence/evidence-service.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { EvidenceEventType } from "../evidence/types.js";
import { errorEnvelope, successEnvelope } from "./v2-router.js";

type Handler = (body: unknown, auth: V2AuthContext, requestId: string, deps: unknown) => Promise<ApiResponseEnvelope>;
const services = new Map<string, EvidenceService>();
const serviceFor = (auth: V2AuthContext) => { let s = services.get(auth.serviceId); if (!s) { s = new EvidenceService(); services.set(auth.serviceId, s); } return s; };
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, any> : (() => { throw new Error("request payload must be an object"); })();
const route = async (fn: () => Promise<unknown>, id: string): Promise<ApiResponseEnvelope> => { try { return successEnvelope(await fn(), id); } catch (e) { return errorEnvelope(400, e instanceof Error ? e.message : "INVALID_EVIDENCE_REQUEST", id); } };

const createRun: Handler = (body, auth, id) => route(async () => {
  const p = obj(body);
  // Team/agent/user scope is validated by the caller's auth integration. The
  // service id identifies the metadata instance, not a team id, so do not
  // incorrectly require `team_id === serviceId`.
  if (typeof p.team_id !== "string" || typeof p.agent_id !== "string" || typeof p.user_id !== "string") {
    throw new Error("team_id, agent_id and user_id are required");
  }
  return serviceFor(auth).createTaskRun({ ...p, idempotency_key: p.idempotency_key } as any);
}, id);
const withRun = (name: string, fn: (s: EvidenceService, runId: string, p: Record<string, any>) => Promise<unknown>): Handler => (body, auth, id) => route(async () => { const p = obj(body); const runId = p.run_id; if (typeof runId !== "string") throw new Error("run_id required"); return fn(serviceFor(auth), runId, p); }, id);
const access = withRun("access", (s, run, p) => { const { run_id, ...input } = p; return s.recordAccess(run, input as any); });
const behavior = withRun("behavior", (s, run, p) => { const { run_id, ...input } = p; return s.recordBehavior(run, input as any); });
const diff = withRun("diff", (s, run, p) => { const { run_id, ...input } = p; return s.recordDiff(run, input as any); });
const claim = withRun("claim", (s, run, p) => { const { run_id, ...input } = p; return s.recordClaim(run, input as any); });
const review = withRun("review", (s, run, p) => { const { run_id, ...input } = p; return s.recordReview(run, input as any); });
const validation = withRun("validation", (s, run, p) => { const { run_id, ...input } = p; return s.recordValidation(run, input as any); });
const evaluation = withRun("evaluation", (s, run, p) => { const { run_id, ...input } = p; return s.recordEvaluation(run, input as any); });
const correction = withRun("correction", (s, run, p) => { const { run_id, ...input } = p; return s.recordCorrection(run, input as any); });
const event = withRun("event", (s, run, p) => { if (typeof p.type !== "string" || typeof p.idempotency_key !== "string") throw new Error("type and idempotency_key required"); return s.appendEvent(run, p.type as EvidenceEventType, obj(p.data), p.idempotency_key, p.actor); });
const getSnapshot: Handler = (body, auth, id) => route(async () => { const run = obj(body).run_id; if (typeof run !== "string") throw new Error("run_id required"); return serviceFor(auth).getSnapshot(run); }, id);
const receipt: Handler = (body, auth, id) => route(async () => { const run = obj(body).run_id; if (typeof run !== "string") throw new Error("run_id required"); return serviceFor(auth).getReceipt(run); }, id);
const close: Handler = (body, auth, id) => route(async () => { const p = obj(body); if (typeof p.run_id !== "string") throw new Error("run_id required"); return serviceFor(auth).closeTaskRun(p.run_id, p.close_reason); }, id);

export function makeEvidenceRouteTable(): Record<string, Handler> {
  return {
    "/v3/evidence/task-runs": createRun,
    "/v3/evidence/task-runs/accesses": access,
    "/v3/evidence/task-runs/behaviors": behavior,
    "/v3/evidence/task-runs/diffs": diff,
    "/v3/evidence/task-runs/events": event,
    "/v3/evidence/task-runs/claims": claim,
    "/v3/evidence/task-runs/reviews": review,
    "/v3/evidence/task-runs/validations": validation,
    "/v3/evidence/task-runs/evaluations": evaluation,
    "/v3/evidence/task-runs/corrections": correction,
    "/v3/evidence/task-runs/get": getSnapshot,
    "/v3/evidence/task-runs/receipt": receipt,
    "/v3/evidence/task-runs/close": close,
  };
}
