// Uses the shop the way a buyer does, in a real browser, against `npm run shop`.
//
//   node sim/e2e.mjs [owner/repo]
//
// Needs Edge or Chrome, found through BROWSER or the usual install paths. It installs nothing.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [repo = 'near-examples/coin-flip-examples'] = process.argv.slice(2);
// The default repo is NEAR's own coin-flip example, whose checklist finding is known.
const EXPECTED = { 'near-examples/coin-flip-examples': 'contract-rs/src/lib.rs:12' }[repo];
const SHOP = process.env.SHOP ?? 'http://127.0.0.1:8793';
const PORT = Number(process.env.DEBUG_PORT ?? 9343);
const SHOTS = new URL('../docs/shots/', import.meta.url);
mkdirSync(SHOTS, { recursive: true });

const candidates = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const binary = candidates.find((path) => existsSync(path));
if (!binary) {
  console.error('No browser found. Set BROWSER to Edge or Chrome.');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'nobody-e2e-'));
const browser = spawn(binary, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(passed, text) {
  if (!passed) failures += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${text}`);
}

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = pages.find((target) => target.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      await sleep(300);
    }
  }
  throw new Error('the browser did not start');
}

const socket = new WebSocket(await connect());
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
let nextId = 1;
const waiting = new Map();
const errors = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && waiting.has(message.id)) {
    waiting.get(message.id)(message.result ?? message.error);
    waiting.delete(message.id);
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? 'error');
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args[0]?.value ?? 'console error');
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return result.result?.value;
}

async function until(expression, seconds, what) {
  for (let tick = 0; tick < seconds * 4; tick += 1) {
    if (await evaluate(expression)) return true;
    await sleep(250);
  }
  check(false, `timed out waiting for ${what}`);
  return false;
}

async function shot(name, { width = 1100, height = 800, full = true } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(250);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  writeFileSync(new URL(`${name}.png`, SHOTS), Buffer.from(data, 'base64'));
}

const type = (id, value) => evaluate(`(() => { const box = document.getElementById(${JSON.stringify(id)}); box.value = ${JSON.stringify(value)}; box.dispatchEvent(new Event('input')); })()`);
const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const text = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
const visible = (id) => evaluate(`!document.getElementById(${JSON.stringify(id)}).hidden`);

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: SHOP });
  await until(`document.getElementById('sign-text')?.textContent.startsWith('Open')`, 15, 'the live status from the contract');
  check((await text('sign-text')).startsWith('Open'), `the door reads from the contract: "${await text('sign-text')}"`);
  check((await text('buy')).includes('$'), `the price is live: "${await text('buy')}"`);
  await shot('home');

  await click('buy');
  check((await text('problem')).includes('owner/name'), 'an empty repo is refused with a clear message');

  await type('repo', `https://github.com/${repo}`);
  await click('free');
  await until(`!document.getElementById('free-out').hidden`, 20, 'the free check');
  const rows = await evaluate(`document.querySelectorAll('#free-rows li').length`);
  check(rows >= 1, `the free check runs in the browser and shows ${rows} findings`);
  await shot('free-check');

  await click('buy');
  await until(`!document.getElementById('pay').hidden`, 5, 'the payment panel');
  await click('pay-go');
  check((await text('pay-problem')).includes('terms'), 'nobody can pay without agreeing to the terms');
  await evaluate(`document.getElementById('agree').click()`);
  await click('pay-go');
  await until(`!document.getElementById('track').hidden`, 10, 'the order tracker');
  check(true, 'a simulated payment started the order');

  await until(`!document.getElementById('report').hidden`, 120, 'the report');
  const high = await evaluate(`document.querySelector('#report .tally b')?.textContent`);
  check(/^\d+$/.test(high ?? ''), `the sealed report opened in the browser, ${high} confirmed high-severity problems`);
  const hash = await evaluate(`location.hash.length`);
  check(hash === 67, 'the report link holds the key in the fragment, which is never sent to a server');
  const listed = await evaluate(`document.querySelectorAll('#report .rows li').length`);
  check(listed >= 1, `${listed} checklist candidates are on the page`);
  const report = await text('report');
  check((!EXPECTED || report.includes(EXPECTED)) && report.includes('OPEN'), `a real hole in a real contract is shown${EXPECTED ? ` at ${EXPECTED}` : ''}, and honestly marked unjudged`);
  const sales = await evaluate(`document.querySelector('#figures b')?.textContent`);
  check(/^\$[1-9]/.test(sales ?? ''), `the books updated as soon as the report arrived: ${sales} in sales`);
  await shot('report');
  await shot('report-phone', { width: 390, height: 844 });

  await evaluate(`refresh()`);
  await until(`document.getElementById('ledger').children.length >= 3`, 15, 'the ledger');
  const ledger = await evaluate(`document.getElementById('ledger').textContent`);
  check(ledger.includes('Sale') && ledger.includes('Payout'), 'the sale and its payout reached the public ledger');
  const horizontal = await evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
  check(!horizontal, 'no sideways scroll at phone width');
  await shot('books', { width: 1100, height: 800 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await shot('light', { width: 1100, height: 800 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await shot('dark-top', { width: 1100, height: 800, full: false });

  const reloaded = `${SHOP}/${await evaluate('location.hash')}`;
  await send('Page.navigate', { url: reloaded });
  await until(`!document.getElementById('report').hidden`, 30, 'the report after a reload');
  check(true, 'the report link reopens the report after a reload');

  // The first sale gave the company its enclave key, so a second sale also buys inference.
  await send('Page.navigate', { url: SHOP });
  await until(`document.getElementById('sign-text')?.textContent.startsWith('Open')`, 15, 'the shop again');
  await type('repo', `https://github.com/${repo}`);
  await click('buy');
  await until(`!document.getElementById('pay').hidden`, 5, 'the payment panel');
  await evaluate(`document.getElementById('agree').click()`);
  await click('pay-go');
  await until(`!document.getElementById('report').hidden`, 120, 'the second report');
  await evaluate(`refresh()`);
  await until(`document.getElementById('ledger').textContent.includes('AI bought')`, 15, 'the purchase on the ledger');
  check((await text('ledger')).includes('AI bought'), 'a second sale also bought inference, on the public ledger');
  const bought = await text('inference');
  check(bought.includes('staked with NEAR AI'), `the books say what was bought: "${bought}"`);
  check((await text('proof')).includes('can call buy_inference and nothing else'), 'the page shows the only key the company has');
  await shot('books-bought', { width: 1100, height: 800 });

  check(errors.length === 0, `no browser errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
} finally {
  socket.close();
  browser.kill();
  await sleep(600);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // The browser may still hold a file for a moment. It is only a temp folder.
  }
}
console.log(failures ? `\n${failures} CHECKS FAILED` : '\nALL CHECKS PASS');
process.exit(failures ? 1 : 0);
