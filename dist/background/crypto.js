/**
 * At-rest encryption for API keys.
 *
 * A per-install AES-GCM key is generated **non-extractable** and kept in the
 * background worker's IndexedDB (extension origin). Non-extractable means its
 * raw bytes can never be read back — not by us, not by anyone dumping
 * storage — so a `chrome.storage.local` dump yields only ciphertext, and
 * decryption requires executing code as the extension. This lives only in
 * the background worker; content scripts' IndexedDB is the host page's
 * origin, so they never touch it.
 *
 * The database name is configurable so a host extension migrating onto this
 * package can keep decrypting its existing blobs.
 */
const STORE = 'keys';
const KEY_ID = 'aes-key';
let dbName = 'ai-connect-crypto';
let cached;
/** Must be called before the first encrypt/decrypt if a custom name is used. */
export function configureCryptoDb(name) {
    if (name !== dbName) {
        dbName = name;
        cached = undefined;
    }
}
function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
function idbGet(db, key) {
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
function idbPut(db, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
async function getKey() {
    if (cached)
        return cached;
    cached = (async () => {
        const db = await openDb();
        const existing = await idbGet(db, KEY_ID);
        if (existing)
            return existing;
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
            'encrypt',
            'decrypt',
        ]);
        // CryptoKey objects are structured-cloneable; a non-extractable key
        // round-trips through IndexedDB without its bytes ever being exposed.
        await idbPut(db, KEY_ID, key);
        return key;
    })();
    return cached;
}
function idbDelete(db, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
/* ── device signing keys (Ollama Cloud) ───────────────────────────── */
const signingId = (id) => `ed25519:${id}`;
/**
 * Create and store an Ed25519 key pair under `id`. The private half is
 * **non-extractable**: it signs requests inside this worker and can never be
 * read back, so a paired device key cannot be copied out of the extension.
 * Needs WebCrypto Ed25519 (Chrome 137+).
 */
export async function createSigningKey(id) {
    let pair;
    try {
        pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
            'sign',
            'verify',
        ]));
    }
    catch {
        throw new Error('This browser cannot create Ed25519 keys (needs Chrome 137 or later).');
    }
    await idbPut(await openDb(), signingId(id), pair);
    return pair;
}
export async function getSigningKey(id) {
    return idbGet(await openDb(), signingId(id));
}
export async function deleteSigningKey(id) {
    await idbDelete(await openDb(), signingId(id));
}
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
export async function encryptString(plain) {
    if (!plain)
        return { iv: '', ct: '' };
    const key = await getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
    return { iv: toB64(iv.buffer), ct: toB64(ct) };
}
export async function decryptBlob(blob) {
    if (!blob || !blob.ct)
        return '';
    const key = await getKey();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
    return new TextDecoder().decode(plain);
}
