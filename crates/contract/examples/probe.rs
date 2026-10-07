//! Read-only probe: `probe <spec-repo> <client-repo>...` prints counts only (no paths, no snippets).
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use intely_contract::analyze::{analyze, Cache, ClientInput};
use intely_contract::{git, spec};

fn main() {
    let args: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    let t = Instant::now();
    let files = git::list_files(&args[0]);
    let s = spec::load(&args[0], &files).expect("spec");
    println!("spec: {} | {} endpoints | {} definitions | {} source files | {} ms", s.kind, s.endpoints.len(), s.defs.len(), s.files.len(), t.elapsed().as_millis());
    let inputs: Vec<ClientInput> = args[1..].iter().enumerate().map(|(i, p)| ClientInput { id: format!("client{i}"), root: p.clone() }).collect();
    let t = Instant::now();
    let rep = analyze(&s, "spec", &git::fingerprint(&args[0]), &inputs, &Cache::default());
    println!("analysis: {} ms", t.elapsed().as_millis());
    for c in &rep.clients {
        let mut by: BTreeMap<String, usize> = BTreeMap::new();
        for f in &c.findings {
            *by.entry(format!("{}/{}", f.kind, f.severity)).or_default() += 1;
        }
        println!("{}: files {} calls {} matched {} errors {} warnings {} infos {} | {:?}", c.repo_id, c.counts.files, c.counts.calls, c.counts.matched, c.counts.errors, c.counts.warnings, c.counts.infos, by);
    }
    if std::env::var_os("PROBE_SAMPLE").is_some() {
        for c in rep.clients.iter().take(1) {
            for f in c.findings.iter().filter(|f| matches!(f.kind.as_str(), "tagMismatch" | "renamed" | "missing" | "method")).step_by(7).take(14) {
                println!("  {} {} -> {:?} {:?}", f.kind, f.target, f.suggestion.as_ref().map(|s| (&s.id, &s.operation_id, s.similarity)), f.names);
            }
        }
    }
    println!("unused endpoints: {}", rep.unused.len());
}
