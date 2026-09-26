import { normalizeBaseUrl, defaultLabel, } from '../types.js';
import { configureCryptoDb, createSigningKey, decryptBlob, deleteSigningKey, encryptString, getSigningKey, } from './crypto.js';
import { CONNECT_POLL_MS, CONNECT_TIMEOUT_MS, OLLAMA_BASE, connectUrl, disconnect as ollamaDisconnect, publicKeyLine, signRequest, whoami, } from './ollama-device.js';
import { exchangeCode, isSetupToken, refreshTokens, startLogin, withClaudeCodeSystem, } from './anthropic-oauth.js';
import { CODEX_MODELS, codexComplete, exchangeDeviceCode, nextPollDelayMs, pollDevice, refreshOpenAiTokens, startDeviceLogin, } from './openai-oauth.js';
let opts = resolve({});
function resolve(o) {
    return {
        prefix: o.prefix ?? 'aiconnect',
        storageKey: o.storageKey ?? 'aiConnections',
        cryptoDbName: o.cryptoDbName ?? 'ai-connect-crypto',
        debugFlagKey: o.debugFlagKey ?? 'aiConnectDebug',
        settingsHint: o.settingsHint ?? 'Add one in the extension settings.',
        openConsentTab: o.openConsentTab ?? true,
    };
}
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** Abort a completion that runs too long (a hung endpoint / stuck model). */
const COMPLETE_TIMEOUT_MS = 60_000;
/**
 * Debug tracing. Flip on by running in the SW console:
 *   chrome.storage.local.set({ <debugFlagKey>: true })
 * Then every completion logs the full request (URL, body — keys are in
 * headers, never the body) and the raw response to the service-worker
 * console. Off by default so message content isn't logged in normal use.
 */
async function debugOn() {
    return (await chrome.storage.local.get(opts.debugFlagKey))[opts.debugFlagKey] === true;
}
function dlog(label, data) {
    console.log(`%c[ai-connect] ${label}`, 'color:#00a884;font-weight:bold', data);
}
/** Strip reasoning/thinking the model may emit despite instructions. */
function stripThinking(text) {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
        .trim();
}
function empty() {
    return { activeId: null, connections: [] };
}
/**
 * Load config, migrating older shapes into the connections list:
 *  - v3: { activeId, connections: [...] }              (current)
 *  - v2: { provider, creds: { <kind>: {baseUrl, model, apiKeyEnc|apiKey} } }
 *  - v1: { provider, apiKey, baseUrl, model }          (flat plaintext)
 * Any plaintext key found is encrypted on the way in.
 */
async function load() {
    const raw = (await chrome.storage.local.get(opts.storageKey))[opts.storageKey];
    if (!raw)
        return empty();
    // v3 — already migrated.
    if (Array.isArray(raw.connections)) {
        return {
            activeId: raw.activeId ?? null,
            connections: raw.connections,
        };
    }
    const cfg = empty();
    const add = async (kind, c, active) => {
        const hasContent = c.apiKey || c.apiKeyEnc || c.model;
        if (!hasContent)
            return;
        const apiKeyEnc = typeof c.apiKey === 'string' && c.apiKey
            ? await encryptString(c.apiKey) // v1/v2 plaintext
            : (c.apiKeyEnc ?? null);
        const baseUrl = c.baseUrl ?? '';
        const conn = {
            id: crypto.randomUUID(),
            kind,
            label: defaultLabel(kind, baseUrl),
            baseUrl,
            model: c.model ?? '',
            apiKeyEnc,
        };
        cfg.connections.push(conn);
        if (active)
            cfg.activeId = conn.id;
    };
    const activeKind = raw.provider;
    if (raw.creds && typeof raw.creds === 'object') {
        const src = raw.creds;
        for (const kind of ['anthropic', 'openai-compatible']) {
            const entry = src[kind];
            if (entry)
                await add(kind, entry, activeKind === kind);
        }
    }
    else if (typeof raw.apiKey === 'string') {
        if (activeKind === 'anthropic' || activeKind === 'openai-compatible') {
            await add(activeKind, raw, true);
        }
    }
    await save(cfg);
    return cfg;
}
async function save(cfg) {
    await chrome.storage.local.set({ [opts.storageKey]: cfg });
}
async function toView(c) {
    if (c.auth === 'device-key') {
        return {
            id: c.id,
            kind: c.kind,
            auth: c.auth,
            label: c.label,
            baseUrl: c.baseUrl,
            model: c.model,
            hasKey: true,
            keyHint: c.account ?? '',
        };
    }
    const key = await decryptBlob(c.apiKeyEnc);
    return {
        id: c.id,
        kind: c.kind,
        auth: c.auth ?? 'key',
        label: c.label,
        baseUrl: c.baseUrl,
        model: c.model,
        hasKey: key.length > 0,
        keyHint: key ? `····${key.slice(-4)}` : '',
    };
}
async function getView() {
    const cfg = await load();
    return {
        activeId: cfg.activeId,
        connections: await Promise.all(cfg.connections.map(toView)),
    };
}
async function setActive(req) {
    const cfg = await load();
    cfg.activeId = req.id && cfg.connections.some((c) => c.id === req.id) ? req.id : null;
    await save(cfg);
    return { ok: true };
}
async function saveConnection(req) {
    const cfg = await load();
    let conn = req.id ? cfg.connections.find((c) => c.id === req.id) : undefined;
    if (!conn) {
        conn = {
            id: crypto.randomUUID(),
            kind: req.kind,
            label: '',
            baseUrl: '',
            model: '',
            apiKeyEnc: null,
        };
        cfg.connections.push(conn);
    }
    conn.kind = req.kind;
    conn.label = req.label || defaultLabel(req.kind, req.baseUrl);
    conn.baseUrl = req.kind === 'openai-compatible' ? req.baseUrl : '';
    // Chrome's on-device model has no model list or key.
    conn.model = req.kind === 'chrome-builtin' ? 'gemini-nano' : req.model;
    if (req.apiKeyMode === 'set')
        conn.apiKeyEnc = await encryptString(req.apiKey ?? '');
    else if (req.apiKeyMode === 'clear')
        conn.apiKeyEnc = null;
    if (req.makeActive)
        cfg.activeId = conn.id;
    await save(cfg);
    return { ok: true, data: { id: conn.id } };
}
/* ── Claude subscription sign-in ──────────────────────────────────── */
const PENDING_KEY = 'aiConnectAnthropicLogin';
/** Begin the Claude sign-in: mint PKCE, open the consent tab, stash the
 *  verifier/state in session storage (survives an SW restart while the user
 *  approves), and return the URL as a fallback link. */
async function anthropicLoginStart() {
    try {
        const { verifier, state, authorizeUrl } = await startLogin();
        await chrome.storage.session.set({ [PENDING_KEY]: { verifier, state } });
        if (opts.openConsentTab)
            void chrome.tabs.create({ url: authorizeUrl }).catch(() => { });
        return { ok: true, data: { authorizeUrl } };
    }
    catch (error) {
        return { ok: false, error: errMessage(error) };
    }
}
/** Finish the sign-in: exchange the pasted code, store tokens as a new
 *  connection, make it active. */
async function anthropicLoginComplete(req) {
    try {
        const pending = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
        if (!pending)
            throw new Error('Sign-in expired — start again.');
        const tokens = await exchangeCode({
            pasted: req.pasted,
            expectedState: pending.state,
            verifier: pending.verifier,
        });
        await chrome.storage.session.remove(PENDING_KEY);
        const id = await createSubscriptionConnection({
            auth: 'oauth',
            label: req.label || 'Claude (Pro/Max)',
            token: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
        });
        return { ok: true, data: { id } };
    }
    catch (error) {
        return { ok: false, error: errMessage(error) };
    }
}
/** Add a Claude subscription connection from a pasted setup-token (no refresh). */
async function anthropicPasteToken(req) {
    try {
        const token = req.token.trim();
        if (!isSetupToken(token))
            throw new Error('That is not a setup-token (should start with sk-ant-oat).');
        const id = await createSubscriptionConnection({
            auth: 'setup-token',
            label: req.label || 'Claude (setup-token)',
            token,
        });
        return { ok: true, data: { id } };
    }
    catch (error) {
        return { ok: false, error: errMessage(error) };
    }
}
async function createSubscriptionConnection(input) {
    const cfg = await load();
    const conn = {
        id: crypto.randomUUID(),
        kind: 'anthropic',
        auth: input.auth,
        label: input.label,
        baseUrl: '',
        model: '',
        apiKeyEnc: await encryptString(input.token),
        refreshTokenEnc: input.refreshToken ? await encryptString(input.refreshToken) : null,
        expiresAt: input.expiresAt,
    };
    cfg.connections.push(conn);
    cfg.activeId = conn.id;
    await save(cfg);
    return conn.id;
}
/* ── ChatGPT subscription (device flow) ───────────────────────────── */
const CHATGPT_PENDING = 'aiConnectChatgptDevice';
/** Start the device flow: get a user code, stash the session, tell the UI
 *  what to show. The user approves at the verify URL; the UI then polls. */
async function chatgptLoginStart() {
    try {
        const start = await startDeviceLogin();
        await chrome.storage.session.set({ [CHATGPT_PENDING]: { ...start, slowDowns: 0 } });
        if (opts.openConsentTab)
            void chrome.tabs.create({ url: start.verifyUrl }).catch(() => { });
        return { ok: true, data: { userCode: start.userCode, verifyUrl: start.verifyUrl } };
    }
    catch (error) {
        return { ok: false, error: errMessage(error) };
    }
}
/** One poll step, driven by the UI so the worker can be killed between
 *  polls (MV3) without losing the session — it lives in session storage. */
async function chatgptLoginPoll(label) {
    try {
        const pending = (await chrome.storage.session.get(CHATGPT_PENDING))[CHATGPT_PENDING];
        if (!pending)
            throw new Error('Sign-in expired — start again.');
        if (Date.now() > pending.expiresAt) {
            await chrome.storage.session.remove(CHATGPT_PENDING);
            throw new Error('Sign-in timed out after 15 minutes — start again.');
        }
        const poll = await pollDevice(pending.deviceAuthId, pending.userCode);
        if (poll.status === 'pending')
            return { ok: true, data: { status: 'pending' } };
        if (poll.status === 'slow_down') {
            await chrome.storage.session.set({
                [CHATGPT_PENDING]: { ...pending, slowDowns: pending.slowDowns + 1 },
            });
            return { ok: true, data: { status: 'pending' } };
        }
        if (poll.status === 'denied') {
            await chrome.storage.session.remove(CHATGPT_PENDING);
            throw new Error(poll.error);
        }
        const tokens = await exchangeDeviceCode({
            authorizationCode: poll.authorizationCode,
            codeVerifier: poll.codeVerifier,
        });
        await chrome.storage.session.remove(CHATGPT_PENDING);
        const cfg = await load();
        const conn = {
            id: crypto.randomUUID(),
            kind: 'chatgpt',
            auth: 'oauth',
            label: label || 'ChatGPT (subscription)',
            baseUrl: '',
            model: CODEX_MODELS[0] ?? '',
            apiKeyEnc: await encryptString(tokens.accessToken),
            refreshTokenEnc: tokens.refreshToken ? await encryptString(tokens.refreshToken) : null,
            expiresAt: tokens.expiresAt,
            accountId: tokens.accountId,
        };
        cfg.connections.push(conn);
        cfg.activeId = conn.id;
        await save(cfg);
        return { ok: true, data: { status: 'created', id: conn.id } };
    }
    catch (error) {
        return { ok: false, error: errMessage(error) };
    }
}
/** How long the UI should wait before the next poll. */
export function chatgptPollDelay(intervalSec, slowDowns) {
    return nextPollDelayMs(intervalSec, slowDowns);
}
/* ── Ollama Cloud (connect device) ────────────────────────────────── */
const OLLAMA_PENDING = 'aiConnectOllamaConnect';
/** Start pairing: mint a device key under a fresh connection id, open
 *  ollama.com/connect for it, and remember the attempt in session storage
 *  (survives an SW restart while the user clicks Connect). */
async function ollamaLoginStart(deviceName) {
    try {
        const previous = (await chrome.storage.session.get(OLLAMA_PENDING))[OLLAMA_PENDING];
        if (previous)
            await deleteSigningKey(previous.id);
        const id = crypto.randomUUID();
        const pair = await createSigningKey(id);
        const url = connectUrl(deviceName.trim() || 'Chrome extension', await publicKeyLine(pair));
        await chrome.storage.session.set({
            [OLLAMA_PENDING]: { id, expiresAt: Date.now() + CONNECT_TIMEOUT_MS },
        });
        if (opts.openConsentTab)
            void chrome.tabs.create({ url }).catch(() => { });
        return { ok: true, data: { connectUrl: url, pollMs: CONNECT_POLL_MS } };
    }
    catch (error) {
        return { ok: false, error: errMessage(error) };
    }
}
/** One poll, driven by the UI: is the pending key paired yet? */
async function ollamaLoginPoll(label) {
    try {
        const pending = (await chrome.storage.session.get(OLLAMA_PENDING))[OLLAMA_PENDING];
        if (!pending)
            throw new Error('Sign-in expired — start again.');
        const pair = await getSigningKey(pending.id);
        if (!pair || Date.now() > pending.expiresAt) {
            await chrome.storage.session.remove(OLLAMA_PENDING);
            await deleteSigningKey(pending.id);
            throw new Error('Sign-in timed out after 15 minutes — start again.');
        }
        const account = await whoami(pair);
        if (!account)
            return { ok: true, data: { status: 'pending' } };
        await chrome.storage.session.remove(OLLAMA_PENDING);
        const cfg = await load();
        cfg.connections.push({
            id: pending.id,
            kind: 'openai-compatible',
            auth: 'device-key',
            label: label || (account.name ? `Ollama Cloud (${account.name})` : 'Ollama Cloud'),
            baseUrl: OLLAMA_BASE,
            model: '',
            apiKeyEnc: null,
            account: account.name,
        });
        cfg.activeId = pending.id;
        await save(cfg);
        return { ok: true, data: { status: 'created', id: pending.id } };
    }
    catch (error) {
        return { ok: false, error: errMessage(error) };
    }
}
/** Refresh an OAuth connection's token if it's near expiry, persisting the
 *  rotated pair. Returns the usable access token. */
async function freshToken(cfg, conn) {
    const access = await decryptBlob(conn.apiKeyEnc);
    if (conn.auth !== 'oauth')
        return access; // setup-token / key: no refresh
    const skewMs = 5 * 60_000;
    if (conn.expiresAt && Date.now() < conn.expiresAt - skewMs)
        return access;
    const refresh = await decryptBlob(conn.refreshTokenEnc);
    if (!refresh)
        return access; // can't refresh; try the current token
    const tokens = conn.kind === 'chatgpt' ? await refreshOpenAiTokens(refresh) : await refreshTokens(refresh);
    conn.apiKeyEnc = await encryptString(tokens.accessToken);
    conn.refreshTokenEnc = await encryptString(tokens.refreshToken);
    conn.expiresAt = tokens.expiresAt;
    const accountId = tokens.accountId;
    if (accountId)
        conn.accountId = accountId;
    await save(cfg); // persist rotated single-use token immediately
    return tokens.accessToken;
}
async function deleteConnection(req) {
    const cfg = await load();
    const gone = cfg.connections.find((c) => c.id === req.id);
    if (gone?.auth === 'device-key') {
        // Un-pair on ollama.com, then drop the key; a failed un-pair still drops it.
        const pair = await getSigningKey(gone.id);
        if (pair)
            await ollamaDisconnect(pair).catch(() => { });
        await deleteSigningKey(gone.id);
    }
    cfg.connections = cfg.connections.filter((c) => c.id !== req.id);
    if (cfg.activeId === req.id)
        cfg.activeId = null;
    await save(cfg);
    return { ok: true };
}
async function listModels(req) {
    try {
        const cfg = await load();
        const stored = req.id ? cfg.connections.find((c) => c.id === req.id) : undefined;
        // Subscription connections carry no baseUrl but authenticate via Bearer.
        const subscription = stored ? stored.auth === 'oauth' || stored.auth === 'setup-token' : false;
        if (req.kind === 'chrome-builtin') {
            return { ok: true, data: [{ id: 'gemini-nano', name: 'Chrome on-device model' }] };
        }
        // The Codex backend has no model-enumeration endpoint — use the list.
        if (req.kind === 'chatgpt') {
            return { ok: true, data: CODEX_MODELS.map((id) => ({ id, name: id })) };
        }
        const apiKey = req.apiKey || (stored ? await freshToken(cfg, stored) : '');
        if (req.kind === 'anthropic' && !apiKey)
            throw new Error('Enter an API key first.');
        const models = req.kind === 'anthropic'
            ? await anthropicModels(apiKey, subscription)
            : await openaiModels(stored && !req.apiKey ? await authorizerFor(stored, apiKey) : bearerAuth(apiKey), normalizeBaseUrl(req.baseUrl));
        return { ok: true, data: models };
    }
    catch (error) {
        return { ok: false, error: errMessage(error) };
    }
}
async function complete(req) {
    try {
        const cfg = await load();
        const conn = cfg.connections.find((c) => c.id === cfg.activeId);
        if (!conn)
            throw new Error(`No AI connection selected. ${opts.settingsHint}`);
        const subscription = conn.auth === 'oauth' || conn.auth === 'setup-token';
        const apiKey = await freshToken(cfg, conn);
        if (conn.kind === 'chrome-builtin') {
            // Runs in a page context (needs the page + user gesture); the worker
            // should never be asked to do it.
            throw new Error('The on-device model runs in the page, not the worker.');
        }
        if (!conn.model || (conn.kind === 'anthropic' && !apiKey)) {
            throw new Error(`The active AI connection is incomplete. ${opts.settingsHint}`);
        }
        const debug = await debugOn();
        if (debug) {
            dlog('request', {
                connection: conn.label,
                kind: conn.kind,
                model: conn.model,
                baseUrl: conn.baseUrl || ANTHROPIC_BASE,
                system: req.system,
                prompt: req.prompt,
                maxTokens: req.maxTokens ?? 1024,
            });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), COMPLETE_TIMEOUT_MS);
        try {
            const raw = conn.kind === 'anthropic'
                ? await anthropicComplete(apiKey, conn.model, req, controller.signal, debug, subscription)
                : conn.kind === 'chatgpt'
                    ? await codexComplete({
                        accessToken: apiKey,
                        accountId: conn.accountId,
                        model: conn.model,
                        system: req.system,
                        prompt: req.prompt,
                    }, controller.signal)
                    : await openaiComplete(await authorizerFor(conn, apiKey), normalizeBaseUrl(conn.baseUrl), conn.model, req, controller.signal, debug);
            const text = stripThinking(raw);
            if (debug)
                dlog('result', { raw, afterStripThinking: text });
            return { ok: true, data: text };
        }
        finally {
            clearTimeout(timer);
        }
    }
    catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            return { ok: false, error: 'Timed out — the model took too long (a large local model can hang your machine; pick a smaller one).' };
        }
        return { ok: false, error: errMessage(error) };
    }
}
/* ── provider HTTP ───────────────────────────────────────────────── */
function bearer(apiKey) {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
function bearerAuth(apiKey) {
    return async () => bearer(apiKey);
}
async function authorizerFor(conn, apiKey) {
    if (conn.auth !== 'device-key')
        return bearerAuth(apiKey);
    const pair = await getSigningKey(conn.id);
    if (!pair)
        throw new Error('This Ollama device key is gone — remove the connection and sign in again.');
    return (method, url) => signRequest(pair, method, url);
}
/**
 * Anthropic headers. Subscription tokens ride in Authorization (x-api-key
 * 401s for them); API keys use x-api-key.
 *
 * The `dangerous-direct-browser-access` header opts a request into CORS
 * (browser) handling — API keys NEED it (else 401 "must set the header"),
 * but subscription orgs REJECT it ("CORS requests are not allowed for this
 * Organization"). Subscription requests instead go out as plain server
 * requests: no such header, and the host extension's DNR ruleset (see
 * manifest/dnr-rules.json) strips Origin/Sec-Fetch on api.anthropic.com so
 * Anthropic doesn't classify them as CORS.
 */
function anthropicHeaders(token, subscription) {
    return subscription
        ? {
            authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'anthropic-version': ANTHROPIC_VERSION,
        }
        : {
            'x-api-key': token,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-dangerous-direct-browser-access': 'true',
        };
}
async function anthropicModels(token, subscription) {
    const res = await fetch(`${ANTHROPIC_BASE}/v1/models?limit=100`, {
        headers: anthropicHeaders(token, subscription),
    });
    if (!res.ok)
        throw new Error(await describeHttp(res));
    const json = (await res.json());
    return (json.data ?? []).map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
}
async function openaiModels(authorize, base) {
    const url = new URL(`${base}/v1/models`);
    const res = await fetch(url, { headers: await authorize('GET', url) });
    if (!res.ok)
        throw new Error(await describeHttp(res));
    const json = (await res.json());
    return (json.data ?? [])
        .map((m) => ({ id: m.id, name: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
}
async function anthropicComplete(token, model, req, signal, debug = false, subscription = false) {
    const body = {
        model,
        max_tokens: req.maxTokens ?? 1024,
        // Subscription tokens are gated on Claude-Code-shaped traffic: the system
        // prompt must lead with the sentinel or the call 429s.
        ...(subscription ? withClaudeCodeSystem(req.system) : { system: req.system }),
        messages: [{ role: 'user', content: req.prompt }],
    };
    const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: 'POST',
        signal,
        headers: {
            ...anthropicHeaders(token, subscription),
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const rawText = await res.text();
    if (debug)
        dlog('http response', { url: `${ANTHROPIC_BASE}/v1/messages`, status: res.status, body: rawText });
    if (!res.ok)
        throw new Error(describeHttpText(res.status, rawText));
    const json = JSON.parse(rawText);
    return (json.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();
}
async function openaiComplete(authorize, base, model, req, signal, debug = false) {
    const url = new URL(`${base}/v1/chat/completions`);
    const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: { ...(await authorize('POST', url)), 'content-type': 'application/json' },
        body: JSON.stringify({
            model,
            max_tokens: req.maxTokens ?? 1024,
            messages: [
                { role: 'system', content: req.system },
                { role: 'user', content: req.prompt },
            ],
            // Note: we deliberately don't send reasoning_effort/enable_thinking —
            // strict servers (OpenAI) 400 on unknown fields. Thinking is
            // discouraged via the system prompt and stripped from the response.
        }),
    });
    const rawText = await res.text();
    if (debug)
        dlog('http response', { url: url.href, status: res.status, body: rawText });
    if (!res.ok)
        throw new Error(describeHttpText(res.status, rawText));
    const json = JSON.parse(rawText);
    return (json.choices?.[0]?.message?.content ?? '').trim();
}
async function describeHttp(res) {
    return describeHttpText(res.status, await res.text());
}
function describeHttpText(status, body) {
    let detail = '';
    try {
        const parsed = JSON.parse(body);
        detail =
            typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? body.slice(0, 200));
    }
    catch {
        detail = body.slice(0, 200);
    }
    return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
}
function errMessage(error) {
    if (error instanceof TypeError)
        return 'Network error (check the base URL / that the server is reachable). Local endpoints may also need CORS opened for the extension, e.g. OLLAMA_ORIGINS.';
    return error instanceof Error ? error.message : String(error);
}
/**
 * Build a message handler for composing with an existing onMessage listener.
 * Returns true if it handled the message (and will call sendResponse
 * asynchronously) — propagate that return so Chrome keeps the channel open.
 */
export function createAiMessageHandler(options = {}) {
    opts = resolve(options);
    configureCryptoDb(opts.cryptoDbName);
    const p = opts.prefix;
    return (message, sendResponse) => {
        switch (message?.type) {
            case `${p}:ai-get`:
                void getView().then(sendResponse);
                return true;
            case `${p}:ai-set-active`:
                void setActive(message).then(sendResponse);
                return true;
            case `${p}:ai-save-connection`:
                void saveConnection(message).then(sendResponse);
                return true;
            case `${p}:ai-delete-connection`:
                void deleteConnection(message).then(sendResponse);
                return true;
            case `${p}:ai-list-models`:
                void listModels(message).then(sendResponse);
                return true;
            case `${p}:ai-complete`:
                void complete(message).then(sendResponse);
                return true;
            case `${p}:ai-anthropic-login-start`:
                void anthropicLoginStart().then(sendResponse);
                return true;
            case `${p}:ai-anthropic-login-complete`:
                void anthropicLoginComplete(message).then(sendResponse);
                return true;
            case `${p}:ai-anthropic-paste-token`:
                void anthropicPasteToken(message).then(sendResponse);
                return true;
            case `${p}:ai-chatgpt-login-start`:
                void chatgptLoginStart().then(sendResponse);
                return true;
            case `${p}:ai-chatgpt-login-poll`:
                void chatgptLoginPoll(message.label ?? '').then(sendResponse);
                return true;
            case `${p}:ai-ollama-login-start`:
                void ollamaLoginStart(message.deviceName ?? '').then(sendResponse);
                return true;
            case `${p}:ai-ollama-login-poll`:
                void ollamaLoginPoll(message.label ?? '').then(sendResponse);
                return true;
            default:
                return false;
        }
    };
}
/** One-call wiring: adds its own chrome.runtime.onMessage listener. */
export function registerAiHandlers(options = {}) {
    const handle = createAiMessageHandler(options);
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => handle(message, sendResponse));
}
export { CODEX_MODELS } from './openai-oauth.js';
