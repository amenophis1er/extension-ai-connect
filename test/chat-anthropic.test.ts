/**
 * Anthropic mapping: the request body, and the response rebuilt from SSE.
 * Stream fixtures follow the documented Messages streaming event sequence
 * (message_start, content_block_start/delta/stop, message_delta, message_stop).
 */
import { describe, expect, it } from 'vitest';
import { anthropicBody, anthropicMessages, anthropicResult } from '../src/background/chat-anthropic.js';
import { readSse } from '../src/background/sse.js';
import type { AIChatRequest, AIMessage } from '../src/types.js';
import { anthropicSse, streamOf } from './helpers.js';

const TOOL = { name: 'browser', description: 'Control a page.', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } };
const parse = (payloads: Array<Record<string, unknown>>, size = 9) => anthropicResult(readSse(streamOf(anthropicSse(payloads), size)));

const start = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 120, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 1 } } };
const stop = (reason: string, output = 40) => [
  { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: output } },
  { type: 'message_stop' },
];
const toolUse = (index: number, id: string, fragments: string[]) => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'browser', input: {} } },
  ...fragments.map((partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
  { type: 'content_block_stop', index },
];

describe('request body', () => {
  const req: AIChatRequest = { system: 'You drive a browser.', messages: [{ role: 'user', content: 'Open example.com' }], tools: [TOOL] };

  it('marks the system prompt and the last tool as the cached prefix, and turns parallel calls off', () => {
    const body = anthropicBody(req, 'claude-opus-5', [{ type: 'text', text: 'You drive a browser.' }]);
    expect(body).toMatchObject({
      model: 'claude-opus-5', max_tokens: 16000, stream: true,
      system: [{ type: 'text', text: 'You drive a browser.', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'browser', description: 'Control a page.', input_schema: TOOL.inputSchema, cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    });
  });

  it('allows parallel calls only when asked, and sends no tool_choice without tools', () => {
    expect(anthropicBody({ ...req, parallelToolCalls: true }, 'm', [])['tool_choice']).toEqual({ type: 'auto', disable_parallel_tool_use: false });
    const bare = anthropicBody({ ...req, tools: [] }, 'm', []);
    expect(bare).not.toHaveProperty('tools');
    expect(bare).not.toHaveProperty('tool_choice');
    expect(bare).not.toHaveProperty('system');
  });

  it('replays the provider\'s own blocks verbatim, and puts all tool results for a turn in one user message', () => {
    const state = [
      { type: 'thinking', thinking: 'plan', signature: 'sig-abc' },
      { type: 'tool_use', id: 'toolu_1', name: 'browser', input: { action: 'navigate' } },
      { type: 'tool_use', id: 'toolu_2', name: 'browser', input: { action: 'observe' } },
    ];
    const messages: AIMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', toolCalls: [{ id: 'toolu_1', name: 'browser', args: {} }], providerState: state },
      { role: 'tool', toolCallId: 'toolu_1', name: 'browser', content: '{"completed":true}' },
      { role: 'tool', toolCallId: 'toolu_2', name: 'browser', content: 'refused', isError: true },
      { role: 'user', content: 'also check the price' },
    ];
    expect(anthropicMessages(messages)).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: state },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"completed":true}' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'refused', is_error: true },
      ] },
      { role: 'user', content: 'also check the price' },
    ]);
  });

  it('rebuilds an assistant turn without provider state, and maps images to base64 blocks', () => {
    const messages: AIMessage[] = [
      { role: 'assistant', content: 'Opening it.', toolCalls: [{ id: 't1', name: 'browser', args: { action: 'observe' } }] },
      { role: 'tool', toolCallId: 't1', name: 'browser', content: [{ type: 'text', text: 'ok' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
    ];
    expect(anthropicMessages(messages)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'Opening it.' }, { type: 'tool_use', id: 't1', name: 'browser', input: { action: 'observe' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
        { type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ] }] },
    ]);
  });
});

describe('streamed response', () => {
  it('returns text and usage for a plain answer', async () => {
    const result = await parse([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'ping' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done: ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the mug is $12.' } },
      { type: 'content_block_stop', index: 0 }, ...stop('end_turn', 12)]);
    expect(result).toMatchObject({ ok: true, text: 'Done: the mug is $12.', stopReason: 'end',
      usage: { inputTokens: 120, outputTokens: 12, cacheReadTokens: 100, cacheWriteTokens: 0 } });
    expect(result.toolCalls).toBeUndefined();
  });

  it('assembles a tool call from input_json_delta fragments and keeps thinking with its signature for replay', async () => {
    const result = await parse([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need to ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'navigate.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQBCgIYAh' } },
      { type: 'content_block_stop', index: 0 },
      ...toolUse(1, 'toolu_01', ['{"action": "nav', 'igate", "url": "https://exa', 'mple.com"}']),
      ...stop('tool_use')]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([{ id: 'toolu_01', name: 'browser', args: { action: 'navigate', url: 'https://example.com' } }]);
    expect(result.providerState).toEqual([
      { type: 'thinking', thinking: 'Need to navigate.', signature: 'EqQBCgIYAh' },
      { type: 'tool_use', id: 'toolu_01', name: 'browser', input: { action: 'navigate', url: 'https://example.com' } },
    ]);
  });

  it('returns two calls in one response in order', async () => {
    const result = await parse([start, ...toolUse(0, 'a', ['{"action":"navigate"}']), ...toolUse(1, 'b', ['{"action":"observe"}']), ...stop('tool_use')]);
    expect(result.toolCalls!.map((call) => call.id)).toEqual(['a', 'b']);
  });

  it('keeps arguments that are not valid JSON as argsError instead of guessing', async () => {
    const result = await parse([start, ...toolUse(0, 'x', ['{"action": "nav']), ...stop('tool_use')]);
    expect(result.toolCalls![0]).toMatchObject({ id: 'x', argsError: { raw: '{"action": "nav' } });
    expect(result.toolCalls![0]!.args).toBeUndefined();
  });

  it('hands out no tool call from a turn cut off by max_tokens or a refusal', async () => {
    for (const reason of ['max_tokens', 'refusal']) {
      const result = await parse([start, ...toolUse(0, 'x', ['{"action":"navigate","url":"https://ex']), ...stop(reason)]);
      expect(result.ok).toBe(true);
      expect(result.stopReason).toBe(reason === 'max_tokens' ? 'length' : 'refusal');
      expect(result.toolCalls).toBeUndefined();
      expect(result.providerState).toEqual([]);
    }
  });

  it('fails on an error event after HTTP 200, even if everything before it looked fine', async () => {
    const result = await parse([start, ...toolUse(0, 'x', ['{"action":"observe"}']),
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
    expect(result).toEqual({ ok: false, error: 'overloaded_error: Overloaded' });
  });

  it('fails when the stream ends before message_stop, even after complete-looking arguments', async () => {
    const result = await parse([start, ...toolUse(0, 'x', ['{"action":"observe"}']), { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }]);
    expect(result).toEqual({ ok: false, error: 'The response stream ended before it finished.' });
  });
});
