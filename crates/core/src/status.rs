//! Snapshot computation (contract section 6.3).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::exec::{clean_rel_path, resolve_in_repo, run_git_full, GitCtx, RunOpts};
use crate::parse::nfc_path;
use crate::parse::status_v2::{parse_status_v2, ParsedStatus};
use crate::{
    code, Change, ChangeKind, EngineError, GuardState, HeadInfo, HookInfo, HookKind, RepoConfig, RepoSnapshot, RepoState,
    UntrackedList, UpstreamInfo,
};

/// Signature of [`crate::guard::classify`]; the snapshot builder takes it as a parameter so it can be tested in isolation.
type Classify = fn(&str, bool, Option<u64>) -> GuardState;

/// Generous cap for a status of an enormous worktree; hitting it is reported in `RepoSnapshot::error`.
const MAX_STATUS_BYTES: usize = 256 * 1024 * 1024;
const STATUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Full snapshot of one repo: `git status --porcelain=v2 -z --branch`, repo state, hooks, stash/worktree counts.
/// `revision` is assigned by the repo actor.
pub async fn snapshot(ctx: &GitCtx, repo: &RepoConfig) -> Result<RepoSnapshot, EngineError> {
    snapshot_with(ctx, repo, crate::guard::classify).await
}

async fn snapshot_with(ctx: &GitCtx, repo: &RepoConfig, classify: Classify) -> Result<RepoSnapshot, EngineError> {
    let root = PathBuf::from(&repo.path);
    let args = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal"];
    let opts = RunOpts { read_only: true, max_output: Some(MAX_STATUS_BYTES), timeout: Some(STATUS_TIMEOUT), ..Default::default() };
    // The marker files are read while git runs, so the first snapshot costs one process, not one process plus I/O.
    let meta_root = root.clone();
    let (out, meta) = tokio::join!(run_git_full(ctx, &root, &args, &opts, None), tokio::task::spawn_blocking(move || read_meta(&meta_root)));
    let run = out?;
    let out = run.output;
    if !out.success() {
        let err = out.stderr_text();
        let (c, msg) = if err.contains("not a git repository") {
            (code::NOT_A_REPO, "not a git repository".to_owned())
        } else if run.timed_out {
            (code::GIT, "git status timed out".to_owned())
        } else {
            (code::GIT, "git status failed".to_owned())
        };
        return Err(EngineError::new(c, msg).with_detail(err.trim().to_owned()));
    }
    let truncated = run.truncated;
    let parsed = parse_status_v2(&out.stdout)?;
    let meta = meta.map_err(|e| EngineError::new(code::IO, e.to_string()))?;
    let repo = repo.clone();
    let mut snap = tokio::task::spawn_blocking(move || build_snapshot(&repo, &root, parsed, meta, classify))
        .await
        .map_err(|e| EngineError::new(code::IO, e.to_string()))?;
    if truncated {
        snap.error = Some("status output was truncated".to_owned());
    }
    Ok(snap)
}

/// Untracked files below a collapsed directory entry (`dir` is repo-relative, ends with `/`).
pub async fn list_untracked(ctx: &GitCtx, repo: &RepoConfig, dir: &str, limit: u32) -> Result<UntrackedList, EngineError> {
    list_untracked_with(ctx, repo, dir, limit, crate::guard::classify).await
}

/// Upper bound for one NUL-terminated path in the capped `ls-files` output.
const UNTRACKED_PATH_BUDGET: usize = 1024;

async fn list_untracked_with(ctx: &GitCtx, repo: &RepoConfig, dir: &str, limit: u32, classify: Classify) -> Result<UntrackedList, EngineError> {
    let root = PathBuf::from(&repo.path);
    resolve_in_repo(&root, dir)?;
    let dir = clean_rel_path(dir)?;
    let mut opts = RunOpts { read_only: true, kill_on_limit: true, max_output: Some((limit as usize + 1) * UNTRACKED_PATH_BUDGET), ..Default::default() };
    opts.extra_env.insert("GIT_LITERAL_PATHSPECS".into(), "1".into());
    let run = run_git_full(ctx, &root, &["ls-files", "-z", "--others", "--exclude-standard", "--", &dir], &opts, None).await?;
    let out = run.output;
    if !out.success() && !run.truncated {
        return Err(EngineError::new(code::GIT, "git ls-files failed").with_detail(out.stderr_text().trim().to_owned()));
    }
    let mut records: Vec<&[u8]> = out.stdout.split(|&b| b == 0).collect();
    records.pop(); // empty, or a record cut off by the output cap
    let truncated = run.truncated || records.len() > limit as usize;
    records.truncate(limit as usize);
    let files = records
        .into_iter()
        .map(|raw| {
            let path = nfc_path(raw);
            let mut c = untracked_change(&path, &root, classify);
            if path.ends_with('/') {
                c.dir = Some(true);
            }
            c
        })
        .collect();
    Ok(UntrackedList { files, truncated })
}

fn untracked_change(path: &str, root: &Path, classify: Classify) -> Change {
    let is_dir = path.ends_with('/');
    let size = if is_dir { None } else { std::fs::symlink_metadata(root.join(path)).ok().map(|m| m.len()) };
    Change {
        path: path.to_owned(),
        orig_path: None,
        kind: ChangeKind::Untracked,
        index_status: " ".to_owned(),
        worktree_status: "?".to_owned(),
        staged: false,
        partially_staged: false,
        guard: classify(path.trim_end_matches('/'), true, size),
        binary: None,
        size_bytes: size,
        dir: None,
    }
}

/// A staged path that HEAD does not have (added, copied, or renamed to a guarded name) is new to the repo and guarded
/// like an untracked file; while a merge or rebase is in progress the commit-time check decides, because the
/// operation may legitimately have brought the path in.
fn is_new_to_repo(c: &Change, classify: Classify) -> bool {
    match c.kind {
        ChangeKind::Added | ChangeKind::Copied => true,
        ChangeKind::Renamed => c.orig_path.as_deref().map_or(true, |o| classify(o, false, None) != GuardState::Sensitive),
        _ => false,
    }
}

/// Repo facts that need no git process.
#[derive(Debug, PartialEq)]
struct Meta {
    state: RepoState,
    stash_count: u32,
    worktree_count: u32,
    hooks: HookInfo,
    remotes: Vec<String>,
}

fn build_snapshot(repo: &RepoConfig, root: &Path, parsed: ParsedStatus, meta: Meta, classify: Classify) -> RepoSnapshot {
    let ParsedStatus { branch, mut changes } = parsed;
    let merging = matches!(meta.state, RepoState::Merging | RepoState::Rebasing | RepoState::CherryPicking | RepoState::Reverting);
    for c in &mut changes {
        if c.kind == ChangeKind::Untracked {
            let guard = untracked_change(&c.path, root, classify);
            c.guard = guard.guard;
            c.size_bytes = guard.size_bytes;
        } else {
            c.guard = classify(&c.path, !merging && is_new_to_repo(c, classify), None);
        }
    }
    let upstream = branch.upstream.as_deref().map(|u| split_upstream(u, &meta.remotes, branch.upstream_gone));
    RepoSnapshot {
        repo_id: repo.id.clone(),
        revision: 0,
        taken_at_ms: now_ms(),
        head: HeadInfo { unborn: branch.oid.is_none(), detached: branch.head.is_none(), branch: branch.head, oid: branch.oid },
        upstream,
        ahead: branch.ahead,
        behind: branch.behind,
        state: meta.state,
        hooks: meta.hooks,
        changes,
        stash_count: meta.stash_count,
        worktree_count: meta.worktree_count,
        error: None,
    }
}

/// `origin/feature/x` -> remote `origin`, branch `feature/x`. The longest configured remote name that prefixes the ref
/// wins (remote names may contain `/`); an upstream without a remote part is a local branch (`.`).
fn split_upstream(upstream: &str, remotes: &[String], gone: bool) -> UpstreamInfo {
    let remote = remotes
        .iter()
        .filter(|r| upstream.strip_prefix(r.as_str()).is_some_and(|rest| rest.starts_with('/')))
        .max_by_key(|r| r.len())
        .cloned();
    let (remote, branch) = match remote {
        Some(r) => {
            let b = upstream[r.len() + 1..].to_owned();
            (r, b)
        }
        None => match upstream.split_once('/') {
            Some((r, b)) => (r.to_owned(), b.to_owned()),
            None => (".".to_owned(), upstream.to_owned()),
        },
    };
    UpstreamInfo { remote, branch, gone }
}

/// `.git` directories of a work tree, found without spawning git.
#[derive(Debug, Clone, PartialEq)]
pub struct GitDirs {
    /// Per-worktree git dir (HEAD, index, MERGE_HEAD, rebase state).
    pub git_dir: PathBuf,
    /// Shared dir (config, hooks, refs, logs, `worktrees/`); equals `git_dir` outside linked worktrees.
    pub common_dir: PathBuf,
}

pub fn find_git_dirs(root: &Path) -> Option<GitDirs> {
    let dot_git = root.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
        let p = Path::new(target);
        if p.is_absolute() { p.to_path_buf() } else { lexically_clean(&root.join(p)) }
    };
    let common_dir = match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(rel) => {
            let p = Path::new(rel.trim());
            if p.is_absolute() { p.to_path_buf() } else { lexically_clean(&git_dir.join(p)) }
        }
        Err(_) => git_dir.clone(),
    };
    Some(GitDirs { git_dir, common_dir })
}

/// Resolves `.` and `..` textually (`.git/worktrees/x/../..` -> `.git`).
fn lexically_clean(p: &Path) -> PathBuf {
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

fn read_meta(root: &Path) -> Meta {
    let Some(dirs) = find_git_dirs(root) else {
        return Meta { state: RepoState::Normal, stash_count: 0, worktree_count: 0, hooks: HookInfo { kind: HookKind::None, path: None }, remotes: Vec::new() };
    };
    let g = &dirs.git_dir;
    let state = if g.join("rebase-merge").exists() || g.join("rebase-apply").exists() {
        RepoState::Rebasing
    } else if g.join("MERGE_HEAD").exists() {
        RepoState::Merging
    } else if g.join("CHERRY_PICK_HEAD").exists() {
        RepoState::CherryPicking
    } else if g.join("REVERT_HEAD").exists() {
        RepoState::Reverting
    } else if g.join("BISECT_LOG").exists() {
        RepoState::Bisecting
    } else {
        RepoState::Normal
    };
    let stash_count = std::fs::read(dirs.common_dir.join("logs/refs/stash")).map_or(0, |b| b.iter().filter(|&&c| c == b'\n').count() as u32);
    let worktree_count = std::fs::read_dir(dirs.common_dir.join("worktrees")).map_or(0, |d| d.filter_map(Result::ok).filter(|e| e.path().is_dir()).count() as u32);
    let config = [dirs.common_dir.join("config"), dirs.git_dir.join("config.worktree")]
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .map(|t| parse_git_config(&t))
        .fold(ConfigInfo::default(), |mut acc, c| {
            acc.hooks_path = c.hooks_path.or(acc.hooks_path);
            acc.remotes.extend(c.remotes);
            acc
        });
    let hooks = detect_hooks(&dirs.common_dir, config.hooks_path.as_deref());
    Meta { state, stash_count, worktree_count, hooks, remotes: config.remotes }
}

#[derive(Debug, Default, PartialEq)]
struct ConfigInfo {
    hooks_path: Option<String>,
    remotes: Vec<String>,
}

/// The few facts needed from a `.git/config`: `core.hooksPath` and the remote names.
fn parse_git_config(text: &str) -> ConfigInfo {
    let mut info = ConfigInfo::default();
    let mut section = String::new();
    for raw in text.lines() {
        let mut line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[') {
            let Some((head, tail)) = rest.split_once(']') else { continue };
            section = head.trim().to_owned();
            if let Some(name) = section.strip_prefix("remote \"").or_else(|| section.strip_prefix("remote  \"")).and_then(|n| n.strip_suffix('"')) {
                info.remotes.push(name.to_owned());
            }
            line = tail.trim();
            if line.is_empty() {
                continue;
            }
        }
        if let Some((key, value)) = line.split_once('=') {
            if section.eq_ignore_ascii_case("core") && key.trim().eq_ignore_ascii_case("hookspath") {
                info.hooks_path = Some(value.trim().trim_matches('"').to_owned());
            }
        }
    }
    info
}

/// `path` is the configured `core.hooksPath` (relative to the repo root unless absolute) or the `.git/hooks` dir.
fn detect_hooks(common_dir: &Path, hooks_path: Option<&str>) -> HookInfo {
    use std::os::unix::fs::PermissionsExt;
    if let Some(p) = hooks_path.filter(|p| !p.is_empty()) {
        let trimmed = p.trim_end_matches('/');
        let kind = if trimmed.ends_with(".husky/_") || trimmed.ends_with(".husky") { HookKind::Husky } else { HookKind::Custom };
        let path = p.to_owned();
        return HookInfo { kind, path: Some(path) };
    }
    let dir = common_dir.join("hooks");
    let has_active = std::fs::read_dir(&dir).is_ok_and(|rd| {
        rd.filter_map(Result::ok).any(|e| {
            let name = e.file_name();
            !name.to_string_lossy().ends_with(".sample") && e.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
    });
    if has_active {
        HookInfo { kind: HookKind::Custom, path: Some(dir.to_string_lossy().into_owned()) }
    } else {
        HookInfo { kind: HookKind::None, path: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::fixture::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake_classify(path: &str, untracked: bool, size: Option<u64>) -> GuardState {
        if path.split('/').any(|c| c.starts_with("dump_")) {
            GuardState::NeverAdd
        } else if path.ends_with(".env") {
            GuardState::Secret
        } else if untracked && size.is_some_and(|s| s > 5 * 1024 * 1024) {
            GuardState::TooLarge
        } else {
            GuardState::Ok
        }
    }

    async fn snap(f: &Fixture) -> RepoSnapshot {
        snapshot_with(&ctx(), &f.config(), fake_classify).await.unwrap()
    }

    fn find<'a>(s: &'a RepoSnapshot, path: &str) -> &'a Change {
        s.changes.iter().find(|c| c.path == path).unwrap_or_else(|| panic!("{path} not in {:?}", s.changes.iter().map(|c| &c.path).collect::<Vec<_>>()))
    }

    #[test]
    fn config_parsing() {
        let c = parse_git_config("[core]\n\trepositoryformatversion = 0\n\thooksPath = .husky/_\n[remote \"origin\"]\n\turl = x\n[remote \"team/mirror\"]\n\turl = y\n[branch \"main\"]\n\tremote = origin\n; comment\n[Core] HooksPath = \"/abs/hooks\"\n");
        assert_eq!(c, ConfigInfo { hooks_path: Some("/abs/hooks".into()), remotes: vec!["origin".into(), "team/mirror".into()] });
        assert_eq!(parse_git_config("[user]\nname = x\n[other]\nhooksPath = no\n").hooks_path, None);
    }

    #[test]
    fn upstream_split_prefers_the_longest_remote() {
        let remotes = vec!["origin".to_owned(), "team".to_owned(), "team/mirror".to_owned()];
        assert_eq!(split_upstream("origin/feature/x", &remotes, false), UpstreamInfo { remote: "origin".into(), branch: "feature/x".into(), gone: false });
        assert_eq!(split_upstream("team/mirror/main", &remotes, true), UpstreamInfo { remote: "team/mirror".into(), branch: "main".into(), gone: true });
        assert_eq!(split_upstream("main", &remotes, false).remote, ".");
        assert_eq!(split_upstream("unknown/x", &[], false).remote, "unknown");
    }

    #[tokio::test]
    async fn clean_repo_and_unborn_repo() {
        let f = Fixture::new();
        let s = snap(&f).await;
        assert_eq!((s.head.branch.as_deref(), s.head.detached, s.head.unborn, s.state.clone()), (Some("main"), false, false, RepoState::Normal));
        assert!(s.head.oid.is_some() && s.changes.is_empty() && s.upstream.is_none());
        assert_eq!((s.repo_id.as_str(), s.revision, s.stash_count, s.worktree_count), ("r1", 0, 0, 0));

        let u = Fixture::unborn();
        u.write("a.txt", "a");
        u.git(&["add", "a.txt"]);
        let s = snap(&u).await;
        assert!(s.head.unborn && s.head.oid.is_none());
        assert_eq!((s.head.branch.as_deref(), find(&s, "a.txt").kind.clone()), (Some("main"), ChangeKind::Added));
    }

    #[tokio::test]
    async fn change_kinds_staging_and_partial_staging() {
        let f = Fixture::new();
        for n in ["mod.txt", "both.txt", "del.txt", "ren-old.txt", "staged-del.txt"] {
            f.write(n, "line1\nline2\nline3\nline4\nline5\n");
        }
        f.commit_all("base");
        f.write("mod.txt", "changed\n");
        f.write("both.txt", "staged\nline2\nline3\nline4\nline5\n");
        f.git(&["add", "both.txt"]);
        f.write("both.txt", "staged\nline2\nline3\nline4\nworktree\n");
        std::fs::remove_file(f.root.join("del.txt")).unwrap();
        f.git(&["mv", "ren-old.txt", "ren-new.txt"]);
        f.git(&["rm", "-q", "staged-del.txt"]);
        f.write("added.txt", "new");
        f.git(&["add", "added.txt"]);
        f.write("untracked.txt", "u");
        let s = snap(&f).await;
        let tuple = |p: &str| {
            let c = find(&s, p);
            (c.kind.clone(), c.index_status.clone(), c.worktree_status.clone(), c.staged, c.partially_staged)
        };
        assert_eq!(tuple("mod.txt"), (ChangeKind::Modified, " ".into(), "M".into(), false, false));
        assert_eq!(tuple("both.txt"), (ChangeKind::Modified, "M".into(), "M".into(), true, true));
        assert_eq!(tuple("del.txt"), (ChangeKind::Deleted, " ".into(), "D".into(), false, false));
        assert_eq!(tuple("staged-del.txt"), (ChangeKind::Deleted, "D".into(), " ".into(), true, false));
        assert_eq!(tuple("added.txt"), (ChangeKind::Added, "A".into(), " ".into(), true, false));
        assert_eq!(tuple("untracked.txt"), (ChangeKind::Untracked, " ".into(), "?".into(), false, false));
        let r = find(&s, "ren-new.txt");
        assert_eq!((r.kind.clone(), r.orig_path.as_deref()), (ChangeKind::Renamed, Some("ren-old.txt")));
        assert_eq!(find(&s, "untracked.txt").size_bytes, Some(1));
        assert!(find(&s, "mod.txt").size_bytes.is_none());
    }

    #[tokio::test]
    async fn untracked_dirs_are_collapsed_and_guard_applies() {
        let f = Fixture::new();
        f.write(".gitignore", "ignored/\n");
        f.write("ignored/x", "x");
        f.write("newdir/a.txt", "a");
        f.write("newdir/sub/b.txt", "b");
        f.write("dump_old/c.sql", "c");
        f.write(".env", "S=1");
        f.write("big.bin", vec![0u8; 5 * 1024 * 1024 + 1]);
        f.write("árvíztűrő.txt", "hu");
        let s = snap(&f).await;
        let d = find(&s, "newdir/");
        assert_eq!((d.dir, d.kind.clone(), d.size_bytes), (Some(true), ChangeKind::Untracked, None));
        assert!(s.changes.iter().all(|c| !c.path.starts_with("ignored") && c.path != "newdir/a.txt"));
        assert_eq!(find(&s, "dump_old/").guard, GuardState::NeverAdd);
        assert_eq!(find(&s, ".env").guard, GuardState::Secret);
        assert_eq!(find(&s, "big.bin").guard, GuardState::TooLarge);
        assert_eq!(find(&s, "newdir/").guard, GuardState::Ok);
        let nfc = "árvíztűrő.txt";
        assert_eq!(nfc, nfc.chars().collect::<String>());
        assert_eq!(find(&s, nfc).guard, GuardState::Ok);
    }

    #[tokio::test]
    async fn list_untracked_below_a_collapsed_dir() {
        let f = Fixture::new();
        for i in 0..30 {
            f.write(&format!("newdir/f{i:02}.txt"), "x");
        }
        f.write("newdir/nested/deep.txt", "x");
        f.write("newdir/dump_x.txt", "x");
        f.write("other/y.txt", "y");
        let c = ctx();
        let cfg = f.config();
        let all = list_untracked_with(&c, &cfg, "newdir/", 100, fake_classify).await.unwrap();
        assert!(!all.truncated);
        assert_eq!(all.files.len(), 32);
        assert!(all.files.iter().all(|c| c.path.starts_with("newdir/") && c.kind == ChangeKind::Untracked && c.dir.is_none()));
        assert!(all.files.iter().any(|c| c.path == "newdir/nested/deep.txt"));
        let dump = all.files.iter().find(|c| c.path == "newdir/dump_x.txt").unwrap();
        assert_eq!((dump.guard.clone(), dump.size_bytes), (GuardState::NeverAdd, Some(1)));
        let some = list_untracked_with(&c, &cfg, "newdir", 10, fake_classify).await.unwrap();
        assert_eq!((some.files.len(), some.truncated), (10, true));
        let exact = list_untracked_with(&c, &cfg, "newdir/", 32, fake_classify).await.unwrap();
        assert_eq!((exact.files.len(), exact.truncated), (32, false));
        let none = list_untracked_with(&c, &cfg, "newdir/", 0, fake_classify).await.unwrap();
        assert_eq!((none.files.len(), none.truncated), (0, true));
        // glob characters in the directory name are literal
        f.write("[x]/a.txt", "a");
        f.write("x/b.txt", "b");
        let lit = list_untracked_with(&c, &cfg, "[x]/", 10, fake_classify).await.unwrap();
        assert_eq!(lit.files.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), vec!["[x]/a.txt"]);
    }

    #[tokio::test]
    async fn list_untracked_rejects_escaping_paths() {
        let f = Fixture::new();
        std::os::unix::fs::symlink(f.dir.path(), f.root.join("escape")).unwrap();
        for bad in ["../", "/etc", "escape/sub/", "a/../../b"] {
            let e = list_untracked_with(&ctx(), &f.config(), bad, 10, fake_classify).await.unwrap_err();
            assert_eq!(e.code, code::INVALID_SELECTION, "{bad}");
        }
    }

    #[tokio::test]
    async fn upstream_ahead_behind_and_gone() {
        let f = Fixture::new();
        let bare = tempfile::tempdir().unwrap();
        let bare_path = bare.path().join("remote.git");
        let out = std::process::Command::new(crate::exec::pinned_git_path())
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(&bare_path)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap();
        assert!(out.status.success());
        f.git(&["remote", "add", "origin", &bare_path.to_string_lossy()]);
        f.git(&["push", "-q", "-u", "origin", "main"]);
        f.write("a.txt", "a");
        f.commit_all("second");
        let s = snap(&f).await;
        assert_eq!((s.ahead, s.behind), (1, 0));
        assert_eq!(s.upstream, Some(UpstreamInfo { remote: "origin".into(), branch: "main".into(), gone: false }));
        f.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
        let s = snap(&f).await;
        assert_eq!(s.upstream.map(|u| u.gone), Some(true));
        assert_eq!((s.ahead, s.behind), (0, 0));
    }

    #[tokio::test]
    async fn repo_state_markers() {
        let f = Fixture::new();
        for (marker, expected) in [
            ("MERGE_HEAD", RepoState::Merging),
            ("CHERRY_PICK_HEAD", RepoState::CherryPicking),
            ("REVERT_HEAD", RepoState::Reverting),
            ("BISECT_LOG", RepoState::Bisecting),
            ("rebase-merge/", RepoState::Rebasing),
            ("rebase-apply/", RepoState::Rebasing),
        ] {
            let p = f.root.join(".git").join(marker);
            if marker.ends_with('/') {
                std::fs::create_dir_all(&p).unwrap();
            } else {
                std::fs::write(&p, "x").unwrap();
            }
            assert_eq!(snap(&f).await.state, expected, "{marker}");
            if marker.ends_with('/') {
                std::fs::remove_dir_all(&p).unwrap();
            } else {
                std::fs::remove_file(&p).unwrap();
            }
        }
        assert_eq!(snap(&f).await.state, RepoState::Normal);
    }

    #[tokio::test]
    async fn real_merge_conflict_is_reported_as_conflicted_in_merging_state() {
        let f = Fixture::new();
        f.write("c.txt", "base\n");
        f.commit_all("base");
        f.git(&["checkout", "-q", "-b", "other"]);
        f.write("c.txt", "other\n");
        f.commit_all("other");
        f.git(&["checkout", "-q", "main"]);
        f.write("c.txt", "main\n");
        f.commit_all("main");
        let merge = f.cmd(&["merge", "other"]).output().unwrap();
        assert!(!merge.status.success());
        let s = snap(&f).await;
        assert_eq!(s.state, RepoState::Merging);
        let c = find(&s, "c.txt");
        assert_eq!((c.kind.clone(), c.index_status.as_str(), c.worktree_status.as_str(), c.staged), (ChangeKind::Conflicted, "U", "U", false));
    }

    #[tokio::test]
    async fn stash_and_worktree_counts_without_extra_spawns() {
        let f = Fixture::new();
        f.write("a.txt", "a");
        f.commit_all("a");
        for i in 0..2 {
            f.write("a.txt", format!("v{i}"));
            f.git(&["stash", "push", "-q"]);
        }
        let wt = f.dir.path().join("wt1");
        f.git(&["worktree", "add", "-q", "-b", "side", &wt.to_string_lossy()]);
        let s = snap(&f).await;
        assert_eq!((s.stash_count, s.worktree_count), (2, 1));
        // the linked worktree itself: its own state, shared stash, and git dirs resolved through the .git file
        let linked = snapshot_with(&ctx(), &repo_config(&wt), fake_classify).await.unwrap();
        assert_eq!((linked.head.branch.as_deref(), linked.stash_count), (Some("side"), 2));
        let dirs = find_git_dirs(&wt).unwrap();
        assert_ne!(dirs.git_dir, dirs.common_dir);
        assert!(dirs.common_dir.ends_with(".git"));
    }

    #[tokio::test]
    async fn hooks_detection() {
        let f = Fixture::new();
        assert_eq!(snap(&f).await.hooks, HookInfo { kind: HookKind::None, path: None }, "sample hooks do not count");
        let hook = f.root.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\n").unwrap();
        assert_eq!(snap(&f).await.hooks.kind, HookKind::None, "non-executable file does not count");
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let h = snap(&f).await.hooks;
        assert_eq!(h.kind, HookKind::Custom);
        assert!(h.path.unwrap().ends_with(".git/hooks"));
        f.git(&["config", "core.hooksPath", ".husky/_"]);
        assert_eq!(snap(&f).await.hooks, HookInfo { kind: HookKind::Husky, path: Some(".husky/_".into()) });
        f.git(&["config", "core.hooksPath", "tools/hooks"]);
        assert_eq!(snap(&f).await.hooks, HookInfo { kind: HookKind::Custom, path: Some("tools/hooks".into()) });
    }

    #[tokio::test]
    async fn errors_for_missing_and_non_repos() {
        let f = Fixture::new();
        let missing = repo_config(&f.root.join("nope"));
        assert_eq!(snapshot_with(&ctx(), &missing, fake_classify).await.unwrap_err().code, code::REPO_MISSING);
        let plain = tempfile::tempdir().unwrap();
        let mut cfg = repo_config(plain.path());
        cfg.path = plain.path().to_string_lossy().into_owned();
        let e = snapshot_with(&ctx(), &cfg, fake_classify).await.unwrap_err();
        assert_eq!(e.code, code::NOT_A_REPO, "{e:?}");
    }

    #[tokio::test]
    async fn snapshot_uses_the_real_guard() {
        let f = Fixture::new();
        f.write(".env", "S=1");
        f.write("dump_a/x", "x");
        f.write("ok.txt", "x");
        let s = snapshot(&ctx(), &f.config()).await.unwrap();
        assert_eq!(find(&s, ".env").guard, GuardState::Secret);
        assert_eq!(find(&s, "dump_a/").guard, GuardState::NeverAdd);
        assert_eq!(find(&s, "ok.txt").guard, GuardState::Ok);
    }

    #[tokio::test]
    async fn tracked_secret_names_are_sensitive_and_new_ones_stay_blocked() {
        let f = Fixture::new();
        f.write(".npmrc", "registry=a\n");
        f.write("dump_a/x", "x");
        f.commit_all("tracked");
        f.write(".npmrc", "registry=b\n");
        f.write("dump_a/x", "y");
        f.write("sub/.npmrc", "new\n");
        f.write("id_rsa", "new\n");
        f.git(&["add", "id_rsa"]);
        let s = snapshot(&ctx(), &f.config()).await.unwrap();
        assert_eq!(find(&s, ".npmrc").guard, GuardState::Sensitive);
        assert_eq!(find(&s, "dump_a/x").guard, GuardState::Ok);
        assert_eq!(find(&s, "sub/").guard, GuardState::Ok);
        assert_eq!(find(&s, "id_rsa").guard, GuardState::Secret);
    }

    /// `cargo test -p intely-core status_latency -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "measurement"]
    async fn status_latency() {
        use std::time::Instant;
        let f = Fixture::new();
        for i in 0..5000 {
            f.write(&format!("src/m{:02}/f{i}.txt", i % 50), format!("content {i}\n"));
        }
        f.commit_all("5000 files");
        for i in (0..5000).step_by(2) {
            f.write(&format!("src/m{:02}/f{i}.txt", i % 50), format!("changed {i}\n"));
        }
        for i in 0..200 {
            f.write(&format!("new/n{i}.txt"), "n");
        }
        let (c, cfg) = (ctx(), f.config());
        let mut times = Vec::new();
        for _ in 0..5 {
            let t = Instant::now();
            let s = snapshot(&c, &cfg).await.unwrap();
            times.push(t.elapsed());
            assert_eq!(s.changes.len(), 2500 + 1);
        }
        eprintln!("status 5,000 tracked files (2,500 modified + 1 collapsed dir): {times:?}");

        let h = Fixture::new();
        for i in 0..100_000 {
            let p = h.root.join(format!("huge/d{:03}/f{i}.dat", i % 500));
            if i < 500 {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            }
            std::fs::write(p, b"x").unwrap_or_else(|_| {
                std::fs::create_dir_all(h.root.join(format!("huge/d{:03}", i % 500))).unwrap();
                std::fs::write(h.root.join(format!("huge/d{:03}/f{i}.dat", i % 500)), b"x").unwrap();
            });
        }
        let (cfg, mut times) = (h.config(), Vec::new());
        for _ in 0..3 {
            let t = Instant::now();
            let s = snapshot(&c, &cfg).await.unwrap();
            times.push(t.elapsed());
            assert_eq!(s.changes.len(), 1);
        }
        eprintln!("status with a 100,000-file untracked dir: {times:?}");
        let t = Instant::now();
        let l = list_untracked(&c, &cfg, "huge/", 5000).await.unwrap();
        eprintln!("list_untracked(limit 5000) on it: {:?} (truncated: {}, files: {})", t.elapsed(), l.truncated, l.files.len());
    }
}
