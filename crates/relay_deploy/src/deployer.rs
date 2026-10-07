//! The relay operations behind the Tauri commands (spec 4.3, 4.4, 4.11): Prepare, sign-in, sign-out, whoami, rollback, remove and the
//! VAPID secrets run here; preview and the deploy job are in `pipeline.rs`. Pure over injected seams (`Spawner`, `Http`, `Clock`,
//! `SecretStore`, a variable getter), so tests drive everything with fakes and never reach a real Cloudflare account.
//!
//! Every operation: takes the single-operation guard (`busy`), passes the jail gate, builds the child environment from the allow-list,
//! masks every output line, and wipes wrangler's log directory afterwards. Nothing exists between operations (no thread, no timer).

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use intely_core::jail::Jail;
use intely_relay_bundle::Http;
use intely_settings::secrets::SecretStore;
use serde::Serialize;

use crate::clock::Clock;
use crate::error::{DeployError, Result};
use crate::gate::{effective_jail, gate, wrangler_bin_override};
use crate::kit::{private_dir, which_in, KitReport, RelayKit};
use crate::keys;
use crate::ops_log::{OpRecord, OpsLog};
use crate::output::{classify, parse_login_url, parse_whoami, Account, ErrorKind, WhoAmI};
use crate::pipeline::{JobState, PreviewRecord};
use crate::plan::{Plan, PlanOp, PlanRequest, PlanStore};
use crate::runner::{LogChunk, OpRunner, RunGuard};
use crate::wrangler::{child_env, pnpm, Base, ChildEnv, EnvVal, Invocation, Line, Op, Outcome, Spawner};
use crate::Secret;

/// How the user signed in: wrangler's OAuth login, or an API token kept in the Keychain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthMode {
    Oauth,
    Token,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthCtx {
    pub mode: AuthMode,
    /// Pinned as `CLOUDFLARE_ACCOUNT_ID` for every Cloudflare operation once the user chose an account.
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Stage,
    Config,
    Deploy,
    Parse,
    Secrets,
    Health,
    Verify,
    Record,
}

pub const STEPS: [Step; 8] = [Step::Stage, Step::Config, Step::Deploy, Step::Parse, Step::Secrets, Step::Health, Step::Verify, Step::Record];

impl Step {
    pub fn index(&self) -> usize {
        STEPS.iter().position(|s| s == self).unwrap_or(0)
    }

    /// Steps that are safe to run again (spec 3.2 step 5): `Retry from this step`.
    pub fn idempotent(&self) -> bool {
        matches!(self, Step::Deploy | Step::Secrets | Step::Health | Step::Verify)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Pending,
    Running,
    Ok,
    Failed,
    Skipped,
}

/// `relay-cloud:state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepEvent {
    pub run_id: String,
    pub step: Step,
    pub status: StepStatus,
    pub code: Option<String>,
}

/// What an operation tells its caller while it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobEvent {
    Step(StepEvent),
    /// One masked output line (also kept in the log ring).
    Log(String),
    /// The `https://dash.cloudflare.com/...` sign-in URL, for display as plain selectable text.
    LoginUrl(String),
}

pub struct Deps {
    pub kit: RelayKit,
    /// `<agents data dir>`; the state lives in `<data_dir>/relay-deploy`.
    pub data_dir: PathBuf,
    pub jail: Jail,
    /// `INTELY_CLOUD=1`: lifts READONLY for the relay tools only.
    pub cloud: bool,
    pub spawner: Arc<dyn Spawner>,
    pub http: Arc<dyn Http>,
    pub clock: Arc<dyn Clock>,
    pub store: Arc<dyn SecretStore>,
    /// Reads a variable of the launching environment (`PATH`, `HOME`, `INTELY_WRANGLER_BIN`, ...).
    pub var: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    pub install_id: String,
}

pub struct Deployer {
    pub(crate) d: Deps,
    pub(crate) root: PathBuf,
    /// The jail with `INTELY_CLOUD` applied (network checks and the gate).
    pub(crate) jail: Jail,
    pub(crate) runner: Arc<OpRunner>,
    pub(crate) ops: OpsLog,
    pub(crate) previews: Mutex<HashMap<String, Arc<PreviewRecord>>>,
    /// The one-time plan nonces of deploy, rollback and remove (`plan.rs`).
    pub(crate) plans: PlanStore,
    pub(crate) last_job: Mutex<Option<JobState>>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A finished child process: the raw lines exist only for in-memory parsing (see `Line`).
pub(crate) struct Exec {
    pub outcome: Outcome,
    pub raw: Vec<String>,
    pub masked: Vec<String>,
}

impl Exec {
    pub fn ok(&self) -> bool {
        self.outcome.ok()
    }

    /// The last 20 masked lines.
    pub fn tail(&self) -> String {
        let from = self.masked.len().saturating_sub(20);
        self.masked[from..].join("\n")
    }

    pub fn raw_text(&self) -> String {
        self.raw.join("\n")
    }

    /// The classified failure of a run that did not succeed.
    pub fn failure(&self) -> DeployError {
        if self.outcome.cancelled {
            return DeployError::coded("cancelled", "stopped");
        }
        if self.outcome.timed_out {
            return DeployError::coded("timeout", self.tail());
        }
        if self.outcome.exit_code == 127 {
            return DeployError::coded("wranglerMissing", "the program could not be started");
        }
        DeployError::coded(classify(&self.masked, self.outcome.exit_code).code(), self.tail())
    }

    pub fn kind(&self) -> ErrorKind {
        classify(&self.masked, self.outcome.exit_code)
    }
}

pub(crate) struct OpMeta<'a> {
    pub worker: &'a str,
    pub account_tail: &'a str,
}

const KEEP_RAW_LINES: usize = 2000;

impl Deployer {
    pub fn new(d: Deps) -> Self {
        let root = d.data_dir.join("relay-deploy");
        let jail = effective_jail(&d.jail, d.cloud);
        let ops = OpsLog::new(&root);
        Self { d, root, jail, runner: OpRunner::new(), ops, previews: Mutex::new(HashMap::new()), plans: PlanStore::new(), last_job: Mutex::new(None) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn runner(&self) -> &Arc<OpRunner> {
        &self.runner
    }

    pub fn ops_log(&self) -> &OpsLog {
        &self.ops
    }

    pub fn kit(&self) -> &RelayKit {
        &self.d.kit
    }

    pub fn stop(&self, run_id: &str) {
        self.runner.stop(run_id);
    }

    pub fn logs(&self, run_id: &str, from_seq: u32) -> Option<LogChunk> {
        self.runner.logs(run_id, from_seq)
    }

    pub(crate) fn path_var(&self) -> String {
        (self.d.var)("PATH").unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".to_owned())
    }

    /// Step 1 of the wizard. Reads `package.json` files and the PATH; spawns nothing.
    pub fn kit_report(&self) -> KitReport {
        self.d.kit.check(&self.path_var())
    }

    /// The wrangler to run: the kit's pinned one, or (E2E jail only, inside the fixture root) the `INTELY_WRANGLER_BIN` seam.
    pub(crate) fn wrangler(&self) -> Result<PathBuf> {
        let var = (self.d.var)("INTELY_WRANGLER_BIN");
        if let Some(p) = wrangler_bin_override(&self.d.jail, var.as_deref()) {
            return Ok(p.to_path_buf());
        }
        self.d.kit.wrangler_bin()
    }

    pub(crate) fn ensure_dirs(&self) -> Result<PathBuf> {
        private_dir(&self.root)?;
        private_dir(&self.root.join("logs"))?;
        let cwd = self.root.join("cwd");
        private_dir(&cwd)?;
        Ok(cwd)
    }

    fn wipe_logs(&self) {
        if let Ok(rd) = fs::read_dir(self.root.join("logs")) {
            for e in rd.flatten() {
                let p = e.path();
                let _ = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
            }
        }
    }

    /// The allow-list environment; `with_account` pins `CLOUDFLARE_ACCOUNT_ID`, token mode adds the token (from the Keychain).
    pub(crate) fn env(&self, auth: &AuthCtx, with_account: bool) -> Result<Vec<(String, EnvVal)>> {
        let token: Option<Secret> = match auth.mode {
            AuthMode::Token => Some(keys::api_token(&*self.d.store)?.ok_or_else(|| DeployError::coded("notLoggedIn", "no API token is stored"))?),
            AuthMode::Oauth => None,
        };
        let var = |k: &str| (self.d.var)(k);
        let account = if with_account { auth.account_id.as_deref() } else { None };
        Ok(child_env(&ChildEnv { var: &var, state_root: &self.root, account_id: account, token: token.as_ref() }))
    }

    /// Runs one invocation: gate, echo line, spawn, collect, wipe wrangler logs, ops log. Raw lines are kept in memory only so the
    /// caller can parse values the masker hides.
    pub(crate) fn exec(&self, guard: &RunGuard, inv: Invocation, meta: &OpMeta, emit: &mut dyn FnMut(JobEvent), mut peek: Option<&mut dyn FnMut(&Line) -> Option<JobEvent>>) -> Result<Exec> {
        let program = PathBuf::from(inv.argv.first().cloned().unwrap_or_default());
        gate(&self.d.jail, inv.op, &program, self.d.cloud)?;
        self.ensure_dirs()?;
        let echo = format!("$ {}", crate::mask::Masker::new(&inv.secrets()).mask(&inv.display()));
        guard.log(&echo);
        emit(JobEvent::Log(echo));
        let started = Instant::now();
        let mut raw: Vec<String> = Vec::new();
        let mut masked: Vec<String> = Vec::new();
        let outcome = self.d.spawner.run(
            &inv,
            &mut |line: &Line| {
                guard.log(line.masked());
                emit(JobEvent::Log(line.masked().to_owned()));
                // An event the caller derives from a line goes out at once (the login URL is needed while wrangler still blocks).
                if let Some(ev) = peek.as_mut().and_then(|p| p(line)) {
                    emit(ev);
                }
                if raw.len() < KEEP_RAW_LINES {
                    raw.push(line.raw_for_parsing().to_owned());
                    masked.push(line.masked().to_owned());
                }
            },
            &|| guard.cancelled(),
        );
        self.wipe_logs();
        let result = Exec { outcome, raw, masked };
        let word = if result.outcome.cancelled {
            "cancelled".to_owned()
        } else if result.ok() {
            "ok".to_owned()
        } else {
            format!("failed:{}", result.failure().code())
        };
        let _ = self.ops.append(&OpRecord {
            ts: self.d.clock.now(),
            op: inv.op.name().to_owned(),
            outcome: word,
            worker: meta.worker.to_owned(),
            account_tail: meta.account_tail.to_owned(),
            exit_code: Some(result.outcome.exit_code),
            duration_ms: started.elapsed().as_millis() as u64,
        });
        Ok(result)
    }

    pub(crate) fn base_cwd(&self) -> Result<PathBuf> {
        self.ensure_dirs()
    }

    /// Prepare: `pnpm install --frozen-lockfile` in both packages, then `pnpm build` in `remote-web`. Downloads packages from the npm
    /// registry; nothing is sent to Cloudflare. Only on a click.
    pub fn prepare(&self, emit: &mut dyn FnMut(JobEvent)) -> Result<()> {
        let guard = self.runner.begin("prepare")?;
        // Not "kitMissing": the kit is there, the tools are not on this app's PATH (the wizard says what to install).
        let path = self.path_var();
        let pnpm_bin = which_in(&path, "pnpm").ok_or_else(|| DeployError::coded("toolMissing", "pnpm was not found on PATH"))?;
        which_in(&path, "node").ok_or_else(|| DeployError::coded("toolMissing", "node was not found on PATH"))?;
        gate(&self.d.jail, Op::Pnpm, &pnpm_bin, self.d.cloud)?;
        let env = self.env(&AuthCtx { mode: AuthMode::Oauth, account_id: None }, false)?;
        let steps: [(&Path, &[&str]); 3] =
            [(&self.d.kit.relay_dir, &["install", "--frozen-lockfile"]), (&self.d.kit.web_dir, &["install", "--frozen-lockfile"]), (&self.d.kit.web_dir, &["build"])];
        for (dir, args) in steps {
            let r = self.exec(&guard, pnpm(&pnpm_bin, dir, args, &env), &OpMeta { worker: "", account_tail: "" }, emit, None)?;
            if !r.ok() {
                return Err(r.failure());
            }
        }
        Ok(())
    }

    /// The explicit `wrangler --version` button: spawns once and checks the answer equals the pinned version.
    pub fn spawn_version(&self, emit: &mut dyn FnMut(JobEvent)) -> Result<String> {
        let guard = self.runner.begin("version")?;
        let wrangler = self.wrangler()?;
        let env = self.env(&AuthCtx { mode: AuthMode::Oauth, account_id: None }, false)?;
        let cwd = self.base_cwd()?;
        let r = self.exec(&guard, Base { wrangler: &wrangler, cwd: &cwd, env: &env }.version(), &OpMeta { worker: "", account_tail: "" }, emit, None)?;
        if !r.ok() {
            return Err(r.failure());
        }
        let found = r.masked.iter().find_map(|l| l.split_whitespace().find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()) && w.contains('.')).map(str::to_owned));
        match found {
            Some(v) if v == self.d.kit.pinned => Ok(v),
            Some(v) => Err(DeployError::coded("wranglerVersion", format!("wrangler reports {v}, {} is pinned", self.d.kit.pinned))),
            None => Err(DeployError::coded("wranglerVersion", "wrangler did not report a version")),
        }
    }

    /// `wrangler login` (or `--device`). The URL goes to the UI as plain text once, if its host is `dash.cloudflare.com`.
    pub fn login(&self, device: bool, emit: &mut dyn FnMut(JobEvent)) -> Result<()> {
        let guard = self.runner.begin("login")?;
        let wrangler = self.wrangler()?;
        let env = self.env(&AuthCtx { mode: AuthMode::Oauth, account_id: None }, false)?;
        let cwd = self.base_cwd()?;
        let inv = Base { wrangler: &wrangler, cwd: &cwd, env: &env }.login(device);
        let mut urls: Vec<String> = Vec::new();
        let r = self.exec(&guard, inv, &OpMeta { worker: "", account_tail: "" }, emit, Some(&mut |l: &Line| {
            let u = parse_login_url(l.raw_for_parsing())?;
            if urls.contains(&u) {
                return None;
            }
            urls.push(u.clone());
            Some(JobEvent::LoginUrl(u))
        }))?;
        if r.ok() {
            Ok(())
        } else {
            Err(r.failure())
        }
    }

    pub fn logout(&self, emit: &mut dyn FnMut(JobEvent)) -> Result<()> {
        let guard = self.runner.begin("logout")?;
        let wrangler = self.wrangler()?;
        let env = self.env(&AuthCtx { mode: AuthMode::Oauth, account_id: None }, false)?;
        let cwd = self.base_cwd()?;
        let r = self.exec(&guard, Base { wrangler: &wrangler, cwd: &cwd, env: &env }.logout(), &OpMeta { worker: "", account_tail: "" }, emit, None)?;
        if r.ok() {
            Ok(())
        } else {
            Err(r.failure())
        }
    }

    /// `wrangler whoami --json`. A non-zero exit that reads as "not authenticated" is a logged-out result, not an error.
    pub fn whoami(&self, auth: &AuthCtx, emit: &mut dyn FnMut(JobEvent)) -> Result<WhoAmI> {
        let guard = self.runner.begin("whoami")?;
        let wrangler = self.wrangler()?;
        let env = self.env(auth, false)?;
        let cwd = self.base_cwd()?;
        let r = self.exec(&guard, Base { wrangler: &wrangler, cwd: &cwd, env: &env }.whoami(), &OpMeta { worker: "", account_tail: "" }, emit, None)?;
        if r.ok() {
            let mut w = parse_whoami(&r.raw_text())?;
            w.chosen_account_id = auth.account_id.clone().filter(|id| w.accounts.iter().any(|a| &a.id == id));
            return Ok(w);
        }
        match r.kind() {
            ErrorKind::NotLoggedIn if !r.outcome.timed_out && !r.outcome.cancelled => Ok(WhoAmI::logged_out()),
            _ if r.outcome.exit_code == 1 && !r.outcome.timed_out && r.masked.is_empty() => Ok(WhoAmI::logged_out()),
            _ => Err(r.failure()),
        }
    }

    pub(crate) fn config_path(&self, worker: &str) -> Result<PathBuf> {
        let p = self.root.join(worker).join("wrangler.jsonc");
        if p.is_file() {
            Ok(p)
        } else {
            Err(DeployError::coded("previewStale", "no generated config exists for this Worker: run Update first"))
        }
    }

    /// The plan for a rollback or a remove: the exact argv, directory and Worker name, held under a one-time nonce. Spawns nothing.
    /// A deploy plan is made from a live preview (`PlanRequest::Deploy`). The Worker needs the generated config a preview wrote.
    pub fn plan(&self, req: &PlanRequest) -> Result<Plan> {
        let now = self.d.clock.now();
        match req {
            PlanRequest::Deploy { preview_id } => {
                let rec = {
                    let mut m = lock(&self.previews);
                    m.retain(|_, r| r.expires_at > now);
                    m.get(preview_id).cloned()
                }
                .ok_or_else(|| DeployError::coded("previewStale", "the review is no longer valid: review again"))?;
                // Re-read from disk: the plan shows what would run now, and it must still be what the review bound.
                let live = self.live(&rec.worker, &rec.account, rec.auth_mode, &rec.staged.pubkey, rec.staged.seq).map_err(|e| match e.code() {
                    "kitMissing" => DeployError::coded("previewStale", "the Worker source changed since the review: review again"),
                    _ => e,
                })?;
                if live.binding != rec.binding {
                    return Err(DeployError::coded("previewStale", "something the review showed has changed since: review again"));
                }
                let plan = Plan {
                    plan_id: String::new(),
                    op: PlanOp::Deploy,
                    worker_name: rec.worker.clone(),
                    account_id_tail: tail4(Some(&rec.account.id)),
                    argv: live.argv,
                    command_line: live.command_line,
                    cwd: self.root.join(&rec.worker).to_string_lossy().into_owned(),
                    env_names: live.env_names,
                    expires_at: 0,
                };
                self.plans.issue(now, plan, Some((preview_id.clone(), rec.binding.clone())))
            }
            PlanRequest::Rollback { worker, auth } => self.plan_cli(now, PlanOp::Rollback, worker, auth, false),
            PlanRequest::Remove { worker, auth, force } => self.plan_cli(now, PlanOp::Remove, worker, auth, *force),
        }
    }

    fn plan_cli(&self, now: u64, op: PlanOp, worker: &str, auth: &AuthCtx, force: bool) -> Result<Plan> {
        let (inv, cwd) = self.cli_invocation(op, worker, auth, force)?;
        let plan = Plan {
            plan_id: String::new(),
            op,
            worker_name: worker.to_owned(),
            account_id_tail: tail4(auth.account_id.as_deref()),
            argv: inv.argv.clone(),
            command_line: inv.display(),
            cwd: cwd.to_string_lossy().into_owned(),
            env_names: inv.env_names(),
            expires_at: 0,
        };
        self.plans.issue(now, plan, None)
    }

    /// The invocation a rollback or remove runs (`cwd` is the Worker's state directory).
    fn cli_invocation(&self, op: PlanOp, worker: &str, auth: &AuthCtx, force: bool) -> Result<(Invocation, PathBuf)> {
        let cfg = self.config_path(worker)?;
        let wrangler = self.wrangler()?;
        let env = self.env(auth, true)?;
        let cwd = self.root.join(worker);
        let base = Base { wrangler: &wrangler, cwd: &cwd, env: &env };
        let inv = match op {
            PlanOp::Rollback => base.rollback(&cfg, worker),
            PlanOp::Remove => base.delete(&cfg, worker, force),
            PlanOp::Deploy => return Err(DeployError::coded("previewStale", "a deploy runs from a review")),
        };
        Ok((inv, cwd))
    }

    /// Runs the planned rollback/remove: the nonce and the typed name must fit the plan still held (spent by this run) and the
    /// invocation built now must equal the planned argv. Fails closed (`previewStale`, `confirmMismatch`) before anything spawns.
    fn run_planned(&self, op: PlanOp, worker: &str, auth: &AuthCtx, confirm_name: &str, plan_id: &str, force: bool, emit: &mut dyn FnMut(JobEvent)) -> Result<()> {
        let guard = self.runner.begin(op.name())?;
        let (inv, _cwd) = self.cli_invocation(op, worker, auth, force)?;
        let plan = self.plans.redeem(self.d.clock.now(), plan_id, op, confirm_name, None)?;
        if plan.worker_name != worker || plan.argv != inv.argv {
            return Err(DeployError::coded("previewStale", "the command changed since the plan: review again"));
        }
        let tail = tail4(auth.account_id.as_deref());
        let r = self.exec(&guard, inv, &OpMeta { worker, account_tail: &tail }, emit, None)?;
        if r.ok() {
            Ok(())
        } else {
            Err(r.failure())
        }
    }

    /// `wrangler rollback` behind a plan nonce and the typed Worker name.
    pub fn rollback(&self, worker: &str, auth: &AuthCtx, confirm_name: &str, plan_id: &str, emit: &mut dyn FnMut(JobEvent)) -> Result<()> {
        self.run_planned(PlanOp::Rollback, worker, auth, confirm_name, plan_id, false, emit)
    }

    /// `wrangler delete` behind a plan nonce and the typed Worker name. `force` is true only when `wrangler delete --help` lists
    /// `--force`. The button stays hidden until the manual plan M8 passed; the Durable Object data is not claimed to be deleted.
    pub fn remove(&self, worker: &str, auth: &AuthCtx, confirm_name: &str, plan_id: &str, force: bool, emit: &mut dyn FnMut(JobEvent)) -> Result<()> {
        self.run_planned(PlanOp::Remove, worker, auth, confirm_name, plan_id, force, emit)?;
        self.plans.forget_worker(worker);
        Ok(())
    }

    /// The three `secret put` calls (value on stdin, never argv). Returns the first failure after trying nothing further.
    pub fn put_vapid_secrets(&self, worker: &str, host: &str, auth: &AuthCtx, emit: &mut dyn FnMut(JobEvent)) -> Result<()> {
        let guard = self.runner.begin("vapidPush")?;
        // A rotated pair reaches the relay with the redeploy that carries its public key (the phone reads it from the bundle).
        if keys::staged_vapid(&*self.d.store)?.is_some() {
            return Err(DeployError::coded("rotationPending", "a push key rotation is waiting for its redeploy"));
        }
        let cfg = self.config_path(worker)?;
        let (private, public) = keys::vapid(&*self.d.store)?.ok_or_else(|| DeployError::coded("secretFailed", "no VAPID key was generated"))?;
        self.secrets_run(&guard, worker, &cfg, host, auth, &private, &public, emit)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn secrets_run(&self, guard: &RunGuard, worker: &str, cfg: &Path, host: &str, auth: &AuthCtx, private: &Secret, public: &str, emit: &mut dyn FnMut(JobEvent)) -> Result<()> {
        let wrangler = self.wrangler()?;
        let env = self.env(auth, true)?;
        let cwd = self.root.join(worker);
        let tail = tail4(auth.account_id.as_deref());
        let items: [(&str, Secret); 3] = [
            ("VAPID_PRIVATE_KEY", private.clone()),
            ("VAPID_PUBLIC_KEY", Secret::new(public)),
            ("VAPID_SUBJECT", Secret::new(format!("https://{host}/"))),
        ];
        for (key, value) in items {
            let inv = Base { wrangler: &wrangler, cwd: &cwd, env: &env }.secret_put(cfg, worker, key, value);
            let r = self.exec(guard, inv, &OpMeta { worker, account_tail: &tail }, emit, None)?;
            if !r.ok() {
                let e = r.failure();
                return Err(DeployError::coded("secretFailed", format!("{}: {}", e.code(), r.tail())));
            }
        }
        Ok(())
    }

    /// Accounts for the wizard's choice step (re-exported helper).
    pub fn resolve_account(who: &WhoAmI, chosen: Option<&str>, manual_id: Option<&str>) -> Result<Account> {
        who.resolve_account(chosen, manual_id)
    }
}

pub(crate) fn tail4(id: Option<&str>) -> String {
    id.map(crate::output::account_tail).unwrap_or_default()
}

/// 128 random bits as hex, from the OS source.
pub(crate) fn random_hex(bytes: usize) -> Result<String> {
    let mut buf = vec![0u8; bytes];
    fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).map_err(|e| DeployError::Io(format!("no random source: {e}")))?;
    Ok(hex::encode(buf))
}
