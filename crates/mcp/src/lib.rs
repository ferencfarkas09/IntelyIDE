//! MCP server management ((design notes: mcp-management-spec)), Tauri-free: the config store (the `mcp` settings namespace, secrets and the
//! confirmation proof in the Keychain), validation, the Test probe, the import from Claude Code, and the supplier the agent host
//! consumes. `src-tauri/src/modules/mcp.rs` is the thin command layer on top. Wire types are exported to `ui/src/bindings/mcp.ts`.

pub mod codefiles;
pub mod error;
pub mod imports;
pub mod model;
pub mod probe;
pub mod resolve;
pub mod scrub;
pub mod store;
pub mod testrun;
pub mod types;

pub use error::{code, McpErr};
pub use resolve::{rules_supplier, scrub_supplier, supplier};
pub use scrub::Scrubber;
pub use store::{McpStore, StoreConfig};
