//! The PR bridge. Reads (`gh pr list|view|checks --json`) never change anything. `create` is the only write: a draft
//! PR by default, behind the jail, an upstream, a head that is not a live branch and the typed repo name and head
//! branch. It never pushes, merges, edits, closes, approves or comments, and never passes `--web`, `--fill` or
//! `--no-maintainer-edit`-style options it was not told about: the argv is built here and shown verbatim.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use intely_core::jail::{matches_live, Jail};
use intely_core::{code, EngineError};
use serde_json::Value;

use crate::gh::{Gh, GH_AUTH};
use crate::git;
use crate::types::{CreatePlan, CreateRequest, CreateResult, PlanCommit, PrCheck, PrDetail, PrList, PrReview, PrSummary, Refusal};

pub const CONFIRM_REQUIRED: &str = "confirmRequired";
const LIST_LIMIT: &str = "30";
const LIST_FIELDS: &str = "number,title,state,isDraft,headRefName,baseRefName,author,url,reviewDecision,statusCheckRollup,updatedAt";
const VIEW_FIELDS: &str = "number,title,body,state,isDraft,headRefName,baseRefName,author,url,reviewDecision,latestReviews,statusCheckRollup,updatedAt";
const MAX_COMMITS: usize = 50;

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

/// `pass`, `fail`, `pending` or `skip` for one entry of `statusCheckRollup` (a CheckRun or a StatusContext).
fn rollup_bucket(e: &Value) -> &'static str {
    if let Some(state) = e.get("state").and_then(Value::as_str) {
        return match state {
            "SUCCESS" => "pass",
            "FAILURE" | "ERROR" => "fail",
            _ => "pending",
        };
    }
    match (s(e, "status").as_str(), s(e, "conclusion").as_str()) {
        ("COMPLETED", "SUCCESS") => "pass",
        ("COMPLETED", "NEUTRAL" | "SKIPPED") => "skip",
        ("COMPLETED", "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "STALE") => "fail",
        _ => "pending",
    }
}

pub fn summary_of(v: &Value) -> PrSummary {
    let (mut passed, mut failed, mut pending) = (0u32, 0u32, 0u32);
    for e in v.get("statusCheckRollup").and_then(Value::as_array).into_iter().flatten() {
        match rollup_bucket(e) {
            "pass" => passed += 1,
            "fail" => failed += 1,
            "pending" => pending += 1,
            _ => {}
        }
    }
    let ci = if failed > 0 {
        "failing"
    } else if pending > 0 {
        "pending"
    } else if passed > 0 {
        "passing"
    } else {
        "none"
    };
    let review = match s(v, "reviewDecision").as_str() {
        "APPROVED" => "approved",
        "CHANGES_REQUESTED" => "changesRequested",
        "REVIEW_REQUIRED" => "reviewRequired",
        _ => "none",
    };
    PrSummary {
        number: v.get("number").and_then(Value::as_u64).unwrap_or(0),
        title: s(v, "title"),
        state: s(v, "state"),
        is_draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        head: s(v, "headRefName"),
        base: s(v, "baseRefName"),
        author: v.get("author").map(|a| s(a, "login")).unwrap_or_default(),
        url: s(v, "url"),
        review: review.into(),
        ci: ci.into(),
        checks_passed: passed,
        checks_failed: failed,
        checks_pending: pending,
        updated_at: s(v, "updatedAt"),
    }
}

fn parse_list(text: &str) -> Result<Vec<PrSummary>, EngineError> {
    let v: Value = serde_json::from_str(text).map_err(|_| EngineError::new(code::IO, "gh returned something that is not JSON"))?;
    Ok(v.as_array().into_iter().flatten().map(summary_of).collect())
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| (*a).to_owned()).collect()
}

pub fn current_branch(jail: &Jail, repo: &Path) -> Option<String> {
    git::try_read(jail, repo, &["symbolic-ref", "--short", "-q", "HEAD"])
}

/// Open PRs of the current branch and of the signed-in user. Read-only.
pub fn list(gh: &Gh, jail: &Jail, repo: &Path) -> Result<PrList, EngineError> {
    gh.network_allowed(repo)?;
    let branch = current_branch(jail, repo);
    let mine = parse_list(&gh.read(repo, &strings(&["pr", "list", "--state", "open", "--author", "@me", "--limit", LIST_LIMIT, "--json", LIST_FIELDS]))?)?;
    let current = match &branch {
        Some(b) => parse_list(&gh.read(repo, &strings(&["pr", "list", "--state", "open", "--head", b, "--limit", LIST_LIMIT, "--json", LIST_FIELDS]))?)?,
        None => Vec::new(),
    };
    Ok(PrList { branch, current, mine })
}

/// One PR with its description, reviews and checks. Read-only.
pub fn view(gh: &Gh, repo: &Path, number: u64) -> Result<PrDetail, EngineError> {
    let n = number.to_string();
    let text = gh.read(repo, &strings(&["pr", "view", &n, "--json", VIEW_FIELDS]))?;
    let v: Value = serde_json::from_str(&text).map_err(|_| EngineError::new(code::IO, "gh returned something that is not JSON"))?;
    let reviews = v
        .get("latestReviews")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|r| PrReview { author: r.get("author").map(|a| s(a, "login")).unwrap_or_default(), state: s(r, "state") })
        .collect();
    // `gh pr checks` exits 8 while checks are pending and 1 when one failed, with the JSON on stdout either way.
    let o = gh.run(repo, &strings(&["pr", "checks", &n, "--json", "name,workflow,state,bucket,link"]), Duration::from_secs(25))?;
    let checks = match serde_json::from_str::<Value>(&o.stdout) {
        Ok(Value::Array(a)) => a
            .iter()
            .map(|c| PrCheck { name: s(c, "name"), workflow: s(c, "workflow"), state: s(c, "state"), bucket: s(c, "bucket"), link: Some(s(c, "link")).filter(|l| !l.is_empty()) })
            .collect(),
        _ if o.ok || o.stderr.contains("no checks reported") => Vec::new(),
        _ => return Err(crate::gh::failure(&o)),
    };
    Ok(PrDetail { summary: summary_of(&v), body: s(&v, "body"), reviews, checks })
}

// ---- draft ------------------------------------------------------------------------------------------------------------

struct Parsed<'a> {
    kind: Option<&'a str>,
    scope: Option<&'a str>,
    description: &'a str,
}

fn parse_subject(subject: &str) -> Parsed<'_> {
    let plain = Parsed { kind: None, scope: None, description: subject };
    let Some((prefix, rest)) = subject.split_once(": ") else { return plain };
    let prefix = prefix.trim_end_matches('!');
    let (kind, scope) = match prefix.split_once('(') {
        Some((k, sc)) => match sc.strip_suffix(')') {
            Some(sc) => (k, Some(sc)),
            None => return plain,
        },
        None => (prefix, None),
    };
    if kind.is_empty() || !kind.chars().all(|c| c.is_ascii_lowercase()) {
        return plain;
    }
    Parsed { kind: Some(kind), scope, description: rest }
}

fn humanize_branch(branch: &str) -> String {
    let last = branch.rsplit('/').next().unwrap_or(branch);
    let words: String = last.chars().map(|c| if c == '-' || c == '_' { ' ' } else { c }).collect();
    words.trim().to_owned()
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let cut: String = text.chars().take(max - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Title and body in the commit style of the user: Conventional Commits header and an `Extended English:` paragraph,
/// then the commit list. Pure and deterministic; it adds no trailer and no attribution.
pub fn draft(head: &str, base: &str, commits: &[(String, String, String)]) -> (String, String) {
    let parsed: Vec<Parsed> = commits.iter().map(|c| parse_subject(&c.1)).collect();
    let title = if commits.len() == 1 {
        commits[0].1.clone()
    } else {
        const ORDER: [&str; 11] = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "style", "chore", "revert"];
        let kind = ORDER
            .iter()
            .copied()
            .map(|k| (k, parsed.iter().filter(|p| p.kind == Some(k)).count()))
            .filter(|(_, n)| *n > 0)
            .max_by_key(|(k, n)| (*n, std::cmp::Reverse(ORDER.iter().position(|o| o == k))))
            .map_or("chore", |(k, _)| k);
        let scopes: Vec<_> = parsed.iter().map(|p| p.scope).collect();
        let scope = scopes.first().copied().flatten().filter(|sc| scopes.iter().all(|x| *x == Some(*sc)));
        let human = humanize_branch(head);
        let desc = if human.is_empty() || human == humanize_branch(base) { parsed.last().map_or("", |p| p.description).to_owned() } else { human };
        let header = match scope {
            Some(sc) => format!("{kind}({sc}): "),
            None => format!("{kind}: "),
        };
        format!("{header}{}", truncate(&desc, 72usize.saturating_sub(header.chars().count()).max(20)))
    };
    let n = commits.len();
    let lead = commits
        .iter()
        .map(|c| c.2.split("\n\n").next().unwrap_or("").trim().replace('\n', " "))
        .find(|b| !b.is_empty())
        .unwrap_or_default();
    let mut body = format!("Extended English: This pull request brings {n} commit{} from `{head}` into `{base}`.", if n == 1 { "" } else { "s" });
    if !lead.is_empty() {
        body.push(' ');
        body.push_str(&lead);
        if !lead.ends_with(['.', '!', '?']) {
            body.push('.');
        }
    }
    body.push_str("\n\nCommits:\n");
    for c in commits {
        body.push_str(&format!("- {} ({})\n", c.1, &c.0[..c.0.len().min(7)]));
    }
    (title, body.trim_end().to_owned())
}

// ---- plan and create ------------------------------------------------------------------------------------------------

pub struct RepoRef<'a> {
    pub path: &'a Path,
    pub name: &'a str,
    /// `protectedBranches` plus the repo's `liveBranches`.
    pub live_patterns: &'a [String],
}

fn refusal(code: &str, message: impl Into<String>) -> Option<Refusal> {
    Some(Refusal { code: code.into(), message: message.into() })
}

fn remote_bases(jail: &Jail, repo: &Path) -> Vec<String> {
    git::try_read(jail, repo, &["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.strip_prefix("origin/"))
        .filter(|b| *b != "HEAD" && !b.is_empty())
        .take(100)
        .map(str::to_owned)
        .collect()
}

fn default_base(jail: &Jail, repo: &Path, bases: &[String]) -> Option<String> {
    git::try_read(jail, repo, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
        .and_then(|r| r.strip_prefix("origin/").map(str::to_owned))
        .filter(|b| bases.contains(b))
        .or_else(|| ["main", "master"].iter().find(|b| bases.iter().any(|x| x == *b)).map(|b| (*b).to_owned()))
}

/// The argv of `gh pr create` as (flag, value) pairs. The same list is run and shown.
pub fn create_parts(base: &str, head: &str, title: &str, body: &str, draft: bool) -> Vec<(String, Option<String>)> {
    let mut parts = vec![("pr".to_owned(), None), ("create".to_owned(), None)];
    if draft {
        parts.push(("--draft".into(), None));
    }
    for (flag, value) in [("--base", base), ("--head", head), ("--title", title), ("--body", body)] {
        parts.push((flag.into(), Some(value.into())));
    }
    parts
}

fn quote(text: &str) -> String {
    if !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c)) {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

/// `gh pr create ...` as one shell line for display.
pub fn command_line(parts: &[(String, Option<String>)]) -> String {
    let mut line = String::from("gh");
    for (flag, value) in parts {
        line.push(' ');
        line.push_str(flag);
        if let Some(v) = value {
            line.push('=');
            line.push_str(&quote(v));
        }
    }
    line
}

fn argv(parts: &[(String, Option<String>)]) -> Vec<String> {
    parts.iter().map(|(f, v)| v.as_ref().map_or_else(|| f.clone(), |v| format!("{f}={v}"))).collect()
}

struct Facts {
    head: Option<String>,
    upstream: Option<String>,
    unpushed: u32,
    bases: Vec<String>,
    base: Option<String>,
    commits: Vec<(String, String, String)>,
    refusal: Option<Refusal>,
}

fn facts(jail: &Jail, repo: &RepoRef, wanted_base: Option<&str>) -> Facts {
    let mut f = Facts { head: current_branch(jail, repo.path), upstream: None, unpushed: 0, bases: remote_bases(jail, repo.path), base: None, commits: Vec::new(), refusal: None };
    f.base = match wanted_base {
        Some(b) if f.bases.iter().any(|x| x == b) => Some(b.to_owned()),
        Some(b) => {
            f.refusal = refusal("unknownBase", format!("'{b}' is not a branch of the remote"));
            None
        }
        None => default_base(jail, repo.path, &f.bases),
    };
    let Some(head) = f.head.clone() else {
        f.refusal = f.refusal.take().or_else(|| refusal("detachedHead", "HEAD is detached: check out the branch first"));
        return f;
    };
    f.upstream = git::try_read(jail, repo.path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    if f.upstream.is_some() {
        f.unpushed = git::try_read(jail, repo.path, &["rev-list", "--count", "@{upstream}..HEAD"]).and_then(|n| n.parse().ok()).unwrap_or(0);
    }
    if let Some(base) = &f.base {
        let range = format!("origin/{base}..HEAD");
        let log = git::try_read(jail, repo.path, &["log", "--reverse", "-n", &MAX_COMMITS.to_string(), "--format=%H%x1f%s%x1f%b%x1e", &range]).unwrap_or_default();
        f.commits = log
            .split('\u{1e}')
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .filter_map(|r| {
                let mut p = r.splitn(3, '\u{1f}');
                Some((p.next()?.to_owned(), p.next()?.to_owned(), p.next().unwrap_or("").trim().to_owned()))
            })
            .collect();
    }
    let default_head = git::try_read(jail, repo.path, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]).and_then(|r| r.strip_prefix("origin/").map(str::to_owned));
    let upstream_branch = f.upstream.as_deref().and_then(|u| u.split_once('/')).map(|(_, b)| b.to_owned());
    f.refusal = f.refusal.take().or_else(|| {
        if let Err(e) = jail.check_op("gh pr create", repo.path) {
            refusal(&e.code, e.message)
        } else if matches_live(repo.live_patterns, default_head.as_deref(), &head) {
            refusal("liveHead", format!("'{head}' is a live branch: it can be the base of a PR, never the head"))
        } else if f.upstream.is_none() {
            refusal("noUpstream", format!("'{head}' has no upstream: push it from the Push dialog first, this never pushes"))
        } else if upstream_branch.as_deref() != Some(head.as_str()) {
            refusal("upstreamMismatch", format!("'{head}' tracks a branch with another name: the PR head would not match"))
        } else if f.base.is_none() {
            refusal("noBase", "no base branch could be found on the remote")
        } else if f.base.as_deref() == Some(head.as_str()) {
            refusal("sameBranch", "the head and the base are the same branch")
        } else if f.commits.is_empty() {
            refusal("nothingAhead", "the branch has no commits ahead of the base")
        } else {
            None
        }
    });
    f
}

/// What the Create PR dialog shows: the draft, the exact command and, if Create must stay off, the reason. Git reads only.
pub fn plan(jail: &Jail, repo: &RepoRef, base: Option<&str>, draft_pr: bool) -> CreatePlan {
    let f = facts(jail, repo, base);
    let head_name = f.head.clone().unwrap_or_default();
    let base_name = f.base.clone().unwrap_or_default();
    let (title, body) = if f.commits.is_empty() { (String::new(), String::new()) } else { draft(&head_name, &base_name, &f.commits) };
    let command = command_line(&create_parts(&base_name, &head_name, &title, &body, draft_pr));
    CreatePlan {
        repo_name: repo.name.to_owned(),
        head: f.head,
        base: f.base,
        bases: f.bases,
        upstream: f.upstream,
        unpushed: f.unpushed,
        commits: f.commits.iter().map(|c| PlanCommit { sha: c.0.clone(), subject: c.1.clone() }).collect(),
        title,
        body,
        draft: draft_pr,
        command,
        refusal: f.refusal,
    }
}

/// The command the request would run (edited title and body included), for the dialog's live preview.
pub fn preview(jail: &Jail, repo: &RepoRef, req: &CreateRequest) -> Result<String, EngineError> {
    let head = current_branch(jail, repo.path).ok_or_else(|| EngineError::new("detachedHead", "HEAD is detached"))?;
    Ok(command_line(&create_parts(&req.base, &head, &req.title, &req.body, req.draft)))
}

/// Runs `gh pr create`. Order: jail, refusals, the typed confirmation, `gh` and its sign-in, then the one call.
pub fn create(jail: Arc<Jail>, path_env: &str, repo: &RepoRef, req: &CreateRequest) -> Result<CreateResult, EngineError> {
    jail.check_op("gh pr create", repo.path)?;
    let f = facts(&jail, repo, Some(&req.base));
    if let Some(r) = f.refusal {
        return Err(EngineError::new(&r.code, r.message));
    }
    let head = f.head.expect("a refusal-free plan has a head");
    if req.confirm_repo != repo.name || req.confirm_head != head {
        return Err(EngineError::new(CONFIRM_REQUIRED, format!("type the repo name {} and the head branch {head} to confirm", repo.name)));
    }
    if req.title.trim().is_empty() {
        return Err(EngineError::new("emptyTitle", "the title is empty"));
    }
    let gh = Gh::locate(Arc::clone(&jail), path_env)?;
    gh.network_allowed(repo.path)?;
    if !gh.authenticated(repo.path)? {
        return Err(EngineError::new(GH_AUTH, "gh is not signed in: run `gh auth login` in a terminal"));
    }
    let parts = create_parts(&req.base, &head, &req.title, &req.body, req.draft);
    let o = gh.run(repo.path, &argv(&parts), Duration::from_secs(60))?;
    if !o.ok {
        return Err(crate::gh::failure(&o));
    }
    let url = o.stdout.lines().rev().map(str::trim).find(|l| l.starts_with("https://")).unwrap_or("").to_owned();
    Ok(CreateResult { url, command: command_line(&parts) })
}
