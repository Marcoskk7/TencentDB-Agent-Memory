export interface ToolEvidence {
  tool_use_id: string;
  tool_name: string;
  input_json: string;
  result?: string;
  result_status?: "ok" | "error" | "unknown";
}

/** Buffers Anthropic SSE blocks without assuming a particular upstream SDK. */
export class AnthropicSseEvidenceBuffer {
  private pending = "";
  private readonly pendingBlocks = new Map<number, ToolEvidence>();
  private nextSyntheticIndex = 0;
  private readonly tools: ToolEvidence[] = [];

  push(chunk: string): ToolEvidence[] {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try { this.consume(JSON.parse(raw) as Record<string, unknown>); } catch { /* ignore malformed SSE frames */ }
    }
    return this.list();
  }

  finish(): ToolEvidence[] { if (this.pending.trim().startsWith("data:")) this.push("\n"); return this.list(); }
  list(): ToolEvidence[] { return this.tools.map((t) => ({ ...t })); }

  private consume(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === "content_block_start") {
      const block = (event.content_block ?? {}) as Record<string, unknown>;
      const index = typeof event.index === "number" ? event.index : this.nextSyntheticIndex++;
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        // Anthropic sends an empty object at block start and the actual JSON via
        // input_json_delta; do not concatenate "{}" with the streamed payload.
        const initial = typeof block.input === "string" ? block.input : (block.input && Object.keys(block.input as object).length ? JSON.stringify(block.input) : "");
        this.pendingBlocks.set(index, { tool_use_id: block.id, tool_name: block.name, input_json: initial });
      }
    } else if (type === "content_block_delta") {
      const index = typeof event.index === "number" ? event.index : [...this.pendingBlocks.keys()][0];
      const current = index === undefined ? undefined : this.pendingBlocks.get(index);
      if (!current) return;
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") current.input_json += delta.partial_json;
    } else if (type === "content_block_stop") {
      const index = typeof event.index === "number" ? event.index : [...this.pendingBlocks.keys()][0];
      if (index !== undefined) {
        const current = this.pendingBlocks.get(index);
        if (current) { this.tools.push(current); this.pendingBlocks.delete(index); }
      }
    }
  }
}

export function extractToolResults(messages: unknown[]): Array<{ tool_use_id: string; result: string; result_status: "ok" | "error" | "unknown" }> {
  const out: Array<{ tool_use_id: string; result: string; result_status: "ok" | "error" | "unknown" }> = [];
  for (const message of messages) {
    const blocks = (message as { content?: unknown })?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const result = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      out.push({ tool_use_id: b.tool_use_id, result: result.slice(0, 20_000), result_status: b.is_error === true ? "error" : b.is_error === false ? "ok" : "unknown" });
    }
  }
  return out;
}
