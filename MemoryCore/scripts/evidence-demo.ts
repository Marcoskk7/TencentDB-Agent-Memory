/** Minimal HTTP demo for the asset evidence chain.
 * Run against a started gateway:
 *   npx tsx scripts/evidence-demo.ts http://127.0.0.1:8787 demo-key demo-instance
 */
const [endpoint = "http://127.0.0.1:8787", apiKey = "", serviceId = "default"] = process.argv.slice(2);
const headers = {
  authorization: `Bearer ${apiKey}`,
  "x-tdai-service-id": serviceId,
  "content-type": "application/json",
};
async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${endpoint}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json() as { code?: number; data?: any; message?: string };
  if (!response.ok || payload.code !== 0) throw new Error(`${response.status}: ${payload.message ?? JSON.stringify(payload)}`);
  return payload.data;
}

const run = await post("/v3/evidence/task-runs", {
  team_id: "demo-team", agent_id: "demo-agent", user_id: "demo-user",
  agent_source: "demo", session_id: `demo-${Date.now()}`,
  request_id: `req-${Date.now()}`, execution_id: `exec-${Date.now()}`,
  task_goal: "demonstrate an evidence chain", idempotency_key: `demo-${Date.now()}`,
});
const access = await post(`/v3/evidence/task-runs/${run.run_id}/accesses`, {
  asset_id: "skill_retry", asset_type: "skill", version: 3,
  mode: "inject",
  reader_team_id: run.team_id, reader_agent_id: run.agent_id, reader_user_id: run.user_id,
  name: "API retry skill", applicability: "HTTP retry/backoff",
});
await post(`/v3/evidence/task-runs/${run.run_id}/events`, { type: "asset_selected", idempotency_key: "demo-select", data: { access_id: access.access_id, reason: "relevant" } });
const behavior = await post(`/v3/evidence/task-runs/${run.run_id}/behaviors`, { tool_name: "edit", target_files: ["src/api.ts"] });
const claim = await post(`/v3/evidence/task-runs/${run.run_id}/claims`, { access_id: access.access_id, declared_usage: "used", purpose: "backoff policy", files: ["src/api.ts"] });
await post(`/v3/evidence/task-runs/${run.run_id}/reviews`, { access_id: access.access_id, decision: "support", reason: "matches implementation", behavior_refs: [behavior.behavior_id], reviewer_user_id: run.user_id });
await post(`/v3/evidence/task-runs/${run.run_id}/validations`, { command: "pnpm test", passed: true, validation_type: "test", claim_refs: [claim.claim_id] });
const receipt = await post(`/v3/evidence/task-runs/${run.run_id}/close`, {});
console.log(JSON.stringify(receipt, null, 2));
