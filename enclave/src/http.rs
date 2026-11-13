//! A small HTTPS client over WASI. It writes in chunks because OutLayer's worker traps on any
//! single write over 4,096 bytes, and a real prompt is far larger.

use wasi::http::outgoing_handler;
use wasi::http::types::{Fields, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme};
use wasi::io::streams::StreamError;

const MAX_WRITE_BYTES: usize = 4096;
const READ_BYTES: u64 = 65536;
const CONNECT_TIMEOUT_NANOS: u64 = 15_000_000_000;

/// Returned when a response passes its size limit, so a caller can fall back to less.
pub const TOO_LARGE: &str = "response too large";

pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}

fn split_url(url: &str) -> Result<(Scheme, &str, &str), String> {
    let (scheme, rest) = url.split_once("://").ok_or("url has no scheme")?;
    let scheme = match scheme {
        "https" => Scheme::Https,
        "http" => Scheme::Http,
        other => return Err(format!("unsupported scheme {other}")),
    };
    Ok(match rest.find('/') {
        Some(slash) => (scheme, &rest[..slash], &rest[slash..]),
        None => (scheme, rest, "/"),
    })
}

fn send(method: Method, url: &str, headers: &[(&str, String)], body: &[u8], limit: usize) -> Result<Reply, String> {
    let (scheme, authority, path) = split_url(url)?;
    let fields = Fields::new();
    let add = |name: &str, value: &[u8]| {
        fields.append(&name.to_lowercase(), &value.to_vec()).map_err(|error| format!("{error:?}"))
    };
    add("user-agent", b"nobody-enclave/0.1")?;
    for (name, value) in headers {
        add(name, value.as_bytes())?;
    }

    let request = OutgoingRequest::new(fields);
    request.set_method(&method).map_err(|()| "set method")?;
    request.set_scheme(Some(&scheme)).map_err(|()| "set scheme")?;
    request.set_authority(Some(authority)).map_err(|()| "set authority")?;
    request.set_path_with_query(Some(path)).map_err(|()| "set path")?;

    let outgoing = request.body().map_err(|()| "open body")?;
    let options = RequestOptions::new();
    options.set_connect_timeout(Some(CONNECT_TIMEOUT_NANOS)).map_err(|()| "set timeout")?;
    // Sent before the body is written: a large body fills the buffer and blocks until the
    // request is running and draining it.
    let pending = outgoing_handler::handle(request, Some(options)).map_err(|error| format!("send failed: {error:?}"))?;

    let stream = outgoing.write().map_err(|()| "open body stream")?;
    for chunk in body.chunks(MAX_WRITE_BYTES) {
        stream.blocking_write_and_flush(chunk).map_err(|error| format!("write failed: {error:?}"))?;
    }
    drop(stream);
    OutgoingBody::finish(outgoing, None).map_err(|error| format!("finish failed: {error:?}"))?;

    pending.subscribe().block();
    let response = pending
        .get()
        .ok_or("no response")?
        .map_err(|()| "response taken")?
        .map_err(|error| format!("request failed: {error:?}"))?;
    drop(pending);

    let status = response.status();
    let incoming = response.consume().map_err(|()| "open response")?;
    let stream = incoming.stream().map_err(|()| "open response stream")?;
    let mut bytes = Vec::new();
    loop {
        match stream.blocking_read(READ_BYTES) {
            Ok(chunk) => {
                bytes.extend(chunk);
                if bytes.len() > limit {
                    return Err(TOO_LARGE.to_string());
                }
            }
            Err(StreamError::Closed) => break,
            Err(error) => return Err(format!("read failed: {error:?}")),
        }
    }
    Ok(Reply { status, body: bytes })
}

pub fn get(url: &str, limit: usize) -> Result<Reply, String> {
    send(Method::Get, url, &[], &[], limit)
}

pub fn post(url: &str, headers: &[(&str, String)], body: &[u8], limit: usize) -> Result<Reply, String> {
    let mut all = vec![("content-type", "application/json".to_string())];
    all.extend(headers.iter().cloned());
    send(Method::Post, url, &all, body, limit)
}
