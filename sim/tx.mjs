// NEAR transactions in their wire format, so the simulator can check a transaction the enclave
// signed exactly as a node would: borsh bytes, a sha256 hash, and an ed25519 signature over it.
import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function fromBase58(text) {
  let value = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`not base58: ${char}`);
    value = value * 58n + BigInt(digit);
  }
  const bytes = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** `ed25519:<base58>`, the way NEAR writes a public key. */
export const publicKeyText = (bytes) => `ed25519:${base58(bytes)}`;

export function publicKeyBytes(text) {
  const [curve, body] = text.split(':');
  if (curve !== 'ed25519') throw new Error(`unsupported key type ${curve}`);
  const bytes = fromBase58(body);
  if (bytes.length !== 32) throw new Error('an ed25519 key is 32 bytes');
  return bytes;
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.at = 0;
  }
  take(length) {
    if (this.at + length > this.bytes.length) throw new Error('transaction ends early');
    const part = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return part;
  }
  u8() {
    return this.take(1)[0];
  }
  u32() {
    return Buffer.from(this.take(4)).readUInt32LE(0);
  }
  u64() {
    return Buffer.from(this.take(8)).readBigUInt64LE(0);
  }
  u128() {
    const part = this.take(16);
    let value = 0n;
    for (let i = 15; i >= 0; i -= 1) value = (value << 8n) | BigInt(part[i]);
    return value;
  }
  string() {
    return new TextDecoder().decode(this.take(this.u32()));
  }
}

const FUNCTION_CALL = 2;

/**
 * Reads a borsh `SignedTransaction` (a version 0 transaction) whose only action is a function
 * call. Anything else is refused, because nothing else is expected from the enclave.
 */
export function decodeSignedTransaction(bytes) {
  const reader = new Reader(bytes);
  const signer = reader.string();
  if (reader.u8() !== 0) throw new Error('only ed25519 keys are expected');
  const publicKey = reader.take(32);
  const nonce = reader.u64();
  const receiver = reader.string();
  const blockHash = reader.take(32);
  const count = reader.u32();
  if (count !== 1) throw new Error(`expected one action, found ${count}`);
  if (reader.u8() !== FUNCTION_CALL) throw new Error('expected a function call');
  const method = reader.string();
  const args = reader.take(reader.u32());
  const gas = reader.u64();
  const deposit = reader.u128();
  const signed = reader.at;
  if (reader.u8() !== 0) throw new Error('only ed25519 signatures are expected');
  const signature = reader.take(64);
  if (reader.at !== bytes.length) throw new Error('bytes after the signature');
  const hash = createHash('sha256').update(bytes.subarray(0, signed)).digest();
  return { signer, publicKey, nonce, receiver, blockHash, method, args, gas, deposit, signature, hash };
}

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function u64(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function u128(value) {
  const out = Buffer.alloc(16);
  let rest = BigInt(value);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

const text = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
};

const bytesField = (value) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
};

const key = (publicKey) => Buffer.concat([Buffer.from([0]), Buffer.from(publicKey)]);

/**
 * One action in borsh. The kinds Nobody's scripts use:
 * `{ createAccount: true }`, `{ deploy: code }`, `{ call: { method, args, gas, deposit } }`,
 * `{ transfer: amount }`, `{ addKey: { publicKey, full: true } }` or
 * `{ addKey: { publicKey, allowance, receiver, methods } }`, and `{ deleteKey: publicKey }`.
 */
export function encodeAction(action) {
  if (action.createAccount) return Buffer.from([0]);
  if (action.deploy) return Buffer.concat([Buffer.from([1]), bytesField(action.deploy)]);
  if (action.call) {
    const { method, args = '{}', gas, deposit = 0n } = action.call;
    return Buffer.concat([Buffer.from([FUNCTION_CALL]), text(method), bytesField(args), u64(gas), u128(deposit)]);
  }
  if (action.transfer !== undefined) return Buffer.concat([Buffer.from([3]), u128(action.transfer)]);
  if (action.addKey) {
    const { publicKey, full, allowance, receiver, methods = [] } = action.addKey;
    const permission = full
      ? Buffer.from([1])
      : Buffer.concat([
          Buffer.from([0]),
          allowance === undefined || allowance === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), u128(allowance)]),
          text(receiver),
          u32(methods.length),
          ...methods.map(text),
        ]);
    return Buffer.concat([Buffer.from([5]), key(publicKey), u64(0), permission]);
  }
  if (action.deleteKey) return Buffer.concat([Buffer.from([6]), key(action.deleteKey)]);
  throw new Error(`unknown action ${JSON.stringify(Object.keys(action))}`);
}

/** The borsh bytes of a version 0 transaction: what gets hashed and signed. */
export function encodeActions({ signer, publicKey, nonce, receiver, blockHash, actions }) {
  return Buffer.concat([
    text(signer),
    key(publicKey),
    u64(nonce),
    text(receiver),
    Buffer.from(blockHash),
    u32(actions.length),
    ...actions.map(encodeAction),
  ]);
}

/** The borsh bytes of a version 0 transaction with one function call: what gets hashed. */
export function encodeTransaction({ signer, publicKey, nonce, receiver, blockHash, method, args, gas, deposit = 0n }) {
  return encodeActions({ signer, publicKey, nonce, receiver, blockHash, actions: [{ call: { method, args, gas, deposit } }] });
}
