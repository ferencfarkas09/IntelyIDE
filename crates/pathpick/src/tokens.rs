//! One-time, purpose-bound path tokens ((design notes: workspaces-spec) 5.6).
//!
//! 32 lowercase hex characters (a v4 UUID), five minutes, single redeem, at most 256 outstanding (oldest evicted). A
//! wrong purpose is an error that does not consume the token. Tokens never leave the process and are not logged.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use intely_core::EngineError;

use crate::types::{codes, Picked};
use crate::validate::{err, Purpose, Validated, Validator};

pub const TTL_MS: u64 = 5 * 60 * 1000;
pub const MAX_OUTSTANDING: usize = 256;
const GRAVE: usize = 1024;

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }
}

/// A settable clock for tests.
#[derive(Default)]
pub struct FakeClock(AtomicU64);

impl FakeClock {
    pub fn new(ms: u64) -> Self {
        Self(AtomicU64::new(ms))
    }

    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Entry {
    validated: Validated,
    purpose: Purpose,
    issued_ms: u64,
}

#[derive(Default)]
struct Table {
    live: HashMap<String, Entry>,
    order: VecDeque<String>,
    used: HashSet<String>,
    expired: HashSet<String>,
    grave_order: VecDeque<String>,
}

impl Table {
    fn bury(&mut self, token: String, used: bool) {
        if used {
            self.used.insert(token.clone());
        } else {
            self.expired.insert(token.clone());
        }
        self.grave_order.push_back(token);
        while self.grave_order.len() > GRAVE {
            if let Some(old) = self.grave_order.pop_front() {
                self.used.remove(&old);
                self.expired.remove(&old);
            }
        }
    }
}

pub struct PathTokens {
    table: Mutex<Table>,
    clock: Arc<dyn Clock>,
}

/// What a successful redeem hands to the caller (the registration code).
pub struct Redeemed {
    /// Freshly re-validated (same identity as at issue time).
    pub validated: Validated,
    pub purpose: Purpose,
}

impl Default for PathTokens {
    fn default() -> Self {
        Self::new()
    }
}

impl PathTokens {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(SystemClock))
    }

    pub fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self { table: Mutex::new(Table::default()), clock }
    }

    pub fn outstanding(&self) -> usize {
        let mut t = self.table.lock().unwrap();
        self.sweep(&mut t);
        t.live.len()
    }

    fn sweep(&self, t: &mut Table) {
        let now = self.clock.now_ms();
        let stale: Vec<String> =
            t.live.iter().filter(|(_, e)| now.saturating_sub(e.issued_ms) > TTL_MS).map(|(k, _)| k.clone()).collect();
        for k in stale {
            t.live.remove(&k);
            t.order.retain(|o| o != &k);
            t.bury(k, false);
        }
    }

    /// Issues a token for `v` (and one for its `root`, if any) and returns the wire value.
    pub fn issue(&self, v: Validated, purpose: &Purpose) -> Picked {
        let root = v.root.clone().map(|r| Box::new(self.issue(*r, purpose)));
        let token = uuid::Uuid::new_v4().simple().to_string();
        let picked = to_picked(&v, token.clone(), root);
        let mut t = self.table.lock().unwrap();
        self.sweep(&mut t);
        while t.live.len() >= MAX_OUTSTANDING {
            match t.order.pop_front() {
                Some(old) => {
                    t.live.remove(&old);
                    t.bury(old, false);
                }
                None => break,
            }
        }
        t.order.push_back(token.clone());
        t.live.insert(token, Entry { validated: v, purpose: purpose.clone(), issued_ms: self.clock.now_ms() });
        picked
    }

    /// Looks a token up without consuming it (the dialog's start folder, the `git init` pre-checks).
    pub fn peek(&self, token: &str) -> Option<(Validated, Purpose)> {
        let mut t = self.table.lock().unwrap();
        self.sweep(&mut t);
        t.live.get(token).map(|e| (e.validated.clone(), e.purpose.clone()))
    }

    /// Consumes `token` if it was issued for one of `purposes`, then re-validates its path.
    pub fn redeem(&self, token: &str, purposes: &[Purpose], validator: &Validator) -> Result<Redeemed, EngineError> {
        let entry = {
            let mut t = self.table.lock().unwrap();
            self.sweep(&mut t);
            match t.live.get(token) {
                None => {
                    return Err(if t.used.contains(token) {
                        err(codes::TOKEN_USED, "that choice was already used")
                    } else if t.expired.contains(token) {
                        err(codes::TOKEN_EXPIRED, "that choice expired")
                    } else {
                        err(codes::PATH_NOT_VALIDATED, "that folder was not chosen through the picker")
                    })
                }
                Some(e) if !purposes.contains(&e.purpose) => {
                    return Err(err(codes::WRONG_PURPOSE, "that folder was chosen for another purpose"))
                }
                Some(_) => {}
            }
            t.order.retain(|o| o != token);
            let e = t.live.remove(token).expect("checked above");
            t.bury(token.to_owned(), true);
            e
        };
        let validated = validator.revalidate(&entry.validated, &entry.purpose)?;
        Ok(Redeemed { validated, purpose: entry.purpose })
    }
}

pub fn to_picked(v: &Validated, token: String, root: Option<Box<Picked>>) -> Picked {
    Picked {
        token,
        path: v.path.to_string_lossy().into_owned(),
        name: v.name.clone(),
        kind: v.kind.clone(),
        identity: v.identity.clone(),
        root,
        main: v.main.clone(),
        warnings: v.warnings.clone(),
        config_risks: v.config_risks.clone(),
        remotes: v.remotes.clone(),
        branch: v.branch.clone(),
        detached: v.detached,
        protected_folder: v.protected_folder.clone(),
        via_symlink: v.via_symlink,
        gitfile_target: v.gitfile_target.clone(),
    }
}
