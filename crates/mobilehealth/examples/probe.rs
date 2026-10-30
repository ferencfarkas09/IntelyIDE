//! Prints the report of a folder as JSON: `cargo run -p intely-mobilehealth --example probe -- <dir>`.
fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let report = intely_mobilehealth::scan(std::path::Path::new(&dir));
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
