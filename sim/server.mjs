// The whole company on one laptop: the real shop page, the real contract on the simulated chain,
// and the real enclave under wasmtime. `npm run shop`, then open the address it prints.
// With no NEARAI_API_KEY the model is canned, and the report says so.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../scripts/rules.mjs';
import { drawTree } from './chain.mjs';
import { enclaveBuilt, keeperEnv, runEnclave, signAndSubmit, startModel } from './worker.mjs';
import { COMPANY, KEEPER_SEED, createWorld } from './world.mjs';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const PORT = Number(process.env.PORT ?? 8793);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

if (!enclaveBuilt()) {
  console.error('Build the enclave first: see the README.');
  process.exit(1);
}

const key = process.env.NEARAI_API_KEY;
const model = key ? null : await startModel();
const env = key ? { NEARAI_API_KEY: key } : { NEARAI_API_KEY: 'canned', NOBODY_LLM_URL: model.url };

// The company runs on the same config.yaml a human would apply on chain, with enough NEAR that
// some is spare above what it keeps for compute, so it has something to buy inference with.
const world = createWorld({ rules: loadRules(), near_balance: process.env.NEAR_BALANCE ?? '10' });
const { chain } = world;

async function work(job) {
  const mark = chain.trail.length;
  try {
    const output = JSON.parse(await runEnclave(job.input, { ...env, ...keeperEnv(chain, COMPANY, KEEPER_SEED) }));
    if (output.local_sealed_hex) {
      world.store.set(`report:${job.input.order}`, Buffer.from(output.local_sealed_hex, 'hex'));
      delete output.local_sealed_hex;
    }
    // On OutLayer the keystore signs and the transaction goes out during the run.
    if (output.local_keeper_tx) {
      try {
        const bought = signAndSubmit(chain, output.local_keeper_tx, KEEPER_SEED);
        console.log(`\nthe enclave's keeper bought inference:\n${drawTree(bought.receipts)}`);
      } catch (error) {
        console.error(`the keeper's transaction was refused: ${error.message}`);
      }
      delete output.local_keeper_tx;
    }
    world.answer(job, JSON.stringify(output));
  } catch (error) {
    console.error(`order ${job.input.order} failed: ${error.message}`);
    world.answer(job, 'null');
  }
  console.log(`\norder ${job.input.order}, after the enclave answered:\n${drawTree(chain.trail.slice(mark))}`);
}

// The chain must finish the current receipt before the enclave starts.
world.afterRequest = (job) => setImmediate(() => work(job));

function rpc(body) {
  const { account_id: account, method_name: method, args_base64: args } = body.params;
  const value = chain.view(account, method, JSON.parse(Buffer.from(args, 'base64').toString() || '{}'));
  return { jsonrpc: '2.0', id: body.id, result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: Number(chain.height) } };
}

function readBody(request) {
  return new Promise((resolve) => {
    const parts = [];
    request.on('data', (part) => parts.push(part));
    request.on('end', () => resolve(Buffer.concat(parts).toString()));
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const send = (status, body, type = 'application/json') => {
    response.writeHead(status, { 'content-type': type });
    response.end(body);
  };
  try {
    if (request.method === 'POST' && url.pathname === '/rpc') {
      return send(200, JSON.stringify(rpc(JSON.parse(await readBody(request)))));
    }
    if (request.method === 'POST' && url.pathname === '/sim/pay') {
      const { amount, msg } = JSON.parse(await readBody(request));
      const paid = world.payFromAnyChain(BigInt(amount), msg);
      console.log(`\na payment arrived:\n${drawTree(paid.receipts)}`);
      return send(200, '{}');
    }
    if (url.pathname === '/sim/trail') {
      const trail = chain.trail.map(({ id, parent, predecessor, receiver, method, gas, ok }) => ({ id, parent, predecessor, receiver, method, gas: String(gas), ok }));
      return send(200, JSON.stringify(trail));
    }
    if (url.pathname === '/public/storage/get') {
      const sealed = world.store.get(url.searchParams.get('key'));
      return sealed ? send(200, sealed, 'application/octet-stream') : send(404, '{}');
    }
    const path = normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (path.startsWith('..')) return send(404, 'not found', 'text/plain');
    return send(200, await readFile(join(WEB, path)), TYPES[extname(path)] ?? 'application/octet-stream');
  } catch (error) {
    return send(error.code === 'ENOENT' ? 404 : 500, String(error.message), 'text/plain');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Nobody is open at http://127.0.0.1:${PORT}`);
  console.log(`Contract ${COMPANY} on a simulated chain. Model: ${key ? 'NEAR AI Cloud' : 'canned, no key set'}.`);
});
