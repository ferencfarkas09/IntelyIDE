//! Path matching between client calls and swagger endpoints, plus fuzzy suggestions for renamed endpoints.

use std::collections::HashMap;

use crate::spec::Endpoint;

pub struct Index<'a> {
    pub eps: &'a [Endpoint],
    by_len: HashMap<usize, Vec<usize>>,
    segs: Vec<Vec<&'a str>>,
    by_op: HashMap<&'a str, Vec<usize>>,
}

fn segments(p: &str) -> Vec<&str> {
    p.split('/').filter(|s| !s.is_empty()).collect()
}

fn is_param(s: &str) -> bool {
    s.starts_with('{') || s.starts_with(':') || s.contains("{}")
}

impl<'a> Index<'a> {
    pub fn new(eps: &'a [Endpoint]) -> Self {
        let segs: Vec<Vec<&str>> = eps.iter().map(|e| segments(&e.path)).collect();
        let mut by_len: HashMap<usize, Vec<usize>> = HashMap::new();
        let mut by_op: HashMap<&str, Vec<usize>> = HashMap::new();
        for (i, s) in segs.iter().enumerate() {
            by_len.entry(s.len()).or_default().push(i);
        }
        for (i, e) in eps.iter().enumerate() {
            if let Some(o) = &e.operation_id {
                by_op.entry(o.as_str()).or_default().push(i);
            }
        }
        Index { eps, by_len, segs, by_op }
    }

    pub fn by_operation(&self, op: &str) -> &[usize] {
        self.by_op.get(op).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn operation_ids(&self) -> impl Iterator<Item = &str> {
        self.by_op.keys().copied()
    }

    /// Endpoint indexes whose path matches `client` (with `{}` for interpolations), best score first. Tries the path as
    /// written and with `/api` in front (mobile helpers add the prefix themselves).
    pub fn candidates(&self, client: &str) -> Vec<usize> {
        let variants = [client.to_string(), format!("/api{client}")];
        for v in variants {
            let cs = segments(&v);
            let Some(list) = self.by_len.get(&cs.len()) else { continue };
            let mut scored: Vec<(f32, usize)> = Vec::new();
            for &i in list {
                if let Some(s) = score(&cs, &self.segs[i]) {
                    scored.push((s, i));
                }
            }
            if !scored.is_empty() {
                scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
                return scored.into_iter().map(|(_, i)| i).collect();
            }
        }
        Vec::new()
    }

    /// True when the match only works by letting a client interpolation stand for a literal swagger segment.
    pub fn loose(&self, client: &str, i: usize) -> bool {
        let cs = segments(client);
        let ss = &self.segs[i];
        let off = ss.len().saturating_sub(cs.len());
        cs.iter().zip(ss.iter().skip(off)).any(|(a, b)| is_param(a) && !is_param(b))
    }

    /// The closest path by segment similarity (for "renamed?"), preferring endpoints with `method`.
    pub fn nearest(&self, client: &str, method: Option<&str>) -> Option<(usize, f32)> {
        let with_api = if client.starts_with("/api") { client.to_string() } else { format!("/api{client}") };
        let cs = segments(&with_api);
        let mut best: Option<(f32, usize)> = None;
        for n in [cs.len().saturating_sub(1), cs.len(), cs.len() + 1] {
            let Some(list) = self.by_len.get(&n) else { continue };
            for &i in list {
                let mut s = similarity(&cs, &self.segs[i]);
                if method.is_some_and(|m| self.eps[i].method == m) {
                    s += 0.03;
                }
                if best.is_none_or(|(b, _)| s > b) {
                    best = Some((s, i));
                }
            }
        }
        best.map(|(s, i)| (i, s.min(1.0)))
    }
}

fn score(c: &[&str], s: &[&str]) -> Option<f32> {
    let mut total = 0.0;
    for (a, b) in c.iter().zip(s) {
        let (ap, bp) = (is_param(a), is_param(b));
        total += match (ap, bp) {
            (false, false) if a.eq_ignore_ascii_case(b) => 2.0,
            (false, false) => return None,
            (true, true) => 1.5,
            (false, true) => 1.0,
            (true, false) => 0.5,
        };
    }
    Some(total)
}

pub fn lev(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i];
        for j in 1..=b.len() {
            let c = usize::from(a[i - 1] != b[j - 1]);
            cur.push((prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + c));
        }
        prev = cur;
    }
    prev[b.len()]
}

pub fn ratio(a: &str, b: &str) -> f32 {
    let m = a.chars().count().max(b.chars().count());
    if m == 0 {
        return 1.0;
    }
    1.0 - lev(&a.to_lowercase(), &b.to_lowercase()) as f32 / m as f32
}

fn similarity(c: &[&str], s: &[&str]) -> f32 {
    let n = c.len().max(s.len());
    if n == 0 {
        return 0.0;
    }
    // align from the end: resource names sit at the tail, prefixes (api, versions) at the head
    let mut total = 0.0;
    for k in 0..n {
        let (a, b) = (c.len().checked_sub(1 + k).map(|i| c[i]), s.len().checked_sub(1 + k).map(|i| s[i]));
        total += match (a, b) {
            (Some(a), Some(b)) if is_param(a) && is_param(b) => 1.0,
            (Some(a), Some(b)) if is_param(a) || is_param(b) => 0.7,
            (Some(a), Some(b)) => ratio(a, b),
            _ => 0.0,
        };
    }
    total / n as f32
}
