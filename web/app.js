'use strict';
// The shop. It has no server: it talks directly to NEAR RPC, 1Click and public storage. Text
// that comes from a repo, a model or the chain is always set with textContent, never as HTML.

const LOCAL = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
// scripts/build-page.mjs writes the real names here when it packs the page for a deployment.
const CONTRACT = 'hirenobody.near';
const PROJECT = 'hirenobody.near/enclave';
const TESTNET = CONTRACT.endsWith('.testnet');
const CONFIG = LOCAL
  ? { contract: CONTRACT, rpc: '/rpc', storage: '/public/storage/get', project: 'local', oneClick: '' }
  : {
      contract: CONTRACT,
      rpc: TESTNET ? 'https://test.rpc.fastnear.com' : 'https://free.rpc.fastnear.com',
      storage: `https://${TESTNET ? 'testnet-' : ''}api.outlayer.ai/public/storage/get`,
      project: PROJECT,
      // NEAR Intents has no testnet.
      oneClick: TESTNET ? '' : 'https://1click.chaindefuser.com/v0',
    };
const PAY_IN_PAGE = LOCAL || !TESTNET;
// Refunds go to an account the buyer's own wallet controls, so only chains with one are offered.
const CHAINS = { near: 'NEAR', base: 'Base', eth: 'Ethereum', arb: 'Arbitrum', op: 'Optimism', pol: 'Polygon', bsc: 'BNB Chain', avax: 'Avalanche', sol: 'Solana' };
const FAVOURITES = ['USDC', 'USDT', 'NEAR', 'wNEAR', 'SOL', 'ETH'];

const $ = (id) => document.getElementById(id);
const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Builds an element. Children are text or elements, so untrusted text stays text. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}

async function view(method, args = {}) {
  const response = await fetch(CONFIG.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'nobody',
      method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: CONFIG.contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  const data = await response.json();
  if (!data.result?.result) throw new Error(data.error?.message ?? 'The chain did not answer');
  return JSON.parse(new TextDecoder().decode(new Uint8Array(data.result.result)));
}

// ---- Reading the form ----

function parseRepo(value) {
  const text = value.trim().replace(/^https?:\/\//, '').replace(/^(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const [owner, name] = text.split('/');
  return owner && name && /^[A-Za-z0-9-]{1,39}$/.test(owner) && /^[A-Za-z0-9._-]{1,100}$/.test(name) ? `${owner}/${name}` : null;
}

function readForm() {
  $('problem').textContent = '';
  const repo = parseRepo($('repo').value);
  if (!repo) {
    $('problem').textContent = 'Enter a repo as owner/name or a GitHub link.';
    return null;
  }
  return { repo };
}

// ---- Free check, in the browser ----

async function exists(repo, path) {
  const response = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${path}`, { method: 'HEAD' });
  return response.ok;
}

async function readRaw(repo, path) {
  const response = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${path}`);
  return response.ok ? response.text() : null;
}

/** A few checks that cost nothing: they read the manifest the way the full review does. */
async function freeCheck(repo) {
  const rows = [];
  const add = (pass, title, detail) => rows.push({ pass, title, detail });
  const manifests = await Promise.all(['Cargo.toml', 'contract/Cargo.toml', 'contracts/Cargo.toml'].map((path) => readRaw(repo, path)));
  const readme = await readRaw(repo, 'README.md');
  if (!readme && !manifests.some(Boolean)) {
    add(false, 'Public repo', 'Nothing could be read. The repo may be private or misspelled, and the review can only read public code.');
    return rows;
  }
  add(true, 'Public repo', 'Readable from GitHub.');
  const withSdk = manifests.find((text) => text?.includes('near-sdk'));
  if (!withSdk) {
    add(false, 'A NEAR contract', 'No near-sdk in Cargo.toml at the top, in contract/ or in contracts/. The full review searches the whole repo.');
    return rows;
  }
  const version = withSdk.match(/near-sdk\s*=\s*(?:\{[^}]*version\s*=\s*)?"[\^~=]?(\d+)\.?([\d.]*)"/);
  const major = version ? Number(version[1]) : null;
  add(major === null || major >= 5, 'Current near-sdk', major === null ? 'The version is set by the workspace.' : major >= 5 ? `Version ${version[1]}.${version[2]}.` : `Version ${version[1]}.${version[2]} is behind the 5.x line.`);
  const checked = manifests.some((text) => text && /\[profile\.release\][^[]*overflow-checks\s*=\s*true/.test(text));
  add(checked, 'Overflow checks in release builds', checked ? 'Arithmetic that overflows will abort, not wrap.' : 'Add overflow-checks = true under [profile.release], so overflowing math aborts instead of wrapping.');
  const licences = await Promise.all(['LICENSE', 'LICENSE.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENCE'].map((path) => exists(repo, path)));
  add(licences.some(Boolean), 'A licence', licences.some(Boolean) ? 'Found.' : 'No LICENSE at the top of the repo, so others cannot safely reuse the code.');
  return rows;
}

function renderFree(rows) {
  $('free-rows').replaceChildren(...rows.map((row) => el('li', {},
    el('span', { className: `tag ${row.pass ? 'ok' : 'no'}`, textContent: row.pass ? 'PASS' : 'FIX' }),
    el('div', {}, el('b', { textContent: row.title }), el('span', { className: 'why', textContent: row.detail })))));
  $('free-out').hidden = false;
}

// ---- Paying ----

let order = null;
let tokens = [];

function base58Decode(text) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of text) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return fromHex(hex);
}

/** The account inside NEAR Intents that the buyer's own wallet controls. */
function refundTarget(chain, address) {
  const text = address.trim();
  if (chain === 'near') return /^[a-z0-9._-]{2,64}$/.test(text) ? `near:${text}` : null;
  if (chain === 'sol') {
    const key = base58Decode(text);
    return key?.length === 32 ? `intents:${toHex(key)}` : null;
  }
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? `intents:${text.toLowerCase()}` : null;
}

function orderMessage(refund) {
  const message = { repo: order.repo, pk: order.pk };
  if (refund) message.refund = refund;
  const referrer = new URLSearchParams(location.search).get('ref');
  if (referrer && /^[a-z0-9._-]{2,64}$/.test(referrer)) message.ref = referrer;
  return JSON.stringify(message);
}

async function loadTokens() {
  if (tokens.length || LOCAL) return;
  const list = await (await fetch(`${CONFIG.oneClick}/tokens`)).json();
  tokens = list.filter((token) => CHAINS[token.blockchain]);
  tokens.sort((a, b) => {
    const rank = (token) => (FAVOURITES.indexOf(token.symbol) + 1 || 99);
    return rank(a) - rank(b) || a.symbol.localeCompare(b.symbol);
  });
  $('token').replaceChildren(...tokens.map((token, index) => el('option', { value: String(index), textContent: `${token.symbol} on ${CHAINS[token.blockchain]}` })));
}

async function quote(price) {
  const token = tokens[Number($('token').value)];
  const refund = refundTarget(token.blockchain, $('refund').value);
  if (!refund) throw new Error(`Enter your address on ${CHAINS[token.blockchain]}.`);
  const response = await fetch(`${CONFIG.oneClick}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dry: false,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: 100,
      originAsset: token.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: `nep141:${USDC}`,
      amount: String(price),
      refundTo: $('refund').value.trim(),
      refundType: 'ORIGIN_CHAIN',
      recipient: CONFIG.contract,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
      customRecipientMsg: orderMessage(refund),
    }),
  });
  const data = await response.json();
  if (!data.quote?.depositAddress) throw new Error(data.message ?? 'No quote is available for this token right now.');
  return { ...data.quote, symbol: token.symbol };
}

function startOrder(form) {
  const keys = nacl.box.keyPair();
  order = { ...form, pk: toHex(keys.publicKey), secret: toHex(keys.secretKey) };
  $('free-out').hidden = true;
  $('report').hidden = true;
  $('deposit').hidden = true;
  $('pay-problem').textContent = '';
  $('pay').hidden = false;
  $('pay-real').hidden = LOCAL || !PAY_IN_PAGE;
  $('pay-local').hidden = !LOCAL;
  $('pay-testnet').hidden = PAY_IN_PAGE;
  $('pay-go').hidden = !PAY_IN_PAGE;
  $('pay-go').textContent = LOCAL ? 'Simulate the payment' : 'Get payment address';
  $('pay').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!PAY_IN_PAGE) return;
  loadTokens().catch(() => {
    $('pay-problem').textContent = 'Could not load the token list. Try again in a moment.';
  });
}

async function pay() {
  const problem = $('pay-problem');
  problem.textContent = '';
  if (!$('agree').checked) {
    problem.textContent = 'Please agree to the terms first.';
    return;
  }
  $('pay-go').disabled = true;
  try {
    const status = await view('get_status');
    if (!status.open) throw new Error(`Closed right now: ${status.closed_because}.`);
    if (LOCAL) {
      const response = await fetch('/sim/pay', {
        method: 'POST',
        body: JSON.stringify({ amount: status.price, msg: orderMessage('intents:0x2527d02599ba641c19fea793cd0f167589a0f10d') }),
      });
      if (!response.ok) throw new Error('The simulated payment failed.');
      $('pay').hidden = true;
    } else {
      const details = await quote(status.price);
      $('deposit-amount').textContent = `${details.amountInFormatted} ${details.symbol}`;
      $('deposit-address').textContent = details.depositAddress;
      $('deposit-memo-wrap').hidden = !details.depositMemo;
      $('deposit-memo').textContent = details.depositMemo ?? '';
      $('deposit').hidden = false;
      $('pay-go').hidden = true;
    }
    store('nobody:last', order.secret);
    history.replaceState(null, '', `#r=${order.secret}`);
    trackOrder(order.pk, order.secret);
  } catch (error) {
    problem.textContent = error.message;
  } finally {
    $('pay-go').disabled = false;
  }
}

// ---- Following an order ----

const STAGES = ['Waiting for your payment', 'Payment received, company awake', 'The enclave is reviewing your contract', 'Report delivered'];

function showStage(stage) {
  $('track').hidden = false;
  $('steps').replaceChildren(...STAGES.map((text, index) => el('li', {
    className: index < stage ? 'done' : index === stage ? 'now' : '',
    textContent: text,
  })));
}

async function trackOrder(pk, secret) {
  showStage(0);
  $('track-problem').textContent = '';
  for (let tick = 0; tick < 400; tick += 1) {
    const found = await view('find_order', { pk }).catch(() => null);
    if (found?.status === 'Running') showStage(2);
    if (found?.status === 'Delivered') {
      showStage(4);
      $('pay').hidden = true;
      await showReport(found, secret);
      refresh();
      return;
    }
    if (found && ['Refunding', 'Refunded', 'RefundFailed'].includes(found.status)) {
      showStage(1);
      const where = found.refund_to.startsWith('intents:') ? 'your own balance inside NEAR Intents' : 'your NEAR account';
      $('track-problem').textContent = `${usd(found.paid)} ${found.status === 'Refunded' ? 'was refunded to' : 'is being refunded to'} ${where}. Reason: ${found.reason}.`;
      return;
    }
    await sleep(3000);
  }
  $('track-problem').textContent = 'This is taking too long. If the work never finishes, anyone can trigger your refund after 15 minutes.';
}

async function fetchReport(id) {
  const url = `${CONFIG.storage}?project=${encodeURIComponent(CONFIG.project)}&key=${encodeURIComponent(`report:${id}`)}&format=raw`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    await sleep(1500);
  }
  throw new Error('The report is not available yet. Reload this page in a minute.');
}

async function showReport(found, secret) {
  try {
    const sealed = await fetchReport(found.id);
    const digest = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', sealed)));
    if (digest !== found.report_sha256) throw new Error('This report does not match the hash on chain.');
    const plain = nacl.box.open(sealed.subarray(56), sealed.subarray(32, 56), sealed.subarray(0, 32), fromHex(secret));
    if (!plain) throw new Error('This link cannot open the report.');
    renderReport(JSON.parse(new TextDecoder().decode(plain)), found);
  } catch (error) {
    $('track-problem').textContent = error.message;
  }
}

function renderReport(report, found) {
  const sheet = $('report');
  const { counts, stats } = report;
  // Red only when there is something to fear: a zero should read as good news.
  const tally = (key, label) => el('div', { className: counts[key] > 0 ? key : '' }, el('b', { textContent: String(counts[key]) }), el('span', { textContent: label }));
  const parts = [
    el('div', { className: 'head' },
      el('div', { className: 'tally' }, tally('high', 'high'), tally('medium', 'medium'), tally('low', 'low')),
      el('div', { className: 'seal' }, 'REVIEWED', el('br'), 'BY NOBODY')),
    el('div', { className: 'note', textContent: `${report.repo}: ${stats.contract_files} contract file${stats.contract_files === 1 ? '' : 's'}, ${stats.rust_files} Rust files, near-sdk ${stats.sdk ?? 'not found'}` }),
    el('p', { className: 'verdict', textContent: report.verdict }),
  ];
  if (counts.unreviewed) parts.push(el('p', { className: 'note', textContent: `${counts.unreviewed} candidate${counts.unreviewed === 1 ? ' was' : 's were'} not judged by the model, so ${counts.unreviewed === 1 ? 'it is' : 'they are'} not counted above.` }));

  const SEVERITY = { high: 'no', medium: 'no', low: 'hint', info: 'hint' };
  if (report.findings.length) {
    parts.push(el('h3', { textContent: 'Problems the review found' }));
    parts.push(el('ul', { className: 'rows' }, ...report.findings.map((finding) => el('li', {},
      el('span', { className: `tag ${SEVERITY[finding.severity]}`, textContent: finding.severity.toUpperCase() }),
      el('div', {}, el('b', { textContent: finding.title }),
        el('span', { className: 'why', textContent: `${finding.why} Fix: ${finding.fix}${finding.file ? ` (${finding.file})` : ''}` }))))));
  }

  if (report.candidates.length) {
    // Confirmed first, then what still needs a human eye, then what the model ruled out.
    const order = { confirmed: 0, unreviewed: 1, dismissed: 2 };
    const candidates = report.candidates.slice().sort((a, b) => order[a.status] - order[b.status]);
    parts.push(el('h3', { textContent: "NEAR's audit checklist" }));
    const LABEL = { confirmed: (candidate) => candidate.severity.toUpperCase(), unreviewed: () => 'OPEN', dismissed: () => 'OK' };
    parts.push(el('p', { className: 'note', textContent: 'OPEN means not yet judged by the model. OK means the model checked it and found no problem.' }));
    parts.push(el('ul', { className: 'rows' }, ...candidates.map((candidate) => el('li', {},
      el('span', { className: `tag ${candidate.status === 'confirmed' ? 'no' : candidate.status === 'dismissed' ? 'ok' : 'hint'}`, textContent: LABEL[candidate.status](candidate) }),
      el('div', {}, el('b', { textContent: `${candidate.title}, ${candidate.file}${candidate.line ? `:${candidate.line}` : ''}` }),
        el('span', { className: 'why', textContent: candidate.why ? `${candidate.detail} ${candidate.why}` : candidate.detail }))))));
  } else {
    parts.push(el('h3', { textContent: "NEAR's audit checklist" }));
    parts.push(el('p', { className: 'note', textContent: 'The static checks found nothing to flag.' }));
  }

  if (report.good.length) {
    parts.push(el('h3', { textContent: 'Done well' }));
    parts.push(el('ul', { className: 'rows' }, ...report.good.map((good) => el('li', {},
      el('span', { className: 'tag ok', textContent: 'GOOD' }), el('div', {}, el('b', { textContent: good }))))));
  }

  parts.push(el('p', { className: 'fine' },
    `Order ${report.order}. SHA-256 on chain: ${found.report_sha256}. Model: ${report.model}${report.inference_id ? `, inference ${report.inference_id}` : ''}. ${report.disclaimer}`));
  sheet.replaceChildren(...parts);
  sheet.hidden = false;
  sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- The door and the books ----

const LABELS = {
  Sale: 'Sale', AiCost: 'AI cost', ComputeCost: 'Compute', Payout: 'Payout', Refund: 'Refund',
  Refused: 'Turned away', PriceChange: 'Price set by AI', RuleChange: 'Owner', AiPurchase: 'AI bought',
  KeyChange: 'Key',
};

/** What the Detail column says. */
function detailOf(entry) {
  if (entry.kind === 'AiPurchase') return `${entry.to}, NEAR AI's staking contract`;
  return entry.to ?? entry.note ?? (entry.order ? `order ${entry.order}` : '');
}

const nearText = (yocto) => `${(Number(BigInt(yocto) / 10n ** 20n) / 1e4).toFixed(3)} NEAR`;

function amountOf(entry) {
  if (entry.kind === 'ComputeCost' || entry.kind === 'AiPurchase') return nearText(entry.amount);
  if (entry.kind === 'AiCost') return `$${(Number(entry.amount) / 1e6).toFixed(4)}`;
  if (entry.kind === 'RuleChange' || entry.kind === 'KeyChange') return '';
  return usd(entry.amount);
}

function clock(nanos) {
  return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString().slice(5, 16).replace('T', ' ');
}

function renderBooks(status, entries) {
  $('lamp').className = `lamp ${status.open ? 'on' : 'off'}`;
  $('sign-text').textContent = status.open
    ? `Open. ${usd(status.price)} a review. ${status.delivered} delivered.`
    : `Closed: ${status.closed_because}.`;
  $('buy').textContent = `Full review, ${usd(status.price)}`;
  const figures = [
    [usd(status.gross), 'sales'],
    [status.customers, 'paying customers'],
    [`$${(Number(status.ai_total) / 1e6).toFixed(4)}`, 'spent on AI'],
    [usd(status.paid_out), 'paid to contributors'],
    [usd(status.treasury), 'in the treasury'],
    [status.refunded, 'refunds'],
  ];
  $('figures').replaceChildren(...figures.map(([value, label]) => el('div', {}, el('b', { textContent: String(value) }), el('span', { textContent: label }))));
  const purchases = Number(status.ai_purchases);
  $('inference').textContent = purchases > 0
    ? `${nearText(status.ai_staked)} staked with NEAR AI, in ${purchases} purchase${purchases === 1 ? '' : 's'}. Its yield pays for the model, and the NEAR stays the company's.`
    : `No inference bought yet. Up to ${nearText(status.ai_stake_cap)} may be staked with NEAR AI, from NEAR above the ${nearText(status.keep_liquid)} kept for compute.`;
  const rows = entries.slice().reverse().map((entry) => el('tr', {},
    el('td', { className: 'when', textContent: clock(entry.at) }),
    el('td', { className: 'what', textContent: LABELS[entry.kind] ?? entry.kind }),
    el('td', { className: 'num', textContent: amountOf(entry) }),
    el('td', { textContent: detailOf(entry) })));
  $('ledger').replaceChildren(...rows);
  $('ledger-empty').hidden = entries.length > 0;
  const keeper = status.keeper
    ? ` Its enclave key ${status.keeper.slice(0, 16)}… can call buy_inference and nothing else.`
    : '';
  $('proof').textContent = `Contract ${CONFIG.contract}. Enclave build ${status.version_key.slice(0, 16)}… ${status.locked ? 'Locked for good.' : 'Not locked yet.'}${keeper}`;
}

async function refresh() {
  try {
    const status = await view('get_status');
    const from = Math.max(0, status.ledger_len - 40);
    renderBooks(status, await view('get_ledger', { from, limit: 40 }));
  } catch {
    $('lamp').className = 'lamp';
    $('sign-text').textContent = 'The chain is not answering. Try again soon.';
  }
}

// ---- Start ----

$('free').addEventListener('click', async () => {
  const form = readForm();
  if (!form) return;
  $('free').disabled = true;
  try {
    renderFree(await freeCheck(form.repo));
  } catch {
    $('problem').textContent = 'Could not reach GitHub from here. Try again in a moment.';
  } finally {
    $('free').disabled = false;
  }
});

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = readForm();
  if (form) startOrder(form);
});

$('pay-go').addEventListener('click', pay);

const saved = location.hash.match(/^#r=([0-9a-f]{64})$/)?.[1];
if (saved) {
  const keys = nacl.box.keyPair.fromSecretKey(fromHex(saved));
  trackOrder(toHex(keys.publicKey), saved);
}
refresh();
setInterval(refresh, 15000);
