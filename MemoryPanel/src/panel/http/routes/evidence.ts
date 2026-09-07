/**
 * Evidence Panel BFF.
 *
 * This is deliberately a small allow-list rather than a transparent `/v3/evidence/*`
 * proxy.  The browser supplies only query/review evidence; gateway credentials come
 * from the resolved panel instance and caller identity comes from its user key.
 */
import type { Context, Hono } from 'hono';
import type { MetaCallContext } from '../../kernel/types.js';
import { toKernelCredentials } from '../../kernel/types.js';
import type { PanelDeps } from '../../panel-deps.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';

type JsonObject = Record<string, unknown>;

async function readBody(c: Context): Promise<JsonObject> {
  const value: unknown = await c.req.json().catch(() => ({}));
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function hasInvalidStringList(value: unknown): boolean {
  return value !== undefined && stringList(value) === undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function buildContext(c: Context): MetaCallContext {
  const panelMeta = c.get('panelMeta');
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get('reqId'),
  };
}

async function forward(
  c: Context,
  deps: PanelDeps,
  path: string,
  body: JsonObject,
) {
  const envelope = await deps.kernelHttp.postEnvelope(
    path,
    body,
    toKernelCredentials(buildContext(c), { timeoutMs: deps.config.metadataRemoteTimeoutMs }),
  );
  return respondEnvelope(c, envelope);
}

/** Register the browser-facing evidence read/review operations. */
export function registerEvidenceRoutes(api: Hono, deps: PanelDeps): void {
  const auth = validatePanelMetaHeaders(deps);

  api.post('/evidence/runs/list', auth, async (c) => {
    const source = await readBody(c);
    const body: JsonObject = {};
    // Copy only query fields. In particular do not forward browser-provided actor IDs.
    for (const field of ['team_id', 'task_id', 'asset_id', 'asset_type', 'status', 'variant', 'candidate_status', 'review_status', 'evaluation_group_id']) {
      const value = text(source[field]);
      if (value) body[field] = value;
    }
    const limit = nonNegativeInt(source.limit);
    const offset = nonNegativeInt(source.offset);
    if (limit !== undefined) body.limit = Math.min(limit, 100);
    if (offset !== undefined) body.offset = offset;
    return forward(c, deps, '/v3/evidence/task-runs/list', body);
  });

  for (const [route, upstream] of [
    ['/evidence/runs/get', '/v3/evidence/task-runs/get'],
    ['/evidence/runs/receipt', '/v3/evidence/task-runs/receipt'],
  ] as const) {
    api.post(route, auth, async (c) => {
      const runId = text((await readBody(c)).run_id);
      if (!runId) return respondControlError(c, 400, 'MISSING_RUN_ID');
      return forward(c, deps, upstream, { run_id: runId });
    });
  }

  api.post('/evidence/runs/review', auth, async (c) => {
    const source = await readBody(c);
    const runId = text(source.run_id);
    const accessId = text(source.access_id);
    const decision = text(source.decision);
    const reason = text(source.reason);
    if (!runId || !accessId || !reason || !['support', 'not_support', 'uncertain'].includes(decision ?? '') ||
      ['behavior_refs', 'diff_refs', 'decision_refs'].some((field) => hasInvalidStringList(source[field]))) {
      return respondControlError(c, 400, 'INVALID_EVIDENCE_REVIEW');
    }
    const body: JsonObject = { run_id: runId, access_id: accessId, decision, reason };
    for (const field of ['behavior_refs', 'diff_refs', 'decision_refs']) {
      const value = stringList(source[field]);
      if (value) body[field] = value;
    }
    return forward(c, deps, '/v3/evidence/task-runs/reviews', body);
  });

  api.post('/evidence/runs/candidates/review', auth, async (c) => {
    const source = await readBody(c);
    const runId = text(source.run_id);
    const candidateId = text(source.candidate_id);
    const status = text(source.status);
    const reason = text(source.reason);
    if (!runId || !candidateId || !reason || !['approved', 'rejected'].includes(status ?? '')) {
      return respondControlError(c, 400, 'INVALID_CANDIDATE_REVIEW');
    }
    const body: JsonObject = { run_id: runId, candidate_id: candidateId, status, reason };
    return forward(c, deps, '/v3/evidence/candidates/review', body);
  });
}
