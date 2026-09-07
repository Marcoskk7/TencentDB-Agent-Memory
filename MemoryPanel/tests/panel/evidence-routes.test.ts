import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerEvidenceRoutes } from '../../src/panel/http/routes/evidence.js';

function makeApp(code = 0) {
  const postEnvelope = vi.fn().mockResolvedValue({
    code,
    message: code === 0 ? 'ok' : 'UPSTREAM_DENIED',
    request_id: 'kernel-request',
    data: code === 0 ? { items: [], total: 0 } : null,
  });
  const deps = {
    config: { metadataRemoteTimeoutMs: 1234 },
    instanceRegistry: {
      resolve: vi.fn().mockReturnValue({
        instance_id: 'resolved-instance',
        gateway_endpoint: 'http://kernel.example',
        api_key: 'server-owned-key',
      }),
    },
    kernelHttp: { postEnvelope },
  } as any;
  const app = new Hono();
  registerEvidenceRoutes(app, deps);
  return { app, postEnvelope };
}

const headers = {
  'content-type': 'application/json',
  'X-Tdai-Service-Id': 'browser-instance',
  'X-Tdai-User-Key': 'browser-user-key',
};

describe('evidence Panel BFF', () => {
  it('requires the panel instance and user-key headers', async () => {
    const { app } = makeApp();
    const response = await app.request('/evidence/runs/list', { method: 'POST' });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe('MISSING_INSTANCE_ID');
  });

  it('forwards only allow-listed list fields with resolved server credentials', async () => {
    const { app, postEnvelope } = makeApp();
    const response = await app.request('/evidence/runs/list', {
      method: 'POST', headers,
      body: JSON.stringify({ team_id: 'team_1', asset_id: 'asset_1', review_status: 'pending', user_id: 'forged', reviewer_user_id: 'forged-reviewer', limit: 999, offset: 2 }),
    });
    expect(response.status).toBe(200);
    expect(postEnvelope).toHaveBeenCalledWith(
      '/v3/evidence/task-runs/list',
      { team_id: 'team_1', asset_id: 'asset_1', review_status: 'pending', limit: 100, offset: 2 },
      expect.objectContaining({ endpoint: 'http://kernel.example', apiKey: 'server-owned-key', instanceId: 'resolved-instance', userKey: 'browser-user-key' }),
    );
  });

  it('allows only evidence review fields and rejects unknown Panel paths', async () => {
    const { app, postEnvelope } = makeApp();
    const response = await app.request('/evidence/runs/review', {
      method: 'POST', headers,
      body: JSON.stringify({ run_id: 'run_1', access_id: 'access_1', decision: 'support', reason: 'diff proves it', behavior_refs: ['behavior_1'], user_id: 'forged' }),
    });
    expect(response.status).toBe(200);
    expect(postEnvelope).toHaveBeenCalledWith(
      '/v3/evidence/task-runs/reviews',
      { run_id: 'run_1', access_id: 'access_1', decision: 'support', reason: 'diff proves it', behavior_refs: ['behavior_1'] },
      expect.any(Object),
    );
    expect((await app.request('/evidence/runs/accesses', { method: 'POST', headers })).status).toBe(404);
  });

  it('uses the separate candidate-review operation and does not forward forged reviewer identity', async () => {
    const { app, postEnvelope } = makeApp();
    const response = await app.request('/evidence/runs/candidates/review', {
      method: 'POST', headers,
      body: JSON.stringify({ run_id: 'run_1', candidate_id: 'candidate_1', status: 'approved', reason: 'validated', reviewer_user_id: 'forged' }),
    });
    expect(response.status).toBe(200);
    expect(postEnvelope).toHaveBeenCalledWith(
      '/v3/evidence/candidates/review',
      { run_id: 'run_1', candidate_id: 'candidate_1', status: 'approved', reason: 'validated' },
      expect.any(Object),
    );
  });

  it('passes upstream failures through the standard envelope/status mapping', async () => {
    const { app } = makeApp(403);
    const response = await app.request('/evidence/runs/get', {
      method: 'POST', headers, body: JSON.stringify({ run_id: 'run_1' }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).message).toBe('UPSTREAM_DENIED');
  });

  it('treats null/arrays as invalid bodies and rejects malformed evidence refs', async () => {
    const { app } = makeApp();
    const nullBody = await app.request('/evidence/runs/get', { method: 'POST', headers, body: 'null' });
    expect(nullBody.status).toBe(400);
    expect((await nullBody.json()).message).toBe('MISSING_RUN_ID');
    const invalidRefs = await app.request('/evidence/runs/review', {
      method: 'POST', headers,
      body: JSON.stringify({ run_id: 'run_1', access_id: 'access_1', decision: 'support', reason: 'proof', behavior_refs: 'not-an-array' }),
    });
    expect(invalidRefs.status).toBe(400);
    expect((await invalidRefs.json()).message).toBe('INVALID_EVIDENCE_REVIEW');
  });
});
