//! Pathname expansion for the analyser: the files an unquoted glob in a command can name.
//!
//! The shell replaces `src/*.js` with the names it matches before the program runs, so `cat .e*` reads `.env` although no word of the
//! command says so. The analyser lists the matches and judges each one like a plain operand. Only the forms of everyday commands are
//! expanded: `*`, `?`, `[set]` (with `!` or `^` to negate and `a-z` ranges) and a `**` directory component (zsh, the shell of this
//! machine, enters directories for it). A name that starts with a dot matches only a pattern that starts with a dot, as in the shell.

use std::path::{Component, Path, PathBuf};

use super::fsview;

/// More matches than this are not judged one by one.
pub const MAX_MATCHES: usize = 5000;
/// Most directory entries that one expansion reads.
const MAX_VISITED: usize = 100_000;

#[derive(Debug, PartialEq, Eq)]
pub enum Expansion {
    /// The matches (none when the pattern names nothing: the shell then passes the pattern itself).
    Files(Vec<PathBuf>),
    /// More matches, or more directory entries, than are judged: the matches found before the limit was reached.
    TooMany(Vec<PathBuf>),
}

/// True when the text holds a glob metacharacter.
pub fn has_meta(s: &str) -> bool {
    s.contains(['*', '?', '['])
}

/// The matches of an absolute pattern. The pattern is not resolved here: `..` and `.` are expected to be gone already.
pub fn expand(pattern: &Path) -> Expansion {
    let comps: Vec<String> = pattern
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let mut out = Vec::new();
    let mut visited = 0usize;
    let complete = walk(Path::new("/"), &comps, &mut out, &mut visited);
    out.sort();
    if complete {
        Expansion::Files(out)
    } else {
        Expansion::TooMany(out)
    }
}

/// `false` when a limit was hit.
fn walk(dir: &Path, rest: &[String], out: &mut Vec<PathBuf>, visited: &mut usize) -> bool {
    let Some((comp, tail)) = rest.split_first() else {
        out.push(dir.to_path_buf());
        return out.len() <= MAX_MATCHES;
    };
    // (`***/` of zsh also follows links and is read the same way here: it includes the folder itself)
    if comp.len() >= 2 && comp.chars().all(|c| c == '*') && !tail.is_empty() {
        // zero directories, then one or more (not through links, and not into dot directories)
        if !walk(dir, tail, out, visited) {
            return false;
        }
        let Some(entries) = fsview::read_dir(dir) else { return true };
        for e in entries {
            *visited += 1;
            if *visited > MAX_VISITED {
                return false;
            }
            if e.name.starts_with('.') || !e.is_dir {
                continue;
            }
            if !walk(&dir.join(&e.name), rest, out, visited) {
                return false;
            }
        }
        return true;
    }
    if !has_meta(comp) {
        let next = dir.join(comp);
        if tail.is_empty() {
            if fsview::symlink_metadata(&next).is_some() {
                out.push(next);
            }
            return out.len() <= MAX_MATCHES;
        }
        return walk(&next, tail, out, visited);
    }
    let Some(entries) = fsview::read_dir(dir) else { return true };
    for e in entries {
        *visited += 1;
        if *visited > MAX_VISITED {
            return false;
        }
        if !matches(comp, &e.name) {
            continue;
        }
        let path = dir.join(&e.name);
        if tail.is_empty() {
            out.push(path);
            if out.len() > MAX_MATCHES {
                return false;
            }
        } else if fsview::is_dir(&path) && !walk(&path, tail, out, visited) {
            return false;
        }
    }
    true
}

/// Does `name` match the glob `pattern` (one path component)?
pub fn matches(pattern: &str, name: &str) -> bool {
    if name.starts_with('.') && !pattern.starts_with('.') {
        return false;
    }
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    match_at(&p, &n)
}

fn match_at(p: &[char], n: &[char]) -> bool {
    let (mut pi, mut ni) = (0usize, 0usize);
    // the last `*` seen: where to go back to when the rest does not fit
    let mut star: Option<(usize, usize)> = None;
    while ni < n.len() {
        let step = match p.get(pi) {
            Some('*') => {
                star = Some((pi, ni));
                pi += 1;
                continue;
            }
            Some('?') => Some(pi + 1),
            Some('[') => match class_end(p, pi) {
                Some((end, set)) => class_has(set, n[ni]).then_some(end),
                // a bracket that is never closed is a plain character
                None => (n[ni] == '[').then_some(pi + 1),
            },
            Some(c) => (*c == n[ni]).then_some(pi + 1),
            None => None,
        };
        match step {
            Some(next) => {
                pi = next;
                ni += 1;
            }
            None => match star {
                Some((sp, sn)) => {
                    pi = sp + 1;
                    ni = sn + 1;
                    star = Some((sp, sn + 1));
                }
                None => return false,
            },
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

/// For `[` at `at`: the index after the closing `]` and the set between the brackets. `None` when it is not closed (then `[` is a plain character).
fn class_end(p: &[char], at: usize) -> Option<(usize, &[char])> {
    let mut i = at + 1;
    if matches!(p.get(i), Some('!' | '^')) {
        i += 1;
    }
    // a `]` right after the opening is a member
    if p.get(i) == Some(&']') {
        i += 1;
    }
    while let Some(c) = p.get(i) {
        if *c == ']' {
            return Some((i + 1, &p[at + 1..i]));
        }
        i += 1;
    }
    None
}

fn class_has(set: &[char], c: char) -> bool {
    let (negate, set) = match set.first() {
        Some('!' | '^') => (true, &set[1..]),
        _ => (false, set),
    };
    let mut i = 0;
    let mut hit = false;
    while i < set.len() {
        if i + 2 < set.len() && set[i + 1] == '-' {
            hit |= set[i] <= c && c <= set[i + 2];
            i += 3;
        } else {
            hit |= set[i] == c;
            i += 1;
        }
    }
    hit != negate
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_matched_the_way_the_shell_does() {
        assert!(matches("*.js", "a.js") && !matches("*.js", ".js") && matches(".*.js", ".a.js"));
        assert!(matches("*", "a") && !matches("*", ".env") && matches(".e*", ".env") && matches(".*", ".env"));
        assert!(matches("a?c", "abc") && !matches("a?c", "ac") && matches("[a-c]x", "bx") && !matches("[a-c]x", "dx") && matches("[!a-c]x", "dx") && matches("[^a-c]x", "dx"));
        assert!(matches("mail*.model.js", "mailBox.model.js") && !matches("mail*.model.js", "mail.model.ts") && matches("*a*b*", "xxaxxbxx") && !matches("*a*b*", "xxbxxaxx"));
        // `]` first in a set is a member, and a bracket that is never closed is a plain character
        assert!(matches("[]a]x", "]x") && matches("a[b", "a[b") && !matches("a[b", "ab"));
        assert!(matches("", "") && !matches("", "a") && matches("*", ""));
    }

    #[test]
    fn a_pattern_expands_to_the_files_it_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        for f in ["src/a.js", "src/b.js", "src/c.ts", "src/.env", "src/deep/x.js", "src/deep/er/y.js", ".git/config"] {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "x").unwrap();
        }
        let names = |pat: &str| match expand(&root.join(pat)) {
            Expansion::Files(v) => v.iter().map(|p| p.strip_prefix(&root).unwrap().display().to_string()).collect::<Vec<_>>(),
            Expansion::TooMany(_) => vec!["TOO MANY".to_string()],
        };
        assert_eq!(names("src/*.js"), ["src/a.js", "src/b.js"]);
        assert_eq!(names("src/*"), ["src/a.js", "src/b.js", "src/c.ts", "src/deep"]);
        assert_eq!(names("src/.e*"), ["src/.env"]);
        assert_eq!(names("src/?.[jt]s"), ["src/a.js", "src/b.js", "src/c.ts"]);
        assert_eq!(names("*/deep/*.js"), ["src/deep/x.js"]);
        assert_eq!(names("src/**/*.js"), ["src/a.js", "src/b.js", "src/deep/er/y.js", "src/deep/x.js"]);
        assert_eq!(names("**/config"), Vec::<String>::new(), "a dot directory is not entered");
        assert_eq!(names("src/none*"), Vec::<String>::new());
        assert_eq!(names("nodir/*.js"), Vec::<String>::new());
        assert_eq!(names("src/a.js"), ["src/a.js"]);
    }

    #[test]
    fn too_many_matches_are_not_judged() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        for i in 0..MAX_MATCHES + 5 {
            std::fs::write(root.join(format!("f{i}.txt")), "").unwrap();
        }
        assert!(matches!(expand(&root.join("*.txt")), Expansion::TooMany(_)));
        assert!(matches!(expand(&root.join("f1.*")), Expansion::Files(v) if v.len() == 1));
    }
}
