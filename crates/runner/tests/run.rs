//! Fixture tests: a tiny fake dev server (node http on a random loopback port) under a throwaway temp repo proves start,
//! port detection, log, RSS, stop, no orphans, the secret canary and the jail. No real repo is touched, no network beyond
//! loopback. Needs `node`, `npm` and `lsof` on PATH.

use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use intely_agent_gate::gate::{procinfo, rss};
use intely_agent_gate::OrphanRegistry;
use intely_core::jail::Jail;
use intely_runner::types::{LogChunk, ServerInfo, ServerStatus};
use intely_runner::{RunManager, RunSink, StartOpts};

/// Built at run time so that no file holds a token-shaped literal except the one fixture the catalog test needs.
fn canary() -> String {
    format!("{}{}", "ghp_", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo")
}

const SERVER_JS: &str = r#"
const http = require('http');
const { spawn } = require('child_process');
const srv = http.createServer((q, r) => r.end('ok'));
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  console.log('\x1b[32mLocal:\x1b[0m http://localhost:' + port + '/');
  console.log('GH_TOKEN=' + 'ghp_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo');
  console.error('stderr line');
});
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
globalThis.ballast = Buffer.alloc(40 * 1024 * 1024, 1);
"#;

const GIT_WRITE_JS: &str = r#"
const { spawnSync } = require('child_process');
for (const args of [['commit', '--allow-empty', '-m', 'x'], ['checkout', '-b', 'evil'], ['reset', '--hard'], ['add', '-A'], ['status', '--short']]) {
  console.log('git ' + args[0] + ' -> ' + spawnSync('git', args).status);
}
"#;

const SPLIT_JS: &str = r#"
const t = 'ghp_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo';
console.log('ansi ' + t.slice(0, 12) + '\x1b[31m' + t.slice(12));
console.log('zwsp ' + t.slice(0, 14) + '\u200b' + t.slice(14));
console.log('b64 ' + Buffer.from('GH_TOKEN=' + t).toString('base64'));
process.stdout.write('late ' + t.slice(0, 16));
setTimeout(() => process.stdout.write(t.slice(16) + '\n'), 800);
"#;

const QUIET_JS: &str = "require('http').createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1');";

const STUBBORN_JS: &str = r#"
process.on('SIGTERM', () => {});
const { spawn } = require('child_process');
spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
console.log('stubborn up');
setInterval(() => {}, 1000);
"#;

fn package_json() -> String {
    format!(
        r#"{{"name":"fixture","version":"1.0.0","scripts":{{
          "dev":"node server.js","quiet":"node quiet.js","stubborn":"node stubborn.js",
          "heavy1":"node --max-old-space-size=4800 server.js","heavy2":"node --max-old-space-size=4800 server.js",
          "deploy":"node server.js","gitwrite":"node gitwrite.js","split":"node split.js",
          "login:github":"set GH_TOKEN={c} && set GH_TOKEN={c}"}}}}"#,
        c = canary()
    )
}

#[derive(Default)]
struct Collect {
    states: Mutex<Vec<ServerInfo>>,
    logs: Mutex<Vec<LogChunk>>,
}

impl RunSink for Collect {
    fn state(&self, server: ServerInfo) {
        self.states.lock().unwrap().push(server);
    }
    fn log(&self, chunk: LogChunk) {
        self.logs.lock().unwrap().push(chunk);
    }
}

struct Fx {
    repo: tempfile::TempDir,
    sink: Arc<Collect>,
    mgr: RunManager,
}

impl Drop for Fx {
    fn drop(&mut self) {
        self.mgr.shutdown();
    }
}

fn fixture_with(jail: Jail, orphans: Option<Arc<OrphanRegistry>>, grace: Duration) -> Fx {
    let repo = tempfile::tempdir().unwrap();
    let write = |n: &str, c: &str| std::fs::write(repo.path().join(n), c).unwrap();
    write("package.json", &package_json());
    write("server.js", SERVER_JS);
    write("quiet.js", QUIET_JS);
    write("gitwrite.js", GIT_WRITE_JS);
    write("split.js", SPLIT_JS);
    write("stubborn.js", STUBBORN_JS);
    let sink = Arc::new(Collect::default());
    let mgr = RunManager::with_grace(Arc::new(jail), orphans, sink.clone(), grace);
    Fx { repo, sink, mgr }
}

fn fixture() -> Fx {
    fixture_with(Jail::off(), None, Duration::from_secs(3))
}

fn wait_for<T>(what: &str, secs: u64, mut f: impl FnMut() -> Option<T>) -> T {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(Instant::now() < end, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn info(fx: &Fx, id: &str) -> ServerInfo {
    fx.mgr.list().into_iter().find(|s| s.id == id).expect("server listed")
}

fn all_log_text(fx: &Fx, id: &str) -> String {
    let ring = fx.mgr.logs(id, 0).unwrap().lines.join("\n");
    let events: Vec<String> = fx.sink.logs.lock().unwrap().iter().flat_map(|c| c.lines.clone()).collect();
    format!("{ring}\n{}", events.join("\n"))
}

fn start(fx: &Fx, script: &str, confirmed: bool) -> Result<ServerInfo, intely_core::EngineError> {
    fx.mgr.start("fx", fx.repo.path(), script, StartOpts { confirmed, allow_second_heavy: false, env: Default::default() })
}

fn exited(fx: &Fx, id: &str) {
    wait_for("exit", 20, || matches!(info(fx, id).status, ServerStatus::Exited).then_some(()));
}

fn alive(pids: &[i32]) -> Vec<i32> {
    pids.iter().copied().filter(|p| procinfo::is_alive(*p)).collect()
}

#[test]
fn start_detect_port_log_rss_stop_leaves_nothing_behind() {
    let fx = fixture();
    let id = "fx:npm:dev";
    let started = start(&fx, "npm:dev", false).unwrap();
    assert_eq!(started.id, id);
    let pid = started.pid.unwrap();

    let running = wait_for("port from the output", 30, || Some(info(&fx, id)).filter(|i| !i.ports.is_empty()));
    let port = running.ports[0];
    assert_eq!(running.url.as_deref(), Some(format!("http://localhost:{port}").as_str()));
    assert!(TcpStream::connect(("127.0.0.1", port)).is_ok(), "the fixture server really listens");

    let text = wait_for("log lines", 10, || Some(all_log_text(&fx, id)).filter(|t| t.contains("stderr line")));
    assert!(text.contains("\u{1b}[32mLocal:"), "ANSI is kept for the UI: {text}");
    assert!(text.contains("GH_TOKEN=***"), "{text}");

    let measured = wait_for("tree rss", 15, || Some(info(&fx, id)).filter(|i| i.rss_mb.is_some_and(|m| m >= 30) && i.procs >= 3));
    assert!(matches!(measured.status, ServerStatus::Running));
    let tree = rss::tree_pids(&[pid], &[pid]);
    assert!(tree.len() >= 3, "npm, node and the child: {tree:?}");

    fx.mgr.stop(id).unwrap();
    exited(&fx, id);
    wait_for("no process of the tree left", 10, || alive(&tree).is_empty().then_some(()));
    assert!(procinfo::live_group_pids(pid).is_empty());
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err(), "the port is closed");
    assert!(info(&fx, id).ports.is_empty() && info(&fx, id).pid.is_none());
}

#[test]
fn a_token_hidden_by_escapes_zero_width_text_base64_or_a_pause_never_reaches_the_log() {
    let fx = fixture();
    start(&fx, "npm:split", false).unwrap();
    exited(&fx, "fx:npm:split");
    let text = all_log_text(&fx, "fx:npm:split");
    for part in ["Zz9Yy8", "Xx7Ww6", "Vv5Uu4", "Tt3Ss2", "Rr1Qq0", "Pp9Oo"] {
        assert!(!text.contains(part), "{part} leaked: {text}");
    }
    assert!(text.contains("ansi ***") && text.contains("zwsp ***") && text.contains("b64 ***") && text.contains("late ***"), "{text}");
}

#[test]
fn a_port_the_server_never_prints_is_found_through_lsof() {
    let fx = fixture();
    let id = "fx:npm:quiet";
    start(&fx, "npm:quiet", false).unwrap();
    let found = wait_for("lsof port", 30, || Some(info(&fx, id)).filter(|i| !i.ports.is_empty()));
    assert!(TcpStream::connect(("127.0.0.1", found.ports[0])).is_ok());
    fx.mgr.stop(id).unwrap();
    exited(&fx, id);
}

#[test]
fn the_github_token_canary_never_reaches_the_catalog_the_log_or_an_event() {
    let fx = fixture();
    let token = canary();
    let secret = &token[4..];
    let catalog = intely_runner::catalog::catalog("fx", fx.repo.path()).unwrap();
    assert!(!serde_json::to_string(&catalog).unwrap().contains(secret));
    assert!(!intely_runner::catalog::display_command(fx.repo.path(), "npm:login:github").unwrap().contains(secret));

    // npm prints the script body when it runs one: the log must hold the masked form.
    let err = start(&fx, "npm:login:github", false).unwrap_err();
    assert_eq!(err.code, "confirmRequired");
    start(&fx, "npm:login:github", true).unwrap();
    let id = "fx:npm:login:github";
    exited(&fx, id);
    // dev prints the token at run time too.
    start(&fx, "npm:dev", false).unwrap();
    wait_for("token line", 20, || Some(()).filter(|_| all_log_text(&fx, "fx:npm:dev").contains("GH_TOKEN=***")));
    fx.mgr.stop("fx:npm:dev").unwrap();
    exited(&fx, "fx:npm:dev");

    for id in [id, "fx:npm:dev"] {
        let text = all_log_text(&fx, id);
        assert!(!text.contains(secret), "{id}: {text}");
    }
    let login_log = all_log_text(&fx, id);
    assert!(login_log.contains("GH_TOKEN=***"), "npm echoes the body, masked: {login_log}");
    let wire = serde_json::to_string(&(fx.mgr.list(), fx.sink.states.lock().unwrap().clone(), fx.sink.logs.lock().unwrap().clone())).unwrap();
    assert!(!wire.contains(secret), "no event, state or listing carries the token");
}

#[test]
fn a_process_that_ignores_sigterm_is_killed_after_the_grace() {
    let fx = fixture_with(Jail::off(), None, Duration::from_secs(1));
    let id = "fx:npm:stubborn";
    let pid = start(&fx, "npm:stubborn", false).unwrap().pid.unwrap();
    wait_for("log", 15, || Some(()).filter(|_| all_log_text(&fx, id).contains("stubborn up")));
    let tree = wait_for("tree", 10, || Some(rss::tree_pids(&[pid], &[pid])).filter(|t| t.len() >= 3));
    fx.mgr.stop(id).unwrap();
    exited(&fx, id);
    wait_for("everything gone", 10, || alive(&tree).is_empty().then_some(()));
}

#[test]
fn restart_gives_a_new_process_and_keeps_the_log() {
    let fx = fixture();
    let id = "fx:npm:dev";
    let first = start(&fx, "npm:dev", false).unwrap().pid.unwrap();
    wait_for("port", 30, || Some(()).filter(|_| !info(&fx, id).ports.is_empty()));
    let second = fx.mgr.restart(id, Default::default()).unwrap();
    assert_ne!(second.pid.unwrap(), first);
    wait_for("port again", 30, || Some(()).filter(|_| !info(&fx, id).ports.is_empty()));
    let text = all_log_text(&fx, id);
    assert_eq!(fx.mgr.logs(id, 0).unwrap().lines.iter().filter(|l| l.contains("npm run dev")).count(), 2, "{text}");
    assert_eq!(start(&fx, "npm:dev", false).unwrap_err().code, "alreadyRunning");
    fx.mgr.stop(id).unwrap();
    exited(&fx, id);
    assert!(alive(&[first]).is_empty());
}

#[test]
fn a_second_heavy_server_needs_an_explicit_ok() {
    let fx = fixture();
    start(&fx, "npm:heavy1", false).unwrap();
    let err = start(&fx, "npm:heavy2", false).unwrap_err();
    assert_eq!(err.code, "heavyRunning");
    assert!(err.message.contains("heavy1"), "{}", err.message);
    let ok = fx.mgr.start("fx", fx.repo.path(), "npm:heavy2", StartOpts { confirmed: false, allow_second_heavy: true, env: Default::default() });
    assert!(ok.is_ok());
    fx.mgr.stop_all();
    exited(&fx, "fx:npm:heavy1");
    exited(&fx, "fx:npm:heavy2");
}

#[test]
fn deploy_like_scripts_need_the_confirmation() {
    let fx = fixture();
    let catalog = intely_runner::catalog::catalog("fx", fx.repo.path()).unwrap();
    let deploy = catalog.scripts.iter().find(|s| s.name == "deploy").unwrap();
    assert!(deploy.forbidden_to_agents);
    assert_eq!(start(&fx, "npm:deploy", false).unwrap_err().code, "confirmRequired");
    assert!(fx.mgr.list().is_empty(), "nothing was spawned");
}

#[test]
fn read_only_jail_refuses_processes_until_allowed_and_stops_them_when_revoked() {
    let fx = fixture_with(Jail::read_only(), None, Duration::from_secs(3));
    let err = start(&fx, "npm:quiet", false).unwrap_err();
    assert_eq!(err.code, "readOnly");
    assert!(err.message.contains("Allow processes"));
    assert!(fx.mgr.list().is_empty());
    let access = fx.mgr.access(Some(fx.repo.path()));
    assert!(!access.startable && !access.allowed && access.jail == "readOnly");

    fx.mgr.set_allow_processes(true);
    assert!(fx.mgr.access(Some(fx.repo.path())).startable);
    let pid = start(&fx, "npm:quiet", false).unwrap().pid.unwrap();
    let tree = wait_for("tree", 10, || Some(rss::tree_pids(&[pid], &[pid])).filter(|t| t.len() >= 2));
    fx.mgr.set_allow_processes(false);
    exited(&fx, "fx:npm:quiet");
    wait_for("gone", 10, || alive(&tree).is_empty().then_some(()));
    assert_eq!(start(&fx, "npm:quiet", false).unwrap_err().code, "readOnly");
}

/// A fixture repo with nothing committed; `git` runs with the host's config switched off.
fn git_fixture(fx: &Fx) {
    let ok = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(fx.repo.path())
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .status()
        .unwrap()
        .success();
    assert!(ok);
}

fn run_git_writes(fx: &Fx) -> String {
    git_fixture(fx);
    let identity = [("GIT_AUTHOR_NAME", "t"), ("GIT_AUTHOR_EMAIL", "t@example.invalid"), ("GIT_COMMITTER_NAME", "t"), ("GIT_COMMITTER_EMAIL", "t@example.invalid")];
    let env = identity.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    fx.mgr.start("fx", fx.repo.path(), "npm:gitwrite", StartOpts { env, ..StartOpts::default() }).unwrap();
    exited(fx, "fx:npm:gitwrite");
    wait_for("log", 10, || Some(all_log_text(fx, "fx:npm:gitwrite")).filter(|t| t.contains("git status ->")))
}

#[test]
fn a_script_started_in_read_only_mode_cannot_commit_checkout_reset_or_add() {
    // Control: without a jail the same script does commit, so the test can tell a refusal from an inert script.
    let open = fixture();
    let text = run_git_writes(&open);
    assert!(text.contains("git commit -> 0"), "{text}");

    let fx = fixture_with(Jail::read_only(), None, Duration::from_secs(3));
    fx.mgr.set_allow_processes(true);
    let text = run_git_writes(&fx);
    for verb in ["commit", "checkout", "reset", "add"] {
        assert!(text.contains(&format!("git {verb} -> 126")), "{verb}: {text}");
    }
    assert!(text.contains("git status -> 0"), "reads still work: {text}");
    let head = std::process::Command::new("git").args(["rev-parse", "--verify", "-q", "HEAD"]).current_dir(fx.repo.path()).env("GIT_CONFIG_GLOBAL", "/dev/null").status().unwrap();
    assert!(!head.success(), "HEAD must still be unborn");
}

#[test]
fn e2e_jail_only_runs_inside_the_fixture_root() {
    let inside = tempfile::tempdir().unwrap();
    let fx = fixture_with(Jail::e2e(inside.path()), None, Duration::from_secs(3));
    // The fixture repo lives in another temp dir, outside the jail's fixture root.
    assert_eq!(start(&fx, "npm:quiet", false).unwrap_err().code, "testJail");
    fx.mgr.set_allow_processes(true);
    assert_eq!(start(&fx, "npm:quiet", false).unwrap_err().code, "testJail", "the switch does not widen the E2E jail");

    let root = tempfile::tempdir().unwrap();
    let jailed = fixture_with(Jail::e2e(root.path()), None, Duration::from_secs(3));
    let inner = root.path().join("repo");
    std::fs::create_dir(&inner).unwrap();
    for n in ["package.json", "quiet.js"] {
        std::fs::copy(jailed.repo.path().join(n), inner.join(n)).unwrap();
    }
    let started = jailed.mgr.start("fx", &inner, "npm:quiet", StartOpts::default());
    assert!(started.is_ok(), "{started:?}");
    jailed.mgr.stop_all();
    exited(&jailed, "fx:npm:quiet");
}

#[test]
fn the_orphan_registry_tracks_the_group_while_it_runs() {
    let state = tempfile::tempdir().unwrap();
    let registry = Arc::new(OrphanRegistry::open(state.path().join("run-gate.json")).unwrap());
    let fx = fixture_with(Jail::off(), Some(registry.clone()), Duration::from_secs(3));
    let pid = start(&fx, "npm:quiet", false).unwrap().pid.unwrap();
    assert_eq!(registry.recorded().unwrap(), vec![pid]);
    fx.mgr.stop("fx:npm:quiet").unwrap();
    exited(&fx, "fx:npm:quiet");
    wait_for("forgotten", 5, || registry.recorded().unwrap().is_empty().then_some(()));
}

#[test]
fn shutdown_ends_every_server() {
    let fx = fixture();
    let pid = start(&fx, "npm:dev", false).unwrap().pid.unwrap();
    let tree = wait_for("tree", 20, || Some(rss::tree_pids(&[pid], &[pid])).filter(|t| t.len() >= 3));
    fx.mgr.shutdown();
    wait_for("gone", 10, || alive(&tree).is_empty().then_some(()));
}

#[test]
fn clearing_the_log_resets_the_view_but_not_the_sequence() {
    let fx = fixture();
    start(&fx, "npm:quiet", false).unwrap();
    let id = "fx:npm:quiet";
    wait_for("marker", 10, || Some(()).filter(|_| !fx.mgr.logs(id, 0).unwrap().lines.is_empty()));
    let before = fx.mgr.logs(id, 0).unwrap();
    fx.mgr.clear_log(id).unwrap();
    let after = fx.mgr.logs(id, 0).unwrap();
    assert!(after.lines.is_empty() && after.start_seq >= before.start_seq + before.lines.len() as u32);
    assert!(fx.sink.logs.lock().unwrap().iter().any(|c| c.reset));
    fx.mgr.stop(id).unwrap();
    exited(&fx, id);
}
