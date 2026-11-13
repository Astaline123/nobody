// Runs one real review on this machine: the real enclave wasm, reading a real public repo.
//
//   node sim/review.mjs owner/repo
//
// With NEARAI_API_KEY set it asks the real model. Without one it uses a canned model, the
// candidates stay unreviewed, and the report says so. Nothing is paid and nothing goes on chain.
import { randomBytes } from 'node:crypto';
import { nacl, open } from './open.mjs';
import { enclaveBuilt, runEnclave, startModel } from './worker.mjs';

const [repo] = process.argv.slice(2);
if (!repo) {
  console.error('usage: node sim/review.mjs owner/repo');
  process.exit(1);
}
if (!enclaveBuilt()) {
  console.error('Build the enclave first: see the README.');
  process.exit(1);
}

const keys = nacl().box.keyPair.fromSecretKey(new Uint8Array(randomBytes(32)));
const pk = Buffer.from(keys.publicKey).toString('hex');
const realKey = process.env.NEARAI_API_KEY;
const model = realKey ? null : await startModel();
const env = realKey ? { NEARAI_API_KEY: realKey } : { NEARAI_API_KEY: 'canned', NOBODY_LLM_URL: model.url };

const started = Date.now();
const output = await runEnclave({ v: 2, order: 1, repo, pk }, env);
model?.server.close();
const line = JSON.parse(output);
if (!line.ok) {
  console.error(`The run failed: ${line.error}`);
  process.exit(1);
}
const report = open(Buffer.from(line.local_sealed_hex, 'hex'), keys.secretKey);
delete line.local_sealed_hex;

const { counts, stats } = report;
console.log(`\n${report.repo}  (${((Date.now() - started) / 1000).toFixed(1)}s, ${report.model})`);
console.log(`${stats.contract_files} contract files, ${stats.rust_files} Rust files, near-sdk ${stats.sdk ?? 'not found'}`);
console.log(`Problems: ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Unreviewed candidates: ${counts.unreviewed}.`);
console.log(report.verdict);
for (const finding of report.findings) console.log(`\n  [${finding.severity}] ${finding.title} (${finding.file})\n    ${finding.why}\n    Fix: ${finding.fix}`);
if (report.candidates.length) console.log('\nCandidates from the static rules');
for (const candidate of report.candidates) {
  console.log(`  ${candidate.status.padEnd(10)} [${candidate.severity}] ${candidate.file}:${candidate.line}  ${candidate.detail}${candidate.why ? `\n             ${candidate.why}` : ''}`);
}
for (const good of report.good) console.log(`  good: ${good}`);
console.log(`\nWhat the contract would receive (${JSON.stringify(line).length} bytes, limit 900):`);
console.log(JSON.stringify(line));
