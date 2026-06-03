// The batch-normalisation cache-service key is embedded into the binary at
// compile time via `option_env!("CHESSVAULT_NORMALISE_API_KEY")` (see
// src/normalise.rs). Cargo does not fingerprint env vars read by `option_env!`,
// so without this hint a release built earlier *without* the key would not be
// recompiled when the key is later supplied (or vice-versa) — shipping a binary
// with the wrong key state. Telling cargo to watch the variable forces a rebuild
// whenever it changes, so official builds reliably bake the key in.
fn main() {
    println!("cargo:rerun-if-env-changed=CHESSVAULT_NORMALISE_API_KEY");
}
