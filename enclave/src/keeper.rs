//! The keeper: buys the company's inference after a sale.
//!
//! OutLayer's keystore derives an ed25519 key inside the TEE for this project and for the
//! contract that started the run. This code never sees that key. It reports the public half in
//! every delivery line, and the contract adopts it as a key on its own account that can call
//! `buy_inference` and nothing else. When the contract asks, this code builds that one call,
//! has the keystore sign it, and sends it through OutLayer's RPC proxy.
//!
//! A local build has no keystore and no chain. The worker plays both: it names the public key,
//! answers the access-key lookup, and signs the transaction this run hands back, then checks
//! it the way a node would.

use nobody_core::valid_account_shape;
use nobody_review::keeper::{encode, hash, public_key_text, read_access_key, BuyTx};
#[cfg(feature = "outlayer")]
use nobody_review::keeper::{base64, signed};

#[cfg(feature = "outlayer")]
mod host {
    use outlayer::raw::rpc;
    use outlayer::signing_keys;

    /// Declared in the manifest, so it is covered by the build's hash.
    const PATH: &str = "keeper";

    pub fn public_key() -> Result<[u8; 32], String> {
        let key = signing_keys::public_key(PATH, None).map_err(|error| format!("no keeper key: {error:?}"))?;
        key.try_into().map_err(|_| "the keeper key is not ed25519".to_string())
    }

    pub fn access_key(account: &str, key: &str) -> Result<String, String> {
        let (answer, error) = rpc::view_access_key(account, key, "final");
        if error.is_empty() { Ok(answer) } else { Err(format!("access key lookup failed: {error}")) }
    }

    pub fn sign(digest: &[u8; 32]) -> Result<Vec<u8>, String> {
        signing_keys::sign(PATH, None, digest).map_err(|error| format!("the keystore did not sign: {error:?}"))
    }

    pub fn send(signed_base64: &str) -> Result<(), String> {
        // NONE: hand it to the network and go. The contract records what the purchase did.
        let (_, error) = rpc::send_tx(signed_base64, "NONE");
        if error.is_empty() { Ok(()) } else { Err(format!("the transaction was not sent: {error}")) }
    }
}

#[cfg(not(feature = "outlayer"))]
mod host {
    fn unhex(text: &str) -> Option<Vec<u8>> {
        if text.len() % 2 != 0 {
            return None;
        }
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
    }

    pub fn public_key() -> Result<[u8; 32], String> {
        let text = std::env::var("NOBODY_LOCAL_KEEPER").map_err(|_| "no keeper key in this run")?;
        unhex(&text).and_then(|bytes| bytes.try_into().ok()).ok_or_else(|| "NOBODY_LOCAL_KEEPER is not 32 bytes of hex".to_string())
    }

    pub fn access_key(_account: &str, _key: &str) -> Result<String, String> {
        std::env::var("NOBODY_LOCAL_ACCESS_KEY").map_err(|_| "access key lookup failed: no answer in this run".to_string())
    }
}

/// What the keeper did, for the delivery line, and in a local run the unsigned transaction.
#[derive(Default)]
pub struct Kept {
    pub fields: Vec<(&'static str, String)>,
    pub unsigned: Option<Vec<u8>>,
}

/// Reports the keeper key, and buys inference when the contract asked for it. Nothing here
/// can fail the order: the report is already published when this runs.
pub fn keep(asked_to_buy: bool) -> Kept {
    let mut kept = Kept::default();
    let Ok(key) = host::public_key() else { return kept };
    kept.fields.push(("keeper", public_key_text(&key)));
    if !asked_to_buy {
        return kept;
    }
    match buy(&key) {
        Ok((tx_hash, bytes)) => {
            kept.fields.push(("buy", tx_hash));
            if cfg!(not(feature = "outlayer")) {
                kept.unsigned = Some(bytes);
            }
        }
        Err(reason) => kept.fields.push(("buy_error", reason.chars().take(120).collect())),
    }
    kept
}

/// Builds the one transaction the key may sign: `buy_inference` on the contract that started
/// this run, from that contract's own account. Returns its hash and its unsigned bytes.
fn buy(key: &[u8; 32]) -> Result<(String, Vec<u8>), String> {
    let account = std::env::var("NEAR_PREDECESSOR_ID")
        .ok()
        .filter(|account| valid_account_shape(account))
        .ok_or("no calling contract in this run")?;
    let answer = host::access_key(&account, &public_key_text(key))?;
    let (nonce, block_hash) = read_access_key(&answer, &account).ok_or("the key cannot buy on this account yet")?;
    let bytes = encode(&BuyTx { account, public_key: *key, nonce: nonce + 1, block_hash });
    let digest = hash(&bytes);
    #[cfg(feature = "outlayer")]
    {
        let signature = host::sign(&digest)?;
        let signed = signed(&bytes, &signature).ok_or("the keystore's signature is not 64 bytes")?;
        host::send(&base64(&signed))?;
    }
    Ok((nobody_review::keeper::base58(&digest), bytes))
}
