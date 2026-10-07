//! Starts a proxy in front of a dev server that is already running on loopback (used by scripts/preview/e2e-inspect.mjs).
//!   cargo run -p intely-preview-proxy --example serve -- <upstream-port> [--no-inject]
//! Prints `PROXY_PORT=<port>` and serves until stdin is closed.

use intely_preview_proxy::{Proxy, ProxyConfig};
use std::io::Read;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let port: u16 = args.next().and_then(|p| p.parse().ok()).expect("usage: serve <upstream-port> [--no-inject]");
    let inject = args.next().as_deref() != Some("--no-inject");
    let upstream = format!("127.0.0.1:{port}").parse().unwrap();
    let proxy = Proxy::start(ProxyConfig { upstream, allowed_ports: vec![port], inject }).await.expect("proxy");
    println!("PROXY_PORT={}", proxy.port());
    tokio::task::spawn_blocking(|| {
        let mut sink = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut sink);
    })
    .await
    .ok();
    proxy.stop();
}
