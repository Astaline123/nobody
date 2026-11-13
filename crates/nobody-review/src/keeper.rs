//! The keeper's one transaction: `buy_inference`, sent from the company's own account.
//!
//! OutLayer's keystore derives an ed25519 key inside the TEE for this project and the contract
//! that started the run. The contract adopts that key as a key on its own account that can call
//! `buy_inference` and nothing else. This module builds the transaction for that key to sign:
//! NEAR's borsh `Transaction` (version 0) with a single function call. The keystore signs the
//! sha256 of these bytes, and never sees anything else from this code.
//!
//! Every field is fixed here except the account, the nonce and the block hash, so whatever
//! answers the RPC calls cannot make the key sign anything but this one call.

use sha2::{Digest, Sha256};
use serde_json::Value;

pub const BUY_METHOD: &str = "buy_inference";
/// `buy_inference` refuses less than 345 Tgas. This leaves a margin above that.
pub const BUY_GAS: u64 = 400_000_000_000_000;

const ED25519: u8 = 0;
const FUNCTION_CALL: u8 = 2;
const BASE58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// What changes from one purchase to the next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuyTx {
    /// The company: it signs, and it receives the call.
    pub account: String,
    pub public_key: [u8; 32],
    pub nonce: u64,
    pub block_hash: [u8; 32],
}

fn string(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(&(text.len() as u32).to_le_bytes());
    out.extend_from_slice(text.as_bytes());
}

/// The borsh bytes of the transaction: what is hashed and signed.
pub fn encode(tx: &BuyTx) -> Vec<u8> {
    let args = b"{}";
    let mut out = Vec::with_capacity(160);
    string(&mut out, &tx.account);
    out.push(ED25519);
    out.extend_from_slice(&tx.public_key);
    out.extend_from_slice(&tx.nonce.to_le_bytes());
    string(&mut out, &tx.account);
    out.extend_from_slice(&tx.block_hash);
    out.extend_from_slice(&1u32.to_le_bytes());
    out.push(FUNCTION_CALL);
    string(&mut out, BUY_METHOD);
    out.extend_from_slice(&(args.len() as u32).to_le_bytes());
    out.extend_from_slice(args);
    out.extend_from_slice(&BUY_GAS.to_le_bytes());
    out.extend_from_slice(&0u128.to_le_bytes());
    out
}

/// What the key signs, and also the transaction's hash on explorers.
pub fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// A `SignedTransaction`: the transaction, then its ed25519 signature.
pub fn signed(bytes: &[u8], signature: &[u8]) -> Option<Vec<u8>> {
    if signature.len() != 64 {
        return None;
    }
    let mut out = bytes.to_vec();
    out.push(ED25519);
    out.extend_from_slice(signature);
    Some(out)
}

pub fn base58(bytes: &[u8]) -> String {
    let zeros = bytes.iter().take_while(|byte| **byte == 0).count();
    let mut digits: Vec<u8> = Vec::new();
    for byte in bytes {
        let mut carry = *byte as u32;
        for digit in digits.iter_mut() {
            carry += (*digit as u32) << 8;
            *digit = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = "1".repeat(zeros);
    out.extend(digits.iter().rev().map(|digit| BASE58[*digit as usize] as char));
    out
}

pub fn from_base58(text: &str) -> Option<Vec<u8>> {
    let zeros = text.bytes().take_while(|char| *char == b'1').count();
    let mut bytes: Vec<u8> = Vec::new();
    for char in text.bytes() {
        let mut carry = BASE58.iter().position(|known| *known == char)? as u32;
        for byte in bytes.iter_mut() {
            carry += (*byte as u32) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let mut out = vec![0u8; zeros];
    out.extend(bytes.iter().rev());
    Some(out)
}

pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(BASE64[(n >> shift & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// `ed25519:<base58>`, the way NEAR writes a public key.
pub fn public_key_text(key: &[u8; 32]) -> String {
    format!("ed25519:{}", base58(key))
}

/// Reads a `view_access_key` answer: the nonce to go after, and a block hash to build on. It
/// takes the RPC's `result` or the bare object. A key that cannot call `buy_inference` on this
/// account is refused here, so a transaction that would be rejected is never signed.
pub fn read_access_key(answer: &str, account: &str) -> Option<(u64, [u8; 32])> {
    let value: Value = serde_json::from_str(answer).ok()?;
    let key = value.get("result").unwrap_or(&value);
    let nonce = key["nonce"].as_u64()?;
    let block_hash: [u8; 32] = from_base58(key["block_hash"].as_str()?)?.try_into().ok()?;
    let call = &key["permission"]["FunctionCall"];
    let allowed = call["receiver_id"] == account
        && call["method_names"].as_array().is_some_and(|names| names.iter().any(|name| *name == BUY_METHOD));
    allowed.then_some((nonce, block_hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encoded by NEAR's own `@near-js/transactions` 2.5.1, which produced identical bytes.
    const OFFICIAL: &str = "0f000000686972656e6f626f64792e6e65617200fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618141a99be1c0000000f000000686972656e6f626f64792e6e656172070707070707070707070707070707070707070707070707070707070707070701000000020d0000006275795f696e666572656e6365020000007b7d0000e941cc6b010000000000000000000000000000000000";
    const KEY: &str = "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618";

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }

    fn sample() -> BuyTx {
        BuyTx {
            account: "hirenobody.near".into(),
            public_key: unhex(KEY).try_into().unwrap(),
            nonce: 123_456_789_012,
            block_hash: [7; 32],
        }
    }

    #[test]
    fn the_transaction_is_byte_for_byte_what_near_js_encodes() {
        assert_eq!(encode(&sample()), unhex(OFFICIAL));
        assert_eq!(base58(&hash(&encode(&sample()))), "EMnwMstLKZnPdNH8ZgDiYUhmZX8eECh8FxUVGWqYHoxe");
    }

    #[test]
    fn keys_and_hashes_read_the_way_near_writes_them() {
        let key: [u8; 32] = unhex(KEY).try_into().unwrap();
        assert_eq!(public_key_text(&key), "ed25519:J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf");
        assert_eq!(base58(&[7; 32]), "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");
        assert_eq!(base58(&[0; 32]), "1".repeat(32));
        for bytes in [vec![], vec![0], vec![0, 0, 1], key.to_vec(), vec![255; 40]] {
            assert_eq!(from_base58(&base58(&bytes)).unwrap(), bytes);
        }
        assert_eq!(from_base58("0OIl"), None, "not base58");
    }

    #[test]
    fn base64_matches_the_standard_alphabet_with_padding() {
        assert_eq!(base64(b"nobody?"), "bm9ib2R5Pw==");
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"abc"), "YWJj");
    }

    #[test]
    fn a_signed_transaction_is_the_transaction_then_the_signature() {
        let bytes = encode(&sample());
        let signed = signed(&bytes, &[1; 64]).unwrap();
        assert_eq!(&signed[..bytes.len()], &bytes[..]);
        assert_eq!(signed[bytes.len()], 0);
        assert_eq!(&signed[bytes.len() + 1..], &[1; 64]);
        assert_eq!(super::signed(&bytes, &[1; 63]), None);
    }

    #[test]
    fn only_a_key_that_can_buy_on_this_account_is_used() {
        let answer = |receiver: &str, method: &str| {
            format!(
                r#"{{"jsonrpc":"2.0","result":{{"block_hash":"US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx","block_height":1,"nonce":41,"permission":{{"FunctionCall":{{"allowance":"1000000000000000000000000","method_names":["{method}"],"receiver_id":"{receiver}"}}}}}}}}"#
            )
        };
        assert_eq!(read_access_key(&answer("hirenobody.near", "buy_inference"), "hirenobody.near"), Some((41, [7; 32])));
        assert_eq!(read_access_key(&answer("other.near", "buy_inference"), "hirenobody.near"), None);
        assert_eq!(read_access_key(&answer("hirenobody.near", "pause"), "hirenobody.near"), None);
        assert_eq!(read_access_key(r#"{"error":"UNKNOWN_ACCESS_KEY"}"#, "hirenobody.near"), None);
        assert_eq!(read_access_key("not json", "hirenobody.near"), None);
    }
}
