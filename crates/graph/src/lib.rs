//! Tauri-free backend of the `graph` module: the multi-repo commit graph, blame, interactive rebase, cherry-pick, the
//! cross-repo branch matrix, bundles and commit message helpers. Types that cross the IPC boundary live in `types` and
//! are exported to `ui/src/bindings/graph.ts` by `pnpm bindings`.
//!
//! Every call takes an [`Env`] (the engine's git context plus a workspace snapshot), so all git processes go through
//! the exec layer and its jail (docs/safety.md). History-rewriting calls additionally need the typed confirmation on
//! protected and live branches.

pub mod blame;
pub mod branches;
pub mod bundles;
pub mod detail;
pub mod env;
pub mod lanes;
pub mod log;
pub mod message;
pub mod rebase;
pub mod types;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use intely_core::{EngineError, RepoId};

pub use env::Env;
pub use message::DraftModel;
use types::*;

/// The module's state: caches and the bundle store. Cheap to create; holds no git process.
pub struct Graph {
    blame: blame::BlameCache,
    bundles: bundles::BundleStore,
    model: RwLock<Option<Arc<dyn DraftModel>>>,
}

impl Graph {
    /// `data_dir` is where `graph-bundles.json` lives (the directory of the workspace file); `None` keeps bundles in memory.
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self { blame: blame::BlameCache::default(), bundles: bundles::BundleStore::new(data_dir), model: RwLock::new(None) }
    }

    /// Plugs in the utility model for `draft_message`; without one drafts are template-only.
    pub fn set_draft_model(&self, model: Option<Arc<dyn DraftModel>>) {
        *self.model.write().expect("model lock") = model;
    }

    pub async fn log_page(
        &self,
        env: &Env,
        repo_ids: &[RepoId],
        cursor: Option<&str>,
        filters: &LogFilters,
        limit: Option<u32>,
    ) -> Result<LogPage, EngineError> {
        log::log_page(env, repo_ids, cursor, filters, limit).await
    }

    pub async fn commit_detail(&self, env: &Env, repo_id: &str, oid: &str) -> Result<CommitDetail, EngineError> {
        detail::commit_detail(env, repo_id, oid).await
    }

    pub async fn file_history(&self, env: &Env, repo_id: &RepoId, path: &str) -> Result<Vec<GraphRow>, EngineError> {
        detail::file_history(env, repo_id, path).await
    }

    /// Blames the working-tree file, or the file at `rev`. Cached per file and resolved revision.
    pub async fn blame(&self, env: &Env, repo_id: &str, path: &str, rev: Option<&str>) -> Result<Vec<BlameLine>, EngineError> {
        Ok(blame::blame(env, &self.blame, repo_id, path, rev).await?.as_ref().clone())
    }

    pub async fn blame_caret(&self, env: &Env, repo_id: &str, path: &str, line: u32, rev: Option<&str>) -> Result<BlameCaret, EngineError> {
        blame::blame_caret(env, &self.blame, repo_id, path, line, rev).await
    }

    pub async fn rebase_plan(&self, env: &Env, repo_id: &str, onto: &str) -> Result<RebasePlan, EngineError> {
        rebase::plan(env, repo_id, onto).await
    }

    pub async fn rebase_run(&self, env: &Env, plan: &RebasePlan, confirm_live: Option<&str>) -> Result<OpOutcome, EngineError> {
        rebase::run(env, plan, confirm_live).await
    }

    pub async fn rebase_abort(&self, env: &Env, repo_id: &str) -> Result<OpOutcome, EngineError> {
        rebase::abort(env, repo_id).await
    }

    pub async fn rebase_continue(&self, env: &Env, repo_id: &str) -> Result<OpOutcome, EngineError> {
        rebase::continue_(env, repo_id).await
    }

    /// Whether a rebase or cherry-pick is in progress in the repo.
    pub async fn op_state(&self, env: &Env, repo_id: &str) -> Result<OpOutcome, EngineError> {
        rebase::op_state(env, repo_id).await
    }

    pub async fn cherry_pick(&self, env: &Env, repo_id: &str, oids: &[String], confirm_live: Option<&str>) -> Result<OpOutcome, EngineError> {
        rebase::cherry_pick(env, repo_id, oids, confirm_live).await
    }

    pub async fn cherry_pick_abort(&self, env: &Env, repo_id: &str) -> Result<OpOutcome, EngineError> {
        rebase::cherry_pick_abort(env, repo_id).await
    }

    pub async fn cherry_pick_continue(&self, env: &Env, repo_id: &str) -> Result<OpOutcome, EngineError> {
        rebase::cherry_pick_continue(env, repo_id).await
    }

    pub async fn branch_matrix(&self, env: &Env, repo_ids: &[RepoId]) -> Result<BranchMatrix, EngineError> {
        branches::matrix(env, repo_ids).await
    }

    pub async fn same_branch_create(&self, env: &Env, repo_ids: &[RepoId], name: &str, start: Option<&str>) -> Result<SameBranchResult, EngineError> {
        branches::same_branch_create(env, repo_ids, name, start).await
    }

    pub async fn same_branch_switch(&self, env: &Env, repo_ids: &[RepoId], name: &str) -> Result<SameBranchResult, EngineError> {
        branches::same_branch_switch(env, repo_ids, name).await
    }

    pub async fn bundles(&self, env: &Env, repo_ids: &[RepoId], window_ms: Option<i64>) -> Result<Vec<Bundle>, EngineError> {
        bundles::list(env, &self.bundles, repo_ids, window_ms).await
    }

    /// Links the commits one coordinated commit created. IDE state only: git and the messages are not touched.
    pub async fn bundle_record(&self, env: &Env, links: &[BundleLink], name: Option<&str>) -> Result<Bundle, EngineError> {
        bundles::record(env, &self.bundles, links, name).await
    }

    pub fn bundle_remove(&self, id: &str) -> Result<(), EngineError> {
        self.bundles.remove(id)
    }

    pub fn validate_message(&self, message: &str, style: &MessageStyle) -> MessageCheck {
        message::validate(message, style)
    }

    pub fn message_template(&self, style: &MessageStyle, subject: Option<&str>) -> String {
        message::template(style, subject)
    }

    pub async fn draft_message(&self, env: &Env, repo_id: &str, selection: &[SelectedPath]) -> Result<MessageDraft, EngineError> {
        let model = self.model.read().expect("model lock").clone();
        message::draft(env, model, repo_id, selection).await
    }
}
