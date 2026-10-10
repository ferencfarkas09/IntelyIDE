//! The per-run git shim on the server, the paths of a ready server and the one-line sidecar start command.

use crate::cfg::{valid_name, valid_version, validate_remote_path, ServerCfg};
use crate::probe::ServerStatus;
use crate::quote::sh_quote;
use crate::ssh::{Ssh, SshError};
use std::path::Path;
use std::time::Duration;

/// Where things are on a ready server. All paths are absolute and come from the probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemotePaths {
    /// `$HOME`.
    pub home: String,
    /// The `node` binary (Node >= 24).
    pub node: String,
    /// `<home>/.intely/<ver>/resources/sidecar/index.js`.
    pub sidecar_js: String,
    /// The `claude` binary.
    pub claude: String,
    /// The `git` binary.
    pub git: String,
    /// `<home>/.intely/shims`; one dir per agent below it.
    pub shims_dir: String,
}

fn abs_ok(p: &str) -> bool {
    p.starts_with('/') && validate_remote_path("path", p).is_ok()
}

/// The paths of a server, or `None` unless it is ready, enabled and every path is clean.
pub fn remote_paths(st: &ServerStatus, cfg: &ServerCfg, app_version: &str) -> Option<RemotePaths> {
    if !st.ready || !cfg.enabled || !valid_version(app_version) {
        return None;
    }
    let home = st.home.clone()?;
    let (node, claude, git) = (st.node.path.clone()?, st.claude.path.clone()?, st.git.path.clone()?);
    let home_t = home.trim_end_matches('/').to_string();
    let p = RemotePaths {
        sidecar_js: format!("{home_t}/.intely/{app_version}/resources/sidecar/index.js"),
        shims_dir: format!("{home_t}/.intely/shims"),
        home,
        node,
        claude,
        git,
    };
    [&p.home, &p.node, &p.claude, &p.git, &p.sidecar_js].iter().all(|x| abs_ok(x)).then_some(p)
}

/// The remote command for `Ssh::command`: `sh -c '<script>'`, where the script puts the managed Node and Claude first
/// on PATH, goes to `$HOME` and `exec`s the sidecar. Providers other than `[a-z0-9-]+` are dropped.
/// The remote login shell must understand POSIX single quotes (sh, bash, zsh, dash, ksh, fish).
pub fn sidecar_command(p: &RemotePaths, providers: &[String], policy_timeout_ms: u32) -> String {
    let good: Vec<&str> = providers
        .iter()
        .map(String::as_str)
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
        .collect();
    let mut script = String::from(
        "PATH=\"$HOME/.intely/node/bin:$HOME/.intely/claude/bin:$PATH\"; export PATH; cd \"$HOME\"; exec ",
    );
    script.push_str(&sh_quote(&p.node));
    script.push(' ');
    script.push_str(&sh_quote(&p.sidecar_js));
    if !good.is_empty() {
        script.push(' ');
        script.push_str(&sh_quote(&format!("--providers={}", good.join(","))));
    }
    script.push(' ');
    script.push_str(&sh_quote(&format!("--policy-timeout={policy_timeout_ms}")));
    format!("sh -c {}", sh_quote(&script))
}

fn shim_dir(home: &str, agent_id: &str) -> Result<String, SshError> {
    if !abs_ok(home) {
        return Err(SshError::invalid("home".into()));
    }
    if !valid_name(agent_id) {
        return Err(SshError::invalid("agent id".into()));
    }
    Ok(format!("{}/.intely/shims/{agent_id}", home.trim_end_matches('/')))
}

/// Uploads the files of `local_shim_dir` into `<home>/.intely/shims/<agent_id>` and returns that remote dir.
pub fn upload_shim(
    ssh: &Ssh,
    cfg: &ServerCfg,
    home: &str,
    agent_id: &str,
    local_shim_dir: &Path,
) -> Result<String, SshError> {
    let dir = shim_dir(home, agent_id)?;
    let mut names = Vec::new();
    let rd = std::fs::read_dir(local_shim_dir).map_err(|e| SshError::invalid(format!("shim dir: {e}")))?;
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if !valid_name(&n) {
            return Err(SshError::invalid(format!("shim file name {n:?}")));
        }
        names.push(n);
    }
    if names.is_empty() {
        return Err(SshError::invalid("shim dir is empty".into()));
    }
    names.sort();
    let entries: Vec<&str> = names.iter().map(String::as_str).collect();
    ssh.push_tar(cfg, local_shim_dir, &entries, &dir, Duration::from_secs(60))?;
    Ok(dir)
}

/// Removes the shim dir of one agent.
pub fn remove_shim(ssh: &Ssh, cfg: &ServerCfg, home: &str, agent_id: &str) -> Result<(), SshError> {
    let dir = shim_dir(home, agent_id)?;
    let out = ssh.exec(cfg, &format!("rm -rf -- {}\n", sh_quote(&dir)), Duration::from_secs(30))?;
    if out.success() {
        Ok(())
    } else {
        Err(SshError::other(out.stderr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{BundleStatus, ClaudeStatus, GitStatus, NodeStatus, SdkStatus};
    use crate::testkit::*;
    use std::process::Command;

    fn ready_status() -> ServerStatus {
        ServerStatus {
            reachable: true,
            home: Some("/home/me".into()),
            node: NodeStatus { version: Some("v24.13.0".into()), path: Some("/home/me/.intely/node/bin/node".into()), ok: true },
            claude: ClaudeStatus { path: Some("/home/me/.local/bin/claude".into()), version: None, logged_in: Some(true) },
            git: GitStatus { path: Some("/usr/bin/git".into()), version: None },
            bundle: BundleStatus { version: Some("1.1.1".into()), ok: true },
            sdk: SdkStatus { ok: true, version: None, detail: None },
            ready: true,
            ..ServerStatus::default()
        }
    }

    #[test]
    fn remote_paths_of_a_ready_server() {
        let p = remote_paths(&ready_status(), &test_cfg(), "1.1.1").unwrap();
        assert_eq!(p.sidecar_js, "/home/me/.intely/1.1.1/resources/sidecar/index.js");
        assert_eq!(p.shims_dir, "/home/me/.intely/shims");
        assert_eq!((p.node.as_str(), p.git.as_str()), ("/home/me/.intely/node/bin/node", "/usr/bin/git"));
    }

    #[test]
    fn remote_paths_need_a_ready_enabled_server_and_clean_paths() {
        let cfg = test_cfg();
        let mut st = ready_status();
        st.ready = false;
        assert!(remote_paths(&st, &cfg, "1.1.1").is_none());
        assert!(remote_paths(&ready_status(), &ServerCfg { enabled: false, ..cfg.clone() }, "1.1.1").is_none());
        assert!(remote_paths(&ready_status(), &cfg, "../x").is_none());
        let mut st = ready_status();
        st.home = Some("/home/me\n/etc".into());
        assert!(remote_paths(&st, &cfg, "1.1.1").is_none());
        let mut st = ready_status();
        st.node.path = Some("relative/node".into());
        assert!(remote_paths(&st, &cfg, "1.1.1").is_none());
        let mut st = ready_status();
        st.git.path = None;
        assert!(remote_paths(&st, &cfg, "1.1.1").is_none());
    }

    #[test]
    fn sidecar_command_shape() {
        let p = remote_paths(&ready_status(), &test_cfg(), "1.1.1").unwrap();
        let c = sidecar_command(&p, &["claude".into(), "codex-cli".into()], 8000);
        assert!(c.starts_with("sh -c '"));
        assert!(c.contains("exec"));
        assert!(c.contains("--providers=claude,codex-cli"));
        assert!(c.contains("--policy-timeout=8000"));
        assert!(c.contains("cd \"$HOME\""));
        assert!(c.contains(".intely/node/bin:$HOME/.intely/claude/bin:$PATH"));
        // one line
        assert!(!c.contains('\n'));
    }

    #[test]
    fn sidecar_command_drops_hostile_providers() {
        let p = remote_paths(&ready_status(), &test_cfg(), "1.1.1").unwrap();
        let c = sidecar_command(&p, &["claude".into(), "x;rm -rf /".into(), "A".into(), "".into(), "$(id)".into()], 2000);
        assert!(c.contains("--providers=claude'"), "{c}");
        assert!(!c.contains("rm -rf") && !c.contains("$(id)"));
        let c = sidecar_command(&p, &[], 2000);
        assert!(!c.contains("--providers"));
    }

    #[test]
    fn sidecar_command_runs_the_right_program_with_the_right_arguments() {
        // Run the command with sh and a fake node that prints its arguments; paths contain quotes and spaces.
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let node = root.join("it's a node");
        write_exec(&node, "#!/bin/sh\npwd\nfor a; do printf '[%s]\\n' \"$a\"; done\n");
        let js = root.join("side car/index.js");
        std::fs::create_dir_all(js.parent().unwrap()).unwrap();
        std::fs::write(&js, "").unwrap();
        let home = root.join("h");
        std::fs::create_dir_all(&home).unwrap();
        let p = RemotePaths {
            home: home.display().to_string(),
            node: node.display().to_string(),
            sidecar_js: js.display().to_string(),
            claude: "/x/claude".into(),
            git: "/x/git".into(),
            shims_dir: "/x".into(),
        };
        let cmd = sidecar_command(&p, &["claude".into()], 1234);
        let out = Command::new("sh").arg("-c").arg(&cmd).env("HOME", &home).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], home.display().to_string());
        assert_eq!(lines[1], format!("[{}]", js.display()));
        assert_eq!(lines[2..], ["[--providers=claude]", "[--policy-timeout=1234]"]);
    }

    #[test]
    fn sidecar_command_survives_the_fake_ssh_transport() {
        let f = Fake::new();
        f.stub("tool", "echo ok");
        let node = f.stubs.join("tool");
        let p = RemotePaths {
            home: f.home.display().to_string(),
            node: node.display().to_string(),
            sidecar_js: "/dev/null".into(),
            claude: "/c".into(),
            git: "/g".into(),
            shims_dir: "/s".into(),
        };
        let mut cmd = f.ssh.command(&f.cfg, &sidecar_command(&p, &["claude".into()], 2000));
        let out = cmd.output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ok\n");
    }

    fn shim_src(f: &Fake) -> std::path::PathBuf {
        let d = f.dir.path().join("shim");
        write_exec(&d.join("git"), "#!/bin/sh\necho shim\n");
        d
    }

    #[test]
    fn upload_and_remove_shim() {
        let f = Fake::new();
        let src = shim_src(&f);
        let home = f.home.display().to_string();
        let dir = upload_shim(&f.ssh, &f.cfg, &home, "agent-1", &src).unwrap();
        assert_eq!(dir, format!("{home}/.intely/shims/agent-1"));
        let remote_git = f.home.join(".intely/shims/agent-1/git");
        assert!(is_exec(&remote_git));
        assert_eq!(std::fs::read_to_string(&remote_git).unwrap(), "#!/bin/sh\necho shim\n");
        remove_shim(&f.ssh, &f.cfg, &home, "agent-1").unwrap();
        assert!(!f.home.join(".intely/shims/agent-1").exists());
        // removing again is fine
        remove_shim(&f.ssh, &f.cfg, &home, "agent-1").unwrap();
    }

    #[test]
    fn remove_shim_only_touches_its_own_dir() {
        let f = Fake::new();
        let home = f.home.display().to_string();
        std::fs::create_dir_all(f.home.join(".intely/shims/other")).unwrap();
        remove_shim(&f.ssh, &f.cfg, &home, "agent-1").unwrap();
        assert!(f.home.join(".intely/shims/other").exists());
        for bad in ["", ".", "..", "../x", "a/b", "-rf", "a b", "$(id)"] {
            assert!(remove_shim(&f.ssh, &f.cfg, &home, bad).is_err(), "{bad:?}");
        }
        assert!(f.home.join(".intely/shims/other").exists());
    }

    #[test]
    fn upload_shim_validates_inputs() {
        let f = Fake::new();
        let src = shim_src(&f);
        let home = f.home.display().to_string();
        for bad in ["", "..", "a/b", "-x"] {
            assert!(upload_shim(&f.ssh, &f.cfg, &home, bad, &src).is_err(), "{bad:?}");
        }
        for bad_home in ["", "rel", "/a/../b", "~"] {
            assert!(upload_shim(&f.ssh, &f.cfg, bad_home, "ok", &src).is_err(), "{bad_home:?}");
        }
        assert!(upload_shim(&f.ssh, &f.cfg, &home, "ok", &f.dir.path().join("nope")).is_err());
        let empty = f.dir.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(upload_shim(&f.ssh, &f.cfg, &home, "ok", &empty).is_err());
        let odd = f.dir.path().join("odd");
        write_exec(&odd.join("we ird"), "x");
        assert!(upload_shim(&f.ssh, &f.cfg, &home, "ok", &odd).is_err());
    }
}
