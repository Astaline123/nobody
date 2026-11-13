// Builds everything and copies the results to the folders the repo tracks.
//
//   node scripts/build.mjs                 contract and local enclave
//   node scripts/build.mjs --production <contract account> <secrets owner>
//
// The production enclave has the contract's name inside it, so the hash differs per deployment.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '1' };

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} failed`);
    process.exit(1);
  }
}

function report(name, path) {
  const bytes = readFileSync(path);
  console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KB, sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
}

const [flag, contract, owner] = process.argv.slice(2);
mkdirSync(`${root}enclave/res`, { recursive: true });
mkdirSync(`${root}contract/res`, { recursive: true });

if (flag === '--production') {
  if (!contract || !owner) {
    console.error('usage: node scripts/build.mjs --production <contract account> <secrets owner>');
    process.exit(1);
  }
  const manifest = readFileSync(`${root}enclave/manifest.template.json`, 'utf8')
    .replaceAll('__CONTRACT__', contract)
    .replaceAll('__SECRETS_OWNER__', owner);
  writeFileSync(`${root}enclave/manifest.json`, manifest);
  run('cargo', ['build', '--target', 'wasm32-wasip2', '--release', '--features', 'outlayer', '--target-dir', 'target-outlayer'], `${root}enclave`);
  const out = `${root}enclave/res/nobody-enclave.${contract}.wasm`;
  copyFileSync(`${root}enclave/target-outlayer/wasm32-wasip2/release/nobody-enclave.wasm`, out);
  // Cargo does not rebuild when only manifest.json changed, so check the manifest really is
  // the one just written. A stale one could name another contract or lack the keeper key.
  if (!readFileSync(out).includes(Buffer.from(manifest))) {
    console.error('The built enclave does not hold the manifest just written. Run: cargo clean --target-dir target-outlayer, then build again.');
    process.exit(1);
  }
  report('production enclave', out);
} else {
  run('cargo', ['near', 'build', 'non-reproducible-wasm', '--no-abi'], `${root}contract`);
  copyFileSync(`${root}target/near/nobody/nobody.wasm`, `${root}contract/res/nobody.wasm`);
  report('contract', `${root}contract/res/nobody.wasm`);
  run('cargo', ['build', '--target', 'wasm32-wasip2', '--release'], `${root}enclave`);
  copyFileSync(`${root}enclave/target/wasm32-wasip2/release/nobody-enclave.wasm`, `${root}enclave/res/nobody-enclave.local.wasm`);
  report('local enclave', `${root}enclave/res/nobody-enclave.local.wasm`);
}
