// Packs the shop into one file, so the contract can serve it with no other host.
//
//   node scripts/build-page.mjs <contract account> <enclave project id>
//
// It writes web/dist/index.html and, next to it, the base64 body that `set_page` takes. A
// contract on `.testnet` gets a page that reads testnet.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function buildPage(contract = 'hirenobody.near', project = `${contract}/enclave`) {
  const web = new URL('../web/', import.meta.url);
  const read = (path) => readFileSync(new URL(path, web), 'utf8');
  const source = read('app.js');
  for (const placeholder of ["const CONTRACT = 'hirenobody.near';", "const PROJECT = 'hirenobody.near/enclave';"]) {
    if (!source.includes(placeholder)) throw new Error(`web/app.js no longer has: ${placeholder}`);
  }
  const app = source
    .replace("const CONTRACT = 'hirenobody.near';", () => `const CONTRACT = ${JSON.stringify(contract)};`)
    .replace("const PROJECT = 'hirenobody.near/enclave';", () => `const PROJECT = ${JSON.stringify(project)};`);
  const inline = (code) => `<script>${code.replaceAll('</script', '<\\/script')}</script>`;
  const html = read('index.html')
    .replace('<script src="vendor/nacl-fast.min.js"></script>', () => inline(read('vendor/nacl-fast.min.js')))
    .replace('<script src="app.js"></script>', () => inline(app));
  mkdirSync(new URL('dist/', web), { recursive: true });
  writeFileSync(new URL('dist/index.html', web), html);
  const body = Buffer.from(html).toString('base64');
  writeFileSync(new URL('dist/page.base64.txt', web), body);
  return { html, body };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { html, body } = buildPage(...process.argv.slice(2));
  console.log(`page: ${(html.length / 1024).toFixed(1)} KB, about ${((body.length + 200) / 100_000).toFixed(2)} NEAR of contract storage`);
}
