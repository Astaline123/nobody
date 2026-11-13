// Runs the real compiled contract. `npm test` needs only Node.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { loadRules, parseConfig, toRules } from '../scripts/rules.mjs';
import { near, tgas } from './chain.mjs';
import { nacl } from './open.mjs';
import { encodeTransaction, publicKeyText } from './tx.mjs';
import { COMPANY, CONTRIBUTORS, DOLLAR, FARM, INTENTS, KEEPER_SEED, OWNER, USDC, VERSION, createWorld } from './world.mjs';

const BUYER_ON_BASE = '0x2527d02599ba641c19fea793cd0f167589a0f10d';

const lastJob = (world) => world.outlayer.jobs.at(-1);
const kinds = (world) => world.ledger().map((entry) => entry.kind);
const failed = (result) => result.receipts.filter((receipt) => !receipt.ok);
const find = (result, method) => result.receipts.find((receipt) => receipt.method === method);
const logsOf = (result) => result.receipts.flatMap((receipt) => receipt.logs).join('\n');

describe('a sale from another chain', () => {
  it('wakes the company with a payment alone, and nothing fails', () => {
    const world = createWorld();
    const paid = world.payFromAnyChain();
    assert.deepEqual(failed(paid), []);
    assert.equal(world.outlayer.jobs.length, 1, 'the payment itself started the work');
    assert.equal(world.getOrder(1).status, 'Running');
  });

  it('fits inside the gas a real 1Click delivery brings', () => {
    const world = createWorld();
    const paid = world.payFromAnyChain();
    assert.equal(find(paid, 'ft_on_transfer').gas, tgas(258.7));
    assert.ok(find(paid, 'request_execution').gas >= tgas(100), 'OutLayer gets its minimum');
  });

  it('the token transfer is final before the work starts', () => {
    const world = createWorld();
    const paid = world.payFromAnyChain();
    assert.ok(paid.receipts.some((receipt) => receipt.method === 'ft_resolve_transfer' && receipt.ok));
    assert.equal(world.usdc(COMPANY), DOLLAR);
    assert.equal(world.usdc(INTENTS), 999n * DOLLAR);
  });

  it('asks OutLayer the way workers require', () => {
    const world = createWorld();
    world.payFromAnyChain();
    const job = lastJob(world);
    assert.ok(job.complete, 'all three limits are sent, or workers ignore the job');
    assert.equal(job.version, VERSION, 'the exact enclave build is pinned');
    assert.equal(job.format, 'Json');
    assert.equal(job.payer, COMPANY, 'unused compute money returns to the company');
    assert.deepEqual(job.input, {
      v: 2,
      order: 1,
      repo: 'near/near-sdk-rs',
      pk: 'ab'.repeat(32),
    });
  });

  it('settles a delivered order and shares the money by the rules', () => {
    const world = createWorld();
    world.payFromAnyChain();
    world.answerGood(lastJob(world));
    const order = world.getOrder(1);
    assert.equal(order.status, 'Delivered');
    assert.equal(order.report_sha256.length, 64);
    assert.equal(world.usdc(CONTRIBUTORS), 200_000n);
    assert.equal(world.usdc(COMPANY), 800_000n);
    const status = world.status();
    assert.equal(status.gross, '1000000');
    assert.equal(status.treasury, '700000', 'no referrer, so that share stays here');
    assert.equal(status.stake_pool, '100000');
    assert.equal(status.paid_out, '200000');
    assert.equal(status.customers, '1');
  });

  it('writes every sale, cost and payout to the public ledger', () => {
    const world = createWorld();
    world.payFromAnyChain();
    world.answerGood(lastJob(world));
    assert.deepEqual(kinds(world), ['ComputeCost', 'Sale', 'AiCost', 'Payout']);
    const [, sale, ai, payout] = world.ledger();
    assert.equal(sale.amount, '1000000');
    assert.equal(ai.amount, '6300');
    assert.equal(payout.to, CONTRIBUTORS);
  });

  it('gets back the compute money OutLayer did not use', () => {
    const world = createWorld();
    const before = world.chain.balance(COMPANY);
    world.payFromAnyChain();
    world.answerGood(lastJob(world));
    assert.equal(before - world.chain.balance(COMPANY) > 0n, true);
    assert.ok(before - world.chain.balance(COMPANY) < near('0.01'), 'only the used part is spent');
  });
});

describe('when the work fails, the buyer is refunded', () => {
  const outcomes = {
    'a timed-out run, which arrives as null': 'null',
    'output that is not JSON': 'the model wandered off',
    'an empty object': '{}',
    'a run that reports failure': JSON.stringify({ v: 1, ok: false, order: 1 }),
    'an answer for another order': JSON.stringify({ v: 1, ok: true, order: 99, sha256: 'ab'.repeat(32), len: 100, ai: 1 }),
    'a broken digest': JSON.stringify({ v: 1, ok: true, order: 1, sha256: 'xyz', len: 100, ai: 1 }),
    'an empty report': JSON.stringify({ v: 1, ok: true, order: 1, sha256: 'ab'.repeat(32), len: 0, ai: 1 }),
    'a claimed report that is absurdly large': JSON.stringify({ v: 1, ok: true, order: 1, sha256: 'ab'.repeat(32), len: 900000, ai: 1 }),
    'a wrong protocol version': JSON.stringify({ v: 2, ok: true, order: 1, sha256: 'ab'.repeat(32), len: 100, ai: 1 }),
  };
  for (const [name, output] of Object.entries(outcomes)) {
    it(name, () => {
      const world = createWorld();
      world.payFromAnyChain();
      world.answer(lastJob(world), output);
      const order = world.getOrder(1);
      assert.equal(order.status, 'Refunded');
      assert.equal(world.intents.inside.get(BUYER_ON_BASE), DOLLAR, 'the buyer owns it inside Intents');
      assert.equal(world.status().gross, '0', 'a refund is not revenue');
      assert.equal(world.usdc(CONTRIBUTORS), 0n);
    });
  }

  it('when OutLayer refuses the job outright', () => {
    const world = createWorld();
    world.refuseRuns = true;
    const paid = world.payFromAnyChain();
    assert.equal(world.getOrder(1).status, 'Refunded');
    assert.equal(world.intents.inside.get(BUYER_ON_BASE), DOLLAR);
    assert.equal(failed(paid).map((receipt) => receipt.method).join(), 'request_execution');
    assert.equal(world.chain.balance(COMPANY) >= near('5.5'), true, 'the failed run returned its deposit');
  });

  it('a NEAR wallet buyer gets it back in their wallet', () => {
    const world = createWorld();
    world.payFromWallet();
    assert.equal(world.usdc('wallet.near'), 99n * DOLLAR);
    world.answer(lastJob(world), 'null');
    assert.equal(world.usdc('wallet.near'), 100n * DOLLAR);
  });

  it('anyone can rescue a run that never came back, but not too early', () => {
    const world = createWorld();
    world.payFromAnyChain();
    const early = world.chain.tx({ signer: 'stranger.near', receiver: COMPANY, method: 'expire', args: { order_id: 1 } });
    assert.match(early.first.error, /within its time limit/);
    world.chain.advance(16 * 60 * 1000);
    const late = world.chain.tx({ signer: 'stranger.near', receiver: COMPANY, method: 'expire', args: { order_id: 1 } });
    assert.ok(late.first.ok);
    assert.equal(world.getOrder(1).status, 'Refunded');
  });

  it('a very late answer after a rescue cannot charge the buyer twice', () => {
    const world = createWorld();
    world.payFromAnyChain();
    const job = lastJob(world);
    world.chain.advance(16 * 60 * 1000);
    world.chain.tx({ signer: 'stranger.near', receiver: COMPANY, method: 'expire', args: { order_id: 1 } });
    world.answerGood(job);
    assert.equal(world.getOrder(1).status, 'Refunded');
    assert.equal(world.status().gross, '0');
    assert.equal(world.intents.inside.get(BUYER_ON_BASE), DOLLAR);
  });

  it('a refund that fails can be sent again by anyone', () => {
    const world = createWorld();
    const msg = world.order({ refund: 'near:carol.near' });
    world.payFromAnyChain(DOLLAR, msg);
    world.answer(lastJob(world), 'null');
    assert.equal(world.getOrder(1).status, 'RefundFailed', 'carol has no USDC storage yet');
    world.token.register('carol.near');
    const again = world.chain.tx({ signer: 'stranger.near', receiver: COMPANY, method: 'retry_refund', args: { order_id: 1 } });
    assert.deepEqual(failed(again), []);
    assert.equal(world.getOrder(1).status, 'Refunded');
    assert.equal(world.usdc('carol.near'), DOLLAR);
  });
});

describe('the company turns work away cleanly', () => {
  const refused = (world, reason) => {
    const entry = world.ledger().find((item) => item.kind === 'Refused');
    assert.match(entry.note, reason);
    assert.equal(world.outlayer.jobs.length, 0, 'no compute was spent');
    // The USDC is back at intents.near, and this is what makes it the buyer's and not 1Click's.
    assert.equal(world.intents.inside.get(BUYER_ON_BASE), DOLLAR, 'the buyer owns it inside Intents');
    assert.equal(world.usdc(COMPANY), 0n);
    assert.equal(world.getOrder(1).status, 'Refunded');
    assert.deepEqual(world.ledger().map((item) => item.kind).slice(-2), ['Refused', 'Refund']);
  };

  it('with the kill switch on', () => {
    const world = createWorld();
    world.owner('pause', { reason: 'taking a look' });
    world.payFromAnyChain();
    refused(world, /taking a look/);
  });

  it('when the payment is short', () => {
    const world = createWorld();
    world.payFromAnyChain(DOLLAR / 2n);
    assert.equal(world.outlayer.jobs.length, 0);
    assert.equal(world.intents.inside.get(BUYER_ON_BASE), DOLLAR / 2n);
    assert.match(world.ledger().at(-1).note, /below the price/);
  });

  it('allows the small gap a swap can leave', () => {
    const world = createWorld();
    world.payFromAnyChain(999_798n);
    assert.equal(world.outlayer.jobs.length, 1, 'a real 1Click delivery gave 999798 for a $1 payment');
  });

  for (const [name, order, reason] of [
    ['a URL instead of owner/name', { repo: 'https://evil.example/x' }, /owner\/name/],
    ['a path that climbs out of the repo', { repo: 'near/..' }, /owner\/name/],
    ['a bad public key', { pk: 'xyz' }, /64 hex/],
  ]) {
    it(`when it asks for ${name}`, () => {
      const world = createWorld();
      world.payFromAnyChain(DOLLAR, world.order(order));
      refused(world, reason);
    });
  }

  it('when the order cannot be read, but it still names no one to refund', () => {
    const world = createWorld();
    const paid = world.payFromAnyChain(DOLLAR, 'not json');
    assert.deepEqual(failed(paid), []);
    assert.equal(world.usdc(INTENTS), 1_000n * DOLLAR, 'the only safe move is to hand it back');
  });

  it('hands a wallet its money straight back', () => {
    const world = createWorld();
    world.owner('pause', {});
    world.payFromWallet();
    assert.equal(world.usdc('wallet.near'), 100n * DOLLAR);
    assert.equal(world.status().orders, '0');
  });

  it('when free NEAR for compute has run out', () => {
    // The contract's own code and state need about 2.4 NEAR of storage.
    const world = createWorld({ near_balance: '2.8' });
    assert.equal(world.status().open, false);
    assert.match(world.status().closed_because, /NEAR/);
    world.payFromAnyChain();
    refused(world, /NEAR/);
  });

  it('when a caller brings too little gas', () => {
    const world = createWorld();
    const result = world.chain.tx({
      signer: 'wallet.near',
      receiver: USDC,
      method: 'ft_transfer_call',
      args: { receiver_id: COMPANY, amount: String(DOLLAR), msg: world.order({ refund: undefined }) },
      deposit: 1n,
      gas: tgas(150),
    });
    assert.deepEqual(failed(result), []);
    assert.equal(world.usdc('wallet.near'), 100n * DOLLAR);
    assert.match(logsOf(result), /not enough gas/);
  });

  it('a loop of refused wallet payments costs the company no storage', () => {
    const world = createWorld();
    world.owner('pause', {});
    const account = world.chain.accounts.get(COMPANY);
    const before = world.chain.storageBytes(account);
    for (let i = 0; i < 25; i += 1) world.payFromWallet(1n, world.order({ refund: undefined }));
    assert.equal(world.chain.storageBytes(account), before);
    assert.equal(world.usdc('wallet.near'), 100n * DOLLAR);
  });

  it('accepts only USDC', () => {
    const world = createWorld();
    const result = world.chain.tx({
      signer: 'stranger.near',
      receiver: COMPANY,
      method: 'ft_on_transfer',
      args: { sender_id: 'stranger.near', amount: String(DOLLAR), msg: world.order() },
    });
    assert.match(result.first.error, /Only USDC/);
    assert.equal(world.outlayer.jobs.length, 0);
  });
});

describe('the daily AI budget', () => {
  it('closes the shop before the cap is passed, and reopens the next day', () => {
    const world = createWorld({ rules: { max_ai_per_day: '100000', ai_reserve_per_run: '50000' } });
    world.payFromAnyChain();
    world.answerGood(lastJob(world), { ai: 50_000 });
    assert.equal(world.status().open, true);
    world.payFromAnyChain();
    world.answerGood(lastJob(world), { ai: 50_000 });
    assert.equal(world.status().open, false);
    assert.match(world.status().closed_because, /daily AI budget/);
    world.payFromAnyChain();
    assert.equal(world.outlayer.jobs.length, 2);
    world.chain.advance(24 * 60 * 60 * 1000);
    assert.equal(world.status().open, true);
  });

  it('never believes a reported cost above the reserve', () => {
    const world = createWorld();
    world.payFromAnyChain();
    world.answerGood(lastJob(world), { ai: 9_000_000 });
    assert.equal(world.status().ai_total, '50000');
  });
});

describe('referrers', () => {
  it('earn their share inside the sale', () => {
    const world = createWorld();
    world.payFromAnyChain(DOLLAR, world.order({ ref: 'alice.near' }));
    world.answerGood(lastJob(world));
    assert.equal(world.usdc('alice.near'), 100_000n);
    assert.equal(world.status().treasury, '600000');
  });

  it('keep their money when they cannot receive it yet', () => {
    const world = createWorld();
    world.payFromAnyChain(DOLLAR, world.order({ ref: 'dave.near' }));
    world.answerGood(lastJob(world));
    assert.equal(world.chain.view(COMPANY, 'get_owed', { account: 'dave.near' }), '100000');
    world.token.register('dave.near');
    world.chain.tx({ signer: 'stranger.near', receiver: COMPANY, method: 'claim', args: { account: 'dave.near' } });
    assert.equal(world.usdc('dave.near'), 100_000n);
    assert.equal(world.chain.view(COMPANY, 'get_owed', { account: 'dave.near' }), '0');
  });
});

describe('a human can set limits, and cannot take the money', () => {
  it('no withdrawal method exists', () => {
    const world = createWorld();
    world.payFromAnyChain();
    world.answerGood(lastJob(world));
    for (const method of ['withdraw', 'ft_transfer', 'transfer', 'drain', 'set_contributors', 'set_owner', 'migrate', 'upgrade']) {
      const result = world.owner(method, {});
      assert.match(result.first.error, /has no method/, method);
    }
  });

  it('the owner cannot move the split past the caps', () => {
    const world = createWorld();
    for (const rule of [{ contributors_bps: 5001 }, { referrer_bps: 3001 }, { stake_bps: 5001 }, { contributors_bps: 5000, stake_bps: 4500 }]) {
      const result = world.owner('set_rules', { rules: { ...world.rules, ...rule } });
      assert.ok(!result.first.ok, JSON.stringify(rule));
    }
  });

  it('only the owner can touch the rules, and it takes one yocto', () => {
    const world = createWorld();
    assert.match(world.owner('pause', {}, 'stranger.near').first.error, /Only the owner/);
    assert.match(world.owner('set_rules', { rules: world.rules }, 'stranger.near').first.error, /Only the owner/);
    const free = world.chain.tx({ signer: OWNER, receiver: COMPANY, method: 'pause', args: {} });
    assert.match(free.first.error, /1 yoctoNEAR/);
  });

  it('the kill switch stops new work, and running work still finishes', () => {
    const world = createWorld();
    world.payFromAnyChain();
    const job = lastJob(world);
    world.owner('pause', {});
    world.answerGood(job);
    assert.equal(world.getOrder(1).status, 'Delivered');
    assert.equal(world.status().open, false);
    world.owner('resume');
    assert.equal(world.status().open, true);
  });

  it('nobody can call the settlement directly', () => {
    const world = createWorld();
    world.payFromAnyChain();
    const result = world.chain.tx({ signer: OWNER, receiver: COMPANY, method: 'on_review', args: { order_id: 1 } });
    assert.match(result.first.error, /private/);
    assert.equal(world.getOrder(1).status, 'Running');
  });

  it('locking fixes the enclave and the page for good', () => {
    const world = createWorld();
    assert.ok(world.owner('set_enclave', { project_id: 'x/y', version_key: 'b'.repeat(64) }).first.ok);
    world.owner('lock');
    assert.equal(world.status().locked, true);
    assert.match(world.owner('set_enclave', { project_id: 'x/y', version_key: 'c'.repeat(64) }).first.error, /locked/);
    assert.match(world.owner('set_page', { body_base64: 'aGk=' }).first.error, /locked/);
  });
});

describe('the AI sets the price, inside the human range', () => {
  const board = { board_every: 2 };

  it('is asked every few sales, and told the books', () => {
    const world = createWorld({ rules: board });
    for (let i = 0; i < 2; i += 1) {
      world.payFromAnyChain();
      assert.equal(lastJob(world).input.board, undefined);
      world.answerGood(lastJob(world));
    }
    world.payFromAnyChain();
    assert.equal(lastJob(world).input.board.delivered, 2);
    assert.equal(lastJob(world).input.board.gross, '2000000');
  });

  it('a price inside the range is taken, and the reasoning is public', () => {
    const world = createWorld({ rules: board });
    for (let i = 0; i < 2; i += 1) {
      world.payFromAnyChain();
      world.answerGood(lastJob(world));
    }
    world.payFromAnyChain();
    world.answerGood(lastJob(world), { board: { price: '1500000', note: 'Demand is rising before the deadline.' } });
    assert.equal(world.status().price, '1500000');
    const entry = world.ledger().find((item) => item.kind === 'PriceChange');
    assert.equal(entry.note, 'Demand is rising before the deadline.');
  });

  for (const [name, price, expected] of [
    ['a greedy price stops at the maximum', '999000000', '5000000'],
    ['a giveaway stops at the minimum', '1', '1000000'],
  ]) {
    it(name, () => {
      const world = createWorld({ rules: board });
      world.payFromAnyChain();
      world.answerGood(lastJob(world), { board: { price, note: 'x' } });
      assert.equal(world.status().price, expected);
    });
  }

  it('a buyer quoted before a rise still pays the old price for a while', () => {
    const world = createWorld({ rules: board });
    world.payFromAnyChain();
    world.answerGood(lastJob(world), { board: { price: '3000000', note: 'up' } });
    world.payFromAnyChain(DOLLAR);
    assert.equal(world.outlayer.jobs.length, 2, 'the old price holds');
    world.answerGood(lastJob(world));
    world.chain.advance(21 * 60 * 1000);
    world.payFromAnyChain(DOLLAR);
    assert.equal(world.outlayer.jobs.length, 2, 'then the new price applies');
  });

  it('text from the AI cannot break the ledger', () => {
    const world = createWorld({ rules: board });
    world.payFromAnyChain();
    world.answerGood(lastJob(world), { board: { price: '2000000', note: `line\nbreak\t${'x'.repeat(600)}` } });
    const entry = world.ledger().find((item) => item.kind === 'PriceChange');
    assert.equal(entry.note.length, 240);
    assert.ok(!entry.note.includes('\n'));
  });

  it('an answer too long for OutLayer to have sent is not a delivery', () => {
    const world = createWorld({ rules: board });
    world.payFromAnyChain();
    world.answerGood(lastJob(world), { board: { price: '2000000', note: 'x'.repeat(2000) } });
    assert.equal(world.getOrder(1).status, 'Refunded');
  });
});

describe('config.yaml runs the company', () => {
  it('every rule in the file reaches the contract', () => {
    const world = createWorld({ rules: loadRules() });
    assert.deepEqual(world.chain.view(COMPANY, 'get_rules'), {
      paused: false,
      min_price: '1000000',
      max_price: '5000000',
      max_ai_per_day: '5000000',
      ai_reserve_per_run: '50000',
      contributors_bps: 2000,
      referrer_bps: 1000,
      stake_bps: 1000,
      board_every: 5,
      run_deposit: String(near('0.03')),
      near_floor: String(near('0.5')),
      ai_stake_cap: String(near('2')),
      keep_liquid: String(near('1')),
    });
  });

  it('the shipped deposit covers OutLayer\'s limit for this run size', () => {
    assert.ok(BigInt(loadRules().run_deposit) >= near('0.013'));
  });

  it('flipping the kill switch in the file stops the shop', () => {
    const world = createWorld();
    const rules = toRules(parseConfig('kill_switch: true\nmin_price_usd: 1.00\nmax_price_usd: 5.00\nmax_ai_spend_usd_per_day: 5.00\nai_reserve_per_run_usd: 0.05\nrevenue_split:\n  contributors_percent: 20\n  referrer_percent: 10\n  stake_percent: 10\nprice_review_every_sales: 5\ncompute_deposit_near: 0.03\nnear_floor: 0.5\nai_stake_cap_near: 2\nkeep_liquid_near: 1\n'));
    world.owner('set_rules', { rules });
    assert.equal(world.status().open, false);
    world.payFromAnyChain();
    assert.equal(world.outlayer.jobs.length, 0);
  });

  it('a config that breaks the caps is refused by the contract, not trusted', () => {
    const world = createWorld();
    const rules = { ...loadRules(), contributors_bps: 9000 };
    assert.match(world.owner('set_rules', { rules }).first.error, /above the cap/);
  });
});

describe('the books stay honest', () => {
  it('the team is never counted as a customer', () => {
    const world = createWorld();
    world.payFromAnyChain(DOLLAR, world.order({ team: true }));
    world.answerGood(lastJob(world));
    const status = world.status();
    assert.equal(status.customers, '0');
    assert.equal(status.team_orders, '1');
    assert.equal(world.ledger().find((item) => item.kind === 'Sale').note, 'team');
  });

  it('every dollar is accounted for across many mixed orders', () => {
    const world = createWorld();
    let refunded = 0n;
    for (let i = 0; i < 12; i += 1) {
      world.payFromAnyChain(DOLLAR, world.order({ ref: i % 3 === 0 ? 'alice.near' : undefined }));
      if (i % 4 === 3) {
        world.answer(lastJob(world), 'null');
        refunded += DOLLAR;
      } else {
        world.answerGood(lastJob(world));
      }
    }
    const status = world.status();
    assert.equal(BigInt(status.gross) + refunded, 12n * DOLLAR);
    assert.equal(BigInt(status.paid_out) + BigInt(status.treasury) + BigInt(status.stake_pool), BigInt(status.gross));
    assert.equal(world.usdc(COMPANY), BigInt(status.treasury) + BigInt(status.stake_pool), 'what the books say is what it holds');
  });

  it('a browser can find its order, even one that was refused', () => {
    const world = createWorld();
    const key = 'cd'.repeat(32);
    world.payFromAnyChain(DOLLAR, world.order({ pk: key }));
    assert.equal(world.chain.view(COMPANY, 'find_order', { pk: key }).id, 1);
    world.owner('pause', {});
    const refusedKey = 'ef'.repeat(32);
    world.payFromAnyChain(DOLLAR, world.order({ pk: refusedKey }));
    const found = world.chain.view(COMPANY, 'find_order', { pk: refusedKey });
    assert.equal(found.status, 'Refunded');
    assert.match(found.reason, /kill switch/);
    assert.equal(world.chain.view(COMPANY, 'find_order', { pk: 'aa'.repeat(32) }), null);
  });

  it('the status page reads directly from the contract', () => {
    const world = createWorld();
    const status = world.status();
    assert.equal(status.open, true);
    assert.equal(status.price, '1000000');
    assert.equal(status.version_key, VERSION);
  });

  it('serves its own shop', () => {
    const world = createWorld();
    assert.equal(world.chain.view(COMPANY, 'web4_get', { request: { path: '/' } }).status, 404);
    world.owner('set_page', { body_base64: 'PGgxPk5vYm9keTwvaDE+' });
    const page = world.chain.view(COMPANY, 'web4_get', { request: { path: '/' } });
    assert.equal(page.body, 'PGgxPk5vYm9keTwvaDE+');
    assert.match(page.contentType, /text\/html/);
  });

  it('emits events an indexer can read', () => {
    const world = createWorld();
    const paid = world.payFromAnyChain();
    assert.match(logsOf(paid), /EVENT_JSON:.*"event":"order"/);
  });
});

describe('the company buys its own inference', () => {
  // Enough NEAR that some is spare after the 2 NEAR kept for compute and the gas a purchase
  // reserves while it runs.
  const rich = (rules = {}) => createWorld({ near_balance: '10', rules });
  const adopt = (world) => {
    world.payFromAnyChain();
    world.answerGood(lastJob(world), { keeper: world.keeper });
  };
  const otherKey = () => publicKeyText(nacl().sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey);
  const poke = (world, gas = tgas(400)) =>
    world.chain.tx({ signer: 'stranger.near', receiver: COMPANY, method: 'buy_inference', gas });

  it('adopts the enclave key once, as a key that can only call buy_inference', () => {
    const world = rich();
    adopt(world);
    const key = world.chain.keysOf(COMPANY).get(world.keeper);
    assert.ok(key, 'the key is on the company account');
    assert.equal(key.full, false, 'it is not a full-access key');
    assert.equal(key.receiver, COMPANY);
    assert.deepEqual(key.methods, ['buy_inference']);
    assert.equal(key.allowance, near('1'), 'its gas allowance is capped');
    assert.equal(world.status().keeper, world.keeper);
    const added = world.ledger().find((entry) => entry.kind === 'KeyChange');
    assert.equal(added.note, `enclave key ${world.keeper} added; it can only call buy_inference`);

    world.payFromAnyChain(DOLLAR, world.order({ pk: 'cd'.repeat(32) }));
    world.answerGood(lastJob(world), { keeper: otherKey() });
    assert.equal(world.chain.keysOf(COMPANY).size, 1, 'a later report cannot swap the key');
    assert.equal(world.status().keeper, world.keeper);
  });

  it('a delivery with an unreadable key is still a delivery, and adopts nothing', () => {
    for (const keeper of ['ed25519:not-a-key', `secp256k1:${'1'.repeat(80)}`, 42]) {
      const world = rich();
      world.payFromAnyChain();
      world.answerGood(lastJob(world), { keeper });
      assert.equal(world.getOrder(1).status, 'Delivered');
      assert.equal(world.status().keeper, null);
      assert.equal(world.chain.keysOf(COMPANY).size, 0);
    }
  });

  it('asks the enclave to buy only once its key is in place and something is due', () => {
    const world = rich();
    world.payFromAnyChain();
    assert.equal(lastJob(world).input.buy, undefined, 'no key yet');
    world.answerGood(lastJob(world), { keeper: world.keeper });
    world.payFromAnyChain(DOLLAR, world.order({ pk: 'cd'.repeat(32) }));
    assert.equal(lastJob(world).input.buy, true);

    const off = rich({ ai_stake_cap: '0' });
    adopt(off);
    off.payFromAnyChain(DOLLAR, off.order({ pk: 'cd'.repeat(32) }));
    assert.equal(lastJob(off).input.buy, undefined, 'a cap of zero means nothing is ever due');
  });

  it('the keeper stakes spare NEAR with NEAR AI, and the purchase is on the ledger', () => {
    const world = rich();
    adopt(world);
    const bought = world.keeperBuys();
    assert.deepEqual(failed(bought), []);
    assert.deepEqual(bought.receipts.map((receipt) => receipt.method), ['buy_inference', 'storage_deposit', 'stake', 'on_bought']);
    assert.ok(find(bought, 'stake').gas >= tgas(300), 'NEAR AI refuses a stake with less than 300 Tgas');
    assert.equal(world.farm.positions.get(COMPANY), near('2'), 'up to the cap a human set');
    const status = world.status();
    assert.equal(status.ai_staked, String(near('2')));
    assert.equal(status.ai_purchases, '1');
    assert.equal(status.stake_due, '0', 'the cap is reached, so nothing more is due');
    const purchase = world.ledger().find((entry) => entry.kind === 'AiPurchase');
    assert.equal(purchase.amount, String(near('2')));
    assert.equal(purchase.to, FARM);
    assert.match(logsOf(bought), /"event":"bought"/);
  });

  it('registers with NEAR AI once, then only stakes', () => {
    const world = rich({ ai_stake_cap: String(near('100')) });
    adopt(world);
    world.keeperBuys();
    const first = BigInt(world.status().ai_staked);
    // Everything spare is staked now. More NEAR arrives, so more is spare again.
    world.chain.accounts.get(COMPANY).balance += near('3');
    const again = world.keeperBuys();
    assert.deepEqual(again.receipts.map((receipt) => receipt.method), ['buy_inference', 'stake', 'on_bought']);
    assert.ok(BigInt(world.status().ai_staked) > first + near('2'));
    assert.equal(world.status().ai_purchases, '2');
  });

  it('stakes only what is above the NEAR kept for compute, so the shop stays open', () => {
    const world = rich({ ai_stake_cap: String(near('100')) });
    adopt(world);
    world.keeperBuys();
    const status = world.status();
    assert.ok(BigInt(status.ai_staked) > near('4'), 'it staked what was spare');
    assert.ok(BigInt(status.near_free) >= near('2'), 'and kept 2 NEAR liquid for compute');
    assert.equal(status.open, true);
    world.payFromAnyChain(DOLLAR, world.order({ pk: 'cd'.repeat(32) }));
    assert.equal(world.getOrder(2).status, 'Running');
  });

  it('the keeper key can do nothing else', () => {
    const world = rich();
    adopt(world);
    assert.throws(() => world.keeperBuys({ method: 'pause' }), /MethodNameMismatch/);
    assert.throws(() => world.keeperBuys({ method: 'set_rules' }), /MethodNameMismatch/);
    assert.throws(() => world.keeperBuys({ method: 'claim' }), /MethodNameMismatch/);
    assert.throws(() => world.keeperBuys({ receiver: USDC, method: 'ft_transfer' }), /ReceiverMismatch/);
    assert.throws(() => world.keeperBuys({ deposit: 1n }), /DepositWithFunctionCall/);
    assert.equal(world.usdc(COMPANY), 800_000n, 'no money moved');
  });

  it('anyone may ask, and gets only what the rules allow', () => {
    const world = rich();
    assert.deepEqual(failed(poke(world)), []);
    assert.equal(world.farm.positions.get(COMPANY), near('2'));
    const again = poke(world);
    assert.equal(find(again, 'stake'), undefined, 'nothing more is due');
    assert.equal(world.farm.positions.get(COMPANY), near('2'));
  });

  it('refuses to start without the gas NEAR AI needs, and changes nothing', () => {
    const world = rich();
    assert.match(poke(world, tgas(300)).first.error, /345 Tgas/);
    assert.equal(world.status().ai_staked, '0');
    assert.equal(world.farm.positions.size, 0);
  });

  it('a purchase that fails changes nothing, and the next one works', () => {
    const world = rich();
    adopt(world);
    world.farmRefuses = true;
    const before = world.chain.balance(COMPANY);
    const refused = world.keeperBuys();
    assert.match(logsOf(refused), /"event":"buy_failed"/);
    assert.equal(world.status().ai_staked, '0');
    assert.ok(before - world.chain.balance(COMPANY) < near('0.05'), 'the NEAR came back');
    assert.ok(!kinds(world).includes('AiPurchase'), 'nothing was bought, so nothing is booked');
    world.farmRefuses = false;
    world.keeperBuys();
    assert.equal(world.status().ai_staked, String(near('2')));
  });

  it('the kill switch stops buying too', () => {
    const world = rich();
    adopt(world);
    world.owner('pause');
    world.keeperBuys();
    poke(world);
    assert.equal(world.status().ai_staked, '0');
  });

  it('a new enclave removes the old keeper key', () => {
    const world = rich();
    adopt(world);
    world.owner('set_enclave', { project_id: 'hirenobody.near/enclave2', version_key: 'b'.repeat(64) });
    assert.equal(world.chain.keysOf(COMPANY).has(world.keeper), false);
    assert.equal(world.status().keeper, null);
    assert.match(world.ledger().at(-1).note, /removed, for a new enclave/, 'the public ledger says so');
    assert.throws(() => world.keeperBuys(), /AccessKeyNotFound/);
  });

  it('the farm cannot be switched once NEAR is staked with it', () => {
    const world = rich();
    poke(world);
    const moved = world.owner('set_farm', { farm: 'elsewhere.near', farm_product: 'prod_x' });
    assert.match(moved.first.error, /already staked/);
  });

  it('runs a transaction signed in NEAR\'s wire format, and refuses a tampered one', () => {
    const world = rich();
    adopt(world);
    const keys = nacl().sign.keyPair.fromSeed(KEEPER_SEED);
    const nonce = world.chain.keysOf(COMPANY).get(world.keeper).nonce + 1n;
    const bytes = encodeTransaction({
      signer: COMPANY,
      publicKey: keys.publicKey,
      nonce,
      receiver: COMPANY,
      blockHash: new Uint8Array(32),
      method: 'buy_inference',
      args: Buffer.from('{}'),
      gas: tgas(400),
    });
    const signature = nacl().sign.detached(createHash('sha256').update(bytes).digest(), keys.secretKey);
    const signed = Buffer.concat([bytes, Buffer.from([0]), Buffer.from(signature)]);
    const tampered = Buffer.from(signed);
    tampered[6] ^= 1;
    assert.throws(() => world.chain.submit(tampered.toString('base64')), /InvalidSignature/);
    world.chain.submit(signed.toString('base64'));
    assert.equal(world.status().ai_staked, String(near('2')));
    assert.throws(() => world.chain.submit(signed.toString('base64')), /InvalidNonce/, 'a replay is refused');
  });
});
