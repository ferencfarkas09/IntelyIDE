//! Generates `packages/protocol`: the TypeScript types and the Rust-produced fixtures the TS tests parse.
//! `cargo run -p intely-agent-core --features specta --example gen_protocol -- [packages/protocol dir]`

use std::path::PathBuf;

fn main() {
    let root = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol"));
    intely_agent_core::export::export_all(&root).expect("write protocol files");
    println!("wrote {}", root.display());
}
