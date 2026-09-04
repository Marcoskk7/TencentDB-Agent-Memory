import { describe, expect, it } from "vitest";
import { buildAssetSummaryBlock, classifyClaudeCodeRequest } from "../evidence-context.js";
import { parseAssetUsage } from "../usage-claim-parser.js";
import { AnthropicSseEvidenceBuffer, extractToolResults } from "../tool-evidence.js";
import { ensureEvidenceRun, injectApprovedSkillSnapshots, recordEvidenceResponse, recordEvidenceToolResults } from "../evidence-runtime.js";
import { DEFAULT_CONFIG } from "../../../config.js";
import { createSseAssetUsageFilterStream } from "../evidence-stream-filter.js";

describe("claude evidence protocol", () => {
  it("parses and strips structured usage claims", () => {
    const input = `answer\n<asset_usage>{"schema_version":1,"claims":[{"access_id":"acc_1","declared_usage":"used","purpose":"retry policy","files":["src/api.ts"]}]}</asset_usage>`;
    const parsed = parseAssetUsage(input);
    expect(parsed.claims[0]?.access_id).toBe("acc_1");
    expect(parsed.text).toBe("answer");
  });

  it("does not treat malformed claims as usage", () => {
    const parsed = parseAssetUsage("x<asset_usage>{bad}</asset_usage>");
    expect(parsed.claims).toHaveLength(0);
    expect(parsed.text).toBe("x");
  });

  it("buffers streamed tool use input JSON", () => {
    const b = new AnthropicSseEvidenceBuffer();
    b.push('data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n');
    b.push('data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"pnpm test\\"}"}}\n\n');
    b.push('data: {"type":"content_block_stop"}\n\n');
    expect(b.finish()[0]).toMatchObject({ tool_name: "Bash", input_json: '{"cmd":"pnpm test"}' });
  });

  it("classifies compact and renders bounded candidate XML", () => {
    expect(classifyClaudeCodeRequest({ path: "/v1/compact", body: {} })).toBe("compact");
    expect(buildAssetSummaryBlock({ access_id: "a", asset_id: "s", asset_type: "skill", version: 1, summary: "retry" })).toContain("access_id=\"a\"");
  });

  it("extracts tool results from follow-up messages", () => {
    expect(extractToolResults([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] }])[0]?.result_status).toBe("ok");
    expect(extractToolResults([{ content: [{ type: "tool_result", tool_use_id: "t2", content: "pending" }] }])[0]?.result_status).toBe("unknown");
  });

  it("writes only authenticated main-run evidence and keeps execution unknown", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ path: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ code: 0, data: String(url).includes("/behaviors") ? { behavior_id: "beh-1" } : String(url).includes("task-runs") && !String(url).includes("/events") ? { run_id: "run-1" } : {} }));
    }) as typeof fetch;
    try {
      const config = { ...DEFAULT_CONFIG, evidence: { enabled: true, endpoint: "http://core", apiKey: "key", serviceId: "svc", timeoutMs: 1000, assetIds: [] } };
      expect(await ensureEvidenceRun({ config, identity: null, requestKind: "main", taskGoal: "fix", agentSource: "claude-code", requestId: "no-id" })).toBeNull();
      const run = await ensureEvidenceRun({ config, identity: { teamId: "team", userId: "user", agentId: "agent", sessionId: "session" }, requestKind: "main", taskGoal: "fix", agentSource: "claude-code", requestId: "request" });
      await recordEvidenceResponse(config, run, "svc", null, [{ tool_use_id: "tool-1", tool_name: "Bash", input_json: "{}" }], []);
      await recordEvidenceToolResults(config, run, "svc", null, [{ content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] }]);
      await recordEvidenceResponse(config, run, "svc", null, [], [{ access_id: "unseen", declared_usage: "used", purpose: "nope" }]);
      expect(calls.some((call) => call.path.endsWith("/behaviors") && call.body.result_summary === "tool result status=unknown; execution_status=unknown")).toBe(true);
      expect(calls.some((call) => call.path.endsWith("/claims"))).toBe(false);
      expect(calls.some((call) => call.path.endsWith("/close"))).toBe(false);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("reads ACL-filtered Core skill content and records the injected snapshot", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      const path = String(url); calls.push(path);
      if (path.includes("agent-fixed-asset/list-with-detail")) return new Response(JSON.stringify({ code: 0, data: { agent: {}, items: [{ asset_id: "skill-1", asset_type: "skill", status: "approved", description: "real summary" }, { asset_id: "draft-skill", asset_type: "skill", status: "draft" }], total: 2, limit: 100, offset: 0 } }));
      if (path.endsWith("/v3/skill/get")) return new Response(JSON.stringify({ code: 0, data: { version: 7, content: "real skill content" } }));
      if (path.endsWith("/accesses")) return new Response(JSON.stringify({ code: 0, data: { access_id: "acc-real" } }));
      return new Response(JSON.stringify({ code: 0, data: {} }));
    }) as typeof fetch;
    try {
      const config = { ...DEFAULT_CONFIG, coreSkill: { ...DEFAULT_CONFIG.coreSkill, endpoint: "http://core", serviceToken: "service" }, evidence: { enabled: true, endpoint: "http://core", apiKey: "key", serviceId: "svc", timeoutMs: 1000, assetIds: [] } };
      const context = { runId: "run-assets", accessIds: new Set<string>(), behaviorIds: new Map<string, string>() };
      const identity = { teamId: "team", userId: "user", agentId: "agent", sessionId: "session" };
      const block = await injectApprovedSkillSnapshots(config, context, identity, "svc", "user-key");
      expect(block).toContain('access_id="acc-real"');
      expect(block).toContain('version="7"');
      expect(context.accessIds.has("acc-real")).toBe(true);
      expect(calls.some((path) => path.endsWith("/v3/skill/get"))).toBe(true);
      expect(calls.filter((path) => path.endsWith("/v3/skill/get"))).toHaveLength(1);
      expect(calls.some((path) => path.endsWith("/accesses"))).toBe(true);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("filters a usage tag split across UTF-8 network chunks while preserving tools and text", async () => {
    const source = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"before <as"}}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t","name":"Bash"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"set_usage>{\\"schema_version\\":1}</asset_usage> after 🌍"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
    ].join("");
    const bytes = new TextEncoder().encode(source);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, bytes.length - 2)); controller.enqueue(bytes.slice(bytes.length - 2)); controller.close(); } });
    const output = await new Response(stream.pipeThrough(createSseAssetUsageFilterStream())).text();
    expect(output).toContain("before ");
    expect(output).toContain(" after 🌍");
    expect(output).toContain('"tool_use"');
    expect(output).not.toContain("asset_usage");
  });

  it("retains already prepared injection when a later approved asset cannot be read", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const pathname = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (pathname.includes("agent-fixed-asset/list-with-detail")) return new Response(JSON.stringify({ code: 0, data: { agent: {}, items: ["first", "second"].map(asset_id => ({ asset_id, asset_type: "skill", status: "approved" })), total: 2 } }));
      if (pathname.endsWith("/v3/skill/get")) {
        if (body.skill_id === "second") throw new Error("read unavailable");
        return new Response(JSON.stringify({ code: 0, data: { version: 1, content: "first skill contents" } }));
      }
      if (pathname.endsWith("/accesses")) return new Response(JSON.stringify({ code: 0, data: { access_id: "acc-first" } }));
      return new Response(JSON.stringify({ code: 0, data: {} }));
    }) as typeof fetch;
    try {
      const config = { ...DEFAULT_CONFIG, coreSkill: { ...DEFAULT_CONFIG.coreSkill, endpoint: "http://core", serviceToken: "service" }, evidence: { enabled: true, endpoint: "http://core", apiKey: "key", serviceId: "svc", timeoutMs: 1000, assetIds: [] } };
      const context = { runId: "run-partial", accessIds: new Set<string>(), behaviorIds: new Map<string, string>() };
      const block = await injectApprovedSkillSnapshots(config, context, { teamId: "team", userId: "user", agentId: "agent", sessionId: "session" }, "svc", "user-key");
      expect(block).toContain('access_id="acc-first"');
      expect(block).not.toContain('asset_id="second"');
    } finally { globalThis.fetch = originalFetch; }
  });
});
