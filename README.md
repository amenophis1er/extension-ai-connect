# extension-ai-connect

BYO-key AI provider connections for Chrome extensions (MV3). Extracted from
[wassup](https://github.com/amenophis1er/wassup); one package, three provider
families, one message-passing API:

- **Anthropic** — API key, Claude Pro/Max subscription OAuth (PKCE +
  paste-code, no redirect registration), or a pasted `claude setup-token`.
- **OpenAI-compatible** — OpenAI, OpenRouter, Ollama (local or cloud), any
  `/v1/chat/completions` server.
- **ChatGPT subscription** — the Codex device flow + Responses-API backend.
- **Chrome built-in** (`gemini-nano`) is modeled as a connection kind, but
  inference runs in a page context; the host extension wires that side.

## Security model

- All secrets live in the **background worker only**. Keys are encrypted at
  rest with a per-install **non-extractable** AES-GCM key (IndexedDB); a
  `chrome.storage.local` dump yields ciphertext.
- UI surfaces get a **redacted view** (`hasKey`, `····a1b2`) — a key that has
  been saved is never sent back out of the worker.
- Provider HTTP happens in the worker: no CORS games in page frames, keys
  never touch host-page contexts.
- OAuth refresh tokens are single-use: the rotated pair is persisted before
  the response is used.

## Install

```
npm install github:amenophis1er/extension-ai-connect
```

(Ships TypeScript compiled on install via `prepare`; no registry needed.)

## Wire the background worker

```ts
// service-worker.ts
import { registerAiHandlers } from '@amenophis1er/extension-ai-connect/background';

registerAiHandlers({
  prefix: 'myext',                       // messages become `myext:ai-*`
  settingsHint: 'Open MyExt settings → AI.',
});
```

Composing with an existing `onMessage` listener instead:

```ts
import { createAiMessageHandler } from '@amenophis1er/extension-ai-connect/background';
const handleAi = createAiMessageHandler({ prefix: 'myext' });
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // ...your own messages...
  return handleAi(msg, sendResponse); // true = handled, keeps channel open
});
```

## Call it from any UI surface

```ts
import { createAiClient } from '@amenophis1er/extension-ai-connect/client';

const ai = createAiClient({ prefix: 'myext' });

const view = await ai.get();                       // redacted connections
await ai.saveConnection({ kind: 'openai-compatible', label: '', baseUrl: 'https://api.openai.com',
                          model: 'gpt-5.5', apiKeyMode: 'set', apiKey: 'sk-…', makeActive: true });
const res = await ai.complete({ system: 'Be terse.', prompt: 'Hello' });
if (res.ok) console.log(res.data);
```

Subscription sign-ins are UI-driven state machines (the worker can be killed
between steps; pending state lives in `chrome.storage.session`):

```ts
// Claude Pro/Max: start → user approves in the opened tab → paste `code#state`
await ai.anthropicLoginStart();
await ai.anthropicLoginComplete({ pasted, label: 'Claude (Pro/Max)' });

// ChatGPT: start → show userCode → poll until 'created'
const start = await ai.chatgptLoginStart();
// poll every few seconds (chatgptPollDelay in /background gives the delay)
const poll = await ai.chatgptLoginPoll('ChatGPT');
```

## What the host extension must declare

**Permissions** — `storage`, `declarativeNetRequest` (subscription auth
only), and `tabs.create` works without a permission.

**Host permissions** for the providers you enable:

```jsonc
"host_permissions": [
  "https://api.anthropic.com/*",
  "https://api.openai.com/*",
  "https://ollama.com/*",
  "https://openrouter.ai/*",
  "https://claude.com/*",          // Claude subscription consent
  "https://platform.claude.com/*", // Claude subscription token endpoint
  "https://auth.openai.com/*",     // ChatGPT device flow
  "https://chatgpt.com/*"          // Codex inference backend
],
"optional_host_permissions": ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]
```

Custom base URLs (self-hosted, LM Studio, local Ollama) need an on-demand
grant — `originPattern(baseUrl)` from `/types` gives you the match pattern
for `chrome.permissions.request`.

**DNR rules** (subscription auth only): merge `manifest/dnr-rules.json` into
your ruleset. Anthropic subscription orgs reject CORS-classified requests
and the Codex backend rejects browser-shaped ones, so these strip
`Origin`/`Sec-Fetch-*` (and set the expected `user-agent`) on those hosts.
Rule ids are 9001–9003; renumber on collision.

## Provider fine print (already handled, documented so you don't undo it)

- Anthropic **API keys** need `anthropic-dangerous-direct-browser-access`;
  **subscription tokens** are rejected if it's present, must use
  `Authorization: Bearer`, and are gated on Claude-Code-shaped traffic — the
  system prompt is automatically prefixed with the Claude Code sentinel.
- The ChatGPT flow polls by `device_auth_id` (not RFC-8628 `device_code`),
  and users must first enable *“device code authorization for Codex”* in
  ChatGPT security settings. Codex only streams; the SSE is aggregated for
  you. Tokens do **not** work against `api.openai.com`.
- `<think>…</think>` / `<reasoning>…</reasoning>` blocks are stripped from
  completions (local models emit them despite instructions).
- Debug logging: `chrome.storage.local.set({ <debugFlagKey>: true })` in the
  SW console logs full request/response bodies (never keys).

## Migrating an extension that already stored connections

Pass your legacy names so nothing is lost:

```ts
registerAiHandlers({
  prefix: 'wassup',              // keep existing message names
  storageKey: 'ai',              // keep stored connections
  cryptoDbName: 'wassup-crypto', // keep decrypting existing ciphertext
  debugFlagKey: 'wassupDebug',
});
```

v1/v2 config shapes (flat plaintext key / per-kind creds) are migrated and
encrypted automatically on first load.

## Storage/session keys used

- `chrome.storage.local`: `<storageKey>` (config), `<debugFlagKey>` (flag)
- `chrome.storage.session`: `aiConnectAnthropicLogin`, `aiConnectChatgptDevice`
  (pending sign-ins; safe to lose — the user just restarts the flow)
- IndexedDB `<cryptoDbName>`: the non-extractable AES key
