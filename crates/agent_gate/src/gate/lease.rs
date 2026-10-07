//! Lease-based slots (providers-plan 5.6). `acquire` hands out a lease with a TTL and registers the agent's
//! process groups as they are spawned (`renew` carries `pgids`; `heartbeat` renews all leases of one owner). When
//! renewals stop for a TTL, the owner (the sidecar) is gone or its pipe closed, Rust reclaims the lease and kills
//! the registered groups itself (SIGTERM, grace, SIGKILL), so a crashed sidecar never leaks a slot or an orphan CLI.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use libc::pid_t;
use serde::{Deserialize, Serialize};

use super::cancel::{terminate_group, usable_pgid, TermOutcome};
use super::orphans::OrphanRegistry;
use super::procinfo::ProcKey;
use super::rss::{self, TreeRss};

#[derive(Debug, Clone)]
pub struct GateConfig {
    /// Cap of live agents across all providers (PLAN: 3).
    pub max_agents: usize,
    /// Per-provider cap; providers not listed fall back to `max_agents`.
    pub max_per_provider: Vec<(String, usize)>,
    /// At most this many leases with `writer: true` (PLAN: 2).
    pub max_writers: usize,
    /// Combined tree-RSS budget: a start is admitted if `sum(current tree RSS) + request budget <= this`.
    pub rss_budget_bytes: u64,
    pub default_ttl: Duration,
    /// Time between SIGTERM and SIGKILL when the gate reclaims a lease.
    pub term_grace: Duration,
}

impl Default for GateConfig {
    fn default() -> Self {
        Self {
            max_agents: 3,
            max_per_provider: vec![("claude".into(), 3)],
            max_writers: 2,
            rss_budget_bytes: 1536 * 1024 * 1024,
            default_ttl: Duration::from_secs(15),
            term_grace: Duration::from_secs(3),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdmissionKind {
    NoSlot,
    RssBudget,
    WriteLease,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{kind:?}: {detail}")]
pub struct AdmissionError {
    #[serde(rename = "error")]
    pub kind: AdmissionKind,
    pub detail: String,
}

impl AdmissionError {
    fn new(kind: AdmissionKind, detail: impl Into<String>) -> Self {
        Self { kind, detail: detail.into() }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireReq {
    pub agent_id: String,
    pub provider: String,
    #[serde(default)]
    pub writer: bool,
    #[serde(default)]
    pub repo_id: Option<String>,
    /// Who renews this lease (the sidecar); see [`Gate::register_owner`].
    pub owner: String,
    #[serde(default)]
    pub ttl_ms: Option<u64>,
    /// Expected tree RSS of this provider in MB, reserved until the first process group is registered.
    #[serde(default)]
    pub rss_budget_mb: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub lease_id: String,
    pub ttl_ms: u64,
    pub tree_budget_mb: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReclaimReason {
    Expired,
    OwnerGone,
    OwnerClosed,
    Idle,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reclaimed {
    pub lease_id: String,
    pub agent_id: String,
    pub provider: String,
    pub repo_id: Option<String>,
    pub writer: bool,
    pub reason: ReclaimReason,
    pub pgids: Vec<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseInfo {
    pub lease_id: String,
    pub agent_id: String,
    pub provider: String,
    pub repo_id: Option<String>,
    pub writer: bool,
    pub owner: String,
    pub pgids: Vec<i32>,
    pub busy: bool,
    pub idle_ms: u64,
    pub expires_in_ms: u64,
    pub tree_rss_mb: u64,
    pub tree_procs: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewOk {
    pub ttl_ms: u64,
    /// Group ids that were not registered: pgid <= 1 or the gate's own process group.
    pub rejected_pgids: Vec<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RenewError {
    #[error("unknown or reclaimed lease {0}")]
    UnknownLease(String),
}

struct LeaseState {
    id: String,
    req: AcquireReq,
    ttl: Duration,
    expires: Instant,
    pgids: BTreeSet<pid_t>,
    /// Groups of processes below the registered ones (tool commands run in groups of their own); found by the
    /// reaper, killed with the lease and recorded for the startup sweep.
    tree_pgids: BTreeSet<pid_t>,
    last_activity: Instant,
    busy: bool,
}

struct Owner {
    key: Option<ProcKey>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    leases: Vec<LeaseState>,
    owners: Vec<(String, Owner)>,
}

type Listener = Box<dyn Fn(&Reclaimed) + Send + Sync>;

pub struct Gate {
    cfg: GateConfig,
    state: Mutex<State>,
    kills: Mutex<Vec<JoinHandle<TermOutcome>>>,
    listener: Mutex<Option<Listener>>,
    orphans: Option<Arc<OrphanRegistry>>,
}

impl Gate {
    pub fn new(cfg: GateConfig) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            state: Mutex::new(State::default()),
            kills: Mutex::new(Vec::new()),
            listener: Mutex::new(None),
            orphans: None,
        })
    }

    /// Also records every registered process group in the orphan state file (`gate.json`).
    pub fn with_orphans(cfg: GateConfig, orphans: Arc<OrphanRegistry>) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            state: Mutex::new(State::default()),
            kills: Mutex::new(Vec::new()),
            listener: Mutex::new(None),
            orphans: Some(orphans),
        })
    }

    pub fn config(&self) -> &GateConfig {
        &self.cfg
    }

    /// Called (from the sweeping thread) for every lease the gate reclaims on its own, so the adapter side can
    /// emit its single `turn.end` and the UI can show why the agent stopped.
    pub fn on_reclaim(&self, f: impl Fn(&Reclaimed) + Send + Sync + 'static) {
        *lock(&self.listener) = Some(Box::new(f));
    }

    /// Registers a lease owner. With a `pid` the gate also notices when that process dies (pid reuse safe).
    pub fn register_owner(&self, owner: &str, pid: Option<pid_t>) {
        let key = pid.and_then(ProcKey::of);
        let mut st = lock(&self.state);
        st.owners.retain(|(id, _)| id != owner);
        st.owners.push((owner.to_string(), Owner { key }));
    }

    pub fn acquire(&self, req: AcquireReq) -> Result<Lease, AdmissionError> {
        let ttl = req.ttl_ms.map(Duration::from_millis).unwrap_or(self.cfg.default_ttl);
        let mut st = lock(&self.state);
        if req.writer {
            let Some(repo) = req.repo_id.as_deref() else {
                return Err(AdmissionError::new(AdmissionKind::WriteLease, "a writer needs a repoId"));
            };
            if let Some(held) = st.leases.iter().find(|l| l.req.writer && l.req.repo_id.as_deref() == Some(repo)) {
                return Err(AdmissionError::new(
                    AdmissionKind::WriteLease,
                    format!("repo {repo} is already being written by agent {}", held.req.agent_id),
                ));
            }
        }
        if let Some(held) = st.leases.iter().find(|l| l.req.agent_id == req.agent_id) {
            return Err(AdmissionError::new(AdmissionKind::NoSlot, format!("agent {} already holds lease {}", req.agent_id, held.id)));
        }
        if st.leases.len() >= self.cfg.max_agents {
            return Err(AdmissionError::new(AdmissionKind::NoSlot, format!("{} agents are running (cap {})", st.leases.len(), self.cfg.max_agents)));
        }
        let provider_cap = self.cfg.max_per_provider.iter().find(|(p, _)| *p == req.provider).map_or(self.cfg.max_agents, |(_, n)| *n);
        let provider_live = st.leases.iter().filter(|l| l.req.provider == req.provider).count();
        if provider_live >= provider_cap {
            return Err(AdmissionError::new(AdmissionKind::NoSlot, format!("{provider_live} {} agents are running (cap {provider_cap})", req.provider)));
        }
        if req.writer {
            let writers = st.leases.iter().filter(|l| l.req.writer).count();
            if writers >= self.cfg.max_writers {
                return Err(AdmissionError::new(AdmissionKind::NoSlot, format!("{writers} writers are running (cap {})", self.cfg.max_writers)));
            }
        }
        let used: u64 = st.leases.iter().map(|l| committed_bytes(l)).sum();
        let want = req.rss_budget_mb * 1024 * 1024;
        if used + want > self.cfg.rss_budget_bytes {
            return Err(AdmissionError::new(
                AdmissionKind::RssBudget,
                format!("{} MB in use + {} MB requested exceeds the {} MB budget", used >> 20, req.rss_budget_mb, self.cfg.rss_budget_bytes >> 20),
            ));
        }
        st.next_id += 1;
        let id = format!("L{}", st.next_id);
        if !st.owners.iter().any(|(o, _)| *o == req.owner) {
            st.owners.push((req.owner.clone(), Owner { key: None }));
        }
        let now = Instant::now();
        let budget = req.rss_budget_mb;
        st.leases.push(LeaseState { id: id.clone(), req, ttl, expires: now + ttl, pgids: BTreeSet::new(), tree_pgids: BTreeSet::new(), last_activity: now, busy: false });
        Ok(Lease { lease_id: id, ttl_ms: ttl.as_millis() as u64, tree_budget_mb: budget })
    }

    /// Flips the writer flag of a live lease (a live mode switch, permission-modes spec 5.6). `writer = false` always succeeds and
    /// frees the slot; `writer = true` applies the writer admission of [`Self::acquire`] (one writer per repository, `max_writers`),
    /// excluding the lease itself, and takes `repo_id` when the lease has none. Nothing changes on an error.
    pub fn set_writer(&self, lease_id: &str, writer: bool, repo_id: Option<&str>) -> Result<(), AdmissionError> {
        let mut st = lock(&self.state);
        let Some(i) = st.leases.iter().position(|l| l.id == lease_id) else {
            return Err(AdmissionError::new(AdmissionKind::NoSlot, format!("unknown or reclaimed lease {lease_id}")));
        };
        if !writer {
            st.leases[i].req.writer = false;
            return Ok(());
        }
        if st.leases[i].req.writer {
            return Ok(());
        }
        let Some(repo) = repo_id.map(str::to_owned).or_else(|| st.leases[i].req.repo_id.clone()) else {
            return Err(AdmissionError::new(AdmissionKind::WriteLease, "a writer needs a repoId"));
        };
        if let Some(held) = st.leases.iter().enumerate().find(|(j, l)| *j != i && l.req.writer && l.req.repo_id.as_deref() == Some(repo.as_str())) {
            return Err(AdmissionError::new(AdmissionKind::WriteLease, format!("repo {repo} is already being written by agent {}", held.1.req.agent_id)));
        }
        let writers = st.leases.iter().enumerate().filter(|(j, l)| *j != i && l.req.writer).count();
        if writers >= self.cfg.max_writers {
            return Err(AdmissionError::new(AdmissionKind::NoSlot, format!("{writers} writers are running (cap {})", self.cfg.max_writers)));
        }
        st.leases[i].req.writer = true;
        st.leases[i].req.repo_id = Some(repo);
        Ok(())
    }

    /// Extends the lease by one TTL and registers newly spawned process groups.
    pub fn renew(&self, lease_id: &str, pgids: &[i32]) -> Result<RenewOk, RenewError> {
        let mut st = lock(&self.state);
        let lease = st.leases.iter_mut().find(|l| l.id == lease_id).ok_or_else(|| RenewError::UnknownLease(lease_id.into()))?;
        lease.expires = Instant::now() + lease.ttl;
        let mut rejected = Vec::new();
        let mut added = Vec::new();
        for &g in pgids {
            if !usable_pgid(g) {
                rejected.push(g);
            } else if lease.pgids.insert(g) {
                added.push(g);
            }
        }
        let (ttl_ms, agent) = (lease.ttl.as_millis() as u64, lease.req.agent_id.clone());
        drop(st);
        if let Some(orphans) = &self.orphans {
            for g in added {
                if let Err(e) = orphans.record(g, lease_id, &agent) {
                    eprintln!("agent_gate: cannot record pgid {g} in the orphan file: {e}");
                }
            }
        }
        Ok(RenewOk { ttl_ms, rejected_pgids: rejected })
    }

    /// Renews every lease of `owner` (the sidecar heartbeat). Returns how many were renewed.
    pub fn heartbeat(&self, owner: &str) -> usize {
        let now = Instant::now();
        let mut st = lock(&self.state);
        let mut n = 0;
        for l in st.leases.iter_mut().filter(|l| l.req.owner == owner) {
            l.expires = now + l.ttl;
            n += 1;
        }
        n
    }

    /// Normal end of a run: frees the slot without killing anything.
    pub fn release(&self, lease_id: &str) -> bool {
        let removed = {
            let mut st = lock(&self.state);
            st.leases.iter().position(|l| l.id == lease_id).map(|i| st.leases.remove(i))
        };
        match removed {
            Some(l) => {
                self.forget_groups(l.pgids.iter().copied());
                true
            }
            None => false,
        }
    }

    /// Marks activity (an event arrived); resets the idle clock.
    pub fn touch(&self, lease_id: &str) {
        if let Some(l) = lock(&self.state).leases.iter_mut().find(|l| l.id == lease_id) {
            l.last_activity = Instant::now();
        }
    }

    /// A running turn is never idle.
    pub fn set_busy(&self, lease_id: &str, busy: bool) {
        if let Some(l) = lock(&self.state).leases.iter_mut().find(|l| l.id == lease_id) {
            l.busy = busy;
            l.last_activity = Instant::now();
        }
    }

    pub fn lease_pgids(&self, lease_id: &str) -> Vec<i32> {
        lock(&self.state).leases.iter().find(|l| l.id == lease_id).map(|l| l.pgids.iter().copied().collect()).unwrap_or_default()
    }

    pub fn has_lease(&self, lease_id: &str) -> bool {
        lock(&self.state).leases.iter().any(|l| l.id == lease_id)
    }

    /// The owner's pipe closed or the sidecar exited: reclaim everything it held right away.
    pub fn owner_closed(&self, owner: &str) -> Vec<Reclaimed> {
        let ids: Vec<String> = lock(&self.state).leases.iter().filter(|l| l.req.owner == owner).map(|l| l.id.clone()).collect();
        lock(&self.state).owners.retain(|(o, _)| o != owner);
        ids.iter().filter_map(|id| self.reclaim(id, ReclaimReason::OwnerClosed)).collect()
    }

    /// One pass of the reaper: reclaims expired leases and leases whose owner process died.
    pub fn sweep(&self) -> Vec<Reclaimed> {
        self.track_trees();
        let now = Instant::now();
        let due: Vec<(String, ReclaimReason)> = {
            let st = lock(&self.state);
            st.leases
                .iter()
                .filter_map(|l| {
                    let owner_dead = st.owners.iter().find(|(o, _)| *o == l.req.owner).and_then(|(_, o)| o.key).is_some_and(|k| !k.is_alive());
                    if owner_dead {
                        Some((l.id.clone(), ReclaimReason::OwnerGone))
                    } else if l.expires <= now {
                        Some((l.id.clone(), ReclaimReason::Expired))
                    } else {
                        None
                    }
                })
                .collect()
        };
        due.into_iter().filter_map(|(id, why)| self.reclaim(&id, why)).collect()
    }

    /// Registers the process groups below each lease's groups, so a reclaim or the next startup's sweep reaches them
    /// even after their parents are gone.
    fn track_trees(&self) {
        let snapshot: Vec<(String, String, Vec<pid_t>)> =
            lock(&self.state).leases.iter().filter(|l| !l.pgids.is_empty()).map(|l| (l.id.clone(), l.req.agent_id.clone(), l.pgids.iter().copied().collect())).collect();
        for (id, agent, pgids) in snapshot {
            let found = rss::descendant_pgids(&pgids);
            let added: Vec<pid_t> = {
                let mut st = lock(&self.state);
                let Some(l) = st.leases.iter_mut().find(|l| l.id == id) else { continue };
                found.into_iter().filter(|g| usable_pgid(*g) && l.tree_pgids.insert(*g)).collect()
            };
            if let Some(orphans) = &self.orphans {
                for g in added {
                    let _ = orphans.record(g, &id, &agent);
                }
            }
        }
    }

    /// Removes the lease and terminates its registered groups on background threads (SIGTERM, grace, SIGKILL).
    pub fn reclaim(&self, lease_id: &str, reason: ReclaimReason) -> Option<Reclaimed> {
        let l = {
            let mut st = lock(&self.state);
            let i = st.leases.iter().position(|l| l.id == lease_id)?;
            st.leases.remove(i)
        };
        let pgids: Vec<i32> = l.pgids.iter().copied().collect();
        // Snapshot the trees before anything is signalled: once a parent dies its children are reparented and lost.
        let mut below = rss::descendant_pgids(&pgids);
        let tracked: Vec<pid_t> = l.tree_pgids.iter().copied().filter(|g| !pgids.contains(g) && !below.contains(g)).collect();
        below.extend(tracked);
        let grace = self.cfg.term_grace;
        let mut kills = lock(&self.kills);
        kills.retain(|h| !h.is_finished());
        for &g in pgids.iter().chain(&below) {
            kills.push(std::thread::spawn(move || terminate_group(g, grace)));
        }
        drop(kills);
        self.forget_groups(pgids.iter().chain(&below).copied());
        let out = Reclaimed {
            lease_id: l.id,
            agent_id: l.req.agent_id,
            provider: l.req.provider,
            repo_id: l.req.repo_id,
            writer: l.req.writer,
            reason,
            pgids,
        };
        if let Some(f) = lock(&self.listener).as_ref() {
            f(&out);
        }
        Some(out)
    }

    /// Ids of leases that have been idle (no turn running, no activity) for at least `threshold`.
    pub fn idle_leases(&self, threshold: Duration) -> Vec<String> {
        let now = Instant::now();
        lock(&self.state).leases.iter().filter(|l| !l.busy && now.duration_since(l.last_activity) >= threshold).map(|l| l.id.clone()).collect()
    }

    /// Waits for the termination threads started by reclaims (shutdown and tests). `true` when all finished.
    pub fn join_kills(&self) -> bool {
        let handles: Vec<_> = lock(&self.kills).drain(..).collect();
        handles.into_iter().all(|h| h.join().is_ok())
    }

    pub fn live_count(&self) -> usize {
        lock(&self.state).leases.len()
    }

    /// Current tree RSS over all leases.
    pub fn total_tree_rss(&self) -> TreeRss {
        let pgids: Vec<pid_t> = lock(&self.state).leases.iter().flat_map(|l| l.pgids.iter().copied()).collect();
        rss::tree_rss(&pgids, &pgids)
    }

    pub fn leases(&self) -> Vec<LeaseInfo> {
        let now = Instant::now();
        let st = lock(&self.state);
        st.leases
            .iter()
            .map(|l| {
                let pgids: Vec<i32> = l.pgids.iter().copied().collect();
                let tree = rss::tree_rss(&pgids, &pgids);
                LeaseInfo {
                    lease_id: l.id.clone(),
                    agent_id: l.req.agent_id.clone(),
                    provider: l.req.provider.clone(),
                    repo_id: l.req.repo_id.clone(),
                    writer: l.req.writer,
                    owner: l.req.owner.clone(),
                    pgids,
                    busy: l.busy,
                    idle_ms: now.duration_since(l.last_activity).as_millis() as u64,
                    expires_in_ms: l.expires.saturating_duration_since(now).as_millis() as u64,
                    tree_rss_mb: tree.mb(),
                    tree_procs: tree.procs,
                }
            })
            .collect()
    }

    fn forget_groups(&self, pgids: impl Iterator<Item = pid_t>) {
        if let Some(orphans) = &self.orphans {
            for g in pgids {
                let _ = orphans.forget(g);
            }
        }
    }
}

/// What a lease counts against the budget: its measured tree, or its reservation while it has no live process yet.
fn committed_bytes(l: &LeaseState) -> u64 {
    let pgids: Vec<pid_t> = l.pgids.iter().copied().collect();
    let measured = rss::tree_rss(&pgids, &pgids);
    if measured.procs == 0 {
        l.req.rss_budget_mb * 1024 * 1024
    } else {
        measured.bytes
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
