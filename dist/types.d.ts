/**
 * Types and the message protocol between an extension's UI surfaces and its
 * background worker.
 *
 * The user can save any number of CONNECTIONS (an OpenAI key, a local
 * Ollama, an Anthropic key, several of each) and pick one active at a time.
 * All secret handling lives in the background worker: keys are encrypted at
 * rest with a non-extractable key and stored as ciphertext; the UI only ever
 * sends a freshly-typed key to save and receives a REDACTED view (hasKey +
 * hint), never the key back — so plaintext keys never enter page frames.
 *
 * Message `type` strings are `${prefix}:ai-<op>`; the prefix is chosen by
 * the host extension (see registerAiHandlers / createAiClient).
 */
/**
 * 'chatgpt'        = ChatGPT subscription via the Codex backend (Responses
 *                    API) — a different wire protocol from openai-compatible.
 * 'chrome-builtin' = Chrome's on-device model. Runs in a PAGE context, not
 *                    the worker (no key, no CORS, and model downloads need a
 *                    user gesture) — the host extension wires that side.
 */
export type ProviderKind = 'anthropic' | 'openai-compatible' | 'chatgpt' | 'chrome-builtin';
/** How a connection authenticates. 'key' = API key; 'oauth'/'setup-token'
 *  = a Claude Pro/Max subscription token (Bearer, refreshable / long-lived). */
export type AuthMode = 'key' | 'oauth' | 'setup-token';
/** A saved connection, minus the secret (what the settings UI sees). */
export interface ConnectionView {
    id: string;
    kind: ProviderKind;
    auth: AuthMode;
    label: string;
    baseUrl: string;
    model: string;
    hasKey: boolean;
    /** e.g. "····a1b2" — last chars only, for recognition. */
    keyHint: string;
}
export interface AIConfigView {
    activeId: string | null;
    connections: ConnectionView[];
}
/** Preset base URLs offered in the UI for openai-compatible connections. */
export declare const OPENAI_COMPATIBLE_PRESETS: {
    label: string;
    baseUrl: string;
    /** Local/self-hosted endpoints usually need no key. */
    keyOptional?: boolean;
}[];
/** Normalize a user-typed base URL: add scheme, drop trailing slash and /v1. */
export declare function normalizeBaseUrl(url: string): string;
/** Host-permission match pattern for a base URL's origin (port-agnostic). */
export declare function originPattern(baseUrl: string): string | null;
/** A sensible default label for a connection. */
export declare function defaultLabel(kind: ProviderKind, baseUrl: string): string;
export interface AIGetRequest {
    type: string;
}
export interface AISetActiveRequest {
    type: string;
    id: string | null;
}
export interface AISaveConnectionRequest {
    type: string;
    /** Omit to create; provide to update an existing connection. */
    id?: string;
    kind: ProviderKind;
    label: string;
    baseUrl: string;
    model: string;
    /** 'set' stores `apiKey`; 'keep' leaves the stored key; 'clear' removes it. */
    apiKeyMode: 'set' | 'keep' | 'clear';
    apiKey?: string;
    /** Make this the active connection after saving. */
    makeActive?: boolean;
}
export interface AIDeleteConnectionRequest {
    type: string;
    id: string;
}
export interface AIListModelsRequest {
    type: string;
    kind: ProviderKind;
    baseUrl: string;
    /** Freshly typed key; empty means "use the saved key for `id`". */
    apiKey: string;
    /** Existing connection whose stored key to fall back on. */
    id?: string;
}
export interface AICompleteRequest {
    type: string;
    system: string;
    prompt: string;
    maxTokens?: number;
}
export interface AIAnthropicLoginStartRequest {
    type: string;
}
/** Reply from login-start: the worker opened the consent tab; the UI shows
 *  the authorize URL as a fallback link and waits for the pasted code. */
export interface AIAnthropicLoginStart {
    authorizeUrl: string;
}
export interface AIAnthropicLoginCompleteRequest {
    type: string;
    /** The `code#state` string the consent page displayed. */
    pasted: string;
    label: string;
}
/** Paste a `claude setup-token` (sk-ant-oat…) directly instead of the flow. */
export interface AIAnthropicPasteTokenRequest {
    type: string;
    token: string;
    label: string;
}
export interface AIChatgptLoginStartRequest {
    type: string;
}
/** Reply: show this code, send the user to verifyUrl, then poll. */
export interface AIChatgptLoginStart {
    userCode: string;
    verifyUrl: string;
}
/** Poll once; the worker holds the device session. */
export interface AIChatgptLoginPollRequest {
    type: string;
    label: string;
}
export type AIChatgptPoll = {
    status: 'pending';
} | {
    status: 'created';
    id: string;
};
export interface AIResult<T> {
    ok: boolean;
    data?: T;
    error?: string;
}
export type ModelInfo = {
    id: string;
    name: string;
};
