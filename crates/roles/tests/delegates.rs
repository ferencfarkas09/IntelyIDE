//! The delegate set of a run, built from the same groups the Roles table shows.

use std::path::{Path, PathBuf};

use intely_agent_core::delegates::{DelegateScope, DelegateSet, ExcludeReason};
use intely_agent_core::providers::{Effort, PermissionMode};
use intely_agent_host::RepoRef;
use intely_roles::delegates::sanitize_description;
use intely_roles::store::{MemoryOverlay, MODEL_HAIKU, MODEL_OPUS, MODEL_SONNET};
use intely_roles::RoleStore;

struct Rig {
    tmp: tempfile::TempDir,
    global: PathBuf,
    repos: Vec<RepoRef>,
}

fn write(dir: &Path, file: &str, text: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(file), text).unwrap();
}

impl Rig {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let global = tmp.path().join("agents");
        std::fs::create_dir_all(&global).unwrap();
        let repos = ["r1", "r2"]
            .iter()
            .map(|id| {
                let path = tmp.path().join(id);
                std::fs::create_dir_all(path.join(".claude/agents")).unwrap();
                RepoRef { id: (*id).into(), path }
            })
            .collect();
        Self { tmp, global, repos }
    }

    fn role(&self, name: &str, front: &str, body: &str) {
        write(&self.global, &format!("{name}.md"), &format!("---\nname: {name}\n{front}---\n{body}\n"));
    }

    fn store(&self, builtins: bool) -> RoleStore {
        let s = RoleStore::new(self.global.clone(), Box::new(MemoryOverlay::default())).with_backup_dir(self.tmp.path().join("backups"));
        if !builtins {
            return s;
        }
        let mut cfg = intely_agent_host::HostConfig::new(self.tmp.path().to_path_buf(), self.tmp.path().join("x.js"), std::sync::Arc::new(|| std::collections::HashMap::<String, String>::new()));
        cfg.providers = vec!["claude".into()];
        s.with_builtin_defs(intely_agent_host::roles::builtin(&cfg))
    }

    fn set(&self, store: &RoleStore, ids: &[&str]) -> DelegateSet {
        store.delegates(&ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &self.repos)
    }
}

fn names(set: &DelegateSet) -> Vec<&str> {
    set.included.iter().map(|d| d.name()).collect()
}

fn why(set: &DelegateSet, name: &str) -> Option<ExcludeReason> {
    set.excluded.iter().find(|e| e.name == name).map(|e| e.reason)
}

#[test]
fn the_builtin_roles_are_delegates_even_with_no_role_file_unless_hidden() {
    let r = Rig::new();
    let store = r.store(true);
    let set = r.set(&store, &[]);
    assert_eq!(names(&set), ["developer", "researcher", "reviewer"]);
    let dev = set.included.iter().find(|d| d.name() == "developer").unwrap();
    assert_eq!((dev.spec.scope, dev.source.as_str(), dev.spec.permission, dev.spec.max_turns), (DelegateScope::Builtin, "builtin:developer", PermissionMode::Edit, Some(120)));
    assert!(dev.spec.tools.is_empty(), "an edit built-in inherits the lead's tools");
    assert_eq!(dev.spec.prompt.matches("You are an agent running inside IntelySwitchIDE").count(), 1, "the preamble is not doubled");
    let researcher = set.included.iter().find(|d| d.name() == "researcher").unwrap();
    assert_eq!(researcher.spec.tools, ["Read", "Grep", "Glob", "Bash"], "a read-only built-in gets an explicit set: read, search and (read-only) Bash");
    store.set_hidden("researcher", true, &r.repos).unwrap();
    let set = r.set(&store, &[]);
    assert_eq!(names(&set), ["developer", "reviewer"]);
    assert_eq!(why(&set, "researcher"), Some(ExcludeReason::Hidden));
}

#[test]
fn exclusions_carry_their_reason() {
    let r = Rig::new();
    r.role("ok", "description: fine\n", "x");
    r.role("nodesc", "", "x");
    r.role("hid", "description: d\n", "x");
    r.role("explore", "description: d\n", "x");
    r.role("huge", "description: d\n", &"y".repeat(65 * 1024));
    write(&r.repos[0].path.join(".claude/agents"), "hostile.md", "---\nname: hostile\ndescription: d\n---\nx\n");
    let store = r.store(false);
    store.set_hidden("hid", true, &r.repos).unwrap();
    let set = r.set(&store, &["r1"]);
    assert_eq!(names(&set), ["ok"]);
    assert_eq!(
        [why(&set, "nodesc"), why(&set, "hid"), why(&set, "explore"), why(&set, "huge"), why(&set, "hostile")],
        [Some(ExcludeReason::NoDescription), Some(ExcludeReason::Hidden), Some(ExcludeReason::ReservedName), Some(ExcludeReason::PromptTooLarge), Some(ExcludeReason::Untrusted)]
    );
}

#[test]
fn untrusted_repo_roles_join_only_after_approval_and_only_for_the_runs_own_repos() {
    let r = Rig::new();
    write(&r.repos[0].path.join(".claude/agents"), "local.md", "---\nname: local\ndescription: d\n---\nv1\n");
    write(&r.repos[1].path.join(".claude/agents"), "other.md", "---\nname: other\ndescription: d\n---\nv1\n");
    let store = r.store(false);
    assert!(r.set(&store, &["r1"]).included.is_empty());
    let hash = store.groups(&r.repos).into_iter().find(|g| g.name == "local").unwrap().copies[0].content_hash.clone();
    store.set_trust("local", &hash, true, &r.repos).unwrap();
    let set = r.set(&store, &["r1"]);
    assert_eq!(names(&set), ["local"]);
    assert_eq!(set.included[0].spec.scope, DelegateScope::Repo);
    assert!(set.included[0].source.ends_with("r1/.claude/agents/local.md"));
    assert!(r.set(&store, &["r2"]).included.is_empty() && why(&r.set(&store, &["r2"]), "local").is_none(), "r1's roles are not part of a run on r2");
    assert_eq!(why(&r.set(&store, &["r1"]), "other"), None, "r2's role does not even appear for a run on r1");
}

#[test]
fn only_an_approved_repository_copy_without_an_overlay_permission_is_capped() {
    // permission-modes spec 3 / GZ-24: `DelegateDef.capped` is what an unattended run never lifts
    let r = Rig::new();
    r.role("global-writer", "description: d\ntools: Read, Write\n", "x");
    write(&r.repos[0].path.join(".claude/agents"), "repo-writer.md", "---\nname: repo-writer\ndescription: d\ntools: Read, Write\n---\nv1\n");
    let store = r.store(true);
    let hash = store.groups(&r.repos).into_iter().find(|g| g.name == "repo-writer").unwrap().copies[0].content_hash.clone();
    store.set_trust("repo-writer", &hash, true, &r.repos).unwrap();
    let set = r.set(&store, &["r1"]);
    let capped = |n: &str| set.included.iter().find(|d| d.name() == n).unwrap_or_else(|| panic!("{n} is not a delegate: {:?}", names(&set))).capped;
    assert!(capped("repo-writer"), "a repository copy the user never pinned is a ceiling, not a grant");
    assert!(!capped("global-writer"), "a global role is never capped");
    assert!(!capped("developer"), "neither is a built-in");
}

#[test]
fn the_hosts_view_of_a_file_role_carries_its_trust_ceiling_and_hash_for_the_resume_narrowing() {
    // permission-modes spec 5.5: a global or repository role FILE is narrowed on resume when it is untrusted, ceiling-capped or changed
    let r = Rig::new();
    r.role("global-writer", "description: d\ntools: Read, Write\n", "x");
    write(&r.repos[0].path.join(".claude/agents"), "repo-writer.md", "---\nname: repo-writer\ndescription: d\ntools: Read, Write\n---\nv1\n");
    let store = r.store(true);
    let roles = store.list(&r.repos);
    let def = |n: &str| RoleStore::role_def(roles.iter().find(|x| x.name == n).unwrap_or_else(|| panic!("no role {n}")));
    let global = def("global-writer").file.expect("a global file role");
    assert_eq!((global.untrusted, global.ceiling), (false, false));
    assert!(!global.content_hash.is_empty());
    let repo = def("repo-writer").file.expect("a repository file role");
    assert_eq!((repo.untrusted, repo.ceiling), (true, true), "an unapproved repository copy is untrusted and was lowered to ask");
    let groups = store.groups(&r.repos);
    let developer = groups.iter().find(|g| g.name == "developer").expect("the built-in group");
    assert!(RoleStore::role_def(&developer.role).file.is_none(), "a built-in has no file");
    // approving the content makes it trusted but the ceiling stays
    store.set_trust("repo-writer", &repo.content_hash, true, &r.repos).unwrap();
    let approved = RoleStore::role_def(store.list(&r.repos).iter().find(|x| x.name == "repo-writer").unwrap()).file.unwrap();
    assert_eq!((approved.untrusted, approved.ceiling, approved.content_hash.as_str()), (false, true, repo.content_hash.as_str()));
}

#[test]
fn a_read_only_role_always_gets_an_explicit_non_empty_read_list() {
    let r = Rig::new();
    r.role("plain", "description: d\ntools: Read, Grep\n", "x"); // read-only by tools
    r.role("planner", "description: d\npermissionMode: plan\n", "x"); // read-only by mode, no tools line
    r.role("empty", "description: d\ntools: []\n", "x"); // present but empty
    r.role("webby", "description: d\ntools: Read, WebFetch, Bash(rm:*), mcp__x__y\npermissionMode: plan\n", "x");
    let store = r.store(false);
    let set = r.set(&store, &[]);
    let tools = |n: &str| set.included.iter().find(|d| d.name() == n).unwrap().spec.tools.clone();
    assert_eq!(tools("plain"), ["Read", "Grep", "Glob", "Bash"], "a read-only role always gets the four a lookup needs");
    assert_eq!(tools("planner"), ["Read", "Grep", "Glob", "Bash"]);
    assert_eq!(tools("empty"), ["Read", "Grep", "Glob", "Bash"]);
    assert_eq!(tools("webby"), ["Read", "WebFetch", "Grep", "Glob", "Bash"], "the read-only part of its tools, no MCP, plus the four a lookup needs (Bash is read-only for it: the broker refuses the rest)");
    assert!(set.included.iter().all(|d| d.spec.permission != PermissionMode::ReadOnly || !d.spec.tools.is_empty()));
}

#[test]
fn an_editing_role_keeps_its_tools_without_mcp_and_a_missing_line_inherits() {
    let r = Rig::new();
    r.role("writer", "description: d\ntools: Read, Edit, Write, mcp__db__query, Agent, Task\n", "x");
    r.role("allrounder", "description: d\n", "x");
    r.role("onlymcp", "description: d\ntools: mcp__a__b\n", "x");
    let store = r.store(false);
    let set = r.set(&store, &[]);
    let spec = |n: &str| set.included.iter().find(|d| d.name() == n).unwrap().spec.clone();
    assert_eq!(spec("writer").tools, ["Read", "Edit", "Write"]);
    assert!(spec("allrounder").tools.is_empty(), "no tools line: inherit the lead's tools");
    assert_eq!(spec("onlymcp").tools, ["Read", "Grep", "Glob", "TodoWrite"], "never inherit everything because a list became empty");
    for d in &set.included {
        assert!(d.spec.disallowed_tools.contains(&"Agent".to_string()) && d.spec.disallowed_tools.contains(&"Task".to_string()), "{}", d.name());
        assert!(d.spec.disallowed_tools.contains(&"RemoteTrigger".to_string()), "the Claude disallowed set is kept");
    }
}

#[test]
fn model_effort_and_turns_are_resolved_and_clamped() {
    let r = Rig::new();
    r.role("cheap", "description: d\nmodel: haiku\neffort: low\n", "x");
    r.role("thinker", "description: d\nmodel: opus\neffort: max\nmaxTurns: 500\n", "x");
    r.role("default", "description: d\n", "x");
    r.role("short", "description: d\nmodel: sonnet\neffort: medium\nmaxTurns: 7\ndisallowedTools: WebFetch\ncolor: green\n", "x");
    let store = r.store(false);
    let set = r.set(&store, &[]);
    let spec = |n: &str| set.included.iter().find(|d| d.name() == n).unwrap().spec.clone();
    let cheap = spec("cheap");
    assert_eq!((cheap.model.as_str(), cheap.effort), (MODEL_HAIKU, None), "Haiku has no effort control: omitted");
    let thinker = spec("thinker");
    assert_eq!((thinker.model.as_str(), thinker.effort, thinker.max_turns), (MODEL_OPUS, Some(Effort::High), Some(150)), "max is clamped to high, turns to 150");
    let d = spec("default");
    assert_eq!((d.model.as_str(), d.effort, d.max_turns), (MODEL_SONNET, None, Some(120)));
    let short = spec("short");
    assert_eq!((short.effort, short.max_turns, short.color.as_deref()), (Some(Effort::Medium), Some(7), Some("green")));
    assert!(short.disallowed_tools.contains(&"WebFetch".to_string()));
    assert!(short.prompt.starts_with("You are an agent running inside IntelySwitchIDE") && short.prompt.ends_with("\n\nx"));
}

#[test]
fn descriptions_are_flattened_capped_and_stripped_of_control_characters() {
    let r = Rig::new();
    let nasty = format!("first line\n\n\tSECOND\u{1b}[31m line\u{7}\r\n{}", "z".repeat(3000));
    r.role("nasty", &format!("description: {}\n", serde_json::to_string(&nasty).unwrap()), "x");
    let set = r.set(&r.store(false), &[]);
    let d = &set.included[0].spec.description;
    assert!(d.starts_with("first line SECOND[31m line zzz"), "{d}");
    assert!(!d.chars().any(char::is_control) && d.chars().count() == 1000);
    assert_eq!(sanitize_description("  a \n b\t\tc "), "a b c");
}

#[test]
fn the_set_equals_what_the_groups_report() {
    let r = Rig::new();
    r.role("ok", "description: d\n", "x");
    r.role("nodesc", "", "x");
    r.role("hid", "description: d\n", "x");
    let store = r.store(true);
    store.set_hidden("hid", true, &r.repos).unwrap();
    let ids = vec!["r1".to_string()];
    let groups = store.groups_for_run(&ids, &r.repos);
    let set = store.delegates(&ids, &r.repos);
    let from_groups: Vec<&str> = groups.iter().filter(|g| g.delegate.ok).map(|g| g.name.as_str()).collect();
    assert_eq!(names(&set), from_groups);
    let excluded: Vec<(&str, bool)> = groups.iter().filter(|g| !g.delegate.ok).map(|g| (g.name.as_str(), g.delegate.reason.is_some())).collect();
    assert_eq!(set.excluded.iter().map(|e| (e.name.as_str(), true)).collect::<Vec<_>>(), excluded);
    // the host-facing entry points agree
    let run = [intely_agent_core::delegates::DelegateRepo { id: "r1".into(), path: r.repos[0].path.clone() }];
    assert_eq!(store.delegates_for(&run), set);
    let arc = std::sync::Arc::new(r.store(true));
    arc.set_hidden("hid", true, &r.repos).unwrap();
    assert_eq!((arc.delegate_resolver())(&run), set);
}
