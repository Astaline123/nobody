//! Nobody: an AI company with no server, no staff and no keys.
//!
//! Nothing runs until someone pays. A payment reaches `ft_on_transfer`, which asks OutLayer to
//! run pinned code in an enclave. The answer comes back to `on_review`, which settles the sale
//! or refunds the buyer. The contract moves money by fixed rules. The AI only writes text and
//! proposes a price, and the owner can only stop the company or change its limits.
//!
//! The company also buys its own inference. NEAR AI sells Cloud credits for staked NEAR: the
//! stake's yield becomes credits. `buy_inference` stakes the NEAR the company can spare into
//! NEAR AI's farm. The enclave calls it after a sale, signing with a key that OutLayer's TEE
//! derives for this project and this contract. That key can call `buy_inference` and nothing
//! else, and it never exists in plain text.
//!
//! Once a buyer's money is in, no path may panic. A panic would hand the money back through
//! `intents.near`, where a buyer on another chain cannot reach it, so refusals and failures
//! always end in an explicit refund to the address the buyer gave.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{LazyOption, LookupMap, Vector};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Allowance, CurveType, Gas, GasWeight,
    NearToken, PanicOnDefault, Promise, PublicKey,
};
use nobody_core::{
    ai_budget_allows, clamp_price, clean_note, day_of, parse_refund, payment_covers, split_sale,
    stake_due, valid_digest, valid_public_key, valid_repo, RefundTarget, Split,
};

/// Passed to OutLayer as a minimum. Any gas left over goes to it too.
const RUN_GAS: Gas = Gas::from_tgas(100);
/// Settling pays up to two accounts, and refunding through Intents needs a deep call.
const REVIEW_CALLBACK_GAS: Gas = Gas::from_tgas(80);
/// A real 1Click delivery reaches `ft_on_transfer` with about 258 Tgas.
const MIN_ORDER_GAS: Gas = Gas::from_tgas(195);
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);
const FT_CALL_GAS: Gas = Gas::from_tgas(50);
/// These callbacks record who is owed money, so they must never run out of gas.
const NOTE_CALLBACK_GAS: Gas = Gas::from_tgas(12);

/// OutLayer returns at most 900 bytes. Anything larger is not a valid answer.
const MAX_OUTPUT_BYTES: usize = 1024;
const MAX_REPORT_BYTES: u64 = 256 * 1024;
const MAX_NOTE_CHARS: usize = 240;
const MAX_LIST: u32 = 100;
/// An order still running after this can be refunded by anyone.
const STUCK_AFTER_NS: u64 = 15 * 60 * 1_000_000_000;
/// A buyer quoted just before a price change still pays the old price for this long.
const PRICE_GRACE_NS: u64 = 20 * 60 * 1_000_000_000;
/// 1%, for the small gap a cross-chain swap can leave.
const PAYMENT_TOLERANCE_BPS: u16 = 100;

/// NEAR AI's staking contract refuses a stake that arrives with less than 300 Tgas.
const FARM_STAKE_GAS: Gas = Gas::from_tgas(305);
const FARM_STORAGE_GAS: Gas = Gas::from_tgas(10);
const BUY_CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// The stake, a first-time registration, the callback, and `buy_inference` itself.
const MIN_BUY_GAS: Gas = Gas::from_tgas(345);
/// Registers the company with NEAR AI's staking contract: its 0.01 NEAR minimum plus one farm
/// position at 0.005. What is left over stays the company's, as prepaid storage there.
const FARM_STORAGE: NearToken = NearToken::from_millinear(20);
/// A farm position is a few hundred bytes of JSON.
const MAX_POSITION_BYTES: usize = 4096;
/// Gas the keeper key may spend. A purchase reserves about 0.4 NEAR while it runs and burns a
/// small part of that, so this covers dozens of purchases.
const KEEPER_ALLOWANCE: NearToken = NearToken::from_near(1);
/// The only method the keeper key can call.
const KEEPER_METHODS: &str = "buy_inference";

/// Everything fixed when the company is created.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Config {
    /// Sets limits and can stop the company. Has no way to take the money.
    pub owner: AccountId,
    pub usdc: AccountId,
    pub intents: AccountId,
    pub outlayer: AccountId,
    pub contributors: AccountId,
    pub project_id: String,
    /// The sha256 of the enclave build. Only this exact code runs.
    pub version_key: String,
    /// Workers silently ignore a request that omits any of these.
    pub max_instructions: U64,
    pub max_memory_mb: u32,
    pub max_execution_seconds: u64,
    /// NEAR AI's staking contract: `stake.dao` on mainnet, `stake-dao.testnet` on testnet.
    pub farm: AccountId,
    /// Its "NEAR AI Cloud Credits" product, whose farm turns staked NEAR into credits.
    pub farm_product: String,
}

/// The human constraints, mirrored from `config.yaml`.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Rules {
    /// The kill switch.
    pub paused: bool,
    pub min_price: U128,
    pub max_price: U128,
    /// Maximum inference spend per day, in millionths of a dollar.
    pub max_ai_per_day: U128,
    /// What one run is assumed to cost until the enclave reports the real figure.
    pub ai_reserve_per_run: U128,
    pub contributors_bps: u16,
    pub referrer_bps: u16,
    pub stake_bps: u16,
    /// The AI reviews the price every this many sales. Zero turns that off.
    pub board_every: u32,
    /// NEAR attached to each run. OutLayer refunds what it does not use.
    pub run_deposit: U128,
    /// Orders stop when free NEAR would fall below this.
    pub near_floor: U128,
    /// The most NEAR the company may keep staked with NEAR AI to buy inference. Zero stops
    /// buying.
    pub ai_stake_cap: U128,
    /// NEAR the company always keeps liquid for compute. Only NEAR above this is staked.
    pub keep_liquid: U128,
}

impl Rules {
    fn split(&self) -> Split {
        Split {
            contributors_bps: self.contributors_bps,
            referrer_bps: self.referrer_bps,
            stake_bps: self.stake_bps,
        }
    }

    fn check(&self) {
        if let Err(reason) = self.split().check() {
            env::panic_str(reason);
        }
        require!(self.min_price.0 > 0, "min_price must be above zero");
        require!(self.min_price.0 <= self.max_price.0, "min_price is above max_price");
        require!(self.ai_reserve_per_run.0 > 0, "ai_reserve_per_run must be above zero");
        // Buying inference must never be what closes the shop.
        require!(
            self.keep_liquid.0 >= self.near_floor.0 + self.run_deposit.0,
            "keep_liquid must cover near_floor plus one run"
        );
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OrderStatus {
    /// Paid, and the enclave is working.
    Running,
    /// The report is published and the sale is settled.
    Delivered,
    /// A refund is on its way.
    Refunding,
    Refunded,
    /// The refund failed. Anyone can call `retry_refund`.
    RefundFailed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Order {
    pub id: u64,
    /// The GitHub repository whose contract is reviewed, as owner/name.
    pub repo: String,
    /// The buyer's public key. The report is sealed to it, so only the buyer can read it.
    pub pk: String,
    pub paid: U128,
    pub referrer: Option<AccountId>,
    pub refund_to: String,
    /// Bought by the team. Kept on the ledger, and never counted as a customer.
    pub team: bool,
    pub status: OrderStatus,
    pub created_at: U64,
    pub finished_at: Option<U64>,
    pub report_sha256: Option<String>,
    pub report_len: Option<u64>,
    pub reason: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EntryKind {
    /// A delivered order. `amount` is USDC.
    Sale,
    /// `amount` is millionths of a dollar of AI, as reported by the enclave.
    AiCost,
    /// `amount` is the NEAR attached to a run. Most of it comes back as a refund.
    ComputeCost,
    /// USDC paid out. `to` says who received it.
    Payout,
    /// USDC returned to a buyer.
    Refund,
    /// An order the company turned away. `amount` is the USDC it was offered.
    Refused,
    /// A price the AI chose. `amount` is the new price.
    PriceChange,
    /// The owner changed a rule or the kill switch.
    RuleChange,
    /// Inference bought from NEAR AI. `amount` is yoctoNEAR staked in its farm, which stays
    /// the company's while its yield pays for Cloud credits.
    AiPurchase,
    /// A key on the company's own account was added or removed. `note` says which.
    KeyChange,
}

/// One line of the public ledger. The page reads these directly from the contract.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Entry {
    pub at: U64,
    pub kind: EntryKind,
    pub order: Option<u64>,
    pub amount: U128,
    pub to: Option<AccountId>,
    pub note: Option<String>,
}

/// A sale is recorded only once the work is delivered.
#[near(serializers = [borsh])]
#[derive(Default)]
pub struct Books {
    pub orders: u64,
    pub delivered: u64,
    pub refunded: u64,
    pub customers: u64,
    pub team_orders: u64,
    pub gross: u128,
    pub paid_out: u128,
    pub treasury: u128,
    pub stake_pool: u128,
    pub ai_total: u128,
    pub ai_day: u64,
    pub ai_today: u128,
    pub sales_since_board: u32,
    /// yoctoNEAR the company has staked with NEAR AI for credits.
    pub ai_staked: u128,
    pub ai_purchases: u64,
}

#[near(serializers = [json])]
pub struct Status {
    pub open: bool,
    pub closed_because: Option<String>,
    pub paused: bool,
    pub locked: bool,
    pub price: U128,
    pub min_price: U128,
    pub max_price: U128,
    pub orders: U64,
    pub delivered: U64,
    pub refunded: U64,
    pub customers: U64,
    pub team_orders: U64,
    pub gross: U128,
    pub paid_out: U128,
    pub treasury: U128,
    pub stake_pool: U128,
    pub ai_total: U128,
    pub ai_today: U128,
    pub max_ai_per_day: U128,
    pub near_free: U128,
    pub near_floor: U128,
    pub ledger_len: u32,
    pub owner: AccountId,
    pub contributors: AccountId,
    pub project_id: String,
    pub version_key: String,
    pub ai_staked: U128,
    pub ai_purchases: U64,
    pub ai_stake_cap: U128,
    pub keep_liquid: U128,
    /// NEAR that `buy_inference` would stake if called now.
    pub stake_due: U128,
    pub farm: AccountId,
    pub farm_product: String,
    /// The enclave's key on this account, once it has been adopted.
    pub keeper: Option<PublicKey>,
}

/// What a buyer's payment carries in `msg`.
#[derive(Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct OrderMsg {
    pub repo: String,
    pub pk: String,
    #[serde(default, rename = "ref")]
    pub referrer: Option<AccountId>,
    #[serde(default)]
    pub refund: Option<String>,
    #[serde(default)]
    pub team: bool,
}

/// A valid answer from the enclave.
#[derive(Debug, PartialEq)]
struct Delivery {
    sha256: String,
    len: u64,
    ai_cost: u128,
    board: Option<(u128, String)>,
    /// The ed25519 key OutLayer's keystore derives for this project and this contract.
    keeper: Option<PublicKey>,
}

/// Anything but a complete answer for this exact order means no delivery. That covers
/// OutLayer's `null` on a timed-out run, which arrives as a successful promise.
fn read_delivery(value: &Value, order_id: u64) -> Option<Delivery> {
    if value["v"] != 1 || value["ok"] != true || value["order"].as_u64()? != order_id {
        return None;
    }
    let sha256 = value["sha256"].as_str()?;
    let len = value["len"].as_u64()?;
    if !valid_digest(sha256) || len == 0 || len > MAX_REPORT_BYTES {
        return None;
    }
    let ai_cost = value["ai"].as_u64()? as u128;
    let board = value.get("board").and_then(|board| {
        let price = board["price"].as_str()?.parse::<u128>().ok()?;
        let note = clean_note(board["note"].as_str().unwrap_or(""), MAX_NOTE_CHARS);
        Some((price, note))
    });
    // A missing or unreadable key never spoils a delivery. It only means no key is adopted.
    let keeper = value["keeper"]
        .as_str()
        .and_then(|key| key.parse::<PublicKey>().ok())
        .filter(|key| key.curve_type() == CurveType::ED25519);
    Some(Delivery { sha256: sha256.to_string(), len, ai_cost, board, keeper })
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Nobody {
    config: Config,
    rules: Rules,
    price: u128,
    old_price: u128,
    price_changed_at: u64,
    /// True once the enclave and the page can never change again.
    locked: bool,
    pause_reason: Option<String>,
    books: Books,
    next_order: u64,
    orders: LookupMap<u64, Order>,
    /// A buyer's public key to their order, so a browser can find what it paid for.
    by_key: LookupMap<String, u64>,
    /// Payouts that failed, usually because the receiver has no USDC storage yet.
    owed: LookupMap<AccountId, u128>,
    ledger: Vector<Entry>,
    /// The shop itself, base64, served through web4.
    page: LazyOption<String>,
    /// The enclave's key on this account. It can only call `buy_inference`.
    keeper: Option<PublicKey>,
    /// True once NEAR AI's staking contract holds storage for this account.
    farm_registered: bool,
    /// When the purchase on its way started, or zero. One at a time keeps the books simple,
    /// and a purchase that never reports back stops blocking the next after a while.
    buying_since: u64,
}

#[near]
impl Nobody {
    #[init]
    pub fn new(config: Config, rules: Rules, price: U128) -> Self {
        rules.check();
        require!(
            price.0 >= rules.min_price.0 && price.0 <= rules.max_price.0,
            "price is outside the range"
        );
        require!(valid_digest(&config.version_key), "version_key must be a sha256");
        Self {
            config,
            rules,
            price: price.0,
            old_price: price.0,
            price_changed_at: 0,
            locked: false,
            pause_reason: None,
            books: Books::default(),
            next_order: 1,
            orders: LookupMap::new(b"o"),
            by_key: LookupMap::new(b"k"),
            owed: LookupMap::new(b"w"),
            ledger: Vector::new(b"l"),
            page: LazyOption::new(b"p", None),
            keeper: None,
            farm_registered: false,
            buying_since: 0,
        }
    }

    // ---- The company at work ----

    /// The front door. Every sale starts here, on the buyer's own payment.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(env::predecessor_account_id() == self.config.usdc, "Only USDC is accepted");
        let paid = amount.0;
        let order_msg = serde_json::from_str::<OrderMsg>(&msg).ok();
        let refund_to = self.refund_target(&sender_id, order_msg.as_ref());

        let refusal = match &order_msg {
            Some(order_msg) => self.why_refuse(order_msg, paid),
            None => Some("the order could not be read".to_string()),
        };
        let (Some(order_msg), None) = (&order_msg, refusal.as_ref()) else {
            let reason = refusal.unwrap_or_default();
            emit("refused", json!({ "amount": amount, "reason": reason }));
            // A wallet gets its money straight back, so a refusal costs it only gas. It must
            // not also cost the company storage, or a loop of tiny payments would drain the
            // NEAR that pays for compute. A cross-chain payment pays 1Click's fee each time.
            if sender_id == self.config.intents {
                self.record(EntryKind::Refused, None, paid, None, Some(reason.clone()));
            }
            let key = order_msg.map(|order_msg| order_msg.pk).filter(|key| valid_public_key(key));
            return self.turn_away(&sender_id, paid, refund_to, reason, key);
        };
        let order_msg = OrderMsg {
            repo: order_msg.repo.clone(),
            pk: order_msg.pk.clone(),
            referrer: order_msg.referrer.clone(),
            refund: None,
            team: order_msg.team,
        };

        // A valid order always has a refund target, or `why_refuse` would have refused it.
        let order = self.open_order(order_msg, paid, refund_to.unwrap_or_default());
        self.start_run(&order);
        U128(0)
    }

    /// The enclave's answer, or OutLayer's report that there is none.
    #[private]
    pub fn on_review(&mut self, order_id: u64) {
        let Some(order) = self.orders.get(&order_id).cloned() else { return };
        // `expire` may already have refunded a run that came back very late.
        if order.status != OrderStatus::Running {
            return;
        }
        let delivery = env::promise_result_checked(0, MAX_OUTPUT_BYTES)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| read_delivery(&value, order_id));
        match delivery {
            Some(delivery) => self.settle(order, delivery),
            None => self.refund(order, "the work failed, so nothing is charged"),
        }
    }

    #[private]
    pub fn on_payout(&mut self, to: AccountId, amount: U128, order: Option<u64>) {
        if near_sdk::is_promise_success() {
            self.books.paid_out += amount.0;
            self.record(EntryKind::Payout, order, amount.0, Some(to), None);
        } else {
            let owed = self.owed.get(&to).copied().unwrap_or(0) + amount.0;
            self.owed.insert(to, owed);
        }
    }

    #[private]
    pub fn on_refund(&mut self, order_id: u64) {
        let Some(mut order) = self.orders.get(&order_id).cloned() else { return };
        let done = match env::promise_result_checked(0, MAX_OUTPUT_BYTES) {
            // `ft_transfer` returns nothing. `ft_transfer_call` returns the amount the
            // receiver kept, and anything short of everything means the refund did not land.
            Ok(bytes) if bytes.is_empty() => true,
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes).is_ok_and(|kept| kept == order.paid),
            Err(_) => false,
        };
        if done {
            order.status = OrderStatus::Refunded;
            self.books.refunded += 1;
            self.record(EntryKind::Refund, Some(order.id), order.paid.0, None, order.reason.clone());
            emit("refund", json!({ "order": order.id, "amount": order.paid, "to": order.refund_to }));
        } else {
            order.status = OrderStatus::RefundFailed;
        }
        order.finished_at = Some(U64(env::block_timestamp()));
        self.orders.insert(order_id, order);
    }

    // ---- The company buys its own inference ----

    /// Buys NEAR AI Cloud credits the way NEAR AI sells them for NEAR: by staking in its farm,
    /// whose yield becomes credits for the NEAR AI organization this account is bound to. The
    /// NEAR stays the company's. The enclave's keeper key calls this after a sale, and anyone
    /// else may too: the contract alone decides whether to buy and how much, from the rules,
    /// so a caller can only make it do what it would do anyway. Returns whether it bought.
    pub fn buy_inference(&mut self) -> bool {
        if self.rules.paused || self.buying() {
            return false;
        }
        require!(env::prepaid_gas() >= MIN_BUY_GAS, "buy_inference needs at least 345 Tgas");
        let amount = self.stake_due();
        if amount == 0 {
            return false;
        }
        self.buying_since = env::block_timestamp();
        let farm = self.config.farm.clone();
        // NEAR AI's contract runs a long pipeline behind `stake`, so it also gets whatever gas
        // the caller attached beyond what this call needs.
        let stake = Promise::new(farm.clone()).function_call_weight(
            "stake",
            json!({ "product_id": self.config.farm_product }).to_string().into_bytes(),
            NearToken::from_yoctonear(amount),
            FARM_STAKE_GAS,
            GasWeight(1),
        );
        let purchase = if self.farm_registered {
            stake
        } else {
            Promise::new(farm)
                .function_call(
                    "storage_deposit",
                    json!({ "account_id": env::current_account_id() }).to_string().into_bytes(),
                    FARM_STORAGE,
                    FARM_STORAGE_GAS,
                )
                .then(stake)
        };
        purchase
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(BUY_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_bought(U128(amount)),
            )
            .detach();
        emit("buying", json!({ "amount": U128(amount), "farm": self.config.farm }));
        true
    }

    /// NEAR AI's contract answers a stake with the farm position. Anything else means the stake
    /// did not happen, and the protocol has returned the NEAR attached to it.
    #[private]
    pub fn on_bought(&mut self, amount: U128) {
        self.buying_since = 0;
        let staked = env::promise_result_checked(0, MAX_POSITION_BYTES)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|position| position["product_id"] == json!(self.config.farm_product));
        if !staked {
            emit("buy_failed", json!({ "amount": amount }));
            return;
        }
        self.farm_registered = true;
        self.books.ai_staked += amount.0;
        self.books.ai_purchases += 1;
        let note = format!("staked with NEAR AI; its yield buys Cloud credits ({})", self.config.farm_product);
        self.record(EntryKind::AiPurchase, None, amount.0, Some(self.config.farm.clone()), Some(note));
        emit("bought", json!({ "amount": amount, "farm": self.config.farm }));
    }

    // ---- Anyone can call these. None of them needs trust. ----

    /// Refunds an order whose run never came back.
    pub fn expire(&mut self, order_id: u64) {
        let order = self.orders.get(&order_id).cloned().expect("No such order");
        require!(order.status == OrderStatus::Running, "Order is not running");
        require!(
            env::block_timestamp() >= order.created_at.0 + STUCK_AFTER_NS,
            "Order is still within its time limit"
        );
        self.refund(order, "the run never came back, so nothing is charged");
    }

    /// Sends a failed refund again, to the same address as before.
    pub fn retry_refund(&mut self, order_id: u64) {
        let mut order = self.orders.get(&order_id).cloned().expect("No such order");
        require!(order.status == OrderStatus::RefundFailed, "No refund is waiting");
        order.status = OrderStatus::Refunding;
        self.send_refund(&order);
        self.orders.insert(order_id, order);
    }

    /// Sends a payout that failed, to the account it was meant for.
    pub fn claim(&mut self, account: AccountId) {
        let amount = self.owed.remove(&account).expect("Nothing is owed");
        self.pay(account, amount, None);
    }

    // ---- What a human may do. There is deliberately no way to withdraw. ----

    /// Sets the constraints. The split caps in `nobody-core` hold whatever the owner sends.
    #[payable]
    pub fn set_rules(&mut self, rules: Rules) {
        self.assert_owner();
        rules.check();
        self.rules = rules;
        let price = clamp_price(self.price, self.rules.min_price.0, self.rules.max_price.0);
        self.set_price(price);
        self.record(EntryKind::RuleChange, None, 0, None, Some("rules changed".to_string()));
    }

    /// The kill switch. Orders already running still finish or refund.
    #[payable]
    pub fn pause(&mut self, reason: Option<String>) {
        self.assert_owner();
        self.rules.paused = true;
        self.pause_reason = reason.map(|reason| clean_note(&reason, MAX_NOTE_CHARS));
        self.record(EntryKind::RuleChange, None, 0, None, Some("kill switch on".to_string()));
    }

    #[payable]
    pub fn resume(&mut self) {
        self.assert_owner();
        self.rules.paused = false;
        self.pause_reason = None;
        self.record(EntryKind::RuleChange, None, 0, None, Some("kill switch off".to_string()));
    }

    /// Points the company at a new enclave build, until `lock` is called. Another project
    /// derives another keeper key, so the old key is removed and the next delivery brings the
    /// new one.
    #[payable]
    pub fn set_enclave(&mut self, project_id: String, version_key: String) {
        self.assert_owner();
        require!(!self.locked, "The company is locked");
        require!(valid_digest(&version_key), "version_key must be a sha256");
        self.config.project_id = project_id;
        self.config.version_key = version_key;
        if let Some(old) = self.keeper.take() {
            let note = format!("enclave key {old} removed, for a new enclave");
            Promise::new(env::current_account_id()).delete_key(old).detach();
            self.record(EntryKind::KeyChange, None, 0, None, Some(note));
        }
    }

    /// Points purchases at another NEAR AI farm, until `lock` is called.
    #[payable]
    pub fn set_farm(&mut self, farm: AccountId, farm_product: String) {
        self.assert_owner();
        require!(!self.locked, "The company is locked");
        require!(!self.buying(), "A purchase is on its way");
        require!(self.books.ai_staked == 0, "NEAR is already staked with the current farm");
        self.config.farm = farm;
        self.config.farm_product = farm_product;
        self.farm_registered = false;
    }

    /// Stores the shop page, until `lock` is called.
    #[payable]
    pub fn set_page(&mut self, body_base64: String) {
        self.assert_owner();
        require!(!self.locked, "The company is locked");
        self.page.set(Some(body_base64));
    }

    /// Fixes the enclave and the page for good. It cannot be undone.
    #[payable]
    pub fn lock(&mut self) {
        self.assert_owner();
        self.locked = true;
        self.record(EntryKind::RuleChange, None, 0, None, Some("company locked".to_string()));
    }

    // ---- Views ----

    pub fn get_status(&self) -> Status {
        let closed_because = self.closed_because();
        Status {
            open: closed_because.is_none(),
            closed_because,
            paused: self.rules.paused,
            locked: self.locked,
            price: U128(self.price),
            min_price: self.rules.min_price,
            max_price: self.rules.max_price,
            orders: U64(self.books.orders),
            delivered: U64(self.books.delivered),
            refunded: U64(self.books.refunded),
            customers: U64(self.books.customers),
            team_orders: U64(self.books.team_orders),
            gross: U128(self.books.gross),
            paid_out: U128(self.books.paid_out),
            treasury: U128(self.books.treasury),
            stake_pool: U128(self.books.stake_pool),
            ai_total: U128(self.books.ai_total),
            ai_today: U128(self.ai_spent_today()),
            max_ai_per_day: self.rules.max_ai_per_day,
            near_free: U128(self.free_near()),
            near_floor: self.rules.near_floor,
            ledger_len: self.ledger.len(),
            owner: self.config.owner.clone(),
            contributors: self.config.contributors.clone(),
            project_id: self.config.project_id.clone(),
            version_key: self.config.version_key.clone(),
            ai_staked: U128(self.books.ai_staked),
            ai_purchases: U64(self.books.ai_purchases),
            ai_stake_cap: self.rules.ai_stake_cap,
            keep_liquid: self.rules.keep_liquid,
            stake_due: U128(self.stake_due()),
            farm: self.config.farm.clone(),
            farm_product: self.config.farm_product.clone(),
            keeper: self.keeper.clone(),
        }
    }

    pub fn get_rules(&self) -> Rules {
        self.rules.clone()
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_order(&self, order_id: u64) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    /// Finds an order by the public key the buyer's browser made for it.
    pub fn find_order(&self, pk: String) -> Option<Order> {
        self.by_key.get(&pk).and_then(|id| self.orders.get(id)).cloned()
    }

    /// Newest last, starting at `from`.
    pub fn get_ledger(&self, from: u32, limit: u32) -> Vec<Entry> {
        self.ledger.iter().skip(from as usize).take(limit.min(MAX_LIST) as usize).cloned().collect()
    }

    pub fn get_owed(&self, account: AccountId) -> U128 {
        U128(self.owed.get(&account).copied().unwrap_or(0))
    }

    /// Serves the shop from this account. The gateway calls it for every path.
    pub fn web4_get(&self, request: Value) -> Value {
        let _ = request;
        match self.page.get() {
            Some(body) => json!({ "contentType": "text/html; charset=UTF-8", "body": body }),
            None => json!({ "status": 404, "contentType": "text/plain", "body": "" }),
        }
    }
}

// ---- Private machinery ----

impl Nobody {
    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.config.owner, "Only the owner can do this");
    }

    fn free_near(&self) -> u128 {
        let locked_for_storage =
            env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        env::account_balance().as_yoctonear().saturating_sub(locked_for_storage)
    }

    fn buying(&self) -> bool {
        self.buying_since != 0 && env::block_timestamp() < self.buying_since + STUCK_AFTER_NS
    }

    /// NEAR that a purchase would stake now. A free farm registration comes out of it first.
    fn stake_due(&self) -> u128 {
        let registration = if self.farm_registered { 0 } else { FARM_STORAGE.as_yoctonear() };
        stake_due(
            self.free_near().saturating_sub(registration),
            self.rules.keep_liquid.0,
            self.books.ai_staked,
            self.rules.ai_stake_cap.0,
        )
    }

    fn ai_spent_today(&self) -> u128 {
        if self.books.ai_day == day_of(env::block_timestamp()) {
            self.books.ai_today
        } else {
            0
        }
    }

    /// The reason the company cannot take new work, if any.
    fn closed_because(&self) -> Option<String> {
        if self.rules.paused {
            let reason = self.pause_reason.clone().unwrap_or_else(|| "the kill switch is on".to_string());
            return Some(reason);
        }
        if !ai_budget_allows(
            self.ai_spent_today(),
            self.rules.ai_reserve_per_run.0,
            self.rules.max_ai_per_day.0,
        ) {
            return Some("the daily AI budget is spent".to_string());
        }
        if self.free_near() < self.rules.run_deposit.0 + self.rules.near_floor.0 {
            return Some("not enough NEAR to pay for compute".to_string());
        }
        None
    }

    /// A buyer quoted just before a price change is held to the lower price for a while.
    fn price_due(&self) -> u128 {
        let recent = env::block_timestamp() < self.price_changed_at + PRICE_GRACE_NS;
        if recent {
            self.price.min(self.old_price)
        } else {
            self.price
        }
    }

    /// The address a refund for this payment would go to. The contract sees `intents.near` as
    /// the sender of any cross-chain payment, so a buyer there must name their own address.
    fn refund_target(&self, sender: &AccountId, order_msg: Option<&OrderMsg>) -> Option<String> {
        if let Some(named) = order_msg.and_then(|order_msg| order_msg.refund.as_deref()) {
            let account = match parse_refund(named)? {
                RefundTarget::Near(account) | RefundTarget::Intents(account) => account,
            };
            return account.parse::<AccountId>().is_ok().then(|| named.to_string());
        }
        (sender != &self.config.intents).then(|| format!("near:{sender}"))
    }

    fn why_refuse(&self, order_msg: &OrderMsg, paid: u128) -> Option<String> {
        if let Some(reason) = self.closed_because() {
            return Some(reason);
        }
        let reason = if !valid_repo(&order_msg.repo) {
            "the repo must be owner/name"
        } else if !valid_public_key(&order_msg.pk) {
            "the public key must be 64 hex characters"
        } else if !payment_covers(paid, self.price_due(), PAYMENT_TOLERANCE_BPS) {
            "the payment is below the price"
        } else if env::prepaid_gas() < MIN_ORDER_GAS {
            "not enough gas to start the work"
        } else {
            return None;
        };
        Some(reason.to_string())
    }

    /// Hands a refused payment back. A wallet gets it straight back through the token. A
    /// cross-chain buyer gets an explicit refund, because handing money back through
    /// `intents.near` would leave it where they cannot reach it.
    fn turn_away(
        &mut self,
        sender: &AccountId,
        paid: u128,
        refund_to: Option<String>,
        reason: String,
        key: Option<String>,
    ) -> U128 {
        let (true, Some(refund_to)) = (sender == &self.config.intents, refund_to) else {
            return U128(paid);
        };
        let id = self.take_order_id();
        if let Some(key) = &key {
            self.by_key.insert(key.clone(), id);
        }
        let order = Order {
            id,
            repo: String::new(),
            pk: key.unwrap_or_default(),
            paid: U128(paid),
            referrer: None,
            refund_to,
            team: false,
            status: OrderStatus::Refunding,
            created_at: U64(env::block_timestamp()),
            finished_at: None,
            report_sha256: None,
            report_len: None,
            reason: Some(reason),
        };
        self.send_refund(&order);
        self.orders.insert(id, order);
        U128(0)
    }

    fn take_order_id(&mut self) -> u64 {
        let id = self.next_order;
        self.next_order += 1;
        self.books.orders += 1;
        id
    }

    fn open_order(&mut self, order_msg: OrderMsg, paid: u128, refund_to: String) -> Order {
        let id = self.take_order_id();
        let order = Order {
            id,
            repo: order_msg.repo,
            pk: order_msg.pk,
            paid: U128(paid),
            referrer: order_msg.referrer,
            refund_to,
            team: order_msg.team,
            status: OrderStatus::Running,
            created_at: U64(env::block_timestamp()),
            finished_at: None,
            report_sha256: None,
            report_len: None,
            reason: None,
        };
        self.orders.insert(id, order.clone());
        self.by_key.insert(order.pk.clone(), id);
        emit("order", json!({ "order": id, "repo": order.repo, "amount": order.paid }));
        order
    }

    /// Wakes the enclave. It is detached so that the token transfer finishes now and cannot
    /// be undone by anything that happens during the work.
    fn start_run(&mut self, order: &Order) {
        let mut input = json!({
            "v": 2,
            "order": order.id,
            "repo": order.repo,
            "pk": order.pk,
        });
        // Asks the enclave to send `buy_inference` once its key can. The contract checks
        // everything again when that call arrives, so this is only a hint.
        if self.keeper.is_some() && !self.rules.paused && !self.buying() && self.stake_due() > 0 {
            input["buy"] = json!(true);
        }
        let every = self.rules.board_every;
        if every > 0 && self.books.sales_since_board >= every {
            input["board"] = json!({
                "price": U128(self.price),
                "min": self.rules.min_price,
                "max": self.rules.max_price,
                "delivered": self.books.delivered,
                "refunded": self.books.refunded,
                "gross": U128(self.books.gross),
                "ai_total": U128(self.books.ai_total),
            });
        }
        let args = json!({
            "source": { "Project": {
                "project_id": self.config.project_id,
                "version_key": self.config.version_key,
            } },
            "resource_limits": {
                "max_instructions": self.config.max_instructions,
                "max_memory_mb": self.config.max_memory_mb,
                "max_execution_seconds": self.config.max_execution_seconds,
            },
            "input_data": input.to_string(),
            // The inference key comes from `author_secrets` in the enclave's manifest. Its
            // access rule names this contract and this build, so nothing is passed here.
            "response_format": "Json",
            "payer_account_id": env::current_account_id(),
        });
        let deposit = self.rules.run_deposit;
        let note = Some("attached, and OutLayer refunds what it does not use".to_string());
        self.record(EntryKind::ComputeCost, Some(order.id), deposit.0, None, note);
        Promise::new(self.config.outlayer.clone())
            .function_call_weight(
                "request_execution",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(deposit.0),
                RUN_GAS,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(REVIEW_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_review(order.id),
            )
            .detach();
    }

    fn settle(&mut self, mut order: Order, delivery: Delivery) {
        let gross = order.paid.0;
        let shares = split_sale(gross, &self.rules.split(), order.referrer.is_some());
        self.books.delivered += 1;
        self.books.gross += gross;
        self.books.treasury += shares.treasury;
        self.books.stake_pool += shares.stake;
        if order.team {
            self.books.team_orders += 1;
        } else {
            self.books.customers += 1;
        }

        let ai_cost = delivery.ai_cost.min(self.rules.ai_reserve_per_run.0);
        let today = day_of(env::block_timestamp());
        if self.books.ai_day != today {
            self.books.ai_day = today;
            self.books.ai_today = 0;
        }
        self.books.ai_today += ai_cost;
        self.books.ai_total += ai_cost;

        self.record(EntryKind::Sale, Some(order.id), gross, None, order.team.then(|| "team".to_string()));
        self.record(EntryKind::AiCost, Some(order.id), ai_cost, None, None);
        emit("sale", json!({
            "order": order.id,
            "amount": order.paid,
            "contributors": U128(shares.contributors),
            "referrer": U128(shares.referrer),
            "stake": U128(shares.stake),
            "treasury": U128(shares.treasury),
        }));

        order.status = OrderStatus::Delivered;
        order.finished_at = Some(U64(env::block_timestamp()));
        order.report_sha256 = Some(delivery.sha256);
        order.report_len = Some(delivery.len);
        self.pay(self.config.contributors.clone(), shares.contributors, Some(order.id));
        if let Some(referrer) = order.referrer.clone() {
            self.pay(referrer, shares.referrer, Some(order.id));
        }
        self.books.sales_since_board += 1;
        if let Some((proposed, note)) = delivery.board {
            self.take_board_decision(proposed, note);
        }
        if let Some(keeper) = delivery.keeper {
            self.adopt_keeper(keeper);
        }
        self.orders.insert(order.id, order);
    }

    /// The first key the enclave reports becomes a key on this account that can call
    /// `buy_inference` and nothing else, with a capped gas allowance. OutLayer's keystore
    /// derives it inside the TEE for this project and this contract, so it never exists in
    /// plain text. Later reports are ignored until `set_enclave` removes the key.
    fn adopt_keeper(&mut self, key: PublicKey) {
        if self.keeper.is_some() {
            return;
        }
        let Some(allowance) = Allowance::limited(KEEPER_ALLOWANCE) else { return };
        let me = env::current_account_id();
        Promise::new(me.clone())
            .add_access_key_allowance(key.clone(), allowance, me, KEEPER_METHODS)
            .detach();
        let note = format!("enclave key {key} added; it can only call buy_inference");
        self.record(EntryKind::KeyChange, None, 0, None, Some(note));
        emit("keeper", json!({ "public_key": key }));
        self.keeper = Some(key);
    }

    /// The AI chooses, and the human range decides how far that choice can go.
    fn take_board_decision(&mut self, proposed: u128, note: String) {
        self.books.sales_since_board = 0;
        let price = clamp_price(proposed, self.rules.min_price.0, self.rules.max_price.0);
        self.record(EntryKind::PriceChange, None, price, None, Some(note));
        self.set_price(price);
    }

    fn set_price(&mut self, price: u128) {
        if price != self.price {
            self.old_price = self.price;
            self.price = price;
            self.price_changed_at = env::block_timestamp();
        }
    }

    fn refund(&mut self, mut order: Order, reason: &str) {
        order.status = OrderStatus::Refunding;
        order.reason = Some(reason.to_string());
        self.send_refund(&order);
        self.orders.insert(order.id, order);
    }

    fn send_refund(&self, order: &Order) {
        let usdc = Promise::new(self.config.usdc.clone());
        let one_yocto = NearToken::from_yoctonear(1);
        let transfer = match parse_refund(&order.refund_to) {
            Some(RefundTarget::Intents(account)) => usdc.function_call(
                "ft_transfer_call",
                json!({ "receiver_id": self.config.intents, "amount": order.paid, "msg": account })
                    .to_string()
                    .into_bytes(),
                one_yocto,
                FT_CALL_GAS,
            ),
            Some(RefundTarget::Near(account)) => usdc.function_call(
                "ft_transfer",
                json!({ "receiver_id": account, "amount": order.paid }).to_string().into_bytes(),
                one_yocto,
                FT_TRANSFER_GAS,
            ),
            // The target was checked when the payment arrived.
            None => env::panic_str("Unreadable refund target"),
        };
        transfer
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(NOTE_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_refund(order.id),
            )
            .detach();
    }

    fn pay(&self, to: AccountId, amount: u128, order: Option<u64>) {
        if amount == 0 {
            return;
        }
        Promise::new(self.config.usdc.clone())
            .function_call(
                "ft_transfer",
                json!({ "receiver_id": to, "amount": U128(amount) }).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                FT_TRANSFER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(NOTE_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_payout(to, U128(amount), order),
            )
            .detach();
    }

    fn record(
        &mut self,
        kind: EntryKind,
        order: Option<u64>,
        amount: u128,
        to: Option<AccountId>,
        note: Option<String>,
    ) {
        self.ledger.push(Entry { at: U64(env::block_timestamp()), kind, order, amount: U128(amount), to, note });
    }
}

fn emit(event: &str, data: Value) {
    let line = json!({ "standard": "nobody", "version": "1.0.0", "event": event, "data": data });
    env::log_str(&format!("EVENT_JSON:{line}"));
}
