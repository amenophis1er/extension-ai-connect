/**
 * Anthropic Claude subscription OAuth (Claude Pro/Max), ported from the
 * proven ekip/vonzio implementation to WebCrypto for the MV3 worker.
 *
 * Authorization-code + PKCE, public client, OUT-OF-BAND display mode
 * (`code=true` + the platform callback): after consent the page SHOWS a
 * `code#state` string the user pastes back — no redirect registration, no
 * local server, no polling, which is ideal for an extension. Access tokens
 * are opaque (no exp claim); expiry comes from `expires_in` at exchange.
 *
 * Two traps the constants avoid (both rejected only AFTER "Authorize"):
 * the retired console.anthropic.com redirect, and any scope beyond
 * user:inference. The authorize query is percent-encoded BY HAND —
 * URLSearchParams emits '+' for spaces, which the endpoint rejects.
 */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CODE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const SCOPE = 'user:inference';
/**
 * Subscription OAuth tokens are gated on Claude-Code-shaped traffic: a
 * /v1/messages call whose system prompt doesn't lead with this exact
 * sentinel is refused with a bare 429. `withClaudeCodeSystem` prepends it.
 */
export const CLAUDE_CODE_SENTINEL = "You are Claude Code, Anthropic's official CLI for Claude.";
/* ── PKCE (WebCrypto) ─────────────────────────────────────────────── */
function base64url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
function randomB64url() {
    return base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
}
async function codeChallengeS256(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64url(digest);
}
/** Pasted `claude setup-token` output — long-lived, no refresh, never refreshed. */
export function isSetupToken(token) {
    return token.trim().startsWith('sk-ant-oat');
}
export async function startLogin() {
    const verifier = randomB64url();
    const state = randomB64url();
    const params = [
        ['code', 'true'],
        ['client_id', CLIENT_ID],
        ['response_type', 'code'],
        ['redirect_uri', CODE_REDIRECT_URI],
        ['scope', SCOPE],
        ['code_challenge', await codeChallengeS256(verifier)],
        ['code_challenge_method', 'S256'],
        ['state', state],
    ];
    const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return { verifier, state, authorizeUrl: `${AUTHORIZE_URL}?${query}` };
}
/** Parse whatever the user pastes: raw `code#state`, a URL, a query, or bare. */
export function parsePaste(input) {
    const value = (input ?? '').trim();
    if (!value)
        return {};
    try {
        const url = new URL(value);
        return {
            code: url.searchParams.get('code') ?? undefined,
            state: url.searchParams.get('state') ?? undefined,
        };
    }
    catch {
        /* not a URL */
    }
    if (value.includes('#')) {
        const [code, state] = value.split('#', 2).map((p) => p.trim());
        return { code, state };
    }
    if (value.includes('code=')) {
        const params = new URLSearchParams(value);
        return { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined };
    }
    return { code: value };
}
function tokensFromResponse(raw) {
    const r = (raw ?? {});
    const accessToken = typeof r.access_token === 'string' ? r.access_token : '';
    const refreshToken = typeof r.refresh_token === 'string' ? r.refresh_token : '';
    if (!accessToken || !refreshToken)
        throw new Error('Token endpoint returned no token pair.');
    const expiresInSec = typeof r.expires_in === 'number' && r.expires_in > 0 ? r.expires_in : 3600;
    return { accessToken, refreshToken, expiresAt: Date.now() + expiresInSec * 1000 };
}
/** Exchange the pasted `code#state` (state REQUIRED — enforces CSRF). JSON body. */
export async function exchangeCode(input) {
    const { code, state } = parsePaste(input.pasted);
    if (!code)
        throw new Error('Paste the code shown after approving in the browser.');
    if (!state)
        throw new Error("Paste the FULL code, including the part after '#'.");
    if (state !== input.expectedState)
        throw new Error('Sign-in state mismatch — start again.');
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            code,
            state,
            redirect_uri: CODE_REDIRECT_URI,
            code_verifier: input.verifier,
        }),
    });
    if (!res.ok)
        throw new Error(await httpError('Token exchange', res));
    return tokensFromResponse(await res.json());
}
/** Refresh grant (JSON body). Refresh token is SINGLE-USE and rotates. */
export async function refreshTokens(refreshToken) {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            refresh_token: refreshToken,
        }),
    });
    if (!res.ok)
        throw new Error(await httpError('Token refresh', res));
    return tokensFromResponse(await res.json());
}
async function httpError(what, res) {
    let detail = '';
    try {
        detail = (await res.text()).slice(0, 300);
    }
    catch {
        /* ignore */
    }
    if (res.status === 429 || /rate.?limit/i.test(detail)) {
        return "Anthropic is rate-limiting sign-in (usually from repeated tries). Wait a few minutes, then do it ONCE with a fresh code — or use 'Paste a setup-token instead', which skips this step.";
    }
    return `${what} failed (${res.status})${detail ? `: ${detail}` : ''}`;
}
/** Ensure the request body's system prompt leads with the Claude Code sentinel. */
export function withClaudeCodeSystem(system) {
    const blocks = system ? [{ type: 'text', text: system }] : [];
    if (blocks[0]?.text.startsWith(CLAUDE_CODE_SENTINEL))
        return { system: blocks };
    return { system: [{ type: 'text', text: CLAUDE_CODE_SENTINEL }, ...blocks] };
}
