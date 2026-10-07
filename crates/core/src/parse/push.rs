//! `git push --porcelain` output (contract section 6.6).
//!
//! stdout is `To <url>`, one `<flag>\t<from>:<to>\t<summary>` line per ref and `Done`. `Done` is printed even when refs
//! were rejected: the process exit code, not this parser, says whether the push failed.

use crate::{EngineError, PushFlag, PushRefResult};

fn flag_of(c: &str) -> Option<PushFlag> {
    Some(match c {
        " " => PushFlag::FastForward,
        "+" => PushFlag::Forced,
        "-" => PushFlag::Deleted,
        "*" => PushFlag::NewRef,
        "=" => PushFlag::UpToDate,
        "!" => PushFlag::Rejected,
        _ => return None,
    })
}

/// `[rejected] (fetch first)` / `[remote rejected] (pre-receive hook declined)` -> the parenthesised reason.
fn rejection_reason(summary: &str) -> Option<String> {
    let rest = summary.strip_prefix("[rejected]").or_else(|| summary.strip_prefix("[remote rejected]"))?;
    let rest = rest.trim_start();
    Some(rest.strip_prefix('(').and_then(|r| r.strip_suffix(')')).unwrap_or(rest).to_owned()).filter(|r| !r.is_empty())
}

pub fn parse_push_porcelain(stdout: &str) -> Result<Vec<PushRefResult>, EngineError> {
    let mut refs = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(flag), Some(refspec), Some(summary)) = (parts.next(), parts.next(), parts.next()) else {
            continue; // `To <url>`, `Done`, hook noise
        };
        let Some(flag) = flag_of(flag) else { continue };
        let (from, to) = refspec.split_once(':').unwrap_or((refspec, ""));
        let reason = if flag == PushFlag::Rejected { rejection_reason(summary).or_else(|| Some(summary.to_owned())) } else { None };
        refs.push(PushRefResult { flag, from: from.to_owned(), to: to.to_owned(), summary: summary.to_owned(), reason });
    }
    Ok(refs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Vec<PushRefResult> {
        parse_push_porcelain(s).unwrap()
    }

    #[test]
    fn new_branch_to_differently_named_remote_branch() {
        let r = parse("To /tmp/r.git\n*\trefs/heads/feature/x:refs/heads/release-x\t[new branch]\nDone\n");
        assert_eq!(
            r,
            vec![PushRefResult {
                flag: PushFlag::NewRef,
                from: "refs/heads/feature/x".into(),
                to: "refs/heads/release-x".into(),
                summary: "[new branch]".into(),
                reason: None,
            }]
        );
    }

    #[test]
    fn fast_forward_has_a_space_flag() {
        let r = parse("To u\n \trefs/heads/a:refs/heads/a\t52c8d1a..adbc26b\nDone\n");
        assert_eq!((r[0].flag.clone(), r[0].summary.as_str(), r[0].reason.as_deref()), (PushFlag::FastForward, "52c8d1a..adbc26b", None));
    }

    #[test]
    fn forced_up_to_date_deleted_new_tag() {
        let r = parse(
            "To u\n+\trefs/heads/a:refs/heads/a\t52c8d1a...adbc26b (forced update)\n=\trefs/heads/b:refs/heads/b\t[up to date]\n-\t:refs/heads/c\t[deleted]\n*\trefs/tags/v1:refs/tags/v1\t[new tag]\nDone\n",
        );
        assert_eq!(r.iter().map(|x| x.flag.clone()).collect::<Vec<_>>(), vec![PushFlag::Forced, PushFlag::UpToDate, PushFlag::Deleted, PushFlag::NewRef]);
        assert_eq!((r[2].from.as_str(), r[2].to.as_str()), ("", "refs/heads/c"));
        assert_eq!(r[0].summary, "52c8d1a...adbc26b (forced update)");
    }

    #[test]
    fn rejected_variants_carry_the_reason_text() {
        let r = parse(
            "To u\n!\trefs/heads/a:refs/heads/a\t[rejected] (fetch first)\n!\trefs/heads/b:refs/heads/b\t[rejected] (non-fast-forward)\n!\trefs/heads/c:refs/heads/c\t[rejected] (stale info)\n!\trefs/heads/d:refs/heads/d\t[remote rejected] (pre-receive hook declined)\nDone\n",
        );
        assert_eq!(
            r.iter().map(|x| (x.flag.clone(), x.reason.as_deref().unwrap())).collect::<Vec<_>>(),
            vec![
                (PushFlag::Rejected, "fetch first"),
                (PushFlag::Rejected, "non-fast-forward"),
                (PushFlag::Rejected, "stale info"),
                (PushFlag::Rejected, "pre-receive hook declined"),
            ]
        );
        assert_eq!(r[3].summary, "[remote rejected] (pre-receive hook declined)");
    }

    #[test]
    fn hook_abort_prints_no_ref_lines() {
        assert!(parse("").is_empty());
        assert!(parse("To u\nDone\n").is_empty());
    }

    #[test]
    fn unknown_lines_and_flags_are_skipped() {
        assert_eq!(parse("noise\n?\tx:y\tz\n=\ta:b\t[up to date]\n").len(), 1);
    }
}
