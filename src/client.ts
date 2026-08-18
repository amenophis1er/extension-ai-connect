import type {
  AIAnthropicLoginStart,
  AIChatgptLoginStart,
  AIChatgptPoll,
  AIConfigView,
  AIResult,
  ModelInfo,
  ProviderKind,
  AISaveConnectionRequest,
} from './types.js';

/**
 * Typed client for UI surfaces (content scripts, options/settings pages,
 * side panels). Every call is one chrome.runtime.sendMessage to the
 * background handlers registered with the SAME prefix.
 */

export interface AiClient {
  /** Redacted config: connections without secrets. */
  get(): Promise<AIConfigView>;
  setActive(id: string | null): Promise<AIResult<null>>;
  saveConnection(
    input: Omit<AISaveConnectionRequest, 'type'>,
  ): Promise<AIResult<{ id: string }>>;
  deleteConnection(id: string): Promise<AIResult<null>>;
  listModels(input: {
    kind: ProviderKind;
    baseUrl: string;
    apiKey: string;
    id?: string;
  }): Promise<AIResult<ModelInfo[]>>;
  /** One text completion through the active connection. */
  complete(input: { system: string; prompt: string; maxTokens?: number }): Promise<AIResult<string>>;
  anthropicLoginStart(): Promise<AIResult<AIAnthropicLoginStart>>;
  anthropicLoginComplete(input: { pasted: string; label: string }): Promise<AIResult<{ id: string }>>;
  anthropicPasteToken(input: { token: string; label: string }): Promise<AIResult<{ id: string }>>;
  chatgptLoginStart(): Promise<AIResult<AIChatgptLoginStart>>;
  chatgptLoginPoll(label: string): Promise<AIResult<AIChatgptPoll>>;
}

export function createAiClient(options: { prefix?: string } = {}): AiClient {
  const p = options.prefix ?? 'aiconnect';
  const send = <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> =>
    chrome.runtime.sendMessage({ type: `${p}:${type}`, ...payload }) as Promise<T>;

  return {
    get: () => send('ai-get'),
    setActive: (id) => send('ai-set-active', { id }),
    saveConnection: (input) => send('ai-save-connection', { ...input }),
    deleteConnection: (id) => send('ai-delete-connection', { id }),
    listModels: (input) => send('ai-list-models', { ...input }),
    complete: (input) => send('ai-complete', { ...input }),
    anthropicLoginStart: () => send('ai-anthropic-login-start'),
    anthropicLoginComplete: (input) => send('ai-anthropic-login-complete', { ...input }),
    anthropicPasteToken: (input) => send('ai-anthropic-paste-token', { ...input }),
    chatgptLoginStart: () => send('ai-chatgpt-login-start'),
    chatgptLoginPoll: (label) => send('ai-chatgpt-login-poll', { label }),
  };
}
