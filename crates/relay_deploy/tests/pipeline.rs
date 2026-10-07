//! The preview and deploy job against a scripted wrangler and a fake relay (spec 11.1 `pipeline`, 11.4b). No process, no network.

mod common;

use std::fs;

use common::*;
use intely_relay_deploy::pipeline::{overwrite_phrase, stamp_of, DeployRequest};
use intely_relay_deploy::{keys, JobEvent, Op, PlanRequest, Reply, ScriptedSpawner, Step, StepStatus};
use sha2::{Digest, Sha256};

fn steps(ev: &[JobEvent]) -> Vec<(Step, StepStatus, Option<String>)> {
    ev.iter()
        .filter_map(|e| if let JobEvent::Step(s) = e { Some((s.step.clone(), s.status, s.code.clone())) } else { None })
        .collect()
}

fn run_deploy(f: &Fixture, req: &DeployRequest) -> (Result<intely_relay_deploy::DeployRecord, intely_relay_deploy::DeployError>, Vec<JobEvent>) {
    let mut ev = Vec::new();
    let r = f.deployer.deploy(req, &mut |e| ev.push(e));
    (r, ev)
}

#[test]
fn happy_path_push_off() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    assert_eq!(p.name_check, intely_relay_deploy::output::NameCheck::Free);
    assert!(!p.needs_overwrite_phrase);
    assert_eq!(p.module_check, "verified");
    assert_eq!(p.bundle.hash_short.split(' ').count(), 4);
    assert!(p.config_text.contains("\"workers_dev\": true") && !p.config_text.contains("account_id"));
    assert!(p.resources.iter().any(|r| r.kind == "durableObject" && r.label.starts_with("Room") && !r.label.contains('(')));
    assert!(p.resources.iter().all(|r| r.kind != "secret"));
    let replay = f.request(&p);
    let (r, ev) = run_deploy(&f, &f.request(&p));
    let rec = r.expect("deploy");
    assert_eq!(rec.url, format!("wss://{HOST}"));
    assert_eq!(rec.http_base, format!("https://{HOST}"));
    assert!(!rec.push_deployed && rec.warnings.is_empty());
    assert_eq!(rec.bundle.hash, p.bundle.hash_full);
    assert_eq!(rec.check.verdict, "ok");
    assert_eq!(rec.stamp, stamp_of("install-123"));
    let s = steps(&ev);
    let ok: Vec<&Step> = s.iter().filter(|(_, st, _)| *st == StepStatus::Ok).map(|(x, _, _)| x).collect();
    assert_eq!(ok, vec![&Step::Stage, &Step::Config, &Step::Deploy, &Step::Parse, &Step::Health, &Step::Verify, &Step::Record]);
    assert!(s.contains(&(Step::Secrets, StepStatus::Skipped, None)));
    // Order of wrangler calls: dry run, name check, then the deploy; no secret put.
    let ops: Vec<Op> = f.spawner.calls().iter().map(|c| c.op).collect();
    assert_eq!(ops, vec![Op::DeployDryRun, Op::DeploymentsList, Op::Deploy]);
    let deploy = &f.spawner.calls_of(Op::Deploy)[0];
    assert!(deploy.argv.windows(2).any(|w| w[0] == "--message" && w[1] == format!("intely-relay:{}", stamp_of("install-123"))));
    assert!(deploy.env_plain.iter().any(|(k, v)| k == "CLOUDFLARE_ACCOUNT_ID" && v == ACCOUNT_ID));
    assert_eq!(deploy.cwd, f.worker_dir(), "never the repo kit");
    // The preview and the plan are single use.
    assert_eq!(f.deployer.deploy(&replay, &mut |_| {}).unwrap_err().code(), "previewStale");
    assert!(f.deployer.plan(&PlanRequest::Deploy { preview_id: p.preview_id.clone() }).is_err(), "no plan for a spent preview");
}

#[test]
fn push_on_sets_three_secrets_through_stdin_only() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(true);
    assert!(p.resources.iter().filter(|r| r.kind == "secret").count() == 3);
    let (r, _) = run_deploy(&f, &f.request(&p));
    let rec = r.expect("deploy");
    assert!(rec.push_deployed);
    let (private, public) = keys::vapid(&*f.store).unwrap().unwrap();
    assert_eq!(rec.vapid_public.as_deref(), Some(public.as_str()));
    let puts = f.spawner.calls_of(Op::SecretPut);
    assert_eq!(puts.len(), 3);
    let names: Vec<&str> = puts.iter().map(|c| c.argv[3].as_str()).collect();
    assert_eq!(names, vec!["VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"]);
    let h = |v: &str| hex::encode(Sha256::digest(format!("{v}\n").as_bytes()));
    assert_eq!(puts[0].stdin_sha256.as_deref(), Some(h(private.expose()).as_str()));
    assert_eq!(puts[1].stdin_sha256.as_deref(), Some(h(&public).as_str()));
    assert_eq!(puts[2].stdin_sha256.as_deref(), Some(h(&format!("https://{HOST}/")).as_str()));
    for c in &puts {
        assert!(!c.argv.iter().any(|a| a.contains(private.expose()) || a == &public));
    }
    // The public key is inside the signed bundle (push-config.json).
    let cfg = fs::read_to_string(f.worker_dir().join("dist/push-config.json")).unwrap();
    assert!(cfg.contains(&public));
}

#[test]
fn wrong_typed_name_is_refused_and_does_not_burn_the_preview() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    for bad in ["", "INTELY-RELAY-0123456789AB", "intely-relay-0123456789a", " intely-relay-0123456789ab"] {
        let r = DeployRequest { confirm_name: bad.to_owned(), ..f.request(&p) };
        assert_eq!(run_deploy(&f, &r).0.unwrap_err().code(), "confirmMismatch", "{bad:?}");
    }
    assert!(f.spawner.calls_of(Op::Deploy).is_empty(), "no deploy before the confirmation");
    assert!(run_deploy(&f, &f.request(&p)).0.is_ok());
}

fn foreign_spawner() -> ScriptedSpawner {
    // A listing without our stamp: somebody else's Worker of that name.
    let mut s = happy_spawner(WORKER);
    s = s.on_when(Op::DeploymentsList, |_| true, Reply::ok().lines(&["Created: 2026-09-01", "Message: hand deploy", "Version(s): (100%) 9999"]));
    s
}

#[test]
fn foreign_name_needs_the_overwrite_phrase() {
    let f = fixture(foreign_spawner());
    let p = f.preview(false);
    assert_eq!(p.name_check, intely_relay_deploy::output::NameCheck::Foreign);
    assert!(p.needs_overwrite_phrase);
    assert_eq!(run_deploy(&f, &f.request(&p)).0.unwrap_err().code(), "confirmMismatch");
    let wrong = DeployRequest { overwrite_phrase: Some("overwrite other".into()), ..f.request(&p) };
    assert_eq!(run_deploy(&f, &wrong).0.unwrap_err().code(), "confirmMismatch");
    let ok = DeployRequest { overwrite_phrase: Some(overwrite_phrase(WORKER)), ..f.request(&p) };
    assert!(run_deploy(&f, &ok).0.is_ok());
}

#[test]
fn unknown_name_check_is_treated_like_foreign() {
    let s = happy_spawner(WORKER).on_when(Op::DeploymentsList, |_| true, Reply::exit(1, &["something odd happened"]));
    let f = fixture(s);
    let p = f.preview(false);
    assert_eq!(p.name_check, intely_relay_deploy::output::NameCheck::Unknown);
    assert!(p.needs_overwrite_phrase);
}

#[test]
fn mine_only_with_the_install_stamp() {
    let stamp = stamp_of("install-123");
    let s = happy_spawner(WORKER).on_when(Op::DeploymentsList, |_| true, Reply::ok().lines(&["Created: 2026-10-01", &format!("Message: intely-relay:{stamp}")]));
    let f = fixture(s);
    let p = f.preview(false);
    assert_eq!(p.name_check, intely_relay_deploy::output::NameCheck::Mine);
    assert!(!p.needs_overwrite_phrase);
    // The stamp of ANOTHER install is a foreign Worker.
    let other = stamp_of("someone-else");
    let s = happy_spawner(WORKER).on_when(Op::DeploymentsList, |_| true, Reply::ok().lines(&[&format!("Message: intely-relay:{other}")]));
    assert_eq!(fixture(s).preview(false).name_check, intely_relay_deploy::output::NameCheck::Foreign);
}

#[test]
fn a_dirty_kit_needs_the_overwrite_phrase() {
    let f = fixture(happy_spawner(WORKER));
    // The kit directory becomes a git repo (temp fixture only) with everything committed, then one file changes.
    let git = |args: &[&str]| {
        let st = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(f.tmp.path().join("kit"))
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap();
        assert!(st.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&st.stderr));
    };
    fs::write(f.tmp.path().join("kit/.gitignore"), "node_modules\ndist\n").unwrap();
    git(&["init", "-q"]);
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "fixture"]);
    let clean = f.preview(false);
    assert_eq!(clean.kit_dirty, None);
    assert!(!clean.needs_overwrite_phrase);
    fs::write(f.tmp.path().join("kit/remote-relay/src/config.ts"), "export const PROTOCOL = \"edited\";\n").unwrap();
    let p = f.preview(false);
    assert_eq!(p.kit_dirty, Some(1));
    assert!(p.needs_overwrite_phrase);
    assert_eq!(run_deploy(&f, &f.request(&p)).0.unwrap_err().code(), "confirmMismatch");
    let ok = DeployRequest { overwrite_phrase: Some(overwrite_phrase(WORKER)), ..f.request(&p) };
    assert!(run_deploy(&f, &ok).0.is_ok());
}

#[test]
fn stale_previews_are_refused() {
    // expired
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    let req = f.request(&p);
    f.clock.advance(15 * 60 + 1);
    assert_eq!(run_deploy(&f, &req).0.unwrap_err().code(), "previewStale");
    // unknown id
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    let r = DeployRequest { preview_id: "0".repeat(32), ..f.request(&p) };
    assert_eq!(run_deploy(&f, &r).0.unwrap_err().code(), "previewStale");
}

#[test]
fn every_bound_component_is_reverified_before_the_spawn() {
    type Tamper = Box<dyn Fn(&Fixture)>;
    let cases: Vec<(&str, Tamper)> = vec![
        ("staged file", Box::new(|f: &Fixture| fs::write(f.worker_dir().join("dist/assets/app.js"), "evil();\n").unwrap())),
        ("extra staged file", Box::new(|f: &Fixture| fs::write(f.worker_dir().join("dist/extra.js"), "x\n").unwrap())),
        ("staged symlink", Box::new(|f: &Fixture| {
            fs::remove_file(f.worker_dir().join("dist/assets/app.js")).unwrap();
            std::os::unix::fs::symlink("/etc/hosts", f.worker_dir().join("dist/assets/app.js")).unwrap();
        })),
        ("snapshot source", Box::new(|f: &Fixture| fs::write(f.worker_dir().join("kit/src/index.ts"), "export default {};\n").unwrap())),
        ("snapshot package.json", Box::new(|f: &Fixture| fs::write(f.worker_dir().join("kit/package.json"), "{}").unwrap())),
        ("snapshot symlink", Box::new(|f: &Fixture| {
            fs::remove_file(f.worker_dir().join("kit/src/config.ts")).unwrap();
            std::os::unix::fs::symlink("/etc/hosts", f.worker_dir().join("kit/src/config.ts")).unwrap();
        })),
        ("generated config", Box::new(|f: &Fixture| {
            let p = f.worker_dir().join("wrangler.jsonc");
            let t = fs::read_to_string(&p).unwrap().replace("\"workers_dev\": true", "\"workers_dev\": false");
            fs::write(p, t).unwrap();
        })),
        ("wrangler entry", Box::new(|f: &Fixture| fs::write(f.kit.relay_dir.join("node_modules/wrangler/bin/wrangler.js"), "// replaced\n").unwrap())),
    ];
    for (what, tamper) in cases {
        let f = fixture(happy_spawner(WORKER));
        let p = f.preview(false);
        let req = f.request(&p);
        tamper(&f);
        assert_eq!(f.deployer.plan(&PlanRequest::Deploy { preview_id: p.preview_id.clone() }).unwrap_err().code(), "previewStale", "{what}: no plan for a changed review");
        let (r, _) = run_deploy(&f, &req);
        let code = r.unwrap_err().code();
        assert_eq!(code, "previewStale", "tampered {what} gave {code}");
        assert!(f.spawner.calls_of(Op::Deploy).is_empty(), "{what}: deploy must not spawn");
    }
}

#[test]
fn deploy_failure_stops_at_the_step_and_retry_continues() {
    // The first deploy call fails (expired login), the second works: `on` queues replies in order.
    let s = base_spawner(WORKER).on(Op::Deploy, Reply::exit(1, &["✘ [ERROR] Authentication error [code: 10000]"])).on(Op::Deploy, deploy_ok(WORKER));
    let f = fixture(s);
    let p = f.preview(false);
    let (r, ev) = run_deploy(&f, &f.request(&p));
    assert_eq!(r.unwrap_err().code(), "authInvalid");
    let st = steps(&ev);
    assert!(st.contains(&(Step::Deploy, StepStatus::Failed, Some("authInvalid".into()))));
    assert!(!st.iter().any(|(s, _, _)| *s == Step::Parse), "stops at the failing step");
    let job_id = ev.iter().find_map(|e| if let JobEvent::Step(s) = e { Some(s.run_id.clone()) } else { None }).unwrap();
    // Stage is not idempotent and cannot be retried alone; Deploy can.
    assert_eq!(f.deployer.retry(&job_id, Step::Stage, &mut |_| {}).unwrap_err().code(), "previewStale");
    assert_eq!(f.deployer.retry("nope", Step::Deploy, &mut |_| {}).unwrap_err().code(), "previewStale");
    let mut ev2 = Vec::new();
    let rec = f.deployer.retry(&job_id, Step::Deploy, &mut |e| ev2.push(e)).expect("retry");
    assert_eq!(rec.url, format!("wss://{HOST}"));
    assert_eq!(f.spawner.calls_of(Op::Deploy).len(), 2);
    assert!(!steps(&ev2).iter().any(|(s, _, _)| *s == Step::Stage), "earlier steps are not repeated");
}

#[test]
fn retry_from_health_does_not_deploy_again() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    *f.relay.status_failures.lock().unwrap() = 10_000;
    let (r, ev) = run_deploy(&f, &f.request(&p));
    assert_eq!(r.unwrap_err().code(), "healthTimeout");
    let job_id = ev.iter().find_map(|e| if let JobEvent::Step(s) = e { Some(s.run_id.clone()) } else { None }).unwrap();
    *f.relay.status_failures.lock().unwrap() = 0;
    let rec = f.deployer.retry(&job_id, Step::Health, &mut |_| {}).expect("retry from Health");
    assert_eq!(rec.check.verdict, "ok");
    assert_eq!(f.spawner.calls_of(Op::Deploy).len(), 1, "the deploy ran exactly once");
}

#[test]
fn parse_rejects_hosts_names_and_failure_lines() {
    let cases: Vec<(&str, String)> = vec![
        ("evil host", deploy_ndjson(WORKER, "https://evil.example")),
        ("http", deploy_ndjson(WORKER, &format!("http://{HOST}"))),
        ("userinfo", deploy_ndjson(WORKER, &format!("https://u:p@{HOST}"))),
        ("other worker name", deploy_ndjson("someone-else", &format!("https://someone-else.my-sub.workers.dev"))),
        ("path", deploy_ndjson(WORKER, &format!("https://{HOST}/x"))),
        ("command failed", "{\"type\":\"command-failed\",\"code\":10000,\"message\":\"Authentication error\"}\n".to_owned()),
        ("empty", String::new()),
    ];
    for (what, ndjson) in cases {
        let s = happy_spawner(WORKER).on_when(Op::Deploy, |_| true, Reply::ok().output_file(&ndjson));
        let f = fixture(s);
        let p = f.preview(false);
        let (r, ev) = run_deploy(&f, &f.request(&p));
        assert_eq!(r.unwrap_err().code(), "deployFailed", "{what}");
        assert!(steps(&ev).contains(&(Step::Parse, StepStatus::Failed, Some("deployFailed".into()))), "{what}");
        assert!(!steps(&ev).iter().any(|(s, _, _)| *s == Step::Health), "{what}: nothing after a rejected target");
    }
}

#[test]
fn secret_failure_is_a_warning_not_a_failure() {
    let s = happy_spawner(WORKER).on_when(Op::SecretPut, |_| true, Reply::exit(1, &["✘ [ERROR] A request to the Cloudflare API failed. [code: 10007]"]));
    let f = fixture(s);
    let p = f.preview(true);
    let (r, ev) = run_deploy(&f, &f.request(&p));
    let rec = r.expect("the Worker is live without push");
    assert!(!rec.push_deployed);
    assert_eq!(rec.warnings, vec!["secretFailed".to_owned()]);
    assert!(steps(&ev).contains(&(Step::Secrets, StepStatus::Failed, Some("secretFailed".into()))));
    assert!(steps(&ev).contains(&(Step::Record, StepStatus::Ok, None)));
    assert_eq!(f.spawner.calls_of(Op::SecretPut).len(), 1, "stops after the first failing secret");
}

#[test]
fn health_retries_through_523_without_real_sleeping() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    *f.relay.status_failures.lock().unwrap() = 5;
    let started = std::time::Instant::now();
    let (r, _) = run_deploy(&f, &f.request(&p));
    assert!(r.is_ok());
    assert_eq!(f.clock.sleeps.lock().unwrap().len(), 5);
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "the injected clock never sleeps for real");
    assert!(f.clock.sleeps.lock().unwrap().iter().all(|d| d.as_secs() == 5));
}

#[test]
fn health_gives_up_after_ninety_seconds() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    *f.relay.status_failures.lock().unwrap() = 10_000;
    let (r, ev) = run_deploy(&f, &f.request(&p));
    assert_eq!(r.unwrap_err().code(), "healthTimeout");
    let slept: u64 = f.clock.sleeps.lock().unwrap().iter().map(|d| d.as_secs()).sum();
    assert!((85..=100).contains(&slept), "slept {slept}");
    assert!(steps(&ev).contains(&(Step::Health, StepStatus::Failed, Some("healthTimeout".into()))));
    assert!(!steps(&ev).iter().any(|(s, _, _)| *s == Step::Verify));
}

#[test]
fn a_served_bundle_that_differs_blocks_the_record() {
    for (what, expect) in [("index.html", "bundleMismatch"), ("sw.js", "bundleMismatch"), ("bundle.json", "badSignature")] {
        let f = fixture(happy_spawner(WORKER));
        let p = f.preview(false);
        if what == "bundle.json" {
            // one byte of the signature changed
            let text = fs::read_to_string(f.worker_dir().join("dist/bundle.json")).unwrap();
            let i = text.find("\"sig\":\"").unwrap() + 7;
            let mut b = text.into_bytes();
            b[i] = if b[i] == b'A' { b'B' } else { b'A' };
            f.relay.override_file(what, &b);
        } else {
            f.relay.override_file(what, b"tampered\n");
        }
        let (r, ev) = run_deploy(&f, &f.request(&p));
        assert_eq!(r.unwrap_err().code(), expect, "{what}");
        assert!(steps(&ev).contains(&(Step::Verify, StepStatus::Failed, Some(expect.into()))), "{what}");
        assert!(!steps(&ev).iter().any(|(s, st, _)| *s == Step::Record && *st == StepStatus::Ok), "{what}");
    }
}

#[test]
fn stop_mid_run_cancels_the_deploy() {
    let s = happy_spawner(WORKER).on_when(Op::Deploy, |_| true, Reply::ok().blocking());
    let f = std::sync::Arc::new(fixture(s));
    let p = f.preview(false);
    let f2 = f.clone();
    let req = f.request(&p);
    let t = std::thread::spawn(move || {
        let mut ev = Vec::new();
        let r = f2.deployer.deploy(&req, &mut |e| ev.push(e));
        (r, ev)
    });
    let run_id = loop {
        if let Some((id, op)) = f.deployer.runner().busy() {
            if op == "deploy" && !f.spawner.calls_of(Op::Deploy).is_empty() {
                break id;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    // busy while the deploy runs
    assert_eq!(f.deployer.login(false, &mut |_| {}).unwrap_err().code(), "busy");
    f.deployer.stop(&run_id);
    let (r, ev) = t.join().unwrap();
    assert_eq!(r.unwrap_err().code(), "cancelled");
    assert!(steps(&ev).contains(&(Step::Deploy, StepStatus::Failed, Some("cancelled".into()))));
    assert!(f.deployer.runner().busy().is_none());
}

#[test]
fn dry_run_failures_are_classified() {
    let cases = [
        ("You need to register a workers.dev subdomain before publishing [code: 10063]", "noSubdomain"),
        ("You do not have permission to perform this action", "permission"),
        ("Authentication error [code: 10000]", "authInvalid"),
        ("You are not authenticated. Please run `wrangler login`.", "notLoggedIn"),
        ("getaddrinfo ENOTFOUND api.cloudflare.com", "network"),
        ("something unclassified", "deployFailed"),
    ];
    for (line, code) in cases {
        let f = fixture(happy_spawner(WORKER).on_when(Op::DeployDryRun, |_| true, Reply::exit(1, &[line])));
        let e = f.deployer.preview(&f.preview_req(false), &mut |_| {}).unwrap_err();
        assert_eq!(e.code(), code, "{line}");
    }
}

#[test]
fn a_bundled_module_outside_the_snapshot_aborts() {
    let w = WORKER.to_owned();
    let s = happy_spawner(WORKER).on_when(
        Op::DeployDryRun,
        |_| true,
        Reply::ok().hook(move |inv| {
            let i = inv.argv.iter().position(|a| a == "--outdir").unwrap();
            let out = std::path::PathBuf::from(&inv.argv[i + 1]);
            fs::create_dir_all(&out).unwrap();
            fs::write(out.join("index.js.map"), format!("{{\"sources\":[\"../{w}/kit/src/index.ts\",\"../../../etc/passwd\"]}}")).unwrap();
        }),
    );
    let f = fixture(s);
    let e = f.deployer.preview(&f.preview_req(false), &mut |_| {}).unwrap_err();
    assert_eq!(e.code(), "deployFailed");
    assert!(e.to_string().contains("outside the snapshot"));
}

#[test]
fn a_missing_source_map_is_reported_as_unverified() {
    let s = happy_spawner(WORKER).on_when(Op::DeployDryRun, |_| true, Reply::ok());
    let f = fixture(s);
    assert_eq!(f.preview(false).module_check, "unverified");
}

#[test]
fn volatile_secret_store_refuses_before_anything_is_generated() {
    let store = FakeKeychain::degraded();
    let f = fixture_with(happy_spawner(WORKER), FixtureOpts { store: store.clone(), ..FixtureOpts::default() });
    let e = f.deployer.preview(&f.preview_req(true), &mut |_| {}).unwrap_err();
    assert_eq!(e.code(), "secretStoreVolatile");
    assert!(f.spawner.calls().is_empty());
    use intely_settings::secrets::SecretStore;
    assert!(!store.has(keys::KEY_SIGNING).unwrap() && !store.has(keys::KEY_VAPID_PRIVATE).unwrap(), "no key was created");
    assert!(!f.worker_dir().exists(), "nothing was staged");
}

#[test]
fn seq_is_monotonic_and_the_clock_is_checked() {
    let f = fixture(happy_spawner(WORKER));
    let p1 = f.preview(false);
    assert_eq!(p1.bundle.seq, NOW);
    assert_eq!(keys::read_seq(&*f.store).unwrap(), Some(NOW));
    let p2 = f.preview(false);
    assert_eq!(p2.bundle.seq, NOW + 1, "prev + 1 even though the clock stands still");
    f.clock.advance(100);
    assert_eq!(f.preview(false).bundle.seq, NOW + 2);
    // A stored seq more than 24 h ahead of the clock is refused, unless the typed override is given.
    keys::write_seq(&*f.store, NOW + 3 * 86_400).unwrap();
    let e = f.deployer.preview(&f.preview_req(false), &mut |_| {}).unwrap_err();
    assert_eq!(e.code(), "seqClock");
    let mut req = f.preview_req(false);
    req.allow_seq_clock_skew = true;
    assert!(f.deployer.preview(&req, &mut |_| {}).is_ok());
}

#[test]
fn the_signing_key_is_stable_across_previews() {
    let f = fixture(happy_spawner(WORKER));
    let a = f.preview(false).bundle.pub_fingerprint;
    let b = f.preview(false).bundle.pub_fingerprint;
    assert_eq!(a, b);
}

fn assert_no_secret(f: &Fixture, secret: &str) {
    for c in f.spawner.calls() {
        assert!(!c.argv.iter().any(|a| a.contains(secret)), "secret in argv of {:?}", c.op);
        assert!(!c.env_plain.iter().any(|(_, v)| v.contains(secret)), "secret in a plain env value of {:?}", c.op);
    }
    let walk = |root: &std::path::Path| {
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Ok(t) = fs::read(&p) {
                    assert!(!String::from_utf8_lossy(&t).contains(secret), "secret in {}", p.display());
                }
            }
        }
    };
    walk(f.deployer.root());
}

#[test]
fn no_secret_reaches_argv_files_logs_or_events() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(true);
    let (private, _) = keys::vapid(&*f.store).unwrap().unwrap();
    let (r, ev) = run_deploy(&f, &f.request(&p));
    assert!(r.is_ok());
    assert_no_secret(&f, private.expose());
    use intely_settings::secrets::SecretStore;
    let signing = f.store.get(keys::KEY_SIGNING).unwrap().unwrap();
    assert_no_secret(&f, signing.expose());
    let logged: String = ev.iter().filter_map(|e| if let JobEvent::Log(l) = e { Some(l.clone()) } else { None }).collect::<Vec<_>>().join("\n");
    assert!(!logged.contains(private.expose()) && !logged.contains(signing.expose()));
    // The command echo shows the stdin placeholder, not the value.
    assert!(logged.contains("<secret via stdin>"));
}

#[test]
fn output_is_masked_in_events_the_ring_and_the_ops_log() {
    let token = "cfut_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";
    let s = happy_spawner(WORKER).on_when(
        Op::Deploy,
        |_| true,
        Reply::ok().lines(&[&format!("using token {token}"), "logged in as ada@example.test"]).output_file(&deploy_ndjson(WORKER, &format!("https://{HOST}"))),
    );
    let f = fixture(s);
    let p = f.preview(false);
    let (r, ev) = run_deploy(&f, &f.request(&p));
    assert!(r.is_ok());
    let logged: String = ev.iter().filter_map(|e| if let JobEvent::Log(l) = e { Some(l.clone()) } else { None }).collect::<Vec<_>>().join("\n");
    assert!(!logged.contains("cfut_") && !logged.contains("ada@") && logged.contains("a***@e***.test"), "{logged}");
    let ops = fs::read_to_string(f.deployer.root().join("ops.jsonl")).unwrap();
    assert!(!ops.contains("cfut_") && !ops.contains("ada@") && !ops.contains("--config"), "{ops}");
}

#[test]
fn token_mode_passes_the_token_in_the_environment_only() {
    use intely_settings::secrets::{Secret, SecretStore};
    let f = fixture_with(
        happy_spawner(WORKER),
        FixtureOpts { env: vec![("CLOUDFLARE_API_TOKEN", "inherited-token".into()), ("NODE_OPTIONS", "--require /evil.js".into()), ("INTELY_X", "1".into()), ("GIT_DIR", "/x".into()), ("NPM_CONFIG_REGISTRY", "http://evil".into())], ..FixtureOpts::default() },
    );
    f.store.set(keys::KEY_API_TOKEN, Secret::new("cfut_TOKENTOKENTOKENTOKENTOKENTOKENTOKEN12345")).unwrap();
    let mut req = f.preview_req(false);
    req.auth_mode = intely_relay_deploy::AuthMode::Token;
    let p = f.deployer.preview(&req, &mut |_| {}).unwrap();
    f.relay.serve(&f.worker_dir().join("dist"));
    for c in f.spawner.calls() {
        let names = &c.env_names;
        assert!(names.contains(&"CLOUDFLARE_API_TOKEN".to_owned()), "token mode sets it");
        assert!(!c.env_plain.iter().any(|(k, _)| k == "CLOUDFLARE_API_TOKEN"), "and never as a plain value");
        for banned in ["NODE_OPTIONS", "INTELY_X", "GIT_DIR", "NPM_CONFIG_REGISTRY"] {
            assert!(!names.contains(&banned.to_owned()), "{banned} leaked");
        }
        assert!(names.contains(&"CLOUDFLARE_ACCOUNT_ID".to_owned()));
        assert!(names.contains(&"WRANGLER_SEND_METRICS".to_owned()) && names.contains(&"NO_COLOR".to_owned()));
    }
    assert!(p.env_names.contains(&"CLOUDFLARE_API_TOKEN".to_owned()));
    assert_no_secret(&f, "TOKENTOKENTOKENTOKENTOKENTOKENTOKEN12345");
    // OAuth mode: no token variable at all, even though the launching environment has one.
    let f = fixture_with(happy_spawner(WORKER), FixtureOpts { env: vec![("CLOUDFLARE_API_TOKEN", "inherited-token".into())], ..FixtureOpts::default() });
    f.deployer.preview(&f.preview_req(false), &mut |_| {}).unwrap();
    assert!(f.spawner.calls().iter().all(|c| !c.env_names.contains(&"CLOUDFLARE_API_TOKEN".to_owned())));
}

#[test]
fn building_the_deployer_and_reading_the_status_touch_nothing() {
    let f = fixture(happy_spawner(WORKER));
    let r = f.deployer.kit_report();
    assert!(r.found && r.wrangler_ok && r.dist_built);
    assert_eq!(r.wrangler_version.as_deref(), Some("4.147.0"));
    assert!(f.spawner.calls().is_empty(), "no spawn");
    assert!(!f.deployer.root().exists(), "no directory was created");
    assert!(f.relay.requests.lock().unwrap().is_empty(), "no request");
}
