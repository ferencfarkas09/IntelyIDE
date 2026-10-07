//! Global search: ripgrep (`rg --json`) when installed, else `git grep`. Hits stream out in batches; secret and
//! never-add files are neither searched nor reported.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use intely_core::exec::{run_git_full, CancelToken, RunInfo, RunOpts};
use intely_core::guard::{classify, NEVER_ADD, SECRET};
use intely_core::{code, EngineError, GuardState, OpKind, StreamKind};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::types::*;
use crate::{Files, FilesSink};

pub const MAX_HITS: usize = 5000;
const BATCH_HITS: usize = 50;
const BATCH_EVERY: Duration = Duration::from_millis(80);
/// The caller learns the search id only when `start` resolves; the first batch waits for that.
const START_DELAY: Duration = Duration::from_millis(30);
const PREVIEW_CHARS: usize = 300;
/// Shown under the search status when `git grep` ran because ripgrep is not installed.
pub const RG_MISSING_NOTICE: &str = "No ripgrep, using git grep. Faster: brew install ripgrep";

/// `INTELY_RG=off` forces `git grep` (tests); `INTELY_RG=<path>` names the binary.
fn rg_path() -> Option<PathBuf> {
    static RG: OnceLock<Option<PathBuf>> = OnceLock::new();
    RG.get_or_init(|| {
        if let Ok(v) = std::env::var("INTELY_RG") {
            return if v == "off" || v.is_empty() { None } else { Some(PathBuf::from(v)) };
        }
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from);
        let from_path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
        from_path.into_iter().chain(extra).map(|d| d.join("rg")).find(|p| p.is_file())
    })
    .clone()
}

/// Collects hits of one search and sends them on in batches.
struct Batcher {
    id: String,
    sink: Arc<dyn FilesSink>,
    pending: Mutex<(Vec<SearchHit>, Instant)>,
    total: Mutex<usize>,
    limit_hit: AtomicBool,
    /// Sent with the last batch only.
    notice: Option<String>,
}

impl Batcher {
    fn push(&self, hit: SearchHit) -> bool {
        if classify(&hit.path, true, None) != GuardState::Ok {
            return true;
        }
        {
            let mut total = self.total.lock().expect("total lock");
            if *total >= MAX_HITS {
                self.limit_hit.store(true, Ordering::SeqCst);
                return false;
            }
            *total += 1;
        }
        let mut pending = self.pending.lock().expect("pending lock");
        pending.0.push(hit);
        if pending.0.len() >= BATCH_HITS || pending.1.elapsed() >= BATCH_EVERY {
            let hits = std::mem::take(&mut pending.0);
            pending.1 = Instant::now();
            drop(pending);
            self.emit(hits, false, None);
        }
        true
    }

    fn emit(&self, hits: Vec<SearchHit>, done: bool, error: Option<String>) {
        let truncated = done && self.limit_hit.load(Ordering::SeqCst);
        let notice = if done { self.notice.clone() } else { None };
        self.sink.search_batch(SearchBatch { search_id: self.id.clone(), hits, done, truncated, error, notice });
    }

    fn flush(&self) {
        let hits = std::mem::take(&mut self.pending.lock().expect("pending lock").0);
        if !hits.is_empty() {
            self.emit(hits, false, None);
        }
    }

    fn finish(&self, error: Option<String>) {
        let hits = std::mem::take(&mut self.pending.lock().expect("pending lock").0);
        self.emit(hits, true, error);
    }

    fn full(&self) -> bool {
        self.limit_hit.load(Ordering::SeqCst)
    }
}

fn char_col(text: &str, byte: usize) -> u32 {
    let byte = byte.min(text.len());
    (0..=byte).rev().find(|i| text.is_char_boundary(*i)).map_or(1, |i| text[..i].chars().count() as u32 + 1)
}

fn preview_of(line: &str) -> String {
    line.trim_end_matches(['\n', '\r']).chars().take(PREVIEW_CHARS).collect()
}

fn glob_for(glob: &str) -> String {
    let g = glob.trim().trim_start_matches("./");
    if g.contains('/') {
        g.trim_start_matches('/').to_owned()
    } else {
        format!("**/{g}")
    }
}

/// One `rg --json` line: a `match` message becomes a hit (the first match of the line), everything else is ignored.
/// Paths or lines that are not valid UTF-8 are skipped.
fn parse_rg_line(repo_id: &str, line: &str) -> Option<SearchHit> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "match" {
        return None;
    }
    let data = v.get("data")?;
    let path = data.get("path")?.get("text")?.as_str()?;
    let text = data.get("lines")?.get("text")?.as_str()?;
    let start = data.get("submatches")?.get(0)?.get("start")?.as_u64()? as usize;
    Some(SearchHit {
        repo_id: repo_id.to_owned(),
        path: crate::nfc(path.strip_prefix("./").unwrap_or(path)),
        line: data.get("line_number")?.as_u64()? as u32,
        col: char_col(text, start),
        preview: preview_of(text),
    })
}

/// One `git grep -n --column -z` record: `path NUL line NUL column NUL text`.
fn parse_grep_record(repo_id: &str, rec: &str) -> Option<SearchHit> {
    let mut parts = rec.splitn(4, '\0');
    let (path, line, col, text) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    Some(SearchHit {
        repo_id: repo_id.to_owned(),
        path: crate::nfc(path),
        line: line.parse().ok()?,
        col: char_col(text, col.parse::<usize>().ok()?.saturating_sub(1)),
        preview: preview_of(text),
    })
}

impl Files {
    /// Starts a search over `roots` (already narrowed to the requested repos) and returns its id. Batches arrive as
    /// `search:results`; the last one has `done`.
    pub async fn search_start(self: &Arc<Self>, roots: Vec<RepoRoot>, query: &str, opts: SearchOptions) -> Result<String, EngineError> {
        if query.is_empty() {
            return Err(EngineError::new(code::INVALID_SELECTION, "the search query is empty"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = CancelToken::default();
        self.searches.lock().expect("searches lock").insert(id.clone(), cancel.clone());
        let batcher = Arc::new(Batcher {
            id: id.clone(),
            sink: self.sink.clone(),
            pending: Mutex::new((Vec::new(), Instant::now())),
            total: Mutex::new(0),
            limit_hit: AtomicBool::new(false),
            notice: rg_path().is_none().then(|| RG_MISSING_NOTICE.to_owned()),
        });
        let files = Arc::clone(self);
        let query = query.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(START_DELAY).await;
            let mut error = None;
            for root in &roots {
                if cancel.is_cancelled() || batcher.full() {
                    break;
                }
                if let Err(e) = files.search_repo(root, &query, &opts, &batcher, &cancel).await {
                    error.get_or_insert(format!("{}: {}", root.id, e.detail.as_deref().unwrap_or(&e.message)));
                }
                batcher.flush();
            }
            batcher.finish(error);
            files.searches.lock().expect("searches lock").remove(&batcher.id);
        });
        Ok(id)
    }

    pub fn search_cancel(&self, search_id: &str) {
        if let Some(token) = self.searches.lock().expect("searches lock").get(search_id) {
            token.cancel();
        }
    }

    async fn search_repo(
        &self,
        root: &RepoRoot,
        query: &str,
        opts: &SearchOptions,
        batcher: &Arc<Batcher>,
        cancel: &CancelToken,
    ) -> Result<(), EngineError> {
        match rg_path() {
            Some(rg) => search_rg(&rg, root, query, opts, batcher, cancel).await,
            None => self.search_git_grep(root, query, opts, batcher, cancel).await,
        }
    }

    async fn search_git_grep(
        &self,
        root: &RepoRoot,
        query: &str,
        opts: &SearchOptions,
        batcher: &Arc<Batcher>,
        cancel: &CancelToken,
    ) -> Result<(), EngineError> {
        let mut args: Vec<String> = ["grep", "-n", "--column", "-I", "-z", "--no-color", "--untracked", "--exclude-standard"]
            .map(String::from)
            .into();
        args.push(if opts.regex { "-E" } else { "-F" }.into());
        if !opts.case_sensitive {
            args.push("-i".into());
        }
        args.extend(["-e".into(), query.to_owned(), "--".into()]);
        // Pathspecs are alternatives: the glob replaces `.` as the positive one (the excludes need at least one).
        match opts.glob.as_deref().filter(|g| !g.trim().is_empty()) {
            Some(glob) => args.push(format!(":(glob){}", glob_for(glob))),
            None => args.push(".".into()),
        }
        for pat in NEVER_ADD {
            args.push(format!(":(exclude,glob,icase)**/{pat}/**"));
            args.push(format!(":(exclude,glob,icase)**/{pat}"));
        }
        for pat in SECRET {
            args.push(format!(":(exclude,glob,icase)**/{pat}"));
        }
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();

        let ctx = self.git.with_run(RunInfo { run_id: batcher.id.clone(), kind: OpKind::Fetch, cancel: cancel.clone() });
        let (repo_id, stop) = (root.id.clone(), cancel.clone());
        let mut on_line = |stream: StreamKind, line: &str| {
            if matches!(stream, StreamKind::Stderr) {
                return;
            }
            if let Some(hit) = parse_grep_record(&repo_id, line) {
                if !batcher.push(hit) {
                    stop.cancel();
                }
            }
        };
        let opts = RunOpts { read_only: true, max_output: Some(64 * 1024 * 1024), ..Default::default() };
        let res = run_git_full(&ctx, &root.path, &argv, &opts, Some(&mut on_line)).await?;
        match res.output.code {
            Some(0 | 1) => Ok(()),
            _ if res.cancelled => Ok(()),
            _ => Err(EngineError::new(code::GIT, "git grep failed").with_detail(res.output.stderr_text().trim().to_owned())),
        }
    }
}

async fn search_rg(
    rg: &Path,
    root: &RepoRoot,
    query: &str,
    opts: &SearchOptions,
    batcher: &Arc<Batcher>,
    cancel: &CancelToken,
) -> Result<(), EngineError> {
    let mut cmd = tokio::process::Command::new(rg);
    cmd.current_dir(&root.path).args(["--json", "--no-config", "--hidden", "--max-filesize", "5M", "--glob-case-insensitive"]);
    cmd.args(["-g", "!.git"]);
    cmd.arg(if opts.case_sensitive { "-s" } else { "-i" });
    if !opts.regex {
        cmd.arg("-F");
    }
    for pat in NEVER_ADD.iter().chain(SECRET) {
        cmd.args(["-g", &format!("!{pat}")]);
    }
    if let Some(glob) = opts.glob.as_deref().filter(|g| !g.trim().is_empty()) {
        cmd.args(["-g", &glob_for(glob)]);
    }
    cmd.args(["-e", query, "--", "."]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| EngineError::new(code::IO, format!("cannot start rg: {e}")))?;
    let stderr = child.stderr.take().expect("piped stderr");
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if text.len() < 2000 {
                text.push_str(&l);
                text.push('\n');
            }
        }
        text
    });
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                return Ok(());
            }
            line = lines.next_line() => match line {
                Ok(Some(l)) => {
                    if let Some(hit) = parse_rg_line(&root.id, &l) {
                        if !batcher.push(hit) {
                            let _ = child.kill().await;
                            return Ok(());
                        }
                    }
                }
                _ => break,
            },
        }
    }
    let status = child.wait().await.map_err(|e| EngineError::new(code::IO, e.to_string()))?;
    let stderr = stderr_task.await.unwrap_or_default();
    match status.code() {
        Some(0 | 1) => Ok(()),
        _ => Err(EngineError::new(code::GIT, "rg failed").with_detail(stderr.trim().to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rg_json_match_becomes_a_hit() {
        let line = r#"{"type":"match","data":{"path":{"text":"./src/a.ts"},"lines":{"text":"  const é = needle;\n"},"line_number":7,"absolute_offset":10,"submatches":[{"match":{"text":"needle"},"start":13,"end":19}]}}"#;
        let hit = parse_rg_line("r1", line).unwrap();
        assert_eq!((hit.path.as_str(), hit.line, hit.col, hit.preview.as_str()), ("src/a.ts", 7, 13, "  const é = needle;"));
        assert!(parse_rg_line("r1", r#"{"type":"summary","data":{}}"#).is_none());
        assert!(parse_rg_line("r1", r#"{"type":"match","data":{"path":{"bytes":"AAAA"},"lines":{"text":"x"},"line_number":1,"submatches":[]}}"#).is_none());
    }

    #[test]
    fn git_grep_record_converts_the_byte_column_to_characters() {
        let hit = parse_grep_record("r1", "src/a.ts\x007\x0014\x00  const é = needle;").unwrap();
        assert_eq!((hit.path.as_str(), hit.line, hit.col), ("src/a.ts", 7, 13));
        assert!(parse_grep_record("r1", "broken record").is_none());
    }

    #[test]
    fn a_glob_without_a_slash_matches_at_any_depth() {
        assert_eq!(glob_for("*.ts"), "**/*.ts");
        assert_eq!(glob_for("src/**/*.ts"), "src/**/*.ts");
    }
}
