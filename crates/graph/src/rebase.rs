//! Interactive rebase and cherry-pick. The rebase runs the real `git rebase -i` with a `GIT_SEQUENCE_EDITOR` that
//! installs our todo list and a `GIT_EDITOR` that supplies the prepared commit messages, so git does all the work and
//! reports conflicts the usual way. The scripts live in the temp directory, never in the repository.

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use intely_core::jail::{matches_live, LIVE_BRANCH_CONFIRM};
use intely_core::EngineError;

use crate::env::{check_oid, git_error, invalid, Env};
use crate::types::{InProgressOp, OpOutcome, OpStatus, RebaseAction, RebasePlan, RebaseStep};

pub const DIRTY_TREE: &str = "dirtyTree";
pub const OP_IN_PROGRESS: &str = "opInProgress";
pub const NOTHING_IN_PROGRESS: &str = "nothingInProgress";
pub const CONFLICTS_REMAIN: &str = "conflictsRemain";
pub const DETACHED_HEAD: &str = "detachedHead";
pub const UNSUPPORTED_RANGE: &str = "unsupportedRange";
const MAX_STEPS: usize = 500;

async fn git_path(env: &Env, repo: &Path, name: &str) -> Result<PathBuf, EngineError> {
    let out = env.read(repo, &["rev-parse", "--git-path", name]).await?;
    Ok(repo.join(out.trim()))
}

async fn current_branch(env: &Env, repo: &Path) -> Result<Option<String>, EngineError> {
    let out = env.run(repo, &["symbolic-ref", "-q", "--short", "HEAD"]).await?;
    Ok(out.success().then(|| out.stdout_text().trim().to_owned()))
}

async fn head_oid(env: &Env, repo: &Path) -> Option<String> {
    env.read(repo, &["rev-parse", "--verify", "-q", "HEAD"]).await.ok().map(|s| s.trim().to_owned())
}

async fn read_count(path: PathBuf) -> u32 {
    tokio::fs::read_to_string(path).await.ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

/// Whether a rebase or cherry-pick is in progress in `repo_id`, and where it stands.
pub async fn op_state(env: &Env, repo_id: &str) -> Result<OpOutcome, EngineError> {
    let repo = env.path(repo_id)?;
    let (kind, step, total) = if git_path(env, &repo, "rebase-merge").await?.is_dir() {
        let dir = git_path(env, &repo, "rebase-merge").await?;
        (InProgressOp::Rebase, read_count(dir.join("msgnum")).await, read_count(dir.join("end")).await)
    } else if git_path(env, &repo, "rebase-apply").await?.is_dir() {
        let dir = git_path(env, &repo, "rebase-apply").await?;
        (InProgressOp::Rebase, read_count(dir.join("next")).await, read_count(dir.join("last")).await)
    } else if git_path(env, &repo, "CHERRY_PICK_HEAD").await?.exists() || git_path(env, &repo, "sequencer").await?.is_dir() {
        (InProgressOp::CherryPick, 0, 0)
    } else {
        (InProgressOp::None, 0, 0)
    };
    let conflict_files: Vec<String> = if kind == InProgressOp::None {
        Vec::new()
    } else {
        env.read(&repo, &["diff", "--name-only", "--diff-filter=U", "-z"]).await?.split('\0').filter(|p| !p.is_empty()).map(str::to_owned).collect()
    };
    let status = match (&kind, conflict_files.is_empty()) {
        (InProgressOp::None, _) => OpStatus::Idle,
        (_, false) => OpStatus::Conflict,
        (_, true) => OpStatus::Stopped,
    };
    Ok(OpOutcome { repo_id: repo_id.to_owned(), kind, status, step, total, conflict_files, head: head_oid(env, &repo).await, message: None })
}

async fn ensure_idle(env: &Env, repo_id: &str) -> Result<(), EngineError> {
    match op_state(env, repo_id).await?.kind {
        InProgressOp::None => Ok(()),
        _ => Err(EngineError::new(OP_IN_PROGRESS, "a rebase or cherry-pick is already in progress in this repository")),
    }
}

async fn ensure_clean(env: &Env, repo: &Path) -> Result<(), EngineError> {
    let status = env.read(repo, &["status", "--porcelain", "--untracked-files=no"]).await?;
    if status.trim().is_empty() {
        Ok(())
    } else {
        Err(EngineError::new(DIRTY_TREE, "the working tree has uncommitted changes to tracked files: commit or stash them first"))
    }
}

/// History rewriting on a protected or live branch needs its exact name typed by the human (docs/safety.md, layer 6).
fn ensure_confirmed(env: &Env, repo_id: &str, branch: &str, confirm: Option<&str>, what: &str) -> Result<(), EngineError> {
    if matches_live(&env.live_patterns(repo_id), None, branch) && confirm != Some(branch) {
        return Err(EngineError::new(
            LIVE_BRANCH_CONFIRM,
            format!("'{branch}' is a live branch: type its exact name to confirm the {what}"),
        ));
    }
    Ok(())
}

/// The first line of every commit message of `onto..HEAD`, oldest first, with the full oid.
struct RangeCommit {
    oid: String,
    first_line: String,
}

async fn range_commits(env: &Env, repo: &Path, onto: &str) -> Result<Vec<RangeCommit>, EngineError> {
    let range = format!("{onto}..HEAD");
    let merges = env.read(repo, &["rev-list", "--merges", "--count", &range]).await?;
    if merges.trim() != "0" {
        return Err(EngineError::new(UNSUPPORTED_RANGE, "the range contains merge commits; rebasing merges is not supported yet"));
    }
    let out = env.read(repo, &["log", "--reverse", "--format=%H%x00%B%x1e", &range]).await?;
    Ok(out
        .split('\x1e')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|r| {
            let (oid, message) = r.trim_start().split_once('\0')?;
            Some(RangeCommit { oid: oid.to_owned(), first_line: message.lines().next().unwrap_or_default().to_owned() })
        })
        .collect())
}

async fn resolve_onto(env: &Env, repo: &Path, onto: &str) -> Result<String, EngineError> {
    crate::env::check_rev(onto)?;
    let spec = format!("{onto}^{{commit}}");
    Ok(env.read(repo, &["rev-parse", "--verify", "--end-of-options", &spec]).await?.trim().to_owned())
}

/// The commits `onto..HEAD` as an all-`pick` plan, oldest first.
pub async fn plan(env: &Env, repo_id: &str, onto: &str) -> Result<RebasePlan, EngineError> {
    let repo = env.path(repo_id)?;
    if current_branch(env, &repo).await?.is_none() {
        return Err(EngineError::new(DETACHED_HEAD, "HEAD is not on a branch"));
    }
    let onto_oid = resolve_onto(env, &repo, onto).await?;
    let commits = range_commits(env, &repo, &onto_oid).await?;
    if commits.is_empty() {
        return Err(invalid(format!("there is nothing to rebase between {onto} and HEAD")));
    }
    if commits.len() > MAX_STEPS {
        return Err(invalid(format!("more than {MAX_STEPS} commits to rebase")));
    }
    Ok(RebasePlan {
        repo_id: repo_id.to_owned(),
        onto: onto.to_owned(),
        steps: commits
            .into_iter()
            .map(|c| RebaseStep { action: RebaseAction::Pick, oid: c.oid, subject: c.first_line, message: None })
            .collect(),
    })
}

/// Checks a plan against the real range: every step names a distinct commit of it, a squash or fixup has something to
/// fold into, a reword carries its message.
fn validate(plan: &RebasePlan, actual: &[RangeCommit]) -> Result<(), EngineError> {
    let known: HashSet<&str> = actual.iter().map(|c| c.oid.as_str()).collect();
    let mut seen = HashSet::new();
    let mut have_target = false;
    for step in &plan.steps {
        if !known.contains(step.oid.as_str()) {
            return Err(invalid(format!("{} is not a commit of the range being rebased", step.oid)));
        }
        if !seen.insert(step.oid.as_str()) {
            return Err(invalid(format!("{} appears twice in the plan", step.oid)));
        }
        match step.action {
            RebaseAction::Drop => {}
            RebaseAction::Squash | RebaseAction::Fixup if !have_target => {
                return Err(invalid("the first kept commit cannot be squashed or fixed up: there is nothing before it"));
            }
            _ => have_target = true,
        }
        let message = step.message.as_deref().map(str::trim);
        match (&step.action, message) {
            (RebaseAction::Reword, None | Some("")) => return Err(invalid(format!("reword of {} needs a message", step.oid))),
            (RebaseAction::Reword | RebaseAction::Squash, _) => {}
            (_, Some(_)) => return Err(invalid("only reword and squash steps take a message")),
            (_, None) => {}
        }
    }
    Ok(())
}

fn is_noop(plan: &RebasePlan, actual: &[RangeCommit]) -> bool {
    plan.steps.len() == actual.len()
        && plan.steps.iter().zip(actual).all(|(s, c)| s.action == RebaseAction::Pick && s.oid == c.oid)
}

/// Per repository path (two workspaces may use the same repo id) and stable across restarts, so `continue` finds it.
fn work_dir(repo_id: &str, repo: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let safe: String = repo_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    repo.hash(&mut hasher);
    std::env::temp_dir().join("intely-rebase").join(format!("{safe}-{:016x}", hasher.finish()))
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn write_script(path: &Path, body: &str) -> Result<(), EngineError> {
    std::fs::write(path, format!("#!/bin/sh\n{body}"))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

/// Writes the todo, the messages and both editor scripts; returns the environment for the git call.
fn prepare(dir: &Path, plan: &RebasePlan, actual: &[RangeCommit]) -> Result<Vec<(&'static str, String)>, EngineError> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir.join("q"))?;
    let first_line = |oid: &str| actual.iter().find(|c| c.oid == oid).map(|c| c.first_line.clone()).unwrap_or_default();

    let mut todo = String::new();
    // One editor session per chain (a pick or reword and the squashes and fixups folded into it), keyed by the first
    // line of the chain head's message, which is the first thing the editor shows.
    let mut queue: Vec<(String, String)> = Vec::new();
    let mut head_key: Option<String> = None;
    for step in &plan.steps {
        let verb = match step.action {
            RebaseAction::Pick => "pick",
            RebaseAction::Reword => "reword",
            RebaseAction::Squash => "squash",
            RebaseAction::Fixup => "fixup",
            RebaseAction::Drop => "drop",
        };
        todo.push_str(&format!("{verb} {} {}\n", step.oid, first_line(&step.oid)));
        match step.action {
            RebaseAction::Pick | RebaseAction::Reword => {
                head_key = Some(first_line(&step.oid));
                if let (RebaseAction::Reword, Some(m)) = (&step.action, &step.message) {
                    queue.push((first_line(&step.oid), m.trim().to_owned()));
                }
            }
            RebaseAction::Squash => {
                if let (Some(key), Some(m)) = (&head_key, &step.message) {
                    queue.retain(|(k, _)| k != key);
                    queue.push((key.clone(), m.trim().to_owned()));
                }
            }
            RebaseAction::Fixup | RebaseAction::Drop => {}
        }
    }
    std::fs::write(dir.join("todo"), todo)?;
    for (i, (key, message)) in queue.iter().enumerate() {
        std::fs::write(dir.join("q").join(i.to_string()), format!("{message}\n"))?;
        std::fs::write(dir.join("q").join(format!("{i}.key")), key)?;
    }
    write_script(&dir.join("seq.sh"), &format!("cat {} > \"$1\"\n", quote(&dir.join("todo"))))?;
    // The first not yet used message whose key equals the first non-comment line of the file being edited. Any other
    // editor session (for instance the one after resolving a conflict) keeps the message git prepared.
    write_script(
        &dir.join("edit.sh"),
        &format!(
            "f=\"$1\"\nq={q}\nkey=$(grep -v '^#' \"$f\" | sed -n '/./{{p;q;}}')\ni=0\nwhile [ -e \"$q/$i\" ]; do\n  if [ ! -e \"$q/$i.done\" ] && [ \"$(cat \"$q/$i.key\")\" = \"$key\" ]; then\n    cp \"$q/$i\" \"$f\"\n    : > \"$q/$i.done\"\n    exit 0\n  fi\n  i=$((i+1))\ndone\nexit 0\n",
            q = quote(&dir.join("q"))
        ),
    )?;
    Ok(editor_env(dir))
}

fn editor_env(dir: &Path) -> Vec<(&'static str, String)> {
    let mut env = Vec::new();
    if dir.join("edit.sh").exists() {
        env.push(("GIT_SEQUENCE_EDITOR", dir.join("seq.sh").to_string_lossy().into_owned()));
        env.push(("GIT_EDITOR", dir.join("edit.sh").to_string_lossy().into_owned()));
    }
    env
}

/// After a git call that may have stopped: done, stopped (keep the scripts for `continue`), or failed (clean up).
async fn outcome_after(env: &Env, repo_id: &str, what: &str, out: &intely_core::exec::GitOutput, dir: &Path) -> Result<OpOutcome, EngineError> {
    let mut state = op_state(env, repo_id).await?;
    if out.success() && state.status == OpStatus::Idle {
        let _ = std::fs::remove_dir_all(dir);
        state.status = OpStatus::Done;
        return Ok(state);
    }
    if state.status == OpStatus::Idle {
        let _ = std::fs::remove_dir_all(dir);
        return Err(git_error(what, out));
    }
    state.message = Some(out.stderr_text().trim().to_owned()).filter(|m| !m.is_empty());
    Ok(state)
}

pub async fn run(env: &Env, plan: &RebasePlan, confirm_live: Option<&str>) -> Result<OpOutcome, EngineError> {
    let repo = env.path(&plan.repo_id)?;
    env.git.jail.check_op("git rebase", &repo)?;
    ensure_idle(env, &plan.repo_id).await?;
    let Some(branch) = current_branch(env, &repo).await? else {
        return Err(EngineError::new(DETACHED_HEAD, "HEAD is not on a branch"));
    };
    ensure_confirmed(env, &plan.repo_id, &branch, confirm_live, "rebase")?;
    ensure_clean(env, &repo).await?;
    let onto = resolve_onto(env, &repo, &plan.onto).await?;
    let actual = range_commits(env, &repo, &onto).await?;
    validate(plan, &actual)?;
    if is_noop(plan, &actual) {
        let mut state = op_state(env, &plan.repo_id).await?;
        state.status = OpStatus::Done;
        return Ok(state);
    }
    let dir = work_dir(&plan.repo_id, &repo);
    let extra = prepare(&dir, plan, &actual)?;
    let args = ["rebase", "-i", "--no-autosquash", "--no-rebase-merges", "--no-update-refs", &onto];
    let out = env.write(&repo, &args, &extra).await?;
    outcome_after(env, &plan.repo_id, "git rebase", &out, &dir).await
}

async fn require_in_progress(env: &Env, repo_id: &str, kind: InProgressOp) -> Result<OpOutcome, EngineError> {
    let state = op_state(env, repo_id).await?;
    if state.kind != kind {
        return Err(EngineError::new(NOTHING_IN_PROGRESS, "there is nothing in progress to continue or abort"));
    }
    Ok(state)
}

pub async fn abort(env: &Env, repo_id: &str) -> Result<OpOutcome, EngineError> {
    let repo = env.path(repo_id)?;
    env.git.jail.check_op("git rebase --abort", &repo)?;
    require_in_progress(env, repo_id, InProgressOp::Rebase).await?;
    let out = env.write(&repo, &["rebase", "--abort"], &[]).await?;
    if !out.success() {
        return Err(git_error("git rebase --abort", &out));
    }
    let _ = std::fs::remove_dir_all(work_dir(repo_id, &repo));
    op_state(env, repo_id).await
}

pub async fn continue_(env: &Env, repo_id: &str) -> Result<OpOutcome, EngineError> {
    let repo = env.path(repo_id)?;
    env.git.jail.check_op("git rebase --continue", &repo)?;
    let state = require_in_progress(env, repo_id, InProgressOp::Rebase).await?;
    if !state.conflict_files.is_empty() {
        return Err(EngineError::new(CONFLICTS_REMAIN, format!("{} file(s) still have conflicts: resolve and stage them first", state.conflict_files.len())));
    }
    let dir = work_dir(repo_id, &repo);
    let out = env.write(&repo, &["rebase", "--continue"], &editor_env(&dir)).await?;
    outcome_after(env, repo_id, "git rebase --continue", &out, &dir).await
}

/// Applies `oids` (in the given order, oldest first) on top of the current branch. No `-x`: the messages stay as they are.
pub async fn cherry_pick(env: &Env, repo_id: &str, oids: &[String], confirm_live: Option<&str>) -> Result<OpOutcome, EngineError> {
    let repo = env.path(repo_id)?;
    env.git.jail.check_op("git cherry-pick", &repo)?;
    if oids.is_empty() || oids.len() > MAX_STEPS {
        return Err(invalid("cherry-pick needs between 1 and 500 commits"));
    }
    ensure_idle(env, repo_id).await?;
    let Some(branch) = current_branch(env, &repo).await? else {
        return Err(EngineError::new(DETACHED_HEAD, "HEAD is not on a branch"));
    };
    ensure_confirmed(env, repo_id, &branch, confirm_live, "cherry-pick")?;
    ensure_clean(env, &repo).await?;
    let mut full = Vec::new();
    for oid in oids {
        check_oid(oid)?;
        let spec = format!("{oid}^{{commit}}");
        let resolved = env.read(&repo, &["rev-parse", "--verify", "--end-of-options", &spec]).await?.trim().to_owned();
        let parents = env.read(&repo, &["rev-list", "--parents", "-n1", &resolved]).await?;
        if parents.split_whitespace().count() > 2 {
            return Err(EngineError::new(UNSUPPORTED_RANGE, format!("{oid} is a merge commit; cherry-picking merges is not supported")));
        }
        full.push(resolved);
    }
    let mut args = vec!["cherry-pick", "--end-of-options"];
    args.extend(full.iter().map(String::as_str));
    let out = env.write(&repo, &args, &[]).await?;
    outcome_after(env, repo_id, "git cherry-pick", &out, &work_dir(repo_id, &repo)).await
}

pub async fn cherry_pick_abort(env: &Env, repo_id: &str) -> Result<OpOutcome, EngineError> {
    let repo = env.path(repo_id)?;
    env.git.jail.check_op("git cherry-pick --abort", &repo)?;
    require_in_progress(env, repo_id, InProgressOp::CherryPick).await?;
    let out = env.write(&repo, &["cherry-pick", "--abort"], &[]).await?;
    if !out.success() {
        return Err(git_error("git cherry-pick --abort", &out));
    }
    op_state(env, repo_id).await
}

pub async fn cherry_pick_continue(env: &Env, repo_id: &str) -> Result<OpOutcome, EngineError> {
    let repo = env.path(repo_id)?;
    env.git.jail.check_op("git cherry-pick --continue", &repo)?;
    let state = require_in_progress(env, repo_id, InProgressOp::CherryPick).await?;
    if !state.conflict_files.is_empty() {
        return Err(EngineError::new(CONFLICTS_REMAIN, format!("{} file(s) still have conflicts: resolve and stage them first", state.conflict_files.len())));
    }
    let out = env.write(&repo, &["cherry-pick", "--continue"], &[]).await?;
    outcome_after(env, repo_id, "git cherry-pick --continue", &out, &work_dir(repo_id, &repo)).await
}
