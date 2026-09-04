import { describe, expect, it } from 'vitest';
import { createSseAssetUsageFilterStream } from '../evidence-stream-filter.js';
import { createSseTaskCloseHookStream } from '../task-close-hook.js';

const encoder = new TextEncoder();
const frame = (event: object) => `event: message\ndata: ${JSON.stringify(event)}\n\n`;
const delta = (text: string, index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
async function filter(events: object[]) {
  const bytes = encoder.encode(events.map(frame).join(''));
  const input = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const output = await new Response(input.pipeThrough(createSseAssetUsageFilterStream())).text();
  return output.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
}

async function closeHook(events: object[], state = { prompted: false, pending: false }) {
  const bytes = encoder.encode(events.map(frame).join(''));
  const input = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const output = await new Response(input.pipeThrough(createSseTaskCloseHookStream({ state, enabled: true, hasEvidenceActivity: () => true }))).text();
  return output.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
}

describe('evidence SSE production filter', () => {
  it('preserves block index and emits partial plain-text tails before the block stops', async () => {
    const events = await filter([delta('你好<', 2), { type: 'content_block_stop', index: 2 }, { type: 'message_stop' }]);
    expect(events.map(event => event.delta?.text ?? '').join('')).toBe('你好<');
    expect(events[1]).toMatchObject({ type: 'content_block_delta', index: 2, delta: { text: '<' } });
    expect(events.at(-1).type).toBe('message_stop');
  });

  it('uses the same case-insensitive hidden-tag grammar as the claim parser', async () => {
    const events = await filter([delta('before<AS'), delta('SET_USAGE >{"secret":"hidden"}</ASSET_USAGE >after'), { type: 'content_block_stop', index: 0 }]);
    expect(events.map(event => event.delta?.text ?? '').join('')).toBe('beforeafter');
  });

  it('filters text delivered in content_block_start as well as delta frames', async () => {
    const events = await filter([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'before<asset_usage>' } },
      delta('hidden</asset_usage>after'), { type: 'content_block_stop', index: 0 },
    ]);
    expect(events.map(event => event.content_block?.text ?? event.delta?.text ?? '').join('')).toBe('beforeafter');
  });

  it('emits ordinary text without waiting for the response to close', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const reader = input.pipeThrough(createSseAssetUsageFilterStream()).getReader();
    source.enqueue(encoder.encode(frame(delta('immediate'))));
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('immediate');
    source.close();
    expect((await reader.read()).done).toBe(true);
  });

  it('turns a completed evidence response into one native close confirmation', async () => {
    const events = await closeHook([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      delta('任务已完成，代码已经修复并且测试通过。下面是本次修改涉及的文件和验证结果。', 0),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
    expect(events.some(event => event.type === 'content_block_start' && event.content_block?.name === 'AskUserQuestion')).toBe(true);
    expect(events.find(event => event.type === 'message_delta')?.delta?.stop_reason).toBe('tool_use');
  });
});
