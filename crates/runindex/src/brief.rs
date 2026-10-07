//! The Morning brief: per run what changed per repo (files and diff stats from the Rewind snapshots), what failed,
//! which needs-you items are still unanswered, and the estimated cost. Generated locally from the event log, the run's
//! meta file and read-only git; no model is involved (the optional Haiku summary is the caller's, on a click).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use intely_agent_core::events::types::{AgentEvent, EventKind, StopReason};
use intely_core::jail::Jail;
use serde::Serialize;

use crate::doc::{extract, is_error, parse_log, scrub, MetaFile, MetaSnapshot};

const MAX_FAILURES: usize = 8;
const MAX_NEEDS: usize = 8;
const MAX_FILES_LISTED: usize = 60;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// `modified` | `created` | `deleted`
    pub change: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoChange {
    pub repo_id: String,
    pub files: Vec<FileChange>,
    /// Files changed in total (the list is capped).
    pub file_count: u32,
    pub additions: u32,
    pub deletions: u32,
    /// Why there is nothing to show: no Rewind snapshot for this repo, or git could not be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    /// `tool` | `error` | `stop`
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Need {
    /// `permission` | `question`
    pub kind: String,
    pub text: String,
    pub ts: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefRun {
    pub run_id: String,
    pub title: String,
    pub role: String,
    pub model: String,
    pub status: String,
    pub started_ms: u64,
    pub ended_ms: u64,
    pub repos: Vec<RepoChange>,
    pub failures: Vec<Failure>,
    pub failure_count: u32,
    pub needs_you: Vec<Need>,
    /// The provider's own number; absent when the run reported none (never guessed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    pub tokens: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub runs: u32,
    pub failed: u32,
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
    pub needs_you: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub generated_ms: u64,
    pub runs: Vec<BriefRun>,
    pub totals: Totals,
}

/// Where the per-repo numbers come from. The real one asks git; tests give fixed answers.
pub trait DiffSource {
    /// Changes of the working tree in `repo_path` since the snapshot `ref_name`.
    fn changes(&self, repo_path: &Path, ref_name: &str) -> Result<Vec<FileChange>, String>;
}

/// Read-only git (`diff --numstat`, `ls-files`, `ls-tree`) through the checks crate's hardened runner.
pub struct GitDiff {
    pub jail: std::sync::Arc<Jail>,
}

impl DiffSource for GitDiff {
    fn changes(&self, repo: &Path, ref_name: &str) -> Result<Vec<FileChange>, String> {
        use intely_checks::git::read;
        let jail = self.jail.as_ref();
        let numstat = read(jail, repo, &["-c", "core.quotepath=false", "diff", "--numstat", "--no-renames", ref_name, "--"]).map_err(|e| e.message)?;
        // Untracked files: the snapshot holds them in its tree, `git diff <ref>` sees them as deleted from the index.
        let others = read(jail, repo, &["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"]).unwrap_or_default();
        let untracked: std::collections::BTreeSet<&str> = others.lines().collect();
        let mut out = Vec::new();
        for line in numstat.lines() {
            let mut p = line.splitn(3, '\t');
            let (Some(a), Some(d), Some(path)) = (p.next(), p.next(), p.next()) else { continue };
            // `-` means a binary file: counted as changed, with no line numbers.
            let (mut additions, mut deletions): (u32, u32) = (a.parse().unwrap_or(0), d.parse().unwrap_or(0));
            let exists = repo.join(path).exists();
            if exists && untracked.contains(path) {
                let before = read(jail, repo, &["rev-parse", &format!("{ref_name}:{path}")]).ok();
                let now = read(jail, repo, &["hash-object", "--", path]).ok();
                if before.is_some() && before == now {
                    continue; // unchanged since the snapshot
                }
                (additions, deletions) = untracked_lines(jail, repo, ref_name, path).unwrap_or((additions, deletions));
            }
            out.push(FileChange { path: path.to_owned(), change: if exists { "modified".into() } else { "deleted".into() }, additions, deletions });
        }
        // Files the run created: untracked now and not in the snapshot.
        if !others.trim().is_empty() {
            let snap = read(jail, repo, &["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", ref_name]).unwrap_or_default();
            let known: std::collections::BTreeSet<&str> = snap.lines().collect();
            for path in others.lines().filter(|p| !known.contains(p)) {
                // Rewind never snapshots guard-skipped files (never-add, secret, too large): they were not "created by the run".
                let size = fs::metadata(repo.join(path)).ok().map(|m| m.len());
                if !matches!(intely_core::guard::classify(path, true, size), intely_core::GuardState::Ok | intely_core::GuardState::Sensitive) {
                    continue;
                }
                let additions = fs::metadata(repo.join(path)).ok().filter(|m| m.is_file() && m.len() <= 2_000_000).and_then(|_| fs::read_to_string(repo.join(path)).ok()).map_or(0, |t| t.lines().count() as u32);
                out.push(FileChange { path: path.to_owned(), change: "created".into(), additions, deletions: 0 });
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }
}

/// Added and removed lines of an untracked file against its snapshot blob (`git diff --no-index` on a temp copy).
fn untracked_lines(jail: &Jail, repo: &Path, ref_name: &str, path: &str) -> Option<(u32, u32)> {
    let blob = intely_checks::git::read(jail, repo, &["cat-file", "blob", &format!("{ref_name}:{path}")]).ok()?;
    let tmp = std::env::temp_dir().join(format!("intely-brief-{}-{}", std::process::id(), path.replace('/', "_")));
    fs::write(&tmp, blob).ok()?;
    let out = intely_checks::git::run(jail, repo, &["diff", "--no-index", "--numstat", "--", tmp.to_str()?, path]).ok();
    let _ = fs::remove_file(&tmp);
    let line = out?.stdout;
    let mut p = line.lines().next()?.split('\t');
    Some((p.next()?.parse().ok()?, p.next()?.parse().ok()?))
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let s: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        format!("{s}…")
    } else {
        s
    }
}

/// Builds the brief of the given runs (in the order given). A run without a log is skipped.
pub fn build(runs_dir: &Path, run_ids: &[String], git: &dyn DiffSource, now_ms: u64) -> Brief {
    let mut runs = Vec::new();
    for id in run_ids {
        let Ok(text) = fs::read_to_string(runs_dir.join(format!("{id}.jsonl"))) else { continue };
        let meta = fs::read(runs_dir.join(format!("{id}.meta.json"))).ok().and_then(|b| serde_json::from_slice::<MetaFile>(&b).ok());
        runs.push(brief_run(id, &parse_log(&text), meta.as_ref(), git));
    }
    let mut totals = Totals { runs: runs.len() as u32, ..Totals::default() };
    for r in &runs {
        totals.failed += u32::from(r.status == "failed");
        totals.needs_you += r.needs_you.len() as u32;
        totals.files += r.repos.iter().map(|c| c.file_count).sum::<u32>();
        totals.additions += r.repos.iter().map(|c| c.additions).sum::<u32>();
        totals.deletions += r.repos.iter().map(|c| c.deletions).sum::<u32>();
        if let Some(c) = r.cost_usd {
            *totals.cost_usd.get_or_insert(0.0) += c;
        }
    }
    Brief { generated_ms: now_ms, runs, totals }
}

pub fn brief_run(id: &str, events: &[AgentEvent], meta: Option<&MetaFile>, git: &dyn DiffSource) -> BriefRun {
    let doc = extract(id, events, meta);
    let mut tool_names: BTreeMap<&str, &str> = BTreeMap::new();
    let mut failures = Vec::new();
    let mut failure_count = 0u32;
    let mut failure = |kind: &str, text: String, failures: &mut Vec<Failure>| {
        failure_count += 1;
        if failures.len() < MAX_FAILURES {
            failures.push(Failure { kind: kind.into(), text });
        }
    };
    let mut tokens = 0u64;
    // req_id -> (kind, text, ts, tool_id) of requests still open
    let mut open: Vec<(String, &'static str, String, u64, Option<String>)> = Vec::new();
    for e in events {
        match &e.kind {
            EventKind::ToolStart { tool_id, name, .. } => {
                tool_names.insert(tool_id, name);
                // Anything the agent does after a question means it was answered.
                open.retain(|o| o.1 != "question");
            }
            EventKind::ToolResult { tool_id, status, output, .. } => {
                if is_error(*status) {
                    let name = tool_names.get(tool_id.as_str()).copied().unwrap_or("tool");
                    let line = first_line(&scrub(output.as_deref().unwrap_or("")), 160);
                    failure("tool", if line.is_empty() { name.to_owned() } else { format!("{name}: {line}") }, &mut failures);
                }
                open.retain(|o| o.4.as_deref() != Some(tool_id.as_str()) || o.1 != "question");
            }
            EventKind::Error { message, .. } => failure("error", first_line(&scrub(message), 200), &mut failures),
            EventKind::TurnEnd { stop_reason } => {
                if matches!(stop_reason, StopReason::Error | StopReason::MaxTokens | StopReason::MaxTurns | StopReason::Refusal) {
                    failure("stop", format!("{stop_reason:?}").to_lowercase(), &mut failures);
                }
                open.retain(|o| o.1 != "question");
            }
            EventKind::UserMessage { .. } | EventKind::TextDone { .. } => open.retain(|o| o.1 != "question"),
            EventKind::PermissionRequest { req_id, tool_id, intent, .. } => {
                let what = tool_names.get(tool_id.as_str()).copied().unwrap_or("tool");
                let detail = intent.raw_command.clone().or_else(|| intent.paths.first().cloned()).or_else(|| intent.url.clone()).unwrap_or_default();
                let text = if detail.is_empty() { what.to_owned() } else { format!("{what}: {}", first_line(&scrub(&detail), 140)) };
                open.push((req_id.clone(), "permission", text, e.ts, Some(tool_id.clone())));
            }
            EventKind::PermissionResolved { req_id, .. } => open.retain(|o| &o.0 != req_id),
            EventKind::QuestionRequest { req_id, tool_id, prompt, .. } => open.push((req_id.clone(), "question", first_line(&scrub(prompt), 200), e.ts, tool_id.clone())),
            EventKind::Usage { usage } => tokens = u64::from(usage.cumulative.input_tokens) + u64::from(usage.cumulative.output_tokens),
            _ => {}
        }
    }
    let needs_you: Vec<Need> = open.into_iter().take(MAX_NEEDS).map(|(_, kind, text, ts, _)| Need { kind: kind.into(), text, ts }).collect();

    // Per repo: the snapshot taken before the run against the tree now.
    let snaps: Vec<&MetaSnapshot> = meta.map(|m| m.snapshots.iter().collect()).unwrap_or_default();
    let repo_ids: Vec<String> = if doc.repo_ids.is_empty() { snaps.iter().map(|s| s.repo_id.clone()).collect() } else { doc.repo_ids.clone() };
    let repos = repo_ids
        .iter()
        .map(|repo_id| match snaps.iter().find(|s| &s.repo_id == repo_id) {
            None => RepoChange { repo_id: repo_id.clone(), note: Some("noSnapshot".into()), ..RepoChange::default() },
            Some(s) => match git.changes(Path::new(&s.path), &s.ref_name) {
                Err(_) => RepoChange { repo_id: repo_id.clone(), note: Some("gitUnavailable".into()), ..RepoChange::default() },
                Ok(files) => RepoChange {
                    repo_id: repo_id.clone(),
                    file_count: files.len() as u32,
                    additions: files.iter().map(|f| f.additions).sum(),
                    deletions: files.iter().map(|f| f.deletions).sum(),
                    files: files.into_iter().take(MAX_FILES_LISTED).collect(),
                    note: None,
                },
            },
        })
        .collect();
    BriefRun {
        run_id: id.to_owned(),
        title: doc.title,
        role: doc.role,
        model: doc.model,
        status: doc.status,
        started_ms: doc.started_ms,
        ended_ms: doc.ended_ms,
        repos,
        failures,
        failure_count,
        needs_you,
        cost_usd: doc.cost_usd,
        tokens,
    }
}

/// The brief as plain facts for the optional one-shot summary: titles (the first line of a prompt), paths, counts and
/// failure lines, all scrubbed; never the rest of a prompt, replies or file contents.
pub fn facts_text(brief: &Brief) -> String {
    let mut s = String::new();
    for r in &brief.runs {
        s.push_str(&format!("Run \"{}\" (role {}, status {}", r.title, r.role, r.status));
        if let Some(c) = r.cost_usd {
            s.push_str(&format!(", cost about ${c:.2}"));
        }
        s.push_str(")\n");
        for c in &r.repos {
            match &c.note {
                Some(n) => s.push_str(&format!("  {}: no diff ({n})\n", c.repo_id)),
                None => {
                    s.push_str(&format!("  {}: {} files, +{} -{}\n", c.repo_id, c.file_count, c.additions, c.deletions));
                    for f in c.files.iter().take(12) {
                        s.push_str(&format!("    {} {}\n", f.change, f.path));
                    }
                }
            }
        }
        for f in &r.failures {
            s.push_str(&format!("  failed ({}): {}\n", f.kind, f.text));
        }
        for n in &r.needs_you {
            s.push_str(&format!("  waiting for you ({}): {}\n", n.kind, n.text));
        }
    }
    s
}
