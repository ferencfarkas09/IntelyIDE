//! Preview and the deploy job (spec 4.4). `preview` stages and signs the bundle, snapshots the Worker source, generates the config,
//! proves it with a dry run and a name check, and binds everything into a single-use `previewId`. `deploy` re-verifies every bound
//! component right before the spawn and then runs Stage, Config, Deploy, Parse, Secrets, Health, Verify, Record. Nothing is applied:
//! the caller records the result and the user clicks `Use this relay now`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use intely_relay_bundle::manifest::{manifest_hash, FileEntry};
use intely_relay_bundle::{check_relay_with, fingerprint, stage_and_sign_with, verify_staged, BundleVerdict, Expected, HttpRequest, RelayCheck, SignOptions, StagedBundle};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::config::{self, validate_custom_domain, validate_worker_name, ConfigOpts, Resource};
use crate::deployer::{lock, random_hex, tail4, AuthCtx, AuthMode, Deployer, JobEvent, OpMeta, Step, StepEvent, StepStatus, STEPS};
use crate::error::{DeployError, Result};
use crate::gate::gate;
use crate::kit::{private_dir, sha256_file, RelayKit};
use crate::plan::PlanOp;
use crate::keys;
use crate::output::{accept_target, classify_name_check, parse_deploy_ndjson, Account, ErrorKind, NameCheck, RelayTarget};
use crate::wrangler::{Base, Op};

/// A preview is good for 15 minutes.
pub const PREVIEW_TTL_SECS: u64 = 15 * 60;
/// Health retries every 5 s for up to 90 s (the first workers.dev deploys can answer 523 for about a minute).
pub const HEALTH_INTERVAL: Duration = Duration::from_secs(5);
pub const HEALTH_BUDGET_SECS: u64 = 90;

const LICENSES_TXT: &str = "This phone app is part of IntelyIDE, free software released under the GNU General Public License, version 3 or (at your option) any later version (GPL-3.0-or-later).\nThe corresponding source code is offered by whoever deployed this relay: ask them for the IntelyIDE checkout this bundle was built from.\n";

#[derive(Debug, Clone)]
pub struct PreviewRequest {
    pub worker_name: String,
    pub push: bool,
    pub custom_domain: Option<String>,
    pub account: Account,
    pub auth_mode: AuthMode,
    /// The typed override of spec 4.5 for a Mac clock far from the stored `seq`.
    pub allow_seq_clock_skew: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub name: String,
    pub id_tail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesView {
    pub count: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleView {
    /// The first 16 hex digits in groups of four.
    pub hash_short: String,
    pub hash_full: String,
    pub pub_fingerprint: String,
    pub seq: u64,
}

/// The review screen (spec 3.2 step 4, `DeployPreview` of 4.11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployPreview {
    pub preview_id: String,
    pub expires_at: u64,
    pub argv: Vec<String>,
    pub command_line: String,
    pub env_names: Vec<String>,
    pub account: AccountView,
    pub worker_name: String,
    pub name_check: NameCheck,
    pub resources: Vec<Resource>,
    pub files: FilesView,
    pub bundle: BundleView,
    pub push: bool,
    pub host_preview: String,
    pub config_text: String,
    pub relay_code_hash: String,
    pub file_list: Vec<FileRow>,
    #[serde(rename = "kitDirtyFiles")]
    pub kit_dirty: Option<usize>,
    pub guessable_name: bool,
    pub needs_overwrite_phrase: bool,
    /// `verified`: the dry run's bundled module list lies inside the snapshot and the kit's node_modules; `unverified`: no source map
    /// to read (the shape of the dry-run output is `[unverified]` until M1).
    pub module_check: &'static str,
    /// True when `module_check` is `unverified`: the deploy is refused (`moduleUnverified`) until the user acknowledges it.
    pub needs_unverified_ack: bool,
    /// A rotated signing key / push key pair is staged and this preview signs with it (committed only after the relay check).
    pub signing_key_staged: bool,
    pub vapid_key_staged: bool,
}

/// The overwrite phrase the user must type for a foreign or unknown Worker name, or a dirty kit.
pub fn overwrite_phrase(worker_name: &str) -> String {
    format!("overwrite {worker_name}")
}

/// `intely-relay:<stamp>` is the deployment message; the stamp is the first 16 hex digits of sha256 of the install id.
pub fn stamp_of(install_id: &str) -> String {
    hex::encode(&Sha256::digest(format!("intely-relay-stamp:{install_id}").as_bytes())[..8])
}

pub(crate) struct PreviewRecord {
    pub(crate) expires_at: u64,
    pub(crate) worker: String,
    pub(crate) account: Account,
    pub(crate) auth_mode: AuthMode,
    pub(crate) push: bool,
    pub(crate) custom_domain: Option<String>,
    pub(crate) vapid_public: Option<String>,
    /// The bundle was signed with a rotated key that is still staged / the push keys are a staged pair: committed after Verify.
    pub(crate) signed_staged: bool,
    pub(crate) vapid_staged: bool,
    /// `verified` or `unverified` (the dry run's module list could not be read): deploying an unverified one needs the user's ack.
    pub(crate) module_check: &'static str,
    pub(crate) staged: StagedBundle,
    pub(crate) built_at: u64,
    name_check: NameCheck,
    dirty: Option<usize>,
    pub(crate) binding: String,
    pub(crate) cfg_path: PathBuf,
    pub(crate) config_text: String,
    pub(crate) relay_code_hash: String,
    pub(crate) stamp: String,
}

#[derive(Clone)]
pub struct JobState {
    pub job_id: String,
    pub(crate) rec: Arc<PreviewRecord>,
    pub(crate) target: Option<RelayTarget>,
    pub(crate) version_id: Option<String>,
    pub(crate) secrets_failed: bool,
    pub(crate) check: Option<RelayCheck>,
}

impl JobState {
    pub fn worker_name(&self) -> &str {
        &self.rec.worker
    }

    pub fn target(&self) -> Option<&RelayTarget> {
        self.target.as_ref()
    }
}

#[derive(Debug, Clone)]
pub struct DeployRequest {
    pub preview_id: String,
    pub confirm_name: String,
    pub overwrite_phrase: Option<String>,
    /// The nonce of a plan issued for this preview (`Deployer::plan`); spent by the run.
    pub plan_id: String,
    /// The user acknowledged that the dry run's module list could not be verified.
    pub acknowledge_unverified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleRecord {
    pub hash: String,
    pub pubkey: String,
    pub seq: u64,
    pub built_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckView {
    pub reachable: bool,
    pub relay_version: Option<String>,
    pub do_ok: Option<bool>,
    pub push_configured: Option<bool>,
    pub verdict: &'static str,
    pub served_hash: Option<String>,
    pub problems: Vec<String>,
    pub checked_at: u64,
}

pub fn verdict_name(v: &BundleVerdict) -> &'static str {
    match v {
        BundleVerdict::Ok => "ok",
        BundleVerdict::Observed => "observed",
        BundleVerdict::HashMismatch => "hashMismatch",
        BundleVerdict::BadSignature => "badSignature",
        BundleVerdict::KeyMismatch => "keyMismatch",
        BundleVerdict::Rollback => "rollback",
        BundleVerdict::Missing => "missing",
    }
}

pub fn check_view(c: &RelayCheck) -> CheckView {
    CheckView {
        reachable: c.reachable,
        relay_version: c.relay_version.clone(),
        do_ok: c.do_ok,
        push_configured: c.push_configured,
        verdict: verdict_name(&c.verdict),
        served_hash: c.served_hash.clone(),
        problems: c.problems.clone(),
        checked_at: c.checked_at,
    }
}

/// Everything the Record step hands to the caller (the Tauri layer writes it into `remote.cloud`; the URL is NOT applied).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployRecord {
    pub worker_name: String,
    pub account_id: String,
    pub account_name: String,
    pub auth_mode: AuthMode,
    /// `wss://host` (or `ws://127.0.0.1:port` in the test jail): what `relayUrl` becomes.
    pub url: String,
    pub http_base: String,
    pub host: String,
    pub deployed_at: u64,
    pub version_id: Option<String>,
    pub wrangler_version: Option<String>,
    pub relay_version: Option<String>,
    pub relay_code_hash: String,
    pub stamp: String,
    pub push_deployed: bool,
    pub vapid_public: Option<String>,
    pub custom_domain: Option<String>,
    pub bundle: BundleRecord,
    /// This deploy shipped a rotated key and it is now the active one (the staged slot is empty again).
    pub key_rotated: bool,
    pub vapid_rotated: bool,
    /// `secretFailed` when push was on and a secret did not go through (the Worker is live without push).
    pub warnings: Vec<String>,
    pub check: CheckView,
}

fn group4(hex16: &str) -> String {
    hex16.as_bytes().chunks(4).filter_map(|c| std::str::from_utf8(c).ok()).collect::<Vec<_>>().join(" ")
}

fn sha_join(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_le_bytes());
        h.update(p.as_bytes());
    }
    hex::encode(h.finalize())
}

fn files_hash(entries: &[FileEntry]) -> String {
    let mut h = Sha256::new();
    for e in entries {
        h.update(format!("{}\0{}\0{}\n", e.path, e.sha256, e.size).as_bytes());
    }
    hex::encode(h.finalize())
}

fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// Reads the source maps of a dry run's `--outdir` and checks every original source lies inside the snapshot or the kit's
/// `node_modules` (spec 4.12.4). `Ok(true)` verified, `Ok(false)` no source map to read, `Err` a module outside the allowed roots.
pub fn check_bundled_modules(outdir: &Path, allowed: &[PathBuf]) -> Result<bool> {
    let mut maps: Vec<PathBuf> = Vec::new();
    let mut stack = vec![(outdir.to_path_buf(), 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(meta) = fs::symlink_metadata(&p) else { continue };
            if meta.is_dir() && depth < 2 {
                stack.push((p, depth + 1));
            } else if meta.is_file() && p.extension().and_then(|x| x.to_str()) == Some("map") {
                maps.push(p);
            }
        }
    }
    if maps.is_empty() {
        return Ok(false);
    }
    let allowed: Vec<PathBuf> = allowed.iter().map(|a| fs::canonicalize(a).unwrap_or_else(|_| lexical(a))).collect();
    for m in maps {
        let v: serde_json::Value = serde_json::from_slice(&fs::read(&m)?).map_err(|_| DeployError::coded("deployFailed", "the dry run's source map is not readable"))?;
        let base = fs::canonicalize(m.parent().unwrap_or(outdir)).unwrap_or_else(|_| m.parent().unwrap_or(outdir).to_path_buf());
        for s in v["sources"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            let Some(s) = s.as_str() else { continue };
            if s.contains("://") || s.starts_with("node:") || s.starts_with("cloudflare:") {
                continue;
            }
            let full = lexical(&base.join(s));
            if !allowed.iter().any(|a| full.starts_with(a)) {
                return Err(DeployError::coded("deployFailed", format!("the bundle would contain a module outside the snapshot: {}", crate::mask::Masker::default().mask(s))));
            }
        }
    }
    Ok(true)
}

pub(crate) struct Live {
    pub(crate) binding: String,
    pub(crate) config_text: String,
    pub(crate) argv: Vec<String>,
    pub(crate) command_line: String,
    pub(crate) env_names: Vec<String>,
}

impl Deployer {
    fn auth_ctx(&self, mode: AuthMode, account: &Account) -> AuthCtx {
        AuthCtx { mode, account_id: Some(account.id.clone()) }
    }

    fn message(&self) -> String {
        format!("intely-relay:{}", stamp_of(&self.d.install_id))
    }

    /// Re-reads every bound component from disk and returns the binding hash plus the pieces the review shows. A swapped symlink,
    /// an edited staged file, a replaced wrangler or an edited snapshot all change it.
    pub(crate) fn live(&self, worker: &str, account: &Account, mode: AuthMode, pubkey: &str, seq: u64) -> Result<Live> {
        let worker_dir = self.root.join(worker);
        let entries = verify_staged(&worker_dir.join("dist"), Some(pubkey), Some(seq))?;
        let manifest = manifest_hash(&entries);
        let (src_hash, package_hash) = RelayKit::rehash_snapshot(&worker_dir.join("kit"))?;
        let wrangler = self.wrangler()?;
        let resolved = fs::canonicalize(&wrangler).map_err(|_| DeployError::coded("wranglerMissing", "wrangler is not installed"))?;
        let entry_hash = sha256_file(&resolved, 32 << 20)?;
        let cfg = worker_dir.join("wrangler.jsonc");
        let config_text = fs::read_to_string(&cfg)?;
        let env = self.env(&self.auth_ctx(mode, account), true)?;
        let cwd = worker_dir.clone();
        let placeholder = self.root.join("out-PLACEHOLDER.ndjson");
        let inv = Base { wrangler: &wrangler, cwd: &cwd, env: &env }.deploy(&cfg, worker, &self.message(), &placeholder);
        let env_names = inv.env_names();
        let argv = inv.argv.clone();
        let command_line = inv.display();
        let binding = sha_join(&[
            &argv.join("\0"),
            &env_names.join("\0"),
            &config_text,
            &manifest,
            &account.id,
            worker,
            &src_hash,
            &package_hash,
            &entry_hash,
            &files_hash(&entries),
        ]);
        Ok(Live { binding, config_text, argv, command_line, env_names })
    }

    /// Stage + sign the bundle, snapshot the source, generate the config, dry-run it, check the name, bind it all. Local work and
    /// two read-only wrangler calls; nothing is created at Cloudflare.
    pub fn preview(&self, req: &PreviewRequest, emit: &mut dyn FnMut(JobEvent)) -> Result<DeployPreview> {
        validate_worker_name(&req.worker_name)?;
        if let Some(d) = &req.custom_domain {
            validate_custom_domain(d)?;
        }
        let worker = req.worker_name.as_str();
        let wrangler = self.wrangler()?;
        gate(&self.d.jail, Op::DeployDryRun, &wrangler, self.d.cloud)?;
        let guard = self.runner.begin("preview")?;
        keys::require_durable(&*self.d.store, &self.d.jail)?;
        if !self.d.kit.dist_index().is_file() {
            return Err(DeployError::coded("kitMissing", "the phone app is not built yet: run Prepare"));
        }
        let (key, _pubkey, signed_staged) = keys::signing_key_for_deploy(&*self.d.store, &self.d.jail)?;
        let (vapid_public, vapid_staged) = if req.push {
            let (_, public, staged) = keys::vapid_for_deploy(&*self.d.store, &self.d.jail)?;
            (Some(public), staged)
        } else {
            (None, false)
        };
        let worker_dir = self.root.join(worker);
        self.ensure_dirs()?;
        private_dir(&worker_dir)?;
        let now = self.d.clock.now();

        // 1. Stage and sign (seq is persisted at sign time).
        let prev = keys::read_seq(&*self.d.store)?;
        let opts = SignOptions { extra_files: vec![("licenses.txt".to_owned(), LICENSES_TXT.as_bytes().to_vec())], allow_seq_clock_skew: req.allow_seq_clock_skew, ..SignOptions::default() };
        let staged = stage_and_sign_with(&self.d.kit.dist_dir(), &worker_dir.join("dist"), &key, vapid_public.as_deref(), prev, now, &opts)?;
        keys::write_seq(&*self.d.store, staged.bundle.seq)?;
        guard.log(&format!("staged {} files, bundle {}", staged.bundle.files, &staged.bundle.hash[..16]));

        // 2. Snapshot the Worker source and generate the config.
        let snapshot = self.d.kit.snapshot_src(&worker_dir.join("kit"))?;
        let stamp = stamp_of(&self.d.install_id);
        let cfg = config::generate(&self.d.kit, worker, &snapshot, &worker_dir, &ConfigOpts { custom_domain: req.custom_domain.clone(), stamp: stamp.clone() })?;

        // 3. Dry run: proves the config parses and bundles; the module list must stay inside the snapshot.
        let auth = self.auth_ctx(req.auth_mode, &req.account);
        let env = self.env(&auth, true)?;
        let tail = tail4(Some(&req.account.id));
        let meta = OpMeta { worker, account_tail: &tail };
        let outdir = self.root.join(format!("outdir-{}", guard.run_id()));
        let _ = fs::remove_dir_all(&outdir);
        let r = self.exec(&guard, Base { wrangler: &wrangler, cwd: &worker_dir, env: &env }.deploy_dry_run(&cfg.path, worker, &outdir), &meta, emit, None)?;
        let module_check = if r.ok() {
            let allowed = [worker_dir.join("kit"), self.d.kit.relay_dir.join("node_modules")];
            let verified = check_bundled_modules(&outdir, &allowed);
            let _ = fs::remove_dir_all(&outdir);
            if verified? {
                "verified"
            } else {
                "unverified"
            }
        } else {
            let _ = fs::remove_dir_all(&outdir);
            return Err(r.failure());
        };

        // 4. Name check (read-only). Not logged in / bad token stops here; anything else is `unknown`, which the review shows.
        let r = self.exec(&guard, Base { wrangler: &wrangler, cwd: &worker_dir, env: &env }.deployments_list(&cfg.path, worker), &meta, emit, None)?;
        if !r.ok() && matches!(r.kind(), ErrorKind::NotLoggedIn | ErrorKind::AuthInvalid) {
            return Err(r.failure());
        }
        if r.outcome.cancelled {
            return Err(r.failure());
        }
        let name_check = classify_name_check(&r.masked, if r.outcome.timed_out { 124 } else { r.outcome.exit_code }, &stamp);

        // 5. Kit state, binding, record.
        let dirty = self.d.kit.dirty_files(&self.path_var()).filter(|n| *n > 0);
        let live = self.live(worker, &req.account, req.auth_mode, &staged.bundle.pubkey, staged.bundle.seq)?;
        let id = random_hex(16)?;
        let rec = Arc::new(PreviewRecord {
            expires_at: now + PREVIEW_TTL_SECS,
            worker: worker.to_owned(),
            account: req.account.clone(),
            auth_mode: req.auth_mode,
            push: req.push,
            custom_domain: req.custom_domain.clone(),
            vapid_public: vapid_public.clone(),
            signed_staged,
            vapid_staged,
            module_check,
            staged: staged.bundle.clone(),
            built_at: staged.built_at,
            name_check,
            dirty,
            binding: live.binding.clone(),
            cfg_path: cfg.path.clone(),
            config_text: cfg.text.clone(),
            relay_code_hash: cfg.relay_code_hash.clone(),
            stamp: stamp.clone(),
        });
        {
            let mut m = lock(&self.previews);
            m.retain(|_, r| r.expires_at > now && r.worker != worker);
            m.insert(id.clone(), rec);
        }

        let mut resources = cfg.resources.clone();
        resources.push(Resource::new("assets", ""));
        if req.push {
            for s in ["VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"] {
                resources.push(Resource::new("secret", s));
            }
        }
        let host_preview = match &req.custom_domain {
            Some(d) => format!("https://{d}"),
            None => format!("https://{worker}.<your-workers-subdomain>.workers.dev"),
        };
        Ok(DeployPreview {
            preview_id: id,
            expires_at: now + PREVIEW_TTL_SECS,
            argv: live.argv,
            command_line: live.command_line,
            env_names: live.env_names,
            account: AccountView { name: req.account.name.clone(), id_tail: tail },
            worker_name: worker.to_owned(),
            name_check,
            resources,
            files: FilesView { count: staged.bundle.files, bytes: staged.bundle.bytes },
            bundle: BundleView { hash_short: group4(&staged.bundle.hash[..16]), hash_full: staged.bundle.hash.clone(), pub_fingerprint: fingerprint(&staged.bundle.pubkey), seq: staged.bundle.seq },
            push: req.push,
            host_preview,
            config_text: live.config_text,
            relay_code_hash: cfg.relay_code_hash,
            file_list: staged.file_list.iter().map(|f| FileRow { path: f.path.clone(), size: f.size, sha256: f.sha256.clone() }).collect(),
            kit_dirty: dirty,
            guessable_name: config::name_is_guessable(worker),
            needs_overwrite_phrase: name_check.needs_overwrite_phrase() || dirty.is_some(),
            module_check,
            needs_unverified_ack: module_check != "verified",
            signing_key_staged: signed_staged,
            vapid_key_staged: vapid_staged,
        })
    }

    /// The Worker name and the account id tail of a live preview (what the audit record of its deploy names).
    pub fn preview_subject(&self, preview_id: &str) -> Option<(String, String)> {
        let now = self.d.clock.now();
        lock(&self.previews).get(preview_id).filter(|r| r.expires_at > now).map(|r| (r.worker.clone(), tail4(Some(&r.account.id))))
    }

    /// Runs the deploy job for a live preview: the typed name must equal the Worker name exactly, a foreign/unknown name or a dirty kit
    /// needs the overwrite phrase, and the preview is single use. A mismatch does not burn the preview.
    pub fn deploy(&self, req: &DeployRequest, emit: &mut dyn FnMut(JobEvent)) -> Result<DeployRecord> {
        let now = self.d.clock.now();
        let rec = {
            let mut m = lock(&self.previews);
            m.retain(|_, r| r.expires_at > now);
            m.get(&req.preview_id).cloned()
        }
        .ok_or_else(|| DeployError::coded("previewStale", "the review is no longer valid: review again"))?;
        if rec.name_check.needs_overwrite_phrase() || rec.dirty.is_some() {
            if req.overwrite_phrase.as_deref() != Some(overwrite_phrase(&rec.worker).as_str()) {
                return Err(DeployError::coded("confirmMismatch", "the overwrite phrase is required and does not match"));
            }
        }
        // Fail closed: a module list that could not be read is not "fine", it is unknown, and the user has to say so.
        if rec.module_check != "verified" && !req.acknowledge_unverified {
            return Err(DeployError::coded("moduleUnverified", "the dry run's module list could not be verified: acknowledge it to deploy anyway"));
        }
        let guard = self.runner.begin("deploy")?;
        // The plan nonce and the typed name come last: they are spent only by a run that is about to start.
        self.plans.redeem(now, &req.plan_id, PlanOp::Deploy, &req.confirm_name, Some((&req.preview_id, &rec.binding)))?;
        lock(&self.previews).remove(&req.preview_id);
        let mut job = JobState { job_id: guard.run_id().to_owned(), rec, target: None, version_id: None, secrets_failed: false, check: None };
        let result = self.run_steps(&guard, &mut job, Step::Stage, emit);
        // Only a failed job can be retried: a finished one is gone, so its (spent) plan cannot be replayed through `retry`.
        *lock(&self.last_job) = result.is_err().then_some(job);
        result
    }

    /// The Worker name and the account id tail of the failed job a retry would continue (what the audit record of the retry names).
    pub fn job_subject(&self, job_id: &str) -> Option<(String, String)> {
        lock(&self.last_job).as_ref().filter(|j| j.job_id == job_id).map(|j| (j.rec.worker.clone(), tail4(Some(&j.rec.account.id))))
    }

    /// `Retry from this step` for the steps that are safe to run again (Deploy, Secrets, Health, Verify) after a FAILED job (a finished
    /// job is forgotten, so `there is no failed job to retry` is the answer to a replay).
    pub fn retry(&self, job_id: &str, from: Step, emit: &mut dyn FnMut(JobEvent)) -> Result<DeployRecord> {
        if !from.idempotent() {
            return Err(DeployError::coded("previewStale", "this step cannot be retried on its own: review again"));
        }
        let mut job = lock(&self.last_job).clone().filter(|j| j.job_id == job_id).ok_or_else(|| DeployError::coded("previewStale", "there is no failed job to retry"))?;
        if from.index() > Step::Deploy.index() && job.target.is_none() {
            return Err(DeployError::coded("previewStale", "the deploy did not finish: retry from the Deploy step"));
        }
        let guard = self.runner.begin("deploy")?;
        let result = self.run_steps(&guard, &mut job, from, emit);
        *lock(&self.last_job) = result.is_err().then_some(job);
        result
    }

    fn step_event(guard: &crate::runner::RunGuard, step: Step, status: StepStatus, code: Option<&str>) -> JobEvent {
        JobEvent::Step(StepEvent { run_id: guard.run_id().to_owned(), step, status, code: code.map(str::to_owned) })
    }

    fn run_steps(&self, guard: &crate::runner::RunGuard, job: &mut JobState, from: Step, emit: &mut dyn FnMut(JobEvent)) -> Result<DeployRecord> {
        let mut warnings: Vec<String> = Vec::new();
        let mut record: Option<DeployRecord> = None;
        for step in STEPS.iter().filter(|s| s.index() >= from.index()) {
            emit(Self::step_event(guard, step.clone(), StepStatus::Running, None));
            let outcome: Result<StepStatus> = match step {
                Step::Stage => self.step_stage(job).map(|_| StepStatus::Ok),
                Step::Config => self.step_config(job).map(|_| StepStatus::Ok),
                Step::Deploy => self.step_deploy(guard, job, emit).map(|_| StepStatus::Ok),
                Step::Parse => self.step_parse(guard, job).map(|_| StepStatus::Ok),
                Step::Secrets => self.step_secrets(guard, job, emit),
                Step::Health => self.step_health(guard, job).map(|_| StepStatus::Ok),
                Step::Verify => self.step_verify(job).map(|_| StepStatus::Ok),
                Step::Record => self.step_record(job).map(|r| {
                    record = Some(r);
                    StepStatus::Ok
                }),
            };
            match outcome {
                Ok(status) => {
                    if *step == Step::Secrets && job.secrets_failed {
                        warnings.push("secretFailed".to_owned());
                        emit(Self::step_event(guard, step.clone(), StepStatus::Failed, Some("secretFailed")));
                    } else {
                        emit(Self::step_event(guard, step.clone(), status, None));
                    }
                }
                Err(e) => {
                    emit(Self::step_event(guard, step.clone(), StepStatus::Failed, Some(e.code())));
                    return Err(e);
                }
            }
        }
        let mut rec = record.ok_or_else(|| DeployError::coded("deployFailed", "the job ended before the Record step"))?;
        if job.secrets_failed && !rec.warnings.contains(&"secretFailed".to_owned()) {
            rec.warnings.push("secretFailed".to_owned());
        }
        Ok(rec)
    }

    fn verify_binding(&self, job: &JobState) -> Result<()> {
        let r = &job.rec;
        // A swapped symlink or a missing file in the snapshot is the same event for the user: the review no longer matches.
        let live = self.live(&r.worker, &r.account, r.auth_mode, &r.staged.pubkey, r.staged.seq).map_err(|e| match e.code() {
            "kitMissing" => DeployError::coded("previewStale", "the Worker source changed since the review: review again"),
            _ => e,
        })?;
        if live.binding != r.binding {
            return Err(DeployError::coded("previewStale", "something the review showed has changed since: review again"));
        }
        Ok(())
    }

    fn step_stage(&self, job: &JobState) -> Result<()> {
        self.verify_binding(job)
    }

    fn step_config(&self, job: &JobState) -> Result<()> {
        let text = fs::read_to_string(&job.rec.cfg_path)?;
        if text == job.rec.config_text {
            Ok(())
        } else {
            Err(DeployError::coded("previewStale", "the generated config changed since the review"))
        }
    }

    fn account_ctx(&self, job: &JobState) -> AuthCtx {
        self.auth_ctx(job.rec.auth_mode, &job.rec.account)
    }

    fn out_file(&self, guard: &crate::runner::RunGuard) -> PathBuf {
        self.root.join(format!("out-{}.ndjson", guard.run_id()))
    }

    fn step_deploy(&self, guard: &crate::runner::RunGuard, job: &mut JobState, emit: &mut dyn FnMut(JobEvent)) -> Result<()> {
        // Re-verified immediately before the spawn.
        self.verify_binding(job)?;
        let rec = job.rec.clone();
        let wrangler = self.wrangler()?;
        let env = self.env(&self.account_ctx(job), true)?;
        let worker_dir = self.root.join(&rec.worker);
        let out = self.out_file(guard);
        let _ = fs::remove_file(&out);
        let tail = tail4(Some(&rec.account.id));
        // A rotated key was staged when the review was made: it must still be the staged one, or the Record step could not commit it
        // and the relay would serve a bundle signed with a key this Mac then no longer holds.
        if rec.signed_staged && keys::staged_signing_key(&*self.d.store)?.map(|(_, p)| p).as_deref() != Some(rec.staged.pubkey.as_str()) {
            return Err(DeployError::coded("previewStale", "the staged signing key changed since the review: review again"));
        }
        let inv = Base { wrangler: &wrangler, cwd: &worker_dir, env: &env }.deploy(&rec.cfg_path, &rec.worker, &self.message(), &out);
        let r = self.exec(guard, inv, &OpMeta { worker: &rec.worker, account_tail: &tail }, emit, None)?;
        // From a deploy that may have gone through on, the relay serves the staged key: rolling the rotation back is closed.
        if rec.signed_staged && (r.ok() || r.outcome.timed_out || r.outcome.cancelled) {
            keys::mark_signing_shipped(&*self.d.store, &rec.staged.pubkey)?;
        }
        if !r.ok() {
            // A failure line in the output file is more precise than the exit code, but only the classified code and the masked tail leave.
            return Err(r.failure());
        }
        Ok(())
    }

    fn step_parse(&self, guard: &crate::runner::RunGuard, job: &mut JobState) -> Result<()> {
        let out = self.out_file(guard);
        let text = fs::read_to_string(&out).unwrap_or_default();
        let _ = fs::remove_file(&out);
        let result = parse_deploy_ndjson(&text)?;
        if result.worker_name != job.rec.worker {
            return Err(DeployError::coded("deployFailed", "wrangler deployed a Worker with a different name than the review showed"));
        }
        let mut last: Option<DeployError> = None;
        let mut accepted: Option<RelayTarget> = None;
        for t in &result.targets {
            match accept_target(t, &job.rec.worker, job.rec.custom_domain.as_deref(), self.d.jail.mode()) {
                Ok(a) => {
                    accepted = Some(a);
                    break;
                }
                Err(e) => last = Some(e),
            }
        }
        let target = accepted.ok_or_else(|| last.unwrap_or_else(|| DeployError::coded("deployFailed", "wrangler printed no deploy target")))?;
        job.target = Some(target);
        job.version_id = result.version_id;
        Ok(())
    }

    fn step_secrets(&self, guard: &crate::runner::RunGuard, job: &mut JobState, emit: &mut dyn FnMut(JobEvent)) -> Result<StepStatus> {
        if !job.rec.push {
            return Ok(StepStatus::Skipped);
        }
        let target = job.target.clone().ok_or_else(|| DeployError::coded("previewStale", "no deploy target"))?;
        let pair = if job.rec.vapid_staged { keys::staged_vapid(&*self.d.store)? } else { keys::vapid(&*self.d.store)? };
        let (private, public) = pair.ok_or_else(|| DeployError::coded("secretFailed", "no VAPID key was generated"))?;
        if job.rec.vapid_public.as_deref() != Some(public.as_str()) {
            return Err(DeployError::coded("previewStale", "the VAPID key changed since the review"));
        }
        let auth = self.account_ctx(job);
        let rec = job.rec.clone();
        if rec.vapid_staged {
            keys::mark_vapid_shipped(&*self.d.store, &public)?;
        }
        match self.secrets_run(guard, &rec.worker, &rec.cfg_path, &target.host, &auth, &private, &public, emit) {
            Ok(()) => {
                job.secrets_failed = false;
                Ok(StepStatus::Ok)
            }
            Err(e) if e.code() == "secretFailed" => {
                job.secrets_failed = true;
                Ok(StepStatus::Ok)
            }
            Err(e) => Err(e),
        }
    }

    fn runtime() -> Result<tokio::runtime::Runtime> {
        tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| DeployError::Io(e.to_string()))
    }

    fn step_health(&self, guard: &crate::runner::RunGuard, job: &mut JobState) -> Result<()> {
        let base = job.target.clone().ok_or_else(|| DeployError::coded("previewStale", "no deploy target"))?.http_base;
        let rt = Self::runtime()?;
        let start = self.d.clock.now();
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let req = HttpRequest { url: format!("{base}/api/status"), headers: vec![("accept".to_owned(), "application/json".to_owned())] };
            let probe = rt.block_on(self.d.http.get(req));
            let (ok, why) = match probe {
                Ok(r) if r.status == 200 => {
                    let good = serde_json::from_slice::<serde_json::Value>(&r.body).is_ok_and(|v| v.get("relay").is_some_and(|x| x.is_object()));
                    (good, if good { "ok".to_owned() } else { "unexpected body".to_owned() })
                }
                Ok(r) => (false, format!("HTTP {}", r.status)),
                Err(e) => (false, e.code().to_owned()),
            };
            guard.log(&format!("health attempt {attempt}: {why}"));
            if ok {
                return Ok(());
            }
            if guard.cancelled() {
                return Err(DeployError::coded("cancelled", "stopped"));
            }
            if self.d.clock.now().saturating_sub(start) >= HEALTH_BUDGET_SECS {
                return Err(DeployError::coded("healthTimeout", format!("the relay did not answer within {HEALTH_BUDGET_SECS} seconds")));
            }
            self.d.clock.sleep(HEALTH_INTERVAL);
        }
    }

    fn step_verify(&self, job: &mut JobState) -> Result<()> {
        let base = job.target.clone().ok_or_else(|| DeployError::coded("previewStale", "no deploy target"))?.http_base;
        let rt = Self::runtime()?;
        let expected = Expected { hash: Some(job.rec.staged.hash.clone()), pubkey: Some(job.rec.staged.pubkey.clone()), min_seq: Some(job.rec.staged.seq) };
        let check = rt.block_on(check_relay_with(&base, &expected, None, &self.jail, &*self.d.http));
        let verdict = check.verdict.clone();
        let good = check.reachable && verdict == BundleVerdict::Ok && check.sw_matches != Some(false);
        let why = if check.problems.is_empty() { format!("{verdict:?}, sw {:?}", check.sw_matches) } else { check.problems.join("; ") };
        job.check = Some(check);
        if good {
            return Ok(());
        }
        Err(match verdict {
            BundleVerdict::BadSignature | BundleVerdict::KeyMismatch => DeployError::coded("badSignature", "the relay serves a bundle that does not verify under the key it was signed with"),
            _ => DeployError::coded("bundleMismatch", format!("the relay serves a different bundle than the one that was deployed ({why})")),
        })
    }

    fn step_record(&self, job: &JobState) -> Result<DeployRecord> {
        let r = &job.rec;
        let target = job.target.clone().ok_or_else(|| DeployError::coded("previewStale", "no deploy target"))?;
        let check = job.check.clone().ok_or_else(|| DeployError::coded("bundleMismatch", "the bundle was not verified"))?;
        let push_deployed = r.push && !job.secrets_failed;
        // The rotated keys switch only now: the deploy went through and the relay check passed (this step needs `job.check`). A failure
        // here leaves the staged key in place, so the next preview signs with it again and nothing is lost.
        let key_rotated = r.signed_staged && keys::commit_staged_signing_key(&*self.d.store, &r.staged.pubkey)?;
        let vapid_rotated = match (&r.vapid_public, r.vapid_staged && !job.secrets_failed) {
            (Some(public), true) => keys::commit_staged_vapid(&*self.d.store, public)?,
            _ => false,
        };
        let rec = DeployRecord {
            worker_name: r.worker.clone(),
            account_id: r.account.id.clone(),
            account_name: r.account.name.clone(),
            auth_mode: r.auth_mode,
            url: target.ws_base.clone(),
            http_base: target.http_base.clone(),
            host: target.host.clone(),
            deployed_at: self.d.clock.now(),
            version_id: job.version_id.clone(),
            wrangler_version: self.d.kit.installed_wrangler_version(),
            relay_version: check.relay_version.clone().or_else(|| self.d.kit.relay_version()),
            relay_code_hash: r.relay_code_hash.clone(),
            stamp: r.stamp.clone(),
            push_deployed,
            vapid_public: if r.push { r.vapid_public.clone() } else { None },
            custom_domain: r.custom_domain.clone(),
            bundle: BundleRecord { hash: r.staged.hash.clone(), pubkey: r.staged.pubkey.clone(), seq: r.staged.seq, built_at: r.built_at },
            key_rotated,
            vapid_rotated,
            warnings: if job.secrets_failed { vec!["secretFailed".to_owned()] } else { Vec::new() },
            check: check_view(&check),
        };
        let _ = self.ops.append(&crate::ops_log::OpRecord {
            ts: rec.deployed_at,
            op: "deployJob".to_owned(),
            outcome: "ok".to_owned(),
            worker: rec.worker_name.clone(),
            account_tail: tail4(Some(&rec.account_id)),
            exit_code: None,
            duration_ms: 0,
        });
        Ok(rec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: the health and verify steps run the real (reqwest) Http on this runtime, which needs the I/O driver.
    #[test]
    fn the_job_runtime_has_an_io_driver() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let rt = Deployer::runtime().unwrap();
        rt.block_on(async { tokio::net::TcpStream::connect(addr).await.unwrap() });
    }
}
