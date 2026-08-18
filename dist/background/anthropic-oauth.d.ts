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
/**
 * Subscription OAuth tokens are gated on Claude-Code-shaped traffic: a
 * /v1/messages call whose system prompt doesn't lead with this exact
 * sentinel is refused with a bare 429. `withClaudeCodeSystem` prepends it.
 */
export declare const CLAUDE_CODE_SENTINEL = "You are Claude Code, Anthropic's official CLI for Claude.";
export interface AnthropicTokens {
    accessToken: string;
    refreshToken: string;
    /** Absolute expiry, epoch ms (tokens are opaque, so from expires_in). */
    expiresAt: number;
}
/** Pasted `claude setup-token` output — long-lived, no refresh, never refreshed. */
export declare function isSetupToken(token: string): boolean;
export interface LoginStart {
    verifier: string;
    state: string;
    authorizeUrl: string;
}
export declare function startLogin(): Promise<LoginStart>;
/** Parse whatever the user pastes: raw `code#state`, a URL, a query, or bare. */
export declare function parsePaste(input: string): {
    code?: string;
    state?: string;
};
/** Exchange the pasted `code#state` (state REQUIRED — enforces CSRF). JSON body. */
export declare function exchangeCode(input: {
    pasted: string;
    expectedState: string;
    verifier: string;
}): Promise<AnthropicTokens>;
/** Refresh grant (JSON body). Refresh token is SINGLE-USE and rotates. */
export declare function refreshTokens(refreshToken: string): Promise<AnthropicTokens>;
/** Ensure the request body's system prompt leads with the Claude Code sentinel. */
export declare function withClaudeCodeSystem(system: string): {
    system: {
        type: 'text';
        text: string;
    }[];
};
