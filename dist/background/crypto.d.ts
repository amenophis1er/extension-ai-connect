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
export interface EncBlob {
    /** base64 12-byte IV */
    iv: string;
    /** base64 ciphertext */
    ct: string;
}
/** Must be called before the first encrypt/decrypt if a custom name is used. */
export declare function configureCryptoDb(name: string): void;
export declare function encryptString(plain: string): Promise<EncBlob>;
export declare function decryptBlob(blob: EncBlob | null | undefined): Promise<string>;
