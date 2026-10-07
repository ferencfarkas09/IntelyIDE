//! Permission derivation ((design notes: roles-orchestration-spec) 3.3): a role's permission comes from its own file instead
//! of a blanket read-only. Every doubt resolves toward LESS permission: a `tools` key that is present but empty or
//! unparsable is read-only (never "all tools"), a repository copy never exceeds `ask`.

use crate::frontmatter::Document;
use crate::types::{PermissionSource, RolePermission};

/// Tools that only read. `LS` is a legacy alias that older files still list.
pub const READ_ONLY_TOOLS: &[&str] = &["Read", "Grep", "Glob", "WebSearch", "WebFetch", "TodoWrite", "TaskList", "TaskGet", "ReportFindings", "Skill", "LS"];
/// Tools that change files (`canEdit`).
pub const EDIT_TOOLS: &[&str] = &["Edit", "Write", "NotebookEdit"];
/// Tools that run commands (`canRun`). `Monitor` also opens a socket.
pub const RUN_TOOLS: &[&str] = &["Bash", "Monitor"];
/// Tools that change state without being a file edit or a command: write-capable for the derivation.
pub const STATE_TOOLS: &[&str] = &["TaskStop", "TaskCreate", "TaskUpdate", "EnterWorktree", "ExitWorktree"];

/// The tool name of a list entry: `Bash(npm test:*)` is `Bash`; the legacy names `MultiEdit`, `KillShell` and
/// `BashOutput` are mapped to the tool that replaced them.
pub fn base_name(tool: &str) -> String {
    let base = tool.split('(').next().unwrap_or("").trim();
    match base {
        "MultiEdit" => "Edit",
        "KillShell" | "BashOutput" => "Bash",
        other => other,
    }
    .to_string()
}

/// How permissive a mode is (`readOnly` < `ask` < `edit`).
pub fn rank(p: RolePermission) -> u8 {
    match p {
        RolePermission::ReadOnly => 0,
        RolePermission::Ask => 1,
        RolePermission::Edit => 2,
    }
}

/// The stricter of two permissions.
pub fn min_permission(a: RolePermission, b: RolePermission) -> RolePermission {
    if rank(a) <= rank(b) {
        a
    } else {
        b
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Derived {
    pub permission: RolePermission,
    pub source: PermissionSource,
    pub reason: String,
    pub can_edit: bool,
    pub can_run: bool,
    /// Warning codes this derivation raised (`permissionModeIgnored`, `toolsUnparsable`, `mcpToolsIgnoredForDelegates`).
    pub warnings: Vec<String>,
    /// A repository copy whose permission the user never pinned with an overlay: the permission is a ceiling, and an unattended run never
    /// lifts the role above `readOnly` (permission-modes spec 3, GZ-24).
    pub capped: bool,
}

struct ByTools {
    permission: RolePermission,
    source: PermissionSource,
    reason: &'static str,
    edit: bool,
    run: bool,
}

fn by_tools(doc: &Document, warnings: &mut Vec<String>) -> ByTools {
    // Only a plain name in `disallowedTools` removes a tool; a pattern (`Bash(rm:*)`) leaves the tool in.
    let disallowed: Vec<String> = doc.disallowed_tools().iter().filter(|t| !t.contains('(')).map(|t| base_name(t)).collect();
    let allowed = |t: &&str| !disallowed.iter().any(|d| d == t);
    match doc.list_declared("tools") {
        None => {
            let edit = EDIT_TOOLS.iter().any(allowed);
            let run = RUN_TOOLS.iter().any(allowed);
            if edit || run {
                ByTools { permission: RolePermission::Edit, source: PermissionSource::AllTools, reason: "tools:all", edit, run }
            } else {
                ByTools { permission: RolePermission::ReadOnly, source: PermissionSource::Tools, reason: "tools:readOnly", edit: false, run: false }
            }
        }
        Some(list) if !list.ok => {
            warnings.push("toolsUnparsable".into());
            ByTools { permission: RolePermission::ReadOnly, source: PermissionSource::Tools, reason: "tools:unparsable", edit: false, run: false }
        }
        Some(list) => {
            let mut items: Vec<String> = Vec::new();
            for t in &list.items {
                let b = base_name(t);
                // a delegate never gets Agent/Task (no nested delegation)
                let removed = matches!(b.as_str(), "Agent" | "Task") || disallowed.contains(&b);
                if !removed && !items.contains(&b) {
                    items.push(b);
                }
            }
            if items.iter().any(|t| t.starts_with("mcp__")) {
                warnings.push("mcpToolsIgnoredForDelegates".into());
            }
            let edit = items.iter().any(|t| EDIT_TOOLS.contains(&t.as_str()));
            let run = items.iter().any(|t| RUN_TOOLS.contains(&t.as_str()));
            if items.is_empty() {
                ByTools { permission: RolePermission::ReadOnly, source: PermissionSource::Tools, reason: "tools:none", edit: false, run: false }
            } else if items.iter().all(|t| READ_ONLY_TOOLS.contains(&t.as_str())) {
                ByTools { permission: RolePermission::ReadOnly, source: PermissionSource::Tools, reason: "tools:readOnly", edit: false, run: false }
            } else {
                // any write-capable, MCP or unknown tool: the edit-with-approvals posture; the broker still judges every call
                ByTools { permission: RolePermission::Edit, source: PermissionSource::Tools, reason: "tools:write", edit, run }
            }
        }
    }
}

/// Derives the permission of one role file. `overlay` is the explicit permission the user set in the overlay (it always
/// wins); `repo_copy` clamps a file that comes from a repository to `ask` unless the user decided explicitly.
pub fn derive_permission(doc: &Document, overlay: Option<RolePermission>, repo_copy: bool) -> Derived {
    let mut warnings = Vec::new();
    let tools = by_tools(doc, &mut warnings);
    // No (closed) frontmatter block: Claude Code does not read the file as an agent, so no line in it can say "all
    // tools". A stray note in the agents folder must not become an edit role (every doubt resolves to less).
    let unreadable = !doc.has_frontmatter() && overlay.is_none();
    let (mut permission, mut source, mut reason): (RolePermission, PermissionSource, String) = if let Some(p) = overlay {
        (p, PermissionSource::Overlay, "overlay".into())
    } else if unreadable {
        (RolePermission::ReadOnly, PermissionSource::Tools, "frontmatter:missing".into())
    } else {
        let mode = doc.permission_mode().map(|m| m.trim().to_string());
        let from_mode = match mode.as_deref() {
            Some("plan" | "dontAsk") => Some(RolePermission::ReadOnly),
            Some("acceptEdits") => Some(RolePermission::Edit),
            Some("default") => Some(RolePermission::Ask),
            Some(_) => {
                warnings.push("permissionModeIgnored".into());
                None
            }
            None => None,
        };
        match from_mode {
            Some(p) => (p, PermissionSource::Frontmatter, format!("permissionMode:{}", mode.unwrap_or_default())),
            None => (tools.permission, tools.source, tools.reason.into()),
        }
    };
    if repo_copy && overlay.is_none() && rank(permission) > rank(RolePermission::Ask) {
        permission = RolePermission::Ask;
        source = PermissionSource::Ceiling;
        reason = "ceiling:repo".into();
    }
    let writable = permission != RolePermission::ReadOnly;
    Derived { permission, source, reason, can_edit: tools.edit && writable, can_run: tools.run && writable, warnings, capped: repo_copy && overlay.is_none() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(front: &str) -> Document {
        Document::parse(&format!("---\nname: x\n{front}---\nbody\n"))
    }

    fn d(front: &str) -> Derived {
        derive_permission(&doc(front), None, false)
    }

    #[test]
    fn base_names_strip_patterns_and_map_legacy_tools() {
        assert_eq!(base_name("Bash(npm test:*)"), "Bash");
        assert_eq!(base_name("MultiEdit"), "Edit");
        assert_eq!(base_name("KillShell"), "Bash");
        assert_eq!(base_name(" Read "), "Read");
    }

    #[test]
    fn a_tools_line_without_edit_write_or_bash_is_read_only() {
        let r = d("tools: Read, Grep, Glob\n");
        assert_eq!((r.permission, r.source, r.reason.as_str(), r.can_edit, r.can_run), (RolePermission::ReadOnly, PermissionSource::Tools, "tools:readOnly", false, false));
        assert_eq!(d("tools: Read, WebSearch, WebFetch, Task\n").permission, RolePermission::ReadOnly);
    }

    #[test]
    fn write_capable_unknown_and_mcp_tools_derive_edit() {
        assert_eq!(d("tools: Read, Bash(npm test:*)\n").permission, RolePermission::Edit);
        let mcp = d("tools: Read, mcp__x__y\n");
        assert_eq!(mcp.permission, RolePermission::Edit);
        assert!(mcp.warnings.contains(&"mcpToolsIgnoredForDelegates".to_string()));
        assert_eq!(d("tools: Read, Frobnicate\n").permission, RolePermission::Edit, "unknown tools are write-capable");
        let reviewer = d("tools: Read, Grep, Glob, Bash\n");
        assert_eq!((reviewer.permission, reviewer.can_run, reviewer.can_edit), (RolePermission::Edit, true, false));
    }

    #[test]
    fn no_tools_line_means_all_tools_and_edit() {
        let r = d("");
        assert_eq!((r.permission, r.source, r.reason.as_str(), r.can_edit, r.can_run), (RolePermission::Edit, PermissionSource::AllTools, "tools:all", true, true));
    }

    #[test]
    fn disallowed_tools_can_make_all_tools_read_only() {
        let r = d("disallowedTools: Edit, Write, Bash, NotebookEdit, MultiEdit, KillShell, Monitor, BashOutput\n");
        assert_eq!(r.permission, RolePermission::ReadOnly);
        assert_eq!(d("disallowedTools: Edit, Write\n").permission, RolePermission::Edit, "Bash is still there");
        assert_eq!(d("tools: Read, Edit\ndisallowedTools: Edit\n").permission, RolePermission::ReadOnly);
        assert_eq!(d("tools: Edit\ndisallowedTools: Edit\n").reason, "tools:none");
    }

    #[test]
    fn present_but_empty_or_unparsable_tools_never_mean_all_tools() {
        for front in ["tools:\n", "tools: []\n", "tools: {a: b}\n", "tools: Bash(x, Read\n"] {
            let r = d(front);
            assert_eq!(r.permission, RolePermission::ReadOnly, "{front}");
        }
        assert!(d("tools: {a: b}\n").warnings.contains(&"toolsUnparsable".to_string()));
        assert!(!d("tools: []\n").warnings.contains(&"toolsUnparsable".to_string()));
    }

    #[test]
    fn permission_mode_maps_and_dangerous_modes_are_ignored() {
        assert_eq!(d("permissionMode: plan\n").permission, RolePermission::ReadOnly);
        assert_eq!(d("permissionMode: dontAsk\n").permission, RolePermission::ReadOnly);
        assert_eq!(d("permissionMode: acceptEdits\ntools: Read\n").permission, RolePermission::Edit);
        assert_eq!(d("permissionMode: default\n").permission, RolePermission::Ask);
        let r = d("permissionMode: bypassPermissions\ntools: Read\n");
        assert_eq!((r.permission, r.source), (RolePermission::ReadOnly, PermissionSource::Tools));
        assert!(r.warnings.contains(&"permissionModeIgnored".to_string()));
        assert!(d("permissionMode: auto\n").warnings.contains(&"permissionModeIgnored".to_string()));
        assert_eq!(d("permissionMode: plan\n").source, PermissionSource::Frontmatter);
    }

    #[test]
    fn a_trailing_yaml_comment_is_not_part_of_the_value() {
        let r = d("permissionMode: plan # keep it safe\n");
        assert_eq!((r.permission, r.source), (RolePermission::ReadOnly, PermissionSource::Frontmatter));
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        assert_eq!(d("permissionMode: \"plan\" # keep it safe\n").permission, RolePermission::ReadOnly);
        assert_eq!(d("permissionMode: acceptEdits   #x\ntools: Read\n").permission, RolePermission::Edit);
        assert_eq!(d("tools: Read, Grep # only reading\n").permission, RolePermission::ReadOnly);
        assert_eq!(d("tools: # reading\n  - Read\n").permission, RolePermission::ReadOnly);
        assert!(!d("tools: Read, Grep # only reading\n").warnings.contains(&"toolsUnparsable".to_string()));
    }

    #[test]
    fn a_file_without_a_closed_frontmatter_block_is_read_only() {
        for text in ["", "just a note\n", "---\nname: x\ntools: Read\n(never closed)\n", "---\nname: x\n", "\u{0}\u{1}binary\n"] {
            let r = derive_permission(&Document::parse(text), None, false);
            assert_eq!((r.permission, r.reason.as_str(), r.can_edit, r.can_run), (RolePermission::ReadOnly, "frontmatter:missing", false, false), "{text:?}");
        }
        let explicit = derive_permission(&Document::parse("just a note\n"), Some(RolePermission::Edit), false);
        assert_eq!((explicit.permission, explicit.source), (RolePermission::Edit, PermissionSource::Overlay), "the user's decision still wins");
        assert_eq!(derive_permission(&Document::parse("---\nname: x\n---\nbody\n"), None, false).permission, RolePermission::Edit, "a real block without tools is still all tools");
    }

    #[test]
    fn the_overlay_beats_everything_and_a_repo_copy_is_capped_at_ask() {
        let r = derive_permission(&doc("tools: Read\npermissionMode: plan\n"), Some(RolePermission::Edit), false);
        assert_eq!((r.permission, r.source), (RolePermission::Edit, PermissionSource::Overlay));
        let repo = derive_permission(&doc("permissionMode: acceptEdits\n"), None, true);
        assert_eq!((repo.permission, repo.source, repo.reason.as_str()), (RolePermission::Ask, PermissionSource::Ceiling, "ceiling:repo"));
        assert_eq!(derive_permission(&doc("tools: Read\n"), None, true).permission, RolePermission::ReadOnly, "the ceiling only lowers");
        assert_eq!(derive_permission(&doc("tools: Bash\n"), Some(RolePermission::Edit), true).permission, RolePermission::Edit, "an explicit overlay is the user's decision");
    }

    #[test]
    fn capped_is_exactly_a_repository_copy_without_an_overlay_permission() {
        // a repository file with `tools: Write` is capped (and `ask`); one the user pinned with an overlay is not; global and built-in roles never are
        let repo = derive_permission(&doc("tools: Write\n"), None, true);
        assert_eq!((repo.capped, repo.permission), (true, RolePermission::Ask));
        assert!(derive_permission(&doc("tools: Read\n"), None, true).capped, "capped even when nothing was lowered: the role never gets lifted unattended");
        assert!(!derive_permission(&doc("tools: Write\n"), Some(RolePermission::Edit), true).capped, "an explicit overlay removes the cap");
        assert!(!derive_permission(&doc("tools: Write\n"), None, false).capped, "a global role is never capped");
    }

    #[test]
    fn rank_orders_the_modes() {
        assert_eq!(min_permission(RolePermission::Edit, RolePermission::Ask), RolePermission::Ask);
        assert_eq!(min_permission(RolePermission::ReadOnly, RolePermission::Edit), RolePermission::ReadOnly);
    }
}
