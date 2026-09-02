import { describe, expect, it } from "vitest";
import { buildAssetSummaryBlock, classifyClaudeCodeRequest } from "../evidence-context.js";
import { parseAssetUsage } from "../usage-claim-parser.js";
import { AnthropicSseEvidenceBuffer, extractToolResults } from "../tool-evidence.js";

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
    expect(buildAssetSummaryBlock({ access_id: "a", asset_id: "s", asset_type: "skill", version: 1, digest: "sha256:x", summary: "retry" })).toContain("access_id=\"a\"");
  });

  it("extracts tool results from follow-up messages", () => {
    expect(extractToolResults([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] }])[0]?.result_status).toBe("ok");
    expect(extractToolResults([{ content: [{ type: "tool_result", tool_use_id: "t2", content: "pending" }] }])[0]?.result_status).toBe("unknown");
  });
});
