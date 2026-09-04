import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { TdaiGateway } from '../../../MemoryCore/src/gateway/server.js';
import { loadGatewayConfig } from '../../../MemoryCore/src/gateway/config.js';
import { captureAndRecord, coreClient } from '../../../scripts/evidence-workspace.mjs';
import { registerEvidenceRoutes } from '../../src/panel/http/routes/evidence.js';
import { FetchKernelHttpAdapter } from '../../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';
import { DEFAULT_CONFIG } from '../../../MemoryProxy/src/config.js';
import { clearEvidenceRunCache, ensureEvidenceRun, injectApprovedSkillSnapshots, recordEvidenceResponse, recordEvidenceToolResults } from '../../../MemoryProxy/src/session/claude-code/evidence-runtime.js';

it('real workspace command → Core HTTP → Panel BFF multi-user review → receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'evidence-live-chain-'));
  const serviceId = `evidence-test-${randomUUID()}`;
  const previousMetadata = process.env.TDAI_METADATA_SQLITE_BASE_DIR;
  const previousEvidence = process.env.TDAI_EVIDENCE_SQLITE_BASE_DIR;
  process.env.TDAI_METADATA_SQLITE_BASE_DIR = join(dir, 'metadata');
  process.env.TDAI_EVIDENCE_SQLITE_BASE_DIR = join(dir, 'evidence');
  const gateway = new TdaiGateway({
    instanceId: serviceId,
    server: { host: '127.0.0.1', port: 0, apiKey: 'local-evidence-test-gateway' },
    data: { baseDir: dir },
    llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', model: 'unused' },
    memory: { ...loadGatewayConfig().memory, skill: { enabled: true } },
  });
  try {
    await gateway.start();
    const port = (gateway as any).server.address().port;
    const endpoint = `http://127.0.0.1:${port}`;
    const metadata = await (gateway as any).ensureMetadataService(serviceId);
    const store = metadata.rawStore;
    for (const name of ['owner', 'member', 'reviewer', 'outsider']) {
      await store.createUser({ user_id: name, username: name, auth_provider: 'local', external_id: name, default_key_value: `test-key-${name}` });
    }
    await store.createTeam({ team_id: 'team', name: 'Test team', owner_user_id: 'owner' });
    await store.addTeamMember({ team_id: 'team', user_id: 'member', role: 'member' });
    await store.addTeamMember({ team_id: 'team', user_id: 'reviewer', role: 'reviewer' });
    await store.createAgent({ agent_id: 'agent', team_id: 'team', owner_user_id: 'owner', name: 'Test agent' });
    const post = coreClient({
      EVIDENCE_CORE_URL: endpoint, EVIDENCE_SERVICE_ID: serviceId,
      EVIDENCE_GATEWAY_KEY: 'local-evidence-test-gateway', EVIDENCE_USER_KEY: 'test-key-owner',
    });
    const repo = join(dir, 'workspace');
    await mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
    git('init');
    git('config', 'user.email', 'evidence-test@example.invalid');
    git('config', 'user.name', 'Evidence Test');
    await writeFile(join(repo, 'source.txt'), 'before\n');
    git('add', 'source.txt');
    git('commit', '-m', 'test baseline');
    const baseline = git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'source.txt'), 'after\n');
    const skillResponse = await fetch(`${endpoint}/v3/skill/create`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer local-evidence-test-gateway', 'x-tdai-service-id': serviceId, 'x-tdai-user-key': 'test-key-owner' },
      body: JSON.stringify({ team_id: 'team', agent_id: 'agent', user_id: 'owner', name: 'source-check', content: '---\nname: source-check\ndescription: Check the source change with a real assertion\n---\nVerify source.txt contains the expected output after editing.\n' }),
    });
    const skillEnvelope = await skillResponse.json() as any;
    expect(skillEnvelope.code, JSON.stringify(skillEnvelope)).toBe(0);
    const skillId = skillEnvelope.data.skill_id;
    await store.updateAsset(skillId, { status: 'approved', visibility: 'team' });
    const proxyConfig = {
      ...DEFAULT_CONFIG,
      coreSkill: { ...DEFAULT_CONFIG.coreSkill, endpoint, serviceToken: 'local-evidence-test-gateway', serviceId },
      evidence: { enabled: true, endpoint, apiKey: 'local-evidence-test-gateway', serviceId, timeoutMs: 5_000, assetIds: [skillId] },
    };
    const identity = { teamId: 'team', agentId: 'agent', userId: 'owner', sessionId: serviceId };
    const context = await ensureEvidenceRun({ config: proxyConfig, identity, requestKind: 'main', taskGoal: 'Verify a local change', agentSource: 'claude-code', serviceId, requestId: 'request', userKey: 'test-key-owner' });
    expect(context).not.toBeNull();
    const injected = await injectApprovedSkillSnapshots(proxyConfig, context, identity, serviceId, 'test-key-owner');
    expect(injected).toContain('access_id=');
    const run = { run_id: context!.runId };
    const access = (await post('task-runs/get', { run_id: run.run_id })).accesses[0];
    expect(access.asset_id).toBe(skillId);
    await recordEvidenceResponse(proxyConfig, context, serviceId, 'test-key-owner', [{ tool_use_id: 'tool-1', tool_name: 'Read', input_json: '{"file_path":"source.txt"}' }], []);
    clearEvidenceRunCache();
    const restored = await ensureEvidenceRun({ config: proxyConfig, identity, requestKind: 'main', taskGoal: 'Continue the task after restart', agentSource: 'claude-code', serviceId, requestId: 'request-after-restart', userKey: 'test-key-owner' });
    expect(restored!.runId).toBe(context!.runId);
    expect(restored!.accessIds.has(access.access_id)).toBe(true);
    await recordEvidenceToolResults(proxyConfig, restored, serviceId, 'test-key-owner', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'after\n' }] }]);
    await recordEvidenceResponse(proxyConfig, restored, serviceId, 'test-key-owner', [], [{ access_id: access.access_id, declared_usage: 'used', purpose: 'Apply the source change', files: ['source.txt'] }]);
    const afterProxy = await post('task-runs/get', { run_id: run.run_id });
    expect(afterProxy.behaviors.length).toBeGreaterThanOrEqual(2);
    const claim = afterProxy.claims[0];
    expect(claim).toBeDefined();
    const captured = await captureAndRecord({
      repo, runId: run.run_id, claimIds: [claim.claim_id], baseRef: baseline,
      command: [process.execPath, '-e', 'const fs=require("node:fs");process.exit(fs.readFileSync("source.txt","utf8")==="after\\n"?0:1)'],
      stdio: 'ignore', timeoutMs: 5_000, close: false,
    }, post);
    expect(captured.passed).toBe(true);
    expect(captured.receipt.summary.used).toBe(0);
    expect(captured.receipt.summary.validation_passed).toBe(1);

    const app = new Hono();
    registerEvidenceRoutes(app, {
      config: { metadataRemoteTimeoutMs: 5_000 },
      instanceRegistry: { resolve: () => ({ instance_id: serviceId, gateway_endpoint: endpoint, api_key: 'local-evidence-test-gateway' }) },
      kernelHttp: new FetchKernelHttpAdapter(),
    } as any);
    const panel = async (route: string, body: object, user: string) => {
      const response = await app.request(`/evidence/runs/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': serviceId, 'x-tdai-user-key': `test-key-${user}` }, body: JSON.stringify(body),
      });
      return { status: response.status, envelope: await response.json() as any };
    };
    const snapshot = await post('task-runs/get', { run_id: run.run_id });
    const review = { run_id: run.run_id, access_id: access.access_id, decision: 'support', reason: 'Actual workspace diff and executed test support the claim', diff_refs: [snapshot.diffs[0].diff_id], reviewer_user_id: 'forged' };
    expect((await panel('review', review, 'member')).status).toBe(403);
    expect((await panel('get', { run_id: run.run_id }, 'outsider')).status).toBe(403);
    const accepted = await panel('review', review, 'reviewer');
    expect(accepted.status, JSON.stringify(accepted.envelope)).toBe(200);
    expect(accepted.envelope.data.reviewer_user_id).toBe('reviewer');
    const receipt = await panel('receipt', { run_id: run.run_id }, 'member');
    expect(receipt.envelope.data.summary).toMatchObject({ used: 1, validation_passed: 1, contributed: 0 });
    await post('task-runs/close', { run_id: run.run_id });
    const closed = await post('task-runs/get', { run_id: run.run_id });
    expect(closed.run.status).toBe('completed');
    expect(closed.candidates.length).toBe(1);
    expect(closed.candidates[0].status).toBe('candidate');
    const next = await ensureEvidenceRun({ config: proxyConfig, identity, requestKind: 'main', taskGoal: 'A new task after explicit close', agentSource: 'claude-code', serviceId, requestId: 'request-after-close', userKey: 'test-key-owner' });
    expect(next!.runId).not.toBe(run.run_id);
  } finally {
    await gateway.stop();
    if (previousMetadata === undefined) delete process.env.TDAI_METADATA_SQLITE_BASE_DIR;
    else process.env.TDAI_METADATA_SQLITE_BASE_DIR = previousMetadata;
    if (previousEvidence === undefined) delete process.env.TDAI_EVIDENCE_SQLITE_BASE_DIR;
    else process.env.TDAI_EVIDENCE_SQLITE_BASE_DIR = previousEvidence;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
