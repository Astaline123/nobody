# Nobody

A company with no server, no staff and no keys. It sells private security reviews of NEAR smart contracts, and it buys its own AI. Built at NEAR HACKATHON for the Autonomous Business track (`business`).

**The problem.** Most NEAR contracts ship without an audit, because an audit costs thousands of dollars and weeks of waiting. NEAR publishes its own audit checklist, but someone still has to run it on every method of every contract. Meanwhile most "autonomous" businesses still have a human paying a server bill, so they stop when the founder does.

**The product.** Paste a GitHub repo and pay from any chain. That payment runs a NEAR contract, the contract starts pinned code in a secure enclave, and the enclave runs NEAR's audit checklist (`near-contract-audit`) over every Rust method. A private model then judges each finding. The report is sealed so only the buyer can read it, and the contract settles the sale or refunds the buyer. Then nothing is running. Idling costs nothing, so the company can wait a year for its next customer.

| | |
| --- | --- |
| **Who runs it?** | Nobody. No process of ours exists. A payment is the only thing that wakes it |
| **Who can take the money?** | Nobody. There is no withdraw function. The owner can only pause it or change its limits, and fixed caps in the code limit the split |
| **Who pays for the AI?** | The company. It stakes NEAR it can spare with NEAR AI, whose yield becomes Cloud credits. The NEAR stays the company's |
| **What keys does it have?** | After setup, one: a key that can call `buy_inference` and nothing else, derived inside OutLayer's TEE. Nobody holds it in plain text |
| **What does the AI decide?** | It writes the review and proposes a price, and the contract keeps the price inside a human range. The AI cannot move money |

**Status: built and tested locally. Not yet deployed on testnet or mainnet.** See [What is proven](#what-is-proven-and-what-is-not).

**Video:** [docs/demo/nobody-explained.mp4](docs/demo/nobody-explained.mp4) explains the problem and how Nobody solves it, in plain words, in 2 minutes 14 seconds.

## Try it

The first two steps need only Node 22 or newer: no keys, no wallet, no funds. They run the real compiled contract in `contract/res/nobody.wasm` on a small simulated chain.

1. **Do:** `npm run demo`
   **See:** nine steps of one company cycle, each with `PASS`, ending in `ALL CHECKS PASS` in under a second. A payment wakes the company, the money splits, and the company stakes 2 NEAR with NEAR AI using its enclave key. Then the same key fails to change the rules, a refund goes through, an AI price is clamped, and an owner fails to take the money.
2. **Do:** `npm test`
   **See:** 74 tests pass. They cover the money, every failure path, the keeper key's limits, signed transactions checked the way a node checks them, and each way of trying to cheat the company.
3. **Do:** `cargo test -p nobody-core -p nobody-review` (needs Rust)
   **See:** 68 tests pass. They cover the business rules, the audit checklist, zip bombs, secret scanning, prompt injection staying inside the untrusted block, and a purchase transaction that matches NEAR's own encoder byte for byte.
4. **Do:** install [wasmtime 28](https://github.com/bytecodealliance/wasmtime/releases/tag/v28.0.1), then `npm run review -- near-examples/coin-flip-examples`
   **See:** the real enclave wasm downloads NEAR's coin-flip example from GitHub, runs the checklist, and prints the report after sealing and opening it. It flags `simulate_coin_flip` at `contract-rs/src/lib.rs:12`, because it draws its result from `env::random_seed`, which NEAR's checklist warns a block producer can influence. It uses the same wasmtime release as OutLayer's worker. Without `NEARAI_API_KEY` the model is canned, so the finding stays open, and the report says so.
5. **Do:** `npm run shop`, then open http://127.0.0.1:8793
   **See:** the real shop. Paste a repo, run the free check, then simulate a payment. The report opens in your browser with a key that never leaves it, and the books update from the contract. The terminal prints each receipt tree, and from the second sale on, the purchase of inference too.
6. **Do:** with the shop running, `npm run e2e` (needs Edge or Chrome)
   **See:** a real browser buys two reviews, and 18 checks pass. The second sale's purchase of inference appears on the public ledger. Screenshots land in `docs/shots/`.

On testnet (see [Testnet](#testnet)): `npm run demo:testnet` runs one full loop, from sale to payout, and fails if it takes more than two minutes.

## What the track asks, and where it is

The track's brief is in [04-business.md](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/04-business.md). Its example product, a research shop, is swapped here for contract reviews, which NEAR developers can use. Every requirement stays.

| The track asks for | How Nobody does it | Proven |
| --- | --- | --- |
| Customers pay in whatever token they hold, through NEAR Intents | The page asks 1Click for a quote in any token 1Click lists. 1Click delivers USDC into the contract with `ft_transfer_call`, and that delivery starts the work | In simulation, with gas figures from a real mainnet delivery. 1Click accepts our quote format. **No real payment of ours yet** |
| The agent buys its own inference from NEAR AI Cloud | `buy_inference` stakes spare NEAR in NEAR AI's own staking farm (`stake.dao`). The farm turns the stake's yield into NEAR AI Cloud credits for the organization bound to the company's account | In simulation, against a copy of NEAR AI's contract built from its source. |
| A fixed share of every sale goes to contributors automatically | The settlement callback splits each sale and pays 20% to the contributors' account | Tested |
| `config.yaml`: maximum inference spend per day | The shop closes before a run could pass the cap | Tested |
| `config.yaml`: minimum price | The AI's price is clamped to the human range | Tested |
| `config.yaml`: revenue split | Caps in the code stop the owner turning the split into a withdrawal | Tested |
| `config.yaml`: kill switch | `pause` stops new orders and purchases, while running orders still finish or refund | Tested |
| Its own NEAR account, never a full-access key in plain text: OutLayer custody or a scoped function-call key | The company is a contract account. After setup its only key is a function-call key limited to `buy_inference`, with a gas allowance. OutLayer's keystore derives that key inside the TEE for this project and this contract. The enclave never sees it, and nobody else holds it | In simulation, which checks key permissions, nonces and signatures as a node does. **Testnet pending** |
| Every sale, cost and payout on a public ledger page | `get_ledger` on the contract. The page's "books" read it directly, and the contract serves the page itself through web4 | Tested in a real browser |
| A demo mode: one full loop on testnet, sale to payout, under two minutes | `npm run demo:testnet` | **Pending: see [Testnet](#testnet)** |

## How NEAR makes this possible

1. **NEAR Intents delivers into a contract.** With `customRecipientMsg`, 1Click delivers USDC by `ft_transfer_call`. In mainnet transaction [`94gPxba…`](https://nearblocks.io/txns/94gPxbaXa8cs4noBg1XvRNZF84TSi1HDJ3G1UVziCCSg), 258.7 Tgas reached `ft_on_transfer`. That is enough to start the work inside the buyer's own payment. So a buyer on Solana or Base wakes the company with no server, relayer or cron.
2. **Contracts can call enclaves.** `ft_on_transfer` calls `request_execution` on OutLayer, pinned to one wasm hash. The result comes back to `on_review`.
3. **NEAR AI Cloud runs the model privately.** `z-ai/glm-5.3-flash` runs in a TEE. A review costs about a cent.
4. **NEAR AI sells inference for staked NEAR.** Its staking contract `stake.dao` has a "NEAR AI Cloud Credits" farm (`prod_33Kp14MGUJa2QA`, "100 NEAR × 1 month = $1 credit"). A contract can stake there with a plain function call. It needs at least 300 Tgas, and NEAR's 1 PGas transaction limit leaves room for that.
5. **TEE-held keys can sign for a contract.** OutLayer's keystore derives an ed25519 key for one project and one calling contract. The contract adds that key to its own account, limited to one method. So code that only runs when someone pays can still send its own transactions, and no person holds the key.
6. **The account can be the whole company.** The contract serves the shop through `web4_get`.

```text
A sale (inside the buyer's own payment)
intents.near -> usdc :: ft_transfer_call                278.2 Tgas
  usdc -> company :: ft_on_transfer                     258.7 Tgas   the payment arrives
    company -> outlayer :: request_execution                         the company wakes
    company -> company :: on_review                                  the sale settles
      company -> usdc :: ft_transfer                                 contributors are paid

A purchase (sent by the enclave, signed by its TEE-held key)
company -> company :: buy_inference                     400 Tgas
  company -> stake.dao :: storage_deposit                            once
  company -> stake.dao :: stake                         369 Tgas     NEAR AI's farm
  company -> company :: on_bought                                    booked on the ledger
```

## The rules a human sets

`config.yaml` is the only thing a human controls, and the contract enforces every line.

| Rule | Where it is enforced |
| --- | --- |
| Maximum inference spend per day | `closed_because` in [`contract/src/lib.rs`](contract/src/lib.rs). The shop closes before the cap is passed |
| Minimum and maximum price | `clamp_price` in [`nobody-core`](crates/nobody-core/src/lib.rs) |
| Revenue split | `split_sale`. Caps in the code stop the owner turning a split into a withdrawal |
| Kill switch | `pause`. New orders and purchases stop, and running orders still finish or refund |
| How much NEAR may be staked for inference, and how much stays liquid | `stake_due`. The company only stakes NEAR above what it keeps for compute, never past the cap |

## What stops abuse

| Risk | Answer |
| --- | --- |
| Someone runs the enclave directly and spends our AI credits | The manifest admits one contract, and the secret's access rule names this contract and this build. Both are checked before anything is decrypted |
| The keeper key is stolen | It can only call `buy_inference`, which only stakes NEAR with NEAR AI, within the rules. It cannot attach money or call anything else, and its gas allowance is capped. The chain checks all of this before running anything |
| Anyone calls `buy_inference` | Let them. The contract alone decides whether and how much, so a caller can only make it do what it would do anyway |
| A README tries to talk the model into a clean report | Repo text sits in a marked untrusted block. The checklist runs in plain code, and a candidate the model never judged is shown as open, never as passed |
| A buyer points the enclave at another host | The contract and the enclave both accept only `owner/name`. The enclave builds the URL, and the manifest lists the only reachable hosts |
| The enclave answers late, twice or with rubbish | Anything but a complete answer for that exact order refunds the buyer. A run that never returns can be refunded by anyone after 15 minutes |
| A refund gets stranded | Refunds go to an address the buyer named, never back through `intents.near`, where `sender_id` hides who paid |
| A rival reads your report | Reports are sealed to a key made in your browser. Only the hash is public |

## What is proven, and what is not

| Claim | Status |
| --- | --- |
| The contract's logic, on the real compiled wasm | Tested in `sim/`, a small chain that runs real receipts, promises, deposits, storage staking, attached gas, access keys and ed25519 signatures. It does not meter wasm execution |
| The enclave, on the real wasm | Tested under wasmtime 28 against real GitHub repos. There is no TEE here, so public storage and the keystore are played by the local worker |
| The purchase transaction the enclave builds | Byte for byte what NEAR's `@near-js/transactions` encodes, and accepted by the simulated chain only with a valid signature, nonce and key permission |
| The review's AI judgement | **Not tested with a real model yet.** Local runs use a canned model, labelled as such in the report |
| NEAR AI's farm accepting a stake from a contract | Read from NEAR AI's source and live catalog. **Not yet done by Nobody** |
| How much inference the stake buys | At the live mainnet rate, each staked NEAR earns about $0.02 of credits a month, roughly four reviews. A small company stakes a little and grows its stake |
| Converting the USDC set aside from sales into NEAR | **Not built yet.** Today the company stakes NEAR from its own balance. The planned path is a NEAR Intents swap that the enclave quotes and the contract caps |
| 1Click delivery reaching a contract with 258.7 Tgas | Read from a real mainnet 1Click delivery, transaction `94gPxba…` |
| The whole chain in one flow on a real network | **Not proven yet: testnet is next** |
| Paying customers | **None yet** |

Nobody still relies on NEAR, 1Click, OutLayer, NEAR AI Cloud and GitHub. The honest claim is "no server that we run or pay for". OutLayer itself says its governance still runs on keys it holds.

## Testnet

NEAR Intents has no testnet, so a testnet buyer pays in test USDC (`usdc.fakes.testnet`) from a NEAR account. Everything else is the same code. The enclave runs on `outlayer.testnet`, and purchases go to NEAR AI's testnet farm (`stake-dao.testnet`, `prod_DMBHDlk4bg37Up`).

```text
npm run testnet -- setup <parent.testnet>   accounts, the contract, test USDC and the page, from one funded account
npm run testnet -- enclave                  builds the enclave for this contract and prints the OutLayer steps
npm run testnet -- point <sha256>           points the company at that build
npm run demo:testnet                        one full loop, sale to payout, timed
npm run testnet -- status                   balances, keys, the stake with NEAR AI
npm run testnet -- lockdown --yes           deletes the company's last full-access key
```

Keys stay where the near CLI keeps them (`~/.near-credentials/testnet`) or in environment variables, never in this repo. `deployments/testnet.json` holds account names only.

Mainnet follows the same steps, plus one a person must do: binding the company's account to a NEAR AI organization, so its stake pays for that organization's inference. The steps and costs are in [docs/mainnet.md](docs/mainnet.md).

## Layout

| Path | What it is |
| --- | --- |
| `contract/` | The company. `res/nobody.wasm` is the built contract |
| `crates/nobody-core/` | Money rules and input checks, with no dependencies |
| `crates/nobody-review/` | The review engine: the audit checklist, snapshots, prompts, sealing, and the keeper's transaction |
| `enclave/` | The program that runs on OutLayer. `res/` holds the local build |
| `web/` | The shop, as plain HTML and JavaScript with no external scripts or fonts |
| `sim/` | The local chain, tests, demo, worker and browser test |
| `scripts/` | Builds, the page packer, `config.yaml` reader, and the testnet tools with a small NEAR client |
| `film/` | The explainer video: its lines, pictures and voice. `scripts/explainer.ps1` builds it |
| `config.yaml` | The human constraints |

To rebuild, run `npm run build`. It needs Rust with the `wasm32-unknown-unknown` and `wasm32-wasip2` targets, and `cargo-near`.

## Libraries and tools

**Contract:** near-sdk. **Enclave:** wasi, outlayer (with `signing-keys`), serde_json, sha2, miniz_oxide, crypto_box. **Shop:** tweetnacl, vendored and unmodified. **Scripts and tests:** Node only, with no packages. **Local testing:** wasmtime. **Explainer video** (`film/`, separate from the product): kokoro-js reads the lines and Whisper, through @huggingface/transformers, checks them; both are Apache 2.0.

**AI:** this project was built with Claude Code. The review checklist follows NEAR's `near-contract-audit` skill. The farm facts were checked against NEAR AI's [house-of-stake-contracts](https://github.com/nearai/house-of-stake-contracts), and no code was copied from it.

All code was written during the hackathon window.

## License

MIT. See [LICENSE](LICENSE).
