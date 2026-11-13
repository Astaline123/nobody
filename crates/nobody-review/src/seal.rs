//! Seals a report so that only the buyer can read it. Sealed reports sit in public storage, so
//! anyone can see that a report exists and nothing more.
//!
//! The format is NaCl box, which `tweetnacl` opens in the browser:
//! 32 bytes of one-time public key, then 24 bytes of nonce, then the ciphertext.

use crypto_box::aead::Aead;
use crypto_box::{Nonce, PublicKey, SalsaBox, SecretKey};
use sha2::{Digest, Sha256};

fn from_hex(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(text.get(index * 2..index * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// Seals `plain` to the buyer's key. `secret` and `nonce` must be fresh random bytes.
pub fn seal(plain: &[u8], buyer_key: &str, secret: [u8; 32], nonce: [u8; 24]) -> Option<Vec<u8>> {
    let buyer = PublicKey::from(from_hex(buyer_key)?);
    let secret = SecretKey::from(secret);
    let cipher = SalsaBox::new(&buyer, &secret).encrypt(&Nonce::from(nonce), plain).ok()?;
    let mut sealed = Vec::with_capacity(56 + cipher.len());
    sealed.extend_from_slice(secret.public_key().as_bytes());
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&cipher);
    Some(sealed)
}

/// The hash the contract records, so a buyer can prove the report is the one that was paid for.
pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn open(sealed: &[u8], secret: [u8; 32]) -> Option<Vec<u8>> {
        let sender = PublicKey::from(<[u8; 32]>::try_from(&sealed[..32]).ok()?);
        let nonce = Nonce::from(<[u8; 24]>::try_from(&sealed[32..56]).ok()?);
        SalsaBox::new(&sender, &SecretKey::from(secret)).decrypt(&nonce, &sealed[56..]).ok()
    }

    const BUYER: [u8; 32] = [7; 32];

    fn buyer_key() -> String {
        hex(SecretKey::from(BUYER).public_key().as_bytes())
    }

    #[test]
    fn the_buyer_can_open_it() {
        let sealed = seal(b"your report", &buyer_key(), [1; 32], [2; 24]).unwrap();
        assert_eq!(open(&sealed, BUYER).unwrap(), b"your report");
    }

    #[test]
    fn nobody_else_can() {
        let sealed = seal(b"your report", &buyer_key(), [1; 32], [2; 24]).unwrap();
        assert_eq!(open(&sealed, [8; 32]), None);
    }

    #[test]
    fn a_changed_byte_is_caught() {
        let mut sealed = seal(b"your report", &buyer_key(), [1; 32], [2; 24]).unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert_eq!(open(&sealed, BUYER), None);
    }

    #[test]
    fn the_text_does_not_appear_in_the_output() {
        let plain = b"score: 42 out of 100";
        let sealed = seal(plain, &buyer_key(), [1; 32], [2; 24]).unwrap();
        assert!(!sealed.windows(plain.len()).any(|part| part == plain));
    }

    #[test]
    fn a_bad_key_is_refused() {
        assert_eq!(seal(b"x", "not hex", [1; 32], [2; 24]), None);
        assert_eq!(seal(b"x", &"zz".repeat(32), [1; 32], [2; 24]), None);
    }

    #[test]
    fn digests_are_sha256_hex() {
        assert_eq!(digest(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
