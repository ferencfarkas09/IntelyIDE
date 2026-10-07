//! Read-only probe: `cargo run -p intely-l10n --example probe -- <repo> [release]` prints a compact summary.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = std::path::PathBuf::from(args.get(1).expect("repo path"));
    if args.get(2).map(String::as_str) == Some("release") {
        match intely_l10n::release::plan(&root, None) {
            Ok(p) => println!("{} -> {} ({}), base {:?} {:?}, {} commits, langs {:?}, changelog {:?}, tag {:?}", p.current, p.proposed, p.bump, p.base_kind, p.base, p.commits.len(), p.langs, p.changelog_path, p.tag_hint),
            Err(e) => println!("error {}: {}", e.code, e.message),
        }
        return;
    }
    let r = intely_l10n::analyze(&root);
    println!("layout {} langs {:?} catalogs {} changed {} groups {} undefined {} badges {} skipped {}", r.layout, r.langs, r.catalogs, r.changed, r.groups.len(), r.undefined.len(), r.badges.len(), r.skipped);
    for g in &r.groups {
        println!("  {} rows {}", g.group, g.rows.len());
    }
}
