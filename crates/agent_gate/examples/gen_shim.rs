//! Writes the production allow-list git shim into a directory: `cargo run -p intely-agent-gate --example gen_shim -- <dir> <real git>`.
//! For the live enforcement harness (`scripts/enforcement-suite.mjs`), which must run its attempts behind the same shim
//! the host puts first on every agent's PATH. Prints the shim directory.

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(dir), Some(git)) = (args.next(), args.next()) else {
        eprintln!("usage: gen_shim <dir> <absolute path of the real git>");
        std::process::exit(2);
    };
    match intely_agent_gate::shim::generate(std::path::Path::new(&dir), std::path::Path::new(&git)) {
        Ok(shim) => println!("{}", shim.dir.display()),
        Err(e) => {
            eprintln!("cannot generate the shim: {e}");
            std::process::exit(1);
        }
    }
}
