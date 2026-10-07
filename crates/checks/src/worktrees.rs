//! Worktree manager (#21). Listing is read-only and shows every worktree (the admin repo has six Cursor ones under
//! `~/.cursor`); creating and removing only touch worktrees the IDE made itself: they live under the IDE's own
//! directory, are recorded in `worktrees.json`, and need the worktree name typed as confirmation. There is no prune
//! and no force: a worktree the IDE does not own is never removed, a dirty one is refused by git.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use intely_core::jail::{canon_lenient, Jail};
use intely_core::{code, EngineError};
use serde::{Deserialize, Serialize};

use crate::git::{self, ref_exists};
use crate::types::WorktreeRow;

fn err(code_: &str, msg: impl Into<String>) -> EngineError {
    EngineError::new(code_, msg.into())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owned {
    repo_id: String,
    path: String,
    name: String,
    branch: String,
    created_at: u64,
    run_id: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    owned: Vec<Owned>,
}

#[derive(Debug, Clone, Default)]
pub struct CreateRequest {
    pub name: String,
    /// Commit-ish to branch from; `HEAD` when empty.
    pub base: Option<String>,
    /// The agent run the worktree is for, kept in the state for the UI.
    pub run_id: Option<String>,
    pub confirm: String,
}

/// Worktrees the IDE created live under `<data dir>/worktrees/<repoId>/<name>`; `worktrees.json` beside it records them.
pub struct WorktreeStore {
    root: PathBuf,
    file: PathBuf,
}

fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 48 && !n.starts_with(['-', '.']) && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn valid_base(b: &str) -> bool {
    !b.is_empty() && !b.starts_with('-') && b.len() <= 200 && b.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '~' | '^' | '@'))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

impl WorktreeStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("worktrees"), file: data_dir.join("worktrees.json") }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn load(&self) -> State {
        fs::read_to_string(&self.file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    fn save(&self, state: &State) -> Result<(), EngineError> {
        let io = |e: std::io::Error| err(code::IO, format!("could not save the worktree state: {e}"));
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(io)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(state).unwrap_or_default()).map_err(io)?;
        fs::rename(&tmp, &self.file).map_err(io)
    }

    fn same(a: &str, b: &Path) -> bool {
        canon_lenient(Path::new(a)) == canon_lenient(b)
    }

    /// Every worktree of the repo; read-only.
    pub fn list(&self, jail: &Jail, repo_id: &str, repo: &Path) -> Result<Vec<WorktreeRow>, EngineError> {
        let text = git::read(jail, repo, &["worktree", "list", "--porcelain"])?;
        let state = self.load();
        let mut rows = Vec::new();
        for (i, block) in text.split("\n\n").filter(|b| !b.trim().is_empty()).enumerate() {
            let mut row = WorktreeRow { path: String::new(), name: String::new(), head: String::new(), branch: None, detached: false, locked: false, prunable: false, main: i == 0, owned: false, external: None };
            for l in block.lines() {
                if let Some(p) = l.strip_prefix("worktree ") {
                    row.path = p.to_owned();
                } else if let Some(h) = l.strip_prefix("HEAD ") {
                    row.head = h.chars().take(9).collect();
                } else if let Some(b) = l.strip_prefix("branch ") {
                    row.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_owned());
                } else if l == "detached" {
                    row.detached = true;
                } else if l.starts_with("locked") {
                    row.locked = true;
                } else if l.starts_with("prunable") {
                    row.prunable = true;
                }
            }
            if row.path.is_empty() {
                continue;
            }
            row.name = row.path.rsplit('/').next().unwrap_or("").to_owned();
            row.owned = !row.main && state.owned.iter().any(|o| o.repo_id == repo_id && Self::same(&o.path, Path::new(&row.path)));
            if !row.main && !row.owned {
                row.external = Some(if row.path.contains("/.cursor/") { "cursor" } else { "other" }.to_owned());
            }
            rows.push(row);
        }
        Ok(rows)
    }

    /// A new worktree and branch `intely/<name>` under the IDE's directory.
    pub fn create(&self, jail: &Jail, repo_id: &str, repo: &Path, req: &CreateRequest) -> Result<WorktreeRow, EngineError> {
        if !valid_name(&req.name) {
            return Err(err("invalidName", "use 1-48 letters, digits, '-', '_' or '.', not starting with '-' or '.'"));
        }
        if req.confirm != req.name {
            return Err(err("confirmRequired", format!("type {} to confirm", req.name)));
        }
        let base = req.base.as_deref().map(str::trim).filter(|b| !b.is_empty()).unwrap_or("HEAD");
        if !valid_base(base) {
            return Err(err("invalidName", "that is not a usable starting point"));
        }
        let repo_dir: String = repo_id.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') { c } else { '_' }).collect();
        let target = self.root.join(&repo_dir).join(&req.name);
        let branch = format!("intely/{}", req.name);
        jail.check_op("worktree add", repo)?;
        jail.check_op("worktree add", &target)?;
        if target.exists() {
            return Err(err("exists", format!("{} already exists", target.display())));
        }
        if ref_exists(jail, repo, &format!("refs/heads/{branch}")) {
            return Err(err("exists", format!("the branch {branch} already exists")));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| err(code::IO, format!("could not create {}: {e}", parent.display())))?;
        }
        let target_s = target.to_string_lossy().into_owned();
        let o = git::run(jail, repo, &["worktree", "add", "-b", &branch, &target_s, base])?;
        if !o.ok {
            return Err(err(code::IO, o.stderr.trim().to_owned()));
        }
        let mut state = self.load();
        state.owned.push(Owned { repo_id: repo_id.to_owned(), path: target_s.clone(), name: req.name.clone(), branch: branch.clone(), created_at: now(), run_id: req.run_id.clone() });
        if let Err(e) = self.save(&state) {
            let _ = git::run(jail, repo, &["worktree", "remove", &target_s]);
            return Err(e);
        }
        self.list(jail, repo_id, repo)?.into_iter().find(|w| Self::same(&w.path, &target)).ok_or_else(|| err(code::IO, "the worktree was created but is not listed"))
    }

    /// Removes an IDE-owned worktree after its name was typed. Never forces, never prunes; its branch is left for the
    /// branch hygiene list.
    pub fn remove(&self, jail: &Jail, repo_id: &str, repo: &Path, path: &str, confirm: &str) -> Result<String, EngineError> {
        let mut state = self.load();
        let at = state.owned.iter().position(|o| o.repo_id == repo_id && Self::same(&o.path, Path::new(path)));
        let Some(at) = at else {
            return Err(err("notOwned", "only worktrees created by the IDE can be removed here"));
        };
        let rec = state.owned[at].clone();
        let inside = canon_lenient(Path::new(&rec.path)).starts_with(canon_lenient(&self.root));
        if !inside {
            return Err(err("notOwned", "that worktree is outside the IDE's worktree directory"));
        }
        if confirm != rec.name {
            return Err(err("confirmRequired", format!("type {} to confirm", rec.name)));
        }
        jail.check_op("worktree remove", repo)?;
        jail.check_op("worktree remove", Path::new(&rec.path))?;
        let listed = self.list(jail, repo_id, repo)?.iter().any(|w| Self::same(&w.path, Path::new(&rec.path)));
        if listed {
            let o = git::run(jail, repo, &["worktree", "remove", &rec.path])?;
            if !o.ok {
                return Err(err(code::IO, o.stderr.trim().to_owned()));
            }
        }
        state.owned.remove(at);
        self.save(&state)?;
        Ok(format!("Removed the worktree {}. Its branch {} is kept.", rec.name, rec.branch))
    }
}
