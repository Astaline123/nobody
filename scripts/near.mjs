// A small NEAR client with no dependencies: views, signed transactions and key files. The
// encoder in sim/tx.mjs writes the same bytes as NEAR's own @near-js/transactions.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nacl } from '../sim/open.mjs';
import { base58, encodeActions, fromBase58 } from '../sim/tx.mjs';

export const TGAS = 1_000_000_000_000n;
export const NEAR = 10n ** 24n;

const RPC = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com',
};

export const explorer = (network, hash) =>
  `https://${network === 'mainnet' ? '' : 'testnet.'}nearblocks.io/txns/${hash}`;

/** NEAR amounts for people: yocto to "1.234". */
export const nearText = (yocto, digits = 3) => (Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(digits);

/** "1.5" NEAR to yocto, without floats. */
export function toYocto(amount) {
  const [whole, fraction = ''] = String(amount).split('.');
  return BigInt(whole + fraction.padEnd(24, '0').slice(0, 24));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A key pair, from a near CLI key file's `ed25519:<base58 of 64 bytes>`. */
export function keyFromSecret(secret) {
  const bytes = fromBase58(secret.replace(/^ed25519:/, ''));
  const pair = bytes.length === 64 ? nacl().sign.keyPair.fromSecretKey(bytes) : nacl().sign.keyPair.fromSeed(bytes);
  return { publicKey: pair.publicKey, secretKey: pair.secretKey, text: `ed25519:${base58(pair.publicKey)}` };
}

export function newKey() {
  const pair = nacl().sign.keyPair();
  return { publicKey: pair.publicKey, secretKey: pair.secretKey, text: `ed25519:${base58(pair.publicKey)}` };
}

const keyFile = (network, account) => join(homedir(), '.near-credentials', network, `${account}.json`);

/** Reads a key the near CLI saved with `save-to-legacy-keychain`, or one passed in the environment. */
export function loadKey(network, account, envName) {
  if (envName && process.env[envName]) return keyFromSecret(process.env[envName]);
  const path = keyFile(network, account);
  if (!existsSync(path)) throw new Error(`No key for ${account}. Set ${envName ?? 'a key variable'} or save one at ${path}.`);
  return keyFromSecret(JSON.parse(readFileSync(path, 'utf8')).private_key);
}

/** Saves a key where the near CLI keeps them, outside the repo, before the account exists. */
export function saveKey(network, account, key) {
  const path = keyFile(network, account);
  mkdirSync(join(homedir(), '.near-credentials', network), { recursive: true });
  writeFileSync(path, JSON.stringify({ account_id: account, public_key: key.text, private_key: `ed25519:${base58(key.secretKey)}` }));
  return path;
}

export function client(network = 'testnet') {
  const url = process.env.NEAR_RPC ?? RPC[network];

  async function rpc(method, params) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'nobody', method, params }),
      });
      // Public nodes answer bursts with 429. Waiting is the fix, and it is not an error.
      if ((response.status === 429 || response.status >= 500) && attempt < 6) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const body = await response.json();
      if (body.error) {
        const error = new Error(JSON.stringify(body.error.data ?? body.error.cause ?? body.error).slice(0, 600));
        error.rpc = body.error;
        throw error;
      }
      return body.result;
    }
  }

  async function view(contract, method, args = {}) {
    const result = await rpc('query', {
      request_type: 'call_function',
      finality: 'optimistic',
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    const text = Buffer.from(result.result).toString();
    return text ? JSON.parse(text) : null;
  }

  async function account(id) {
    try {
      return await rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: id });
    } catch (error) {
      if (/UNKNOWN_ACCOUNT|does not exist/.test(error.message)) return null;
      throw error;
    }
  }

  async function keys(id) {
    return (await rpc('query', { request_type: 'view_access_key_list', finality: 'optimistic', account_id: id })).keys;
  }

  /**
   * Signs and sends one transaction and waits until it has run. Throws with the reason when
   * any receipt of it failed, unless `allowFailure` is set. A payment that starts enclave work
   * never "finishes" while OutLayer works, so it waits only for `INCLUDED_FINAL`.
   */
  async function send(signer, key, receiver, actions, { allowFailure = false, wait = 'EXECUTED_OPTIMISTIC' } = {}) {
    const access = await rpc('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: signer, public_key: key.text });
    const bytes = encodeActions({
      signer,
      publicKey: key.publicKey,
      nonce: BigInt(access.nonce) + 1n,
      receiver,
      blockHash: fromBase58(access.block_hash),
      actions,
    });
    const hash = createHash('sha256').update(bytes).digest();
    const signature = nacl().sign.detached(new Uint8Array(hash), key.secretKey);
    const signed = Buffer.concat([bytes, Buffer.from([0]), Buffer.from(signature)]).toString('base64');
    const outcome = await rpc('send_tx', { signed_tx_base64: signed, wait_until: wait });
    const txHash = base58(hash);
    const failures = [outcome.transaction_outcome, ...(outcome.receipts_outcome ?? [])]
      .filter(Boolean)
      .map((item) => item.outcome.status)
      .filter((status) => status.Failure)
      .map((status) => JSON.stringify(status.Failure).slice(0, 400));
    if (failures.length && !allowFailure) {
      const error = new Error(`transaction ${txHash} failed: ${failures[0]}`);
      error.hash = txHash;
      throw error;
    }
    const value = outcome.status?.SuccessValue;
    let returned = null;
    if (value) {
      try {
        returned = JSON.parse(Buffer.from(value, 'base64').toString());
      } catch {
        returned = Buffer.from(value, 'base64').toString();
      }
    }
    const logs = (outcome.receipts_outcome ?? []).flatMap((item) => item.outcome.logs);
    return { hash: txHash, returned, failures, logs, outcome };
  }

  const call = (signer, key, receiver, method, args = {}, { gas = 100n * TGAS, deposit = 0n, allowFailure, wait } = {}) =>
    send(signer, key, receiver, [{ call: { method, args: JSON.stringify(args), gas, deposit } }], { allowFailure, wait });

  return { network: url, rpc, view, account, keys, send, call };
}
