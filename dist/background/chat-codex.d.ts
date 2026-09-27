/**
 * `chat()` for the ChatGPT subscription: OpenAI's Codex backend
 * (`chatgpt.com/backend-api/codex/responses`, the Responses API) with the
 * account's own sign-in, streamed, with function tools.
 *
 * Request: `instructions` is the system prompt; the history becomes Responses
 * input items — messages, and tool calls and results as top-level
 * `function_call` / `function_call_output` items. Tool results carry text
 * only, so their images follow as one user message.
 *
 * Backend quirks:
 *  - `max_output_tokens` is refused, so no output cap is sent;
 *  - `store: false`, and no encrypted reasoning is asked for: with nothing
 *    to replay it into, asking makes tool continuations fail;
 *  - the answer always streams.
 *
 * Provider error text is never copied into an error: it can echo the request.
 */
import type { AIChatRequest, AIChatResult, AIMessage } from '../types.js';
import type { SseEvent } from './sse.js';
export declare const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
type Item = Record<string, unknown>;
/** The history as Responses input items. */
export declare function codexInput(messages: AIMessage[]): Item[];
export declare function codexBody(req: AIChatRequest, model: string): Record<string, unknown>;
/** An HTTP failure in words, without the provider's own text. */
export declare function codexHttpError(status: number, body: string): string;
/**
 * The Responses stream, assembled into one turn. The result counts only once
 * `response.completed` (or `response.incomplete`) has arrived; `error` and
 * `response.failed` are failures, and so is a stream that ends before either.
 */
export declare function codexResult(events: AsyncIterable<SseEvent>): Promise<AIChatResult>;
export {};
