//! What the picker may look at: the jail, the home folder, the effective user and the IDE state directory.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use intely_core::jail::{canon_lenient, Jail, Mode};
use intely_core::EngineError;

use crate::types::codes;

#[derive(Clone)]
pub struct Policy {
    pub jail: Arc<Jail>,
    pub home: PathBuf,
    pub uid: u32,
    pub state_dir: PathBuf,
}

impl Policy {
    pub fn new(jail: Arc<Jail>, home: PathBuf, state_dir: PathBuf) -> Self {
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() } as u32;
        Self { jail, home, uid, state_dir }
    }

    /// The process-wide policy: `$HOME` and the IDE state directory (`INTELY_WORKSPACES` is honoured only under a jail).
    pub fn real(jail: Arc<Jail>) -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
        let home = canon_lenient(&home);
        let state_dir = state_dir_for(&jail, &home, |k| std::env::var(k).ok());
        Self::new(jail, home, state_dir)
    }

    /// Test hook: pretend files belong to another user.
    pub fn with_uid(mut self, uid: u32) -> Self {
        self.uid = uid;
        self
    }

    pub fn mode(&self) -> Mode {
        self.jail.mode()
    }

    /// Off and ReadOnly allow every read; E2e requires the canonical path to be below the fixture root.
    pub fn check_read(&self, canonical: &Path) -> Result<(), EngineError> {
        match self.jail.mode() {
            Mode::E2e if !self.jail.in_fixture(canonical) => {
                Err(EngineError::new(codes::TEST_JAIL, "outside the test fixture folder"))
            }
            _ => Ok(()),
        }
    }

    /// Where the picker starts: the user's home, or the fixture root in e2e mode.
    pub fn start_root(&self) -> PathBuf {
        match (self.jail.mode(), self.jail.fixture_root()) {
            (Mode::E2e, Some(root)) => root.to_path_buf(),
            _ => self.home.clone(),
        }
    }
}

fn state_dir_for(jail: &Jail, home: &Path, var: impl Fn(&str) -> Option<String>) -> PathBuf {
    if jail.is_active() {
        if let Some(reg) = var("INTELY_WORKSPACES").filter(|v| !v.is_empty()) {
            if let Some(parent) = Path::new(&reg).parent() {
                return canon_lenient(parent);
            }
        }
    }
    if let Some(dir) = var("INTELY_DATA_DIR").filter(|v| !v.is_empty()) {
        return canon_lenient(Path::new(&dir));
    }
    home.join("Library/Application Support/IntelySwitchIDE")
}
