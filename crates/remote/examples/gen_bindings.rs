//! `cargo run -p intely-remote --features specta --example gen_bindings -- <out.ts>` (default `ui/src/bindings/remote.ts`).

use std::path::PathBuf;

use specta_typescript::Typescript;

fn main() {
    let out = std::env::args_os().nth(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/bindings/remote.ts"));
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).expect("create bindings directory");
    }
    Typescript::default()
        .header("// Generated from crates/remote/src/{api,wire}.rs. Do not edit.\n/* eslint-disable */")
        .export_to(&out, &intely_remote::api::type_collection(), specta_serde::Format)
        .expect("export TypeScript bindings");
    println!("wrote {}", out.display());
}
