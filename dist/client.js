export function createAiClient(options = {}) {
    const p = options.prefix ?? 'aiconnect';
    const send = (type, payload = {}) => chrome.runtime.sendMessage({ type: `${p}:${type}`, ...payload });
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
        ollamaLoginStart: (deviceName) => send('ai-ollama-login-start', { deviceName }),
        ollamaLoginPoll: (label) => send('ai-ollama-login-poll', { label }),
    };
}
