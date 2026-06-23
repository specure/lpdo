//! Transparent CLI → daemon proxy over HTTP.
//!
//! The `lpdo-server` daemon owns the DuckDB file (single-writer lock), so while
//! it runs the CLI can't open the database directly. Instead, long-running "job"
//! commands are forwarded to the daemon's HTTP API: `POST /jobs` to start, then
//! the `GET /jobs/{id}/events` SSE stream is rendered as the same progress the
//! local path shows. Ctrl-C cancels the remote job. This module is transport
//! only — the command → job mapping lives in `main.rs` (where `Commands` is in
//! scope) and reaches us as a `JobSpec`.

use std::io::Write;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::Method;
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

// ── Quick mutations (one-shot HTTP, no streaming) ─────────────────────────────

/// A one-shot mutation against an existing daemon endpoint: send `method path
/// [body]`, then print the daemon's `{message}` (or `success` for an empty 2xx
/// like 204). An optional `confirm` prompt is shown first.
pub struct MutationSpec {
    method: Method,
    path: String,
    body: Option<serde_json::Value>,
    confirm: Option<String>,
    success: Option<String>,
}

impl MutationSpec {
    pub fn post(path: impl Into<String>) -> Self {
        Self { method: Method::POST, path: path.into(), body: None, confirm: None, success: None }
    }
    pub fn body(mut self, v: serde_json::Value) -> Self {
        self.body = Some(v);
        self
    }
}

/// Run a one-shot mutation (with optional confirmation).
pub async fn run_mutation(port: u16, m: MutationSpec) -> Result<()> {
    if let Some(prompt) = &m.confirm {
        if !prompt_yes_no(prompt)? {
            println!("Cancelled.");
            return Ok(());
        }
    }
    let client = reqwest::Client::new();
    send_mutation(&client, port, m.method, &m.path, m.body.as_ref(), m.success.as_deref()).await
}

/// Send one request and render the outcome (prints `{message}`/`success`, or
/// bails on a non-2xx with the daemon's body).
async fn send_mutation(
    client: &reqwest::Client,
    port: u16,
    method: Method,
    path: &str,
    body: Option<&serde_json::Value>,
    success: Option<&str>,
) -> Result<()> {
    let mut req = client.request(method, format!("{}{path}", base_url(port)));
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req.send().await.context("sending request to the daemon")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
            .or_else(|| success.map(String::from));
        if let Some(msg) = msg {
            println!("{msg}");
        }
        Ok(())
    } else {
        bail!("daemon returned {status}: {}", text.trim());
    }
}

/// `games delete <ids…>` — show each game, confirm (unless `yes_all`), then
/// hard-delete via `DELETE /games/{id}`.
pub async fn run_delete(port: u16, ids: &[u32], yes_all: bool) -> Result<()> {
    let client = reqwest::Client::new();
    if !yes_all {
        for id in ids {
            match get_json::<GameSummaryDto>(&client, port, &format!("/games/{id}")).await {
                Some(g) => println!(
                    "[{}] {} vs {}  {}  {}",
                    g.id, g.white, g.black,
                    g.date.as_deref().unwrap_or("-"), g.event.as_deref().unwrap_or("-"),
                ),
                None => println!("[{id}] (not found)"),
            }
        }
        if !prompt_yes_no(&format!("Delete {} game(s)?", ids.len()))? {
            println!("Cancelled.");
            return Ok(());
        }
    }
    let mut deleted = 0u32;
    for id in ids {
        let resp = client.delete(format!("{}/games/{id}", base_url(port))).send().await
            .context("sending delete to the daemon")?;
        if resp.status().is_success() {
            deleted += 1;
        } else if resp.status() == reqwest::StatusCode::NOT_FOUND {
            eprintln!("[{id}] not found");
        } else {
            eprintln!("[{id}] error: {}", resp.status());
        }
    }
    println!("{deleted} game(s) deleted.");
    Ok(())
}

/// `games purge [--dry-run]` — count soft-deleted games (via `/status`) for a dry
/// run, else `POST /purge`.
pub async fn run_purge(port: u16, dry_run: bool) -> Result<()> {
    let client = reqwest::Client::new();
    if dry_run {
        let n = get_json::<StatusDto>(&client, port, "/status").await.map(|s| s.deleted_games).unwrap_or(0);
        println!("Would purge {n} soft-deleted game(s) (dry run).");
        return Ok(());
    }
    send_mutation(&client, port, Method::POST, "/purge", None, None).await
}

/// `players merge <keep> <drop>` — confirm (unless `yes`) showing game counts,
/// then `POST /players/{keep}/merge/{drop}`.
pub async fn run_merge(port: u16, keep: u32, drop: u32, yes: bool) -> Result<()> {
    let client = reqwest::Client::new();
    if !yes {
        let kc = player_game_count(&client, port, keep).await;
        let dc = player_game_count(&client, port, drop).await;
        let fmt = |n: Option<i64>| n.map(|c| format!("  games: {c}")).unwrap_or_default();
        println!("Keep: [{keep}]{}", fmt(kc));
        println!("Drop: [{drop}]{}", fmt(dc));
        println!("All of [{drop}]'s games move to [{keep}], and player [{drop}] is deleted.");
        if !prompt_yes_no("Proceed?")? {
            println!("Cancelled.");
            return Ok(());
        }
    }
    let resp = client.post(format!("{}/players/{keep}/merge/{drop}", base_url(port))).send().await
        .context("sending merge to the daemon")?;
    let status = resp.status();
    if status.is_success() {
        println!("Done. Player [{drop}] merged into [{keep}].");
        Ok(())
    } else {
        bail!("daemon returned {status}: {}", resp.text().await.unwrap_or_default().trim());
    }
}

/// `players merge-by-name <keep> <drop>` — resolve each name to a single player
/// via `GET /players?name=`, then merge by id.
pub async fn run_merge_by_name(port: u16, keep_name: &str, drop_name: &str, yes: bool) -> Result<()> {
    let client = reqwest::Client::new();
    let keep = resolve_exact_player(&client, port, keep_name).await?;
    let drop = resolve_exact_player(&client, port, drop_name).await?;
    if keep.id == drop.id {
        bail!("both names resolve to the same player [{}]", keep.id);
    }
    if !yes {
        let line = |p: &PlayerInfoDto| format!(
            "[{}] {}  FIDE: {}  games: {}",
            p.id, p.name, p.fide_id.map(|f| f.to_string()).unwrap_or_else(|| "-".into()), p.game_count,
        );
        println!("Keep: {}", line(&keep));
        println!("Drop: {}", line(&drop));
        println!("All of [{}]'s games move to [{}], and player [{}] is deleted.", drop.id, keep.id, drop.id);
        if !prompt_yes_no("Proceed?")? {
            println!("Cancelled.");
            return Ok(());
        }
    }
    run_merge(port, keep.id, drop.id, true).await
}

// ── Small HTTP/render helpers ─────────────────────────────────────────────────

async fn get_json<T: for<'de> Deserialize<'de>>(client: &reqwest::Client, port: u16, path: &str) -> Option<T> {
    let resp = client.get(format!("{}{path}", base_url(port))).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<T>().await.ok()
}

async fn player_game_count(client: &reqwest::Client, port: u16, id: u32) -> Option<i64> {
    get_json::<StatusDtoTotal>(client, port, &format!("/players/{id}/stats")).await.map(|s| s.total)
}

/// Resolve a name to exactly one player (matching the CLI's exact-name merge).
async fn resolve_exact_player(client: &reqwest::Client, port: u16, name: &str) -> Result<PlayerInfoDto> {
    let params = [("name", name)];
    let url = reqwest::Url::parse_with_params(&format!("{}/players", base_url(port)), params)
        .context("building players query")?;
    let matches: Vec<PlayerInfoDto> = client
        .get(url)
        .send()
        .await
        .context("querying players")?
        .json()
        .await
        .context("reading players response")?;
    let want = normalize_name(name);
    let mut exact: Vec<PlayerInfoDto> = matches.into_iter().filter(|p| normalize_name(&p.name) == want).collect();
    match exact.len() {
        1 => Ok(exact.pop().unwrap()),
        0 => bail!("no player exactly named {name:?}"),
        n => bail!("{n} players exactly named {name:?} — merge by id instead"),
    }
}

/// Mirror of the server's name normalisation (lowercase, comma→space, collapse
/// whitespace) so exact-name resolution matches what the daemon stored.
fn normalize_name(s: &str) -> String {
    s.to_lowercase().replace(',', " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

fn prompt_yes_no(prompt: &str) -> Result<bool> {
    print!("{prompt} [y/N] ");
    std::io::stdout().flush().ok();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).context("reading confirmation")?;
    Ok(matches!(line.trim(), "y" | "Y" | "yes" | "Yes"))
}

#[derive(Deserialize)]
struct GameSummaryDto {
    id: u32,
    white: String,
    black: String,
    #[serde(default)]
    white_elo: Option<i16>,
    #[serde(default)]
    black_elo: Option<i16>,
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    eco: Option<String>,
    #[serde(default)]
    move_count: Option<i16>,
    #[serde(default)]
    opening_line: Option<String>,
    #[serde(default)]
    pgn: Option<String>,
}

impl GameSummaryDto {
    /// The list row, matching `search::games` local output.
    fn row(&self) -> String {
        let dash = |s: &Option<String>| s.clone().unwrap_or_else(|| "-".into());
        let elo = |e: &Option<i16>| e.map(|v| v.to_string()).unwrap_or_else(|| "-".into());
        format!(
            "[{}] {} ({}) vs {} ({})  {}  {}  {}  {}  {} moves",
            self.id, self.white, elo(&self.white_elo), self.black, elo(&self.black_elo),
            dash(&self.result), dash(&self.date), dash(&self.event), dash(&self.eco),
            self.move_count.unwrap_or(0),
        )
    }
}

#[derive(Deserialize)]
struct PlayerInfoDto {
    id: u32,
    name: String,
    fide_id: Option<u32>,
    game_count: i64,
}

#[derive(Deserialize)]
struct StatusDto {
    deleted_games: i64,
}

#[derive(Deserialize)]
struct StatusDtoTotal {
    total: i64,
}

// ── Reads (GET, rendered CLI-side) ────────────────────────────────────────────

/// `status` — render the daemon's view of the database.
pub async fn run_status(port: u16) -> Result<()> {
    let client = reqwest::Client::new();
    let s: StatusInfoDto = client
        .get(format!("{}/status", base_url(port)))
        .send().await.context("querying status")?
        .json().await.context("reading status")?;
    let n = |v: i64| -> String {
        // Thousands separators, e.g. 12,040,323.
        let s = v.to_string();
        let mut out = String::new();
        for (i, c) in s.chars().rev().enumerate() {
            if i > 0 && i % 3 == 0 { out.push(','); }
            out.push(c);
        }
        out.chars().rev().collect()
    };
    println!("=== Chess DB Status (server v{}) ===", s.version);
    println!("Games:           {}", n(s.games));
    println!("Players:         {}", n(s.players));
    println!("Positions:       {}", n(s.positions));
    println!("TWIC issues:     {}", n(s.issues));
    println!("Local imports:   {}", n(s.local_imports.unwrap_or(0)));
    if let Some(issue) = s.last_twic_issue {
        let date = s.last_twic_published.as_deref().map(|d| format!(" ({d})")).unwrap_or_default();
        println!("Latest TWIC:     #{issue}{date}");
    }
    if s.deleted_games.unwrap_or(0) > 0 {
        println!("Soft-deleted:    {}", n(s.deleted_games.unwrap_or(0)));
    }
    Ok(())
}

/// `search players` — GET /players, then apply the CLI's `exact`/`id_only`
/// (which the endpoint doesn't model) client-side.
pub async fn run_search_players(
    port: u16,
    name: &str,
    fide_id: Option<u32>,
    exact: bool,
    id_only: bool,
) -> Result<()> {
    let client = reqwest::Client::new();
    let mut q: Vec<(&str, String)> = Vec::new();
    if let Some(f) = fide_id { q.push(("fide_id", f.to_string())); }
    else if !name.is_empty() { q.push(("name", name.to_string())); }
    let url = reqwest::Url::parse_with_params(&format!("{}/players", base_url(port)), &q)
        .context("building players query")?;
    let mut players: Vec<PlayerInfoDto> = client.get(url).send().await.context("searching players")?
        .json().await.context("reading players")?;
    if exact && !name.is_empty() {
        let want = normalize_name(name);
        players.retain(|p| normalize_name(&p.name) == want);
    }
    if id_only {
        match players.as_slice() {
            [p] => { println!("{}", p.id); Ok(()) }
            [] => bail!("no player matched"),
            _ => bail!("{} players matched — narrow the search for --id-only", players.len()),
        }
    } else if players.is_empty() {
        println!("No players found.");
        Ok(())
    } else {
        for p in &players {
            println!(
                "[{}] {}  FIDE: {}  games: {}",
                p.id, p.name,
                p.fide_id.map(|f| f.to_string()).unwrap_or_else(|| "-".into()),
                p.game_count,
            );
        }
        Ok(())
    }
}

/// `search games` — GET /games with the CLI filters as query params, render rows
/// / count / raw PGN. Returns the same footer as the local search.
pub async fn run_search_games(port: u16, query: Vec<(&str, String)>, show_moves: bool) -> Result<()> {
    let client = reqwest::Client::new();
    let count_only = query.iter().any(|(k, _)| *k == "count");
    let pgn_mode = query.iter().any(|(k, _)| *k == "pgn");
    let limit: u32 = query.iter().find(|(k, _)| *k == "limit").and_then(|(_, v)| v.parse().ok()).unwrap_or(100);
    let url = reqwest::Url::parse_with_params(&format!("{}/games", base_url(port)), &query)
        .context("building games query")?;
    let resp = client.get(url).send().await.context("searching games")?;
    if !resp.status().is_success() {
        bail!("daemon returned {}: {}", resp.status(), resp.text().await.unwrap_or_default().trim());
    }
    let val: serde_json::Value = resp.json().await.context("reading games response")?;
    if count_only {
        let c = val.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
        println!("{c}");
        return Ok(());
    }
    let games: Vec<GameSummaryDto> = serde_json::from_value(val).context("parsing games")?;
    for g in &games {
        if pgn_mode {
            if let Some(p) = &g.pgn { println!("{p}\n"); }
        } else {
            println!("{}", g.row());
            if show_moves {
                if let Some(line) = &g.opening_line {
                    println!("  {line}");
                }
            }
        }
    }
    if !pgn_mode {
        println!("\n{} game(s) found (limit {limit})", games.len());
    }
    Ok(())
}

/// `games show <ids…>` — GET /games/{id} for each, print the summary line + PGN.
pub async fn run_show(port: u16, ids: &[u32]) -> Result<()> {
    let client = reqwest::Client::new();
    for id in ids {
        match get_json::<GameSummaryDto>(&client, port, &format!("/games/{id}")).await {
            Some(g) => {
                println!("{}", g.row());
                if let Some(pgn) = &g.pgn {
                    println!("\n{pgn}");
                }
            }
            None => eprintln!("[{id}] not found"),
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct SourceStatusDto {
    key: String,
    name: String,
    kind: String,
    enabled: bool,
    items: i64,
    #[serde(default)]
    last_status: Option<String>,
}

/// Render `sources list` against a running daemon (GET /sources).
pub async fn run_sources(port: u16) -> Result<()> {
    let client = reqwest::Client::new();
    let rows: Vec<SourceStatusDto> = client
        .get(format!("{}/sources", base_url(port)))
        .send().await.context("querying sources")?
        .json().await.context("reading sources")?;
    for s in rows {
        println!(
            "{:<10} {:<22} {:<5} {:<8} items={:<7} {}",
            s.key,
            s.name,
            s.kind,
            if s.enabled { "on" } else { "off" },
            s.items,
            s.last_status.as_deref().unwrap_or(""),
        );
    }
    Ok(())
}

#[derive(Deserialize)]
struct StatusInfoDto {
    version: String,
    games: i64,
    players: i64,
    positions: i64,
    issues: i64,
    #[serde(default)]
    local_imports: Option<i64>,
    #[serde(default)]
    deleted_games: Option<i64>,
    #[serde(default)]
    last_twic_issue: Option<i64>,
    #[serde(default)]
    last_twic_published: Option<String>,
}
