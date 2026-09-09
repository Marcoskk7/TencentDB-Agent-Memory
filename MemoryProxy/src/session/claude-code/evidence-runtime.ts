import type { EvidenceProxyConfig, ProxyConfig } from "../../types.js";
import type { TdaiIdentity } from "../../tdai/types.js";
import type { ParsedUsageClaim } from "./usage-claim-parser.js";
import { extractToolResults, type ToolEvidence } from "./tool-evidence.js";
import { buildAssetSummaryBlock, buildEvidenceSystemInstruction } from "./evidence-context.js";
import { extractTaskCloseDecision, type TaskCloseDecision } from "./extractor.js";

export interface EvidenceRunContext { runId: string; accessIds: Set<string>; behaviorIds: Map<string, string>; closePrompted?: boolean; closePending?: boolean; }

const runs = new Map<string, EvidenceRunContext>();
export function clearEvidenceRunCache(): void { runs.clear(); }
const keyFor = (identity: TdaiIdentity) => `${identity.teamId}:${identity.agentId}:${identity.userId}:${identity.sessionId}`;
const stableKey = (...parts: string[]) => parts.map((part) => `${part.length}:${part}`).join("|");
const safeGoal = (value: string) => value.replace(/(?:sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|token|password)\s*[:=]\s*)\S+/gi, "[REDACTED]").slice(0, 4000);

function settings(config: ProxyConfig, serviceId?: string): EvidenceProxyConfig & { serviceId: string } | null {
  if (!config.evidence?.enabled) return null;
  const endpoint = config.evidence.endpoint || config.tdai.endpoint;
  const apiKey = config.evidence.apiKey || config.tdai.apiKey;
  const resolvedServiceId = serviceId || config.evidence.serviceId || config.tdai.serviceId;
  if (!endpoint || !apiKey || !resolvedServiceId) return null;
  return { ...config.evidence, endpoint, apiKey, serviceId: resolvedServiceId };
}

async function post<T>(cfg: EvidenceProxyConfig & { serviceId: string }, path: string, body: Record<string, unknown>, userKey?: string | null): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(`${cfg.endpoint.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
        "x-tdai-service-id": cfg.serviceId,
        ...(userKey ? { "x-tdai-user-key": userKey } : {}),
      },
      body: JSON.stringify(body), signal: abort.signal,
    });
    const envelope = await response.json() as { code?: number; message?: string; data?: T };
    if (!response.ok || envelope.code !== 0 || envelope.data === undefined) throw new Error(envelope.message ?? `evidence HTTP ${response.status}`);
    return envelope.data;
  } finally { clearTimeout(timer); }
}

/** Retry only endpoints whose payload carries a Core-enforced idempotency key. */
async function postIdempotent<T>(cfg: EvidenceProxyConfig & { serviceId: string }, path: string, body: Record<string, unknown>, userKey?: string | null): Promise<T> {
  try { return await post<T>(cfg, path, body, userKey); }
  catch (firstError) {
    // A response may have been lost after Core committed; replay is safe only
    // because create/events use the same idempotency key on both attempts.
    return post<T>(cfg, path, body, userKey).catch(() => { throw firstError; });
  }
}

/**
 * Creates/reuses only a real main/fork run. Auxiliary traffic and missing
 * authenticated/session identity deliberately produce no evidence context.
 * Runs are never closed here: workspace capture or an explicit close hook owns
 * final diff/validation collection.
 */
export async function ensureEvidenceRun(input: {
  config: ProxyConfig; identity: TdaiIdentity | null; requestKind: string;
  taskGoal: string; agentSource: string; serviceId?: string; requestId: string; userKey?: string | null;
}): Promise<EvidenceRunContext | null> {
  const cfg = settings(input.config, input.serviceId);
  if (!cfg || !input.identity || (input.requestKind !== "main" && input.requestKind !== "fork") || !input.taskGoal.trim()) return null;
  const sessionKey = `${cfg.serviceId}:${keyFor(input.identity)}`;
  const main = runs.get(sessionKey);
  // Core is the source of truth across proxy restarts and explicit closes.
  // Filter all identity dimensions locally because the current list contract
  // only filters team/status.
  const running = await post<{ items?: Array<{ run_id: string; user_id: string; agent_id: string; session_id: string; agent_source: string }> }>(cfg, "/v3/evidence/task-runs/list", { team_id: input.identity.teamId, user_id: input.identity.userId, agent_id: input.identity.agentId, session_id: input.identity.sessionId, agent_source: input.agentSource, status: "running", limit: 100 }, input.userKey);
  const recovered = running.items?.find((run) => run.user_id === input.identity!.userId && run.agent_id === input.identity!.agentId && run.session_id === input.identity!.sessionId && run.agent_source === input.agentSource && (run as { run_kind?: string }).run_kind === "main");
  if (recovered && input.requestKind === "main") {
    const context = main?.runId === recovered.run_id ? main : { runId: recovered.run_id, accessIds: new Set<string>(), behaviorIds: new Map<string, string>(), closePrompted: false, closePending: false };
    if (context !== main) {
      const snapshot = await post<{ accesses?: Array<{ access_id: string }>; behaviors?: Array<{ behavior_id: string; external_tool_use_id?: string; phase?: string }>; events?: Array<{ type?: string; data?: Record<string, unknown> }> }>(cfg, "/v3/evidence/task-runs/get", { run_id: recovered.run_id }, input.userKey);
      for (const access of snapshot.accesses ?? []) context.accessIds.add(access.access_id);
      for (const behavior of snapshot.behaviors ?? []) if (behavior.phase === "intent" && behavior.external_tool_use_id) context.behaviorIds.set(behavior.external_tool_use_id, behavior.behavior_id);
      context.closePrompted = (snapshot.events ?? []).some((event) => event.type === "task_close_prompted");
      context.closePending = context.closePrompted && !(snapshot.events ?? []).some((event) => event.type === "task_close_decision");
    }
    runs.set(sessionKey, context); runs.set(`${sessionKey}:main`, context); return context;
  }
  const executionId = input.requestKind === "main" ? `main:${input.requestId}` : `fork:${stableKey(input.requestId, input.taskGoal).slice(0, 20)}`;
  const cacheKey = `${sessionKey}:${executionId}`;
  const cached = runs.get(cacheKey);
  if (cached) return cached;
  const run = await postIdempotent<{ run_id: string }>(cfg, "/v3/evidence/task-runs", {
    team_id: input.identity.teamId, agent_id: input.identity.agentId, user_id: input.identity.userId,
    agent_source: input.agentSource, session_id: input.identity.sessionId, request_id: input.requestId,
    execution_id: executionId, task_id: input.identity.taskId, task_goal: safeGoal(input.taskGoal),
    run_kind: input.requestKind, parent_run_id: input.requestKind === "fork" ? (main?.runId ?? recovered?.run_id) : undefined,
    idempotency_key: stableKey(sessionKey, executionId),
  }, input.userKey);
  const context = { runId: run.run_id, accessIds: new Set<string>(), behaviorIds: new Map<string, string>(), closePrompted: false, closePending: false };
  runs.set(cacheKey, context);
  if (input.requestKind === "main") runs.set(sessionKey, context);
  // Proxy has no workspace. Make the gap explicit once rather than inventing a diff.
  await appendEvent(cfg, context.runId, "diff_unavailable", { reason: "workspace_not_available_to_proxy" }, stableKey(context.runId, "diff_unavailable"), input.userKey).catch((err) => console.warn("[evidence] diff_unavailable event failed:", err instanceof Error ? err.message : String(err)));
  return context;
}

async function appendEvent(cfg: EvidenceProxyConfig & { serviceId: string }, runId: string, type: string, data: Record<string, unknown>, idempotencyKey: string, userKey?: string | null): Promise<void> {
  await postIdempotent(cfg, `/v3/evidence/task-runs/${encodeURIComponent(runId)}/events`, { type, data, idempotency_key: idempotencyKey }, userKey);
}

export function appendEvidenceEvent(config: ProxyConfig, context: EvidenceRunContext | null, serviceId: string | undefined, type: string, data: Record<string, unknown>, idempotencyKey: string, userKey?: string | null): Promise<void> {
  const cfg = settings(config, serviceId);
  if (!cfg || !context) return Promise.resolve();
  return appendEvent(cfg, context.runId, type, data, idempotencyKey, userKey);
}

export async function recordEvidenceToolResults(config: ProxyConfig, context: EvidenceRunContext | null, serviceId: string | undefined, userKey: string | null | undefined, messages: unknown[]): Promise<void> {
  const cfg = settings(config, serviceId); if (!cfg || !context) return;
  const results = extractToolResults(messages);
  for (const result of results) {
    if (context.closePending) {
      const decision = extractTaskCloseDecision(result.result);
      if (decision) {
        await applyTaskCloseDecision(cfg, context, decision, userKey);
        continue;
      }
    }
    const prior = context.behaviorIds.get(result.tool_use_id);
    if (!prior) { console.warn(`[evidence] tool_result ${result.tool_use_id} has no same-run intent; skipped`); continue; }
    try {
      const behavior = await postIdempotent<{ behavior_id: string }>(cfg, `/v3/evidence/task-runs/${encodeURIComponent(context.runId)}/behaviors`, {
        tool_name: "tool_result", external_tool_use_id: result.tool_use_id, phase: "execution", parent_behavior_id: prior, command_summary: `result for ${prior}`, result_summary: `tool result status=${result.result_status}; execution_status=unknown`,
        idempotency_key: stableKey(context.runId, "result", result.tool_use_id, result.result),
      }, userKey);
      context.behaviorIds.set(`${result.tool_use_id}:result`, behavior.behavior_id);
    } catch (err) { console.warn("[evidence] tool result write failed:", err instanceof Error ? err.message : String(err)); }
  }
}

async function applyTaskCloseDecision(cfg: EvidenceProxyConfig & { serviceId: string }, context: EvidenceRunContext, decision: TaskCloseDecision, userKey?: string | null): Promise<void> {
  await appendEvent(cfg, context.runId, "task_close_decision", { decision }, `task-close-decision:${context.runId}:${decision}`, userKey);
  if (decision === "continue") {
    context.closePending = false;
    context.closePrompted = true;
    return;
  }
  const finalStatus = decision === "complete" ? "completed" : "cancelled";
  await postIdempotent(cfg, "/v3/evidence/task-runs/close", {
    run_id: context.runId,
    final_status: finalStatus,
    close_reason: decision === "complete" ? "user_confirmed_task_complete" : "user_cancelled_task_close",
    idempotency_key: `task-close:${context.runId}:${finalStatus}`,
  }, userKey);
  context.closePending = false;
  context.closePrompted = true;
}

export async function recordEvidenceResponse(config: ProxyConfig, context: EvidenceRunContext | null, serviceId: string | undefined, userKey: string | null | undefined, tools: ToolEvidence[], claims: ParsedUsageClaim[]): Promise<void> {
  const cfg = settings(config, serviceId); if (!cfg || !context) return;
  for (const tool of tools) {
    try {
      const behavior = await postIdempotent<{ behavior_id: string }>(cfg, `/v3/evidence/task-runs/${encodeURIComponent(context.runId)}/behaviors`, {
        tool_name: tool.tool_name, external_tool_use_id: tool.tool_use_id, phase: "intent", command_summary: "tool intent captured",
        idempotency_key: stableKey(context.runId, "intent", tool.tool_use_id, tool.tool_name, tool.input_json),
      }, userKey);
      context.behaviorIds.set(tool.tool_use_id, behavior.behavior_id);
    } catch (err) { console.warn("[evidence] tool intent write failed:", err instanceof Error ? err.message : String(err)); }
  }
  for (const claim of claims.filter((claim) => context.accessIds.has(claim.access_id))) {
    const behaviorRefs = claim.behavior_refs?.map((ref) => context.behaviorIds.get(ref)).filter((ref): ref is string => Boolean(ref));
    if ((claim.behavior_refs?.length ?? 0) !== (behaviorRefs?.length ?? 0)) { console.warn(`[evidence] claim has foreign/unresolved behavior refs; skipped access=${claim.access_id}`); continue; }
    try { await postIdempotent(cfg, `/v3/evidence/task-runs/${encodeURIComponent(context.runId)}/claims`, {
      ...claim, behavior_refs: behaviorRefs, idempotency_key: stableKey(context.runId, "claim", claim.access_id, claim.declared_usage, claim.purpose),
    }, userKey); } catch (err) { console.warn("[evidence] claim write failed:", err instanceof Error ? err.message : String(err)); }
  }
}

export function evidenceRunId(context: EvidenceRunContext | null): string | null { return context?.runId ?? null; }

/**
 * Resolve fixed skill bindings through Core's ACL-filtered metadata API, then
 * read the exact skill version/content from Core and derive its digest locally.
 * The metadata binding is the explicit allow-list; no configured text or
 * caller-provided version/digest is trusted as an asset snapshot.
 */
export async function injectApprovedSkillSnapshots(config: ProxyConfig, context: EvidenceRunContext | null, identity: TdaiIdentity | null, serviceId: string | undefined, userKey: string | null | undefined): Promise<string> {
  const cfg = settings(config, serviceId);
  if (!cfg || !context || !identity || !config.coreSkill.endpoint || !config.coreSkill.serviceToken) return "";
  const { getMetadataClient } = await import("../../meta/client.js");
  const metadata = getMetadataClient(config.coreSkill, serviceId || config.coreSkill.serviceId, userKey || "");
  const fixed = await metadata.getAgentFixedAssets(identity.agentId);
  const allowed = fixed.items.filter((item) => item.asset_type === "skill" && item.status === "approved" &&
    (cfg.assetIds.length === 0 || cfg.assetIds.includes(item.asset_id))).slice(0, 8);
  const blocks: string[] = [];
  for (const item of allowed) {
    try {
    const skill = await readSkill(config, identity, serviceId, userKey, item.asset_id);
    if (!skill || !skill.content || !Number.isInteger(skill.version)) continue;
    const access = await postIdempotent<{ access_id: string }>(cfg, `/v3/evidence/task-runs/${encodeURIComponent(context.runId)}/accesses`, {
      asset_id: item.asset_id, asset_type: "skill", version: skill.version,
      source_ref: typeof skill.source_ref === "string" ? skill.source_ref : undefined, mode: "read",
      reader_team_id: identity.teamId, reader_agent_id: identity.agentId, reader_user_id: identity.userId,
      name: typeof item.name === "string" ? item.name : undefined,
      applicability: typeof item.description === "string" ? item.description : undefined,
      selection_reason: "approved fixed asset binding",
      token_estimate: Math.ceil(skill.content.length / 4),
      idempotency_key: stableKey(context.runId, item.asset_id, String(skill.version), "access"),
    }, userKey);
    context.accessIds.add(access.access_id);
    const snapshot = { access_id: access.access_id, asset_id: item.asset_id, asset_type: "skill", version: skill.version,
      summary: (item.description || skill.content.slice(0, 800)).slice(0, 1200), read_path: item.name ? `使用现有skill_tools中的skill_view，body=${JSON.stringify({ skill_name: item.name, version: skill.version, include_content: true })}；沿用该工具已有的URL、鉴权及会话参数。` : undefined };
    const eventData = { access_id: access.access_id, asset_id: item.asset_id, version: skill.version };
    const selectionData = { ...eventData, reason: "approved fixed asset binding", token_estimate: Math.ceil(skill.content.length / 4) };
    await appendEvent(cfg, context.runId, "asset_recalled", eventData, stableKey(context.runId, access.access_id, "recalled"), userKey);
    await appendEvent(cfg, context.runId, "asset_selected", selectionData, stableKey(context.runId, access.access_id, "selected"), userKey);
    blocks.push(buildAssetSummaryBlock(snapshot));
    await appendEvent(cfg, context.runId, "asset_injected", eventData, stableKey(context.runId, access.access_id, "injected"), userKey);
    } catch (error) {
      // A later asset/read failure must not discard already prepared blocks
      // whose injection facts have been recorded. Keep partial success honest.
      console.warn("[evidence] skill snapshot preparation failed:", error instanceof Error ? error.message : String(error));
    }
  }
  return blocks.length ? `${blocks.join("\n")}\n${buildEvidenceSystemInstruction()}` : "";
}

async function readSkill(config: ProxyConfig, identity: TdaiIdentity, serviceId: string | undefined, userKey: string | null | undefined, skillId: string): Promise<{ version: number; content: string; source_ref?: string } | null> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.coreSkill.timeoutMs);
  try {
    const response = await fetch(`${config.coreSkill.endpoint.replace(/\/+$/, "")}/v3/skill/get`, {
      method: "POST", signal: controller.signal,
      headers: { authorization: `Bearer ${config.coreSkill.serviceToken}`, "content-type": "application/json", "x-tdai-service-id": serviceId || config.coreSkill.serviceId, ...(userKey ? { "x-tdai-user-key": userKey } : {}) },
      body: JSON.stringify({ team_id: identity.teamId, agent_id: identity.agentId, task_id: identity.taskId, skill_id: skillId, include_content: true, include_manifest: false }),
    });
    const envelope = await response.json() as { code?: number; data?: { version?: unknown; content?: unknown; source_ref?: unknown } };
    if (!response.ok || envelope.code !== 0 || typeof envelope.data?.version !== "number" || typeof envelope.data.content !== "string") return null;
    return { version: envelope.data.version, content: envelope.data.content, source_ref: typeof envelope.data.source_ref === "string" ? envelope.data.source_ref : undefined };
  } finally { clearTimeout(timer); }
}
