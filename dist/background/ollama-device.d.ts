/**
 * Ollama Cloud "connect device" sign-in, as `ollama signin` does it.
 *
 * Not an OAuth flow: no code, no token. The device owns an Ed25519 key pair;
 * the user opens ollama.com/connect with the public key in the URL and clicks
 * Connect, which pairs that key with their account. From then on every
 * request to ollama.com is signed:
 *
 *   Authorization: <ssh wire-format public key, base64>:<signature, base64>
 *   signature = Ed25519(`${METHOD},${PATH}?ts=${unix seconds}`)
 *   and the same `ts` rides in the URL's query.
 *
 * Nothing calls back when the user connects, so the worker polls a signed
 * POST /api/me until it names a real account (an unpaired key gets 200 with
 * an all-zero user ID, not a 401). Signed requests
 * are accepted on /api/* and on the OpenAI-compatible /v1/* routes alike, so
 * inference reuses the openai-compatible path with this signer in place of a
 * Bearer key. Ported from ollama's auth.Sign / api.Client.do / signinURL.
 */
export declare const OLLAMA_BASE = "https://ollama.com";
/** Bounds the poll loop; the connect page itself has no expiry we can read. */
export declare const CONNECT_TIMEOUT_MS: number;
export declare const CONNECT_POLL_MS = 3000;
/** The public key as ollama prints it: `ssh-ed25519 AAAA…` (authorized_keys, no comment). */
export declare function publicKeyLine(pair: CryptoKeyPair): Promise<string>;
/** ollama.com/connect?name=…&key=… — `key` is the line, base64url without padding. */
export declare function connectUrl(deviceName: string, keyLine: string): string;
/** The key segment of DELETE /api/user/keys/<key>, which un-pairs the device. */
export declare function encodedKey(keyLine: string): string;
/**
 * Sign one request: returns the Authorization header and sets `ts` on the
 * URL. The challenge covers method and path only, not the body or query.
 */
export declare function signRequest(pair: CryptoKeyPair, method: string, url: URL): Promise<Record<string, string>>;
/**
 * The account the key is paired with, or null while it is not. An unknown
 * key is not a 401 here: /api/me answers 200 with an all-zero user ID and
 * empty fields, so "paired" means a real ID.
 */
export declare function whoami(pair: CryptoKeyPair): Promise<{
    name: string;
} | null>;
/** Un-pair the device from the account. Best effort: the key is dropped locally either way. */
export declare function disconnect(pair: CryptoKeyPair): Promise<void>;
