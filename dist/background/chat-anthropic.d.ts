/**
 * `chat()` for Anthropic: the Messages API, streamed, with tools.
 *
 * Request: tools as `{name, description, input_schema}`, the last tool and the
 * system prompt marked `cache_control` (they are the stable prefix), and
 * `tool_choice: {type: "auto", disable_parallel_tool_use}` — never forced
 * tool use, which some models reject. Tool results go back as `tool_result`
 * blocks in one user message.
 *
 * Response: SSE. Content blocks are rebuilt from their deltas; tool inputs
 * from `input_json_delta` fragments, parsed strictly at the end. The result
 * counts only after `message_stop` with no `error` event before it.
 *
 * Replay: the assistant turn's content blocks — thinking blocks with their
 * signatures, text, tool_use — are returned as `providerState` and sent back
 * verbatim on the next request, as the API requires for thinking blocks.
 */
import type { AIChatRequest, AIChatResult, AIMessage } from '../types.js';
import type { SseEvent } from './sse.js';
type Block = Record<string, unknown> & {
    type: string;
};
export interface AnthropicAuth {
    /** API key (x-api-key) or subscription token (Bearer). */
    token: string;
    subscription: boolean;
}
export declare const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;
export declare function anthropicMessages(messages: AIMessage[]): Array<{
    role: 'user' | 'assistant';
    content: string | Block[];
}>;
/** The request body. `system` is the already-prepared system blocks (the subscription sentinel is the caller's). */
export declare function anthropicBody(req: AIChatRequest, model: string, system: Array<{
    type: 'text';
    text: string;
}>): Record<string, unknown>;
/** Rebuild the response from its SSE events. Anything short of a clean `message_stop` is a failure. */
export declare function anthropicResult(events: AsyncIterable<SseEvent>): Promise<AIChatResult>;
export {};
