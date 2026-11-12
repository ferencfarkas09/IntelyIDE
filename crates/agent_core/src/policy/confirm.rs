//! Confirmable stops (tier 2): the few refusals a person may lift for ONE thing through a visible card.
//!
//! Every hard stop is either tier 1 (never overridable, in any mode, by anyone) or tier 2 (the agent is refused as before, but the
//! IDE may ask the person and, only on their click, lift that one stop). The table below is the classification; `docs/safety.md`
//! carries the same table for the owner to review. **When unsure, a rule is tier 1.**
//!
//! How it stays safe:
//! * A tier-2 refusal is still a `Deny` with `by: HardStop`. The only addition is `PolicyDecision::confirm`, an offer. Anything that
//!   does not know about offers (an old sidecar, a remote client, a test) keeps refusing.
//! * The stop is lifted only by a [`StopGrant`] in the run's [`PolicyContext`](super::decide::PolicyContext), put there by the host
//!   when a person answers a card on the computer. The agent cannot create one: grants are never read from a tool input, and a
//!   write to the file that stores the always-list is itself a tier-1 stop (the IDE state directory).
//! * A grant names one exact thing: the canonical path of a secret-looking file INSIDE a folder of the run, or one exact CLI reason.
//!   A path that leaves the run's folders (`../x`, a symlink that points out) is never offered and never matched.

use std::path::Path;

use serde::{Deserialize, Serialize};

wire_enums! {
    /// What kind of thing a confirmable stop is about.
    pub enum ConfirmKind {
        /// A secret-looking file inside a folder of the run (`.env`, `*.pem`, ...) that is READ, or only named in script text.
        SecretFile,
        /// A `.env` file inside a folder of the run that is EDITED or written. Kept apart from reading: allowing a read never allows an edit.
        SecretEdit,
        /// The Claude CLI raised its own prompt that an Automatic or Bypass run cannot answer.
        CliPrompt,
    }
}

/// What a person could allow instead of the refusal. Rides on the refusal (`PolicyDecision::confirm`) and on the card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ConfirmOffer {
    pub kind: ConfirmKind,
    /// The rule that stopped it (`read.never-read`, `fs.protected`, `cli.prompt-denied`).
    pub rule: String,
    /// The exact thing: a canonical path (`SecretFile`) or the CLI's own reason text (`CliPrompt`).
    pub scope: String,
    /// The folder of the run that holds the path (the repository the always-list entry belongs to); for a CLI prompt the run's
    /// working directory.
        pub repo: String,
}

/// A standing grant (this run, or the repository's always-list) that lifted a stop while a call was judged. The gate writes it to the run
/// log as an override ("You allowed reading .env for this run"), so a stop that is lifted without a card is still visible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct UsedGrant {
    pub offer: ConfirmOffer,
    /// `Run` or `Always` (a "once" grant was logged when its card was answered).
    pub via: crate::events::types::StopGrantScope,
}

/// A stop a person has lifted. Plain data held by the host in the run's policy context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopGrant {
    pub kind: ConfirmKind,
    /// A canonical path or an exact CLI reason; `"*"` = every one of the kind (the card's "for this run"; never persisted).
    pub scope: String,
    /// Set = valid for this one tool call only ("allow once").
    #[serde(default)]
    pub tool_id: Option<String>,
    /// Comes from the repository's always-list (and not from a card of this run): the audit says "always" instead of "for this run".
    #[serde(default)]
    pub from_list: bool,
}

/// The most entries the repository always-list holds (Settings > Safety).
pub const MAX_ALLOW_ENTRIES: usize = 100;

/// The scope that means "every stop of this kind, until the run ends".
pub const ALL_OF_KIND: &str = "*";

impl StopGrant {
    /// Whether this grant lifts a stop of `kind` on `scope` for the tool call `tool_id`.
    pub fn covers(&self, kind: ConfirmKind, scope: &str, tool_id: &str) -> bool {
        self.kind == kind && (self.scope == ALL_OF_KIND || self.scope == scope) && self.tool_id.as_deref().map_or(true, |t| t == tool_id)
    }
}

/// How the policy treats a hard stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// Never overridable.
    Never,
    /// A person may lift it for one exact thing through a card.
    Confirm,
}

/// One row of the classification. `variant` is `None` for a rule that is wholly one tier, otherwise it names the part of the rule
/// that is tier 2 (the rest of the rule is tier 1 in the row with the same id and `variant: None`).
pub struct RuleClass {
    pub rule: &'static str,
    pub variant: Option<&'static str>,
    pub tier: Tier,
    pub reason: &'static str,
}

const fn never(rule: &'static str, reason: &'static str) -> RuleClass {
    RuleClass { rule, variant: None, tier: Tier::Never, reason }
}

const fn confirm(rule: &'static str, variant: &'static str, reason: &'static str) -> RuleClass {
    RuleClass { rule, variant: Some(variant), tier: Tier::Confirm, reason }
}

/// Every hard-stop rule id of the policy (and `cli.prompt-denied` of the sidecar), classified. A test reads the policy sources and fails
/// when a rule id is missing here, so a new stop must be classified when it is added.
pub const CLASSIFICATION: &[RuleClass] = &[
    // ---- tier 2: the person may allow one exact thing ----
    confirm("read.never-read", "a secret-looking file inside a folder of the run, read with the Read or Grep tool", "the file is the person's own project file and the card says that the content goes to the model provider; no shell command is ever lifted: the shell cannot be asked about a file"),
    confirm("fs.protected", "a `.env` file inside a folder of the run, edited with the Edit, Write, MultiEdit or NotebookEdit tool", "an edit to a project-local env file is visible in the diff before any commit; the card names the exact path"),
    confirm("cli.prompt-denied", "a prompt of the Claude CLI that Automatic and Bypass cannot answer", "the command is still judged by every other rule here; the CLI's text heuristics (braces with quotes, `cd` with a redirect, parser limits) are about its own matching"),
    // ---- tier 1: never overridable ----
    never("read.never-read", "everything else (every shell command that names a secret file, scripts and inline code included, and Glob and LS): credential folders and stores of other tools (~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.azure, ~/.op, ~/.config/gh, Library/Keychains), history files, .npmrc/.netrc/.git-credentials, private keys by name (id_rsa*, id_ed25519*), ~/.claude secrets and transcripts, the IDE state directory, wrangler credentials, tunnel and MCP temp folders, and any secret outside the run's folders"),
    never("fs.protected", "everything else: `.git`, `.husky`, `.claude`, refs/intely, lockfiles (a hand edit can swap a dependency source: package managers write them), the IDE state and settings, code of enabled MCP servers, persistence places"),
    never("fs.protected-arg", "a shell command that names a protected path, `.env` files included (the file tools are the only question; the reason tells the agent to use them)"),
    never("fs.outside-jail", "writes outside the run's folders: the folders are the boundary the person chose"),
    never("exec.raw-text", "the Bypass text search for what the analyser cannot judge: it guards git writes and credentials"),
    never("exec.too-long", "an oversized command that mentions a git write or Cloudflare credentials cannot be judged"),
    never("exec.catastrophic", "disk wipes, device writes, recursive removal of the home or run folders"),
    never("exec.proc-env", "other processes' environments hold secrets"),
    never("exec.system-secrets", "security, osascript, dscl reach the Keychain, accounts and system scripting"),
    never("shim.token", "the human-only IDE token"),
    never("hooks.install", "git hooks run on the person's commits"),
    never("alias.git-write", "an alias that hides a git write"),
    never("remote.git-write", "a git write run elsewhere"),
    never("inline.git-write", "a git write inside inline code"),
    never("script.git-write", "a git write inside a script"),
    never("script.protected-path", "a script or inline code names a protected path (.git, .claude, hooks, lockfiles, a `.env` file, the IDE state): a grant cannot vouch for what a script does"),
    never("pm.publish", "publishing or logging in changes a package registry"),
    never("git.intely-refs", "refs/intely holds the Rewind snapshot and checkpoints"),
    never("git.binary-copy", "a copy of the git binary hides git from name-based checks"),
    never("git.exec-option", "an option that makes git run other programs"),
    never("git.xargs", "the git subcommand would come from stdin"),
    never("git.credential", "credential helpers hand out stored secrets"),
    never("git.reset-hard", "destroys work"),
    never("git.lfs-push", "uploads to the remote"),
    never("git.stash", "rewrites the working tree and the stash list"),
    never("git.branch", "moves or deletes refs"),
    never("git.remote", "changes where pushes go"),
    never("git.fetch-local", "writes refs of this repository"),
    never("git.fetch-refspec", "moves or deletes local refs"),
    never("git.reflog", "destroys recovery points"),
    never("git.symbolic-ref", "moves HEAD"),
    never("git.config", "changes identity, executes commands or redirects remotes"),
    never("git.add-xargs", "stages paths nobody can see"),
    never("git.add-all", "stages everything (an index write)"),
    never("git.add-pathspec-file", "stages paths nobody can see"),
    never("git.add-glob", "stages unintended files"),
    never("git.add-magic", "stages unintended files"),
    never("git.add-root", "stages the whole tree"),
    never("env.git-override", "changes git identity, config or target"),
    never("env.loader-override", "makes git or the loader run other code"),
    never("env.path-override", "removes the git shim"),
    never("mcp.args-unjudgeable", "arguments too large or deep to check"),
    never("mcp.protected-arg", "an argument points at a protected path"),
    never("delegate.isolation", "a worktree or remote environment is outside the run's folders"),
    never("workflow.isolation", "a workflow must run its agents here, in the run's folders"),
    never("wrangler.api", "the Cloudflare API"),
    never("wrangler.binary-copy", "hides wrangler from name-based checks"),
    never("wrangler.credentials", "Cloudflare credentials"),
    never("wrangler.env", "Cloudflare tokens in the environment"),
    never("wrangler.exec", "wrangler or Cloudflare deployment tooling"),
    never("wrangler.inline", "inline code that runs or loads wrangler"),
    never("wrangler.node-entry", "the wrangler entry point"),
    never("wrangler.pm-exec", "a package-manager run of wrangler"),
    never("wrangler.remote", "wrangler run elsewhere"),
    never("wrangler.script", "a script that spawns wrangler or reads its credentials"),
];

/// The tier of a rule id seen alone (the whole rule, no variant): `Never` unless every row of the rule is tier 2. Unknown ids are tier 1.
pub fn tier_of(rule: &str) -> Tier {
    let mut rows = CLASSIFICATION.iter().filter(|r| r.rule == rule && r.variant.is_none());
    match rows.next() {
        Some(r) => r.tier,
        None => Tier::Never,
    }
}

/// Whether a CLI prompt reason is one a person may allow (tier 2). Every other reason is tier 1 inside `cli.prompt-denied`, among them the
/// CLI's sensitive-file prompt (`.bashrc`, `.mcp.json`, `.vscode/settings.json`: files that run code later) and a path outside the run's
/// folders (Automatic's boundary; a person who wants it switches to Bypass or adds the folder).
pub fn cli_reason_confirmable(reason: &str) -> bool {
    let r = reason.trim();
    // ASCII only: another spelling (a no-break space, a look-alike letter) is a reason nobody verified
    r.is_ascii() && CONFIRMABLE_CLI_REASONS.iter().any(|p| r.starts_with(p))
}

/// The CLI prompt reasons a person may allow: an ALLOW-LIST of the texts that were seen in the owner's runs and are about the CLI's own text
/// matching, not about where a command reaches. Everything else (`Contains command_substitution`, `find ... -delete`, `Path contains '..'
/// traversal ...`, `Path is outside allowed working directories`, a sensitive file, a reason a newer CLI adds) stays a refusal.
pub const CONFIRMABLE_CLI_REASONS: &[&str] = &[
    "Contains brace with quote character",
    "Compound command contains cd with output redirection",
    "Parser skipped input between top-level statements",
    "Parser aborted",
    "Contains zsh <N-M> numeric-range glob",
];

/// Basenames a person may allow, inside a folder of the run. A positive list: the credential files of OTHER tools (`.npmrc`, `.netrc`,
/// `.git-credentials`, history files, `id_rsa*`, `id_ed25519*`, `.vault-token`, `.pypirc`, `.terraformrc`, `.credentials.json`) stay tier 1
/// even when a repository happens to contain one.
pub fn confirmable_secret_name(base: &str) -> bool {
    let b = base.to_ascii_lowercase();
    if b.ends_with(".pub") || b == ".envrc" {
        return false;
    }
    // (a name that an exact entry of the never-read list also matches, `id_rsa.pem` or `id_ed25519.key`, is a private key by name: tier 1)
    b == ".env"
        || b.starts_with(".env.")
        || b == "google-services.json"
        || b == "credentials.json"
        || ([".pem", ".key", ".p8", ".p12", ".pfx", ".jks", ".keystore"].iter().any(|e| b.ends_with(e) && b.len() > e.len()) && super::paths::secret_by_extension_only(&b))
}

/// A `.env` file for a WRITE (`protected_reason` says `.env*`): `.env` and `.env.<anything>`, never `.envrc` (direnv runs it).
pub fn confirmable_env_write_name(base: &str) -> bool {
    let b = base.to_ascii_lowercase();
    b == ".env" || b.starts_with(".env.")
}

/// Whether `p` has a confirmable secret file name.
pub fn confirmable_secret_path(p: &Path) -> bool {
    p.file_name().is_some_and(|n| confirmable_secret_name(&n.to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_rules_are_tier_one() {
        assert_eq!(tier_of("something.new"), Tier::Never);
        assert_eq!(tier_of("git.add-all"), Tier::Never);
        // a rule that is partly tier 2 is tier 1 as a whole: the offer is made by the code that checks the variant
        assert_eq!(tier_of("read.never-read"), Tier::Never);
    }

    #[test]
    fn every_rule_id_in_the_sources_is_classified() {
        let sources = [
            include_str!("decide.rs"),
            include_str!("hardstop.rs"),
            include_str!("hardstop/facts.rs"),
            include_str!("hardstop/scripts.rs"),
            include_str!("hardstop/protected_args.rs"),
            include_str!("hardstop/vars.rs"),
        ];
        let mut found = std::collections::BTreeSet::new();
        for src in sources {
            for call in ["hard_stop(\"", "stop(\"", "cf_stop(\"", "stop_confirmable(\"", "hard_stop_offer(eff, \""] {
                for part in src.split(call).skip(1) {
                    if let Some(id) = part.split('"').next() {
                        // (the test module of this very file is not among the sources)
                        if id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-')) && id.contains('.') {
                            found.insert(id.to_string());
                        }
                    }
                }
            }
        }
        assert!(found.len() > 40, "the scan found {} ids", found.len());
        for id in &found {
            assert!(CLASSIFICATION.iter().any(|r| r.rule == id), "rule id {id} is not classified in policy/confirm.rs and docs/safety.md");
        }
        for r in CLASSIFICATION {
            assert!(found.contains(r.rule) || r.rule == "cli.prompt-denied", "{} is classified but no longer exists", r.rule);
        }
    }

    #[test]
    fn a_tier_two_variant_always_has_a_tier_one_row_of_the_same_rule() {
        for r in CLASSIFICATION.iter().filter(|r| r.tier == Tier::Confirm) {
            assert!(r.variant.is_some());
            let has_never = CLASSIFICATION.iter().any(|o| o.rule == r.rule && o.tier == Tier::Never && o.variant.is_none());
            // (cli.prompt-denied keeps its tier-1 part in `cli_reason_confirmable`)
            assert!(has_never || r.rule == "cli.prompt-denied", "{}", r.rule);
        }
    }

    #[test]
    fn the_secret_names_a_person_may_allow() {
        for n in [".env", ".env.local", ".env.production", "server.pem", "AuthKey_X.p8", "a.key", "x.p12", "s.pfx", "t.jks", "r.keystore", "google-services.json", "credentials.json"] {
            assert!(confirmable_secret_name(n), "{n}");
        }
        for n in ["id_rsa.pem", "id_rsa.key", "id_ed25519.pem", "id_ed25519.key", ".npmrc", ".netrc", ".git-credentials", ".zsh_history", ".bash_history", "id_rsa", "id_rsa.old", "id_ed25519", ".vault-token", ".pypirc", ".terraformrc", ".credentials.json", ".envrc", "id.pub", "key", ".key", "notes.txt"] {
            assert!(!confirmable_secret_name(n), "{n}");
        }
    }

    #[test]
    fn the_cli_reasons_that_stay_refusals() {
        assert!(cli_reason_confirmable("Contains brace with quote character (expansion obfuscation)"));
        for r in [
            "Contains command_substitution",
            "Path contains '..' traversal after a directory segment, which may follow a symlink outside the working directory",
            "find with '-delete' executes commands or modifies files",
            "Path is outside allowed working directories",
            "Claude requested permissions to edit /home/u/.bashrc which is a sensitive file.",
            // a no-break space or a look-alike letter in an otherwise allowed text
            "Contains brace with quote\u{a0}character (expansion obfuscation)",
            "Contains brace with quote charаcter",
            "Claude requested permissions to edit /x which is a sensitive\u{a0}file.",
        ] {
            assert!(!cli_reason_confirmable(r), "{r}");
        }
        assert!(cli_reason_confirmable("Compound command contains cd with output redirection - manual approval required to prevent path resolution bypass"));
        assert!(!cli_reason_confirmable("Claude requested permissions to edit /home/u/.bashrc which is a sensitive file."));
        assert!(!cli_reason_confirmable(""));
        assert!(!cli_reason_confirmable("path outside the run's folders: /etc"));
    }

    #[test]
    fn a_grant_names_one_thing() {
        let once = StopGrant { kind: ConfirmKind::SecretFile, scope: "/r/.env".into(), tool_id: Some("t1".into()), from_list: false };
        assert!(once.covers(ConfirmKind::SecretFile, "/r/.env", "t1"));
        assert!(!once.covers(ConfirmKind::SecretFile, "/r/.env", "t2"));
        assert!(!once.covers(ConfirmKind::SecretFile, "/r/other.env", "t1"));
        assert!(!once.covers(ConfirmKind::CliPrompt, "/r/.env", "t1"));
        let run = StopGrant { kind: ConfirmKind::SecretFile, scope: ALL_OF_KIND.into(), tool_id: None, from_list: false };
        assert!(run.covers(ConfirmKind::SecretFile, "/anything", "t9"));
        assert!(!run.covers(ConfirmKind::CliPrompt, "x", "t9"));
    }
}
