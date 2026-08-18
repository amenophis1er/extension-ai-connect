/**
 * OpenAI "Connect with ChatGPT" device flow + Codex inference, ported from
 * the proven ekip/vonzio/wassup implementations to the MV3 worker.
 *
 * The flow is non-standard in two ways that matter:
 *   - polling is keyed by `device_auth_id`, NOT the RFC-8628 device_code;
 *   - approval does NOT return tokens — it returns an authorization_code
 *     plus a SERVER-ISSUED code_verifier, exchanged at /oauth/token with the
 *     DEVICE redirect uri.
 *
 * The resulting token does NOT work against api.openai.com: inference goes
 * to the ChatGPT Codex backend, which speaks the OpenAI *Responses* API,
 * only streams, and rejects max_output_tokens. The client id is OpenAI's own
 * Codex CLI app id (there is no third-party client to register).
 *
 * Users must first enable: ChatGPT → Settings → Security & Login →
 * "Enable device code authorization for Codex" (off by default; the start
 * call 404s without it).
 */
const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
/** The usercode response carries no expiry; this bounds the poll loop. */
export const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
/** Never poll faster than this, whatever the server suggests. */
const MIN_POLL_MS = 2000;
/** Curated list — the Codex backend has no model-enumeration endpoint. */
export const CODEX_MODELS = [
    'gpt-5.6-sol',
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
];
/* ── JWT helpers (payload only, never trusted for authorization) ───── */
function decodeJwtPayload(jwt) {
    try {
        const part = jwt.split('.')[1];
        if (!part)
            return null;
        const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
        const payload = JSON.parse(json);
        return typeof payload === 'object' && payload !== null
            ? payload
            : null;
    }
    catch {
        return null;
    }
}
export function accountIdFromJwt(jwt) {
    const ns = decodeJwtPayload(jwt)?.[JWT_CLAIM_PATH];
    const id = ns?.chatgpt_account_id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
}
function expiryFromJwt(jwt) {
    const exp = decodeJwtPayload(jwt)?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : 0;
}
function parseTokens(raw) {
    const r = (raw ?? {});
    const accessToken = typeof r.access_token === 'string' ? r.access_token : '';
    if (!accessToken)
        throw new Error('Token response missing access_token.');
    const refreshToken = typeof r.refresh_token === 'string' ? r.refresh_token : '';
    const idToken = typeof r.id_token === 'string' ? r.id_token : undefined;
    const expiresInSec = typeof r.expires_in === 'number' && r.expires_in > 0 ? r.expires_in : 900;
    return {
        accessToken,
        refreshToken,
        expiresAt: expiryFromJwt(accessToken) || Date.now() + expiresInSec * 1000,
        accountId: accountIdFromJwt(accessToken) ?? (idToken ? accountIdFromJwt(idToken) : undefined),
    };
}
export async function startDeviceLogin() {
    const res = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (!res.ok) {
        if (res.status === 404) {
            throw new Error('Device-code login is not enabled on this ChatGPT account. Turn it on: ChatGPT → Settings → Security & Login → "Enable device code authorization for Codex", then try again.');
        }
        throw new Error(`Device login start failed (${res.status}): ${await res.text()}`);
    }
    const j = (await res.json());
    const deviceAuthId = typeof j.device_auth_id === 'string' ? j.device_auth_id : '';
    const userCode = typeof j.user_code === 'string' ? j.user_code : '';
    if (!deviceAuthId || !userCode)
        throw new Error('Device login returned no code.');
    // `interval` may arrive as a string.
    const rawInterval = typeof j.interval === 'string' ? Number(j.interval.trim()) : j.interval;
    const intervalSec = typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval > 0
        ? rawInterval
        : 5;
    return {
        deviceAuthId,
        userCode,
        verifyUrl: `${ISSUER}/codex/device`,
        intervalSec,
        expiresAt: Date.now() + DEVICE_TIMEOUT_MS,
    };
}
/** One poll. 403/404 and `deviceauth_authorization_pending` mean keep going. */
export async function pollDevice(deviceAuthId, userCode) {
    const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
    if (res.ok) {
        const j = (await res.json().catch(() => ({})));
        const authorizationCode = typeof j.authorization_code === 'string' ? j.authorization_code : '';
        const codeVerifier = typeof j.code_verifier === 'string' ? j.code_verifier : '';
        if (authorizationCode && codeVerifier) {
            return { status: 'authorized', authorizationCode, codeVerifier };
        }
        return { status: 'denied', error: 'Malformed device token response.' };
    }
    if (res.status === 403 || res.status === 404)
        return { status: 'pending' };
    const bodyText = await res.text().catch(() => '');
    let code;
    try {
        const err = JSON.parse(bodyText).error;
        code = typeof err === 'object' ? err?.code : err;
    }
    catch {
        /* non-JSON */
    }
    if (code === 'deviceauth_authorization_pending')
        return { status: 'pending' };
    if (code === 'slow_down')
        return { status: 'slow_down' };
    return { status: 'denied', error: `Device auth failed (${res.status})${bodyText ? `: ${bodyText}` : ''}` };
}
/** Exchange the approval for tokens. Form-encoded; DEVICE redirect uri. */
export async function exchangeDeviceCode(input) {
    const res = await fetch(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            code: input.authorizationCode,
            code_verifier: input.codeVerifier,
            redirect_uri: `${ISSUER}/deviceauth/callback`,
        }).toString(),
    });
    if (!res.ok)
        throw new Error(`Code exchange failed (${res.status}): ${await res.text()}`);
    return parseTokens(await res.json());
}
/** Rotate a refresh token. SINGLE-USE — persist the pair immediately. A
 *  response omitting refresh_token keeps the old one. */
export async function refreshOpenAiTokens(refreshToken) {
    const res = await fetch(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            refresh_token: refreshToken,
        }).toString(),
    });
    if (!res.ok)
        throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
    const tokens = parseTokens(await res.json());
    if (!tokens.refreshToken)
        tokens.refreshToken = refreshToken;
    return tokens;
}
/** Poll interval floor + slow_down backoff, bounded by the 15-min window. */
export function nextPollDelayMs(intervalSec, slowDowns) {
    return Math.max(intervalSec * 1000, MIN_POLL_MS) + slowDowns * 5000;
}
/* ── Codex inference (Responses API, streaming only) ──────────────── */
/**
 * One text completion through the ChatGPT Codex backend. The backend only
 * streams and rejects max_output_tokens, so we always stream and aggregate
 * the SSE `response.output_text.delta` events into a single string.
 */
export async function codexComplete(input, signal) {
    const res = await fetch(CODEX_URL, {
        method: 'POST',
        signal,
        headers: {
            authorization: `Bearer ${input.accessToken}`,
            // Omitted entirely when unresolvable — an empty value is rejected.
            ...(input.accountId ? { 'chatgpt-account-id': input.accountId } : {}),
            originator: 'codex_cli_rs',
            'openai-beta': 'responses=experimental',
            'content-type': 'application/json',
            accept: 'text/event-stream',
        },
        body: JSON.stringify({
            model: input.model,
            store: false,
            stream: true,
            instructions: input.system || 'You are a helpful assistant.',
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input.prompt }] }],
            // max_output_tokens deliberately NOT sent: "Unsupported parameter".
        }),
    });
    if (!res.ok || !res.body) {
        throw new Error(`Codex request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.startsWith('data:'))
                continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]')
                continue;
            try {
                const evt = JSON.parse(payload);
                if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
                    text += evt.delta;
                }
            }
            catch {
                /* ignore non-JSON keepalives */
            }
        }
    }
    return text.trim();
}
