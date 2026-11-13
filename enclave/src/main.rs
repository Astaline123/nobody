//! The work Nobody does when someone pays. The contract starts this for one order. It reads the
//! repo, runs the static checks from NEAR's audit checklist, asks the model to judge them, seals
//! the report to the buyer, publishes it and prints one short line for the contract. If the
//! contract asks, it then buys the company's inference (see `keeper`). Then it stops, and
//! nothing stays running.
//!
//! This code never sees a private key and cannot move money. Its only secret is the inference
//! key, and the keeper key it signs with is held by OutLayer's keystore and can call one method.

mod http;
mod keeper;

use nobody_core::{valid_public_key, valid_repo};
use nobody_review::audit::scan;
use nobody_review::prompt::{board_user, review_user, BOARD_SYSTEM, REVIEW_SYSTEM};
use nobody_review::report::{ai_cost, build_report, delivery_line_with, failure_line, read_board, read_judgement, Inference};
use nobody_review::seal::{digest, seal};
use nobody_review::snapshot::{from_readme, from_zip, Snapshot};
use serde_json::{json, Value};
use std::io::{self, Read, Write};

// Covered by the wasm sha256. It names the only contract that may start a run, and the only
// hosts this code may reach, so neither can be changed without changing the hash.
#[cfg(feature = "outlayer")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

const MODEL: &str = "z-ai/glm-5.3-flash";
const LLM_URL: &str = "https://cloud-api.near.ai/v1/chat/completions";
const MAX_ARCHIVE: usize = 64 * 1024 * 1024;
const MAX_README: usize = 2 * 1024 * 1024;
const MAX_LLM_REPLY: usize = 2 * 1024 * 1024;
const REVIEW_TOKENS: u32 = 2400;
const BOARD_TOKENS: u32 = 300;

fn main() {
    let mut text = String::new();
    let input: Value = match io::stdin().read_to_string(&mut text) {
        Ok(_) => serde_json::from_str(&text).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    let order = input["order"].as_u64().unwrap_or(0);
    let line = run(&input, order).unwrap_or_else(|reason| failure_line(order, &reason));
    let mut stdout = io::stdout();
    let _ = stdout.write_all(line.as_bytes());
    let _ = stdout.flush();
}

/// The URL of a service, which only a local build may point elsewhere.
fn service(name: &str, real: String) -> String {
    if cfg!(feature = "outlayer") {
        return real;
    }
    std::env::var(name).unwrap_or(real)
}

fn fetch_repo(repo: &str) -> Result<Snapshot, String> {
    let url = service("NOBODY_ZIP_URL", format!("https://codeload.github.com/{repo}/zip/HEAD"));
    match http::get(&url, MAX_ARCHIVE) {
        Ok(reply) if reply.status == 200 => from_zip(&reply.body).ok_or_else(|| "the archive could not be read".to_string()),
        Ok(reply) if reply.status == 404 => Err("the repo is private or does not exist".to_string()),
        Ok(reply) => Err(format!("the archive request returned {}", reply.status)),
        // A repo full of media is too big to take whole. Its README still says something.
        Err(reason) if reason == http::TOO_LARGE => {
            let url = service("NOBODY_README_URL", format!("https://raw.githubusercontent.com/{repo}/HEAD/README.md"));
            let reply = http::get(&url, MAX_README)?;
            if reply.status != 200 {
                return Err("the repo is too large and has no README".to_string());
            }
            Ok(from_readme(String::from_utf8_lossy(&reply.body).into_owned()))
        }
        Err(reason) => Err(reason),
    }
}

/// Counts tokens and remembers the first reply's id, which lets the buyer check the signature.
#[derive(Default)]
struct Usage {
    input: u64,
    output: u64,
    inference_id: String,
}

fn ask(system: &str, user: &str, max_tokens: u32, usage: &mut Usage) -> Result<String, String> {
    let key = std::env::var("NEARAI_API_KEY").map_err(|_| "no inference key")?;
    let body = json!({
        "model": MODEL,
        "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }],
        "temperature": 0.1,
        "max_tokens": max_tokens,
    });
    let url = service("NOBODY_LLM_URL", LLM_URL.to_string());
    let auth = [("authorization", format!("Bearer {key}"))];
    let reply = http::post(&url, &auth, body.to_string().as_bytes(), MAX_LLM_REPLY)?;
    if reply.status != 200 {
        return Err(format!("the model returned {}", reply.status));
    }
    let value: Value = serde_json::from_slice(&reply.body).map_err(|_| "the model's reply was not JSON")?;
    usage.input += value["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
    usage.output += value["usage"]["completion_tokens"].as_u64().unwrap_or(0);
    if usage.inference_id.is_empty() {
        usage.inference_id = value["id"].as_str().unwrap_or("").to_string();
    }
    value["choices"][0]["message"]["content"].as_str().map(str::to_string).ok_or_else(|| "the model sent no text".to_string())
}

fn random<const N: usize>() -> Result<[u8; N], String> {
    wasi::random::random::get_random_bytes(N as u64).try_into().map_err(|_| "no random bytes".to_string())
}

/// Puts the sealed report in public storage, where the buyer's browser reads it.
#[cfg(feature = "outlayer")]
fn publish(order: u64, sealed: &[u8]) -> Result<(), String> {
    outlayer::storage::set_worker_with_options(&format!("report:{order}"), sealed, Some(false))
        .map_err(|error| format!("could not publish the report: {error:?}"))
}

#[cfg(not(feature = "outlayer"))]
fn publish(_order: u64, _sealed: &[u8]) -> Result<(), String> {
    Ok(())
}

fn run(input: &Value, order: u64) -> Result<String, String> {
    // The contract checks these too. They are checked again here because the URL is built from
    // the repo, and this code should not depend on who called it.
    if input["v"] != 2 || order == 0 {
        return Err("unknown input".to_string());
    }
    let repo = input["repo"].as_str().filter(|repo| valid_repo(repo)).ok_or("bad repo")?;
    let key = input["pk"].as_str().filter(|key| valid_public_key(key)).ok_or("bad key")?;

    let snapshot = fetch_repo(repo)?;
    let found = scan(&snapshot);

    let mut usage = Usage::default();
    let user = review_user(repo, &snapshot, &found);
    let count = found.candidates.len();
    let reply = ask(REVIEW_SYSTEM, &user, REVIEW_TOKENS, &mut usage)?;
    let judgement = match read_judgement(&reply, count) {
        Some(judgement) => judgement,
        None => read_judgement(&ask(REVIEW_SYSTEM, &user, REVIEW_TOKENS, &mut usage)?, count).ok_or("the model gave no usable review")?,
    };

    // The price review is optional work. If it fails, the buyer still gets their report.
    let board = match input.get("board") {
        Some(figures) => ask(BOARD_SYSTEM, &board_user(figures), BOARD_TOKENS, &mut usage).ok().and_then(|reply| read_board(&reply)),
        None => None,
    };

    let cost = ai_cost(usage.input, usage.output);
    let inference = Inference { model: MODEL, id: &usage.inference_id, cost };
    let report = build_report(order, repo, &found, &judgement, snapshot.partial, &inference);
    let sealed = seal(report.as_bytes(), key, random()?, random()?).ok_or("could not seal the report")?;
    let sha256 = digest(&sealed);
    publish(order, &sealed)?;

    // The report is out, so nothing the keeper does can cost the buyer their delivery.
    let kept = keeper::keep(input["buy"] == true);
    let line = delivery_line_with(order, &sha256, sealed.len(), cost, board.as_ref(), &kept.fields)
        .ok_or("the result line is too long")?;
    if cfg!(feature = "outlayer") {
        return Ok(line);
    }
    // A local run has no public storage and no keystore, so the report and the unsigned
    // purchase travel back in the output.
    let hex = |bytes: &[u8]| bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let mut value: Value = serde_json::from_str(&line).map_err(|_| "bad line")?;
    value["local_sealed_hex"] = json!(hex(&sealed));
    if let Some(unsigned) = &kept.unsigned {
        value["local_keeper_tx"] = json!(hex(unsigned));
    }
    Ok(value.to_string())
}
