fn main() {
    // (The cache-service key that was baked in via `option_env!` was removed with
    // the FIDE scraping / normalise service — normalisation is now purely local.)

    // DuckDB ≥ 1.10503 calls the Windows Restart Manager (RmStartSession,
    // RmEndSession, RmRegisterResources, RmGetList) from its bundled C++ to
    // report which process holds a lock on the database file. libduckdb-sys
    // does not emit the link directive for it, so a Windows MSVC build fails
    // with `LNK2019: unresolved external symbol Rm…`. Link rstrtmgr ourselves.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=dylib=rstrtmgr");
    }
}
