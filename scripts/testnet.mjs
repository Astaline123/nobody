// Nobody on NEAR testnet.
//
//   node scripts/testnet.mjs setup <parent.testnet>    accounts, contract, test USDC and the page
//   node scripts/testnet.mjs enclave                    builds, uploads and deploys the enclave, stores
//                                                       the NEAR AI key, and points the company at it
//   node scripts/testnet.mjs point <sha256>             points the company at a build (owner)
//   node scripts/testnet.mjs demo [owner/repo]          one full loop, sale to payout, timed
//   node scripts/testnet.mjs status                     what the chain says now
//   node scripts/testnet.mjs lockdown --yes             removes the company's full-access key
//
// Keys stay where the near CLI keeps them (~/.near-credentials/testnet), or in environment
// variables, never in this repo. deployments/testnet.json holds account names only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nacl, open } from '../sim/open.mjs';
import { buildPage } from './build-page.mjs';
import { TGAS, client, explorer, loadKey, nearText, newKey, saveKey, toYocto } from './near.mjs';
import { loadRules } from './rules.mjs';

const NETWORK = 'testnet';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILE = join(ROOT, 'deployments', 'testnet.json');
// Read live on 8 Nov 2026: test USDC with a public mint, OutLayer's testnet contract, and
// NEAR AI's own testnet staking contract with its "NEAR AI Cloud Credits" farm.
const USDC = 'usdc.fakes.testnet';
const OUTLAYER = 'outlayer.testnet';
const FARM = 'stake-dao.testnet';
const FARM_PRODUCT = 'prod_DMBHDlk4bg37Up';
const STORAGE_API = 'https://testnet-api.outlayer.ai/public/storage/get';
const PROJECT_NAME = 'nobody-enclave';
// NEAR Intents has no testnet. This name only marks payments as cross-chain, which never
// happens here: testnet buyers pay from a NEAR account.
const INTENTS = 'intents.testnet';
const LIMIT_MS = 120_000;

const near = client(NETWORK);
const say = (text) => console.log(text);
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deployment() {
  if (!existsSync(FILE)) throw new Error('No testnet deployment yet. Run: node scripts/testnet.mjs setup <parent.testnet>');
  return JSON.parse(readFileSync(FILE, 'utf8'));
}

function saveDeployment(data) {
  mkdirSync(join(ROOT, 'deployments'), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`);
}

/** Creates a named sub-account with a fresh key. The key is saved before the account exists. */
async function createAccount(parent, parentKey, id, amount) {
  if (await near.account(id)) {
    say(`  ${id} already exists`);
    return;
  }
  const key = newKey();
  saveKey(NETWORK, id, key);
  const { hash } = await near.send(parent, parentKey, id, [
    { createAccount: true },
    { transfer: toYocto(amount) },
    { addKey: { publicKey: key.publicKey, full: true } },
  ]);
  say(`  ${id} created with ${amount} NEAR  ${explorer(NETWORK, hash)}`);
}

async function registerUsdc(parent, parentKey, account) {
  if (await near.view(USDC, 'storage_balance_of', { account_id: account })) return;
  const bounds = await near.view(USDC, 'storage_balance_bounds');
  await near.call(parent, parentKey, USDC, 'storage_deposit', { account_id: account, registration_only: true }, { deposit: BigInt(bounds.min) });
  say(`  ${account} can now hold test USDC`);
}

async function setup(parent) {
  if (!parent?.endsWith('.testnet')) throw new Error('usage: node scripts/testnet.mjs setup <parent.testnet>');
  const parentKey = loadKey(NETWORK, parent, 'NOBODY_PARENT_KEY');
  const names = {
    company: `co.${parent}`,
    team: `team.${parent}`,
    contributors: `contributors.${parent}`,
    buyer: `buyer.${parent}`,
  };
  const companyNear = process.env.COMPANY_NEAR ?? '7';
  const balance = BigInt((await near.account(parent))?.amount ?? 0n);
  say(`${parent} holds ${nearText(balance)} NEAR`);

  say('\n1. Accounts');
  await createAccount(parent, parentKey, names.team, '1.2');
  await createAccount(parent, parentKey, names.contributors, '0.1');
  await createAccount(parent, parentKey, names.buyer, '0.3');

  say('\n2. The company: account, contract and rules in one transaction, so it is all or nothing');
  const rules = loadRules();
  const config = {
    owner: names.team,
    usdc: USDC,
    intents: INTENTS,
    outlayer: OUTLAYER,
    contributors: names.contributors,
    project_id: `${names.team}/${PROJECT_NAME}`,
    // Replaced by `point` once the enclave is on OutLayer.
    version_key: '0'.repeat(64),
    max_instructions: '30000000000',
    max_memory_mb: 256,
    max_execution_seconds: 120,
    farm: FARM,
    farm_product: FARM_PRODUCT,
  };
  if (await near.account(names.company)) {
    say(`  ${names.company} already exists`);
  } else {
    const key = newKey();
    // A key held only in memory is lost with the funds if anything fails, so it is saved first.
    saveKey(NETWORK, names.company, key);
    const wasm = readFileSync(join(ROOT, 'contract', 'res', 'nobody.wasm'));
    const { hash } = await near.send(parent, parentKey, names.company, [
      { createAccount: true },
      { transfer: toYocto(companyNear) },
      { addKey: { publicKey: key.publicKey, full: true } },
      { deploy: wasm },
      { call: { method: 'new', args: JSON.stringify({ config, rules, price: rules.min_price }), gas: 100n * TGAS } },
    ]);
    say(`  ${names.company} runs the contract (${(wasm.length / 1024).toFixed(1)} KB, sha256 ${createHash('sha256').update(wasm).digest('hex')})`);
    say(`  ${explorer(NETWORK, hash)}`);
  }

  say('\n3. Test USDC');
  for (const account of [names.company, names.contributors, names.buyer]) await registerUsdc(parent, parentKey, account);
  await near.call(parent, parentKey, USDC, 'mint', { account_id: names.buyer, amount: String(10_000_000) });
  say(`  ${names.buyer} holds ${usd(await near.view(USDC, 'ft_balance_of', { account_id: names.buyer }))} of test USDC`);

  say('\n4. The shop page, served by the contract itself');
  const { body } = buildPage(names.company, config.project_id);
  const teamKey = loadKey(NETWORK, names.team);
  await near.call(names.team, teamKey, names.company, 'set_page', { body_base64: body }, { gas: 150n * TGAS, deposit: 1n });
  say(`  ${pageUrl(names.company)}`);

  saveDeployment({ network: NETWORK, parent, ...names, usdc: USDC, outlayer: OUTLAYER, farm: FARM, farm_product: FARM_PRODUCT, project_id: config.project_id, version_key: null });
  say(`\nSaved ${FILE}. Next, with NEARAI_API_KEY in .env: node scripts/testnet.mjs enclave`);
}

function pageUrl(account) {
  return `https://${account.replace(/\.testnet$/, '')}.testnet.page`;
}

/** The OutLayer CLI: OUTLAYER_CLI, the copy in dev-tools, or whatever `outlayer` is on PATH. */
function outlayerCli() {
  const local = join(homedir(), 'dev-tools', 'outlayer', 'bin', process.platform === 'win32' ? 'outlayer.exe' : 'outlayer');
  return process.env.OUTLAYER_CLI ?? (existsSync(local) ? local : 'outlayer');
}

/**
 * Runs the OutLayer CLI with its own config folder, so this never replaces another project's
 * login on a shared machine. Its output is returned, not printed, because one step carries
 * the inference key.
 */
function outlayer(args, { input, quiet = false } = {}) {
  const env = { ...process.env, OUTLAYER_NETWORK: NETWORK, OUTLAYER_HOME: process.env.OUTLAYER_HOME ?? join(homedir(), '.outlayer-nobody') };
  const result = spawnSync(outlayerCli(), args, { input, encoding: 'utf8', env, timeout: 300_000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    throw new Error(`outlayer ${args[0]} failed: ${quiet ? '(output withheld: it may hold a secret)' : output.trim().slice(-800)}`);
  }
  return output;
}

/** The NEAR AI key, from the environment or the gitignored .env. It is never printed. */
function inferenceKey() {
  if (process.env.NEARAI_API_KEY) return process.env.NEARAI_API_KEY;
  const file = join(ROOT, '.env');
  const line = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).find((text) => /^\s*NEARAI_API_KEY\s*=/.test(text)) : null;
  const key = line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
  if (!key) throw new Error(`No NEAR AI key. Put NEARAI_API_KEY=... in ${file} (it is gitignored), then run this again.`);
  return key;
}

async function enclave() {
  const d = deployment();
  const key = inferenceKey();

  say('1. Build the enclave for this deployment');
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--production', d.company, d.team], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(1);
  const path = join(ROOT, 'enclave', 'res', `nobody-enclave.${d.company}.wasm`);
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  say(`  ${sha256}: only ${d.company} may call it, and ${d.team} owns its secrets`);

  say(`\n2. Log the OutLayer CLI in as ${d.team}`);
  const teamSecret = JSON.parse(readFileSync(join(homedir(), '.near-credentials', NETWORK, `${d.team}.json`), 'utf8')).private_key;
  outlayer(['login', NETWORK], { input: `${d.team}\n${teamSecret}\n`, quiet: true });

  say('\n3. Upload it to FastFS');
  const uploaded = outlayer(['upload', path]);
  const url = uploaded.match(/FastFS URL:\s*(\S+)/)?.[1];
  if (!url) throw new Error(`upload printed no URL:\n${uploaded.slice(-600)}`);
  say(`  ${url}`);
  // The FastFS indexer reads the upload from the transaction, which takes a minute or two.
  let served = false;
  for (let attempt = 0; attempt < 50 && !served; attempt += 1) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) served = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') === sha256;
    if (!served) await sleep(6000);
  }
  if (!served) throw new Error(`FastFS does not serve the build yet: ${url}`);
  say('  FastFS serves it, and its sha256 matches');

  say(`\n4. Deploy it as ${d.project_id}`);
  say(outlayer(['deploy', PROJECT_NAME, url, '--hash', sha256]).trim().replace(/^/gm, '  '));

  say('\n5. Store the NEAR AI key, readable only by this build, only through this company');
  outlayer(
    ['secrets', 'set', JSON.stringify({ NEARAI_API_KEY: key }), '--project', d.project_id, '--profile', 'production', '--access', 'allow-all', '--via', d.company, '--build', sha256],
    { quiet: true },
  );
  say('  stored, encrypted to OutLayer\'s keystore');

  say('\n6. Point the company at the build');
  await point(sha256);
}

async function point(sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw new Error('usage: node scripts/testnet.mjs point <sha256 of the enclave build>');
  const d = deployment();
  const { hash } = await near.call(d.team, loadKey(NETWORK, d.team), d.company, 'set_enclave', { project_id: d.project_id, version_key: sha256 }, { deposit: 1n });
  saveDeployment({ ...d, version_key: sha256 });
  say(`${d.company} now runs only ${d.project_id} at ${sha256}  ${explorer(NETWORK, hash)}`);
}

async function fetchReport(projectId, id) {
  const url = `${STORAGE_API}?project=${encodeURIComponent(projectId)}&key=${encodeURIComponent(`report:${id}`)}&format=raw`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    await sleep(1500);
  }
  throw new Error(`the report is not in public storage: ${url}`);
}

async function demo(repo = 'near-examples/coin-flip-examples') {
  const d = deployment();
  const buyerKey = loadKey(NETWORK, d.buyer, 'NOBODY_BUYER_KEY');
  const before = await near.view(d.company, 'get_status');
  if (!before.open) throw new Error(`The company is closed: ${before.closed_because}`);
  const price = BigInt(before.price);
  const held = BigInt(await near.view(USDC, 'ft_balance_of', { account_id: d.buyer }));
  if (held < price) {
    await near.call(d.buyer, buyerKey, USDC, 'mint', { account_id: d.buyer, amount: String(10_000_000) });
  }
  const paidOutBefore = BigInt(await near.view(USDC, 'ft_balance_of', { account_id: d.contributors }));

  // The buyer's report key. Only its public half goes on chain.
  const box = nacl().box.keyPair();
  const pk = hex(box.publicKey);
  const started = Date.now();
  const at = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;

  say(`Nobody on testnet: ${d.company}, ${usd(price)} a review of ${repo}\n`);
  const msg = JSON.stringify({ repo, pk, refund: `near:${d.buyer}` });
  const payment = await near.call(d.buyer, buyerKey, USDC, 'ft_transfer_call', { receiver_id: d.company, amount: String(price), msg }, {
    gas: 300n * TGAS,
    deposit: 1n,
    wait: 'INCLUDED_FINAL',
  });
  say(`${at()}  SALE     ${d.buyer} paid ${usd(price)} in test USDC  ${explorer(NETWORK, payment.hash)}`);

  let order = null;
  let shown = '';
  while (Date.now() - started < LIMIT_MS) {
    order = await near.view(d.company, 'find_order', { pk });
    if (order && order.status !== shown) {
      shown = order.status;
      if (order.status === 'Running') say(`${at()}  WORK     order ${order.id}: the payment woke the contract, which asked OutLayer to run the enclave`);
    }
    if (order && order.status !== 'Running') break;
    await sleep(1500);
  }
  if (!order || order.status !== 'Delivered') {
    const reason = order?.reason ? `: ${order.reason}` : '';
    throw new Error(`No delivery within ${LIMIT_MS / 1000}s. The order is ${order?.status ?? 'not found'}${reason}`);
  }
  say(`${at()}  DELIVER  report sealed to the buyer and published; its sha256 is on chain`);

  const sealed = await fetchReport(d.project_id, order.id);
  const digest = createHash('sha256').update(sealed).digest('hex');
  if (digest !== order.report_sha256) throw new Error('the published report does not match the hash on chain');
  const report = open(sealed, box.secretKey);
  say(`${at()}  OPEN     the buyer opened it: ${report.counts.high} high, ${report.counts.medium} medium, ${report.counts.low} low. "${report.verdict.slice(0, 100)}"`);

  // The payout is its own receipt, a block or two after the delivery. A purchase, when one was
  // due, is a separate transaction the enclave sent with its own key.
  const wantBuy = Boolean(before.keeper) && BigInt(before.stake_due) > 0n;
  let entries = [];
  let seconds = 0;
  for (const deadline = Date.now() + 25_000; Date.now() < deadline; await sleep(1500)) {
    entries = await near.view(d.company, 'get_ledger', { from: before.ledger_len, limit: 50 });
    const paid = entries.some((entry) => entry.kind === 'Payout' && entry.order === order.id);
    if (paid && !seconds) seconds = (Date.now() - started) / 1000;
    if (paid && (!wantBuy || entries.some((entry) => entry.kind === 'AiPurchase'))) break;
  }
  for (const entry of entries) {
    if (entry.kind === 'AiCost') say(`         AI COST  $${(Number(entry.amount) / 1e6).toFixed(4)} of NEAR AI Cloud inference, booked against the daily cap`);
    if (entry.kind === 'Payout') say(`${at()}  PAYOUT   ${usd(entry.amount)} to ${entry.to}, automatically, by the split in config.yaml`);
    if (entry.kind === 'KeyChange') say(`         KEY      ${entry.note}`);
    if (entry.kind === 'AiPurchase') say(`         AI BUY   ${nearText(entry.amount)} NEAR staked with NEAR AI by the enclave's own key; the yield buys Cloud credits`);
  }
  if (wantBuy && !entries.some((entry) => entry.kind === 'AiPurchase')) say('         (a purchase was due but has not landed yet: see `status`)');
  const paidOut = BigInt(await near.view(USDC, 'ft_balance_of', { account_id: d.contributors })) - paidOutBefore;
  if (!seconds) seconds = (Date.now() - started) / 1000;
  say(`\nSale to payout in ${seconds.toFixed(1)}s (limit ${LIMIT_MS / 1000}s). Contributors received ${usd(paidOut)}.`);
  say(`Open the report in a browser: ${pageUrl(d.company)}/#r=${hex(box.secretKey)}`);
  say(`The public ledger: ${pageUrl(d.company)}/#books`);
  if (seconds > LIMIT_MS / 1000 || paidOut <= 0n) process.exit(1);
}

async function status() {
  const d = deployment();
  const s = await near.view(d.company, 'get_status');
  say(`${d.company}: ${s.open ? 'open' : `closed (${s.closed_because})`}, price ${usd(s.price)}, ${s.delivered} delivered, ${s.refunded} refunded`);
  say(`  sales ${usd(s.gross)}, paid out ${usd(s.paid_out)}, AI spent $${(Number(s.ai_total) / 1e6).toFixed(4)}`);
  say(`  NEAR free ${nearText(s.near_free)}, staked with NEAR AI ${nearText(s.ai_staked)} in ${s.ai_purchases} purchases, due now ${nearText(s.stake_due)}`);
  say(`  enclave ${s.project_id} @ ${s.version_key.slice(0, 16)}…, keeper ${s.keeper ?? 'not adopted yet'}`);
  const keys = await near.keys(d.company);
  for (const { public_key: key, access_key: access } of keys) {
    const permission = access.permission === 'FullAccess' ? 'FULL ACCESS' : `can call ${access.permission.FunctionCall.method_names.join(', ')} on ${access.permission.FunctionCall.receiver_id}`;
    say(`  key ${key}: ${permission}`);
  }
  const position = await near.view(d.farm, 'get_farm_position', { account_id: d.company, product_id: d.farm_product });
  if (position) say(`  NEAR AI farm position: ${nearText(position.staked_near_amount)} NEAR, ${position.status}`);
}

async function lockdown(flag) {
  const d = deployment();
  const s = await near.view(d.company, 'get_status');
  if (!s.keeper) throw new Error('The enclave key is not adopted yet. Run the demo once first.');
  const keys = await near.keys(d.company);
  const keeper = keys.find((item) => item.public_key === s.keeper);
  if (!keeper || keeper.access_key.permission === 'FullAccess') throw new Error('The keeper key is not on the account as a function-call key.');
  const companyKey = loadKey(NETWORK, d.company);
  if (flag !== '--yes') {
    say(`This deletes ${companyKey.text}, the last full-access key of ${d.company}. It cannot be undone:`);
    say('the contract can then never be redeployed, and only the enclave key that can call buy_inference remains.');
    say('Run again with --yes to do it.');
    return;
  }
  const { hash } = await near.send(d.company, companyKey, d.company, [{ deleteKey: companyKey.publicKey }]);
  rmSync(join(homedir(), '.near-credentials', NETWORK, `${d.company}.json`), { force: true });
  say(`Deleted. ${explorer(NETWORK, hash)}`);
  await status();
}

const [command, ...rest] = process.argv.slice(2);
const commands = { setup, enclave, point, demo, status, lockdown };
if (!commands[command]) {
  console.error('usage: node scripts/testnet.mjs setup|enclave|point|demo|status|lockdown');
  process.exit(1);
}
try {
  await commands[command](...rest);
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}
