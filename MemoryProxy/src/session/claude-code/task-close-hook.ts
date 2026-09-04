import { TASK_CLOSE_FORM_TITLE, TASK_CLOSE_COMPLETE, TASK_CLOSE_CONTINUE, TASK_CLOSE_CANCEL, TOOL_NAME } from "./form.js";

export interface TaskCloseHookState {
  prompted: boolean;
  pending: boolean;
}

export interface TaskCloseHookOptions {
  state: TaskCloseHookState;
  enabled: boolean;
  hasEvidenceActivity: () => boolean;
  model?: string;
  onPrompted?: () => void;
}

function completionCandidate(text: string, toolCount: number): boolean {
  if (toolCount > 0 || text.trim().length < 20) return false;
  return /(已完成|完成了|已修复|测试通过|实现完毕|任务完成|done|completed|fixed|tests? pass)/i.test(text);
}

/**
 * Holds only the terminal SSE frames long enough to turn an end_turn into a
 * native AskUserQuestion tool_use. This must sit on the client stream itself;
 * a background tee consumer cannot append frames after message_stop.
 */
export function createSseTaskCloseHookStream(options: TaskCloseHookOptions): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let outputText = "";
  let toolCount = 0;
  let maxIndex = -1;
  const model = options.model ?? "unknown";

  const encodeFrame = (event: string, data: Record<string, unknown>) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const emitFrame = (frame: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const lines = frame.split(/\r?\n/);
    const dataIndex = lines.findIndex((line) => line.startsWith("data:"));
    if (dataIndex < 0) { controller.enqueue(encoder.encode(frame + "\n\n")); return; }
    try {
      const event = JSON.parse(lines[dataIndex]!.slice(5).trim()) as Record<string, unknown>;
      const type = event.type;
      if (typeof event.index === "number") maxIndex = Math.max(maxIndex, event.index);
      if (type === "content_block_start") {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") toolCount += 1;
      }
      if (type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") outputText += delta.text;
      }
      if (type === "message_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        const stopReason = delta?.stop_reason;
        if (options.enabled && !options.state.prompted && stopReason === "end_turn" && options.hasEvidenceActivity() && completionCandidate(outputText, toolCount)) {
          options.state.prompted = true;
          options.state.pending = true;
          options.onPrompted?.();
          const index = maxIndex + 1;
          const toolUseId = `toolu_cc_task_close_${Date.now()}`;
          const input = {
            questions: [{
              question: `${TASK_CLOSE_FORM_TITLE}：当前任务看起来已经完成，是否结束本次任务并生成资产使用回执？`,
              header: "任务完成",
              options: [
                { label: TASK_CLOSE_COMPLETE, description: "采集 diff、测试结果并生成 Evidence receipt" },
                { label: TASK_CLOSE_CONTINUE, description: "继续当前任务，不关闭 TaskRun" },
                { label: TASK_CLOSE_CANCEL, description: "结束对话，但不生成完成回执" },
              ],
              multiSelect: false,
            }],
          };
          controller.enqueue(encodeFrame("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: toolUseId, name: TOOL_NAME, input: {} } }));
          controller.enqueue(encodeFrame("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }));
          controller.enqueue(encodeFrame("content_block_stop", { type: "content_block_stop", index }));
          const patched = { ...event, delta: { ...delta, stop_reason: "tool_use" } };
          lines[dataIndex] = `data: ${JSON.stringify(patched)}`;
        }
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
      if (pending.trim()) emitFrame(pending, controller);
    },
  });
}
