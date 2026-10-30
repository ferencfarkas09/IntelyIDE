//! An approximate `.gitignore` reader, enough to answer "would this file name be ignored": plain names, `*` and `?` globs, a leading
//! `/` or a trailing `/`, and `!` re-includes. Only the rules in the file are read (not the global ignore file, not `.git/info`).

pub(crate) struct Ignore {
    rules: Vec<(String, bool)>,
}

fn glob(p: &str, s: &str) -> bool {
    let (p, s): (Vec<char>, Vec<char>) = (p.chars().collect(), s.chars().collect());
    let (mut pi, mut si, mut star, mut mark) = (0, 0, None, 0);
    while si < s.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = si;
            pi += 1;
        } else if let Some(st) = star {
            pi = st + 1;
            mark += 1;
            si = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

impl Ignore {
    pub fn parse(text: &str) -> Ignore {
        let mut rules = Vec::new();
        for l in text.lines().take(5000) {
            let l = l.trim();
            if l.is_empty() || l.starts_with('#') {
                continue;
            }
            let (neg, l) = match l.strip_prefix('!') {
                Some(r) => (true, r),
                None => (false, l),
            };
            let l = l.trim_start_matches('/').trim_end_matches('/');
            if !l.is_empty() {
                rules.push((l.to_string(), neg));
            }
        }
        Ignore { rules }
    }

    pub fn merge(mut self, other: Ignore) -> Ignore {
        self.rules.extend(other.rules);
        self
    }

    /// Whether a file called `name` (last path segment) is ignored. The last matching rule wins, as in Git.
    pub fn ignores(&self, name: &str) -> bool {
        let mut hit = false;
        for (pat, neg) in &self.rules {
            let last = pat.rsplit('/').next().unwrap_or(pat);
            if glob(last, name) {
                hit = !neg;
            }
        }
        hit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_rule_wins_and_globs_work() {
        let i = Ignore::parse("# c\n.env*\n!.env.example\n*.jks\n/build/\n");
        assert!(i.ignores(".env"));
        assert!(i.ignores(".env.local"));
        assert!(!i.ignores(".env.example"));
        assert!(i.ignores("release.jks"));
        assert!(!i.ignores("local.properties"));
        assert!(!Ignore::parse("").ignores(".env"));
    }
}
