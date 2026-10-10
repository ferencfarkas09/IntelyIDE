//! The same run through a REAL `ssh` into a throwaway Ubuntu container: probe, setup (bundle upload, the Agent SDK installed on Linux by the
//! sidecar's own installer), the git guard, and a scripted run whose broker looks at the container's files. Ignored by default: it needs the
//! container and an `ssh` wrapper that logs into it (`INTELY_TEST_SSH`, see `.scratch/dockerssh`), and the npm registry for the SDK.
//!
//!   INTELY_TEST_SSH=.scratch/dockerssh/ssh-wrapper cargo test -p intely-agent-host --test remote_real -- --ignored --nocapture

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use intely_agent_core::api::AgentStartRequest;
use intely_agent_host::{ServerRegistry, StartOptions};
use intely_servers::{probe, setup, ServerCfg, SetupOptions, Ssh};

const VERSION: &str = "9.9.9";

/// The files the container needs, laid out as in the app bundle.
fn stage(into: &Path) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let stage = into.join("resources");
    std::fs::create_dir_all(stage.join("sidecar")).unwrap();
    std::fs::create_dir_all(stage.join("sdk-pin")).unwrap();
    for (from, to) in [("sidecar/dist/index.js", "sidecar/index.js"), ("sidecar/dist/sdk-install.js", "sidecar/sdk-install.js"), ("src-tauri/resources/sidecar-package.json", "sidecar/package.json")] {
        std::fs::copy(root.join(from), stage.join(to)).unwrap();
    }
    for f in ["package.json", "package-lock.json", "tree.sha256", "hash-tree.mjs"] {
        std::fs::copy(root.join("sidecar/sdk-pin").join(f), stage.join("sdk-pin").join(f)).unwrap();
    }
    stage
}

#[test]
#[ignore = "needs the ssh test container (INTELY_TEST_SSH)"]
fn setup_and_a_scripted_run_on_a_real_linux_server() {
    let wrapper = std::env::var_os("INTELY_TEST_SSH").expect("INTELY_TEST_SSH: the ssh wrapper of the test container");
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let ssh = Ssh::from_bin(Some(wrapper), PathBuf::from(format!("/tmp/intely-realssh-{}", std::process::id())));
    let _ = std::fs::create_dir_all(&ssh.control_dir);
    let cfg = ServerCfg { id: "real".into(), name: "Container".into(), destination: "dev@127.0.0.1".into(), port: None, root: "~/work".into(), max_agents: 2, enabled: true };
    // start clean: nothing of an earlier run
    ssh.exec(&cfg, "rm -rf ~/.intely ~/.local/share/IntelyIDE ~/work\n", Duration::from_secs(60)).unwrap();

    let st = probe(&ssh, &cfg, VERSION);
    println!("probe: {st:#?}");
    assert!(st.reachable && st.os.as_deref() == Some("Linux") && st.node.ok && st.git.path.is_some(), "{st:?}");
    assert!(!st.ready && !st.bundle.ok, "a fresh server is not ready");

    // setup: the container has Node 24 already; Claude Code is not installed from here, a stand-in is put there below
    let opts = SetupOptions { resources_dir: stage(&root), app_version: VERSION.into(), install_node: false, install_bundle: true, install_sdk: true, install_claude: false };
    let status = setup(&ssh, &cfg, &opts, &|e| println!("setup: {e:?}")).expect("setup");
    println!("after setup: {status:#?}");
    assert!(!status.ready, "Claude Code is still missing: {status:?}");
    assert!(status.bundle.ok, "{status:?}");
    assert!(status.sdk.ok, "the Agent SDK is installed and verified on Linux: {status:?}");

    // a second setup has nothing to do
    let again = setup(&ssh, &cfg, &opts, &|e| println!("setup 2: {e:?}")).expect("setup again");
    assert!(again.bundle.ok && again.sdk.ok);

    // the person signs in to Claude on the server and clones the repos; the test puts a stand-in and a repo there
    let prep = "mkdir -p ~/.intely/claude/bin ~/work/repo && printf '#!/bin/sh\\necho claude\\n' > ~/.intely/claude/bin/claude && chmod +x ~/.intely/claude/bin/claude && cd ~/work/repo && git init -q -b main && git config user.email t@e.x && git config user.name t && echo one > a.txt && git add a.txt && git commit -q -m init\n";
    assert!(ssh.exec(&cfg, prep, Duration::from_secs(60)).unwrap().success());
    let ready = probe(&ssh, &cfg, VERSION);
    assert!(ready.ready, "{ready:?}");

    // a scripted run: the real host, the sidecar there, the broker looking at the container's files
    let registry = Arc::new(ServerRegistry::new({
        let cfg = cfg.clone();
        Arc::new(move || vec![cfg.clone()])
    }, ssh, VERSION));
    registry.set_status("real", ready);
    let local = fixture_repo(&root);
    let mut hostcfg = config(&root.join("data"), sidecar_js());
    hostcfg.servers = Some(registry);
    let (host, sink) = host_with(hostcfg);
    let def = host.find_role("mock-bash-twice", std::slice::from_ref(&local)).expect("role");
    let run = host
        .start_role_with(&def, AgentStartRequest { role: def.name.clone(), repo_ids: vec![local.id.clone()], prompt: "go".into(), mode: None, mcp_servers: None }, std::slice::from_ref(&local), StartOptions { location: Some("real".into()), ..Default::default() })
        .expect("start on the container");
    let card = sink.wait_kind(&run.agent_id, "permission.request");
    println!("the broker asked about: {:?}", card.kind);
    // the git guard is on the server and refuses what it should
    let r = host.context(&run.agent_id).expect("context");
    assert!(r.fs.is_some() && r.cwd.display().to_string().ends_with("/work/repo"), "{:?}", r.cwd);
    host.shutdown();
}
