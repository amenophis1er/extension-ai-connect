import {
  normalizeBaseUrl,
  defaultLabel,
  type AIAnthropicLoginCompleteRequest,
  type AIAnthropicLoginStart,
  type AIAnthropicPasteTokenRequest,
  type AIChatMessageRequest,
  type AIChatRequest,
  type AIChatResult,
  type AIChatgptPoll,
  type AICompleteRequest,
  type AIConfigView,
  type AIDeleteConnectionRequest,
  type AIListModelsRequest,
  type AIOllamaLoginStart,
  type AIOllamaPoll,
  type AIResult,
  type AISaveConnectionRequest,
  type AISetActiveRequest,
  type AuthMode,
  type ConnectionView,
  type ModelInfo,
  type ProviderKind,
} from '../types.js';
import {
  configureCryptoDb,
  createSigningKey,
  decryptBlob,
  deleteSigningKey,
  encryptString,
  getSigningKey,
  type EncBlob,
} from './crypto.js';
import { anthropicBody, anthropicResult } from './chat-anthropic.js';
import { openaiBody, openaiResult, rejectsParallel } from './chat-openai.js';
import { readSse } from './sse.js';
import {
  CONNECT_POLL_MS,
  CONNECT_TIMEOUT_MS,
  OLLAMA_BASE,
  connectUrl,
  disconnect as ollamaDisconnect,
  publicKeyLine,
  signRequest,
  whoami,
} from './ollama-device.js';
import {
  exchangeCode,
  isSetupToken,
  refreshTokens,
  startLogin,
  withClaudeCodeSystem,
} from './anthropic-oauth.js';
import {
  CODEX_MODELS,
  codexComplete,
  exchangeDeviceCode,
  nextPollDelayMs,
  pollDevice,
  refreshOpenAiTokens,
  startDeviceLogin,
  type DeviceStart,
} from './openai-oauth.js';

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

interface Resolved {
  prefix: string;
  storageKey: string;
  cryptoDbName: string;
  debugFlagKey: string;
  settingsHint: string;
  openConsentTab: boolean;
}

let opts: Resolved = resolve({});

function resolve(o: AiHandlerOptions): Resolved {
  return {
    prefix: o.prefix ?? 'aiconnect',
    storageKey: o.storageKey ?? 'aiConnections',
    cryptoDbName: o.cryptoDbName ?? 'ai-connect-crypto',
    debugFlagKey: o.debugFlagKey ?? 'aiConnectDebug',
    settingsHint: o.settingsHint ?? 'Add one in the extension settings.',
    openConsentTab: o.openConsentTab ?? true,
  };
}

interface StoredConnection {
  id: string;
  kind: ProviderKind;
  /** 'key' (default) | 'oauth' (Claude Pro/Max, refreshable) | 'setup-token'. */
  auth?: AuthMode;
  label: string;
  baseUrl: string;
  model: string;
  /** The secret: API key, or (oauth/setup-token) the access/setup token. */
  apiKeyEnc: EncBlob | null;
  /** oauth only: rotating refresh token + absolute expiry (epoch ms). */
  refreshTokenEnc?: EncBlob | null;
  expiresAt?: number;
  /** chatgpt only: account id from the JWT, sent as chatgpt-account-id. */
  accountId?: string;
  /** device-key only: the Ollama account the device key is paired with. The
   *  key pair itself lives in IndexedDB under the connection id. */
  account?: string;
  /** Bumped by every settings save; absent means 0. */
  revision?: number;
}
interface StoredConfig {
  activeId: string | null;
  connections: StoredConnection[];
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
async function debugOn(): Promise<boolean> {
  return (await chrome.storage.local.get(opts.debugFlagKey))[opts.debugFlagKey] === true;
}
function dlog(label: string, data: unknown): void {
  console.log(`%c[ai-connect] ${label}`, 'color:#00a884;font-weight:bold', data);
}

/** Strip reasoning/thinking the model may emit despite instructions. */
function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .trim();
}

function empty(): StoredConfig {
  return { activeId: null, connections: [] };
}

/**
 * Load config, migrating older shapes into the connections list:
 *  - v3: { activeId, connections: [...] }              (current)
 *  - v2: { provider, creds: { <kind>: {baseUrl, model, apiKeyEnc|apiKey} } }
 *  - v1: { provider, apiKey, baseUrl, model }          (flat plaintext)
 * Any plaintext key found is encrypted on the way in.
 */
async function load(): Promise<StoredConfig> {
  const raw = (await chrome.storage.local.get(opts.storageKey))[opts.storageKey] as
    | Record<string, unknown>
    | undefined;
  if (!raw) return empty();

  // v3 — already migrated.
  if (Array.isArray(raw.connections)) {
    return {
      activeId: (raw.activeId as string | null) ?? null,
      connections: raw.connections as StoredConnection[],
    };
  }

  const cfg = empty();
  const add = async (kind: ProviderKind, c: Record<string, unknown>, active: boolean) => {
    const hasContent = c.apiKey || c.apiKeyEnc || c.model;
    if (!hasContent) return;
    const apiKeyEnc =
      typeof c.apiKey === 'string' && c.apiKey
        ? await encryptString(c.apiKey) // v1/v2 plaintext
        : ((c.apiKeyEnc as EncBlob | undefined) ?? null);
    const baseUrl = (c.baseUrl as string) ?? '';
    const conn: StoredConnection = {
      id: crypto.randomUUID(),
      kind,
      label: defaultLabel(kind, baseUrl),
      baseUrl,
      model: (c.model as string) ?? '',
      apiKeyEnc,
    };
    cfg.connections.push(conn);
    if (active) cfg.activeId = conn.id;
  };

  const activeKind = raw.provider as string | undefined;
  if (raw.creds && typeof raw.creds === 'object') {
    const src = raw.creds as Record<string, Record<string, unknown>>;
    for (const kind of ['anthropic', 'openai-compatible'] as ProviderKind[]) {
      const entry = src[kind];
      if (entry) await add(kind, entry, activeKind === kind);
    }
  } else if (typeof raw.apiKey === 'string') {
    if (activeKind === 'anthropic' || activeKind === 'openai-compatible') {
      await add(activeKind, raw as Record<string, unknown>, true);
    }
  }

  await save(cfg);
  return cfg;
}

async function save(cfg: StoredConfig): Promise<void> {
  await chrome.storage.local.set({ [opts.storageKey]: cfg });
}

/**
 * The one writer for the connection record.
 *
 * Every connection lives in one storage record, and every change is a
 * read-modify-write of the whole record. Two of those interleaved lose one:
 * refreshing connection A while the settings UI edits B can drop B's edit, and
 * two refreshes can restore a used single-use refresh token. So every
 * read-modify-write — saves, deletes, token refresh, sign-in completion —
 * runs through this queue, one at a time. `fn` must not call withConfig.
 */
let configQueue: Promise<unknown> = Promise.resolve();
function withConfig<T>(fn: (cfg: StoredConfig) => Promise<T>): Promise<T> {
  const run = configQueue.then(async () => fn(await load()));
  configQueue = run.catch(() => undefined);
  return run;
}

async function toView(c: StoredConnection): Promise<ConnectionView> {
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
      revision: c.revision ?? 0,
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
    revision: c.revision ?? 0,
  };
}

async function getView(): Promise<AIConfigView> {
  const cfg = await load();
  return {
    activeId: cfg.activeId,
    connections: await Promise.all(cfg.connections.map(toView)),
  };
}

async function setActive(req: AISetActiveRequest): Promise<AIResult<null>> {
  return withConfig(async (cfg) => {
    cfg.activeId = req.id && cfg.connections.some((c) => c.id === req.id) ? req.id : null;
    await save(cfg);
    return { ok: true };
  });
}

async function saveConnection(req: AISaveConnectionRequest): Promise<AIResult<{ id: string }>> {
  return withConfig(async (cfg) => {
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
    if (req.apiKeyMode === 'set') conn.apiKeyEnc = await encryptString(req.apiKey ?? '');
    else if (req.apiKeyMode === 'clear') conn.apiKeyEnc = null;
    conn.revision = (conn.revision ?? 0) + 1;
    if (req.makeActive) cfg.activeId = conn.id;
    await save(cfg);
    return { ok: true, data: { id: conn.id } };
  });
}

/* ── Claude subscription sign-in ──────────────────────────────────── */

const PENDING_KEY = 'aiConnectAnthropicLogin';

/** Begin the Claude sign-in: mint PKCE, open the consent tab, stash the
 *  verifier/state in session storage (survives an SW restart while the user
 *  approves), and return the URL as a fallback link. */
async function anthropicLoginStart(): Promise<AIResult<AIAnthropicLoginStart>> {
  try {
    const { verifier, state, authorizeUrl } = await startLogin();
    await chrome.storage.session.set({ [PENDING_KEY]: { verifier, state } });
    if (opts.openConsentTab) void chrome.tabs.create({ url: authorizeUrl }).catch(() => {});
    return { ok: true, data: { authorizeUrl } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** Finish the sign-in: exchange the pasted code, store tokens as a new
 *  connection, make it active. */
async function anthropicLoginComplete(
  req: AIAnthropicLoginCompleteRequest,
): Promise<AIResult<{ id: string }>> {
  try {
    const pending = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] as
      | { verifier: string; state: string }
      | undefined;
    if (!pending) throw new Error('Sign-in expired — start again.');
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
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** Add a Claude subscription connection from a pasted setup-token (no refresh). */
async function anthropicPasteToken(
  req: AIAnthropicPasteTokenRequest,
): Promise<AIResult<{ id: string }>> {
  try {
    const token = req.token.trim();
    if (!isSetupToken(token)) throw new Error('That is not a setup-token (should start with sk-ant-oat).');
    const id = await createSubscriptionConnection({
      auth: 'setup-token',
      label: req.label || 'Claude (setup-token)',
      token,
    });
    return { ok: true, data: { id } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

async function createSubscriptionConnection(input: {
  auth: AuthMode;
  label: string;
  token: string;
  refreshToken?: string;
  expiresAt?: number;
}): Promise<string> {
  const conn: StoredConnection = {
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
  await addConnection(conn);
  return conn.id;
}

/** Append a connection and make it active, through the one writer. */
function addConnection(conn: StoredConnection): Promise<void> {
  return withConfig(async (cfg) => {
    cfg.connections.push(conn);
    cfg.activeId = conn.id;
    await save(cfg);
  });
}

/* ── ChatGPT subscription (device flow) ───────────────────────────── */

const CHATGPT_PENDING = 'aiConnectChatgptDevice';

/** Start the device flow: get a user code, stash the session, tell the UI
 *  what to show. The user approves at the verify URL; the UI then polls. */
async function chatgptLoginStart(): Promise<AIResult<{ userCode: string; verifyUrl: string }>> {
  try {
    const start = await startDeviceLogin();
    await chrome.storage.session.set({ [CHATGPT_PENDING]: { ...start, slowDowns: 0 } });
    if (opts.openConsentTab) void chrome.tabs.create({ url: start.verifyUrl }).catch(() => {});
    return { ok: true, data: { userCode: start.userCode, verifyUrl: start.verifyUrl } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** One poll step, driven by the UI so the worker can be killed between
 *  polls (MV3) without losing the session — it lives in session storage. */
async function chatgptLoginPoll(label: string): Promise<AIResult<AIChatgptPoll>> {
  try {
    const pending = (await chrome.storage.session.get(CHATGPT_PENDING))[CHATGPT_PENDING] as
      | (DeviceStart & { slowDowns: number })
      | undefined;
    if (!pending) throw new Error('Sign-in expired — start again.');
    if (Date.now() > pending.expiresAt) {
      await chrome.storage.session.remove(CHATGPT_PENDING);
      throw new Error('Sign-in timed out after 15 minutes — start again.');
    }
    const poll = await pollDevice(pending.deviceAuthId, pending.userCode);
    if (poll.status === 'pending') return { ok: true, data: { status: 'pending' } };
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
    const conn: StoredConnection = {
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
    await addConnection(conn);
    return { ok: true, data: { status: 'created', id: conn.id } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** How long the UI should wait before the next poll. */
export function chatgptPollDelay(intervalSec: number, slowDowns: number): number {
  return nextPollDelayMs(intervalSec, slowDowns);
}

/* ── Ollama Cloud (connect device) ────────────────────────────────── */

const OLLAMA_PENDING = 'aiConnectOllamaConnect';

/** Start pairing: mint a device key under a fresh connection id, open
 *  ollama.com/connect for it, and remember the attempt in session storage
 *  (survives an SW restart while the user clicks Connect). */
async function ollamaLoginStart(deviceName: string): Promise<AIResult<AIOllamaLoginStart>> {
  try {
    const previous = (await chrome.storage.session.get(OLLAMA_PENDING))[OLLAMA_PENDING] as
      | { id: string }
      | undefined;
    if (previous) await deleteSigningKey(previous.id);
    const id = crypto.randomUUID();
    const pair = await createSigningKey(id);
    const url = connectUrl(deviceName.trim() || 'Chrome extension', await publicKeyLine(pair));
    await chrome.storage.session.set({
      [OLLAMA_PENDING]: { id, expiresAt: Date.now() + CONNECT_TIMEOUT_MS },
    });
    if (opts.openConsentTab) void chrome.tabs.create({ url }).catch(() => {});
    return { ok: true, data: { connectUrl: url, pollMs: CONNECT_POLL_MS } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** One poll, driven by the UI: is the pending key paired yet? */
async function ollamaLoginPoll(label: string): Promise<AIResult<AIOllamaPoll>> {
  try {
    const pending = (await chrome.storage.session.get(OLLAMA_PENDING))[OLLAMA_PENDING] as
      | { id: string; expiresAt: number }
      | undefined;
    if (!pending) throw new Error('Sign-in expired — start again.');
    const pair = await getSigningKey(pending.id);
    if (!pair || Date.now() > pending.expiresAt) {
      await chrome.storage.session.remove(OLLAMA_PENDING);
      await deleteSigningKey(pending.id);
      throw new Error('Sign-in timed out after 15 minutes — start again.');
    }
    const account = await whoami(pair);
    if (!account) return { ok: true, data: { status: 'pending' } };
    await chrome.storage.session.remove(OLLAMA_PENDING);
    await addConnection({
      id: pending.id,
      kind: 'openai-compatible',
      auth: 'device-key',
      label: label || (account.name ? `Ollama Cloud (${account.name})` : 'Ollama Cloud'),
      baseUrl: OLLAMA_BASE,
      model: '',
      apiKeyEnc: null,
      account: account.name,
    });
    return { ok: true, data: { status: 'created', id: pending.id } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** Refresh an OAuth connection's token if it's near expiry, persisting the
 *  rotated pair through the one writer. Returns the usable access token. */
async function freshToken(connId: string): Promise<string> {
  return withConfig(async (cfg) => {
    const conn = cfg.connections.find((c) => c.id === connId);
    if (!conn) throw new Error('That AI connection no longer exists.');
    const access = await decryptBlob(conn.apiKeyEnc);
    if (conn.auth !== 'oauth') return access; // setup-token / key / device-key: no refresh
    const skewMs = 5 * 60_000;
    if (conn.expiresAt && Date.now() < conn.expiresAt - skewMs) return access;
    const refresh = await decryptBlob(conn.refreshTokenEnc);
    if (!refresh) return access; // can't refresh; try the current token
    const tokens =
      conn.kind === 'chatgpt' ? await refreshOpenAiTokens(refresh) : await refreshTokens(refresh);
    conn.apiKeyEnc = await encryptString(tokens.accessToken);
    conn.refreshTokenEnc = await encryptString(tokens.refreshToken);
    conn.expiresAt = tokens.expiresAt;
    const accountId = (tokens as { accountId?: string }).accountId;
    if (accountId) conn.accountId = accountId;
    await save(cfg); // persist rotated single-use token immediately
    return tokens.accessToken;
  });
}

async function deleteConnection(req: AIDeleteConnectionRequest): Promise<AIResult<null>> {
  const gone = (await load()).connections.find((c) => c.id === req.id);
  if (gone?.auth === 'device-key') {
    // Un-pair on ollama.com, then drop the key; a failed un-pair still drops it.
    const pair = await getSigningKey(gone.id);
    if (pair) await ollamaDisconnect(pair).catch(() => {});
    await deleteSigningKey(gone.id);
  }
  return withConfig(async (cfg) => {
    cfg.connections = cfg.connections.filter((c) => c.id !== req.id);
    if (cfg.activeId === req.id) cfg.activeId = null;
    await save(cfg);
    return { ok: true };
  });
}

async function listModels(req: AIListModelsRequest): Promise<AIResult<ModelInfo[]>> {
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
    const apiKey = req.apiKey || (stored ? await freshToken(stored.id) : '');
    if (req.kind === 'anthropic' && !apiKey) throw new Error('Enter an API key first.');
    const models =
      req.kind === 'anthropic'
        ? await anthropicModels(apiKey, subscription)
        : await openaiModels(
            stored && !req.apiKey ? await authorizerFor(stored, apiKey) : bearerAuth(apiKey),
            normalizeBaseUrl(req.baseUrl),
          );
    return { ok: true, data: models };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

async function complete(req: AICompleteRequest): Promise<AIResult<string>> {
  try {
    const cfg = await load();
    const conn = cfg.connections.find((c) => c.id === cfg.activeId);
    if (!conn) throw new Error(`No AI connection selected. ${opts.settingsHint}`);
    const subscription = conn.auth === 'oauth' || conn.auth === 'setup-token';
    const apiKey = await freshToken(conn.id);
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
      const raw =
        conn.kind === 'anthropic'
          ? await anthropicComplete(apiKey, conn.model, req, controller.signal, debug, subscription)
          : conn.kind === 'chatgpt'
            ? await codexComplete(
                {
                  accessToken: apiKey,
                  accountId: conn.accountId,
                  model: conn.model,
                  system: req.system,
                  prompt: req.prompt,
                },
                controller.signal,
              )
            : await openaiComplete(
                await authorizerFor(conn, apiKey),
                normalizeBaseUrl(conn.baseUrl),
                conn.model,
                req,
                controller.signal,
                debug,
              );
      const text = stripThinking(raw);
      if (debug) dlog('result', { raw, afterStripThinking: text });
      return { ok: true, data: text };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, error: 'Timed out — the model took too long (a large local model can hang your machine; pick a smaller one).' };
    }
    return { ok: false, error: errMessage(error) };
  }
}

/* ── chat with tools ─────────────────────────────────────────────── */

/** Whole-request default for chat(); the stream itself keeps the worker's fetch alive. */
const CHAT_TIMEOUT_MS = 120_000;

/** Request bodies for the debug log, with image bytes replaced (they are never logged). */
function redactImages(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body, (key, value: unknown) =>
    (key === 'data' || key === 'url') && typeof value === 'string' && (value.length > 200 || value.startsWith('data:'))
      ? `[${value.length} chars redacted]` : value));
}

/**
 * One model turn with tools, called directly inside the worker (D4).
 *
 * Streams the response (SSE) and returns it only after the provider's terminal
 * event. Uses the pinned connection when `connectionId` is given; if that
 * connection is gone, or its `revision` moved since the run started, the call
 * fails rather than send the conversation somewhere the run did not start.
 */
export async function chat(req: AIChatRequest, options: { signal?: AbortSignal } = {}): Promise<AIChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), req.timeoutMs ?? CHAT_TIMEOUT_MS);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const cfg = await load();
    const id = req.connectionId ?? cfg.activeId;
    const conn = cfg.connections.find((c) => c.id === id);
    if (!conn) {
      throw new Error(req.connectionId
        ? 'The AI connection this run started with no longer exists. Start a new run.'
        : `No AI connection selected. ${opts.settingsHint}`);
    }
    if (req.connectionRevision !== undefined && (conn.revision ?? 0) !== req.connectionRevision) {
      throw new Error('The AI connection was changed during this run. Start a new run to use the new settings.');
    }
    if (conn.kind === 'chrome-builtin') throw new Error('The on-device model has no tool calling.');
    if (conn.kind === 'chatgpt') throw new Error('Tool calling for the ChatGPT subscription is not available yet.');
    const model = req.model ?? conn.model;
    if (!model) throw new Error(`The AI connection has no model selected. ${opts.settingsHint}`);
    const token = await freshToken(conn.id);
    const debug = await debugOn();
    const signal = controller.signal;

    if (conn.kind === 'anthropic') {
      const subscription = conn.auth === 'oauth' || conn.auth === 'setup-token';
      if (!token) throw new Error(`The AI connection has no key. ${opts.settingsHint}`);
      const system = subscription ? withClaudeCodeSystem(req.system).system : req.system ? [{ type: 'text' as const, text: req.system }] : [];
      const body = anthropicBody(req, model, system);
      if (debug) dlog('chat request', { connection: conn.label, body: redactImages(body) });
      const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: 'POST', signal,
        headers: { ...anthropicHeaders(token, subscription), 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) throw new Error(await describeHttp(res));
      const result = await anthropicResult(readSse(res.body));
      if (debug) dlog('chat result', result);
      return result;
    }

    const base = normalizeBaseUrl(conn.baseUrl);
    const authorize = await authorizerFor(conn, token);
    const send = async (omitParallel: boolean) => {
      const url = new URL(`${base}/v1/chat/completions`);
      const body = openaiBody(req, model, base, omitParallel);
      if (debug) dlog('chat request', { connection: conn.label, url: url.origin + url.pathname, body: redactImages(body) });
      return fetch(url, {
        method: 'POST', signal,
        headers: { ...(await authorize('POST', url)), 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });
    };
    let res = await send(false);
    if (!res.ok) {
      const text = await res.text();
      if (!rejectsParallel(res.status, text)) throw new Error(describeHttpText(res.status, text));
      res = await send(true);
      if (!res.ok) throw new Error(await describeHttp(res));
    }
    if (!res.body) throw new Error('The provider sent no response body.');
    const result = await openaiResult(readSse(res.body));
    if (debug) dlog('chat result', result);
    return result;
  } catch (error) {
    if (options.signal?.aborted) return { ok: false, error: 'Stopped.' };
    if (controller.signal.aborted) return { ok: false, error: 'Timed out waiting for the model.' };
    return { ok: false, error: errMessage(error) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/* ── provider HTTP ───────────────────────────────────────────────── */

function bearer(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Auth headers for one openai-compatible request; may also edit the URL
 *  (a device-key signature adds `ts` to the query). */
type Authorizer = (method: string, url: URL) => Promise<Record<string, string>>;

function bearerAuth(apiKey: string): Authorizer {
  return async () => bearer(apiKey);
}

async function authorizerFor(conn: StoredConnection, apiKey: string): Promise<Authorizer> {
  if (conn.auth !== 'device-key') return bearerAuth(apiKey);
  const pair = await getSigningKey(conn.id);
  if (!pair) throw new Error('This Ollama device key is gone — remove the connection and sign in again.');
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
function anthropicHeaders(token: string, subscription: boolean): Record<string, string> {
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

async function anthropicModels(token: string, subscription: boolean): Promise<ModelInfo[]> {
  const res = await fetch(`${ANTHROPIC_BASE}/v1/models?limit=100`, {
    headers: anthropicHeaders(token, subscription),
  });
  if (!res.ok) throw new Error(await describeHttp(res));
  const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
  return (json.data ?? []).map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
}

async function openaiModels(authorize: Authorizer, base: string): Promise<ModelInfo[]> {
  const url = new URL(`${base}/v1/models`);
  const res = await fetch(url, { headers: await authorize('GET', url) });
  if (!res.ok) throw new Error(await describeHttp(res));
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? [])
    .map((m) => ({ id: m.id, name: m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function anthropicComplete(
  token: string,
  model: string,
  req: AICompleteRequest,
  signal: AbortSignal,
  debug = false,
  subscription = false,
): Promise<string> {
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
  if (debug) dlog('http response', { url: `${ANTHROPIC_BASE}/v1/messages`, status: res.status, body: rawText });
  if (!res.ok) throw new Error(describeHttpText(res.status, rawText));
  const json = JSON.parse(rawText) as { content?: { type: string; text?: string }[] };
  return (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

async function openaiComplete(
  authorize: Authorizer,
  base: string,
  model: string,
  req: AICompleteRequest,
  signal: AbortSignal,
  debug = false,
): Promise<string> {
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
  if (debug) dlog('http response', { url: url.href, status: res.status, body: rawText });
  if (!res.ok) throw new Error(describeHttpText(res.status, rawText));
  const json = JSON.parse(rawText) as { choices?: { message?: { content?: string } }[] };
  return (json.choices?.[0]?.message?.content ?? '').trim();
}

async function describeHttp(res: Response): Promise<string> {
  return describeHttpText(res.status, await res.text());
}

function describeHttpText(status: number, body: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    detail =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? body.slice(0, 200));
  } catch {
    detail = body.slice(0, 200);
  }
  return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

function errMessage(error: unknown): string {
  if (error instanceof TypeError)
    return 'Network error (check the base URL / that the server is reachable). Local endpoints may also need CORS opened for the extension, e.g. OLLAMA_ORIGINS.';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build a message handler for composing with an existing onMessage listener.
 * Returns true if it handled the message (and will call sendResponse
 * asynchronously) — propagate that return so Chrome keeps the channel open.
 */
export function createAiMessageHandler(
  options: AiHandlerOptions = {},
): (message: { type?: string }, sendResponse: (r: unknown) => void) => boolean {
  opts = resolve(options);
  configureCryptoDb(opts.cryptoDbName);
  const p = opts.prefix;
  return (message, sendResponse) => {
    switch (message?.type) {
      case `${p}:ai-get`:
        void getView().then(sendResponse);
        return true;
      case `${p}:ai-set-active`:
        void setActive(message as AISetActiveRequest).then(sendResponse);
        return true;
      case `${p}:ai-save-connection`:
        void saveConnection(message as AISaveConnectionRequest).then(sendResponse);
        return true;
      case `${p}:ai-delete-connection`:
        void deleteConnection(message as AIDeleteConnectionRequest).then(sendResponse);
        return true;
      case `${p}:ai-list-models`:
        void listModels(message as AIListModelsRequest).then(sendResponse);
        return true;
      case `${p}:ai-complete`:
        void complete(message as AICompleteRequest).then(sendResponse);
        return true;
      case `${p}:ai-chat`: {
        const { type: _type, ...request } = message as AIChatMessageRequest;
        void chat(request).then(sendResponse);
        return true;
      }
      case `${p}:ai-anthropic-login-start`:
        void anthropicLoginStart().then(sendResponse);
        return true;
      case `${p}:ai-anthropic-login-complete`:
        void anthropicLoginComplete(message as AIAnthropicLoginCompleteRequest).then(sendResponse);
        return true;
      case `${p}:ai-anthropic-paste-token`:
        void anthropicPasteToken(message as AIAnthropicPasteTokenRequest).then(sendResponse);
        return true;
      case `${p}:ai-chatgpt-login-start`:
        void chatgptLoginStart().then(sendResponse);
        return true;
      case `${p}:ai-chatgpt-login-poll`:
        void chatgptLoginPoll((message as { label?: string }).label ?? '').then(sendResponse);
        return true;
      case `${p}:ai-ollama-login-start`:
        void ollamaLoginStart((message as { deviceName?: string }).deviceName ?? '').then(sendResponse);
        return true;
      case `${p}:ai-ollama-login-poll`:
        void ollamaLoginPoll((message as { label?: string }).label ?? '').then(sendResponse);
        return true;
      default:
        return false;
    }
  };
}

/** One-call wiring: adds its own chrome.runtime.onMessage listener. */
export function registerAiHandlers(options: AiHandlerOptions = {}): void {
  const handle = createAiMessageHandler(options);
  chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) =>
    handle(message, sendResponse),
  );
}

export { CODEX_MODELS } from './openai-oauth.js';
