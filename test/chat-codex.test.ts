import { describe, expect, it } from 'vitest';
import { codexBody, codexHttpError, codexInput, codexResult } from '../src/background/chat-codex.js';
import type { AIMessage } from '../src/types.js';
import type { SseEvent } from '../src/background/sse.js';

async function* events(...items: Array<Record<string, unknown> | string>): AsyncGenerator<SseEvent> {
  for (const item of items) yield { event: 'message', data: typeof item === 'string' ? item : JSON.stringify(item) };
}

describe('ChatGPT request', () => {
  it('maps the history to Responses items: messages, function calls and their outputs, tool images after them', () => {
    const messages: AIMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', name: 'r.pdf' }] },
      { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'c1', name: 'browser', args: { action: 'observe' } }, { id: 'c2', name: 'browser', argsError: { raw: '{"act', message: 'x' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'browser', content: [{ type: 'text', text: 'page' }, { type: 'image', mediaType: 'image/jpeg', data: 'SU1H' }] },
      { role: 'tool', toolCallId: 'c2', name: 'browser', content: 'invalid', isError: true },
    ];
    expect(codexInput(messages)).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read this' }, { type: 'input_file', filename: 'r.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
      { type: 'function_call', call_id: 'c1', name: 'browser', arguments: '{"action":"observe"}' },
      { type: 'function_call', call_id: 'c2', name: 'browser', arguments: '{"act' },
      { type: 'function_call_output', call_id: 'c1', output: 'page' },
      { type: 'function_call_output', call_id: 'c2', output: 'Error: invalid' },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,SU1H' }] },
    ]);
  });

  it('sends tools as functions, one call at a time by default, and never an output cap', () => {
    const body = codexBody({ system: 'Drive.', messages: [{ role: 'user', content: 'go' }], maxTokens: 8000,
      tools: [{ name: 'browser', description: 'd', inputSchema: { type: 'object' } }] }, 'gpt-5.5');
    expect(body).toMatchObject({ model: 'gpt-5.5', store: false, stream: true, instructions: 'Drive.', tool_choice: 'auto', parallel_tool_calls: false,
      tools: [{ type: 'function', name: 'browser', description: 'd', parameters: { type: 'object' }, strict: false }] });
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('reasoning');
  });
});

describe('ChatGPT stream', () => {
  it('assembles text and a tool call whose arguments arrive in pieces', async () => {
    const result = await codexResult(events(
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'Opening ' },
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'it.' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'browser' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"action":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '"observe"}' },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'browser', arguments: '{"action":"observe"}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 120, output_tokens: 9 } } },
    ));
    expect(result).toEqual({ ok: true, text: 'Opening it.', toolCalls: [{ id: 'call_1', name: 'browser', args: { action: 'observe' } }], stopReason: 'tool_use', usage: { inputTokens: 120, outputTokens: 9 } });
  });

  it('takes whole arguments from the done item when no pieces came, and reports bad JSON as argsError', async () => {
    const result = await codexResult(events(
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'browser', arguments: '{"act' } },
      { type: 'response.completed', response: {} },
    ));
    expect(result.toolCalls?.[0]).toMatchObject({ id: 'call_1', name: 'browser', argsError: { raw: '{"act' } });
  });

  it('never hands out a call from a turn cut off by the limit', async () => {
    const result = await codexResult(events(
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', call_id: 'c', name: 'browser' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"action":"na' },
      { type: 'response.incomplete', response: { status: 'incomplete' } },
    ));
    expect(result).toEqual({ ok: true, stopReason: 'length' });
  });

  it('fails on an error event, a failed response, or a stream that ends before completing', async () => {
    expect(await codexResult(events({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'secret prompt echo' } })))
      .toEqual({ ok: false, error: 'Your ChatGPT plan’s limit is reached. Wait for it to reset.' });
    expect((await codexResult(events({ type: 'response.failed', response: { error: { code: 'server_error' } } }))).ok).toBe(false);
    expect(await codexResult(events({ type: 'response.output_text.delta', item_id: 'm', delta: 'half' })))
      .toEqual({ ok: false, error: 'The response stream ended before it finished.' });
  });
});

describe('ChatGPT errors', () => {
  it('say what happened without echoing provider text', () => {
    expect(codexHttpError(401, '{"error":{"message":"your prompt was..."}}')).toBe('ChatGPT rejected this sign-in. Sign in again in Settings.');
    expect(codexHttpError(400, '{"detail":"The \'gpt-9\' model is not supported when using Codex with a ChatGPT account."}')).toMatch(/not available for this ChatGPT account/);
    expect(codexHttpError(400, '{"error":{"code":"bad_thing","message":"leaks the request"}}')).toBe('ChatGPT refused the request (HTTP 400; bad_thing).');
    expect(codexHttpError(503, 'oops')).toBe('ChatGPT’s backend failed (HTTP 503).');
  });
});
