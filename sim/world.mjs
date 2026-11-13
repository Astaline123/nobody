// The services around Nobody, written to behave as the real ones were observed to behave.
// Each mock carries the mainnet fact it copies, so a wrong assumption is easy to find.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Chain, near, tgas } from './chain.mjs';
import { nacl } from './open.mjs';
import { publicKeyText } from './tx.mjs';

export const USDC = 'usdc.sim';
export const INTENTS = 'intents.near';
export const OUTLAYER = 'outlayer.near';
export const COMPANY = 'hirenobody.near';
export const OWNER = 'owner.near';
export const CONTRIBUTORS = 'contributors.near';
export const VERSION = 'a'.repeat(64);
export const PROJECT = 'hirenobody.near/enclave';
export const DOLLAR = 1_000_000n;
// NEAR AI's staking contract and its "NEAR AI Cloud Credits" product, read from mainnet.
export const FARM = 'stake.dao';
export const FARM_PRODUCT = 'prod_33Kp14MGUJa2QA';
// The key OutLayer's keystore would derive for this project and this contract. Here it is a
// fixed test key, so a scenario can sign with it.
export const KEEPER_SEED = new Uint8Array(32).fill(9);

// Read from mainnet tx 94gPxbaXa8cs4noBg1XvRNZF84TSi1HDJ3G1UVziCCSg: 1Click delivered through
// `ft_transfer_call` with 278.2 Tgas, and 258.7 Tgas reached `ft_on_transfer`.
const DELIVERY_GAS = tgas(278.2);
const GAS_KEPT_BY_TOKEN = tgas(19.5);
const RESOLVE_GAS = tgas(15.5);

/** A NEP-141 token with USDC's behaviour: unregistered receivers make a transfer fail. */
export function makeToken(initial) {
  const balances = new Map(Object.entries(initial).map(([id, amount]) => [id, BigInt(amount)]));
  const registered = new Set(balances.keys());
  const move = (context, from, to, amount) => {
    if (context.deposit !== 1n) context.panic('Requires attached deposit of exactly 1 yoctoNEAR');
    if (!registered.has(to)) context.panic(`The account ${to} is not registered`);
    const held = balances.get(from) ?? 0n;
    if (held < amount) context.panic('The account does not have enough balance');
    balances.set(from, held - amount);
    balances.set(to, (balances.get(to) ?? 0n) + amount);
  };
  return {
    balances,
    register: (id) => registered.add(id),
    ft_balance_of: (context) => String(balances.get(context.args.account_id) ?? 0n),
    ft_transfer(context) {
      move(context, context.predecessor, context.args.receiver_id, BigInt(context.args.amount));
    },
    ft_transfer_call(context) {
      const { receiver_id: receiver, amount, msg } = context.args;
      move(context, context.predecessor, receiver, BigInt(amount));
      const onTransfer = context.call(
        receiver,
        'ft_on_transfer',
        { sender_id: context.predecessor, amount, msg },
        { gas: context.gas - GAS_KEPT_BY_TOKEN },
      );
      const resolve = context.then(
        onTransfer,
        context.current,
        'ft_resolve_transfer',
        { sender_id: context.predecessor, receiver_id: receiver, amount },
        { gas: RESOLVE_GAS },
      );
      context.returnPromise(resolve);
    },
    ft_resolve_transfer(context) {
      const { sender_id: sender, receiver_id: receiver, amount } = context.args;
      const sent = BigInt(amount);
      const [result] = context.results;
      let unused = sent;
      if (result.ok) {
        const text = new TextDecoder().decode(result.value);
        unused = BigInt(text ? JSON.parse(text) : 0);
      }
      const back = unused > sent ? sent : unused;
      if (back > 0n) {
        balances.set(receiver, (balances.get(receiver) ?? 0n) - back);
        balances.set(sender, (balances.get(sender) ?? 0n) + back);
        context.log(`Refund ${back} from ${receiver} to ${sender}`);
      }
      return String(sent - back);
    },
  };
}

/** The Intents verifier. What matters here is who owns a balance inside it. */
export function makeIntents(token) {
  const inside = new Map();
  return {
    inside,
    // `msg` names the owner. See docs.near-intents.org, "The msg parameter".
    ft_on_transfer(context) {
      const owner = context.args.msg || context.args.sender_id;
      inside.set(owner, (inside.get(owner) ?? 0n) + BigInt(context.args.amount));
      return '0';
    },
    /** What 1Click does once a swap settles. */
    deliver(context) {
      const { receiver_id: receiver, amount, msg } = context.args;
      context.call(USDC, 'ft_transfer_call', { receiver_id: receiver, amount, msg }, { deposit: 1n, gas: DELIVERY_GAS });
      void token;
    },
  };
}

/**
 * OutLayer's contract. A request yields until a worker answers. Real behaviour it keeps:
 * a request that omits any resource limit is ignored by workers and times out, and a failed
 * or timed-out run reaches the caller as a successful promise holding `null`.
 */
export function makeOutLayer(world) {
  const jobs = [];
  return {
    jobs,
    request_execution(context) {
      if (world.refuseRuns) context.panic('OutLayer refused the request');
      const { source, resource_limits: limits, input_data: input, payer_account_id: payer } = context.args;
      const job = {
        yield: context.defer(),
        version: source?.Project?.version_key,
        project: source?.Project?.project_id,
        limits,
        input: JSON.parse(input),
        format: context.args.response_format,
        payer: payer ?? context.signer,
        deposit: context.deposit,
        caller: context.predecessor,
        complete: Boolean(limits?.max_instructions && limits?.max_memory_mb && limits?.max_execution_seconds),
      };
      jobs.push(job);
      world.afterRequest?.(job);
    },
  };
}

/**
 * NEAR AI's staking contract (`stake.dao`), as its source and mainnet catalog describe it:
 * `stake` needs a registered account, at least 300 Tgas (EPOCH_SETTLEMENT_MIN_GAS) and at least
 * the farm price's 1 NEAR, and answers with the farm position. Registration needs 0.01 NEAR.
 */
export function makeFarm(world) {
  const storage = new Map();
  const positions = new Map();
  return {
    storage,
    positions,
    storage_deposit(context) {
      const account = context.args.account_id ?? context.predecessor;
      const total = (storage.get(account) ?? 0n) + context.deposit;
      if (total < near('0.01')) context.panic('The attached deposit is less than the minimum storage balance');
      storage.set(account, total);
      return { total: String(total), available: '0' };
    },
    stake(context) {
      if (world.farmRefuses) context.panic('Contract is paused');
      if (context.gas < tgas(300)) context.panic('Insufficient gas');
      if (!storage.has(context.predecessor)) context.panic('Account is not registered');
      if (context.args.product_id !== FARM_PRODUCT) context.panic('Product not found');
      if (context.deposit < near('1')) context.panic('Amount is below the price');
      const staked = (positions.get(context.predecessor) ?? 0n) + context.deposit;
      positions.set(context.predecessor, staked);
      return {
        account_id: context.predecessor,
        product_id: FARM_PRODUCT,
        price_id: 'price_QzmSvxbZqdbV0XbG6VD6KkbB',
        validator_id: 'nearai.pool.near',
        shares: String(staked),
        reward_debt: '0',
        accrued_reward_units: '0',
        status: 'Active',
      };
    },
    get_farm_position(context) {
      const staked = positions.get(context.args.account_id);
      return staked === undefined ? null : { staked_near_amount: String(staked), status: 'Active' };
    },
  };
}

/** Everything a scenario needs, with the real contract loaded. */
export function createWorld({ wasm, rules = {}, price = DOLLAR, near_balance = '6' } = {}) {
  const chain = new Chain();
  const code = wasm ?? readFileSync(new URL('../contract/res/nobody.wasm', import.meta.url));
  const world = { chain, store: new Map() };

  const token = makeToken({ [INTENTS]: 1_000n * DOLLAR, 'wallet.near': 100n * DOLLAR, 'stranger.near': 100n * DOLLAR });
  token.register(COMPANY);
  token.register(CONTRIBUTORS);
  token.register('alice.near');
  chain.addAccount(USDC, { native: token });

  const intents = makeIntents(token);
  chain.addAccount(INTENTS, { native: intents, balance: near('1') });
  const outlayer = makeOutLayer(world);
  chain.addAccount(OUTLAYER, { native: outlayer, balance: near('1') });
  const farm = makeFarm(world);
  chain.addAccount(FARM, { native: farm, balance: near('1') });
  for (const id of [OWNER, CONTRIBUTORS, 'wallet.near', 'stranger.near', 'alice.near']) {
    chain.addAccount(id, { balance: near('5') });
  }
  chain.addAccount(COMPANY, { wasm: code, balance: near(near_balance) });

  const config = {
    owner: OWNER,
    usdc: USDC,
    intents: INTENTS,
    outlayer: OUTLAYER,
    contributors: CONTRIBUTORS,
    project_id: PROJECT,
    version_key: VERSION,
    max_instructions: '30000000000',
    max_memory_mb: 256,
    max_execution_seconds: 120,
    farm: FARM,
    farm_product: FARM_PRODUCT,
  };
  const fullRules = {
    paused: false,
    min_price: String(DOLLAR),
    max_price: String(5n * DOLLAR),
    max_ai_per_day: String(5n * DOLLAR),
    ai_reserve_per_run: '50000',
    contributors_bps: 2000,
    referrer_bps: 1000,
    stake_bps: 1000,
    board_every: 0,
    run_deposit: String(near('0.05')),
    near_floor: String(near('0.5')),
    ai_stake_cap: String(near('2')),
    keep_liquid: String(near('2')),
    ...rules,
  };
  const init = chain.tx({
    signer: COMPANY,
    receiver: COMPANY,
    method: 'new',
    args: { config, rules: fullRules, price: String(price) },
  });
  if (!init.first.ok) throw new Error(`init failed: ${init.first.error}`);

  Object.assign(world, { token, intents, outlayer, farm, config, rules: fullRules });

  const keeperKeys = nacl().sign.keyPair.fromSeed(KEEPER_SEED);
  world.keeper = publicKeyText(keeperKeys.publicKey);

  /** What the enclave does with its keeper key: `buy_inference`, from the company's account. */
  world.keeperBuys = ({ gas = tgas(400), method = 'buy_inference', receiver = COMPANY, deposit = 0n } = {}) =>
    chain.signedTx({ signer: COMPANY, publicKey: world.keeper, receiver, method, gas, deposit });

  world.order = (extra = {}) =>
    JSON.stringify({ repo: 'near/near-sdk-rs', pk: 'ab'.repeat(32), refund: 'intents:0x2527d02599ba641c19fea793cd0f167589a0f10d', ...extra });

  /** A payment from another chain, as 1Click delivers it. */
  world.payFromAnyChain = (amount = DOLLAR, msg = world.order()) =>
    chain.tx({
      signer: INTENTS,
      receiver: INTENTS,
      method: 'deliver',
      args: { receiver_id: COMPANY, amount: String(amount), msg },
    });

  /** A payment from a NEAR wallet. */
  world.payFromWallet = (amount = DOLLAR, msg = world.order({ refund: undefined }), signer = 'wallet.near') =>
    chain.tx({
      signer,
      receiver: USDC,
      method: 'ft_transfer_call',
      args: { receiver_id: COMPANY, amount: String(amount), msg },
      deposit: 1n,
      gas: tgas(300),
    });

  /** Publishes a sealed report to public storage and answers, as the enclave would. */
  world.answerGood = (job, { board, ai = 6_300, keeper } = {}) => {
    const sealed = randomBytes(2400);
    world.store.set(`report:${job.input.order}`, sealed);
    const output = {
      v: 1,
      ok: true,
      order: job.input.order,
      sha256: createHash('sha256').update(sealed).digest('hex'),
      len: sealed.length,
      ai,
      ...(board ? { board } : {}),
      ...(keeper ? { keeper } : {}),
    };
    world.answer(job, JSON.stringify(output));
  };

  /** Returns a run's output to the contract and refunds the unused deposit, as OutLayer does. */
  world.answer = (job, text) => {
    const used = near('0.007');
    chain.accounts.get(OUTLAYER).balance -= job.deposit - used;
    chain.accounts.get(job.payer).balance += job.deposit - used;
    chain.resume(job.yield, new TextEncoder().encode(text));
  };

  world.status = () => chain.view(COMPANY, 'get_status');
  world.ledger = () => chain.view(COMPANY, 'get_ledger', { from: 0, limit: 100 });
  world.getOrder = (id) => chain.view(COMPANY, 'get_order', { order_id: id });
  world.usdc = (id) => token.balances.get(id) ?? 0n;
  world.owner = (method, args = {}, signer = OWNER) =>
    chain.tx({ signer, receiver: COMPANY, method, args, deposit: 1n });
  return world;
}
