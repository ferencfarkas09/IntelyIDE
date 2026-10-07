//! The delegate set of a run ((design notes: roles-orchestration-spec) 3.5): the roles the Auto lead may hand work to, built
//! from the same `groups_for_run` data the Roles table shows (so the table and the run can never disagree), from the
//! trusted copies of the global directory and THIS run's repositories only.
//!
//! Per delegate: the model is resolved, the effort clamped, MCP tools stripped, a read-only role gets an explicit
//! read-only tool list (an omitted list would inherit ALL tools of the lead), `Agent`/`Task` are always disallowed (no
//! nested delegation) and the turn cap is 25 (at most 40).

use std::sync::Arc;

use intely_agent_core::delegates::{DelegateDef, DelegateRepo, DelegateResolver, DelegateScope, DelegateSet, DelegateSpec, ExcludedDelegate};
use intely_agent_host::roles::{CLAUDE_DISALLOWED, SYSTEM_PREAMBLE};
use intely_agent_host::RepoRef;

use crate::permission::{base_name, READ_ONLY_TOOLS};
use crate::store::{host_effort, host_permission, resolve_model, RoleStore};
use crate::types::{PermissionSource, Role, RolePermission, RoleScope};

/// Longest description the lead is shown.
pub const MAX_DESCRIPTION: usize = 1000;
/// Turns of a delegate when its file says nothing, and the most a file may ask for. Generous on purpose: a delegate that runs out of
/// turns hands back nothing (a researcher with 25 turns did, and the lead lost the whole lookup).
pub const DEFAULT_MAX_TURNS: u32 = 120;
pub const MAX_TURNS_CAP: u32 = 150;
/// What a role gets when its own tools leave nothing usable (never "inherit all"). A read-only role also always gets Bash, see `delegate_tools`.
pub const DEFAULT_READ_TOOLS: [&str; 4] = ["Read", "Grep", "Glob", "TodoWrite"];

/// One line, no control characters, at most [`MAX_DESCRIPTION`] characters: a repository file must not be able to
/// smuggle a paragraph of instructions (or terminal escapes) into the lead's agent list.
pub fn sanitize_description(text: &str) -> String {
    let flat: String = text.chars().map(|c| if c.is_whitespace() { ' ' } else { c }).filter(|c| !c.is_control()).collect();
    let one_line = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.chars().take(MAX_DESCRIPTION).collect()
}

fn is_mcp(tool: &str) -> bool {
    tool.starts_with("mcp__")
}

/// The explicit allow-list of a delegate (empty = inherit the lead's tools minus `disallowed_tools`).
fn delegate_tools(role: &Role) -> Vec<String> {
    let usable = |t: &&String| !is_mcp(&base_name(t)) && !matches!(base_name(t).as_str(), "Agent" | "Task");
    let mut out: Vec<String> = Vec::new();
    if role.permission == RolePermission::ReadOnly {
        // the intersection with the read-only set, patterns kept (the CLI enforces `Read(src/**)`)
        // A plain `Bash` stays when the role lists it (a pattern such as `Bash(rm:*)` does not: it names what a WRITER may run): for a
        // read-only role the broker allows read-only commands and refuses everything else with a reason the model can act on.
        for t in role.tools.iter().filter(usable).filter(|t| (READ_ONLY_TOOLS.contains(&base_name(t).as_str()) || t.as_str() == "Bash") && base_name(t) != "LS") {
            if !out.contains(t) {
                out.push(t.clone());
            }
        }
        // A lookup needs these four whatever the file lists (a role that could not search or run `git diff` handed back nothing, the
        // 25-turn researcher of 2026-10-05): `Bash` is read-only for this role because the broker refuses everything else.
        for essential in ["Read", "Grep", "Glob", "Bash"] {
            if !out.iter().any(|t| base_name(t) == essential) {
                out.push(essential.to_string());
            }
        }
    } else if !role.tools_declared {
        return out; // no tools line: all of the lead's tools
    } else {
        for t in role.tools.iter().filter(usable) {
            if !out.contains(t) {
                out.push(t.clone());
            }
        }
    }
    if out.is_empty() {
        // never "inherit everything" because a list was empty or became empty after stripping MCP/Agent tools
        out = DEFAULT_READ_TOOLS.iter().map(|t| (*t).to_string()).collect();
    }
    out
}

fn delegate_def(role: &Role) -> DelegateDef {
    let builtin = role.builtin;
    let prompt = if builtin {
        // the synthetic built-in already carries the preamble
        role.system_prompt.clone().unwrap_or_else(|| SYSTEM_PREAMBLE.to_string())
    } else {
        match role.system_prompt.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => format!("{SYSTEM_PREAMBLE}\n\n{p}"),
            None => SYSTEM_PREAMBLE.to_string(),
        }
    };
    let mut disallowed: Vec<String> = Vec::new();
    for t in CLAUDE_DISALLOWED.iter().map(|t| t.to_string()).chain(role.disallowed_tools.iter().cloned()).chain(["Agent".to_string(), "Task".to_string()]) {
        if !disallowed.contains(&t) {
            disallowed.push(t);
        }
    }
    let scope = if builtin {
        DelegateScope::Builtin
    } else if role.scope == RoleScope::Repo {
        DelegateScope::Repo
    } else {
        DelegateScope::Global
    };
    DelegateDef {
        spec: DelegateSpec {
            name: role.name.clone(),
            description: sanitize_description(role.description.as_deref().unwrap_or_default()),
            prompt,
            model: resolve_model(&role.model),
            effort: role.effort.filter(|_| role.effort_available).map(host_effort),
            permission: host_permission(role.permission),
            tools: delegate_tools(role),
            disallowed_tools: disallowed,
            max_turns: Some(if builtin { DEFAULT_MAX_TURNS } else { role.max_turns.unwrap_or(DEFAULT_MAX_TURNS).clamp(1, MAX_TURNS_CAP) }),
            scope,
            color: role.color.clone(),
        },
        source: if builtin { format!("builtin:{}", role.name) } else { role.path.clone() },
        // the same condition as `derive_permission`'s `capped` (a repository copy the user never pinned with an overlay permission)
        capped: !builtin && role.scope == RoleScope::Repo && role.permission_source != PermissionSource::Overlay,
    }
}

impl RoleStore {
    /// The delegate set of a run on `run_repo_ids` (the repositories of the run, the first is the primary one), from
    /// the CURRENT files and overlay. `repos` is every registered repository (their paths are needed to read the
    /// files); only the run's own are looked at.
    pub fn delegates(&self, run_repo_ids: &[String], repos: &[RepoRef]) -> DelegateSet {
        let mut set = DelegateSet::default();
        for g in self.groups_for_run(run_repo_ids, repos) {
            if g.delegate.ok {
                set.included.push(delegate_def(&g.role));
            } else {
                // an excluded group always has a reason; `Untrusted` (the strictest) is the fail-safe label
                let reason = g.delegate.reason.map_or(intely_agent_core::delegates::ExcludeReason::Untrusted, Into::into);
                set.excluded.push(ExcludedDelegate { name: g.name, reason });
            }
        }
        set
    }

    /// [`Self::delegates`] for the repositories of a run as the host hands them over.
    pub fn delegates_for(&self, run: &[DelegateRepo]) -> DelegateSet {
        let repos: Vec<RepoRef> = run.iter().map(|r| RepoRef { id: r.id.clone(), path: r.path.clone() }).collect();
        let ids: Vec<String> = run.iter().map(|r| r.id.clone()).collect();
        self.delegates(&ids, &repos)
    }

    /// The resolver the host config takes (`HostConfig.delegate_resolver`).
    pub fn delegate_resolver(self: &Arc<Self>) -> DelegateResolver {
        let store = self.clone();
        Arc::new(move |run| store.delegates_for(run))
    }
}
