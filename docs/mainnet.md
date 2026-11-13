# Putting Nobody on mainnet

**Not done yet.** This is the plan, step by step, with what each step costs. Testnet runs the same contract, enclave and scripts first.

## What it costs

At about $3.70 a NEAR, on 8 Nov 2026.

| What | NEAR | Spent or kept |
| --- | --- | --- |
| The contract's storage: 271 KB of code, the 66 KB page and its state | about 3.9 | Locked while the contract exists |
| Kept liquid for compute (`keep_liquid_near`) | 1 | The company's, spent a little per review |
| Staked with NEAR AI for inference (`ai_stake_cap_near`) | up to 2 | The company's, earning Cloud credits |
| OutLayer: project, upload, secrets | about 0.2 | Spent |
| Gas for setup | under 0.1 | Spent |
| **Total** | **about 7.2 NEAR, roughly $27** | |

The first real sale costs the buyer $1 plus 1Click's fee. That is the go/no-go test.

## Steps

1. **Accounts.** The company account (for example `hirenobody.near`) is created and funded from your account. The owner and the contributors' account can be your own named accounts.
2. **Contract.** Deploy `contract/res/nobody.wasm` and call `new` with the mainnet config:
   - USDC `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
   - `intents.near` and `outlayer.near`
   - farm `stake.dao`, product `prod_33Kp14MGUJa2QA`
3. **USDC storage.** Register the company and the contributors' account on the USDC contract, 0.00125 NEAR each.
4. **Page.** Run `node scripts/build-page.mjs <company> <project>`, then call `set_page`. The shop is served at `https://<company>.page`.
5. **Enclave.** Build it with `node scripts/build.mjs --production <company> <owner>`, then upload and deploy it with the OutLayer CLI. Store `NEARAI_API_KEY` locked to that build and to calls through the company, then call `set_enclave`. This is the same as `scripts/testnet.mjs enclave`.
6. **NEAR AI binding: a human step.** Sign in to cloud.near.ai with the company account and bind it as the organization's staking wallet. The enclave's NEAR AI key must belong to the same organization. NEAR AI needs a full-access key for this sign-in, and the binding is permanent.
7. **First sale.** Buy one review from another chain through the page. The first delivery makes the contract adopt the enclave's key. A later sale makes the enclave stake with NEAR AI.
8. **Lock down.** Once the keeper key is on the account, delete the company's full-access key, so the only key left can call `buy_inference` and nothing else. If the enclave and page will never change, call `lock` too. Neither step can be undone.

## Needs your yes

Spending, signing on mainnet, the NEAR AI sign-in, and both irreversible steps in 8.
