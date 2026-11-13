//! Static checks for NEAR contracts, after NEAR's own audit checklist (the `near-contract-audit`
//! skill in github.com/near/agent-skills). They find candidates, not verdicts. A pattern match is
//! not proof, and a wrong accusation costs a developer real time, so the model reviews every
//! candidate and the report says which ones it confirmed.

use crate::snapshot::{Snapshot, TextFile};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    High,
    Medium,
    Low,
    Info,
}

impl Severity {
    pub fn word(self) -> &'static str {
        match self {
            Severity::High => "high",
            Severity::Medium => "medium",
            Severity::Low => "low",
            Severity::Info => "info",
        }
    }
}

/// Something a rule found that the model should judge.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub id: &'static str,
    pub severity: Severity,
    pub file: String,
    pub line: usize,
    pub title: &'static str,
    pub detail: String,
}

/// What the rules found, and how much NEAR code they had to work with.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scan {
    pub candidates: Vec<Candidate>,
    pub rust_files: usize,
    pub contract_files: usize,
    pub sdk_version: Option<String>,
}

/// One function, as far as the rules need it.
#[derive(Debug)]
struct Function<'a> {
    name: &'a str,
    attrs: String,
    public: bool,
    signature: &'a str,
    body: &'a str,
    line: usize,
}

/// Skips a string, char or comment starting at `at`, returning where it ends. Lifetimes such as
/// `'a` are not chars, and are left alone.
fn skip_literal(bytes: &[u8], at: usize) -> Option<usize> {
    let rest = &bytes[at..];
    if rest.starts_with(b"//") {
        return Some(at + rest.iter().position(|&b| b == b'\n').unwrap_or(rest.len()));
    }
    if rest.starts_with(b"/*") {
        let end = rest.windows(2).skip(2).position(|pair| pair == b"*/").map_or(rest.len(), |p| p + 4);
        return Some(at + end);
    }
    if rest.starts_with(b"r#\"") || rest.starts_with(b"r\"") {
        let hashes = rest[1..].iter().take_while(|&&b| b == b'#').count();
        let mut close = vec![b'"'];
        close.extend(std::iter::repeat(b'#').take(hashes));
        let start = 2 + hashes;
        let end = rest[start..].windows(close.len()).position(|part| part == close.as_slice()).map_or(rest.len(), |p| start + p + close.len());
        return Some(at + end);
    }
    if rest.first() == Some(&b'"') {
        let mut i = 1;
        while i < rest.len() {
            match rest[i] {
                b'\\' => i += 2,
                b'"' => return Some(at + i + 1),
                _ => i += 1,
            }
        }
        return Some(bytes.len());
    }
    if rest.first() == Some(&b'\'') {
        if rest.get(1) == Some(&b'\\') {
            return rest[2..].iter().position(|&b| b == b'\'').map(|p| at + p + 3);
        }
        if rest.get(2) == Some(&b'\'') {
            return Some(at + 3);
        }
    }
    None
}

/// Finds where the block that opens at `open` closes, ignoring braces in strings and comments.
fn block_end(bytes: &[u8], open: usize) -> usize {
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        if let Some(next) = skip_literal(bytes, i) {
            i = next;
            continue;
        }
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    bytes.len()
}

/// The attribute lines written directly above a function.
fn attributes_above(source: &str, start: usize) -> String {
    let mut attrs = Vec::new();
    for line in source[..start].lines().rev().skip(1) {
        let trimmed = line.trim();
        if trimmed.starts_with("#[") || trimmed.starts_with(')') || trimmed.ends_with(',') {
            attrs.push(trimmed);
        } else if trimmed.starts_with("//") || trimmed.is_empty() && attrs.is_empty() {
            continue;
        } else {
            break;
        }
    }
    attrs.join(" ")
}

fn functions(source: &str) -> Vec<Function<'_>> {
    let bytes = source.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if let Some(next) = skip_literal(bytes, i) {
            i = next;
            continue;
        }
        let boundary = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
        if !(boundary && bytes[i..].starts_with(b"fn ")) {
            i += 1;
            continue;
        }
        let name_start = i + 3;
        let name_len = bytes[name_start..].iter().take_while(|b| b.is_ascii_alphanumeric() || **b == b'_').count();
        if name_len == 0 {
            i += 3;
            continue;
        }
        let Some(open) = bytes[name_start..].iter().position(|&b| b == b'{' || b == b';').map(|p| name_start + p) else { break };
        let line_start = source[..i].rfind('\n').map_or(0, |n| n + 1);
        let prefix = source[line_start..i].trim();
        let line = source[..i].matches('\n').count() + 1;
        let (body, next) = if bytes[open] == b'{' {
            let end = block_end(bytes, open);
            (&source[open..end], end)
        } else {
            ("", open + 1)
        };
        found.push(Function {
            name: &source[name_start..name_start + name_len],
            attrs: attributes_above(source, line_start + 1),
            public: prefix.starts_with("pub") && !prefix.starts_with("pub(crate)") && !prefix.starts_with("pub(super)"),
            signature: &source[i..open],
            body,
            line,
        });
        i = next;
    }
    found
}

fn any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn is_callback(name: &str) -> bool {
    name.starts_with("on_") || name.starts_with("callback") || name.ends_with("_callback") || name.starts_with("resolve_") || name.ends_with("_resolve")
}

/// Token standard receivers. Token contracts call these, so they are public by design.
fn is_receiver(name: &str) -> bool {
    name.ends_with("_on_transfer") || name.ends_with("_on_approve") || name.ends_with("_resolve_transfer")
}

/// Mocks, tests and examples are not what the developer ships, so flagging them is noise.
fn ignored_path(path: &str) -> bool {
    path.to_ascii_lowercase().split('/').any(|part| {
        part == "tests" || part == "test" || part == "tests.rs" || part == "examples" || part == "example" || part == "benches"
            || part.starts_with("test-") || part.starts_with("test_") || part.ends_with("_test.rs") || part.ends_with("_tests.rs")
            || part.contains("mock") || part.contains("fixture") || part.starts_with("sandbox")
    })
}

fn is_sensitive(name: &str) -> bool {
    any(name, &["withdraw", "claim", "transfer", "unstake", "redeem", "payout", "refund", "send_", "sell"])
}

fn is_admin(name: &str) -> bool {
    ["set_", "update_", "pause", "unpause", "resume", "upgrade", "migrate", "add_admin", "remove_admin", "change_owner", "emergency", "whitelist", "blacklist", "grant", "revoke"]
        .iter()
        .any(|word| name.starts_with(word))
}

fn amount_like(name_and_type: &str) -> bool {
    any(name_and_type, &["amount", "balance", "deposit", "price", "supply", "fee", "timestamp", "_ns", "nanos", "yocto"])
}

/// u128 values, and u64 values that are amounts or nanosecond times, lose precision in JSON.
fn native_json_integer(signature: &str) -> Option<String> {
    let params = signature.split_once('(').map_or("", |(_, rest)| rest);
    for part in params.split([',', ')']) {
        let part = part.trim();
        if part.ends_with(": u128") || part.ends_with(": i128") || (part.ends_with(": u64") && amount_like(part)) {
            return Some(part.to_string());
        }
    }
    let returns = signature.split_once("->").map_or("", |(_, rest)| rest.trim());
    (returns == "u128" || returns == "i128" || returns == "Option<u128>").then(|| format!("returns {returns}"))
}

/// A file that defines a contract, not one that merely mentions the SDK.
fn is_near_contract(text: &str) -> bool {
    text.contains("#[near") || text.contains("#[near_bindgen]")
}

/// Runs every rule over the snapshot's Rust and Cargo files.
pub fn scan(snapshot: &Snapshot) -> Scan {
    let mut out = Scan { rust_files: snapshot.rust.len(), ..Scan::default() };
    for file in &snapshot.rust {
        if !is_near_contract(&file.text) || ignored_path(&file.path) {
            continue;
        }
        out.contract_files += 1;
        scan_file(file, &mut out.candidates);
    }
    scan_manifests(snapshot, &mut out);
    for hit in &snapshot.secret_hits {
        out.candidates.push(Candidate {
            id: "committed-secret",
            severity: Severity::High,
            file: hit.path.clone(),
            line: 0,
            title: "A live secret is committed",
            detail: format!("{} was found in the repo. Rotate it, then remove it from history.", hit.kind),
        });
    }
    out.candidates.sort_by(|a, b| a.severity.cmp(&b.severity).then_with(|| a.file.cmp(&b.file)).then(a.line.cmp(&b.line)));
    out.candidates.truncate(30);
    out
}

fn scan_file(file: &TextFile, out: &mut Vec<Candidate>) {
    let mut add = |id, severity, line, title, detail: String| {
        out.push(Candidate { id, severity, file: file.path.clone(), line, title, detail });
    };
    for function in functions(&file.text) {
        // Randomness is a risk wherever it is drawn, in a helper as much as in a method. A seed
        // is always worth a look. Block data only counts where the name says it picks a result.
        let seeded = function.body.contains("random_seed");
        let randomish = any(&function.name.to_lowercase(), &["random", "lottery", "winner", "raffle", "shuffle", "dice", "draw", "flip"]);
        if seeded || (randomish && any(function.body, &["block_timestamp", "block_height", "block_index", "epoch_height"])) {
            let source = if seeded { "env::random_seed" } else { "block data" };
            add("insecure-random", Severity::Medium, function.line, "Randomness a validator can influence",
                format!("`{}` draws randomness from {source}, which the block producer can influence. That is fine for outcomes of no value, not for prizes or money.", function.name));
        }
        let takes_self = function.signature.contains("self");
        let mutates = function.signature.contains("&mut self");
        let private = function.attrs.contains("#[private]");
        if !function.public {
            continue;
        }
        let callback = is_callback(function.name) || is_receiver(function.name);
        if takes_self && is_callback(function.name) && !private {
            add("non-private-callback", Severity::High, function.line, "Callback may be callable by anyone",
                format!("`{}` looks like a callback but has no #[private], so another account could call it directly.", function.name));
        }
        if function.signature.contains("-> Self") && (function.name == "new" || function.name.starts_with("new_") || function.name.starts_with("init")) && !function.attrs.contains("#[init") {
            add("required-initialization-macro", Severity::High, function.line, "Initializer without #[init]",
                format!("`{}` returns Self without #[init], so it may be callable again to reset the owner.", function.name));
        }
        // The risk NEAR's checklist describes is value moving for the caller. A method that pays
        // a recipient fixed in state is safe for anyone to trigger, so it is not flagged.
        let for_caller = function.body.contains("predecessor_account_id");
        if mutates && !private && !callback && for_caller && is_sensitive(function.name) && !function.body.contains("assert_one_yocto") {
            add("yocto-attach", Severity::High, function.line, "Sensitive method does not require one yoctoNEAR",
                format!("`{}` moves value for the caller without assert_one_yocto, so a function-call key could trigger it silently.", function.name));
        }
        if mutates && !private && is_admin(function.name) && !any(function.body, &["predecessor_account_id", "assert_owner", "only_owner", "require_owner", "assert_self", "owner"]) {
            add("owner-check", Severity::High, function.line, "Admin method with no caller check",
                format!("`{}` changes settings but no check of the caller was found.", function.name));
        }
        if takes_self && !private {
            if let Some(part) = native_json_integer(function.signature) {
                add("incorrect-argument-or-return-types", Severity::Medium, function.line, "Large number crosses JSON as a native integer",
                    format!("`{}` uses `{part}`. Use U128 or U64 so values above 2^53 are not corrupted.", function.name));
            }
        }
        if takes_self && function.body.contains(".iter()") && !any(function.body, &[".take(", ".skip(", "limit", "from_index"]) {
            add("gas-griefing", Severity::Medium, function.line, "Unbounded loop over stored data",
                format!("`{}` iterates a collection with no limit, so it can run out of gas as data grows.", function.name));
        }
        if function.signature.contains("callback_unwrap") || (function.body.contains("promise_result") && function.body.contains(".unwrap()")) {
            add("unhandled-promise", Severity::Medium, function.line, "Callback assumes the promise succeeded",
                format!("`{}` unwraps a promise result, so a failed call panics instead of being handled.", function.name));
        }
        if function.body.contains("signer_account_id()") {
            add("signer-auth", Severity::Medium, function.line, "Uses the signer instead of the caller",
                format!("`{}` reads signer_account_id. If that is used for permission, a contract the user signed for can act as them.", function.name));
        }
    }
    let lower = file.text.to_lowercase();
    if any(&lower, &[": f64", ": f32", "as f64", "as f32", "<f64>", "<f32>"]) {
        let line = file.text.lines().position(|line| any(line, &["f64", "f32"])).map_or(0, |p| p + 1);
        add("float-math", Severity::Low, line, "Floating point in contract code",
            "Floats round, and rounding in money math loses funds. Use integers with a fixed number of decimals.".to_string());
    }
    let mut prefixes: Vec<(&str, usize)> = Vec::new();
    for (index, line) in file.text.lines().enumerate() {
        for part in line.split("::new(b\"").skip(1) {
            if let Some(end) = part.find('"') {
                let prefix = &part[..end];
                if let Some((_, first)) = prefixes.iter().find(|(seen, _)| *seen == prefix) {
                    add("storage-collision", Severity::High, index + 1, "Two collections share a storage prefix",
                        format!("Prefix b\"{prefix}\" is also used on line {first}. The two collections would overwrite each other."));
                } else {
                    prefixes.push((prefix, index + 1));
                }
            }
        }
    }
}

fn scan_manifests(snapshot: &Snapshot, out: &mut Scan) {
    let manifests: Vec<&TextFile> = snapshot.manifests.iter().filter(|file| file.path.ends_with("Cargo.toml")).collect();
    let uses_sdk = manifests.iter().find(|file| file.text.contains("near-sdk"));
    let Some(sdk_file) = uses_sdk else { return };
    for line in sdk_file.text.lines() {
        let line = line.trim();
        if line.starts_with("near-sdk") {
            let version = line.split('"').nth(1).map(str::to_string);
            if let Some(found) = &version {
                if found.split('.').next().and_then(|major| major.trim_start_matches(['^', '=', '~']).parse::<u32>().ok()).is_some_and(|major| major < 5) {
                    out.candidates.push(Candidate {
                        id: "old-sdk",
                        severity: Severity::Info,
                        file: sdk_file.path.clone(),
                        line: 0,
                        title: "Older near-sdk",
                        detail: format!("near-sdk {found} is behind the current 5.x line, which fixes known pitfalls."),
                    });
                }
            }
            out.sdk_version = version.or(Some("workspace".to_string()));
            break;
        }
    }
    let checked = manifests.iter().any(|file| {
        let text = file.text.replace(' ', "");
        text.contains("[profile.release]") && text.contains("overflow-checks=true")
    });
    if !checked {
        out.candidates.push(Candidate {
            id: "unsafe-math",
            severity: Severity::Low,
            file: sdk_file.path.clone(),
            line: 0,
            title: "Overflow checks are off in release builds",
            detail: "Add overflow-checks = true under [profile.release], so arithmetic that overflows aborts instead of wrapping.".to_string(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rust(path: &str, text: &str) -> TextFile {
        TextFile { path: path.into(), text: text.into() }
    }

    fn ids(text: &str) -> Vec<&'static str> {
        let snapshot = Snapshot { rust: vec![rust("src/lib.rs", text)], ..Snapshot::default() };
        scan(&snapshot).candidates.into_iter().map(|candidate| candidate.id).collect()
    }

    const HEAD: &str = "use near_sdk::{near, env};\n#[near]\nimpl Contract {\n";

    #[test]
    fn a_callback_without_private_is_found_and_one_with_it_is_not() {
        assert_eq!(ids(&format!("{HEAD}    pub fn on_stake(&mut self) {{ }}\n}}")), ["non-private-callback"]);
        assert!(ids(&format!("{HEAD}    #[private]\n    pub fn on_stake(&mut self) {{ }}\n}}")).is_empty());
        assert!(ids(&format!("{HEAD}    pub fn ft_on_transfer(&mut self) -> U128 {{ U128(0) }}\n}}")).is_empty(), "a token receiver is public by design");
    }

    // The next three are false alarms found by running the rules on real contracts.
    #[test]
    fn token_receivers_and_fixed_recipient_payouts_are_not_flagged() {
        assert!(ids(&format!("{HEAD}    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128) -> U128 {{ U128(0) }}\n}}")).is_empty());
        let claim_for_someone = format!("{HEAD}    pub fn claim(&mut self, account: AccountId) {{ let amount = self.owed.remove(&account); }}\n}}");
        assert!(ids(&claim_for_someone).is_empty(), "it pays the account in state, whoever calls");
        let claim_for_caller = format!("{HEAD}    pub fn claim(&mut self) {{ let who = env::predecessor_account_id(); }}\n}}");
        assert_eq!(ids(&claim_for_caller), ["yocto-attach"], "NEAR's own example");
    }

    #[test]
    fn mocks_tests_and_examples_are_skipped() {
        let text = format!("{HEAD}    pub fn on_x(&mut self) {{ }}\n}}");
        for path in ["contracts/mock-outlayer/src/lib.rs", "contracts/test-token/src/lib.rs", "tests/flows.rs", "examples/a.rs"] {
            let snapshot = Snapshot { rust: vec![rust(path, &text)], ..Snapshot::default() };
            assert!(scan(&snapshot).candidates.is_empty(), "{path}");
        }
        let attestation = Snapshot { rust: vec![rust("src/attestation.rs", &text)], ..Snapshot::default() };
        assert_eq!(scan(&attestation).candidates.len(), 1, "a word that contains 'test' is not a test");
    }

    #[test]
    fn helpers_that_are_not_contract_methods_are_not_flagged() {
        assert!(ids(&format!("{HEAD}}}\npub fn names(list: &[String]) -> usize {{ list.iter().count() }}")).is_empty());
        let snapshot = Snapshot { rust: vec![rust("src/rules.rs", "// uses near_sdk types\npub fn on_x(&mut self) {}")], ..Snapshot::default() };
        assert_eq!(scan(&snapshot).contract_files, 0, "mentioning the SDK does not make a contract");
    }

    #[test]
    fn an_initializer_without_init_is_found() {
        assert_eq!(ids(&format!("{HEAD}    pub fn new(owner: AccountId) -> Self {{ Self {{ owner }} }}\n}}")), ["required-initialization-macro"]);
        assert!(ids(&format!("{HEAD}    #[init]\n    pub fn new(owner: AccountId) -> Self {{ Self {{ owner }} }}\n}}")).is_empty());
    }

    #[test]
    fn a_withdrawal_without_one_yocto_is_found() {
        let found = ids(&format!("{HEAD}    pub fn withdraw(&mut self, amount: U128) {{ let x = env::predecessor_account_id(); }}\n}}"));
        assert_eq!(found, ["yocto-attach"]);
        assert!(ids(&format!("{HEAD}    #[payable]\n    pub fn withdraw(&mut self, amount: U128) {{ assert_one_yocto(); }}\n}}")).is_empty());
    }

    #[test]
    fn an_admin_method_with_no_caller_check_is_found() {
        assert_eq!(ids(&format!("{HEAD}    pub fn set_fee(&mut self, fee: u32) {{ self.fee = fee; }}\n}}")), ["owner-check"]);
        assert!(ids(&format!("{HEAD}    pub fn set_fee(&mut self, fee: u32) {{ require!(env::predecessor_account_id() == self.owner); }}\n}}")).is_empty());
    }

    #[test]
    fn large_native_integers_in_json_are_found_and_small_ones_are_not() {
        assert_eq!(ids(&format!("{HEAD}    pub fn deposit(&mut self, amount: u128) {{ }}\n}}")), ["incorrect-argument-or-return-types"]);
        assert_eq!(ids(&format!("{HEAD}    pub fn total(&self) -> u128 {{ 0 }}\n}}")), ["incorrect-argument-or-return-types"]);
        assert!(ids(&format!("{HEAD}    pub fn get_order(&self, order_id: u64) -> u64 {{ 0 }}\n}}")).is_empty(), "an id never reaches 2^53");
    }

    #[test]
    fn an_unbounded_loop_is_found_and_a_paged_one_is_not() {
        assert_eq!(ids(&format!("{HEAD}    pub fn all(&self) -> Vec<u8> {{ self.items.iter().collect() }}\n}}")), ["gas-griefing"]);
        assert!(ids(&format!("{HEAD}    pub fn page(&self, from: u32, limit: u32) -> Vec<u8> {{ self.items.iter().skip(1).take(2).collect() }}\n}}")).is_empty());
    }

    #[test]
    fn block_data_randomness_unwrapped_promises_and_signer_auth_are_found() {
        assert_eq!(ids(&format!("{HEAD}    pub fn pick_winner(&mut self) {{ let r = env::random_seed(); }}\n}}")), ["insecure-random"]);
        // near-examples/coin-flip-examples draws its seed in a crate-private helper.
        assert_eq!(ids(&format!("{HEAD}}}\npub(crate) fn simulate_coin_flip() -> String {{ let r = env::random_seed(); String::new() }}\n")), ["insecure-random"]);
        assert_eq!(ids(&format!("{HEAD}    pub fn flip(&mut self) {{ let t = env::block_timestamp(); }}\n}}")), ["insecure-random"]);
        // A timestamp in an ordinary method is just a timestamp.
        assert!(ids(&format!("{HEAD}    pub fn stamp(&mut self) {{ self.at = env::block_timestamp(); }}\n}}")).is_empty());
        assert_eq!(ids(&format!("{HEAD}    #[private]\n    pub fn on_done(&mut self) {{ env::promise_result(0).unwrap(); }}\n}}")), ["unhandled-promise"]);
        assert_eq!(ids(&format!("{HEAD}    pub fn vote(&mut self) {{ let who = env::signer_account_id(); }}\n}}")), ["signer-auth"]);
    }

    #[test]
    fn a_shared_storage_prefix_is_found() {
        let text = format!("{HEAD}}}\nfn make() {{ let a = LookupMap::new(b\"a\"); let b = Vector::new(b\"a\"); }}");
        assert_eq!(ids(&text), ["storage-collision"]);
    }

    #[test]
    fn floats_are_found() {
        assert_eq!(ids(&format!("{HEAD}}}\nfn rate(x: u128) -> u128 {{ (x as f64 * 1.5) as u128 }}")), ["float-math"]);
    }

    #[test]
    fn braces_in_strings_and_comments_do_not_confuse_the_parser() {
        let text = format!("{HEAD}    pub fn a(&self) -> String {{ let s = \"{{ not a block\"; // }} nor this\n s.into() }}\n    pub fn on_x(&mut self) {{ }}\n}}");
        assert_eq!(ids(&text), ["non-private-callback"]);
    }

    #[test]
    fn files_that_are_not_near_contracts_are_ignored() {
        let snapshot = Snapshot { rust: vec![rust("src/main.rs", "pub fn on_click(&mut self) {}")], ..Snapshot::default() };
        assert!(scan(&snapshot).candidates.is_empty());
        assert_eq!(scan(&snapshot).contract_files, 0);
    }

    /// Prints what the rules find in a real archive, so false alarms can be read and fixed.
    /// `NOBODY_REAL_ZIP=path cargo test audit_real_archive -- --nocapture`.
    #[test]
    fn audit_real_archive() {
        let Ok(path) = std::env::var("NOBODY_REAL_ZIP") else { return };
        let snapshot = crate::snapshot::from_zip(&std::fs::read(path).unwrap()).unwrap();
        let result = scan(&snapshot);
        println!("rust files {}, contract files {}, sdk {:?}", result.rust_files, result.contract_files, result.sdk_version);
        for candidate in &result.candidates {
            println!("FOUND {:?} {} {}:{} {}", candidate.severity, candidate.id, candidate.file, candidate.line, candidate.detail);
        }
    }

    #[test]
    fn release_overflow_checks_are_read_from_the_manifests() {
        let toml = |text: &str| TextFile { path: "Cargo.toml".into(), text: text.into() };
        let with = Snapshot { manifests: vec![toml("[dependencies]\nnear-sdk = \"5.30.1\"\n[profile.release]\noverflow-checks = true")], ..Snapshot::default() };
        assert!(scan(&with).candidates.is_empty());
        assert_eq!(scan(&with).sdk_version.as_deref(), Some("5.30.1"));
        let without = Snapshot { manifests: vec![toml("[dependencies]\nnear-sdk = \"4.1.1\"")], ..Snapshot::default() };
        let found: Vec<_> = scan(&without).candidates.into_iter().map(|candidate| candidate.id).collect();
        assert_eq!(found, ["unsafe-math", "old-sdk"]);
    }
}
