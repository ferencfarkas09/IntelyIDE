//! Wrangler (and pnpm) invocation model, builders, process runner and the scripted test spawner (spec 4.3).
//!
//! Process rules (the pattern of `crates/checks/src/runner.rs`): own process group, stdin closed except for `secret put`, stdout and
//! stderr read in two threads, every line masked before it leaves the thread, per-op timeouts, `Stop` = SIGTERM to the group then
//! SIGKILL after 3 s, exit code 127 when the binary cannot start and 143 when signalled. The child gets a freshly built environment:
//! nothing is inherited except the allow-list of [`child_env`].

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::mask::{Masker, MAX_INTAKE_BYTES};
use crate::Secret;

/// What a run is for. The jail gate (4.9) decides per `Op`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Op {
    Version,
    Login,
    Logout,
    Whoami,
    DeploymentsList,
    DeployDryRun,
    Deploy,
    SecretPut,
    Delete,
    Rollback,
    Pnpm,
    Node,
}

impl Op {
    pub fn name(self) -> &'static str {
        match self {
            Self::Version => "version",
            Self::Login => "login",
            Self::Logout => "logout",
            Self::Whoami => "whoami",
            Self::DeploymentsList => "deploymentsList",
            Self::DeployDryRun => "deployDryRun",
            Self::Deploy => "deploy",
            Self::SecretPut => "secretPut",
            Self::Delete => "delete",
            Self::Rollback => "rollback",
            Self::Pnpm => "pnpm",
            Self::Node => "node",
        }
    }

    /// The per-op timeout of spec 4.3.
    pub fn timeout(self) -> Duration {
        Duration::from_secs(match self {
            Self::Version => 10,
            Self::Whoami | Self::Logout | Self::DeploymentsList => 30,
            Self::Login | Self::Deploy => 300,
            Self::SecretPut => 60,
            Self::Delete | Self::DeployDryRun | Self::Rollback => 120,
            Self::Pnpm | Self::Node => 600,
        })
    }
}

#[derive(Clone)]
pub enum EnvVal {
    Plain(String),
    /// Masked everywhere it could be printed; `Debug` prints a placeholder.
    Secret(Secret),
}

impl std::fmt::Debug for EnvVal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Plain(v) => write!(f, "Plain({v:?})"),
            Self::Secret(_) => f.write_str("Secret([redacted])"),
        }
    }
}

pub struct Invocation {
    pub op: Op,
    /// `argv[0]` is the program, the rest its arguments.
    pub argv: Vec<String>,
    pub env: Vec<(String, EnvVal)>,
    /// Written to the child's stdin followed by a newline, then closed (`secret put`, the delete confirmation).
    pub stdin: Option<Secret>,
    pub cwd: PathBuf,
    pub timeout: Duration,
}

impl std::fmt::Debug for Invocation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.env.iter().map(|(k, _)| k.as_str()).collect();
        f.debug_struct("Invocation").field("op", &self.op).field("argc", &self.argv.len()).field("env", &names).finish()
    }
}

impl Invocation {
    pub fn env_names(&self) -> Vec<String> {
        self.env.iter().map(|(k, _)| k.clone()).collect()
    }

    /// Every secret this run was given (environment secrets and stdin), for the masker.
    pub fn secrets(&self) -> Vec<Secret> {
        let mut out: Vec<Secret> = self.env.iter().filter_map(|(_, v)| if let EnvVal::Secret(s) = v { Some(s.clone()) } else { None }).collect();
        out.extend(self.stdin.clone());
        out
    }

    /// The command line as shown in the review and the log: quoted argv, `<secret via stdin>` where a value goes through the pipe.
    pub fn display(&self) -> String {
        let mut s = self.argv.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ");
        if self.stdin.is_some() {
            s.push_str(" < <secret via stdin>");
        }
        s
    }
}

fn shell_quote(a: &str) -> String {
    if !a.is_empty() && a.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/' | b':' | b'=' | b'@' | b'+' | b',')) {
        a.to_owned()
    } else {
        format!("'{}'", a.replace('\'', "'\\''"))
    }
}

/// Where the child's variables come from (a getter, so tests never depend on the real process environment).
pub struct ChildEnv<'a> {
    pub var: &'a dyn Fn(&str) -> Option<String>,
    /// `<data dir>/relay-deploy`: the wrangler log directory lives below it.
    pub state_root: &'a Path,
    /// Pinned in every Cloudflare op (both auth modes), so wrangler cannot pick another account than the one the user saw.
    pub account_id: Option<&'a str>,
    /// Token mode only.
    pub token: Option<&'a Secret>,
}

const INHERIT: [&str; 13] = [
    "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE",
];

/// The allow-list environment of every child (spec 4.3). Explicitly absent: every inherited `CLOUDFLARE_*`, `INTELY_*`,
/// `NODE_OPTIONS`, `NPM_CONFIG_*` and `GIT_*` variable; nothing else is inherited either.
pub fn child_env(e: &ChildEnv) -> Vec<(String, EnvVal)> {
    let mut out: Vec<(String, EnvVal)> = Vec::new();
    for k in INHERIT {
        if let Some(v) = (e.var)(k).filter(|v| !v.is_empty()) {
            out.push((k.to_owned(), EnvVal::Plain(v)));
        }
    }
    let plain = |k: &str, v: String| (k.to_owned(), EnvVal::Plain(v));
    out.push(plain("NO_COLOR", "1".into()));
    out.push(plain("WRANGLER_SEND_METRICS", "false".into()));
    out.push(plain("WRANGLER_LOG_PATH", e.state_root.join("logs").to_string_lossy().into_owned()));
    if let Some(id) = e.account_id {
        out.push(plain("CLOUDFLARE_ACCOUNT_ID", id.to_owned()));
    }
    if let Some(t) = e.token {
        out.push(("CLOUDFLARE_API_TOKEN".to_owned(), EnvVal::Secret(t.clone())));
    }
    out
}

/// Program, working directory and environment shared by the builders. The working directory is never the repo kit (so wrangler cannot
/// read `.env` or `.dev.vars` from the checkout): it is the empty per-worker state directory.
pub struct Base<'a> {
    pub wrangler: &'a Path,
    pub cwd: &'a Path,
    pub env: &'a [(String, EnvVal)],
}

impl Base<'_> {
    fn inv(&self, op: Op, args: &[&str]) -> Invocation {
        let mut argv = vec![self.wrangler.to_string_lossy().into_owned()];
        argv.extend(args.iter().map(|a| (*a).to_owned()));
        Invocation { op, argv, env: self.env.to_vec(), stdin: None, cwd: self.cwd.to_path_buf(), timeout: op.timeout() }
    }

    pub fn version(&self) -> Invocation {
        self.inv(Op::Version, &["--version"])
    }

    pub fn login(&self, device: bool) -> Invocation {
        if device {
            self.inv(Op::Login, &["login", "--device"])
        } else {
            self.inv(Op::Login, &["login"])
        }
    }

    pub fn logout(&self) -> Invocation {
        self.inv(Op::Logout, &["logout"])
    }

    pub fn whoami(&self) -> Invocation {
        self.inv(Op::Whoami, &["whoami", "--json"])
    }

    pub fn deployments_list(&self, cfg: &Path, name: &str) -> Invocation {
        self.inv(Op::DeploymentsList, &["deployments", "list", "--name", name, "--config", &cfg.to_string_lossy()])
    }

    pub fn deploy_dry_run(&self, cfg: &Path, name: &str, outdir: &Path) -> Invocation {
        self.inv(Op::DeployDryRun, &["deploy", "--dry-run", "--outdir", &outdir.to_string_lossy(), "--config", &cfg.to_string_lossy(), "--name", name])
    }

    /// `message` is the ownership stamp `intely-relay:<hash of install id>`; `output_file` is `WRANGLER_OUTPUT_FILE_PATH`.
    pub fn deploy(&self, cfg: &Path, name: &str, message: &str, output_file: &Path) -> Invocation {
        let mut i = self.inv(Op::Deploy, &["deploy", "--config", &cfg.to_string_lossy(), "--name", name, "--message", message]);
        i.env.push(("WRANGLER_OUTPUT_FILE_PATH".to_owned(), EnvVal::Plain(output_file.to_string_lossy().into_owned())));
        i
    }

    /// `value` goes to the child's stdin, never argv.
    pub fn secret_put(&self, cfg: &Path, name: &str, key: &str, value: Secret) -> Invocation {
        let mut i = self.inv(Op::SecretPut, &["secret", "put", key, "--name", name, "--config", &cfg.to_string_lossy()]);
        i.stdin = Some(value);
        i
    }

    /// `--force` only when `wrangler delete --help` lists it (`force`); else the answer `y` goes to stdin after the typed confirmation.
    pub fn delete(&self, cfg: &Path, name: &str, force: bool) -> Invocation {
        if force {
            self.inv(Op::Delete, &["delete", "--name", name, "--config", &cfg.to_string_lossy(), "--force"])
        } else {
            let mut i = self.inv(Op::Delete, &["delete", "--name", name, "--config", &cfg.to_string_lossy()]);
            i.stdin = Some(Secret::new("y"));
            i
        }
    }

    /// `[unverified]`: whether `--yes` is the non-interactive flag of the pinned version is settled in M1.
    pub fn rollback(&self, cfg: &Path, name: &str) -> Invocation {
        self.inv(Op::Rollback, &["rollback", "--name", name, "--config", &cfg.to_string_lossy(), "--yes"])
    }
}

/// `pnpm` steps of the Prepare button. `dir` is the package directory (`remote-relay` or `remote-web`).
pub fn pnpm(pnpm_bin: &Path, dir: &Path, args: &[&str], env: &[(String, EnvVal)]) -> Invocation {
    let mut argv = vec![pnpm_bin.to_string_lossy().into_owned()];
    argv.extend(args.iter().map(|a| (*a).to_owned()));
    Invocation { op: Op::Pnpm, argv, env: env.to_vec(), stdin: None, cwd: dir.to_path_buf(), timeout: Op::Pnpm.timeout() }
}

/// Which pipe a line came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// One output line. The raw text exists only so the caller can parse values the masker would hide (a 32-hex account id, a sign-in
/// URL); it must never be stored, emitted or logged. `masked()` is what everything else uses.
pub struct Line {
    raw: String,
    masked: String,
    pub stream: Stream,
}

impl Line {
    pub fn new(raw: &str, stream: Stream, masker: &Masker) -> Self {
        let raw: String = if raw.len() > MAX_INTAKE_BYTES {
            let mut end = MAX_INTAKE_BYTES;
            while !raw.is_char_boundary(end) {
                end -= 1;
            }
            raw[..end].to_owned()
        } else {
            raw.to_owned()
        };
        let masked = masker.mask(&raw);
        Self { raw, masked, stream }
    }

    pub fn masked(&self) -> &str {
        &self.masked
    }

    /// For in-memory parsing only (see the type docs).
    pub fn raw_for_parsing(&self) -> &str {
        &self.raw
    }
}

impl std::fmt::Debug for Line {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Line").field("masked", &self.masked).finish()
    }
}

/// How a run ended: the exit code (127 when the binary cannot start, 143 when signalled) and whether the timeout or a cancel fired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub exit_code: i32,
    pub timed_out: bool,
    pub cancelled: bool,
}

impl Outcome {
    pub fn ok(&self) -> bool {
        self.exit_code == 0 && !self.timed_out && !self.cancelled
    }
}

pub trait Spawner: Send + Sync {
    /// Runs one invocation to the end. `sink` receives the lines (see [`Line`]); `cancel` returns true once the user pressed Stop.
    fn run(&self, inv: &Invocation, sink: &mut dyn FnMut(&Line), cancel: &dyn Fn() -> bool) -> Outcome;
}

/// Proof that a Tauri command (the webview, a human gesture) is asking for a live wrangler run. Tests and agents have no way to get
/// one: the only call site allowed is `src-tauri/src/modules/relay_cloud.rs` inside a command body, enforced by a static test
/// (spec 4.12.3, threat T16).
pub struct LiveGesture(());

impl LiveGesture {
    #[doc(hidden)]
    pub fn mint_in_tauri_command(_site: &'static str) -> Self {
        LiveGesture(())
    }
}

/// Production spawner. Its constructor needs a [`LiveGesture`].
pub struct ProcessSpawner {
    _gesture: LiveGesture,
}

impl ProcessSpawner {
    pub fn new(gesture: LiveGesture) -> Self {
        Self { _gesture: gesture }
    }

    /// Unit tests of the runner itself (temp fake scripts only; never the kit's wrangler).
    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        Self { _gesture: LiveGesture(()) }
    }
}

const KILL_GRACE: Duration = Duration::from_secs(3);

fn killpg(pid: u32, sig: i32) {
    // SAFETY: plain signal delivery to the process group we created with `process_group(0)`.
    unsafe {
        libc::killpg(pid as i32, sig);
    }
}

/// Reads a pipe, splits on `\n` and `\r`, caps every line at [`MAX_INTAKE_BYTES`] (the masker cuts it to [`crate::mask::MAX_LINE_BYTES`] after masking) and hands masked lines to `tx`.
fn read_pipe(mut pipe: impl Read, stream: Stream, masker: Masker, tx: mpsc::Sender<Line>) {
    let mut chunk = [0u8; 4096];
    let mut buf: Vec<u8> = Vec::new();
    let mut overflow = false;
    let flush = |buf: &mut Vec<u8>, tx: &mpsc::Sender<Line>| {
        if !buf.is_empty() {
            let text = String::from_utf8_lossy(buf).into_owned();
            let _ = tx.send(Line::new(&text, stream, &masker));
            buf.clear();
        }
    };
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for &b in &chunk[..n] {
                    if b == b'\n' || b == b'\r' {
                        flush(&mut buf, &tx);
                        overflow = false;
                    } else if buf.len() < MAX_INTAKE_BYTES {
                        buf.push(b);
                    } else {
                        overflow = true;
                    }
                }
            }
        }
    }
    let _ = overflow;
    flush(&mut buf, &tx);
}

impl Spawner for ProcessSpawner {
    fn run(&self, inv: &Invocation, sink: &mut dyn FnMut(&Line), cancel: &dyn Fn() -> bool) -> Outcome {
        let failed_start = Outcome { exit_code: 127, timed_out: false, cancelled: false };
        let Some(program) = inv.argv.first() else { return failed_start };
        let masker = Masker::new(&inv.secrets());
        let mut cmd = Command::new(program);
        cmd.args(&inv.argv[1..]).env_clear();
        for (k, v) in &inv.env {
            match v {
                EnvVal::Plain(s) => cmd.env(k, s),
                EnvVal::Secret(s) => cmd.env(k, s.expose()),
            };
        }
        cmd.current_dir(&inv.cwd)
            .stdin(if inv.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(_) => return failed_start,
        };
        let pid = child.id();
        if let Some(secret) = &inv.stdin {
            if let Some(mut si) = child.stdin.take() {
                let _ = si.write_all(secret.expose().as_bytes());
                let _ = si.write_all(b"\n");
            }
        }
        let (tx, rx) = mpsc::channel::<Line>();
        if let Some(out) = child.stdout.take() {
            let (m, t) = (masker.clone(), tx.clone());
            std::thread::spawn(move || read_pipe(out, Stream::Stdout, m, t));
        }
        if let Some(err) = child.stderr.take() {
            let (m, t) = (masker.clone(), tx.clone());
            std::thread::spawn(move || read_pipe(err, Stream::Stderr, m, t));
        }
        drop(tx);

        let started = Instant::now();
        let mut timed_out = false;
        let mut cancelled = false;
        let mut terminated_at: Option<Instant> = None;
        let mut status: Option<std::process::ExitStatus> = None;
        loop {
            match rx.recv_timeout(Duration::from_millis(40)) {
                Ok(line) => sink(&line),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    if status.is_none() {
                        status = child.wait().ok();
                    }
                    break;
                }
            }
            if status.is_none() {
                status = child.try_wait().ok().flatten();
            }
            if let Some(t) = terminated_at {
                if t.elapsed() >= KILL_GRACE {
                    killpg(pid, libc::SIGKILL);
                    terminated_at = Some(Instant::now());
                }
            } else if cancel() {
                cancelled = true;
                killpg(pid, libc::SIGTERM);
                terminated_at = Some(Instant::now());
            } else if started.elapsed() >= inv.timeout {
                timed_out = true;
                killpg(pid, libc::SIGTERM);
                terminated_at = Some(Instant::now());
            }
            if status.is_some() {
                // The child is gone: anything still holding the pipes belongs to its group.
                killpg(pid, libc::SIGKILL);
                let deadline = Instant::now() + Duration::from_millis(500);
                while let Ok(line) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    sink(&line);
                }
                break;
            }
        }
        let status = status.or_else(|| child.wait().ok());
        let exit_code = status.and_then(|s| s.code()).unwrap_or(143);
        Outcome { exit_code, timed_out, cancelled }
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Scripted spawner (tests of this crate and of the Tauri glue): answers from a script, never starts a process.

type Hook = Arc<dyn Fn(&Invocation) + Send + Sync>;
type When = Arc<dyn Fn(&Invocation) -> bool + Send + Sync>;

/// One scripted answer.
#[derive(Clone, Default)]
pub struct Reply {
    pub lines: Vec<String>,
    pub exit: i32,
    pub timed_out: bool,
    /// Written to the file named by `WRANGLER_OUTPUT_FILE_PATH` (the NDJSON a real deploy writes).
    pub output_file: Option<String>,
    /// Runs before the reply is produced (create the files a real wrangler would, record something, ...).
    pub hook: Option<Hook>,
    /// Do not return until the cancel callback fires (a long login), then report `cancelled`.
    pub block_until_cancel: bool,
}

impl Reply {
    pub fn ok() -> Self {
        Self::default()
    }

    pub fn exit(code: i32, lines: &[&str]) -> Self {
        Self { exit: code, lines: lines.iter().map(|s| (*s).to_owned()).collect(), ..Self::default() }
    }

    pub fn lines(mut self, lines: &[&str]) -> Self {
        self.lines = lines.iter().map(|s| (*s).to_owned()).collect();
        self
    }

    pub fn output_file(mut self, ndjson: &str) -> Self {
        self.output_file = Some(ndjson.to_owned());
        self
    }

    pub fn hook(mut self, f: impl Fn(&Invocation) + Send + Sync + 'static) -> Self {
        self.hook = Some(Arc::new(f));
        self
    }

    pub fn blocking(mut self) -> Self {
        self.block_until_cancel = true;
        self
    }
}

struct Rule {
    op: Op,
    when: Option<When>,
    replies: VecDeque<Reply>,
    last: Option<Reply>,
}

/// What the fake saw (argv, the NAMES of the environment variables and the plain values, a hash of stdin; never a secret value).
#[derive(Debug, Clone)]
pub struct Call {
    pub op: Op,
    pub argv: Vec<String>,
    pub env_names: Vec<String>,
    pub env_plain: Vec<(String, String)>,
    pub stdin_sha256: Option<String>,
    pub cwd: PathBuf,
}

#[derive(Default)]
pub struct ScriptedSpawner {
    rules: Mutex<Vec<Rule>>,
    calls: Mutex<Vec<Call>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ScriptedSpawner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queues `reply` for `op`; the last queued reply repeats once the queue is used up.
    pub fn on(self, op: Op, reply: Reply) -> Self {
        {
            let mut rules = lock(&self.rules);
            if let Some(r) = rules.iter_mut().find(|r| r.op == op && r.when.is_none()) {
                r.replies.push_back(reply);
            } else {
                rules.push(Rule { op, when: None, replies: VecDeque::from([reply]), last: None });
            }
        }
        self
    }

    /// Like [`on`](Self::on) but only for invocations accepted by `when`; checked before the unconditional rules.
    pub fn on_when(self, op: Op, when: impl Fn(&Invocation) -> bool + Send + Sync + 'static, reply: Reply) -> Self {
        lock(&self.rules).insert(0, Rule { op, when: Some(Arc::new(when)), replies: VecDeque::from([reply]), last: None });
        self
    }

    pub fn calls(&self) -> Vec<Call> {
        lock(&self.calls).clone()
    }

    pub fn calls_of(&self, op: Op) -> Vec<Call> {
        self.calls().into_iter().filter(|c| c.op == op).collect()
    }

    fn pick(&self, inv: &Invocation) -> Option<Reply> {
        let mut rules = lock(&self.rules);
        let rule = rules.iter_mut().find(|r| r.op == inv.op && r.when.as_ref().map_or(true, |w| w(inv)))?;
        let reply = rule.replies.pop_front().or_else(|| rule.last.clone())?;
        rule.last = Some(reply.clone());
        Some(reply)
    }
}

impl Spawner for ScriptedSpawner {
    fn run(&self, inv: &Invocation, sink: &mut dyn FnMut(&Line), cancel: &dyn Fn() -> bool) -> Outcome {
        lock(&self.calls).push(Call {
            op: inv.op,
            argv: inv.argv.clone(),
            env_names: inv.env_names(),
            env_plain: inv.env.iter().filter_map(|(k, v)| if let EnvVal::Plain(s) = v { Some((k.clone(), s.clone())) } else { None }).collect(),
            stdin_sha256: inv.stdin.as_ref().map(|s| hex::encode(Sha256::digest(format!("{}\n", s.expose()).as_bytes()))),
            cwd: inv.cwd.clone(),
        });
        let Some(reply) = self.pick(inv) else { return Outcome { exit_code: 127, timed_out: false, cancelled: false } };
        if let Some(h) = &reply.hook {
            h(inv);
        }
        let masker = Masker::new(&inv.secrets());
        for l in &reply.lines {
            sink(&Line::new(l, Stream::Stderr, &masker));
        }
        if let (Some(text), Some((_, path))) = (&reply.output_file, inv.env.iter().find(|(k, _)| k == "WRANGLER_OUTPUT_FILE_PATH")) {
            if let EnvVal::Plain(p) = path {
                let _ = std::fs::write(p, text);
            }
        }
        if reply.block_until_cancel {
            let started = Instant::now();
            while !cancel() && started.elapsed() < Duration::from_secs(30) {
                std::thread::sleep(Duration::from_millis(5));
            }
            return Outcome { exit_code: 143, timed_out: false, cancelled: true };
        }
        Outcome { exit_code: reply.exit, timed_out: reply.timed_out, cancelled: false }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn inv(argv: Vec<String>, cwd: &Path, timeout: Duration) -> Invocation {
        Invocation { op: Op::Version, argv, env: vec![("PATH".into(), EnvVal::Plain("/usr/bin:/bin".into()))], stdin: None, cwd: cwd.to_path_buf(), timeout }
    }

    fn collect(sp: &dyn Spawner, i: &Invocation, cancel: &dyn Fn() -> bool) -> (Outcome, Vec<String>) {
        let mut lines = Vec::new();
        let o = sp.run(i, &mut |l| lines.push(l.masked().to_owned()), cancel);
        (o, lines)
    }

    #[test]
    fn runs_masks_and_reports_the_exit_code() {
        let d = tempfile::tempdir().unwrap();
        let s = script(d.path(), "fake", "echo hello; echo \"CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN\" >&2; echo \"$HOME|$INTELY_X|$NODE_OPTIONS\"; exit 3");
        let mut i = inv(vec![s.to_string_lossy().into_owned()], d.path(), Duration::from_secs(10));
        i.env.push(("CLOUDFLARE_API_TOKEN".into(), EnvVal::Secret(Secret::new("very-secret-token-value-0123456789"))));
        let (o, lines) = collect(&ProcessSpawner::for_tests(), &i, &|| false);
        assert_eq!(o.exit_code, 3);
        assert!(lines.contains(&"hello".to_owned()), "{lines:?}");
        assert!(lines.iter().all(|l| !l.contains("very-secret-token")), "{lines:?}");
        // Nothing is inherited: HOME was not passed, INTELY_X and NODE_OPTIONS do not exist.
        assert!(lines.iter().any(|l| l == "||"), "{lines:?}");
    }

    #[test]
    fn missing_binary_is_127() {
        let d = tempfile::tempdir().unwrap();
        let i = inv(vec![d.path().join("nope").to_string_lossy().into_owned()], d.path(), Duration::from_secs(5));
        assert_eq!(collect(&ProcessSpawner::for_tests(), &i, &|| false).0.exit_code, 127);
    }

    #[test]
    fn stdin_reaches_the_child_and_is_masked() {
        let d = tempfile::tempdir().unwrap();
        let s = script(d.path(), "fake", "read v; echo \"got:$v\"");
        let mut i = inv(vec![s.to_string_lossy().into_owned()], d.path(), Duration::from_secs(10));
        i.stdin = Some(Secret::new("vapid-private-value-abcdef"));
        let (o, lines) = collect(&ProcessSpawner::for_tests(), &i, &|| false);
        assert_eq!(o.exit_code, 0);
        assert_eq!(lines, vec!["got:***".to_owned()]);
    }

    #[test]
    fn stop_kills_the_whole_process_group() {
        let d = tempfile::tempdir().unwrap();
        let marker = d.path().join("child.pid");
        let s = script(d.path(), "fake", &format!("sleep 60 &\necho $! > {}\necho started\nwait", marker.display()));
        let i = inv(vec![s.to_string_lossy().into_owned()], d.path(), Duration::from_secs(60));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let st = stop.clone();
        let m2 = marker.clone();
        let t = std::thread::spawn(move || {
            while !m2.exists() || std::fs::read_to_string(&m2).unwrap_or_default().trim().is_empty() {
                std::thread::sleep(Duration::from_millis(20));
            }
            st.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let started = Instant::now();
        let (o, _) = collect(&ProcessSpawner::for_tests(), &i, &|| stop.load(std::sync::atomic::Ordering::SeqCst));
        t.join().unwrap();
        assert!(o.cancelled, "{o:?}");
        assert!(started.elapsed() < Duration::from_secs(10));
        let pid: i32 = std::fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        // SAFETY: signal 0 only tests whether the process exists.
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        assert!(!alive, "the sleep child survived the stop");
    }

    #[test]
    fn timeout_terminates_and_reports_it() {
        let d = tempfile::tempdir().unwrap();
        let s = script(d.path(), "fake", "sleep 30");
        let i = inv(vec![s.to_string_lossy().into_owned()], d.path(), Duration::from_millis(300));
        let (o, _) = collect(&ProcessSpawner::for_tests(), &i, &|| false);
        assert!(o.timed_out);
        assert_eq!(o.exit_code, 143);
    }

    #[test]
    fn overlong_lines_are_capped() {
        let d = tempfile::tempdir().unwrap();
        let s = script(d.path(), "fake", "head -c 200000 /dev/zero | tr '\\0' 'a'; echo; echo after");
        let i = inv(vec![s.to_string_lossy().into_owned()], d.path(), Duration::from_secs(10));
        let (o, lines) = collect(&ProcessSpawner::for_tests(), &i, &|| false);
        assert_eq!(o.exit_code, 0);
        assert!(lines.iter().all(|l| l.len() <= crate::mask::MAX_LINE_BYTES));
        assert!(lines.contains(&"after".to_owned()));
    }

    #[test]
    fn scripted_spawner_records_names_not_values() {
        let sp = ScriptedSpawner::new().on(Op::Whoami, Reply::ok().lines(&["{}"]));
        let env = [("CLOUDFLARE_API_TOKEN".to_owned(), EnvVal::Secret(Secret::new("tok-0123456789abcdef")))];
        let b = Base { wrangler: Path::new("/w/wrangler"), cwd: Path::new("/w"), env: &env };
        let i = b.whoami();
        let mut seen = vec![];
        let o = sp.run(&i, &mut |l| seen.push(l.masked().to_owned()), &|| false);
        assert_eq!(o.exit_code, 0);
        let c = &sp.calls()[0];
        assert_eq!(c.env_names, vec!["CLOUDFLARE_API_TOKEN".to_owned()]);
        assert!(c.env_plain.is_empty());
        assert!(!format!("{c:?}").contains("tok-0123456789abcdef"));
    }
}

#[cfg(test)]
mod argv_tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_owned()).collect()
    }

    /// The command lines of spec 4.3, byte for byte (argv[0] is the program).
    #[test]
    fn builders_match_the_spec_table() {
        let w = Path::new("/kit/relay/node_modules/.bin/wrangler");
        let env: Vec<(String, EnvVal)> = vec![("PATH".into(), EnvVal::Plain("/usr/bin".into()))];
        let b = Base { wrangler: w, cwd: Path::new("/state/w"), env: &env };
        let cfg = Path::new("/state/w/wrangler.jsonc");
        let prog = w.to_str().unwrap();
        let with = |rest: &[&str]| {
            let mut v = vec![prog.to_owned()];
            v.extend(s(rest));
            v
        };
        assert_eq!(b.version().argv, with(&["--version"]));
        assert_eq!(b.login(false).argv, with(&["login"]));
        assert_eq!(b.login(true).argv, with(&["login", "--device"]));
        assert_eq!(b.logout().argv, with(&["logout"]));
        assert_eq!(b.whoami().argv, with(&["whoami", "--json"]));
        assert_eq!(b.deployments_list(cfg, "n").argv, with(&["deployments", "list", "--name", "n", "--config", "/state/w/wrangler.jsonc"]));
        assert_eq!(b.deploy_dry_run(cfg, "n", Path::new("/tmp/o")).argv, with(&["deploy", "--dry-run", "--outdir", "/tmp/o", "--config", "/state/w/wrangler.jsonc", "--name", "n"]));
        let d = b.deploy(cfg, "n", "intely-relay:0123456789abcdef", Path::new("/state/out-1.ndjson"));
        assert_eq!(d.argv, with(&["deploy", "--config", "/state/w/wrangler.jsonc", "--name", "n", "--message", "intely-relay:0123456789abcdef"]));
        assert!(d.env_names().contains(&"WRANGLER_OUTPUT_FILE_PATH".to_owned()));
        let p = b.secret_put(cfg, "n", "VAPID_PRIVATE_KEY", Secret::new("the-value"));
        assert_eq!(p.argv, with(&["secret", "put", "VAPID_PRIVATE_KEY", "--name", "n", "--config", "/state/w/wrangler.jsonc"]));
        assert!(!p.argv.iter().any(|a| a.contains("the-value")), "the value goes to stdin, never argv");
        assert_eq!(p.stdin.as_ref().map(Secret::expose), Some("the-value"));
        assert_eq!(b.delete(cfg, "n", true).argv, with(&["delete", "--name", "n", "--config", "/state/w/wrangler.jsonc", "--force"]));
        assert_eq!(b.delete(cfg, "n", false).argv, with(&["delete", "--name", "n", "--config", "/state/w/wrangler.jsonc"]));
        for op in [Op::Version, Op::Login, Op::Whoami, Op::Deploy, Op::SecretPut, Op::Delete, Op::DeployDryRun] {
            assert!(op.timeout() >= Duration::from_secs(10));
        }
        assert_eq!(Op::Version.timeout().as_secs(), 10);
        assert_eq!(Op::Whoami.timeout().as_secs(), 30);
        assert_eq!(Op::Login.timeout().as_secs(), 300);
        assert_eq!(Op::Deploy.timeout().as_secs(), 300);
        assert_eq!(Op::SecretPut.timeout().as_secs(), 60);
        assert_eq!(Op::Delete.timeout().as_secs(), 120);
        assert_eq!(Op::DeployDryRun.timeout().as_secs(), 120);
    }

    #[test]
    fn invocation_display_and_debug_never_show_secret_values() {
        let w = Path::new("/w/wrangler");
        let env = vec![("CLOUDFLARE_API_TOKEN".to_owned(), EnvVal::Secret(Secret::new("tok-secret-value-123456")))];
        let b = Base { wrangler: w, cwd: Path::new("/c"), env: &env };
        let i = b.secret_put(Path::new("/c/wrangler.jsonc"), "n", "K", Secret::new("stdin-secret-value"));
        let shown = format!("{:?} {} {:?}", i, i.display(), i.env);
        assert!(!shown.contains("tok-secret-value") && !shown.contains("stdin-secret-value"), "{shown}");
        assert!(i.display().ends_with("< <secret via stdin>"));
        assert!(i.display().contains("CLOUDFLARE_API_TOKEN") == false, "env names are not part of the command line");
        assert_eq!(i.secrets().len(), 2);
    }

    #[test]
    fn the_child_environment_is_an_allow_list() {
        let vars: std::collections::HashMap<&str, &str> = [
            ("PATH", "/usr/bin"), ("HOME", "/Users/x"), ("TMPDIR", "/tmp"), ("LANG", "en_US.UTF-8"), ("USER", "x"), ("HTTPS_PROXY", "http://p:1"),
            ("CLOUDFLARE_API_TOKEN", "leak"), ("CLOUDFLARE_ACCOUNT_ID", "other"), ("CF_ACCOUNT_ID", "other"), ("NODE_OPTIONS", "--require x"),
            ("INTELY_E2E", "1"), ("NPM_CONFIG_REGISTRY", "x"), ("GIT_DIR", "x"), ("VITE_KEY", "x"), ("AWS_SECRET_ACCESS_KEY", "x"), ("SSH_AUTH_SOCK", "x"),
        ]
        .into_iter()
        .collect();
        let var = |k: &str| vars.get(k).map(|v| (*v).to_owned());
        let names = |token: Option<&Secret>, account: Option<&str>| -> Vec<String> {
            child_env(&ChildEnv { var: &var, state_root: Path::new("/state"), account_id: account, token }).into_iter().map(|(k, _)| k).collect()
        };
        let n = names(None, None);
        for want in ["PATH", "HOME", "TMPDIR", "LANG", "USER", "HTTPS_PROXY", "NO_COLOR", "WRANGLER_SEND_METRICS", "WRANGLER_LOG_PATH"] {
            assert!(n.contains(&want.to_owned()), "{want} missing from {n:?}");
        }
        for banned in ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID", "NODE_OPTIONS", "INTELY_E2E", "NPM_CONFIG_REGISTRY", "GIT_DIR", "VITE_KEY", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK"] {
            assert!(!n.contains(&banned.to_owned()), "{banned} leaked into {n:?}");
        }
        let t = Secret::new("cfut_abcdefghijklmnopqrstuvwxyz0123456789");
        let with = child_env(&ChildEnv { var: &var, state_root: Path::new("/state"), account_id: Some("acc123456"), token: Some(&t) });
        assert!(with.iter().any(|(k, v)| k == "CLOUDFLARE_ACCOUNT_ID" && matches!(v, EnvVal::Plain(x) if x == "acc123456")));
        assert!(with.iter().any(|(k, v)| k == "CLOUDFLARE_API_TOKEN" && matches!(v, EnvVal::Secret(_))));
        assert!(with.iter().any(|(k, v)| k == "WRANGLER_LOG_PATH" && matches!(v, EnvVal::Plain(x) if x == "/state/logs")));
        assert!(with.iter().any(|(k, v)| k == "WRANGLER_SEND_METRICS" && matches!(v, EnvVal::Plain(x) if x == "false")));
        assert!(!format!("{with:?}").contains("cfut_abcdef"));
    }
}
