#![allow(dead_code)]
//! Fixture helpers: folders built by writing the files git would write (no git process), under a canonical tempdir.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use intely_core::jail::Jail;
use intely_pathpick::{PathTokens, Policy, Purpose, Validator};

pub struct Fx {
    pub _dir: tempfile::TempDir,
    pub root: PathBuf,
    pub home: PathBuf,
    pub state: PathBuf,
}

impl Fx {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let home = root.join("home");
        let state = root.join("home/Library/Application Support/IntelySwitchIDE");
        fs::create_dir_all(&home).unwrap();
        Self { _dir: dir, root, home, state }
    }

    pub fn policy(&self, jail: Jail) -> Policy {
        Policy::new(Arc::new(jail), self.home.clone(), self.state.clone())
    }

    pub fn validator(&self) -> Validator {
        Validator::new(self.policy(Jail::off()))
    }

    pub fn e2e_validator(&self) -> Validator {
        Validator::new(self.policy(Jail::e2e(&self.root)))
    }

    pub fn tokens(&self) -> PathTokens {
        PathTokens::new()
    }

    pub fn dir(&self, rel: &str) -> PathBuf {
        let p = self.root.join(rel);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// A folder with `.git/{HEAD,config,objects,refs}`.
    pub fn repo(&self, rel: &str) -> PathBuf {
        let p = self.dir(rel);
        let g = p.join(".git");
        fs::create_dir_all(g.join("objects")).unwrap();
        fs::create_dir_all(g.join("refs/heads")).unwrap();
        fs::write(g.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(g.join("config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n").unwrap();
        p
    }

    pub fn set_config(&self, repo: &Path, text: &str) {
        fs::write(repo.join(".git/config"), text).unwrap();
    }
}

pub fn root_purpose() -> Purpose {
    Purpose::WorkspaceRoot
}

pub fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
