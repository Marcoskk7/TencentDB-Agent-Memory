import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteMetadataStore } from "../metadata/store/sqlite-adapter.js";
import { MetadataService } from "../metadata/service/metadata-service.js";
import { makeEvidenceRouteTable } from "./evidence-handlers.js";

const auth = { serviceId: "evidence-handler-test", token: "bearer" } as any;
const requestId = "request";

describe("evidence handlers authorization", () => {
  it("authenticates real metadata users and derives reviewer identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evidence-handler-"));
    const oldBase = process.env.TDAI_EVIDENCE_SQLITE_BASE_DIR;
    process.env.TDAI_EVIDENCE_SQLITE_BASE_DIR = dir;
    try {
      const metaStore = new SqliteMetadataStore(join(dir, "meta.db")); metaStore.init();
      const meta = new MetadataService(metaStore, auth.serviceId);
      const owner = metaStore.createUser({ user_id: "owner", username: "owner", auth_provider: "local", external_id: "owner", default_key_value: "owner-key" });
      const member = metaStore.createUser({ user_id: "member", username: "member", auth_provider: "local", external_id: "member", default_key_value: "member-key" });
      const reviewer = metaStore.createUser({ user_id: "reviewer", username: "reviewer", auth_provider: "local", external_id: "reviewer", default_key_value: "reviewer-key" });
      const outsider = metaStore.createUser({ user_id: "outsider", username: "outsider", auth_provider: "local", external_id: "outsider", default_key_value: "outsider-key" });
      const team = metaStore.createTeam({ team_id: "team", name: "team", owner_user_id: owner.user_id });
      const secondTeam = metaStore.createTeam({ team_id: "team-two", name: "team-two", owner_user_id: owner.user_id });
      metaStore.addTeamMember({ team_id: team.team_id, user_id: member.user_id, role: "member" });
      metaStore.addTeamMember({ team_id: team.team_id, user_id: reviewer.user_id, role: "reviewer" });
      const agent = metaStore.createAgent({ agent_id: "agent", team_id: team.team_id, owner_user_id: owner.user_id, name: "agent" });
      const secondAgent = metaStore.createAgent({ agent_id: "agent-two", team_id: secondTeam.team_id, owner_user_id: owner.user_id, name: "agent-two" });
      metaStore.createAsset({ asset_id: "asset", team_id: team.team_id, asset_type: "skill", name: "asset", owner_user_id: owner.user_id, source_type: "test", version: 1, visibility: "team", status: "approved" });
      const table = makeEvidenceRouteTable();
      const call = async (path: string, body: unknown, key?: string, mode: "standalone" | "service" = "standalone") => table[path]!(body, auth, requestId, { deployMode: mode, evidenceUserKey: key, getMetadataService: async () => meta });

      expect((await call("/v3/evidence/task-runs/list", { team_id: team.team_id })).code).toBe(401);
      expect((await call("/v3/evidence/task-runs/list", { team_id: team.team_id }, "bad-key")).code).toBe(401);
      const create = await call("/v3/evidence/task-runs", { team_id: team.team_id, agent_id: agent.agent_id, agent_source: "test", session_id: "s", request_id: "r", execution_id: "e", task_goal: "goal" }, "owner-key");
      expect(create.code).toBe(0); const run = (create.data as any).run_id;
      const scopedA = await call("/v3/evidence/task-runs", { team_id: team.team_id, agent_id: agent.agent_id, agent_source: "test", session_id: "scope", request_id: "r", execution_id: "e", task_goal: "goal", idempotency_key: "same" }, "owner-key");
      const scopedB = await call("/v3/evidence/task-runs", { team_id: secondTeam.team_id, agent_id: secondAgent.agent_id, agent_source: "test", session_id: "scope", request_id: "r", execution_id: "e", task_goal: "goal", idempotency_key: "same" }, "owner-key");
      expect((scopedA.data as any).run_id).not.toBe((scopedB.data as any).run_id);
      expect((await call("/v3/evidence/task-runs/get", { run_id: run }, "outsider-key")).code).toBe(403);
      const access = await call("/v3/evidence/task-runs/accesses", { run_id: run, asset_id: "asset", asset_type: "skill", version: 1, mode: "read", reader_team_id: team.team_id, reader_agent_id: agent.agent_id, reader_user_id: owner.user_id }, "owner-key");
      const accessId = (access.data as any).access_id;
      const spoof = await call("/v3/evidence/task-runs/reviews", { run_id: run, access_id: accessId, decision: "support", reason: "x", reviewer_user_id: reviewer.user_id }, "member-key");
      expect(spoof.code).toBe(403);
      const accepted = await call("/v3/evidence/task-runs/reviews", { run_id: run, access_id: accessId, decision: "uncertain", reason: "x", reviewer_user_id: owner.user_id }, "reviewer-key");
      expect(accepted.code).toBe(0); expect((accepted.data as any).reviewer_user_id).toBe(reviewer.user_id);
      expect((await call("/v3/evidence/task-runs/list", { team_id: team.team_id, status: "wrong" }, "owner-key")).code).toBe(400);
      expect((await call("/v3/evidence/task-runs/list", { team_id: team.team_id }, "owner-key", "service")).code).toBe(503);
    } finally { process.env.TDAI_EVIDENCE_SQLITE_BASE_DIR = oldBase; await rm(dir, { recursive: true, force: true }); }
  });
});
