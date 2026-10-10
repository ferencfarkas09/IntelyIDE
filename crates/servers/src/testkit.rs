//! Test helpers: a fake `ssh` that runs the "remote" command locally under a temporary HOME.
//!
//! It models what the real ssh does: options are dropped, the destination is ignored, and the remaining arguments are
//! joined with spaces and handed to a shell as ONE command string. Tests never touch the process environment: the
//! server home and the stub directory are written into the fake script itself.

use crate::cfg::ServerCfg;
use crate::ssh::Ssh;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

pub fn test_cfg() -> ServerCfg {
    ServerCfg {
        id: "big".into(),
        name: "Big".into(),
        destination: "big.example.com".into(),
        port: None,
        root: "~/work".into(),
        max_agents: 4,
        enabled: true,
    }
}

pub fn write_exec(p: &Path, body: &str) {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(p, body).unwrap();
    make_exec(p);
}

pub fn make_exec(p: &Path) {
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

pub fn is_exec(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

pub struct Fake {
    pub dir: TempDir,
    /// The "server" home.
    pub home: PathBuf,
    /// Directory in front of PATH on the "server" (stubs for node, claude, git).
    pub stubs: PathBuf,
    pub ssh: Ssh,
    pub cfg: ServerCfg,
}

impl Fake {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        // Resolve symlinks (macOS /var -> /private/var) so paths compare equal to what the shell prints.
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let home = root.join("home");
        let stubs = root.join("stubs");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&stubs).unwrap();
        let bin = root.join("fake-ssh");
        let script = format!(
            r#"#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break;;
    -o|-p|-i|-J|-F) shift 2;;
    -*) shift;;
    *) break;;
  esac
done
dest="$1"; shift
case "$dest" in
  refused.test) echo "ssh: connect to host $dest port 22: Connection refused" >&2; exit 255;;
  badkey.test) echo "Host key verification failed." >&2; exit 255;;
  denied.test) echo "dev@$dest: Permission denied (publickey,password)." >&2; exit 255;;
esac
HOME='{home}'; export HOME
PATH='{stubs}':/usr/bin:/bin:/usr/sbin:/sbin; export PATH
cd "$HOME"
exec sh -c "$*"
"#,
            home = home.display(),
            stubs = stubs.display()
        );
        write_exec(&bin, &script);
        // The server's PATH is hermetic: only the stubs plus the system dirs. git is the one real tool tests use.
        if let Some(git) = find_in_path("git") {
            write_exec(&stubs.join("git"), &format!("#!/bin/sh\nexec '{}' \"$@\"\n", git.display()));
        }
        let ssh = Ssh { bin, control_dir: root.join("cd") };
        Self { dir, home, stubs, ssh, cfg: test_cfg() }
    }

    /// A stub program in front of PATH on the "server".
    pub fn stub(&self, name: &str, body: &str) {
        let _ = std::fs::remove_file(self.stubs.join(name));
        write_exec(&self.stubs.join(name), &format!("#!/bin/sh\n{body}\n"));
    }

    /// A stub `node` that answers `--version` and runs script files with `/bin/sh`, so tests need no real Node.
    pub fn stub_node(&self, version: &str) {
        self.stub(
            "node",
            &format!("case \"$1\" in --version) echo {version}; exit 0;; esac\nexec /bin/sh \"$@\""),
        );
    }

    pub fn stub_claude(&self) {
        self.stub("claude", "echo '2.1.0 (Claude Code)'");
    }

    /// A resources dir like the one inside the .app: sidecar/{index.js,sdk-install.js,package.json}, sdk-pin/.
    /// The "JavaScript" is shell, run by the stub node.
    pub fn resources(&self, name: &str, sdk_ok: bool) -> PathBuf {
        let r = self.dir.path().join(name);
        let side = r.join("sidecar");
        std::fs::create_dir_all(&side).unwrap();
        std::fs::create_dir_all(r.join("sdk-pin")).unwrap();
        let sdk = if sdk_ok {
            r#"{"ok":true,"version":"0.3.1"}"#
        } else {
            r#"{"ok":false,"code":"sdk_missing","detail":"not installed"}"#
        };
        std::fs::write(
            side.join("index.js"),
            format!(
                "case \"$*\" in *--probe*) echo '{{\"sidecar\":\"t\",\"sdk\":{sdk}}}';; *) echo \"sidecar $*\";; esac\n"
            ),
        )
        .unwrap();
        // The installer leaves a marker in HOME so a test can see that it ran, and prints JSON lines.
        std::fs::write(
            side.join("sdk-install.js"),
            "echo run >> \"$HOME/sdk-install-ran\"\necho '{\"stage\":\"download\",\"detail\":\"fetching\"}'\necho '{\"result\":\"ok\",\"version\":\"0.3.1\",\"files\":3,\"ms\":5}'\n",
        )
        .unwrap();
        std::fs::write(side.join("package.json"), "{}").unwrap();
        std::fs::write(r.join("sdk-pin/tree.sha256"), "abc\n").unwrap();
        r
    }
}

/// `cp -R src/. dst` (creates dst).
pub fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    let ok = std::process::Command::new("cp").arg("-R").arg(format!("{}/.", src.display())).arg(dst).status().unwrap();
    assert!(ok.success());
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(name)).find(|p| is_exec(p) && p.is_file())
}

/// The probe also looks at `/usr/local/bin/claude`, which a test cannot hide. Tests that need "no claude" skip then.
pub fn fixed_claude_present() -> bool {
    is_exec(Path::new("/usr/local/bin/claude"))
}
