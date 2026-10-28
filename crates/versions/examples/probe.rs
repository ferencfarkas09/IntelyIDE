//! Prints what the scan finds in a repository: `cargo run -p intely-versions --example probe -- <path>`.
//! Reads only; nothing is written.

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let scan = intely_versions::scan(std::path::Path::new(&path));
    for f in &scan.fields {
        let mixed = if f.mixed { " (not all alike)" } else { "" };
        let also = if f.companions.is_empty() { String::new() } else { format!(" + {}", f.companions.join(", ")) };
        println!("{:<60} {:<8} {:?} x{}{}{}", f.id, f.value, f.role, f.occurrences, mixed, also);
    }
    if scan.truncated {
        println!("(more fields than the list holds)");
    }
    for s in &scan.skipped {
        println!("skipped: {s}");
    }
    println!("{} fields", scan.fields.len());
}
