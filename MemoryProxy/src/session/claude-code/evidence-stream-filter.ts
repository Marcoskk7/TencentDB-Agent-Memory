const OPEN = "<asset_usage";
const CLOSE = /<\/asset_usage\s*>/i;
const MAX_PROTOCOL = 64 * 1024;

/** Stateful, bounded filter for assistant text SSE deltas. */
export class AssetUsageTextFilter {
  private pending = "";
  private inside = "";

  push(text: string): string {
    if (this.inside) return this.consumeInside(text);
    return this.consumePlain(this.pending + text);
  }

  finish(): string {
    if (this.inside) { const leaked = this.inside; this.inside = ""; return leaked; }
    const tail = this.pending; this.pending = ""; return tail;
  }

  private consumePlain(value: string): string {
    const lower = value.toLowerCase();
    const found = lower.indexOf(OPEN);
    if (found >= 0) {
      const before = value.slice(0, found);
      this.pending = "";
      return before + this.consumeInside(value.slice(found));
    }
    let keep = 0;
    for (let length = Math.min(OPEN.length - 1, value.length); length > 0; length--) {
      if (OPEN.startsWith(lower.slice(-length))) { keep = length; break; }
    }
    this.pending = value.slice(value.length - keep);
    return value.slice(0, value.length - keep);
  }

  private consumeInside(value: string): string {
    this.inside += value;
    const close = CLOSE.exec(this.inside);
    if (close) {
      const rest = this.inside.slice(close.index + close[0].length);
      this.inside = "";
      return this.consumePlain(rest);
    }
    if (this.inside.length > MAX_PROTOCOL) {
      // A malformed/unclosed marker is ordinary text, not permission to drop
      // the rest of an answer. Release it after the bounded safety window.
      const malformed = this.inside;
      this.inside = "";
      return malformed;
    }
    return "";
  }
}

/** Filter only text_delta payloads, leaving tool/thinking event ordering intact. */
export function createSseAssetUsageFilterStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder(); const encoder = new TextEncoder();
  const filters = new Map<number, AssetUsageTextFilter>(); let pending = "";
  const emitFrame = (frame: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const lines = frame.split(/\r?\n/); const index = lines.findIndex((line) => line.startsWith("data:"));
    if (index < 0) { controller.enqueue(encoder.encode(frame + "\n\n")); return; }
    try {
      const event = JSON.parse(lines[index]!.slice(5).trim()) as Record<string, unknown>;
      const delta = event.delta as Record<string, unknown> | undefined;
      const blockIndex = typeof event.index === "number" ? event.index : -1;
      const block = event.content_block as Record<string, unknown> | undefined;
      if (event.type === "content_block_start" && block?.type === "text" && typeof block.text === "string") {
        const filter = new AssetUsageTextFilter(); filters.set(blockIndex, filter);
        block.text = filter.push(block.text);
        lines[index] = `data: ${JSON.stringify(event)}`;
      }
      if (event.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
        const filter = filters.get(blockIndex) ?? new AssetUsageTextFilter(); filters.set(blockIndex, filter);
        delta.text = filter.push(delta.text);
        lines[index] = `data: ${JSON.stringify(event)}`;
      }
      if (event.type === "content_block_stop") {
        const filter = filters.get(blockIndex);
        const tail = filter?.finish() ?? ""; filters.delete(blockIndex);
        if (tail) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: tail } })}\n\n`));
      }
      controller.enqueue(encoder.encode(lines.join("\n") + "\n\n"));
    } catch { controller.enqueue(encoder.encode(frame + "\n\n")); }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop() ?? "";
      for (const frame of frames) emitFrame(frame, controller);
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) emitFrame(pending, controller);
      // Do not emit synthetic text after EOF: without content_block_stop it
      // has no safe Anthropic ordering/index contract.
    },
  });
}
