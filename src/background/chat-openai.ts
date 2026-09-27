/**
 * `chat()` for OpenAI-compatible servers: Chat Completions, streamed, with
 * function tools. Covers OpenAI, OpenRouter, Ollama (local and ollama.com)
 * and anything else speaking `/v1/chat/completions`.
 *
 * Request: `tools: [{type: "function", function: {name, description,
 * parameters}}]` and `parallel_tool_calls: false` unless asked otherwise (the
 * caller retries without it when a server rejects the field). OpenAI's own API
 * takes `max_completion_tokens`; everyone else takes `max_tokens`.
 *
 * Response: SSE of `chat.completion.chunk`s. Tool calls arrive as fragments
 * keyed by `index` — some servers send the whole call in one chunk, OpenAI
 * splits `arguments` across many — and are parsed strictly once the stream
 * finishes. The result counts only once a `finish_reason` has arrived; an
 * error chunk or a stream that ends before one is a failure. `[DONE]` closes
 * the stream but is not required: not every server sends it.
 */

import type { AIChatRequest, AIChatResult, AIContentPart, AIMessage, AIStopReason, AIToolCall } from '../types.js';
import type { SseEvent } from './sse.js';

export const OPENAI_DEFAULT_MAX_TOKENS = 16000;

type ChatMessage = Record<string, unknown>;

function textOf(content: string | AIContentPart[]): string {
  return typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
}

type Media = Exclude<AIContentPart, { type: 'text' }>;

/** Images and documents: what a tool message cannot carry in Chat Completions. */
function mediaOf(content: string | AIContentPart[]): Media[] {
  return typeof content === 'string' ? [] : content.filter((part): part is Media => part.type !== 'text');
}

function userContent(content: string | AIContentPart[]): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'document') return { type: 'file', file: { filename: part.name ?? 'document.pdf', file_data: `data:${part.mediaType};base64,${part.data}` } };
    return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } };
  });
}

export function openaiMessages(system: string, messages: AIMessage[]): ChatMessage[] {
  const out: ChatMessage[] = system ? [{ role: 'system', content: system }] : [];
  // Tool messages cannot carry images or documents in Chat Completions: they
  // follow the tool results as one user message instead.
  let pendingImages: Media[] = [];
  const flushImages = () => {
    if (pendingImages.length === 0) return;
    out.push({ role: 'user', content: userContent(pendingImages) });
    pendingImages = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: textOf(message.content) });
      pendingImages.push(...mediaOf(message.content));
      continue;
    }
    flushImages();
    if (message.role === 'user') {
      out.push({ role: 'user', content: userContent(message.content) });
      continue;
    }
    const calls = message.toolCalls ?? [];
    out.push({
      role: 'assistant',
      content: message.content ?? (calls.length > 0 ? null : ''),
      ...(calls.length > 0 ? {
        tool_calls: calls.map((call) => ({ id: call.id, type: 'function',
          function: { name: call.name, arguments: call.argsError ? call.argsError.raw : JSON.stringify(call.args ?? {}) } })),
      } : {}),
    });
  }
  flushImages();
  return out;
}

/** The request body. `omitParallel` drops `parallel_tool_calls` for servers that reject it. */
export function openaiBody(req: AIChatRequest, model: string, base: string, omitParallel = false): Record<string, unknown> {
  const tools = (req.tools ?? []).map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  const openai = /(^|\.)openai\.com$/i.test(safeHost(base));
  return {
    model,
    stream: true,
    [openai ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens ?? OPENAI_DEFAULT_MAX_TOKENS,
    messages: openaiMessages(req.system, req.messages),
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && !omitParallel ? { parallel_tool_calls: req.parallelToolCalls === true } : {}),
  };
}

function safeHost(base: string): string {
  try { return new URL(base).hostname; } catch { return ''; }
}

/** A 400 that complains about `parallel_tool_calls`: retry without the field. */
export function rejectsParallel(status: number, body: string): boolean {
  return status === 400 && /parallel_tool_calls/i.test(body);
}

const STOP: Record<string, AIStopReason> = {
  stop: 'end', tool_calls: 'tool_use', function_call: 'tool_use', length: 'length', content_filter: 'refusal',
};

/** Strip reasoning some local models emit inline despite instructions. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim();
}

export async function openaiResult(events: AsyncIterable<SseEvent>): Promise<AIChatResult> {
  let text = '';
  const fragments = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | undefined;
  let usage: AIChatResult['usage'];

  for await (const { data } of events) {
    if (data.trim() === '[DONE]') break;
    let chunk: Record<string, any>;
    try { chunk = JSON.parse(data) as Record<string, any>; } catch { return { ok: false, error: 'Malformed stream chunk.' }; }
    if (chunk['error']) {
      const error = chunk['error'];
      return { ok: false, error: typeof error === 'string' ? error : String(error['message'] ?? 'the stream reported an error') };
    }
    if (chunk['usage']) {
      usage = { inputTokens: chunk['usage']['prompt_tokens'] ?? 0, outputTokens: chunk['usage']['completion_tokens'] ?? 0 };
    }
    const choice = chunk['choices']?.[0];
    if (!choice) continue;
    const delta = choice['delta'] ?? {};
    if (typeof delta['content'] === 'string') text += delta['content'];
    for (const piece of delta['tool_calls'] ?? []) {
      const index = typeof piece['index'] === 'number' ? piece['index'] : fragments.size;
      const current = fragments.get(index) ?? { id: '', name: '', args: '' };
      if (piece['id']) current.id = piece['id'];
      if (piece['function']?.['name']) current.name += piece['function']['name'];
      if (typeof piece['function']?.['arguments'] === 'string') current.args += piece['function']['arguments'];
      fragments.set(index, current);
    }
    if (choice['finish_reason']) finishReason = choice['finish_reason'];
  }
  if (!finishReason) return { ok: false, error: 'The response stream ended before it finished.' };

  const toolCalls: AIToolCall[] = [...fragments.entries()].sort(([a], [b]) => a - b).map(([index, fragment]) => {
    const call: AIToolCall = { id: fragment.id || `call_${index}`, name: fragment.name };
    try {
      const parsed: unknown = fragment.args.trim() === '' ? {} : JSON.parse(fragment.args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) call.args = parsed as Record<string, unknown>;
      else call.argsError = { raw: fragment.args, message: 'Tool arguments are not a JSON object.' };
    } catch (error) {
      call.argsError = { raw: fragment.args, message: error instanceof Error ? error.message : 'Invalid JSON.' };
    }
    return call;
  });

  const mapped = STOP[finishReason] ?? 'end';
  // A turn cut off by the token limit or a filter may carry a truncated call: never hand one out.
  const runnable = mapped === 'tool_use' || mapped === 'end';
  const cleaned = stripThinking(text);
  return {
    ok: true,
    ...(cleaned ? { text: cleaned } : {}),
    ...(runnable && toolCalls.length > 0 ? { toolCalls } : {}),
    stopReason: runnable && toolCalls.length > 0 ? 'tool_use' : mapped,
    ...(usage ? { usage } : {}),
  };
}
