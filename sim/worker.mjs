// Runs the real enclave wasm on this machine, under the same wasmtime release as OutLayer's
// worker, and plays the model when no real key is given. Only the host differs: there is no TEE
// here and no public storage, so the sealed report comes back in the output instead.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nacl } from './open.mjs';
import { base58 } from './tx.mjs';

// The local build. The production build calls OutLayer's storage, which plain wasmtime lacks.
const WASM = fileURLToPath(new URL('../enclave/res/nobody-enclave.local.wasm', import.meta.url));

function wasmtime() {
  const local = join(homedir(), 'dev-tools', 'wasmtime', process.platform === 'win32' ? 'wasmtime.exe' : 'wasmtime');
  return process.env.WASMTIME ?? (existsSync(local) ? local : 'wasmtime');
}

export const enclaveBuilt = () => existsSync(WASM);

/**
 * A stand-in for the model, so the whole path runs with no key. It reads the rule results it
 * was given and answers in the shape the real model must use. Its text is plainly labelled, so
 * a canned reply can never be mistaken for a real review.
 */
function cannedReply(request) {
  const system = request.messages[0].content;
  const user = request.messages[1].content;
  if (system.includes('You set the price')) {
    const price = Number(user.match(/Current price: (\d+)/)?.[1] ?? 1_000_000);
    return JSON.stringify({ price: Math.round(price * 1.25), note: 'Canned model: demand looks steady, so nudge the price up.' });
  }
  // The canned model judges nothing, so every candidate stays unreviewed in the report.
  const candidates = [...user.matchAll(/^\d+\. \[/gm)].length;
  return JSON.stringify({
    verdict: `Canned model, not a real review. The static rules found ${candidates} candidate${candidates === 1 ? '' : 's'}, and none were judged. Set NEARAI_API_KEY for a real review.`,
    candidates: [],
    findings: [],
    good: [],
  });
}

/** A local OpenAI-style endpoint. Bodies arrive chunked, the same way the enclave sends them. */
export function startModel() {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const parts = [];
      request.on('data', (part) => parts.push(part));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(parts).toString());
        const content = cannedReply(body);
        const prompt = Math.ceil(JSON.stringify(body.messages).length / 4);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          id: `chatcmpl-canned-${Date.now()}`,
          choices: [{ message: { role: 'assistant', content } }],
          usage: { prompt_tokens: prompt, completion_tokens: Math.ceil(content.length / 4) },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }));
  });
}

/**
 * What OutLayer's worker would give the keeper in a run the company started: the calling
 * contract, and the answers its keystore and RPC proxy would give. The access key is read from
 * the simulated chain, so a key the contract has not adopted gets no answer, as on a real node.
 */
export function keeperEnv(chain, account, seed) {
  const keys = nacl().sign.keyPair.fromSeed(seed);
  const publicKey = `ed25519:${base58(keys.publicKey)}`;
  const env = { NEAR_PREDECESSOR_ID: account, NOBODY_LOCAL_KEEPER: Buffer.from(keys.publicKey).toString('hex') };
  const key = chain.keysOf(account).get(publicKey);
  if (key && !key.full) {
    const blockHash = createHash('sha256').update(String(chain.height)).digest();
    env.NOBODY_LOCAL_ACCESS_KEY = JSON.stringify({
      block_hash: base58(blockHash),
      block_height: Number(chain.height),
      nonce: Number(key.nonce),
      permission: { FunctionCall: { allowance: String(key.allowance), method_names: key.methods, receiver_id: key.receiver } },
    });
  }
  return env;
}

/**
 * Plays OutLayer's keystore for a local run: signs the transaction the enclave built with the
 * keeper key, then submits it to the simulated chain, which checks the signature, the nonce and
 * the key's permission the way a node would.
 */
export function signAndSubmit(chain, unsignedHex, seed) {
  const keys = nacl().sign.keyPair.fromSeed(seed);
  const bytes = Buffer.from(unsignedHex, 'hex');
  const signature = nacl().sign.detached(createHash('sha256').update(bytes).digest(), keys.secretKey);
  return chain.submit(Buffer.concat([bytes, Buffer.from([0]), Buffer.from(signature)]).toString('base64'));
}

/** Runs one job and returns the enclave's stdout. `env` becomes the guest's environment. */
export function runEnclave(input, env) {
  return new Promise((resolve, reject) => {
    const flags = Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
    const child = spawn(wasmtime(), ['run', '-S', 'http', '-S', 'cli', ...flags, WASM], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (part) => (out += part));
    child.stderr.on('data', (part) => (err += part));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`enclave exited ${code}: ${err.slice(0, 600)}`))));
    child.stdin.end(JSON.stringify(input));
  });
}
