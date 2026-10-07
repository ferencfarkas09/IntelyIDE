#!/bin/sh
# `pnpm bindings`: regenerates every TypeScript binding file from the Rust types (ui/src/bindings.ts and ui/src/bindings/<name>.ts).
set -eu
cd "$(dirname "$0")/.."
cargo run -q -j "${CARGO_BUILD_JOBS:-2}" -p intely-core --features specta --example gen_bindings
for name in files term graph roles settings happy runner mongo remote pathpick mcp; do
  cargo run -q -j "${CARGO_BUILD_JOBS:-2}" -p "intely-$name" --features specta --example gen_bindings
done
