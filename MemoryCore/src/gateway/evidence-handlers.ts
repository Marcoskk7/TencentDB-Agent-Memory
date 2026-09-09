import { EvidenceService } from "../evidence/evidence-service.js";
import { SqliteEvidenceStore } from "../evidence/evidence-store.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { EvidenceEventType } from "../evidence/types.js";
import { errorEnvelope, successEnvelope } from "./v2-router.js";
import { authenticateV3 } from "../metadata/router/auth.js";
import { resolveSqliteDbPath } from "../metadata/store/db-name.js";
import type { MetadataService } from "../metadata/service/metadata-service.js";
import { canBindAsset } from "../metadata/service/permission-checker.js";

type Handler = (body: unknown, auth: V2AuthContext, requestId: string, deps: unknown) => Promise<ApiResponseEnvelope>;
const services = new Map<string, EvidenceService>();
type EvidenceDeps = { deployMode?: "standalone" | "service"; evidenceUserKey?: string; getMetadataService?: (id: string) => Promise<MetadataService> };
async function identity(auth: V2AuthContext, deps: unknown) {
  const d = deps as EvidenceDeps;
  if (d.deployMode === "service") throw new Error("evidence persistence is not configured for service deployment");
  if (!d.getMetadataService || !d.evidenceUserKey) throw new Error("missing_user_key");
  const metadata = await d.getMetadataService(auth.serviceId); const verified = await authenticateV3(d.evidenceUserKey, metadata);
  if (!verified.ok || !verified.ctx?.userId) throw new Error(verified.reason ?? "invalid_user_key");
  return { metadata, userId: verified.ctx.userId, isSystemAdmin: verified.ctx.isSystemAdmin };
}
async function context(auth: V2AuthContext, deps: unknown, teamId: string, review = false) {
  const who = await identity(auth, deps); const member = who.isSystemAdmin ? null : await who.metadata.rawStore.getTeamMember(teamId, who.userId);
  if (!who.isSystemAdmin && (!member || member.status !== "active")) throw new Error("not a team member");
  if (review && !who.isSystemAdmin && member?.role !== "admin" && member?.role !== "reviewer") throw new Error("reviewer role required");
  return { ...who, role: member?.role };
}
const serviceFor = (auth: V2AuthContext, deps: unknown) => { let s = services.get(auth.serviceId); if (!s) { const d = deps as EvidenceDeps; if (d.deployMode === "service") throw new Error("evidence persistence is not configured for service deployment"); const base = process.env.TDAI_EVIDENCE_SQLITE_BASE_DIR ?? process.env.TDAI_METADATA_SQLITE_BASE_DIR ?? "./data/metadata"; s = new EvidenceService(new SqliteEvidenceStore(resolveSqliteDbPath(base, auth.serviceId, "tdai_metadata"))); services.set(auth.serviceId, s); } return s; };
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, any> : (() => { throw new Error("request payload must be an object"); })();
const route = async (fn: () => Promise<unknown>, id: string): Promise<ApiResponseEnvelope> => { try { return successEnvelope(await fn(), id); } catch (e) { const m = e instanceof Error ? e.message : "INVALID_EVIDENCE_REQUEST"; const status = /user_key/.test(m) ? 401 : /not configured/.test(m) ? 503 : /not a team member|reviewer role|not permitted/.test(m) ? 403 : 400; return errorEnvelope(status, m, id); } };

const createRun: Handler = (body, auth, id, deps) => route(async () => {
  const p = obj(body);
  if (typeof p.team_id !== "string" || typeof p.agent_id !== "string") throw new Error("team_id and agent_id are required");
  const who = await context(auth, deps, p.team_id); const agent = await who.metadata.rawStore.getAgentById(p.agent_id);
  if (!agent || agent.team_id !== p.team_id) throw new Error("agent does not belong to team");
  if (p.task_id !== undefined) { if (typeof p.task_id !== "string") throw new Error("task_id must be a string"); const task = await who.metadata.getTaskById(p.task_id); if (!task || task.team_id !== p.team_id) throw new Error("task does not belong to team"); }
  return serviceFor(auth, deps).createTaskRun({ ...p, user_id: who.userId, idempotency_key: p.idempotency_key } as any);
}, id);
const withRun = (name: string, fn: (s: EvidenceService, runId: string, p: Record<string, any>, userId: string, metadata: MetadataService) => Promise<unknown>, review = false): Handler => (body, auth, id, deps) => route(async () => { const p = obj(body); const runId = p.run_id; if (typeof runId !== "string") throw new Error("run_id required"); await identity(auth, deps); const s = serviceFor(auth, deps); const run = (await s.getSnapshot(runId)).run; const who = await context(auth, deps, run.team_id, review); if (!review && !who.isSystemAdmin && who.role !== "admin" && run.user_id !== who.userId) throw new Error("not permitted to mutate this run"); return fn(s, runId, p, who.userId, who.metadata); }, id);
const access = withRun("access", async (s, run, p, userId, metadata) => { const { run_id, ...input } = p; const previous = typeof input.idempotency_key === "string" ? (await s.getSnapshot(run)).accesses.find(x => x.idempotency_key === input.idempotency_key) : undefined; if (previous) return s.recordAccess(run, input as any); const asset = typeof input.asset_id === "string" ? await metadata.getAssetById(input.asset_id) : null; const taskRun = (await s.getSnapshot(run)).run; const agent = await metadata.rawStore.getAgentById(taskRun.agent_id); if (!asset || !agent || asset.status !== "approved" || asset.team_id !== taskRun.team_id || !canBindAsset(agent, asset) || (asset.visibility === "private" && asset.owner_user_id !== userId)) throw new Error("asset is not readable by this run"); if (input.asset_type !== asset.asset_type || input.version !== asset.version || (input.source_ref !== undefined && input.source_ref !== asset.source_ref)) throw new Error("asset snapshot mismatch"); let provenance: Record<string, unknown> = {}; try { provenance = asset.metadata_json ? JSON.parse(asset.metadata_json) : {}; } catch { /* retain access even if legacy metadata is not JSON */ } if (typeof provenance.candidate_id === "string" && input.source_candidate_id === undefined) input.source_candidate_id = provenance.candidate_id; if (input.name === undefined) input.name = asset.name; if (input.applicability === undefined && typeof provenance.applicability === "string") input.applicability = provenance.applicability; if (input.compatibility_risk === undefined && Array.isArray(provenance.risks)) input.compatibility_risk = provenance.risks.filter((risk): risk is string => typeof risk === "string").join("; ") || undefined; return s.recordAccess(run, input as any); });
const behavior = withRun("behavior", (s, run, p) => { const { run_id, ...input } = p; return s.recordBehavior(run, input as any); });
const diff = withRun("diff", (s, run, p) => { const { run_id, ...input } = p; return s.recordDiff(run, input as any); });
const claim = withRun("claim", (s, run, p) => { const { run_id, ...input } = p; return s.recordClaim(run, input as any); });
const review = withRun("review", (s, run, p, userId) => { const { run_id, reviewer_user_id: _ignored, ...input } = p; return s.recordReview(run, { ...input, reviewer_user_id: userId } as any); }, true);
const validation = withRun("validation", (s, run, p) => { const { run_id, ...input } = p; return s.recordValidation(run, input as any); });
const evaluation = withRun("evaluation", (s, run, p) => { const { run_id, independent_causal_evidence: _ignored, ...input } = p; return s.recordEvaluation(run, input as any); });
const correction = withRun("correction", (s, run, p, userId) => { const { run_id, actor_id: _ignored, ...input } = p; return s.recordCorrection(run, { ...input, actor_id: userId } as any); }, true);
const event = withRun("event", (s, run, p) => { const allowed = new Set(["intent_declared", "asset_selected", "asset_injected", "asset_read", "asset_recalled", "diff_unavailable", "task_close_prompted", "task_close_decision"]); if (typeof p.type !== "string" || !allowed.has(p.type) || typeof p.idempotency_key !== "string") throw new Error("invalid proxy event type"); return s.appendEvent(run, p.type as EvidenceEventType, obj(p.data), p.idempotency_key, { type: "proxy" }); });
const getSnapshot: Handler = (body, auth, id, deps) => route(async () => { const run = obj(body).run_id; if (typeof run !== "string") throw new Error("run_id required"); await identity(auth, deps); const s = serviceFor(auth, deps); await context(auth, deps, (await s.getSnapshot(run)).run.team_id); return s.getSnapshot(run); }, id);
const receipt: Handler = (body, auth, id, deps) => route(async () => { const p = obj(body); const run = p.run_id; if (typeof run !== "string") throw new Error("run_id required"); if (p.revision !== undefined && (!Number.isInteger(p.revision) || p.revision < 1)) throw new Error("invalid receipt revision"); await identity(auth, deps); const s = serviceFor(auth, deps); await context(auth, deps, (await s.getSnapshot(run)).run.team_id); return s.getReceipt(run, p.revision); }, id);
const effectiveness: Handler = (body, auth, id, deps) => route(async () => {
  const p = obj(body);
  if (typeof p.asset_id !== "string" || !p.asset_id.trim()) throw new Error("asset_id required");
  if (p.version !== undefined && (!Number.isInteger(p.version) || p.version < 1)) throw new Error("invalid asset version");
  const who = await identity(auth, deps);
  const metadata = await who.metadata.getAssetById(p.asset_id);
  if (!metadata) throw new Error("asset not found");
  await context(auth, deps, metadata.team_id);
  return serviceFor(auth, deps).getAssetEffectiveness(p.asset_id, p.version);
}, id);
const close = withRun("close", (s, run, p) => { const finalStatus = p.final_status === undefined ? "completed" : p.final_status; if (finalStatus !== "completed" && finalStatus !== "cancelled" && finalStatus !== "abandoned") throw new Error("invalid final_status"); return s.closeTaskRun(run, p.close_reason, p.idempotency_key, finalStatus); });
const list: Handler = (body, auth, id, deps) => route(async () => { const p = obj(body); if (typeof p.team_id !== "string" || !p.team_id.trim()) throw new Error("team_id required"); for (const key of ["user_id", "agent_id", "session_id", "agent_source"] as const) if (p[key] !== undefined && (typeof p[key] !== "string" || !p[key].trim())) throw new Error(`invalid ${key}`); if (p.offset !== undefined && (!Number.isInteger(p.offset) || p.offset < 0)) throw new Error("invalid offset"); if (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100)) throw new Error("invalid limit"); for (const [key, values] of Object.entries({ status: ["running", "completed", "failed", "cancelled", "abandoned"], variant: ["with_assets", "without_assets", "oracle"], candidate_status: ["candidate", "approved", "rejected"], review_status: ["pending", "reviewed"] })) if (p[key] !== undefined && !values.includes(p[key])) throw new Error(`invalid ${key}`); await context(auth, deps, p.team_id); return serviceFor(auth, deps).listTaskRuns(p); }, id);
const candidateReview = withRun("candidate-review", async (s, run, p, userId, metadata) => {
  if (typeof p.candidate_id !== "string" || (p.status !== "approved" && p.status !== "rejected") || typeof p.reason !== "string" || !p.reason.trim()) throw new Error("candidate_id, approved/rejected status and reason required");
  const requestedAssetId = typeof p.published_asset_id === "string" && p.published_asset_id.trim() ? p.published_asset_id.trim() : (typeof p.asset_id === "string" && p.asset_id.trim() ? p.asset_id.trim() : undefined);
  const reviewed = await s.reviewCandidate(run, p.candidate_id, p.status, p.reason, userId, requestedAssetId ? { asset_id: requestedAssetId } : undefined);
  if (p.status !== "approved" || reviewed.published_asset_id === undefined) return reviewed;
  const snapshot = await s.getSnapshot(run);
  const assetType = reviewed.proposed_kind === "skill" || reviewed.proposed_kind === "workflow" ? "skill" : reviewed.proposed_kind === "code_knowledge" ? "code_graph" : reviewed.proposed_kind === "product_knowledge" ? "llm_wiki" : "chat_memory";
  const provenance = { candidate_id: reviewed.candidate_id, source_run_id: reviewed.source_run_id, source_diff_ids: reviewed.source_diff_ids, source_validation_ids: reviewed.source_validation_ids, applicability: reviewed.applicability, risks: reviewed.risks ?? [], recommendation: reviewed.recommendation ?? "publish", supersedes_asset_id: reviewed.supersedes_asset_id, conflict_asset_ids: reviewed.conflict_asset_ids ?? [], deprecates_asset_ids: reviewed.deprecates_asset_ids ?? [], review_reason: p.reason };
  const existing = await metadata.getAssetById(reviewed.published_asset_id);
  let existingProvenance: Record<string, unknown> | undefined;
  try { existingProvenance = existing?.metadata_json ? JSON.parse(existing.metadata_json) : undefined; } catch { existingProvenance = undefined; }
  const samePublication = existing && existingProvenance?.candidate_id === reviewed.candidate_id;
  const desiredStatus = reviewed.recommendation === "deprecate" ? "deprecated" : "approved";
  const asset = samePublication
    ? existing
    : existing
      ? await metadata.updateAsset(existing.asset_id, { description: reviewed.content, source_type: "task_evidence_revision", source_ref: reviewed.source_run_id, version: Math.max(existing.version + 1, reviewed.version ?? 1), status: desiredStatus, confidence: reviewed.confidence, metadata_json: JSON.stringify(provenance) })
    : await metadata.createAsset({ asset_id: reviewed.published_asset_id, team_id: snapshot.run.team_id, asset_type: assetType, name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : `${reviewed.proposed_kind}:${reviewed.candidate_id}`, description: reviewed.content, owner_user_id: userId, source_type: "task_evidence", source_ref: reviewed.source_run_id, version: reviewed.version ?? 1, visibility: "team", status: desiredStatus, confidence: reviewed.confidence, metadata_json: JSON.stringify(provenance) });
  await s.store.updateCandidatePublication(reviewed.candidate_id, asset.asset_id, asset.version);
  return { ...reviewed, published_asset: asset };
}, true);

export function makeEvidenceRouteTable(): Record<string, Handler> {
  return {
    "/v3/evidence/task-runs": createRun,
    "/v3/evidence/task-runs/list": list,
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
    "/v3/evidence/assets/effectiveness": effectiveness,
    "/v3/evidence/task-runs/close": close,
    "/v3/evidence/candidates/review": candidateReview,
  };
}
