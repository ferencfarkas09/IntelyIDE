//! Role groups ((design notes: roles-orchestration-spec) 3.2, 3.2a): all copies of one name (the global file, the copies the
//! `_claude-team` sync put into repositories, the built-in of that name) are ONE group with a winner. The winner rule,
//! the trust gate for repository copies, pin, hide and resolve live here; the groups are a view, `list()` still returns
//! one `Role` per file.

use std::collections::BTreeMap;

use intely_agent_host::roles::RoleDef;
use intely_agent_host::RepoRef;

use crate::store::{diff_fields, group_key, is_reserved, role_effort_of, role_permission, Overlay, RoleError, RoleStore, Snapshot};
use crate::types::{DelegateStatus, ExcludeReason, PermissionMismatch, PermissionSource, Role, RoleCopy, RoleDrift, RoleGroup, RoleScope, RoleTrust, RolesStatus, WinnerReason};

/// At most this many delegates per run (the alphabetically last groups are `TooMany`).
pub const MAX_DELEGATES: usize = 24;
/// A delegate prompt above this is not passed to the lead.
pub const MAX_DELEGATE_PROMPT: usize = 64 * 1024;

fn err(code: &'static str, message: impl Into<String>) -> RoleError {
    RoleError { code, message: message.into() }
}

/// The synthetic role of a host built-in (no file).
fn builtin_role(def: &RoleDef) -> Role {
    let writable = def.permission != intely_agent_core::providers::PermissionMode::ReadOnly;
    Role {
        id: def.name.clone(),
        name: def.name.clone(),
        description: Some(def.description.clone()).filter(|d| !d.is_empty()),
        model: def.model.clone(),
        effort: def.effort.map(role_effort_of),
        effort_available: crate::store::effort_available(&def.provider, &def.model),
        tools: def.tools.clone(),
        system_prompt: def.system_prompt.clone(),
        scope: RoleScope::Global,
        permission: role_permission(def.permission),
        provider: def.provider.clone(),
        permission_source: PermissionSource::Default,
        permission_reason: Some("builtin".into()),
        max_turns: def.max_turns,
        builtin: true,
        can_edit: writable,
        can_run: writable,
        trust: RoleTrust::Trusted,
        ..Role::default()
    }
}

fn pin_matches(pin: &str, r: &Role) -> bool {
    match pin.strip_prefix("repo:") {
        Some(id) => r.scope == RoleScope::Repo && r.repo_id.as_deref() == Some(id),
        None => pin == "global" && r.scope == RoleScope::Global,
    }
}

impl RoleStore {
    /// One group per name (case-insensitive), sorted by name, over every registered repository.
    pub fn groups(&self, repos: &[RepoRef]) -> Vec<RoleGroup> {
        let snap = self.snapshot(repos);
        self.build_groups(&snap, None, None)
    }

    /// The groups a RUN may use: the global copies plus the copies of `run_repo_ids` only (3.2a point 4). The first run
    /// repository is the primary one for the winner rule; the repo-scope check of a role applies.
    pub fn groups_for_run(&self, run_repo_ids: &[String], repos: &[RepoRef]) -> Vec<RoleGroup> {
        let snap = self.snapshot(repos);
        self.build_groups(&snap, Some(run_repo_ids), run_repo_ids.first().map(String::as_str))
    }

    pub(crate) fn build_groups(&self, snap: &Snapshot, run: Option<&[String]>, primary: Option<&str>) -> Vec<RoleGroup> {
        let in_scope = |r: &Role| run.is_none_or(|ids| r.scope == RoleScope::Global || r.repo_id.as_ref().is_some_and(|id| ids.contains(id)));
        let mut order: Vec<String> = Vec::new();
        let mut by_name: BTreeMap<String, Vec<&Role>> = BTreeMap::new();
        for r in snap.roles.iter().filter(|r| in_scope(r)) {
            let key = r.name.to_ascii_lowercase();
            if !order.contains(&key) {
                order.push(key.clone());
            }
            by_name.entry(key).or_default().push(r);
        }
        for (name, def) in &self.builtins {
            let key = name.to_ascii_lowercase();
            if def.as_ref().is_some_and(|d| d.provider == "claude") && !by_name.contains_key(&key) {
                by_name.insert(key.clone(), Vec::new());
                order.push(key);
            }
        }
        let mut groups: Vec<RoleGroup> = by_name.iter().map(|(key, copies)| self.build_group(key, copies, &snap.overlay, primary)).collect();
        groups.sort_by_key(|g| g.name.to_ascii_lowercase());
        // delegate status: the checks that need the run, then the cap (the alphabetically last are the extras)
        let mut included = 0usize;
        for g in &mut groups {
            let mut status = delegate_status(g, run);
            if status.ok {
                included += 1;
                if included > MAX_DELEGATES {
                    status = DelegateStatus { ok: false, reason: Some(ExcludeReason::TooMany) };
                }
            }
            g.delegate = status;
        }
        groups
    }

    fn build_group(&self, key: &str, copies: &[&Role], overlay: &BTreeMap<String, Overlay>, primary: Option<&str>) -> RoleGroup {
        let name = copies.first().map_or_else(|| self.builtins.iter().find(|(n, _)| n.eq_ignore_ascii_case(key)).map_or(key.to_string(), |(n, _)| n.clone()), |r| r.name.clone());
        let ov = overlay.get(&group_key(overlay, &name)).cloned().unwrap_or_default();
        let builtin = self.builtin_def(&name).filter(|d| d.provider == "claude").map(builtin_role);
        let usable: Vec<&Role> = copies.iter().copied().filter(|r| !r.shadowed_by_duplicate).collect();
        let eligible: Vec<&Role> = usable.iter().copied().filter(|r| r.trust != RoleTrust::Untrusted).collect();
        // a pin names a usable copy; one that vanished or is untrusted is ignored (and reported)
        let pinned: Option<&Role> = ov.pin.as_deref().and_then(|p| eligible.iter().copied().find(|r| pin_matches(p, r)));
        let pin_missing = ov.pin.is_some() && pinned.is_none();
        let all_same = usable.windows(2).all(|w| w[0].content_hash == w[1].content_hash);
        let conflict = pinned.is_none() && !all_same;

        let (winner, reason): (Option<&Role>, WinnerReason) = if let Some(p) = pinned {
            (Some(p), WinnerReason::Pinned)
        } else if eligible.is_empty() && builtin.is_some() {
            (None, WinnerReason::BuiltIn)
        } else {
            let pool: &[&Role] = if eligible.is_empty() { &usable } else { &eligible };
            let global = pool.iter().copied().find(|r| r.scope == RoleScope::Global);
            let first_repo = pool.first().copied();
            let pick = if usable.len() == 1 || all_same {
                global.or(first_repo)
            } else if global.is_some() {
                global
            } else {
                primary.and_then(|p| pool.iter().copied().find(|r| r.repo_id.as_deref() == Some(p))).or(first_repo)
            };
            let reason = match pick {
                None => WinnerReason::BuiltIn,
                Some(_) if usable.len() == 1 => WinnerReason::OnlyCopy,
                Some(_) if all_same => WinnerReason::Identical,
                Some(w) if w.scope == RoleScope::Global => WinnerReason::Global,
                Some(_) => WinnerReason::PrimaryRepo,
            };
            (pick, reason)
        };
        let winner_role: Role = winner.cloned().or(builtin.clone()).unwrap_or_default();
        let builtin_shadowed = winner.is_some() && self.is_builtin(&name);
        let winner_id = winner.map(|w| w.id.clone());
        let mut diffs: Vec<RoleDrift> = Vec::new();
        let rows: Vec<RoleCopy> = copies
            .iter()
            .map(|c| {
                let same = c.content_hash == winner_role.content_hash && !winner_role.content_hash.is_empty();
                let fields = if same { Vec::new() } else { diff_fields(c, &winner_role) };
                if !fields.is_empty() && winner_id.as_deref() != Some(c.id.as_str()) {
                    diffs.push(RoleDrift { role_id: c.id.clone(), global_id: winner_role.id.clone(), repo_id: c.repo_id.clone().unwrap_or_default(), fields: fields.clone() });
                }
                let mut warnings = c.warnings.clone();
                if c.name != name && !warnings.iter().any(|w| w == "caseClash") {
                    warnings.push("caseClash".into());
                }
                RoleCopy {
                    id: c.id.clone(),
                    scope: c.scope,
                    repo_id: c.repo_id.clone(),
                    path: c.path.clone(),
                    content_hash: c.content_hash.clone(),
                    same_as_winner: same,
                    fields_differ: fields,
                    trust: c.trust,
                    shadowed_by_duplicate: c.shadowed_by_duplicate,
                    warnings,
                }
            })
            .collect();
        RoleGroup {
            name,
            role: winner_role,
            copies: rows,
            winner_id,
            winner_reason: reason,
            conflict,
            pin: ov.pin.clone(),
            pin_missing,
            hidden: ov.hidden,
            builtin_shadowed,
            diffs,
            delegate: DelegateStatus::default(),
        }
    }

    /// Resolves a role id or name for a NEW run: `name@repo` is exactly that copy (even an untrusted one), a bare name
    /// goes through the winner rule (global wins unless pinned). Hidden groups, untrusted-only groups and pure built-ins
    /// give `None` (the host falls back to its built-in of that name).
    pub fn resolve(&self, id_or_name: &str, primary_repo: Option<&str>, repos: &[RepoRef]) -> Option<Role> {
        self.resolve_checked(id_or_name, primary_repo, repos, false).ok()
    }

    /// Like [`Self::resolve`], but hidden groups still resolve: resuming an existing run by name keeps history working.
    pub fn resolve_any(&self, id_or_name: &str, primary_repo: Option<&str>, repos: &[RepoRef]) -> Option<Role> {
        self.resolve_checked(id_or_name, primary_repo, repos, true).ok()
    }

    /// `unknownRole` carries the reason in its message (`hidden`, `untrusted`, `builtin`, `no role`).
    pub fn resolve_checked(&self, id_or_name: &str, primary_repo: Option<&str>, repos: &[RepoRef], include_hidden: bool) -> Result<Role, RoleError> {
        let snap = self.snapshot(repos);
        let hidden = |name: &str| snap.overlay.get(&group_key(&snap.overlay, name)).is_some_and(|o| o.hidden);
        if id_or_name.contains('@') {
            let role = snap.roles.iter().find(|r| r.id == id_or_name && !r.shadowed_by_duplicate).ok_or_else(|| err("unknownRole", format!("no role {id_or_name}")))?;
            if hidden(&role.name) && !include_hidden {
                return Err(err("unknownRole", format!("{} is hidden", role.name)));
            }
            return Ok(role.clone());
        }
        let groups = self.build_groups(&snap, None, primary_repo);
        let group = groups.iter().find(|g| g.name.eq_ignore_ascii_case(id_or_name)).ok_or_else(|| err("unknownRole", format!("no role {id_or_name}")))?;
        if group.hidden && !include_hidden {
            return Err(err("unknownRole", format!("{} is hidden", group.name)));
        }
        if group.role.builtin {
            return Err(err("unknownRole", format!("{} is a built-in role", group.name)));
        }
        if group.role.trust == RoleTrust::Untrusted {
            return Err(err("unknownRole", format!("{} is an untrusted repository role; trust it first or pick it by its exact id", group.name)));
        }
        Ok(group.role.clone())
    }

    fn group_named(&self, name: &str, repos: &[RepoRef]) -> Result<RoleGroup, RoleError> {
        self.groups(repos).into_iter().find(|g| g.name.eq_ignore_ascii_case(name)).ok_or_else(|| err("unknownRole", format!("no role {name}")))
    }

    /// Hides or shows a whole group. Only the overlay changes: role files are never touched.
    pub fn set_hidden(&self, name: &str, hidden: bool, repos: &[RepoRef]) -> Result<RoleGroup, RoleError> {
        let _g = self.write.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = self.overlay_for_write()?;
        let group = self.group_named(name, repos)?;
        all.entry(group_key(&all, &group.name)).or_default().hidden = hidden;
        self.store_overlay(all)?;
        self.group_named(name, repos)
    }

    /// Pins the copy a run uses (`global` or `repo:<id>`), or clears the pin. Only the overlay changes. The pinned copy
    /// must exist and must not be untrusted.
    pub fn set_pin(&self, name: &str, pin: Option<&str>, repos: &[RepoRef]) -> Result<RoleGroup, RoleError> {
        let _g = self.write.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = self.overlay_for_write()?;
        let group = self.group_named(name, repos)?;
        if let Some(p) = pin {
            let valid_shape = p == "global" || p.strip_prefix("repo:").is_some_and(|id| !id.is_empty());
            if !valid_shape {
                return Err(err("invalidPin", format!("{p:?} is not a pin (global or repo:<id>)")));
            }
            let snap = self.snapshot_with(all.clone(), false, repos);
            let ok = snap.roles.iter().any(|r| r.name.eq_ignore_ascii_case(&group.name) && !r.shadowed_by_duplicate && r.trust != RoleTrust::Untrusted && pin_matches(p, r));
            if !ok {
                return Err(err("invalidPin", format!("{} has no usable copy {p}", group.name)));
            }
        }
        all.entry(group_key(&all, &group.name)).or_default().pin = pin.map(str::to_string);
        self.store_overlay(all)?;
        self.group_named(name, repos)
    }

    /// Approves (or withdraws the approval of) one content hash of a repository copy. A changed file has a new hash and
    /// loses the approval. Only the overlay changes.
    pub fn set_trust(&self, name: &str, hash: &str, trusted: bool, repos: &[RepoRef]) -> Result<RoleGroup, RoleError> {
        let _g = self.write.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = self.overlay_for_write()?;
        let group = self.group_named(name, repos)?;
        if trusted && !group.copies.iter().any(|c| c.scope == RoleScope::Repo && !c.shadowed_by_duplicate && c.content_hash == hash) {
            return Err(err("unknownRole", format!("{} has no repository copy with that content", group.name)));
        }
        let entry = all.entry(group_key(&all, &group.name)).or_default();
        entry.approved_hashes.retain(|h| h != hash);
        if trusted {
            entry.approved_hashes.push(hash.to_string());
        }
        self.store_overlay(all)?;
        self.group_named(name, repos)
    }

    /// Migration list, overlay state and skipped directories for the Roles table.
    pub fn status(&self, repos: &[RepoRef]) -> RolesStatus {
        let snap = self.snapshot(repos);
        let backup = match self.overlay.load_state() {
            crate::store::OverlayState::Corrupt { backup } => backup.map(|b| b.to_string_lossy().into_owned()),
            crate::store::OverlayState::Ok(_) => None,
        };
        let mut mismatches = Vec::new();
        if !snap.corrupt {
            let mut stripped = snap.overlay.clone();
            for o in stripped.values_mut() {
                o.permission = None;
            }
            let derived = self.snapshot_with(stripped, false, repos).roles;
            for r in snap.roles.iter().filter(|r| !r.shadowed_by_duplicate) {
                let Some(pinned) = snap.overlay.get(&r.id).and_then(|o| o.permission) else { continue };
                let Some(d) = derived.iter().find(|d| d.id == r.id) else { continue };
                if d.permission != pinned {
                    mismatches.push(PermissionMismatch { id: r.id.clone(), overlay: pinned, derived: d.permission, reason: d.permission_reason.clone().unwrap_or_default() });
                }
            }
        }
        let global_dir_target = std::fs::symlink_metadata(&self.global_dir).ok().filter(|m| m.file_type().is_symlink()).and_then(|_| self.global_dir.canonicalize().ok()).map(|p| p.to_string_lossy().into_owned());
        RolesStatus { overlay_corrupt: snap.corrupt, overlay_backup: backup, mismatches, skipped_dirs: snap.skipped, global_dir_target, global_dir: self.global_dir.to_string_lossy().into_owned() }
    }
}

/// Is the group passed to the Auto lead, and if not why. The cap (`TooMany`) is applied by the caller over all groups.
pub(crate) fn delegate_status(g: &RoleGroup, run: Option<&[String]>) -> DelegateStatus {
    let no = |reason| DelegateStatus { ok: false, reason: Some(reason) };
    let role = &g.role;
    if g.hidden {
        return no(ExcludeReason::Hidden);
    }
    if role.provider != "claude" {
        return no(ExcludeReason::OtherProvider);
    }
    if role.trust == RoleTrust::Untrusted {
        return no(ExcludeReason::Untrusted);
    }
    if role.description.as_deref().is_none_or(|d| d.trim().is_empty()) {
        return no(ExcludeReason::NoDescription);
    }
    if is_reserved(&g.name) {
        return no(ExcludeReason::ReservedName);
    }
    if role.system_prompt.as_ref().is_some_and(|p| p.len() > MAX_DELEGATE_PROMPT) {
        return no(ExcludeReason::PromptTooLarge);
    }
    if let Some(ids) = run {
        if !role.repo_scope.is_empty() && !ids.iter().all(|id| role.repo_scope.contains(id)) {
            return no(ExcludeReason::RepoScope);
        }
    }
    DelegateStatus { ok: true, reason: None }
}

impl From<ExcludeReason> for intely_agent_core::delegates::ExcludeReason {
    fn from(r: ExcludeReason) -> Self {
        use intely_agent_core::delegates::ExcludeReason as E;
        match r {
            ExcludeReason::Hidden => E::Hidden,
            ExcludeReason::OtherProvider => E::OtherProvider,
            ExcludeReason::NoDescription => E::NoDescription,
            ExcludeReason::ReservedName => E::ReservedName,
            ExcludeReason::PromptTooLarge => E::PromptTooLarge,
            ExcludeReason::RepoScope => E::RepoScope,
            ExcludeReason::TooMany => E::TooMany,
            ExcludeReason::Untrusted => E::Untrusted,
        }
    }
}
