#![allow(dead_code)]

use std::path::PathBuf;

use intely_agent_core::policy::decide::{decide, PolicyContext, PolicyDecision};
use intely_agent_core::policy::intent::{PolicyRequest, ToolIntent};
use intely_agent_core::providers::PermissionMode;
use serde_json::Value;

/// A throw-away working directory shaped like a repo (never a real one).
pub struct Fx {
    pub dir: tempfile::TempDir,
    pub cwd: PathBuf,
}

pub fn fx() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let cwd = std::fs::canonicalize(dir.path()).unwrap();
    for d in [".git/hooks", ".husky", "src", "sub"] {
        std::fs::create_dir_all(cwd.join(d)).unwrap();
    }
    Fx { dir, cwd }
}

pub fn ctx(fx: &Fx, mode: PermissionMode) -> PolicyContext {
    let mut c = PolicyContext::new(mode, &fx.cwd);
    c.home = Some(fx.cwd.join("home"));
    c
}

pub fn request(intent: ToolIntent) -> PolicyRequest {
    PolicyRequest { agent_id: "a1".into(), tool_id: "t1".into(), provider: "claude".into(), intent }
}

pub fn decide_intent(ctx: &PolicyContext, intent: ToolIntent) -> PolicyDecision {
    let d = decide(ctx, &request(intent));
    assert!(d.rule.is_some() && !d.reason.is_empty(), "every decision records what decided and why: {d:?}");
    d
}

pub fn decide_tool(ctx: &PolicyContext, tool: &str, input: Value) -> PolicyDecision {
    decide_intent(ctx, ToolIntent::from_claude_tool(tool, &input))
}

pub fn bash(ctx: &PolicyContext, command: &str) -> PolicyDecision {
    decide_tool(ctx, "Bash", serde_json::json!({ "command": command }))
}

/// A repo-shaped directory with the files the Automatic and Bypass tests run: a package.json whose scripts run plain node files,
/// a harmless script, a script that spawns programs, and one that reads the home directory.
pub fn mfx() -> Fx {
    let fx = fx();
    let w = |name: &str, text: &str| std::fs::write(fx.cwd.join(name), text).unwrap();
    w("package.json", r#"{"scripts":{"test":"node test.js","build":"node build.js","lint":"node lint.js"}}"#);
    w("test.js", "console.log('ok');\n");
    w("build.js", "const { spawnSync } = require('child_process');\nspawnSync('tsc', ['-p', '.']);\n");
    w("lint.js", "console.log('lint');\n");
    w("script.js", "console.log(1);\n");
    w("spawn.js", "const { execSync } = require('child_process');\nexecSync('git status');\n");
    w("home.js", "const os = require('os');\nconsole.log(os.homedir());\n");
    w("a.txt", "x\n");
    std::fs::write(fx.cwd.join("src/a.ts"), "export {};\n").unwrap();
    fx
}

/// `(decision, by, rule)` of a Bash command in a mode.
pub fn verdict(fx: &Fx, mode: PermissionMode, cmd: &str) -> (intely_agent_core::policy::decide::Decision, intely_agent_core::events::types::DecidedBy, String) {
    let d = bash(&ctx(fx, mode), cmd);
    (d.decision, d.by, d.rule.unwrap_or_default())
}
