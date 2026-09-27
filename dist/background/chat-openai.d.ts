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
import type { AIChatRequest, AIChatResult, AIMessage } from '../types.js';
import type { SseEvent } from './sse.js';
export declare const OPENAI_DEFAULT_MAX_TOKENS = 16000;
type ChatMessage = Record<string, unknown>;
export declare function openaiMessages(system: string, messages: AIMessage[]): ChatMessage[];
/** The request body. `omitParallel` drops `parallel_tool_calls` for servers that reject it. */
export declare function openaiBody(req: AIChatRequest, model: string, base: string, omitParallel?: boolean): Record<string, unknown>;
/** A 400 that complains about `parallel_tool_calls`: retry without the field. */
export declare function rejectsParallel(status: number, body: string): boolean;
export declare function openaiResult(events: AsyncIterable<SseEvent>): Promise<AIChatResult>;
export {};
