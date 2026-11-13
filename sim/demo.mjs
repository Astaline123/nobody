// One full company cycle, on the simulated chain, with the real compiled contract.
// Needs only Node: no keys, no wallet, no funds. `npm run demo`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { drawTree, near } from './chain.mjs';
import { COMPANY, CONTRIBUTORS, DOLLAR, createWorld } from './world.mjs';

const WASM = new URL('../contract/res/nobody.wasm', import.meta.url);
const started = Date.now();
let failures = 0;

const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;
const nearOf = (yocto) => `${(Number(BigInt(yocto) / 10n ** 20n) / 1e4).toFixed(4)} NEAR`;

function check(passed, text) {
  if (!passed) failures += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${text}`);
}

function step(title) {
  console.log(`\n--- ${title}`);
}

const code = readFileSync(WASM);
console.log('Nobody: one full company cycle on a simulated chain');
console.log(`contract wasm sha256: ${createHash('sha256').update(code).digest('hex')}`);
console.log(`contract size: ${code.length} bytes, about ${(code.length / 100_000).toFixed(2)} NEAR of storage`);

const START_NEAR = '10';
const world = createWorld({ wasm: code, rules: { board_every: 1 }, near_balance: START_NEAR });
const { chain } = world;

step('1. No server is running. The company is asleep, and costs nothing');
const asleep = world.status();
check(asleep.open && asleep.orders === '0', 'open for business with no process running');
check(chain.keysOf(COMPANY).size === 0, 'its account has no keys at all');

step('2. A stranger pays $1 in SOL. 1Click delivers it as USDC, and that payment wakes the company');
const buyer = '0x2527d02599ba641c19fea793cd0f167589a0f10d';
const paid = world.payFromAnyChain(DOLLAR, world.order({ ref: 'alice.near' }));
console.log(drawTree(paid.receipts));
check(world.outlayer.jobs.length === 1, 'the payment alone started the enclave');
check(world.getOrder(1).status === 'Running', 'order 1 is running');

step('3. The enclave reviews the repo, seals the report to the buyer and publishes it');
const mark = chain.trail.length;
world.answerGood(world.outlayer.jobs.at(-1), { keeper: world.keeper });
console.log(drawTree(chain.trail.slice(mark)));
const order = world.getOrder(1);
check(order.status === 'Delivered', 'delivered, with the report hash on chain');

step('4. The money moved by itself, in that same flow');
check(world.usdc(CONTRIBUTORS) === 200_000n, `contributors received ${usd(world.usdc(CONTRIBUTORS))}`);
check(world.usdc('alice.near') === 100_000n, `the referrer received ${usd(world.usdc('alice.near'))}`);
const status = world.status();
check(status.treasury === '600000', `the treasury keeps ${usd(status.treasury)}`);
check(status.stake_pool === '100000', `${usd(status.stake_pool)} is set aside for buying inference`);

step('5. The company buys its own inference, with a key that can do nothing else');
const key = chain.keysOf(COMPANY).get(world.keeper);
check(key && !key.full && key.methods.join() === 'buy_inference', `the enclave's key, derived in OutLayer's TEE, was adopted: it can call buy_inference only`);
const bought = world.keeperBuys();
console.log(drawTree(bought.receipts));
check(world.farm.positions.get(COMPANY) === near('2'), `${nearOf(world.farm.positions.get(COMPANY))} staked with NEAR AI, the cap in config.yaml; its yield buys Cloud credits`);
check(BigInt(world.status().near_free) >= near('1'), 'and the NEAR kept for compute is untouched, so the shop stays open');
let refused = '';
try {
  world.keeperBuys({ method: 'set_rules' });
} catch (error) {
  refused = error.message;
}
check(/MethodNameMismatch/.test(refused), 'the same key tries to change the rules: the chain refuses it before anything runs');

step('6. A run fails. The buyer is refunded, to an address their own wallet controls');
world.payFromAnyChain();
world.answer(world.outlayer.jobs.at(-1), 'null');
check(world.getOrder(2).status === 'Refunded', 'a timed-out run costs the buyer nothing');
check(world.intents.inside.get(buyer) === DOLLAR, `${usd(world.intents.inside.get(buyer))} now belongs to the buyer inside NEAR Intents`);

step('7. The AI proposes a greedy price, and the human limit holds');
world.payFromAnyChain();
const asked = world.outlayer.jobs.at(-1);
check(asked.input.board !== undefined, 'the enclave was shown the books and asked for a price');
world.answerGood(asked, { board: { price: '999000000', note: 'Every entrant will pay anything before the deadline.' } });
check(world.status().price === '5000000', `it asked for $999.00 and got ${usd(world.status().price)}, the top of the range`);

step('8. A human can stop it. A human cannot rob it');
for (const method of ['withdraw', 'ft_transfer', 'set_owner', 'upgrade']) {
  const result = world.owner(method);
  check(/has no method/.test(result.first.error), `the owner tries ${method}: no such method`);
}
const greedy = world.owner('set_rules', { rules: { ...world.rules, contributors_bps: 9000 } });
check(!greedy.first.ok, 'the owner tries to send 90% to contributors: refused');
world.owner('pause', { reason: 'kill switch test' });
world.payFromAnyChain();
const after = world.ledger().filter((entry) => entry.kind === 'Refused').at(-1);
check(after?.note === 'kill switch test', 'with the kill switch on, a new order is turned away and refunded');

step('9. The books');
const final = world.status();
const ledger = world.ledger();
for (const entry of ledger) {
  let shown = usd(entry.amount);
  if (['ComputeCost', 'AiPurchase'].includes(entry.kind)) shown = nearOf(entry.amount);
  if (entry.kind === 'AiCost') shown = `$${(Number(entry.amount) / 1e6).toFixed(4)}`;
  if (['RuleChange', 'KeyChange'].includes(entry.kind)) shown = '';
  console.log(`  ${entry.kind.padEnd(12)} ${shown.padStart(12)}  ${entry.to ?? ''} ${entry.note ?? ''}`);
}
const held = world.usdc(COMPANY);
check(held === BigInt(final.treasury) + BigInt(final.stake_pool), `the contract holds exactly what the books say: ${usd(held)}`);
const spent = near(START_NEAR) - chain.balance(COMPANY) - BigInt(final.ai_staked);
console.log(`\nNEAR spent on compute and gas this run: ${nearOf(spent)}. It only falls when someone is paying.`);
console.log(`NEAR staked with NEAR AI: ${nearOf(final.ai_staked)}. It stays the company's.`);

console.log(`\n${failures ? `${failures} CHECKS FAILED` : 'ALL CHECKS PASS'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log('This is a simulation of the chain around the real contract. See README for what it does not prove.');
process.exit(failures ? 1 : 0);
