//! Turns the static candidates and the model's reply into the report the buyer reads, and the
//! short line the contract reads. The model's reply is untrusted too, so it is parsed defensively.

use crate::audit::{Candidate, Scan};
use nobody_core::{clean_note, valid_digest};
use serde_json::{json, Value};

/// Output to a contract must stay at or under this. It is OutLayer's limit.
pub const MAX_OUTPUT_BYTES: usize = 900;
const MAX_TEXT: usize = 400;

/// `z-ai/glm-5.3-flash` on NEAR AI Cloud, read from the public price list on 7 Nov 2026.
const INPUT_MICRO_PER_MILLION: u64 = 80_000;
const OUTPUT_MICRO_PER_MILLION: u64 = 500_000;

/// What the model used, in millionths of a dollar. It rounds up, so it never under-reports.
pub fn ai_cost(input_tokens: u64, output_tokens: u64) -> u64 {
    let total = input_tokens * INPUT_MICRO_PER_MILLION + output_tokens * OUTPUT_MICRO_PER_MILLION;
    total.div_ceil(1_000_000)
}

/// Finds the JSON object in a model's reply, which may be wrapped in a code fence or prose.
pub fn json_in(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(text.get(start..=end)?).ok()
}

/// The model's review, reduced to what the report may show.
#[derive(Clone, Debug, PartialEq)]
pub struct Judgement {
    pub verdict: String,
    /// For each candidate, by position: real or not, and why. `None` means it was not judged.
    pub calls: Vec<Option<(bool, String)>>,
    pub findings: Vec<Value>,
    pub good: Vec<String>,
}

fn text_of(value: &Value) -> String {
    clean_note(value.as_str().unwrap_or(""), MAX_TEXT)
}

fn severity_of(value: &Value) -> Option<&'static str> {
    match value.as_str()?.to_ascii_lowercase().as_str() {
        "high" | "critical" => Some("high"),
        "medium" => Some("medium"),
        "low" => Some("low"),
        _ => None,
    }
}

/// Reads the model's reply. A call on a candidate number that does not exist is ignored.
pub fn read_judgement(reply: &str, candidates: usize) -> Option<Judgement> {
    let value = json_in(reply)?;
    let verdict = text_of(&value["verdict"]);
    if verdict.is_empty() {
        return None;
    }
    let mut calls = vec![None; candidates];
    for item in value["candidates"].as_array().into_iter().flatten() {
        let Some(n) = item["n"].as_u64() else { continue };
        let Some(slot) = (n as usize).checked_sub(1).and_then(|index| calls.get_mut(index)) else { continue };
        if let Some(real) = item["real"].as_bool() {
            *slot = Some((real, text_of(&item["why"])));
        }
    }
    let findings = value["findings"]
        .as_array()
        .into_iter()
        .flatten()
        .take(6)
        .filter_map(|item| {
            let severity = severity_of(&item["severity"])?;
            let title = text_of(&item["title"]);
            (!title.is_empty()).then(|| {
                json!({ "severity": severity, "file": text_of(&item["file"]), "title": title, "why": text_of(&item["why"]), "fix": text_of(&item["fix"]) })
            })
        })
        .collect();
    let good = value["good"].as_array().into_iter().flatten().take(3).map(text_of).filter(|text| !text.is_empty()).collect();
    Some(Judgement { verdict, calls, findings, good })
}

/// Which model answered. The id lets a buyer fetch the model's signature from NEAR AI Cloud.
pub struct Inference<'a> {
    pub model: &'a str,
    pub id: &'a str,
    pub cost: u64,
}

fn candidate_json(candidate: &Candidate, call: Option<&(bool, String)>) -> Value {
    let (status, why) = match call {
        Some((true, why)) => ("confirmed", why.as_str()),
        Some((false, why)) => ("dismissed", why.as_str()),
        None => ("unreviewed", ""),
    };
    json!({
        "id": candidate.id,
        "severity": candidate.severity.word(),
        "file": candidate.file,
        "line": candidate.line,
        "title": candidate.title,
        "detail": candidate.detail,
        "status": status,
        "why": why,
    })
}

/// The report the buyer reads, once it is unsealed in their browser. Only confirmed candidates
/// and the model's own findings count as problems. Unreviewed candidates are shown as such.
pub fn build_report(order: u64, repo: &str, scan: &Scan, judgement: &Judgement, partial: bool, inference: &Inference) -> String {
    let candidates: Vec<Value> = scan
        .candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| candidate_json(candidate, judgement.calls.get(index).and_then(Option::as_ref)))
        .collect();
    let mut counts = json!({ "high": 0, "medium": 0, "low": 0, "unreviewed": 0 });
    for (index, candidate) in scan.candidates.iter().enumerate() {
        match judgement.calls.get(index).and_then(Option::as_ref) {
            Some((true, _)) => {
                let key = if candidate.severity.word() == "info" { "low" } else { candidate.severity.word() };
                counts[key] = json!(counts[key].as_u64().unwrap_or(0) + 1);
            }
            Some((false, _)) => {}
            None => counts["unreviewed"] = json!(counts["unreviewed"].as_u64().unwrap_or(0) + 1),
        }
    }
    for finding in &judgement.findings {
        let key = finding["severity"].as_str().unwrap_or("low");
        counts[key] = json!(counts[key].as_u64().unwrap_or(0) + 1);
    }
    json!({
        "v": 2,
        "order": order,
        "repo": repo,
        "verdict": judgement.verdict,
        "counts": counts,
        "candidates": candidates,
        "findings": judgement.findings,
        "good": judgement.good,
        "stats": { "rust_files": scan.rust_files, "contract_files": scan.contract_files, "sdk": scan.sdk_version, "partial": partial },
        "ai_micro": inference.cost,
        "model": inference.model,
        "inference_id": inference.id,
        "disclaimer": "An automated review by an independent service. It is not a full audit and it can miss problems. Check each finding before acting on it.",
    })
    .to_string()
}

/// The price decision, if the reply contains a usable one.
pub fn read_board(reply: &str) -> Option<(u64, String)> {
    let value = json_in(reply)?;
    let price = value["price"].as_u64().or_else(|| value["price"].as_str()?.parse().ok())?;
    Some((price, clean_note(value["note"].as_str().unwrap_or(""), 200)))
}

/// The line the contract settles on. It holds no report text, because this is public.
pub fn delivery_line(order: u64, sha256: &str, len: usize, ai: u64, board: Option<&(u64, String)>) -> Option<String> {
    delivery_line_with(order, sha256, len, ai, board, &[])
}

/// The delivery line, plus optional fields such as the keeper's key. Each extra is kept only
/// if the line still fits, so an extra can never cost the buyer their delivery.
pub fn delivery_line_with(
    order: u64,
    sha256: &str,
    len: usize,
    ai: u64,
    board: Option<&(u64, String)>,
    extras: &[(&str, String)],
) -> Option<String> {
    if !valid_digest(sha256) {
        return None;
    }
    let mut line = json!({ "v": 1, "ok": true, "order": order, "sha256": sha256, "len": len, "ai": ai });
    if let Some((price, note)) = board {
        line["board"] = json!({ "price": price.to_string(), "note": note });
    }
    if line.to_string().len() > MAX_OUTPUT_BYTES {
        return None;
    }
    for (name, value) in extras {
        let mut longer = line.clone();
        longer[*name] = json!(value);
        if longer.to_string().len() <= MAX_OUTPUT_BYTES {
            line = longer;
        }
    }
    Some(line.to_string())
}

/// The line for a run that could not finish. The contract refunds on this.
pub fn failure_line(order: u64, reason: &str) -> String {
    json!({ "v": 1, "ok": false, "order": order, "error": clean_note(reason, 200) }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::Severity;

    fn candidates() -> Vec<Candidate> {
        let make = |id, severity| Candidate { id, severity, file: "src/lib.rs".into(), line: 3, title: "t", detail: "d".into() };
        vec![make("non-private-callback", Severity::High), make("gas-griefing", Severity::Medium), make("unsafe-math", Severity::Low)]
    }

    fn reply() -> String {
        json!({
            "verdict": "Mostly sound. One callback can be called by anyone.",
            "candidates": [{ "n": 1, "real": true, "why": "on_x has no guard" }, { "n": 2, "real": false, "why": "the list is capped" }, { "n": 99, "real": true }],
            "findings": [{ "severity": "High", "file": "src/lib.rs", "title": "Refund sent twice", "why": "w", "fix": "f" }, { "severity": "weird", "title": "dropped" }],
            "good": ["State is updated before calls"],
        })
        .to_string()
    }

    #[test]
    fn prices_match_the_published_rate_and_round_up() {
        assert_eq!(ai_cost(1_000_000, 0), 80_000);
        assert_eq!(ai_cost(0, 1_000_000), 500_000);
        assert_eq!(ai_cost(60_000, 3_000), 6_300);
        assert_eq!(ai_cost(1, 0), 1);
    }

    #[test]
    fn finds_json_inside_a_code_fence() {
        assert_eq!(json_in("Sure!\n```json\n{\"a\":1}\n```").unwrap()["a"], 1);
        assert_eq!(json_in("no object here"), None);
        assert_eq!(json_in("} backwards {"), None);
    }

    #[test]
    fn reads_calls_on_candidates_and_ignores_numbers_that_do_not_exist() {
        let judgement = read_judgement(&reply(), 3).unwrap();
        assert_eq!(judgement.calls[0], Some((true, "on_x has no guard".to_string())));
        assert_eq!(judgement.calls[1], Some((false, "the list is capped".to_string())));
        assert_eq!(judgement.calls[2], None);
    }

    #[test]
    fn findings_need_a_known_severity_and_a_title() {
        let judgement = read_judgement(&reply(), 3).unwrap();
        assert_eq!(judgement.findings.len(), 1);
        assert_eq!(judgement.findings[0]["severity"], "high");
    }

    #[test]
    fn a_useless_reply_is_not_a_judgement() {
        for bad in ["", "no json here", "{}", r#"{"verdict": ""}"#] {
            assert_eq!(read_judgement(bad, 0), None, "{bad}");
        }
    }

    #[test]
    fn only_confirmed_problems_are_counted_and_unreviewed_ones_say_so() {
        let scan = Scan { candidates: candidates(), rust_files: 2, contract_files: 1, sdk_version: Some("5.30.1".into()) };
        let judgement = read_judgement(&reply(), 3).unwrap();
        let inference = Inference { model: "m", id: "chatcmpl-1", cost: 6300 };
        let report: Value = serde_json::from_str(&build_report(7, "o/r", &scan, &judgement, false, &inference)).unwrap();
        assert_eq!(report["counts"], json!({ "high": 2, "medium": 0, "low": 0, "unreviewed": 1 }));
        assert_eq!(report["candidates"][0]["status"], "confirmed");
        assert_eq!(report["candidates"][1]["status"], "dismissed");
        assert_eq!(report["candidates"][2]["status"], "unreviewed");
        assert_eq!(report["inference_id"], "chatcmpl-1");
        assert!(report["disclaimer"].as_str().unwrap().contains("not a full audit"));
    }

    #[test]
    fn text_from_the_model_is_cleaned() {
        let text = json!({ "verdict": format!("line\nbreak{}", "x".repeat(1000)) }).to_string();
        let verdict = read_judgement(&text, 0).unwrap().verdict;
        assert_eq!(verdict.chars().count(), 400);
        assert!(!verdict.contains('\n'));
    }

    #[test]
    fn reads_a_price_given_as_a_number_or_a_string() {
        assert_eq!(read_board(r#"{"price": 1500000, "note": "up"}"#), Some((1_500_000, "up".into())));
        assert_eq!(read_board(r#"{"price": "2000000"}"#), Some((2_000_000, String::new())));
        assert_eq!(read_board(r#"{"note": "no price"}"#), None);
    }

    #[test]
    fn the_delivery_line_fits_the_limit_and_holds_no_report_text() {
        let digest = "ab".repeat(32);
        let board = (2_000_000, "x".repeat(200));
        let line = delivery_line(1, &digest, 2400, 6300, Some(&board)).unwrap();
        assert!(line.len() <= MAX_OUTPUT_BYTES);
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["board"]["price"], "2000000", "the contract reads a string");
        assert_eq!(delivery_line(1, "not a digest", 1, 1, None), None);
    }

    #[test]
    fn an_extra_field_never_costs_the_buyer_their_delivery() {
        let digest = "ab".repeat(32);
        let key = ("keeper", format!("ed25519:{}", "J".repeat(44)));
        let line = delivery_line_with(1, &digest, 2400, 6300, None, &[key.clone()]).unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["keeper"], key.1);

        // A long price note leaves no room, so the extra is dropped and the delivery stands.
        let board = (2_000_000, "x".repeat(MAX_OUTPUT_BYTES - 200));
        let line = delivery_line_with(1, &digest, 2400, 6300, Some(&board), &[key, ("buy", "y".repeat(80))]).unwrap();
        assert!(line.len() <= MAX_OUTPUT_BYTES);
        let value: Value = serde_json::from_str(&line).unwrap();
        assert!(value.get("keeper").is_none() && value.get("buy").is_none());
        assert_eq!(value["ok"], true);
    }

    #[test]
    fn a_failure_line_says_not_ok() {
        let value: Value = serde_json::from_str(&failure_line(3, &"y".repeat(500))).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"].as_str().unwrap().len(), 200);
    }
}
