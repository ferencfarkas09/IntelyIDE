//! Mutating and network git operations (commit, push, stage, pull/fetch, outgoing).

pub mod commit;
pub mod init;
pub mod orphans;
pub mod outgoing;
pub mod pull_fetch;
pub mod push;
pub mod stage;

pub(crate) mod common;
