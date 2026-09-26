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

export const OLLAMA_BASE = 'https://ollama.com';
/** Bounds the poll loop; the connect page itself has no expiry we can read. */
export const CONNECT_TIMEOUT_MS = 15 * 60 * 1000;
export const CONNECT_POLL_MS = 3000;

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const b64url = (s: string): string =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** SSH wire format: string("ssh-ed25519") + string(32-byte public key). */
function sshWire(raw: Uint8Array): Uint8Array {
  const type = new TextEncoder().encode('ssh-ed25519');
  const out = new Uint8Array(4 + type.length + 4 + raw.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, type.length);
  out.set(type, 4);
  view.setUint32(4 + type.length, raw.length);
  out.set(raw, 8 + type.length);
  return out;
}

/** The public key as ollama prints it: `ssh-ed25519 AAAA…` (authorized_keys, no comment). */
export async function publicKeyLine(pair: CryptoKeyPair): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return `ssh-ed25519 ${b64(sshWire(raw))}`;
}

/** ollama.com/connect?name=…&key=… — `key` is the line, base64url without padding. */
export function connectUrl(deviceName: string, keyLine: string): string {
  return `${OLLAMA_BASE}/connect?name=${encodeURIComponent(deviceName)}&key=${b64url(keyLine)}`;
}

/** The key segment of DELETE /api/user/keys/<key>, which un-pairs the device. */
export function encodedKey(keyLine: string): string {
  return b64url(keyLine);
}

/**
 * Sign one request: returns the Authorization header and sets `ts` on the
 * URL. The challenge covers method and path only, not the body or query.
 */
export async function signRequest(
  pair: CryptoKeyPair,
  method: string,
  url: URL,
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const challenge = new TextEncoder().encode(`${method.toUpperCase()},${url.pathname}?ts=${ts}`);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, challenge),
  );
  url.searchParams.set('ts', ts);
  const wire = (await publicKeyLine(pair)).split(' ')[1] ?? '';
  return { Authorization: `${wire}:${b64(signature)}` };
}

const NO_USER = '00000000-0000-0000-0000-000000000000';

/**
 * The account the key is paired with, or null while it is not. An unknown
 * key is not a 401 here: /api/me answers 200 with an all-zero user ID and
 * empty fields, so "paired" means a real ID.
 */
export async function whoami(pair: CryptoKeyPair): Promise<{ name: string } | null> {
  const url = new URL('/api/me', OLLAMA_BASE);
  const res = await fetch(url, { method: 'POST', headers: await signRequest(pair, 'POST', url) });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`Ollama sign-in check failed (${res.status}): ${await res.text()}`);
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof j.ID === 'string' ? j.ID : '';
  if (!id || id === NO_USER) return null;
  return { name: typeof j.Name === 'string' ? j.Name : '' };
}

/** Un-pair the device from the account. Best effort: the key is dropped locally either way. */
export async function disconnect(pair: CryptoKeyPair): Promise<void> {
  const url = new URL(`/api/user/keys/${encodedKey(await publicKeyLine(pair))}`, OLLAMA_BASE);
  await fetch(url, { method: 'DELETE', headers: await signRequest(pair, 'DELETE', url) });
}
