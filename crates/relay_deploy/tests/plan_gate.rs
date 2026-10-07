//! The server-side deploy gate (plan nonce), the unverified-module acknowledgement and the staged key rotation, against a scripted
//! wrangler and a fake relay. No process, no network, no real Cloudflare account.

mod common;

use common::*;
use intely_core::jail::Jail;
use intely_relay_deploy::pipeline::DeployRequest;
use intely_relay_deploy::plan::PLAN_TTL_SECS;
use intely_relay_deploy::{keys, AuthCtx, AuthMode, JobEvent, Op, PlanRequest, Reply};

fn oauth() -> AuthCtx {
    AuthCtx { mode: AuthMode::Oauth, account_id: Some(ACCOUNT_ID.to_owned()) }
}

fn plan_of(f: &Fixture, p: &intely_relay_deploy::DeployPreview) -> intely_relay_deploy::Plan {
    f.deployer.plan(&PlanRequest::Deploy { preview_id: p.preview_id.clone() }).expect("plan")
}

fn req(p: &intely_relay_deploy::DeployPreview, plan_id: &str) -> DeployRequest {
    DeployRequest { preview_id: p.preview_id.clone(), confirm_name: p.worker_name.clone(), overwrite_phrase: None, plan_id: plan_id.to_owned(), acknowledge_unverified: false }
}

fn deploy(f: &Fixture, r: &DeployRequest) -> Result<intely_relay_deploy::DeployRecord, intely_relay_deploy::DeployError> {
    f.deployer.deploy(r, &mut |_| {})
}

// ---------------------------------------------------------------- the plan nonce

#[test]
fn a_deploy_plan_shows_the_exact_command_directory_and_worker() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    let plan = plan_of(&f, &p);
    assert_eq!(plan.worker_name, WORKER);
    assert_eq!(plan.argv, p.argv, "the plan holds the argv the review showed");
    assert_eq!(plan.command_line, p.command_line);
    assert_eq!(plan.cwd, f.worker_dir().to_string_lossy());
    assert_eq!(plan.plan_id.len(), 32);
    assert_eq!(plan.expires_at, NOW + PLAN_TTL_SECS);
    assert!(plan.argv.windows(2).any(|w| w[0] == "--name" && w[1] == WORKER));
    assert_ne!(plan_of(&f, &p).plan_id, plan.plan_id, "every plan has its own nonce");
    // what actually runs is that argv (the output file path is the one varying part)
    assert!(deploy(&f, &req(&p, &plan.plan_id)).is_ok());
    let ran = &f.spawner.calls_of(Op::Deploy)[0];
    assert_eq!(ran.argv.len(), plan.argv.len());
    let differing: Vec<_> = ran.argv.iter().zip(&plan.argv).filter(|(a, b)| a != b).collect();
    assert!(differing.len() <= 1 && differing.iter().all(|(a, _)| a.contains("out-")), "{differing:?}");
    assert_eq!(ran.cwd, f.worker_dir());
}

#[test]
fn a_deploy_without_a_valid_plan_spawns_nothing() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    for nonce in ["", "0", &"0".repeat(32), "../../etc/passwd"] {
        assert_eq!(deploy(&f, &req(&p, nonce)).unwrap_err().code(), "previewStale", "{nonce:?}");
    }
    assert!(f.spawner.calls_of(Op::Deploy).is_empty(), "no deploy without a plan");
    // the preview itself is not burned by those: the right plan still works
    let plan = plan_of(&f, &p);
    assert!(deploy(&f, &req(&p, &plan.plan_id)).is_ok());
}

#[test]
fn a_replayed_plan_is_refused() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    let plan = plan_of(&f, &p);
    let r = req(&p, &plan.plan_id);
    assert!(deploy(&f, &r).is_ok());
    assert_eq!(deploy(&f, &r).unwrap_err().code(), "previewStale");
    assert_eq!(f.spawner.calls_of(Op::Deploy).len(), 1);
    // the plan of a new preview of the same Worker is a different one: the spent nonce does not fit it
    let p2 = f.preview(false);
    assert_eq!(deploy(&f, &req(&p2, &plan.plan_id)).unwrap_err().code(), "previewStale");
    assert_eq!(f.spawner.calls_of(Op::Deploy).len(), 1);
}

#[test]
fn an_expired_plan_is_refused_and_a_new_one_works() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    let plan = plan_of(&f, &p);
    f.clock.advance(PLAN_TTL_SECS);
    assert_eq!(deploy(&f, &req(&p, &plan.plan_id)).unwrap_err().code(), "previewStale");
    assert!(f.spawner.calls_of(Op::Deploy).is_empty());
    let fresh = plan_of(&f, &p);
    assert!(deploy(&f, &req(&p, &fresh.plan_id)).is_ok());
}

#[test]
fn the_wrong_worker_name_is_refused_and_three_of_them_spend_the_plan() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    let plan = plan_of(&f, &p);
    for bad in ["", "other", "INTELY-RELAY-0123456789AB"] {
        let r = DeployRequest { confirm_name: bad.to_owned(), ..req(&p, &plan.plan_id) };
        assert_eq!(deploy(&f, &r).unwrap_err().code(), "confirmMismatch", "{bad:?}");
    }
    assert_eq!(deploy(&f, &req(&p, &plan.plan_id)).unwrap_err().code(), "previewStale", "spent by the third wrong name");
    assert!(f.spawner.calls_of(Op::Deploy).is_empty());
    // the preview survives: a new plan and the right name deploy
    let again = plan_of(&f, &p);
    assert!(deploy(&f, &req(&p, &again.plan_id)).is_ok());
}

#[test]
fn a_plan_of_another_preview_cannot_deploy() {
    let f = fixture(happy_spawner(WORKER));
    let first = f.preview(false);
    let stale_plan = plan_of(&f, &first);
    let second = f.preview(false);
    assert_ne!(first.preview_id, second.preview_id);
    assert_eq!(deploy(&f, &req(&second, &stale_plan.plan_id)).unwrap_err().code(), "previewStale");
    assert!(f.spawner.calls_of(Op::Deploy).is_empty());
}

#[test]
fn no_plan_exists_for_an_unknown_or_expired_preview() {
    let f = fixture(happy_spawner(WORKER));
    assert_eq!(f.deployer.plan(&PlanRequest::Deploy { preview_id: "0".repeat(32) }).unwrap_err().code(), "previewStale");
    let p = f.preview(false);
    f.clock.advance(15 * 60 + 1);
    assert_eq!(f.deployer.plan(&PlanRequest::Deploy { preview_id: p.preview_id.clone() }).unwrap_err().code(), "previewStale");
}

// ---------------------------------------------------------------- the module check fails closed

fn unverified_spawner() -> intely_relay_deploy::ScriptedSpawner {
    // the dry run succeeds but leaves no source map to read
    happy_spawner(WORKER).on_when(Op::DeployDryRun, |_| true, Reply::ok())
}

#[test]
fn an_unverified_module_list_blocks_the_deploy_until_it_is_acknowledged() {
    let f = fixture(unverified_spawner());
    let p = f.preview(false);
    assert_eq!(p.module_check, "unverified");
    assert!(p.needs_unverified_ack);
    let plan = plan_of(&f, &p);
    let e = deploy(&f, &req(&p, &plan.plan_id)).unwrap_err();
    assert_eq!(e.code(), "moduleUnverified");
    assert!(f.spawner.calls_of(Op::Deploy).is_empty(), "refused before any deploy");
    // the refusal costs neither the preview nor the plan
    let r = DeployRequest { acknowledge_unverified: true, ..req(&p, &plan.plan_id) };
    assert!(deploy(&f, &r).is_ok());
    assert_eq!(f.spawner.calls_of(Op::Deploy).len(), 1);
}

#[test]
fn a_verified_module_list_needs_no_acknowledgement() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    assert_eq!(p.module_check, "verified");
    assert!(!p.needs_unverified_ack);
    let plan = plan_of(&f, &p);
    assert!(deploy(&f, &req(&p, &plan.plan_id)).is_ok());
}

// ---------------------------------------------------------------- the review is data, not English sentences

#[test]
fn resources_are_kinds_and_bare_values_never_english_prose() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(true);
    let kinds: Vec<&str> = p.resources.iter().map(|r| r.kind).collect();
    for k in ["worker", "durableObject", "assets", "routeWorkersDev", "secret"] {
        assert!(kinds.contains(&k), "{k} in {kinds:?}");
    }
    for r in &p.resources {
        assert!(!r.label.contains(' ') && !r.label.contains('(') && r.detail.as_deref().is_none_or(|d| !d.contains(' ')), "{r:?}");
    }
    let json = serde_json::to_value(&p.resources).unwrap();
    assert!(json.to_string().contains("\"detail\""), "the Durable Object migration tag travels as data");
}

// ---------------------------------------------------------------- key rotation: staged, committed after the verified redeploy

fn ready_for_rotation(spawner: intely_relay_deploy::ScriptedSpawner) -> (Fixture, String) {
    let f = fixture(spawner);
    // an earlier deploy created the active key
    let (_, active, _) = keys::signing_key(&*f.store, &Jail::off()).unwrap();
    (f, active)
}

#[test]
fn a_rotated_key_becomes_active_only_after_the_verified_redeploy() {
    let (f, old) = ready_for_rotation(happy_spawner(WORKER));
    let staged = keys::stage_signing_key(&*f.store, &Jail::off()).unwrap();
    assert_ne!(staged, old);
    let p = f.preview(false);
    assert!(p.signing_key_staged);
    assert_eq!(p.bundle.pub_fingerprint, intely_relay_bundle::fingerprint(&staged), "the bundle is signed with the staged key");
    assert_eq!(keys::signing_key(&*f.store, &Jail::off()).unwrap().1, old, "still the old key while the review is open");
    let plan = plan_of(&f, &p);
    let rec = deploy(&f, &req(&p, &plan.plan_id)).expect("deploy");
    assert!(rec.key_rotated);
    assert_eq!(rec.bundle.pubkey, staged);
    assert_eq!(keys::signing_key(&*f.store, &Jail::off()).unwrap().1, staged, "switched after Verify");
    assert!(keys::staged_signing_key(&*f.store).unwrap().is_none());
    // the next deploy signs with the new key and rotates nothing
    let p2 = f.preview(false);
    assert!(!p2.signing_key_staged);
    assert_eq!(p2.bundle.pub_fingerprint, intely_relay_bundle::fingerprint(&staged));
}

#[test]
fn a_failed_redeploy_leaves_the_old_key_active_and_the_rotation_pending() {
    let (f, old) = ready_for_rotation(happy_spawner(WORKER));
    let staged = keys::stage_signing_key(&*f.store, &Jail::off()).unwrap();
    let p = f.preview(false);
    *f.relay.status_failures.lock().unwrap() = 10_000; // the relay never answers: Health fails after the deploy ran
    let plan = plan_of(&f, &p);
    let mut ev = Vec::new();
    let e = f.deployer.deploy(&req(&p, &plan.plan_id), &mut |x| ev.push(x)).unwrap_err();
    assert_eq!(e.code(), "healthTimeout");
    assert_eq!(keys::signing_key(&*f.store, &Jail::off()).unwrap().1, old, "the active key never switched");
    assert_eq!(keys::staged_signing_key(&*f.store).unwrap().unwrap().1, staged, "the staged key is kept for the next try");
    // retrying the failed step with a healthy relay finishes the job and only then switches
    *f.relay.status_failures.lock().unwrap() = 0;
    let job_id = ev.iter().find_map(|e| if let JobEvent::Step(s) = e { Some(s.run_id.clone()) } else { None }).unwrap();
    let rec = f.deployer.retry(&job_id, intely_relay_deploy::Step::Health, &mut |_| {}).expect("retry");
    assert!(rec.key_rotated);
    assert_eq!(keys::signing_key(&*f.store, &Jail::off()).unwrap().1, staged);
}

fn job_id_of(ev: &[JobEvent]) -> String {
    ev.iter().find_map(|e| if let JobEvent::Step(s) = e { Some(s.run_id.clone()) } else { None }).expect("a step event")
}

#[test]
fn a_cancelled_rotation_before_the_relay_saw_the_key_goes_back_to_the_old_key() {
    let (f, old) = ready_for_rotation(happy_spawner(WORKER));
    keys::stage_signing_key(&*f.store, &Jail::off()).unwrap();
    let p = f.preview(false);
    // only a review exists: nothing reached the relay
    assert!(keys::discard_staged_signing_key(&*f.store).unwrap());
    assert_eq!(keys::signing_key(&*f.store, &Jail::off()).unwrap().1, old);
    drop(p);
    let p2 = f.preview(false);
    assert!(!p2.signing_key_staged, "after the rollback the next deploy signs with the old key again");
    assert_eq!(p2.bundle.pub_fingerprint, intely_relay_bundle::fingerprint(&old));
}

#[test]
fn a_deploy_that_failed_before_cloudflare_took_it_leaves_the_rotation_cancellable() {
    let s = base_spawner(WORKER).on(Op::Deploy, intely_relay_deploy::Reply::exit(1, &["✘ [ERROR] Authentication error [code: 10000]"]));
    let (f, old) = ready_for_rotation(s);
    keys::stage_signing_key(&*f.store, &Jail::off()).unwrap();
    let p = f.preview(false);
    let plan = plan_of(&f, &p);
    assert_eq!(deploy(&f, &req(&p, &plan.plan_id)).unwrap_err().code(), "authInvalid");
    assert!(keys::discard_staged_signing_key(&*f.store).unwrap(), "the relay never saw the staged key");
    assert_eq!(keys::signing_key(&*f.store, &Jail::off()).unwrap().1, old);
}

#[test]
fn a_rotation_cannot_be_cancelled_or_replaced_once_the_relay_serves_the_staged_key() {
    let (f, old) = ready_for_rotation(happy_spawner(WORKER));
    let staged = keys::stage_signing_key(&*f.store, &Jail::off()).unwrap();
    let p = f.preview(false);
    // the deploy step runs and the relay now serves a bundle signed with the staged key, but Health never sees it answer
    *f.relay.status_failures.lock().unwrap() = 10_000;
    let plan = plan_of(&f, &p);
    let mut ev = Vec::new();
    assert_eq!(f.deployer.deploy(&req(&p, &plan.plan_id), &mut |x| ev.push(x)).unwrap_err().code(), "healthTimeout");
    assert_eq!(f.spawner.calls_of(Op::Deploy).len(), 1);
    // rolling back would delete the only copy of the key the relay serves: refused, nothing changes
    assert_eq!(keys::discard_staged_signing_key(&*f.store).unwrap_err().code(), "rotationShipped");
    assert_eq!(keys::stage_signing_key(&*f.store, &Jail::off()).unwrap_err().code(), "rotationShipped", "and so is a second, different staged key");
    assert_eq!(keys::staged_signing_key(&*f.store).unwrap().unwrap().1, staged);
    assert_eq!(keys::signing_key(&*f.store, &Jail::off()).unwrap().1, old);
    // finishing the job commits the key and re-opens both operations
    *f.relay.status_failures.lock().unwrap() = 0;
    let rec = f.deployer.retry(&job_id_of(&ev), intely_relay_deploy::Step::Health, &mut |_| {}).expect("retry");
    assert!(rec.key_rotated);
    assert_eq!(keys::signing_key(&*f.store, &Jail::off()).unwrap().1, staged);
    keys::stage_signing_key(&*f.store, &Jail::off()).expect("a new rotation can start");
    assert!(keys::discard_staged_signing_key(&*f.store).unwrap());
}

#[test]
fn restaging_while_a_failed_job_waits_cannot_ship_a_key_that_is_then_lost() {
    let s = base_spawner(WORKER).on(Op::Deploy, intely_relay_deploy::Reply::exit(1, &["✘ [ERROR] Authentication error [code: 10000]"])).on(Op::Deploy, deploy_ok(WORKER));
    let (f, old) = ready_for_rotation(s);
    let first = keys::stage_signing_key(&*f.store, &Jail::off()).unwrap();
    let p = f.preview(false);
    let plan = plan_of(&f, &p);
    let mut ev = Vec::new();
    assert_eq!(f.deployer.deploy(&req(&p, &plan.plan_id), &mut |x| ev.push(x)).unwrap_err().code(), "authInvalid");
    // the user rolls the (unshipped) rotation back and starts another one while the failed job still waits
    assert!(keys::discard_staged_signing_key(&*f.store).unwrap());
    let second = keys::stage_signing_key(&*f.store, &Jail::off()).unwrap();
    assert_ne!(first, second);
    // retrying would ship the FIRST key's bundle and then fail to commit it: refused before anything spawns
    let e = f.deployer.retry(&job_id_of(&ev), intely_relay_deploy::Step::Deploy, &mut |_| {}).unwrap_err();
    assert_eq!(e.code(), "previewStale");
    assert_eq!(f.spawner.calls_of(Op::Deploy).len(), 1, "no second deploy");
    assert_eq!(keys::staged_signing_key(&*f.store).unwrap().unwrap().1, second);
    assert_eq!(keys::signing_key(&*f.store, &Jail::off()).unwrap().1, old);
}

#[test]
fn a_finished_job_cannot_be_retried_so_a_spent_plan_cannot_deploy_again() {
    let f = fixture(happy_spawner(WORKER));
    let p = f.preview(false);
    let plan = plan_of(&f, &p);
    let mut ev = Vec::new();
    f.deployer.deploy(&req(&p, &plan.plan_id), &mut |x| ev.push(x)).expect("deploy");
    let job_id = job_id_of(&ev);
    assert_eq!(f.spawner.calls_of(Op::Deploy).len(), 1);
    for from in [intely_relay_deploy::Step::Deploy, intely_relay_deploy::Step::Secrets, intely_relay_deploy::Step::Health, intely_relay_deploy::Step::Verify] {
        let e = f.deployer.retry(&job_id, from.clone(), &mut |_| {}).unwrap_err();
        assert_eq!(e.code(), "previewStale", "{from:?}");
    }
    assert_eq!(f.spawner.calls_of(Op::Deploy).len(), 1, "no second wrangler deploy from one plan");
    assert!(f.deployer.job_subject(&job_id).is_none());
    // a failed job IS retryable, and only until it finishes
    let s = base_spawner(WORKER).on(Op::Deploy, intely_relay_deploy::Reply::exit(1, &["✘ [ERROR] Authentication error [code: 10000]"])).on(Op::Deploy, deploy_ok(WORKER));
    let g = fixture(s);
    let p = g.preview(false);
    let plan = plan_of(&g, &p);
    let mut ev = Vec::new();
    assert!(g.deployer.deploy(&req(&p, &plan.plan_id), &mut |x| ev.push(x)).is_err());
    let job = job_id_of(&ev);
    assert_eq!(g.deployer.job_subject(&job), Some((WORKER.to_owned(), "cdef".to_owned())));
    g.deployer.retry(&job, intely_relay_deploy::Step::Deploy, &mut |_| {}).expect("a failed job retries");
    assert_eq!(g.deployer.retry(&job, intely_relay_deploy::Step::Deploy, &mut |_| {}).unwrap_err().code(), "previewStale", "and then it is finished");
    assert_eq!(g.spawner.calls_of(Op::Deploy).len(), 2);
}

#[test]
fn a_rotated_push_key_switches_only_with_a_verified_redeploy_that_carries_it() {
    let f = fixture(happy_spawner(WORKER));
    let (_, old) = keys::ensure_vapid(&*f.store, &Jail::off()).unwrap();
    let staged = keys::stage_vapid(&*f.store, &Jail::off()).unwrap();
    // the standalone secret push would ship the new private key without the bundle that tells phones its public half
    let p0 = f.preview(false);
    assert_eq!(f.deployer.put_vapid_secrets(WORKER, HOST, &oauth(), &mut |_| {}).unwrap_err().code(), "rotationPending");
    assert!(f.spawner.calls_of(Op::SecretPut).is_empty());
    // a deploy without push does not touch it
    let plan = plan_of(&f, &p0);
    let rec = deploy(&f, &req(&p0, &plan.plan_id)).unwrap();
    assert!(!rec.vapid_rotated);
    assert_eq!(keys::vapid(&*f.store).unwrap().unwrap().1, old);
    // a deploy with push ships and then commits it
    let p = f.preview(true);
    assert!(p.vapid_key_staged);
    let plan = plan_of(&f, &p);
    let rec = deploy(&f, &req(&p, &plan.plan_id)).unwrap();
    assert!(rec.vapid_rotated && rec.push_deployed);
    assert_eq!(rec.vapid_public.as_deref(), Some(staged.as_str()));
    assert_eq!(keys::vapid(&*f.store).unwrap().unwrap().1, staged);
    assert!(keys::staged_vapid(&*f.store).unwrap().is_none());
}

#[test]
fn a_push_key_rotation_cannot_be_cancelled_once_its_secrets_went_out() {
    let f = fixture(happy_spawner(WORKER));
    let (_, old) = keys::ensure_vapid(&*f.store, &Jail::off()).unwrap();
    let staged = keys::stage_vapid(&*f.store, &Jail::off()).unwrap();
    let p = f.preview(true);
    assert!(p.vapid_key_staged);
    *f.relay.status_failures.lock().unwrap() = 10_000;
    let plan = plan_of(&f, &p);
    let mut ev = Vec::new();
    assert_eq!(f.deployer.deploy(&req(&p, &plan.plan_id), &mut |x| ev.push(x)).unwrap_err().code(), "healthTimeout");
    assert_eq!(f.spawner.calls_of(Op::SecretPut).len(), 3, "the secrets with the staged private key reached the relay");
    assert_eq!(keys::discard_staged_vapid(&*f.store).unwrap_err().code(), "rotationShipped");
    assert_eq!(keys::stage_vapid(&*f.store, &Jail::off()).unwrap_err().code(), "rotationShipped");
    assert_eq!(keys::vapid(&*f.store).unwrap().unwrap().1, old);
    *f.relay.status_failures.lock().unwrap() = 0;
    let rec = f.deployer.retry(&job_id_of(&ev), intely_relay_deploy::Step::Health, &mut |_| {}).expect("retry");
    assert!(rec.vapid_rotated);
    assert_eq!(keys::vapid(&*f.store).unwrap().unwrap().1, staged);
    assert!(keys::discard_staged_vapid(&*f.store).is_ok(), "the marker is gone with the commit");
}
