import type { AIAnthropicLoginStart, AIChatgptLoginStart, AIChatgptPoll, AIChatRequest, AIChatResult, AIConfigView, AIOllamaLoginStart, AIOllamaPoll, AIResult, ModelInfo, ProviderKind, AISaveConnectionRequest } from './types.js';
/**
 * Typed client for UI surfaces (content scripts, options/settings pages,
 * side panels). Every call is one chrome.runtime.sendMessage to the
 * background handlers registered with the SAME prefix.
 */
export interface AiClient {
    /** Redacted config: connections without secrets. */
    get(): Promise<AIConfigView>;
    setActive(id: string | null): Promise<AIResult<null>>;
    saveConnection(input: Omit<AISaveConnectionRequest, 'type'>): Promise<AIResult<{
        id: string;
    }>>;
    deleteConnection(id: string): Promise<AIResult<null>>;
    listModels(input: {
        kind: ProviderKind;
        baseUrl: string;
        apiKey: string;
        id?: string;
    }): Promise<AIResult<ModelInfo[]>>;
    /** One text completion through the active connection. */
    complete(input: {
        system: string;
        prompt: string;
        maxTokens?: number;
    }): Promise<AIResult<string>>;
    /** One model turn with tools. Inside the worker, call `chat()` from `/background` directly instead. */
    chat(input: AIChatRequest): Promise<AIChatResult>;
    anthropicLoginStart(): Promise<AIResult<AIAnthropicLoginStart>>;
    anthropicLoginComplete(input: {
        pasted: string;
        label: string;
    }): Promise<AIResult<{
        id: string;
    }>>;
    anthropicPasteToken(input: {
        token: string;
        label: string;
    }): Promise<AIResult<{
        id: string;
    }>>;
    chatgptLoginStart(): Promise<AIResult<AIChatgptLoginStart>>;
    chatgptLoginPoll(label: string): Promise<AIResult<AIChatgptPoll>>;
    /** Ollama Cloud: open ollama.com/connect for a new device key. */
    ollamaLoginStart(deviceName?: string): Promise<AIResult<AIOllamaLoginStart>>;
    ollamaLoginPoll(label: string): Promise<AIResult<AIOllamaPoll>>;
}
export declare function createAiClient(options?: {
    prefix?: string;
}): AiClient;
