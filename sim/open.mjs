// Opens a sealed report with the same library and format the shop page uses.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

let loaded;

/**
 * Loads the vendored tweetnacl the page ships with, so tests cover the real bytes. It runs in
 * this realm on purpose: tweetnacl checks `instanceof Uint8Array`, which fails across realms.
 */
export function nacl() {
  if (loaded) return loaded;
  const source = readFileSync(new URL('../web/vendor/nacl-fast.min.js', import.meta.url), 'utf8');
  const module = { exports: {} };
  new Function('module', 'exports', 'require', source)(module, module.exports, () => crypto);
  loaded = module.exports;
  return loaded;
}

/** The sealed format: one-time public key, then nonce, then ciphertext. */
export function open(sealed, secretKey) {
  const bytes = new Uint8Array(sealed);
  const plain = nacl().box.open(bytes.subarray(56), bytes.subarray(32, 56), bytes.subarray(0, 32), secretKey);
  if (!plain) throw new Error('the report does not open with this key');
  return JSON.parse(new TextDecoder().decode(plain));
}
