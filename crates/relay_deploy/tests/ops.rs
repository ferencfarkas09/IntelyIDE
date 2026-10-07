//! Sign-in, whoami, Prepare, rollback, remove, the VAPID secrets and the jail matrix at the Deployer level (spec 4.9, 11.1, 11.4b).
//! Everything is scripted: no process starts, no network.

mod common;

use std::fs;
use std::sync::Arc;

use common::*;
use intely_core::jail::Jail;
use intely_relay_deploy::output::WhoAmI;
use intely_relay_deploy::{keys, AuthCtx, AuthMode, JobEvent, Op, PlanRequest, Reply, ScriptedSpawner};
use sha2::{Digest, Sha256};

fn fixture_text(name: &str) -> Vec<String> {
    fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap().lines().map(str::to_owned).collect()
}

fn refs(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

fn oauth() -> AuthCtx {
    AuthCtx { mode: AuthMode::Oauth, account_id: Some(ACCOUNT_ID.to_owned()) }
}

#[test]
fn login_reports_the_dashboard_url_once_and_masks_the_log() {
    let mut lines = fixture_text("login-url.txt");
    lines.push("Opening https://evil.example/phish?x=1".to_owned());
    let f = fixture(ScriptedSpawner::new().on(Op::Login, Reply::ok().lines(&refs(&lines))));
    let mut ev = Vec::new();
    f.deployer.login(false, &mut |e| ev.push(e)).expect("login");
    let urls: Vec<&String> = ev.iter().filter_map(|e| if let JobEvent::LoginUrl(u) = e { Some(u) } else { None }).collect();
    assert_eq!(urls.len(), 1, "{urls:?}");
    assert!(urls[0].starts_with("https://dash.cloudflare.com/oauth2/auth?"));
    // Real `wrangler login` blocks until the browser call-back: the URL must go out while it runs, not after it exits.
    let url_at = ev.iter().position(|e| matches!(e, JobEvent::LoginUrl(_))).unwrap();
    let last_log = ev.iter().rposition(|e| matches!(e, JobEvent::Log(_))).unwrap();
    assert!(url_at < last_log, "LoginUrl must be emitted from inside the line callback");
    let logged: String = ev.iter().filter_map(|e| if let JobEvent::Log(l) = e { Some(l.clone()) } else { None }).collect::<Vec<_>>().join("\n");
    assert!(!logged.contains("Zm9vYmFyMTIzNDU2") && !logged.contains("code_challenge=abc123") || logged.contains("***"), "{logged}");
    assert!(!logged.contains("state=Zm9vYmFyMTIzNDU2"), "OAuth query values are masked in the log: {logged}");
    let call = &f.spawner.calls()[0];
    assert_eq!(&call.argv[1..], &["login".to_owned()]);
    assert!(call.env_names.iter().all(|n| n != "CLOUDFLARE_ACCOUNT_ID" && n != "CLOUDFLARE_API_TOKEN"));
    assert_ne!(call.cwd, f.kit.root, "never the repo kit");
}

#[test]
fn device_login_uses_the_device_flag() {
    let f = fixture(ScriptedSpawner::new().on(Op::Login, Reply::ok()));
    f.deployer.login(true, &mut |_| {}).unwrap();
    assert_eq!(&f.spawner.calls()[0].argv[1..], &["login".to_owned(), "--device".to_owned()]);
}

#[test]
fn login_can_be_stopped_and_a_second_operation_is_busy() {
    let f = Arc::new(fixture(ScriptedSpawner::new().on(Op::Login, Reply::ok().blocking())));
    let f2 = f.clone();
    let t = std::thread::spawn(move || f2.deployer.login(false, &mut |_| {}));
    let run_id = loop {
        if let Some((id, _)) = f.deployer.runner().busy() {
            if !f.spawner.calls().is_empty() {
                break id;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    assert_eq!(f.deployer.whoami(&oauth(), &mut |_| {}).unwrap_err().code(), "busy");
    f.deployer.stop(&run_id);
    assert_eq!(t.join().unwrap().unwrap_err().code(), "cancelled");
    assert!(f.deployer.runner().busy().is_none());
}

#[test]
fn login_failures_are_classified() {
    for (line, code) in [("Error: listen EADDRINUSE: address already in use 127.0.0.1:8976", "loginPortBusy"), ("getaddrinfo ENOTFOUND dash.cloudflare.com", "network")] {
        let f = fixture(ScriptedSpawner::new().on(Op::Login, Reply::exit(1, &[line])));
        assert_eq!(f.deployer.login(false, &mut |_| {}).unwrap_err().code(), code);
    }
    let timed_out = Reply { timed_out: true, exit: 143, ..Reply::ok() };
    let f = fixture(ScriptedSpawner::new().on(Op::Login, timed_out));
    assert_eq!(f.deployer.login(false, &mut |_| {}).unwrap_err().code(), "timeout");
}

#[test]
fn whoami_logged_in_logged_out_and_bad_token() {
    let json = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/whoami-oauth.json")).unwrap();
    let jl: Vec<&str> = json.lines().collect();
    let f = fixture(ScriptedSpawner::new().on(Op::Whoami, Reply::ok().lines(&jl)));
    let w = f.deployer.whoami(&oauth(), &mut |_| {}).unwrap();
    assert!(w.logged_in);
    assert_eq!(w.accounts[0].id, ACCOUNT_ID, "the 32-hex id is parsed from the raw line, not the masked one");
    assert_eq!(w.chosen_account_id.as_deref(), Some(ACCOUNT_ID));
    assert_eq!(w.email_hint.as_deref(), Some("a***@e***.test"));
    assert_eq!(&f.spawner.calls()[0].argv[1..], &["whoami".to_owned(), "--json".to_owned()]);
    assert!(f.spawner.calls()[0].env_names.iter().all(|n| n != "CLOUDFLARE_ACCOUNT_ID"), "whoami runs before an account is chosen");

    let lo = fixture_text("whoami-loggedout.txt");
    let f = fixture(ScriptedSpawner::new().on(Op::Whoami, Reply::exit(1, &refs(&lo))));
    assert_eq!(f.deployer.whoami(&oauth(), &mut |_| {}).unwrap(), WhoAmI::logged_out());

    let f = fixture(ScriptedSpawner::new().on(Op::Whoami, Reply::exit(1, &["Authentication error [code: 10000]"])));
    assert_eq!(f.deployer.whoami(&oauth(), &mut |_| {}).unwrap_err().code(), "authInvalid");
    let f = fixture(ScriptedSpawner::new().on(Op::Whoami, Reply::ok().lines(&["<html>proxy</html>"])));
    assert!(f.deployer.whoami(&oauth(), &mut |_| {}).is_err());
}

#[test]
fn token_mode_without_a_stored_token_is_not_logged_in() {
    let f = fixture(ScriptedSpawner::new().on(Op::Whoami, Reply::ok()));
    let e = f.deployer.whoami(&AuthCtx { mode: AuthMode::Token, account_id: None }, &mut |_| {}).unwrap_err();
    assert_eq!(e.code(), "notLoggedIn");
    assert!(f.spawner.calls().is_empty());
}

#[test]
fn logout_runs_wrangler_logout() {
    let f = fixture(ScriptedSpawner::new().on(Op::Logout, Reply::ok()));
    f.deployer.logout(&mut |_| {}).unwrap();
    assert_eq!(&f.spawner.calls()[0].argv[1..], &["logout".to_owned()]);
}

#[test]
fn version_button_checks_the_pin() {
    let f = fixture(ScriptedSpawner::new().on(Op::Version, Reply::ok().lines(&[" ⛅️ wrangler 4.147.0"])));
    assert_eq!(f.deployer.spawn_version(&mut |_| {}).unwrap(), "4.147.0");
    let f = fixture(ScriptedSpawner::new().on(Op::Version, Reply::ok().lines(&["4.150.1"])));
    assert_eq!(f.deployer.spawn_version(&mut |_| {}).unwrap_err().code(), "wranglerVersion");
}

#[test]
fn prepare_runs_the_three_pnpm_steps_without_vite_variables() {
    let f = fixture_with(
        ScriptedSpawner::new().on(Op::Pnpm, Reply::ok().lines(&["Done"])),
        FixtureOpts { env: vec![("VITE_SECRET", "x".into()), ("NPM_CONFIG_USERCONFIG", "/evil".into())], pnpm_stub: true, ..FixtureOpts::default() },
    );
    f.deployer.prepare(&mut |_| {}).unwrap();
    let calls = f.spawner.calls_of(Op::Pnpm);
    assert_eq!(calls.len(), 3);
    let tail = |i: usize| calls[i].argv[1..].join(" ");
    assert_eq!((tail(0).as_str(), calls[0].cwd.clone()), ("install --frozen-lockfile", f.kit.relay_dir.clone()));
    assert_eq!((tail(1).as_str(), calls[1].cwd.clone()), ("install --frozen-lockfile", f.kit.web_dir.clone()));
    assert_eq!((tail(2).as_str(), calls[2].cwd.clone()), ("build", f.kit.web_dir.clone()));
    for c in &calls {
        assert!(c.env_names.iter().all(|n| !n.starts_with("VITE_") && !n.starts_with("NPM_CONFIG") && !n.starts_with("CLOUDFLARE")), "{:?}", c.env_names);
    }
    // a failing step stops the sequence
    let f = fixture_with(ScriptedSpawner::new().on(Op::Pnpm, Reply::exit(1, &["ERR_PNPM_LOCKFILE_BREAKING_CHANGE"])), FixtureOpts { pnpm_stub: true, ..FixtureOpts::default() });
    assert_eq!(f.deployer.prepare(&mut |_| {}).unwrap_err().code(), "deployFailed");
    assert_eq!(f.spawner.calls_of(Op::Pnpm).len(), 1);
    // no pnpm (or node) on PATH: the kit is fine, the tools are missing, and the error must not say the kit is
    let f = fixture(ScriptedSpawner::new());
    assert_eq!(f.deployer.prepare(&mut |_| {}).unwrap_err().code(), "toolMissing");
}

#[test]
fn rollback_and_remove_need_a_plan_the_typed_name_and_a_generated_config() {
    let f = fixture(happy_spawner(WORKER).on(Op::Rollback, Reply::ok()).on(Op::Delete, Reply::ok().lines(&["Successfully deleted"])));
    let plan = |op: &str, force: bool| {
        f.deployer.plan(&if op == "rollback" { PlanRequest::Rollback { worker: WORKER.into(), auth: oauth() } } else { PlanRequest::Remove { worker: WORKER.into(), auth: oauth(), force } })
    };
    // no config yet: no plan, and no run
    assert_eq!(plan("rollback", false).unwrap_err().code(), "previewStale");
    assert_eq!(f.deployer.rollback(WORKER, &oauth(), WORKER, &"0".repeat(32), &mut |_| {}).unwrap_err().code(), "previewStale");
    f.preview(false);
    // a wrong typed name does not run (and a typo does not spend the plan)
    let p = plan("rollback", false).unwrap();
    assert_eq!(f.deployer.rollback(WORKER, &oauth(), "wrong", &p.plan_id, &mut |_| {}).unwrap_err().code(), "confirmMismatch");
    let q = plan("remove", false).unwrap();
    assert_eq!(f.deployer.remove(WORKER, &oauth(), "", &q.plan_id, false, &mut |_| {}).unwrap_err().code(), "confirmMismatch");
    assert!(f.spawner.calls_of(Op::Rollback).is_empty() && f.spawner.calls_of(Op::Delete).is_empty());
    f.deployer.rollback(WORKER, &oauth(), WORKER, &p.plan_id, &mut |_| {}).unwrap();
    let cfg = f.worker_dir().join("wrangler.jsonc").to_string_lossy().into_owned();
    assert_eq!(f.spawner.calls_of(Op::Rollback)[0].argv[1..], ["rollback", "--name", WORKER, "--config", cfg.as_str(), "--yes"]);
    assert_eq!(p.argv, f.spawner.calls_of(Op::Rollback)[0].argv, "the plan held exactly the argv that ran");
    // delete without --force answers the prompt on stdin; with --force there is no stdin
    f.deployer.remove(WORKER, &oauth(), WORKER, &q.plan_id, false, &mut |_| {}).unwrap();
    let q2 = plan("remove", true).unwrap();
    f.deployer.remove(WORKER, &oauth(), WORKER, &q2.plan_id, true, &mut |_| {}).unwrap();
    let d = f.spawner.calls_of(Op::Delete);
    assert_eq!(d[0].argv[1..], ["delete", "--name", WORKER, "--config", cfg.as_str()]);
    assert_eq!(d[0].stdin_sha256.as_deref(), Some(hex::encode(Sha256::digest(b"y\n")).as_str()));
    assert_eq!(d[1].argv[1..], ["delete", "--name", WORKER, "--config", cfg.as_str(), "--force"]);
    assert_eq!(d[1].stdin_sha256, None);
    assert!(d[0].env_plain.iter().any(|(k, v)| k == "CLOUDFLARE_ACCOUNT_ID" && v == ACCOUNT_ID));
}

#[test]
fn a_spent_expired_or_foreign_plan_runs_nothing() {
    let f = fixture(happy_spawner(WORKER).on(Op::Rollback, Reply::ok()).on(Op::Delete, Reply::ok()));
    f.preview(false);
    let remove = || f.deployer.plan(&PlanRequest::Remove { worker: WORKER.into(), auth: oauth(), force: false }).unwrap();
    let rollback = || f.deployer.plan(&PlanRequest::Rollback { worker: WORKER.into(), auth: oauth() }).unwrap();
    // replay
    let p = remove();
    f.deployer.remove(WORKER, &oauth(), WORKER, &p.plan_id, false, &mut |_| {}).unwrap();
    assert_eq!(f.deployer.remove(WORKER, &oauth(), WORKER, &p.plan_id, false, &mut |_| {}).unwrap_err().code(), "previewStale");
    assert_eq!(f.spawner.calls_of(Op::Delete).len(), 1, "the replay spawned nothing");
    // expiry
    let p = remove();
    f.clock.advance(intely_relay_deploy::plan::PLAN_TTL_SECS);
    assert_eq!(f.deployer.remove(WORKER, &oauth(), WORKER, &p.plan_id, false, &mut |_| {}).unwrap_err().code(), "previewStale");
    // a rollback plan cannot remove, a made-up nonce cannot do either
    let p = rollback();
    assert_eq!(f.deployer.remove(WORKER, &oauth(), WORKER, &p.plan_id, false, &mut |_| {}).unwrap_err().code(), "previewStale");
    assert_eq!(f.deployer.rollback(WORKER, &oauth(), WORKER, &p.plan_id, &mut |_| {}).unwrap_err().code(), "previewStale", "dropped by the wrong-operation attempt");
    assert_eq!(f.deployer.remove(WORKER, &oauth(), WORKER, "", false, &mut |_| {}).unwrap_err().code(), "previewStale");
    // the plan is for the argv it showed: --force changes the command, so the run is refused
    let p = remove();
    assert_eq!(f.deployer.remove(WORKER, &oauth(), WORKER, &p.plan_id, true, &mut |_| {}).unwrap_err().code(), "previewStale");
    assert_eq!(f.spawner.calls_of(Op::Delete).len(), 1);
    assert!(f.spawner.calls_of(Op::Rollback).is_empty());
}

#[test]
fn vapid_secrets_can_be_pushed_later_and_fail_with_secret_failed() {
    let f = fixture(happy_spawner(WORKER));
    f.preview(true);
    f.deployer.put_vapid_secrets(WORKER, HOST, &oauth(), &mut |_| {}).unwrap();
    assert_eq!(f.spawner.calls_of(Op::SecretPut).len(), 3);
    let f = fixture(happy_spawner(WORKER).on_when(Op::SecretPut, |_| true, Reply::exit(1, &["boom"])));
    f.preview(true);
    assert_eq!(f.deployer.put_vapid_secrets(WORKER, HOST, &oauth(), &mut |_| {}).unwrap_err().code(), "secretFailed");
    // without a VAPID key there is nothing to push
    let f = fixture(happy_spawner(WORKER));
    f.preview(false);
    assert_eq!(f.deployer.put_vapid_secrets(WORKER, HOST, &oauth(), &mut |_| {}).unwrap_err().code(), "secretFailed");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The jail matrix of spec 4.9: every command, every mode.

type Runner = Box<dyn Fn(&Fixture) -> Result<(), intely_relay_deploy::DeployError>>;

fn commands() -> Vec<(&'static str, Runner)> {
    vec![
        ("login", Box::new(|f| f.deployer.login(false, &mut |_| {}))),
        ("logout", Box::new(|f| f.deployer.logout(&mut |_| {}))),
        ("whoami", Box::new(|f| f.deployer.whoami(&oauth(), &mut |_| {}).map(|_| ()))),
        ("preview", Box::new(|f| f.deployer.preview(&f.preview_req(false), &mut |_| {}).map(|_| ()))),
        ("prepare", Box::new(|f| f.deployer.prepare(&mut |_| {}))),
    ]
}

fn matrix_fixture(jail: Jail, cloud: bool) -> Fixture {
    let s = happy_spawner(WORKER).on(Op::Login, Reply::ok()).on(Op::Logout, Reply::ok()).on(Op::Whoami, Reply::ok().lines(&["{\"loggedIn\":false}"])).on(Op::Pnpm, Reply::ok());
    fixture_with(s, FixtureOpts { jail, cloud, pnpm_stub: true, ..FixtureOpts::default() })
}

#[test]
fn read_only_refuses_every_command_with_zero_spawns() {
    for (name, run) in commands() {
        let f = matrix_fixture(Jail::read_only(), false);
        let e = run(&f).unwrap_err();
        assert_eq!(e.code(), "readOnly", "{name}");
        assert!(f.spawner.calls().is_empty(), "{name}: spawned in read-only mode");
    }
    // Status reads settings and the filesystem only.
    let f = matrix_fixture(Jail::read_only(), false);
    assert!(f.deployer.kit_report().found);
    // the explicit version button is the one spawn READONLY keeps (docs 11.1)
    let f = fixture_with(ScriptedSpawner::new().on(Op::Version, Reply::ok().lines(&["4.147.0"])), FixtureOpts { jail: Jail::read_only(), ..FixtureOpts::default() });
    assert!(f.deployer.spawn_version(&mut |_| {}).is_ok());
}

#[test]
fn intely_cloud_lifts_read_only_for_the_relay_commands() {
    for (name, run) in commands() {
        let f = matrix_fixture(Jail::read_only(), true);
        // preview needs a built dist and a durable store: both exist in the fixture
        let r = run(&f);
        assert!(r.is_ok(), "{name}: {r:?}");
        assert!(!f.spawner.calls().is_empty(), "{name}");
    }
}

#[test]
fn the_test_jail_allows_fixture_binaries_only_and_never_pnpm_or_the_cloud_flag() {
    let tmp = std::env::temp_dir();
    for cloud in [false, true] {
        for (name, run) in commands() {
            let f = matrix_fixture(Jail::e2e(&tmp), cloud);
            let r = run(&f);
            if name == "prepare" {
                assert_eq!(r.unwrap_err().code(), "testJail", "{name}: pnpm is refused in the test jail (cloud={cloud})");
                assert!(f.spawner.calls().is_empty());
            } else {
                assert!(r.is_ok(), "{name} cloud={cloud}: {r:?}");
            }
        }
    }
    // A binary outside the fixture root is refused whatever the cloud flag says (the gate sees the program, not the kit).
    use intely_relay_deploy::gate::gate;
    let e2e = Jail::e2e(&tmp);
    for cloud in [false, true] {
        assert_eq!(gate(&e2e, Op::Login, std::path::Path::new("/usr/local/bin/wrangler"), cloud).unwrap_err().code(), "testJail");
        assert!(gate(&e2e, Op::Login, &tmp.join("wrangler"), cloud).is_ok());
        assert_eq!(gate(&e2e, Op::Node, &tmp.join("node"), cloud).unwrap_err().code(), "testJail");
    }
}

#[test]
fn the_wrangler_override_is_honoured_only_inside_the_test_jail() {
    use intely_relay_deploy::gate::wrangler_bin_override;
    let tmp = std::env::temp_dir();
    let inside = tmp.join("fake-wrangler-bin");
    let e2e = Jail::e2e(&tmp);
    assert_eq!(wrangler_bin_override(&e2e, Some(inside.to_str().unwrap())), Some(inside.as_path()));
    assert_eq!(wrangler_bin_override(&e2e, Some("/usr/local/bin/wrangler")), None, "outside the fixture root");
    assert_eq!(wrangler_bin_override(&Jail::off(), Some(inside.to_str().unwrap())), None, "never outside the test jail");
    assert_eq!(wrangler_bin_override(&Jail::read_only(), Some(inside.to_str().unwrap())), None);
    assert_eq!(wrangler_bin_override(&e2e, Some("")), None);
    assert_eq!(wrangler_bin_override(&e2e, None), None);
}

#[test]
fn the_secret_store_rule_has_one_exception_the_test_jail() {
    use intely_relay_deploy::keys::require_durable;
    let durable = FakeKeychain::durable();
    let degraded = FakeKeychain::degraded();
    assert!(require_durable(&*durable, &Jail::off()).is_ok());
    assert_eq!(require_durable(&*degraded, &Jail::off()).unwrap_err().code(), "secretStoreVolatile");
    let mem = intely_settings::secrets::MemorySecretStore::new();
    assert_eq!(require_durable(&mem, &Jail::off()).unwrap_err().code(), "secretStoreVolatile", "a plain memory store is not durable");
    assert_eq!(require_durable(&mem, &Jail::read_only()).unwrap_err().code(), "secretStoreVolatile");
    assert!(require_durable(&mem, &Jail::e2e(std::env::temp_dir())).is_ok(), "the E2E harness runs on a memory store on purpose");
    assert_eq!(require_durable(&*degraded, &Jail::e2e(std::env::temp_dir())).unwrap_err().code(), "secretStoreVolatile");
}

#[test]
fn keys_are_created_once_and_a_rotation_stays_staged_until_it_is_committed() {
    let store = FakeKeychain::durable();
    let (k1, p1, created) = keys::signing_key(&*store, &Jail::off()).unwrap();
    assert!(created);
    let (k2, p2, created) = keys::signing_key(&*store, &Jail::off()).unwrap();
    assert!(!created && p1 == p2 && k1 == k2);
    // stage: the active key is untouched, the next deploy signs with the staged one
    assert!(keys::staged_signing_key(&*store).unwrap().is_none());
    let p3 = keys::stage_signing_key(&*store, &Jail::off()).unwrap();
    assert_ne!(p1, p3);
    assert_eq!(keys::signing_key(&*store, &Jail::off()).unwrap().1, p1, "the active key did not change");
    let (_, used, staged) = keys::signing_key_for_deploy(&*store, &Jail::off()).unwrap();
    assert!(staged && used == p3);
    // a commit for another public key changes nothing
    assert!(!keys::commit_staged_signing_key(&*store, &p1).unwrap());
    assert_eq!(keys::signing_key(&*store, &Jail::off()).unwrap().1, p1);
    // commit: the staged key becomes the active one and the slot is empty again
    assert!(keys::commit_staged_signing_key(&*store, &p3).unwrap());
    assert_eq!(keys::signing_key(&*store, &Jail::off()).unwrap().1, p3);
    assert!(keys::staged_signing_key(&*store).unwrap().is_none());
    assert!(!keys::commit_staged_signing_key(&*store, &p3).unwrap(), "nothing left to commit");
    // roll back: the staged key is deleted and the active one stays
    let p4 = keys::stage_signing_key(&*store, &Jail::off()).unwrap();
    assert!(keys::discard_staged_signing_key(&*store).unwrap());
    assert!(!keys::discard_staged_signing_key(&*store).unwrap());
    assert_eq!(keys::signing_key_for_deploy(&*store, &Jail::off()).unwrap().1, p3);
    assert_ne!(p4, p3);
    // a volatile store refuses to stage anything
    assert_eq!(keys::stage_signing_key(&*FakeKeychain::degraded(), &Jail::off()).unwrap_err().code(), "secretStoreVolatile");
    // the push keys work the same way
    assert!(keys::vapid(&*store).unwrap().is_none());
    let (_, v1) = keys::ensure_vapid(&*store, &Jail::off()).unwrap();
    assert_eq!(keys::ensure_vapid(&*store, &Jail::off()).unwrap().1, v1);
    let v2 = keys::stage_vapid(&*store, &Jail::off()).unwrap();
    assert_ne!(v2, v1);
    assert_eq!(keys::vapid(&*store).unwrap().unwrap().1, v1);
    assert!(keys::vapid_for_deploy(&*store, &Jail::off()).unwrap().2);
    assert!(keys::commit_staged_vapid(&*store, &v2).unwrap());
    assert_eq!(keys::vapid(&*store).unwrap().unwrap().1, v2);
    let v3 = keys::stage_vapid(&*store, &Jail::off()).unwrap();
    assert!(keys::discard_staged_vapid(&*store).unwrap());
    assert_eq!(keys::vapid(&*store).unwrap().unwrap().1, v2);
    assert_ne!(v3, v2);
    assert_eq!(keys::read_seq(&*store).unwrap(), None);
    keys::write_seq(&*store, 42).unwrap();
    assert_eq!(keys::read_seq(&*store).unwrap(), Some(42));
}
