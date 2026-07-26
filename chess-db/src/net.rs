//! Small network helpers shared by the source downloaders and the job runner.

use anyhow::Error;

/// True when an error looks like a *connectivity* failure — the machine is
/// offline, DNS/connect failed, or the connection timed out — rather than a real
/// server-side or data error (an HTTP 4xx/5xx, a corrupt archive, a parse error).
///
/// This is the signal for the job runner to **pause and retry** a network job
/// instead of failing it (#206). Genuine errors (bad file, server error) still
/// fail, so they don't retry forever. Walks the whole `anyhow` cause chain, since
/// the `reqwest::Error` is usually wrapped in context by the caller.
pub fn is_offline_error(e: &Error) -> bool {
    e.chain()
        .any(|cause| cause.downcast_ref::<reqwest::Error>().is_some_and(is_offline_reqwest))
}

/// The connectivity test for a raw `reqwest::Error` — a connection that couldn't
/// be established or timed out (offline / DNS / connect timeout).
pub fn is_offline_reqwest(re: &reqwest::Error) -> bool {
    re.is_connect() || re.is_timeout()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_status_and_generic_errors_are_not_offline() {
        // A plain anyhow error (corrupt file, parse failure) is not connectivity.
        assert!(!is_offline_error(&anyhow::anyhow!("no .txt entry inside the FIDE zip")));
        assert!(!is_offline_error(&anyhow::anyhow!("boom").context("saving download")));
    }
}
