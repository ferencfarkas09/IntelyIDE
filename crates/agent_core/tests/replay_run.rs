//! Replays the shell commands of recorded runs through the policy, to compare a change of the analyser with what it did before.
//!
//! `REPLAY=<json>` names a file `{"cwd": "<run cwd>", "dirs": ["<other run folders>"], "cmds": [{"seq": 1, "cmd": "..."}]}`, and `MODE` is
//! `automatic` (default), `edit`, `readonly` (plan mode and read-only roles) or `bypass`. Prints one line per command (`seq verdict by rule`, and what the analyser could not judge) and a total; nothing is run. The test is
//! ignored: it reads the maintainer's own run logs.

mod common;

use common::*;
use intely_agent_core::policy::decide::{Decision, PolicyContext};
use intely_agent_core::providers::PermissionMode;
use std::path::PathBuf;

#[test]
#[ignore = "replays a recorded run (REPLAY=<json>); for the maintainer's machine"]
fn replay_a_recorded_run() {
    let file: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("REPLAY").unwrap()).unwrap()).unwrap();
    let mode = match std::env::var("MODE").unwrap_or_default().as_str() {
        "edit" => PermissionMode::Edit,
        "bypass" => PermissionMode::Bypass,
        "readonly" | "plan" => PermissionMode::ReadOnly,
        _ => PermissionMode::Automatic,
    };
    let mut c = PolicyContext::new(mode, file["cwd"].as_str().unwrap());
    c.add_dirs = file["dirs"].as_array().into_iter().flatten().filter_map(|d| d.as_str()).map(PathBuf::from).collect();
    c.home = std::env::var_os("HOME").map(PathBuf::from);
    c.scratch_dirs = intely_agent_core::policy::paths::default_scratch_dirs();
    let jail = intely_agent_core::policy::paths::Jail::new(std::path::Path::new(file["cwd"].as_str().unwrap()), &c.add_dirs, c.home.as_deref());
    let (mut ok, mut no) = (0, 0);
    for item in file["cmds"].as_array().unwrap() {
        let cmd = item["cmd"].as_str().unwrap_or_default();
        let d = bash(&c, cmd);
        let allowed = d.decision == Decision::Allow;
        if allowed { ok += 1 } else { no += 1 }
        println!("VERDICT {:>6} {} {:?} {}", item["seq"], if allowed { "allow" } else { "refuse" }, d.by, d.rule.as_deref().unwrap_or(""));
        if !allowed {
            // what the analyser could not judge (the policy's own reason text is not printed: it may quote what the command named)
            let issues = intely_agent_core::policy::hardstop::analyze(cmd, &jail).issues.join("; ");
            println!("REASON  {:>6} {}", item["seq"], &issues[..issues.len().min(180)]);
        }
    }
    println!("TOTAL allowed {ok} refused {no}");
}
