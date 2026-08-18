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
/** Preset base URLs offered in the UI for openai-compatible connections. */
export const OPENAI_COMPATIBLE_PRESETS = [
    { label: 'OpenAI', baseUrl: 'https://api.openai.com' },
    { label: 'Ollama (cloud)', baseUrl: 'https://ollama.com' },
    { label: 'Ollama (local)', baseUrl: 'http://localhost:11434', keyOptional: true },
    { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api' },
];
/** Normalize a user-typed base URL: add scheme, drop trailing slash and /v1. */
export function normalizeBaseUrl(url) {
    let base = url.trim();
    if (!base)
        return 'https://api.openai.com';
    if (!/^https?:\/\//i.test(base))
        base = `https://${base}`;
    return base.replace(/\/+$/, '').replace(/\/v1$/, '');
}
/** Host-permission match pattern for a base URL's origin (port-agnostic). */
export function originPattern(baseUrl) {
    try {
        const u = new URL(normalizeBaseUrl(baseUrl));
        return `${u.protocol}//${u.hostname}/*`;
    }
    catch {
        return null;
    }
}
/** A sensible default label for a connection. */
export function defaultLabel(kind, baseUrl) {
    if (kind === 'anthropic')
        return 'Anthropic';
    if (kind === 'chatgpt')
        return 'ChatGPT';
    if (kind === 'chrome-builtin')
        return 'Chrome built-in (on-device)';
    const preset = OPENAI_COMPATIBLE_PRESETS.find((p) => p.baseUrl === normalizeBaseUrl(baseUrl));
    if (preset)
        return preset.label;
    try {
        return new URL(normalizeBaseUrl(baseUrl)).hostname;
    }
    catch {
        return 'OpenAI-compatible';
    }
}
