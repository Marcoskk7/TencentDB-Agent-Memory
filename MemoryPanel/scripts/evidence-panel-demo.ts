/**
 * Local-only evidence UI demo. Starts an isolated real Core gateway and Panel,
 * seeds synthetic metadata/evidence through their HTTP APIs, and prints login
 * details. It never reads production configuration or binds a non-loopback IP.
 *
 * Run: node --import tsx scripts/evidence-panel-demo.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { TdaiGateway } from '../../MemoryCore/src/gateway/server.js';
import { buildPanelApp } from '../src/panel/http/app.js';
import { buildPanelDeps } from '../src/panel/panel-deps.js';
import type { PanelConfig } from '../src/panel/config/panel-config.js';

const gatewayPort = Number(process.env.EVIDENCE_DEMO_GATEWAY_PORT ?? 18420);
const panelPort = Number(process.env.EVIDENCE_DEMO_PANEL_PORT ?? 18123);
const serviceId = 'evidence-demo';
const gatewayKey = 'local-evidence-demo-gateway-key';
const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-evidence-panel-'));
const instancesPath = path.join(demoDir, 'metadata-instances.json');
const userKey = 'sk-mem-local-evidence-demo';

process.env.TDAI_METADATA_SQLITE_BASE_DIR = path.join(demoDir, 'metadata');
process.env.TDAI_EVIDENCE_SQLITE_BASE_DIR = path.join(demoDir, 'evidence');
fs.writeFileSync(instancesPath, JSON.stringify({ instances: [{
  id: serviceId, name: 'Local evidence demo', gateway_endpoint: `http://127.0.0.1:${gatewayPort}`, api_key: gatewayKey,
}] }, null, 2));

async function post(baseUrl: string, pathname: string, body: object, user = userKey): Promise<any> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', Authorization: `Bearer ${gatewayKey}`,
      'x-tdai-service-id': serviceId, ...(user ? { 'x-tdai-user-key': user } : {}),
    }, body: JSON.stringify(body),
  });
  const envelope = await response.json() as { code: number; message: string; data: any };
  if (envelope.code !== 0) throw new Error(`${pathname}: ${envelope.message}`);
  return envelope.data;
}

async function seed(): Promise<void> {
  const core = `http://127.0.0.1:${gatewayPort}`;
  const admin = await post(core, '/v3/internal/meta/user/init-admin', { username: 'evidence-demo', user_key: userKey }, '');
  const teams = await post(core, '/v3/meta/team/list', { user_key: userKey, limit: 10 });
  const team = teams.items[0];
  const agents = await post(core, '/v3/meta/agent/list', { team_id: team.team_id, limit: 10 });
  const agent = agents.items[0];
  const task = await post(core, '/v3/meta/task/create', {
    team_id: team.team_id, creator_user_id: admin.user_id, title: 'Synthetic evidence UI task',
    description: 'Local demo data only; safe to delete with its temporary directory.', status: 'completed', linked_agents: [{ agent_id: agent.agent_id }],
  });
  const createRun = async (variant: 'with_assets' | 'without_assets') => post(core, '/v3/evidence/task-runs', {
    team_id: team.team_id, task_id: task.task_id, agent_id: agent.agent_id, task_goal: task.title,
    agent_source: 'local-demo', session_id: `demo-${variant}`, request_id: `demo-${variant}`, execution_id: `demo-${variant}`,
    variant, evaluation_group_id: 'local-evidence-comparison',
  });
  const withAssets = await createRun('with_assets');
  const withoutAssets = await createRun('without_assets');
  await post(core, '/v3/meta/asset/create', {
    asset_id: 'demo-skill-asset', team_id: team.team_id, asset_type: 'skill', name: 'Synthetic debugging checklist',
    owner_user_id: admin.user_id, source_type: 'local-demo', visibility: 'team', status: 'approved',
  });
  await post(core, '/v3/evidence/task-runs/accesses', { run_id: withAssets.run_id, asset_id: 'demo-skill-asset', asset_type: 'skill', version: 1, mode: 'inject', reader_team_id: team.team_id, reader_agent_id: agent.agent_id, reader_user_id: admin.user_id, name: 'Synthetic debugging checklist' });
  const snapshot = await post(core, '/v3/evidence/task-runs/get', { run_id: withAssets.run_id });
  const accessId = snapshot.accesses[0].access_id;
  const behavior = await post(core, '/v3/evidence/task-runs/behaviors', { run_id: withAssets.run_id, tool_name: 'shell', command_summary: 'npm test', result_summary: 'passed' });
  const diff = await post(core, '/v3/evidence/task-runs/diffs', { run_id: withAssets.run_id, files: ['demo.ts'] });
  await post(core, '/v3/evidence/task-runs/claims', { run_id: withAssets.run_id, access_id: accessId, declared_usage: 'used', purpose: 'diagnosis', behavior_refs: [behavior.behavior_id], diff_refs: [diff.diff_id] });
  await post(core, '/v3/evidence/task-runs/validations', { run_id: withAssets.run_id, command: 'npm test', exit_code: 0, passed: true, validation_type: 'test', behavior_refs: [behavior.behavior_id], diff_refs: [diff.diff_id] });
  await post(core, '/v3/evidence/task-runs/reviews', { run_id: withAssets.run_id, access_id: accessId, decision: 'support', reason: 'Synthetic review links the asset to the tested change.', behavior_refs: [behavior.behavior_id], diff_refs: [diff.diff_id] });
  await post(core, '/v3/evidence/task-runs/evaluations', { run_id: withAssets.run_id, control_run_id: withoutAssets.run_id, passed: true, gain: 1, contamination: false });
  await post(core, '/v3/evidence/task-runs/close', { run_id: withAssets.run_id, close_reason: 'local demo complete' });
  await post(core, '/v3/evidence/task-runs/close', { run_id: withoutAssets.run_id, close_reason: 'local control complete' });
}

const gateway = new TdaiGateway({
  server: { host: '127.0.0.1', port: gatewayPort, apiKey: gatewayKey }, data: { baseDir: demoDir },
  llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'not-used', model: 'not-used' },
});
await gateway.start();
await seed();
const config: PanelConfig = {
  server: { host: '127.0.0.1', port: panelPort }, metadataInstancesConfig: instancesPath, metadataRemoteTimeoutMs: 15_000,
  ui: { distDir: path.resolve('web/dist') }, log: { level: 'info', format: 'pretty' },
  knowledge: { baseUrl: 'http://127.0.0.1:1', authToken: '', timeoutMs: 1 }, knowledgeLlmBinding: { sync: false, proxyBaseUrl: 'http://127.0.0.1:1' },
  agentTemplateDir: path.join(demoDir, 'agent-templates'),
};
const panel = serve({ fetch: buildPanelApp(buildPanelDeps(config)).fetch, hostname: '127.0.0.1', port: panelPort });
console.log(`EVIDENCE_DEMO_READY\nPanel: http://127.0.0.1:${panelPort}\nLogin instance: ${serviceId}\nLogin key: ${userKey}\nTemporary data: ${demoDir}`);
const shutdown = async () => { panel.close(); await gateway.stop(); fs.rmSync(demoDir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
