//! Reads a GitHub repo archive into a snapshot. Archives are hostile input: sizes in the
//! headers can lie, so every read is bounded and a bad entry is skipped rather than trusted.

/// The most source text the model is shown, across all files.
const EXCERPT_BUDGET: usize = 140 * 1024;
const EXCERPT_FILE_LIMIT: usize = 16 * 1024;
/// Files larger than this are not inflated at all. Bounds both memory and work.
const MAX_FILE: usize = 256 * 1024;
const MAX_SCANNED_FILES: usize = 400;
const MAX_ENTRIES: usize = 60_000;
/// Every Rust file up to these limits goes to the static checks, not just the excerpts.
const MAX_RUST_FILES: usize = 300;
const MAX_RUST_BYTES: usize = 3 * 1024 * 1024;
const MAX_MANIFESTS: usize = 20;

/// One file's contents, as far as the review needs it.
#[derive(Clone, Debug, PartialEq)]
pub struct TextFile {
    pub path: String,
    pub text: String,
}

/// What the review knows about a repo.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    /// Every path in the repo, without the archive's top folder.
    pub paths: Vec<String>,
    pub readme: Option<String>,
    /// Source files for the model to read, most useful first.
    pub excerpts: Vec<TextFile>,
    /// Every Rust file, whole, for the static checks.
    pub rust: Vec<TextFile>,
    /// Every Cargo.toml.
    pub manifests: Vec<TextFile>,
    /// Paths where something looks like a live secret. The secret itself is never kept.
    pub secret_hits: Vec<SecretHit>,
    /// True when the repo was too big to read in full.
    pub partial: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SecretHit {
    pub path: String,
    pub kind: &'static str,
}

struct Entry {
    path: String,
    method: u16,
    compressed: usize,
    size: usize,
    offset: usize,
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Finds the end-of-central-directory record, which may be followed by a comment.
fn central_directory(zip: &[u8]) -> Option<(usize, usize)> {
    let earliest = zip.len().saturating_sub(22 + 65_535);
    let end = (earliest..=zip.len().checked_sub(22)?)
        .rev()
        .find(|&at| zip.get(at..at + 4) == Some(&[0x50, 0x4b, 0x05, 0x06]))?;
    let count = u16_at(zip, end + 10)? as usize;
    let start = u32_at(zip, end + 16)? as usize;
    Some((start, count))
}

fn read_entries(zip: &[u8]) -> Option<Vec<Entry>> {
    let (mut at, count) = central_directory(zip)?;
    let mut entries = Vec::new();
    for _ in 0..count.min(MAX_ENTRIES) {
        if zip.get(at..at + 4)? != [0x50, 0x4b, 0x01, 0x02] {
            break;
        }
        let name_len = u16_at(zip, at + 28)? as usize;
        let extra_len = u16_at(zip, at + 30)? as usize;
        let comment_len = u16_at(zip, at + 32)? as usize;
        let name = zip.get(at + 46..at + 46 + name_len)?;
        entries.push(Entry {
            path: String::from_utf8_lossy(name).into_owned(),
            method: u16_at(zip, at + 10)?,
            compressed: u32_at(zip, at + 20)? as usize,
            size: u32_at(zip, at + 24)? as usize,
            offset: u32_at(zip, at + 42)? as usize,
        });
        at += 46 + name_len + extra_len + comment_len;
    }
    Some(entries)
}

fn read_entry(zip: &[u8], entry: &Entry) -> Option<Vec<u8>> {
    if entry.size > MAX_FILE {
        return None;
    }
    let header = entry.offset;
    if zip.get(header..header + 4)? != [0x50, 0x4b, 0x03, 0x04] {
        return None;
    }
    let name_len = u16_at(zip, header + 26)? as usize;
    let extra_len = u16_at(zip, header + 28)? as usize;
    let start = header + 30 + name_len + extra_len;
    let data = zip.get(start..start.checked_add(entry.compressed)?)?;
    match entry.method {
        0 => Some(data.to_vec()),
        // The limit is what stops a zip bomb. `entry.size` alone could be a lie.
        8 => miniz_oxide::inflate::decompress_to_vec_with_limit(data, MAX_FILE).ok(),
        _ => None,
    }
}

/// The path without the `repo-HEAD/` folder GitHub puts first.
fn strip_top(path: &str) -> Option<&str> {
    path.split_once('/').map(|(_, rest)| rest).filter(|rest| !rest.is_empty() && !rest.ends_with('/'))
}

fn extension(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path).rsplit_once('.').map_or("", |(_, ext)| ext)
}

fn skipped_folder(path: &str) -> bool {
    path.split('/').any(|part| {
        matches!(part, "node_modules" | "target" | "dist" | "build" | ".next" | "vendor" | ".git" | "out" | "coverage")
    })
}

fn is_text(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    if matches!(name, "Cargo.lock" | "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock") {
        return false;
    }
    name.starts_with(".env")
        || matches!(
            extension(path).to_ascii_lowercase().as_str(),
            "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "go" | "sol" | "md" | "txt"
                | "toml" | "json" | "yaml" | "yml" | "sh" | "ps1" | "html" | "css" | "env"
        )
}

/// Lower sorts first. The review is of contracts, so Rust contract code comes first.
fn excerpt_rank(path: &str) -> Option<u8> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let lower = path.to_ascii_lowercase();
    if matches!(name, "Cargo.toml" | "package.json") && !path.contains('/') {
        return Some(0);
    }
    if !matches!(extension(path), "rs" | "ts" | "tsx" | "js" | "mjs" | "py" | "sol" | "go") {
        return None;
    }
    if lower.contains("test") || lower.contains(".d.ts") || lower.contains(".min.") {
        return Some(5);
    }
    let rust = extension(path) == "rs";
    if rust && (lower.contains("contract") || lower.ends_with("src/lib.rs")) {
        return Some(1);
    }
    if rust {
        return Some(2);
    }
    if lower.contains("contract") {
        return Some(3);
    }
    Some(4)
}

fn base58_run(text: &str, from: usize) -> usize {
    text[from..].bytes().take_while(|b| b.is_ascii_alphanumeric() && !matches!(b, b'0' | b'O' | b'I' | b'l')).count()
}

/// Looks for keys that would be costly to leak. It reports what kind and where, and never
/// keeps the value, so the report cannot become a list of other people's secrets.
fn find_secret(path: &str, text: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name == ".env" || (name.starts_with(".env.") && !name.ends_with("example") && !name.ends_with("sample")) {
        return Some("a committed .env file");
    }
    // A real key has an encoded body under its header. A header alone is a test or a doc.
    if let Some(at) = text.find("PRIVATE KEY-----") {
        let body = text[at..].lines().nth(1).unwrap_or("").trim();
        if text[..at].contains("-----BEGIN") && body.len() >= 40 && body.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)) {
            return Some("a PEM private key");
        }
    }
    for (at, _) in text.match_indices("ed25519:") {
        if base58_run(text, at + 8) >= 80 {
            return Some("a NEAR private key");
        }
    }
    for (at, _) in text.match_indices("sk-") {
        let tail = text[at + 3..].bytes().take_while(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_').count();
        if tail >= 32 {
            return Some("an API key");
        }
    }
    None
}

fn cut(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[cut here]", &text[..end])
}

/// Reads a GitHub archive. Returns `None` only when it is not a readable zip at all.
pub fn from_zip(zip: &[u8]) -> Option<Snapshot> {
    let entries = read_entries(zip)?;
    let mut snapshot = Snapshot::default();
    let mut ranked: Vec<(u8, usize)> = Vec::new();
    let mut scanned = 0;
    let mut rust_bytes = 0;

    for (index, entry) in entries.iter().enumerate() {
        let Some(path) = strip_top(&entry.path) else { continue };
        snapshot.paths.push(path.to_string());
        if skipped_folder(path) {
            continue;
        }
        let name = path.rsplit('/').next().unwrap_or(path);
        if name == "Cargo.toml" && snapshot.manifests.len() < MAX_MANIFESTS {
            if let Some(bytes) = read_entry(zip, entry) {
                snapshot.manifests.push(TextFile { path: path.to_string(), text: String::from_utf8_lossy(&bytes).into_owned() });
            }
        }
        if extension(path) == "rs" {
            if snapshot.rust.len() >= MAX_RUST_FILES || rust_bytes >= MAX_RUST_BYTES {
                snapshot.partial = true;
            } else if let Some(bytes) = read_entry(zip, entry) {
                rust_bytes += bytes.len();
                snapshot.rust.push(TextFile { path: path.to_string(), text: String::from_utf8_lossy(&bytes).into_owned() });
            }
        }
        if snapshot.readme.is_none() && path.eq_ignore_ascii_case("readme.md") {
            let text = read_entry(zip, entry).map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
            snapshot.readme = text;
        }
        if let Some(rank) = excerpt_rank(path) {
            ranked.push((rank, index));
        }
        if is_text(path) {
            if scanned >= MAX_SCANNED_FILES {
                snapshot.partial = true;
                continue;
            }
            scanned += 1;
            if let Some(bytes) = read_entry(zip, entry) {
                if let Some(kind) = find_secret(path, &String::from_utf8_lossy(&bytes)) {
                    snapshot.secret_hits.push(SecretHit { path: path.to_string(), kind });
                }
            }
        }
    }

    ranked.sort();
    let mut budget = EXCERPT_BUDGET;
    for (_, index) in ranked {
        if budget == 0 {
            break;
        }
        let entry = &entries[index];
        let Some(path) = strip_top(&entry.path) else { continue };
        let Some(bytes) = read_entry(zip, entry) else { continue };
        let text = cut(&String::from_utf8_lossy(&bytes), EXCERPT_FILE_LIMIT.min(budget));
        budget = budget.saturating_sub(text.len());
        snapshot.excerpts.push(TextFile { path: path.to_string(), text });
    }
    Some(snapshot)
}

/// A snapshot from the README alone, for a repo too big to download whole.
pub fn from_readme(readme: String) -> Snapshot {
    Snapshot { readme: Some(readme), partial: true, ..Snapshot::default() }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Builds a small zip with stored entries, shaped the way GitHub shapes them.
    pub(crate) fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = Vec::new();
        let mut central = Vec::new();
        for (name, data) in files {
            let path = format!("repo-HEAD/{name}");
            let offset = zip.len() as u32;
            zip.extend_from_slice(&[0x50, 0x4b, 0x03, 0x04]);
            zip.extend_from_slice(&[0u8; 22]);
            zip.extend_from_slice(&(path.len() as u16).to_le_bytes());
            zip.extend_from_slice(&0u16.to_le_bytes());
            zip.extend_from_slice(path.as_bytes());
            zip.extend_from_slice(data);

            central.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02]);
            central.extend_from_slice(&[0u8; 6]);
            central.extend_from_slice(&0u16.to_le_bytes()); // stored, not compressed
            central.extend_from_slice(&[0u8; 8]);
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(path.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0u8; 12]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(path.as_bytes());
        }
        let start = zip.len() as u32;
        zip.extend_from_slice(&central);
        zip.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06]);
        zip.extend_from_slice(&[0u8; 6]);
        zip.extend_from_slice(&(files.len() as u16).to_le_bytes());
        zip.extend_from_slice(&(central.len() as u32).to_le_bytes());
        zip.extend_from_slice(&start.to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip
    }

    #[test]
    fn reads_a_repo_and_drops_the_top_folder() {
        let zip = make_zip(&[("README.md", b"# Hello"), ("src/main.rs", b"fn main() {}"), ("LICENSE", b"MIT")]);
        let snapshot = from_zip(&zip).unwrap();
        assert_eq!(snapshot.readme.as_deref(), Some("# Hello"));
        assert_eq!(snapshot.paths, ["README.md", "src/main.rs", "LICENSE"]);
        assert_eq!(snapshot.excerpts[0].path, "src/main.rs");
    }

    #[test]
    fn manifests_and_contracts_come_before_other_code() {
        let zip = make_zip(&[
            ("web/app.ts", b"web"),
            ("contract/src/lib.rs", b"contract"),
            ("Cargo.toml", b"[workspace]"),
            ("tools/gen.rs", b"tool"),
            ("src/thing.test.ts", b"test"),
        ]);
        let order: Vec<_> = from_zip(&zip).unwrap().excerpts.into_iter().map(|file| file.path).collect();
        assert_eq!(order, ["Cargo.toml", "contract/src/lib.rs", "tools/gen.rs", "web/app.ts", "src/thing.test.ts"]);
    }

    #[test]
    fn every_rust_file_and_manifest_reaches_the_static_checks() {
        let zip = make_zip(&[("Cargo.toml", b"[workspace]"), ("a/Cargo.toml", b"[package]"), ("a/src/lib.rs", b"fn a() {}"), ("b.rs", b"fn b() {}"), ("target/x.rs", b"no")]);
        let snapshot = from_zip(&zip).unwrap();
        assert_eq!(snapshot.rust.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(), ["a/src/lib.rs", "b.rs"]);
        assert_eq!(snapshot.manifests.len(), 2);
    }

    #[test]
    fn dependencies_and_build_output_are_ignored() {
        let zip = make_zip(&[("node_modules/x/index.js", b"x"), ("target/near/a.js", b"y"), ("app.js", b"z")]);
        let snapshot = from_zip(&zip).unwrap();
        assert_eq!(snapshot.excerpts.len(), 1);
        assert_eq!(snapshot.paths.len(), 3, "they still count as files in the repo");
    }

    #[test]
    fn a_large_file_is_never_loaded() {
        let big = vec![b'a'; MAX_FILE + 1];
        let zip = make_zip(&[("big.ts", &big), ("small.ts", b"ok")]);
        let snapshot = from_zip(&zip).unwrap();
        assert_eq!(snapshot.excerpts.len(), 1);
        assert_eq!(snapshot.excerpts[0].path, "small.ts");
    }

    #[test]
    fn excerpts_stay_inside_the_budget() {
        let big = vec![b'a'; 20_000];
        let names: Vec<String> = (0..30).map(|i| format!("src/f{i:02}.ts")).collect();
        let files: Vec<(&str, &[u8])> = names.iter().map(|name| (name.as_str(), big.as_slice())).collect();
        let snapshot = from_zip(&make_zip(&files)).unwrap();
        let total: usize = snapshot.excerpts.iter().map(|file| file.text.len()).sum();
        assert!(total <= EXCERPT_BUDGET + 40 * 30, "{total}");
    }

    #[test]
    fn rubbish_is_not_a_snapshot_and_a_lying_header_is_survived() {
        assert_eq!(from_zip(b"not a zip"), None);
        assert_eq!(from_zip(&[]), None);
        let mut zip = make_zip(&[("a.ts", b"hello")]);
        // Point the entry's data far past the end of the file.
        let local = zip.len() - 22 - 46 - "repo-HEAD/a.ts".len();
        zip[local + 20..local + 24].copy_from_slice(&u32::MAX.to_le_bytes());
        let snapshot = from_zip(&zip).unwrap();
        assert!(snapshot.excerpts.is_empty());
    }

    #[test]
    fn a_zip_bomb_stops_at_the_limit() {
        let huge = vec![0u8; 5 * 1024 * 1024];
        let deflated = miniz_oxide::deflate::compress_to_vec(&huge, 10);
        assert!(deflated.len() < 20_000);
        let entry = Entry { path: "x".into(), method: 8, compressed: deflated.len(), size: 10, offset: 0 };
        let mut zip = vec![0x50, 0x4b, 0x03, 0x04];
        zip.extend_from_slice(&[0u8; 26]);
        zip.extend_from_slice(&deflated);
        assert_eq!(read_entry(&zip, &entry), None, "claimed 10 bytes, inflates past the limit");
    }

    #[test]
    fn finds_secrets_and_never_keeps_them() {
        let near_key = format!("ed25519:{}", "3".repeat(88));
        let api_key = format!("sk-{}", "a1".repeat(24));
        let pem = format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----", "b3Blbn".repeat(12));
        let zip = make_zip(&[
            (".env", b"KEY=1"),
            (".env.example", b"KEY=your-key-here"),
            ("config.json", near_key.as_bytes()),
            ("agent.ts", api_key.as_bytes()),
            ("id.txt", pem.as_bytes()),
            ("clean.ts", b"const publicKey = 'ed25519:abc'; // sk-short"),
            ("docs.md", b"A key looks like -----BEGIN OPENSSH PRIVATE KEY----- and then text."),
        ]);
        let hits = from_zip(&zip).unwrap().secret_hits;
        let found: Vec<_> = hits.iter().map(|hit| (hit.path.as_str(), hit.kind)).collect();
        assert_eq!(
            found,
            [
                (".env", "a committed .env file"),
                ("config.json", "a NEAR private key"),
                ("agent.ts", "an API key"),
                ("id.txt", "a PEM private key"),
            ]
        );
    }

    /// Reads a real archive when one is provided, because a zip made by this test proves only
    /// that the parser agrees with the test. `NOBODY_REAL_ZIP=path cargo test real_archive`.
    #[test]
    fn real_archive() {
        let Ok(path) = std::env::var("NOBODY_REAL_ZIP") else { return };
        let snapshot = from_zip(&std::fs::read(path).unwrap()).expect("a real archive must parse");
        assert!(snapshot.paths.len() > 10, "{}", snapshot.paths.len());
        assert!(snapshot.readme.is_some(), "the README was inflated");
        assert!(!snapshot.excerpts.is_empty());
        println!("paths {} excerpts {} secrets {:?}", snapshot.paths.len(), snapshot.excerpts.len(), snapshot.secret_hits);
    }

    #[test]
    fn long_text_is_cut_on_a_character_boundary() {
        assert_eq!(cut("héllo", 2), "h\n[cut here]");
        assert_eq!(cut("short", 100), "short");
    }
}
