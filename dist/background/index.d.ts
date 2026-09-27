import { type AIChatRequest, type AIChatResult } from '../types.js';
/**
 * All AI secret handling. Users save any number of connections; one is
 * active at a time. Keys are encrypted at rest (crypto.ts) and stored as
 * ciphertext in chrome.storage.local; UI surfaces only ever get a redacted
 * view. Provider calls run here so keys never enter page frames and CORS is
 * avoided (for hosts the worker has permission for).
 *
 * Wire it up in the service worker:
 *
 *   import { registerAiHandlers } from '@amenophis1er/extension-ai-connect/background';
 *   registerAiHandlers({ prefix: 'myext' });
 *
 * or compose with an existing onMessage listener via createAiMessageHandler.
 */
export interface AiHandlerOptions {
    /** Message-type prefix: handlers match `${prefix}:ai-<op>`. Default 'aiconnect'. */
    prefix?: string;
    /** chrome.storage.local key holding the connection config. Default 'aiConnections'. */
    storageKey?: string;
    /** IndexedDB database holding the non-extractable AES key. Default 'ai-connect-crypto'. */
    cryptoDbName?: string;
    /** chrome.storage.local boolean flag enabling request/response logging. Default 'aiConnectDebug'. */
    debugFlagKey?: string;
    /** Appended to "no/incomplete connection" errors — tell users where your settings live. */
    settingsHint?: string;
    /** Open the OAuth consent page in a new tab on login-start (needs nothing beyond tabs.create). Default true. */
    openConsentTab?: boolean;
}
/** How long the UI should wait before the next poll. */
export declare function chatgptPollDelay(intervalSec: number, slowDowns: number): number;
/**
 * One model turn with tools, called directly inside the worker (D4).
 *
 * Streams the response (SSE) and returns it only after the provider's terminal
 * event. Uses the pinned connection when `connectionId` is given; if that
 * connection is gone, or its `revision` moved since the run started, the call
 * fails rather than send the conversation somewhere the run did not start.
 */
export declare function chat(req: AIChatRequest, options?: {
    signal?: AbortSignal;
}): Promise<AIChatResult>;
/**
 * Build a message handler for composing with an existing onMessage listener.
 * Returns true if it handled the message (and will call sendResponse
 * asynchronously) — propagate that return so Chrome keeps the channel open.
 */
export declare function createAiMessageHandler(options?: AiHandlerOptions): (message: {
    type?: string;
}, sendResponse: (r: unknown) => void) => boolean;
/** One-call wiring: adds its own chrome.runtime.onMessage listener. */
export declare function registerAiHandlers(options?: AiHandlerOptions): void;
export { CODEX_MODELS } from './openai-oauth.js';
