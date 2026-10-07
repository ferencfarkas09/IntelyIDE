//! Wire types of the folder picker (camelCase, like `intely-core`); exported to `ui/src/bindings/pathpick.ts`.
//!
//! Error codes travel in `intely_core::EngineError::code` (see [`codes`]); no user-facing English crosses the wire.

use serde::{Deserialize, Serialize};

macro_rules! api_types {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

/// Error codes of this crate (a subset of the shared `EngineError.code` list in (design notes: workspaces-spec), Appendix B).
pub mod codes {
    pub const PATH_INVALID: &str = "pathInvalid";
    pub const NOT_FOUND: &str = "notFound";
    pub const VOLUME_MISSING: &str = "volumeMissing";
    pub const NOT_A_DIRECTORY: &str = "notADirectory";
    pub const NOT_A_FILE: &str = "notAFile";
    pub const PERMISSION_DENIED: &str = "permissionDenied";
    pub const TEST_JAIL: &str = "testJail";
    pub const READ_ONLY: &str = "readOnly";
    pub const TOKEN_EXPIRED: &str = "tokenExpired";
    pub const TOKEN_USED: &str = "tokenUsed";
    pub const WRONG_PURPOSE: &str = "wrongPurpose";
    pub const BARE_REPO: &str = "bareRepo";
    pub const NOT_GIT: &str = "notGit";
    pub const SCAN_TOO_BROAD: &str = "scanTooBroad";
    pub const NATIVE_FAILED: &str = "nativeFailed";
    pub const BUSY: &str = "busy";
    pub const PATH_NOT_VALIDATED: &str = "pathNotValidated";
    pub const RISK_CHANGED: &str = "riskChanged";
    pub const TOO_BROAD: &str = "tooBroad";
    pub const INIT_TOO_BROAD: &str = "initTooBroad";
    pub const IO: &str = "io";
    /// A filesystem call did not answer within its deadline (hung volume), or the mount is skipped for the session.
    pub const UNRESPONSIVE: &str = "unresponsive";
}

api_types! {
    #[derive(Copy, Eq, Hash)]
    #[serde(rename_all = "camelCase")]
    pub enum PathKind { Repo, Worktree, Submodule, Subfolder, Bare, GitDir, NotGit, Folder, File }

    #[derive(Copy, Eq, Hash)]
    #[serde(rename_all = "camelCase")]
    pub enum PickWarning {
        CloudFolder,
        Network,
        ExternalVolume,
        InsideIgnored,
        ForeignOwner,
        GitfileRedirect,
        HomeIsRepo,
        GitSymlink,
        /// Worktrees and submodules (the watcher and orphan sweep assume `.git` is a directory) until C2b ships.
        LimitedSupport,
    }

    #[derive(Copy, Eq, Hash)]
    #[serde(rename_all = "camelCase")]
    pub enum ProtectedFolder {
        Desktop,
        Documents,
        Downloads,
        Movies,
        Music,
        Pictures,
        Icloud,
        CloudStorage,
        Volume,
        Library,
    }

    #[derive(Copy, Eq, Hash)]
    #[serde(rename_all = "camelCase")]
    pub enum EntryKind { Dir, File, SymlinkDir, SymlinkFile, Other }

    /// A remote with credentials stripped: the host only.
    #[serde(rename_all = "camelCase")]
    pub struct PickedRemote {
        pub name: String,
        pub host: String,
    }

    /// A validated path plus a single-use token. `configRisks` holds key names only (never values): git config keys
    /// that can run programs, `hook:<name>` for executable hooks and `gitattributes.filter` for a filter attribute.
    #[serde(rename_all = "camelCase")]
    pub struct Picked {
        pub token: String,
        /// Canonical display path.
        pub path: String,
        /// NFC basename.
        pub name: String,
        pub kind: PathKind,
        /// `"{dev}:{ino}"` of the directory.
        pub identity: String,
        /// `subfolder`: the repository root; `gitDir`: the parent of the `.git` folder. Has its own token.
        pub root: Option<Box<Picked>>,
        /// Linked worktree: the main repository's common git directory (`commondir`).
        pub main: Option<String>,
        pub warnings: Vec<PickWarning>,
        pub config_risks: Vec<String>,
        pub remotes: Vec<PickedRemote>,
        pub branch: Option<String>,
        pub detached: bool,
        pub protected_folder: Option<ProtectedFolder>,
        pub via_symlink: bool,
        pub gitfile_target: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DirEntry {
        /// Exact on-disk name (build child paths from this).
        pub name: String,
        /// NFC form for display.
        pub label: String,
        pub kind: EntryKind,
        pub hidden: bool,
        /// `None` when not probed (protected parents and children, beyond the 400 probe cap).
        pub is_repo: Option<bool>,
        pub protected_folder: Option<ProtectedFolder>,
        pub package: bool,
        pub size: Option<f64>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DirListing {
        pub path: String,
        pub parent: Option<String>,
        pub entries: Vec<DirEntry>,
        pub truncated: bool,
        pub total_seen: u32,
        pub skipped_unreadable: u32,
        pub protected_folder: Option<ProtectedFolder>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ListOpts {
        #[serde(default)]
        pub hidden: bool,
        #[serde(default)]
        pub files: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub extensions: Option<Vec<String>>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct Place {
        pub id: String,
        pub label: String,
        pub path: String,
        pub exists: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct Volume {
        pub name: String,
        pub path: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct StartInfo {
        pub home: String,
        pub start_path: String,
        pub places: Vec<Place>,
        pub volumes: Vec<Volume>,
    }

    #[derive(Copy, Eq, Hash)]
    #[serde(rename_all = "camelCase")]
    pub enum PickerMode { Off, ReadOnly, E2e }

    #[serde(rename_all = "camelCase")]
    pub struct Capabilities {
        pub native: bool,
        pub fake: bool,
        pub mode: PickerMode,
    }

    #[derive(Copy, Eq, Hash)]
    #[serde(rename_all = "camelCase")]
    pub enum NativeKind { Folder, Folders, File, Files }

    /// What the webview may ask of the native dialog. The start folder is never part of it (5.3).
    #[serde(rename_all = "camelCase")]
    pub struct NativeOptions {
        pub kind: NativeKind,
        /// `workspaceRoot | workspaceRepo | scanRoot | file:<field>`
        pub purpose: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub title: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub extensions: Option<Vec<String>>,
        /// A token from an earlier pick whose folder becomes the dialog's start folder.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub start_token: Option<String>,
    }

    #[derive(Copy, Eq, Hash)]
    #[serde(rename_all = "camelCase")]
    pub enum ScanReason { Depth, Repos, Dirs, Time }

    #[serde(rename_all = "camelCase")]
    pub struct ScanProgress {
        pub scan_id: String,
        pub visited: u32,
        pub found: u32,
        pub done: bool,
        pub cancelled: bool,
        pub truncated: bool,
        pub reason: Option<ScanReason>,
        pub skipped_protected: Vec<String>,
        pub skipped_symlinks: u32,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ScanOpts {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub depth: Option<u32>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub max_repos: Option<u32>,
        #[serde(default)]
        pub include_hidden: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ScanStarted {
        pub scan_id: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ScanResults {
        pub repos: Vec<Picked>,
        pub next: u32,
        /// The scan's latest progress: a small scan can finish before the page has subscribed to `picker:scan`.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub progress: Option<ScanProgress>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DropEvent {
        pub count: u32,
    }
}

#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default()
        .register::<Picked>()
        .register::<DirEntry>()
        .register::<DirListing>()
        .register::<ListOpts>()
        .register::<StartInfo>()
        .register::<Capabilities>()
        .register::<NativeOptions>()
        .register::<ScanProgress>()
        .register::<ScanOpts>()
        .register::<ScanStarted>()
        .register::<ScanResults>()
        .register::<DropEvent>()
}

#[cfg(all(test, feature = "specta"))]
mod tests {
    #[test]
    fn the_type_collection_exports_to_typescript() {
        specta_typescript::Typescript::default().export(&super::type_collection(), specta_serde::Format).expect("export");
    }
}
