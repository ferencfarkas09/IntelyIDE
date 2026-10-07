//! Serde types of the `ipc.files`, `ipc.search` and `ipc.branches` namespaces (camelCase, like `intely-core`).
//! Times are epoch milliseconds and sizes bytes, both as `f64` so they stay plain JS numbers.

use intely_core::GuardState;
use serde::{Deserialize, Serialize};

pub type RepoId = String;

/// A registered repository: its id and the folder every path of the id is jailed in.
#[derive(Debug, Clone)]
pub struct RepoRoot {
    pub id: RepoId,
    pub path: std::path::PathBuf,
}

// Omitting empty fields is a runtime nicety (`skip_serializing_if`); the TypeScript export cannot express it, so it
// only applies without the `specta` feature and the exported fields are marked optional instead.
#[cfg_attr(feature = "specta", allow(dead_code))]
fn is_false(b: &bool) -> bool {
    !*b
}

macro_rules! ipc_types {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

ipc_types! {
    #[derive(Copy, Eq)]
    #[serde(rename_all = "camelCase")]
    pub enum FileKind {
        File,
        Dir,
        Symlink,
    }

    #[derive(Copy, Eq)]
    #[serde(rename_all = "camelCase")]
    pub enum Eol {
        Lf,
        Crlf,
        Mixed,
        None,
    }

    /// How the bytes of a file map to text. Writing back with the same value keeps the file's encoding.
    #[derive(Copy, Eq)]
    pub enum Encoding {
        #[serde(rename = "utf8")]
        Utf8,
        #[serde(rename = "utf8Bom")]
        Utf8Bom,
        #[serde(rename = "utf16le")]
        Utf16Le,
        #[serde(rename = "utf16be")]
        Utf16Be,
        /// Fallback for bytes that are not UTF-8; every byte maps to the code point of the same value.
        #[serde(rename = "latin1")]
        Latin1,
        /// ISO-8859-2 (Central European, Hungarian); guessed for non-UTF-8 files with double-acute letters.
        #[serde(rename = "latin2")]
        Latin2,
        /// Windows-1250 (Central European); guessed for non-UTF-8 files with bytes in 0x80..=0x9F.
        #[serde(rename = "windows1250")]
        Windows1250,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DirEntry {
        pub name: String,
        pub kind: FileKind,
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub size: Option<f64>,
        /// Matched by .gitignore.
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "is_false"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub ignored: bool,
        /// Secret or generated file the IDE never opens (same guard as the commit panel).
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "is_false"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub never_read: bool,
        /// One-letter porcelain status ("M", "A", "D", "U" or "?"); a directory shows the strongest status below it.
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub git_status: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct FileRead {
        /// Absent for binary, too large or guarded files.
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub text: Option<String>,
        pub binary: bool,
        pub too_large: bool,
        pub size: f64,
        pub mtime_ms: f64,
        pub eol: Eol,
        pub encoding: Encoding,
        pub guard: GuardState,
    }

    #[serde(rename_all = "camelCase")]
    pub struct WriteResult {
        pub mtime_ms: f64,
    }

    #[derive(Copy, Eq)]
    #[serde(rename_all = "camelCase")]
    pub enum FileChangeKind {
        Created,
        Changed,
        Deleted,
    }

    #[serde(rename_all = "camelCase")]
    pub struct FileChanged {
        pub repo_id: RepoId,
        pub path: String,
        pub kind: FileChangeKind,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SearchOptions {
        /// Defaults to every repo of the workspace.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub repo_ids: Option<Vec<RepoId>>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub regex: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub case_sensitive: bool,
        /// Path glob limiting the files searched.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub glob: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SearchStarted {
        pub search_id: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SearchHit {
        pub repo_id: RepoId,
        pub path: String,
        /// 1-based.
        pub line: u32,
        /// 1-based column (in characters) of the match start.
        pub col: u32,
        pub preview: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SearchBatch {
        pub search_id: String,
        pub hits: Vec<SearchHit>,
        /// The last batch of a search carries `done` (also sent for a cancelled search).
        pub done: bool,
        /// The hit limit was reached; the search stopped early.
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "is_false"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub truncated: bool,
        /// Why a repo (or the whole search) could not be searched, e.g. an invalid regex.
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub error: Option<String>,
        /// A one-line hint for the user, sent with the last batch: ripgrep is not installed and `git grep` ran instead.
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub notice: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct BranchList {
        pub local: Vec<String>,
        pub remote: Vec<String>,
        /// `None` on a detached HEAD.
        pub current: Option<String>,
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub upstream: Option<String>,
        pub ahead: u32,
        pub behind: u32,
    }

    #[serde(rename_all = "camelCase")]
    pub struct StashEntry {
        pub index: u32,
        pub message: String,
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub branch: Option<String>,
        pub created_ms: f64,
    }

    #[derive(Copy, Eq)]
    #[serde(rename_all = "camelCase")]
    pub enum SwitchStatus {
        Switched,
        /// The repo has no such branch (or is already on it).
        Skipped,
        Failed,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SwitchOutcome {
        pub repo_id: RepoId,
        pub status: SwitchStatus,
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub code: Option<String>,
        #[serde(default)]
        #[cfg_attr(not(feature = "specta"), serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub error: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RollbackResult {
        /// Folder holding the patch of the discarded tracked changes and the moved untracked files.
        pub backup_path: String,
    }
}

#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default()
        .register::<DirEntry>()
        .register::<FileRead>()
        .register::<WriteResult>()
        .register::<FileChanged>()
        .register::<Encoding>()
        .register::<SearchOptions>()
        .register::<SearchStarted>()
        .register::<SearchHit>()
        .register::<SearchBatch>()
        .register::<BranchList>()
        .register::<StashEntry>()
        .register::<SwitchOutcome>()
        .register::<RollbackResult>()
}

#[cfg(all(test, feature = "specta"))]
mod tests {
    #[test]
    fn the_type_collection_exports_to_typescript() {
        specta_typescript::Typescript::default().export(&super::type_collection(), specta_serde::Format).expect("export");
    }
}
