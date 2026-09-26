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
 *  = a Claude Pro/Max subscription token (Bearer, refreshable / long-lived);
 *  'device-key' = an Ollama Cloud connected device (requests signed with a
 *  non-extractable Ed25519 key, no secret stored). */
export type AuthMode = 'key' | 'oauth' | 'setup-token' | 'device-key';

/** A saved connection, minus the secret (what the settings UI sees). */
export interface ConnectionView {
  id: string;
  kind: ProviderKind;
  auth: AuthMode;
  label: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** e.g. "····a1b2" — last chars only, for recognition. For a
   *  'device-key' connection, the Ollama account name. */
  keyHint: string;
  /** Bumped by every settings save (not by token refresh). A run pins it: see AIChatRequest.connectionRevision. */
  revision: number;
}

export interface AIConfigView {
  activeId: string | null;
  connections: ConnectionView[];
}

/** Preset base URLs offered in the UI for openai-compatible connections. */
export const OPENAI_COMPATIBLE_PRESETS: {
  label: string;
  baseUrl: string;
  /** Local/self-hosted endpoints usually need no key. */
  keyOptional?: boolean;
}[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com' },
  { label: 'Ollama (cloud)', baseUrl: 'https://ollama.com' },
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434', keyOptional: true },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api' },
];

/** Normalize a user-typed base URL: add scheme, drop trailing slash and /v1. */
export function normalizeBaseUrl(url: string): string {
  let base = url.trim();
  if (!base) return 'https://api.openai.com';
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Host-permission match pattern for a base URL's origin (port-agnostic). */
export function originPattern(baseUrl: string): string | null {
  try {
    const u = new URL(normalizeBaseUrl(baseUrl));
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/** A sensible default label for a connection. */
export function defaultLabel(kind: ProviderKind, baseUrl: string): string {
  if (kind === 'anthropic') return 'Anthropic';
  if (kind === 'chatgpt') return 'ChatGPT';
  if (kind === 'chrome-builtin') return 'Chrome built-in (on-device)';
  const preset = OPENAI_COMPATIBLE_PRESETS.find((p) => p.baseUrl === normalizeBaseUrl(baseUrl));
  if (preset) return preset.label;
  try {
    return new URL(normalizeBaseUrl(baseUrl)).hostname;
  } catch {
    return 'OpenAI-compatible';
  }
}

/* ── message protocol (UI → background worker) ─────────────────────── */

export interface AIGetRequest {
  type: string; // `${prefix}:ai-get`
}
export interface AISetActiveRequest {
  type: string; // `${prefix}:ai-set-active`
  id: string | null;
}
export interface AISaveConnectionRequest {
  type: string; // `${prefix}:ai-save-connection`
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
  type: string; // `${prefix}:ai-delete-connection`
  id: string;
}
export interface AIListModelsRequest {
  type: string; // `${prefix}:ai-list-models`
  kind: ProviderKind;
  baseUrl: string;
  /** Freshly typed key; empty means "use the saved key for `id`". */
  apiKey: string;
  /** Existing connection whose stored key to fall back on. */
  id?: string;
}
export interface AICompleteRequest {
  type: string; // `${prefix}:ai-complete`
  system: string;
  prompt: string;
  maxTokens?: number;
}

/* ── Claude subscription (Pro/Max) sign-in ────────────────────────── */

export interface AIAnthropicLoginStartRequest {
  type: string; // `${prefix}:ai-anthropic-login-start`
}
/** Reply from login-start: the worker opened the consent tab; the UI shows
 *  the authorize URL as a fallback link and waits for the pasted code. */
export interface AIAnthropicLoginStart {
  authorizeUrl: string;
}
export interface AIAnthropicLoginCompleteRequest {
  type: string; // `${prefix}:ai-anthropic-login-complete`
  /** The `code#state` string the consent page displayed. */
  pasted: string;
  label: string;
}
/** Paste a `claude setup-token` (sk-ant-oat…) directly instead of the flow. */
export interface AIAnthropicPasteTokenRequest {
  type: string; // `${prefix}:ai-anthropic-paste-token`
  token: string;
  label: string;
}

/* ── ChatGPT subscription (device flow) ───────────────────────────── */

export interface AIChatgptLoginStartRequest {
  type: string; // `${prefix}:ai-chatgpt-login-start`
}
/** Reply: show this code, send the user to verifyUrl, then poll. */
export interface AIChatgptLoginStart {
  userCode: string;
  verifyUrl: string;
}
/** Poll once; the worker holds the device session. */
export interface AIChatgptLoginPollRequest {
  type: string; // `${prefix}:ai-chatgpt-login-poll`
  label: string;
}
export type AIChatgptPoll =
  | { status: 'pending' }
  | { status: 'created'; id: string };

/* ── Ollama Cloud (connect device) ────────────────────────────────── */

export interface AIOllamaLoginStartRequest {
  type: string; // `${prefix}:ai-ollama-login-start`
  /** Shown on the ollama.com connect page ("Connect <name> with <account>"). */
  deviceName?: string;
}
/** Reply: the worker opened the connect page; the UI shows the URL as a
 *  fallback link and polls until the user clicks Connect. */
export interface AIOllamaLoginStart {
  connectUrl: string;
  /** Suggested delay between polls, ms. */
  pollMs: number;
}
export interface AIOllamaLoginPollRequest {
  type: string; // `${prefix}:ai-ollama-login-poll`
  label: string;
}
export type AIOllamaPoll =
  | { status: 'pending' }
  | { status: 'created'; id: string };

/* ── Chat with tools (v0.2.0) ─────────────────────────────────────── */

/** Message content: text now, images for vision-capable providers. */
export type AIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; data: string /* base64 */ };

/** A tool the model may call; `inputSchema` is JSON Schema. */
export interface AIToolSpec {
  name: string;
  description: string;
  inputSchema: object;
}

/** One tool call the model made. Arguments that were not valid JSON arrive as `argsError`. */
export interface AIToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  argsError?: { raw: string; message: string };
}

export type AIMessage =
  | { role: 'user'; content: string | AIContentPart[] }
  | {
      role: 'assistant';
      content?: string;
      toolCalls?: AIToolCall[];
      /**
       * Opaque provider data that must be sent back verbatim with this turn —
       * e.g. Anthropic thinking blocks (with signatures) and tool_use blocks.
       * Persist it with the message; never edit it.
       */
      providerState?: unknown;
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string | AIContentPart[]; isError?: boolean };

export interface AIChatRequest {
  system: string;
  messages: AIMessage[];
  tools?: AIToolSpec[];
  /** Default 16000. */
  maxTokens?: number;
  /** Default false: at most one tool call per response where the provider supports it. */
  parallelToolCalls?: boolean;
  /** The connection to use; default the active one. A run should pin it. */
  connectionId?: string;
  /** The connection's `revision` when the run started; a different one fails the call (the owner edited it). */
  connectionRevision?: number;
  /** The model to use; default the connection's. */
  model?: string;
  /** Whole-request timeout, default 120000 ms. */
  timeoutMs?: number;
}

export type AIStopReason = 'end' | 'tool_use' | 'length' | 'refusal';

export interface AIChatResult {
  ok: boolean;
  text?: string;
  toolCalls?: AIToolCall[];
  providerState?: unknown;
  stopReason?: AIStopReason;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  error?: string;
}

/** `${prefix}:ai-chat` — the same request as `chat()`, for hosts whose caller is a page. */
export interface AIChatMessageRequest extends AIChatRequest {
  type: string;
}

export interface AIResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type ModelInfo = { id: string; name: string };
