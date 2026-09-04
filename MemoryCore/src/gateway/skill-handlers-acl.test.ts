import { describe, expect, it, vi } from "vitest";
import { handleFilesRead, handleGet, handleList } from "./skill-handlers.js";
import type { SkillCore } from "../core/skill/skill-core.js";

const auth = { apiKey: "gateway-key", serviceId: "default" };
const skill = {
  skill_id: "skl-team-secret",
  name: "Team secret",
  description: "secret",
  content: "---\nname: Team secret\ndescription: secret\n---\nprivate",
  manifest: [],
  version: 1,
  is_head: true,
  status: "active",
  team_id: "team-owner",
  owner_agent_id: "agent-owner",
  user_id: "owner",
  task_id: undefined,
  created_at_ms: 1,
  updated_at_ms: 1,
} as any;

function depsFor(caller: { user_id: string; user_type?: string }, member: any) {
  const core = {
    get: vi.fn(async () => skill),
    list: vi.fn(async () => ({ items: [skill], total: 1 })),
    readFile: vi.fn(async () => ({ path: "README.md", content: "secret", encoding: "utf-8", size_bytes: 6, mime_type: "text/plain", version: 1 })),
  } as unknown as SkillCore;
  const metadata = {
    isConfiguredMemorySystemUserKey: () => false,
    verifyAuth: vi.fn(async () => caller),
    rawStore: { getTeamMember: vi.fn(async () => member) },
  };
  return {
    core,
    deps: {
      getSkillCore: () => core,
      getMetadataService: async () => metadata,
      evidenceUserKey: `${caller.user_id}-key`,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as any,
  };
}

describe("skill read ACL", () => {
  it("rejects an authenticated user from another team before reading content", async () => {
    const { core, deps } = depsFor({ user_id: "outsider", user_type: "member" }, null);
    const response = await handleGet(
      { skill_id: skill.skill_id, team_id: "team-owner", user_id: "owner" },
      auth,
      "req-outsider",
      deps,
    );

    expect(response.code).toBe(40302);
    expect(core.get).not.toHaveBeenCalled();
  });

  it("allows an active member of the owning team to read", async () => {
    const { core, deps } = depsFor(
      { user_id: "member", user_type: "member" },
      { team_id: "team-owner", user_id: "member", status: "active", role: "member" },
    );
    const response = await handleGet(
      { skill_id: skill.skill_id, team_id: "team-owner", user_id: "member" },
      auth,
      "req-member",
      deps,
    );

    expect(response.code).toBe(0);
    expect(core.get).toHaveBeenCalledTimes(1);
  });

  it("does not permit an unscoped list that could enumerate all teams", async () => {
    const { core, deps } = depsFor({ user_id: "member", user_type: "member" }, null);
    const response = await handleList(
      { user_id: "member" },
      auth,
      "req-unscoped",
      deps,
    );

    expect(response.code).toBe(40302);
    expect(core.list).not.toHaveBeenCalled();
  });

  it("rejects resource reads from an outsider before touching storage", async () => {
    const { core, deps } = depsFor({ user_id: "outsider", user_type: "member" }, null);
    const response = await handleFilesRead(
      { skill_id: skill.skill_id, team_id: "team-owner", path: "README.md" },
      auth,
      "req-outsider-file",
      deps,
    );

    expect(response.code).toBe(40302);
    expect(core.readFile).not.toHaveBeenCalled();
  });
});
