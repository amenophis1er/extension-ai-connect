/**
 * OpenAI-compatible mapping: request body, and the response rebuilt from SSE.
 * Two fixtures are live recordings from ollama.com (test/fixtures/README.md);
 * the rest follow OpenAI's chunk shape, where `arguments` arrive in fragments.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openaiBody, openaiMessages, openaiResult, rejectsParallel } from '../src/background/chat-openai.js';
import { readSse } from '../src/background/sse.js';
import type { AIChatRequest, AIMessage } from '../src/types.js';
import { openaiSse, streamOf } from './helpers.js';

const TOOL = { name: 'browser', description: 'Control a page.', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const parse = (text: string, size = 11) => openaiResult(readSse(streamOf(text, size)));
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });

describe('request body', () => {
  const req: AIChatRequest = { system: 'You drive a browser.', messages: [{ role: 'user', content: 'go' }], tools: [TOOL] };

  it('sends function tools, parallel calls off, and max_tokens to a compatible server', () => {
    expect(openaiBody(req, 'gpt-oss:20b', 'https://ollama.com')).toEqual({
      model: 'gpt-oss:20b', stream: true, max_tokens: 16000,
      messages: [{ role: 'system', content: 'You drive a browser.' }, { role: 'user', content: 'go' }],
      tools: [{ type: 'function', function: { name: 'browser', description: 'Control a page.', parameters: TOOL.inputSchema } }],
      parallel_tool_calls: false,
    });
  });

  it('uses max_completion_tokens for OpenAI itself, and can drop parallel_tool_calls', () => {
    const body = openaiBody(req, 'gpt-5.5', 'https://api.openai.com', true);
    expect(body).toHaveProperty('max_completion_tokens', 16000);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('parallel_tool_calls');
    expect(rejectsParallel(400, '{"error":{"message":"Unrecognized request argument supplied: parallel_tool_calls"}}')).toBe(true);
    expect(rejectsParallel(400, '{"error":"bad model"}')).toBe(false);
  });

  it('maps tool calls and results, echoes unparseable arguments as they came, and moves tool images to a user message', () => {
    const messages: AIMessage[] = [
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'browser', args: { action: 'observe' } }, { id: 'c2', name: 'browser', argsError: { raw: '{"act', message: 'x' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'browser', content: [{ type: 'text', text: 'page' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
      { role: 'tool', toolCallId: 'c2', name: 'browser', content: 'invalid', isError: true },
    ];
    expect(openaiMessages('', messages)).toEqual([
      { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'browser', arguments: '{"action":"observe"}' } },
        { id: 'c2', type: 'function', function: { name: 'browser', arguments: '{"act' } },
      ] },
      { role: 'tool', tool_call_id: 'c1', content: 'page' },
      { role: 'tool', tool_call_id: 'c2', content: 'invalid' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ]);
  });
});

describe('streamed response', () => {
  it('parses a live ollama.com recording: reasoning ignored, one whole tool call', async () => {
    const result = await parse(fixture('openai-ollama-toolcall.sse'));
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([{ id: 'call_0erffa5d', name: 'browser', args: { action: 'open', url: 'https://example.com' } }]);
    expect(result.text).toBeUndefined();
  });

  it('parses the second live recording', async () => {
    const result = await parse(fixture('openai-ollama-glm-toolcall.sse'), 3);
    expect(result.toolCalls).toEqual([{ id: 'call_9fk0toch', name: 'browser', args: { action: 'navigate', url: 'https://example.com' } }]);
  });

  it('assembles arguments that arrive in fragments, for two calls, by index', async () => {
    const text = openaiSse([
      chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'browser', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"action":' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'browser', arguments: '{"action":"observe"}' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"navigate"}' } }] }),
      chunk({}, 'tool_calls'),
    ]);
    const result = await parse(text, 5);
    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'browser', args: { action: 'navigate' } },
      { id: 'call_b', name: 'browser', args: { action: 'observe' } },
    ]);
  });

  it('returns text, strips inline think tags, and maps finish reasons', async () => {
    const result = await parse(openaiSse([chunk({ content: '<think>hmm</think>The mug ' }), chunk({ content: 'costs $12.' }, 'stop')]));
    expect(result).toMatchObject({ ok: true, text: 'The mug costs $12.', stopReason: 'end' });
  });

  it('keeps unparseable arguments as argsError', async () => {
    const result = await parse(openaiSse([chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'browser', arguments: '{"action": nav' } }] }), chunk({}, 'tool_calls')]));
    expect(result.toolCalls![0]).toMatchObject({ id: 'c', argsError: { raw: '{"action": nav' } });
  });

  it('hands out no tool call from a turn cut off by the length limit or a filter', async () => {
    for (const [finish, mapped] of [['length', 'length'], ['content_filter', 'refusal']] as const) {
      const result = await parse(openaiSse([chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'browser', arguments: '{"action":"nav' } }] }), chunk({}, finish)]));
      expect(result.stopReason).toBe(mapped);
      expect(result.toolCalls).toBeUndefined();
    }
  });

  it('fails on an error chunk, and when the stream ends before a finish_reason', async () => {
    expect(await parse(openaiSse([chunk({ content: 'x' }), { error: { message: 'upstream overloaded' } }]))).toEqual({ ok: false, error: 'upstream overloaded' });
    expect(await parse(openaiSse([chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'browser', arguments: '{"action":"observe"}' } }] })], false)))
      .toEqual({ ok: false, error: 'The response stream ended before it finished.' });
  });

  it('accepts a finish_reason with no [DONE] after it', async () => {
    const result = await parse(openaiSse([chunk({ content: 'ok' }, 'stop')], false));
    expect(result).toMatchObject({ ok: true, text: 'ok' });
  });
});
