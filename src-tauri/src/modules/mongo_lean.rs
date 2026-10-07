//! Zero cost when off, at compile time: a build without the cargo feature `mongo-studio` links no MongoDB code at all, and a
//! build with it does (so the scan below cannot pass by accident). The scan reads this test executable, which links the same
//! library crate the app is built from, for names that only exist when `intely-mongo` or its Tauri glue is compiled in.
//! The needles are built reversed at run time, so the test binary does not contain them itself.

#[cfg(test)]
mod tests {
    use std::process::Command;

    fn needle(reversed: &str) -> String {
        reversed.chars().rev().collect()
    }

    fn exe_contains(text: &str) -> bool {
        let exe = std::env::current_exe().expect("test executable");
        Command::new("grep").args(["-a", "-q", "-F", text]).arg(exe).status().expect("grep").success()
    }

    /// Rust-side names that exist only when the studio is compiled in: the crate in symbols, and the source paths of its code in
    /// panic locations and debug info. (Command names such as `mongo_run` are no good: an embedded UI bundle contains them too.)
    fn studio_names() -> Vec<String> {
        ["ognom_yletni", "crs/ognom/setarc", "sr.ognom/seludom"].iter().map(|n| needle(n)).collect()
    }

    #[cfg(not(feature = "mongo-studio"))]
    #[test]
    fn a_lean_build_contains_no_mongo_code_or_command() {
        assert!(!cfg!(feature = "mongo-studio"));
        for n in studio_names() {
            assert!(!exe_contains(&n), "the lean build links `{n}`: something outside the feature gate pulls the studio in");
        }
    }

    #[cfg(feature = "mongo-studio")]
    #[test]
    fn the_studio_build_does_contain_them_so_the_lean_scan_means_something() {
        let found = studio_names().iter().filter(|n| exe_contains(n)).count();
        assert!(found >= 2, "only {found} of the studio names were found in a build with the feature");
    }
}
