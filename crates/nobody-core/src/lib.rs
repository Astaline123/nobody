//! Nobody's business rules: how a sale is split, what a price may be, and which inputs the
//! company will accept. There is no chain access here, so every rule can be tested alone.

/// Basis points in a whole.
pub const BPS: u128 = 10_000;

const NANOS_PER_DAY: u64 = 86_400_000_000_000;

/// The most a human may send to contributors. The owner sets the split, so this cap, fixed in
/// the code, is what stops the owner turning a split into a withdrawal.
pub const MAX_CONTRIBUTORS_BPS: u16 = 5_000;
/// The most a referrer can earn from one sale.
pub const MAX_REFERRER_BPS: u16 = 3_000;
/// The most of a sale that can be set aside to buy and stake NEAR.
pub const MAX_STAKE_BPS: u16 = 5_000;
/// The company always keeps at least this much of a sale.
pub const MIN_TREASURY_BPS: u16 = 1_000;

/// How one sale is shared. Whatever is left goes to the treasury.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Split {
    pub contributors_bps: u16,
    pub referrer_bps: u16,
    pub stake_bps: u16,
}

impl Split {
    pub fn check(&self) -> Result<(), &'static str> {
        if self.contributors_bps > MAX_CONTRIBUTORS_BPS {
            return Err("contributors share is above the cap");
        }
        if self.referrer_bps > MAX_REFERRER_BPS {
            return Err("referrer share is above the cap");
        }
        if self.stake_bps > MAX_STAKE_BPS {
            return Err("stake share is above the cap");
        }
        let taken =
            self.contributors_bps as u32 + self.referrer_bps as u32 + self.stake_bps as u32;
        if taken + MIN_TREASURY_BPS as u32 > BPS as u32 {
            return Err("the treasury must keep at least 10% of a sale");
        }
        Ok(())
    }
}

/// One sale, divided. The parts always add up to the sale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shares {
    pub contributors: u128,
    pub referrer: u128,
    pub stake: u128,
    pub treasury: u128,
}

fn share(gross: u128, bps: u16) -> u128 {
    // A sale would need to exceed 3e34 USDC to overflow, and the contract panics if it does.
    gross * bps as u128 / BPS
}

/// Splits a sale. With no referrer, the referrer's share stays in the treasury. Rounding dust
/// also stays there, so nothing is lost and nothing is created.
pub fn split_sale(gross: u128, split: &Split, has_referrer: bool) -> Shares {
    let contributors = share(gross, split.contributors_bps);
    let referrer = if has_referrer { share(gross, split.referrer_bps) } else { 0 };
    let stake = share(gross, split.stake_bps);
    let treasury = gross - contributors - referrer - stake;
    Shares { contributors, referrer, stake, treasury }
}

/// Keeps a price the AI proposed inside the range a human set.
pub fn clamp_price(proposed: u128, min: u128, max: u128) -> u128 {
    proposed.max(min).min(max)
}

/// True when a payment meets the price, allowing for a small swap shortfall.
pub fn payment_covers(paid: u128, price: u128, tolerance_bps: u16) -> bool {
    let shortfall = price * tolerance_bps as u128 / BPS;
    paid >= price - shortfall
}

/// The smallest stake NEAR AI's farm takes: the `amount` of its farm price, 1 NEAR.
pub const MIN_FARM_STAKE: u128 = 1_000_000_000_000_000_000_000_000;

/// How much NEAR may go to NEAR AI's farm now. Only NEAR above what the company keeps liquid
/// for compute can go, never past the cap a human set, and nothing below the farm's minimum.
pub fn stake_due(free: u128, keep_liquid: u128, staked: u128, cap: u128) -> u128 {
    let room = cap.saturating_sub(staked);
    let amount = free.saturating_sub(keep_liquid).min(room);
    if amount < MIN_FARM_STAKE {
        0
    } else {
        amount
    }
}

/// The UTC day of a timestamp, used to reset the daily AI budget.
pub fn day_of(nanos: u64) -> u64 {
    nanos / NANOS_PER_DAY
}

/// True when another run may start without passing the daily AI budget. It assumes the run
/// costs its full reserve, so a burst of orders cannot overshoot the cap.
pub fn ai_budget_allows(spent_today: u128, reserve_per_run: u128, cap_per_day: u128) -> bool {
    spent_today.saturating_add(reserve_per_run) <= cap_per_day
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A GitHub repository as `owner/name`. The enclave builds its download URL from this, so a
/// strict shape here is what stops a buyer pointing it at another host.
pub fn valid_repo(repo: &str) -> bool {
    let Some((owner, name)) = repo.split_once('/') else {
        return false;
    };
    let owner_ok = (1..=39).contains(&owner.len())
        && !owner.starts_with('-')
        && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let name_ok = (1..=100).contains(&name.len())
        && name != "."
        && name != ".."
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    owner_ok && name_ok
}

/// A 32-byte public key in lowercase hex, which the report is encrypted to.
pub fn valid_public_key(key: &str) -> bool {
    key.len() == 64 && is_lower_hex(key)
}

/// A SHA-256 digest in lowercase hex.
pub fn valid_digest(digest: &str) -> bool {
    digest.len() == 64 && is_lower_hex(digest)
}

/// Where a refund goes. A buyer paying from another chain has no NEAR account, so their refund
/// goes to the account their own wallet controls inside NEAR Intents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefundTarget<'a> {
    Near(&'a str),
    Intents(&'a str),
}

/// Reads `near:<account>` or `intents:<account>`.
pub fn parse_refund(value: &str) -> Option<RefundTarget<'_>> {
    let (kind, account) = value.split_once(':')?;
    let target = match kind {
        "near" => RefundTarget::Near(account),
        "intents" => RefundTarget::Intents(account),
        _ => return None,
    };
    valid_account_shape(account).then_some(target)
}

/// A NEAR account shape: a named account, a 64-hex implicit account or a lowercase `0x` address.
pub fn valid_account_shape(account: &str) -> bool {
    if !(2..=64).contains(&account.len()) {
        return false;
    }
    account.split('.').all(|part| {
        !part.is_empty()
            && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
            && !part.starts_with(['-', '_'])
            && !part.ends_with(['-', '_'])
    })
}

/// Makes text from the AI safe to store: no control characters, and a hard length limit.
pub fn clean_note(note: &str, max_chars: usize) -> String {
    note.chars().filter(|c| !c.is_control()).take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPLIT: Split = Split { contributors_bps: 2_000, referrer_bps: 1_000, stake_bps: 1_000 };
    const DOLLAR: u128 = 1_000_000;

    #[test]
    fn a_sale_is_divided_exactly() {
        let s = split_sale(DOLLAR, &SPLIT, true);
        assert_eq!(s, Shares { contributors: 200_000, referrer: 100_000, stake: 100_000, treasury: 600_000 });
    }

    #[test]
    fn with_no_referrer_their_share_stays_in_the_treasury() {
        let s = split_sale(DOLLAR, &SPLIT, false);
        assert_eq!((s.referrer, s.treasury), (0, 700_000));
    }

    #[test]
    fn the_parts_always_add_up_to_the_sale() {
        let splits = [SPLIT, Split { contributors_bps: 3_333, referrer_bps: 1_111, stake_bps: 777 }];
        for gross in [0, 1, 3, 7, 999_999, 1_000_001, 123_456_789, u64::MAX as u128] {
            for split in &splits {
                for referred in [true, false] {
                    let s = split_sale(gross, split, referred);
                    assert_eq!(s.contributors + s.referrer + s.stake + s.treasury, gross);
                }
            }
        }
    }

    #[test]
    fn a_human_cannot_turn_the_split_into_a_withdrawal() {
        assert!(SPLIT.check().is_ok());
        assert!(Split { contributors_bps: 5_000, referrer_bps: 0, stake_bps: 0 }.check().is_ok());
        assert_eq!(
            Split { contributors_bps: 5_001, referrer_bps: 0, stake_bps: 0 }.check(),
            Err("contributors share is above the cap")
        );
        assert_eq!(
            Split { contributors_bps: 0, referrer_bps: 3_001, stake_bps: 0 }.check(),
            Err("referrer share is above the cap")
        );
        assert_eq!(
            Split { contributors_bps: 0, referrer_bps: 0, stake_bps: 5_001 }.check(),
            Err("stake share is above the cap")
        );
        assert_eq!(
            Split { contributors_bps: 4_000, referrer_bps: 1_000, stake_bps: 4_001 }.check(),
            Err("the treasury must keep at least 10% of a sale")
        );
        assert!(Split { contributors_bps: 4_000, referrer_bps: 1_000, stake_bps: 4_000 }.check().is_ok());
    }

    #[test]
    fn the_ai_cannot_price_outside_the_human_range() {
        assert_eq!(clamp_price(5, 10, 20), 10);
        assert_eq!(clamp_price(15, 10, 20), 15);
        assert_eq!(clamp_price(500, 10, 20), 20);
    }

    #[test]
    fn a_small_swap_shortfall_is_allowed_and_a_real_one_is_not() {
        assert!(payment_covers(DOLLAR, DOLLAR, 100));
        assert!(payment_covers(2 * DOLLAR, DOLLAR, 100));
        assert!(payment_covers(990_000, DOLLAR, 100));
        assert!(!payment_covers(989_999, DOLLAR, 100));
        assert!(!payment_covers(999_999, DOLLAR, 0));
    }

    #[test]
    fn the_daily_budget_counts_the_run_about_to_start() {
        assert!(ai_budget_allows(0, 50, 100));
        assert!(ai_budget_allows(50, 50, 100));
        assert!(!ai_budget_allows(51, 50, 100));
        assert!(!ai_budget_allows(u128::MAX, 50, 100));
    }

    #[test]
    fn only_spare_near_is_staked_for_inference_and_never_past_the_cap() {
        const NEAR: u128 = MIN_FARM_STAKE;
        // 10 free, keep 2 liquid, cap 5: stake 5.
        assert_eq!(stake_due(10 * NEAR, 2 * NEAR, 0, 5 * NEAR), 5 * NEAR);
        // 4 free, keep 2: only the 2 above what is kept liquid.
        assert_eq!(stake_due(4 * NEAR, 2 * NEAR, 0, 5 * NEAR), 2 * NEAR);
        // 4 already staked of a cap of 5: room for 1.
        assert_eq!(stake_due(10 * NEAR, 2 * NEAR, 4 * NEAR, 5 * NEAR), NEAR);
        // Under the farm's 1 NEAR minimum, nothing: the farm would refuse it.
        assert_eq!(stake_due(10 * NEAR, 2 * NEAR, 4 * NEAR + 1, 5 * NEAR), 0);
        assert_eq!(stake_due(3 * NEAR - 1, 2 * NEAR, 0, 5 * NEAR), 0);
        // Less free than the company keeps, or a cap already passed: nothing, never a panic.
        assert_eq!(stake_due(NEAR, 2 * NEAR, 0, 5 * NEAR), 0);
        assert_eq!(stake_due(10 * NEAR, 2 * NEAR, 9 * NEAR, 5 * NEAR), 0);
        // A cap of zero turns buying off.
        assert_eq!(stake_due(10 * NEAR, 2 * NEAR, 0, 0), 0);
    }

    #[test]
    fn days_roll_over_at_utc_midnight() {
        assert_eq!(day_of(0), 0);
        assert_eq!(day_of(NANOS_PER_DAY - 1), 0);
        assert_eq!(day_of(NANOS_PER_DAY), 1);
    }

    #[test]
    fn repos_are_owner_slash_name_and_nothing_else() {
        for good in ["near/near-sdk-rs", "a/b", "A-1/b_c.d", "near/.github"] {
            assert!(valid_repo(good), "{good}");
        }
        for bad in [
            "", "near", "/repo", "owner/", "owner/..", "owner/.", "-bad/repo",
            "owner/repo/extra", "evil.com/repo", "owner/re po", "owner/repo?x=1", "owner/repo#x",
            "https://github.com/near/near-sdk-rs",
        ] {
            assert!(!valid_repo(bad), "{bad}");
        }
        assert!(!valid_repo(&format!("{}/r", "o".repeat(40))));
        assert!(!valid_repo(&format!("o/{}", "r".repeat(101))));
    }

    #[test]
    fn keys_and_digests_are_lowercase_hex() {
        let ok = "ab".repeat(32);
        assert!(valid_public_key(&ok) && valid_digest(&ok));
        assert!(!valid_public_key(&"AB".repeat(32)));
        assert!(!valid_public_key(&"ab".repeat(31)));
        assert!(!valid_digest(&format!("{}zz", "ab".repeat(31))));
    }

    #[test]
    fn refunds_reach_near_accounts_and_intents_accounts() {
        assert_eq!(parse_refund("near:alice.near"), Some(RefundTarget::Near("alice.near")));
        let evm = "0x2527d02599ba641c19fea793cd0f167589a0f10d";
        assert_eq!(parse_refund(&format!("intents:{evm}")), Some(RefundTarget::Intents(evm)));
        let solana = "ab".repeat(32);
        assert_eq!(parse_refund(&format!("intents:{solana}")), Some(RefundTarget::Intents(solana.as_str())));
    }

    #[test]
    fn unusable_refund_targets_are_refused() {
        for bad in [
            "", "alice.near", "bitcoin:bc1q", "near:", "near:ALICE.near", "near:a",
            "near:alice..near", "near:-alice.near", "intents:0xABC", "near:alice near",
        ] {
            assert_eq!(parse_refund(bad), None, "{bad}");
        }
        assert_eq!(parse_refund(&format!("near:{}", "a".repeat(65))), None);
    }

    #[test]
    fn notes_lose_control_characters_and_are_cut_to_length() {
        assert_eq!(clean_note("price\n up\t", 100), "price up");
        assert_eq!(clean_note("abcdef", 3), "abc");
        assert_eq!(clean_note("héllo", 2), "hé");
    }
}
