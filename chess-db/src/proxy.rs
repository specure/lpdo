//! Transparent CLI → daemon proxy over HTTP.
//!
//! The `lpdo-server` daemon owns the DuckDB file (single-writer lock), so while
//! it runs the CLI can't open the database directly. Instead, long-running "job"
//! commands are forwarded to the daemon's HTTP API: `POST /jobs` to start, then
//! the `GET /jobs/{id}/events` SSE stream is rendered as the same progress the
//! local path shows. Ctrl-C cancels the remote job. This module is transport
//! only — the command → job mapping lives in `main.rs` (where `Commands` is in
//! scope) and reaches us as a `JobSpec`.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use tokio_stream::StreamExt;

use crate::progress;

/// A job to run on the daemon: the `POST /jobs` body is `{type, params}`.
pub struct JobSpec {
    pub job_type: String,
    pub params: serde_json::Value,
}

/// The subset of `GET /status` we use to confirm a reachable daemon is ours.
#[derive(Deserialize)]
pub struct DaemonInfo {
    pub version: String,
    pub api_version: u32,
}

fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Probe for a running daemon by hitting `GET /status` with a short timeout.
/// Returns its version info, or `None` if nothing is listening / it isn't ours.
pub async fn detect_daemon(port: u16) -> Option<DaemonInfo> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
        .ok()?;
    let resp = client.get(format!("{}/status", base_url(port))).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<DaemonInfo>().await.ok()
}

#[derive(Deserialize)]
struct SubmitResp {
    job_id: String,
}

/// One `JobEvent` off the SSE stream (`reporter::JobEvent` is `Serialize`-only,
/// so we deserialize into our own mirror).
#[derive(Deserialize)]
struct JobEventDto {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    message: String,
    value: Option<u64>,
    total: Option<u64>,
    #[allow(dead_code)]
    path: Option<String>,
}

#[derive(Deserialize)]
struct JobSnapshotDto {
    status: String,
    error: Option<String>,
}

enum Outcome {
    Done,
    Error(String),
}

/// Submit `spec` to the daemon, stream its progress to the terminal, and return
/// `Ok(())` on success or `Err` on a job error (→ non-zero CLI exit). Ctrl-C
/// requests cancellation, then keeps draining until the job stops.
pub async fn run_job_proxied(port: u16, spec: JobSpec, json: bool) -> Result<()> {
    let base = base_url(port);
    // No global timeout: the events stream is long-lived.
    let client = reqwest::Client::new();

    // 1. Start the job.
    let resp = client
        .post(format!("{base}/jobs"))
        .json(&serde_json::json!({ "type": spec.job_type, "params": spec.params }))
        .send()
        .await
        .context("submitting job to the daemon")?;
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("daemon rejected the job ({code}): {body}");
    }
    let job_id = resp.json::<SubmitResp>().await.context("reading job id")?.job_id;

    // 2. Stream events.
    let stream = client
        .get(format!("{base}/jobs/{job_id}/events"))
        .send()
        .await
        .context("opening the job event stream")?
        .bytes_stream();
    tokio::pin!(stream);

    let mut decoder = SseDecoder::new();
    let mut renderer = Renderer::new(json);
    let mut outcome: Option<Outcome> = None;
    let mut cancelled = false;
    let ctrlc = tokio::signal::ctrl_c();
    tokio::pin!(ctrlc);

    loop {
        tokio::select! {
            chunk = stream.next() => match chunk {
                Some(Ok(bytes)) => {
                    for payload in decoder.push(&bytes) {
                        if let Some(o) = renderer.handle(&payload) {
                            outcome = Some(o);
                        }
                    }
                    if outcome.is_some() { break; }
                }
                Some(Err(e)) => {
                    renderer.finish();
                    return settle_via_snapshot(&client, &base, &job_id, Some(e.to_string())).await;
                }
                None => break, // stream closed
            },
            // Only the first Ctrl-C is caught; a second falls through to default
            // process termination.
            _ = &mut ctrlc, if !cancelled => {
                cancelled = true;
                renderer.note("Cancelling… (waiting for the job to stop)");
                let _ = client.post(format!("{base}/jobs/{job_id}/cancel")).send().await;
            }
        }
    }

    renderer.finish();
    match outcome {
        Some(Outcome::Done) => Ok(()),
        Some(Outcome::Error(msg)) => bail!("{msg}"),
        // Stream ended without a terminal event — ask the daemon how it went.
        None => settle_via_snapshot(&client, &base, &job_id, None).await,
    }
}

/// Fallback when the SSE stream drops before a terminal event: read the job's
/// final status directly. A still-running status is treated as failure (we lost
/// the stream) so we never report a false success.
async fn settle_via_snapshot(
    client: &reqwest::Client,
    base: &str,
    job_id: &str,
    transport_err: Option<String>,
) -> Result<()> {
    match client.get(format!("{base}/jobs/{job_id}")).send().await {
        Ok(r) if r.status().is_success() => match r.json::<JobSnapshotDto>().await {
            Ok(s) => match s.status.as_str() {
                "done" => Ok(()),
                "error" => bail!("{}", s.error.unwrap_or_else(|| "job failed".into())),
                other => bail!("lost the stream to job {job_id} (status: {other})"),
            },
            Err(e) => bail!("could not read job status: {e}"),
        },
        _ => match transport_err {
            Some(e) => bail!("event stream failed: {e}"),
            None => bail!("lost contact with job {job_id}"),
        },
    }
}

/// Accumulates raw bytes and yields complete `data:` payloads. Splitting on the
/// `\n` byte is UTF-8-safe (0x0A never appears inside a multibyte sequence), so a
/// chunk boundary that lands mid-line or mid-character is handled correctly.
struct SseDecoder {
    buf: Vec<u8>,
}

impl SseDecoder {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }

    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1]; // drop the '\n'
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            // Skip blank lines and `:` keep-alive comments; keep `data:` payloads.
            if let Ok(s) = std::str::from_utf8(line) {
                if let Some(rest) = s.strip_prefix("data:") {
                    out.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
                }
            }
        }
        out
    }
}

/// Renders job events to the terminal (an indicatif bar + log lines, matching the
/// local look), or passes the raw JSON through in `--json` mode.
struct Renderer {
    json: bool,
    bar: Option<indicatif::ProgressBar>,
}

impl Renderer {
    fn new(json: bool) -> Self {
        Self { json, bar: None }
    }

    /// Render one event payload; return its terminal outcome if it is one.
    fn handle(&mut self, payload: &str) -> Option<Outcome> {
        if self.json {
            // Newline-delimited JobEvent JSON — same schema as a local --json run.
            println!("{payload}");
        }
        let ev: JobEventDto = serde_json::from_str(payload).ok()?;
        if !self.json {
            self.render(&ev);
        }
        match ev.kind.as_str() {
            "done" => Some(Outcome::Done),
            "error" => Some(Outcome::Error(if ev.message.is_empty() {
                "job failed".into()
            } else {
                ev.message
            })),
            _ => None,
        }
    }

    fn render(&mut self, ev: &JobEventDto) {
        match ev.kind.as_str() {
            "log" => match &self.bar {
                Some(bar) => bar.println(&ev.message),
                None => println!("{}", ev.message),
            },
            "progress" => {
                if let (Some(total), Some(value)) = (ev.total, ev.value) {
                    if total > 0 {
                        let bar = self.bar.get_or_insert_with(|| {
                            let pb = indicatif::ProgressBar::new(total);
                            pb.set_style(progress::bar_style());
                            pb
                        });
                        bar.set_length(total);
                        bar.set_position(value);
                        if !ev.message.is_empty() {
                            bar.set_message(ev.message.clone());
                        }
                    }
                }
            }
            "done" => {
                if let Some(bar) = self.bar.take() {
                    bar.finish_and_clear();
                }
                if !ev.message.is_empty() {
                    println!("{}", ev.message);
                }
            }
            "error" => {
                if let Some(bar) = self.bar.take() {
                    bar.finish_and_clear();
                }
                if !ev.message.is_empty() {
                    eprintln!("{}", ev.message);
                }
            }
            _ => {}
        }
    }

    fn note(&self, msg: &str) {
        if self.json {
            return;
        }
        match &self.bar {
            Some(bar) => bar.println(msg),
            None => eprintln!("{msg}"),
        }
    }

    fn finish(&mut self) {
        if let Some(bar) = self.bar.take() {
            bar.finish_and_clear();
        }
    }
}
