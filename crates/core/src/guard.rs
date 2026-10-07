//! Never-add / secret / too-large classification (contract section 6.4).

use crate::GuardState;

pub const MAX_UNTRACKED_BYTES: u64 = 5 * 1024 * 1024;

/// Matched against every path component: anything below such a directory is guarded too.
pub const NEVER_ADD: &[&str] = &[
    "dump_*",
    "SERVER_MOVE*",
    "_to_delete",
    "_check_*",
    "_tmp_*",
    "backup_*",
    ".history",
    "crm-export",
];

/// Matched against the file name only.
pub const SECRET: &[&str] = &[
    ".env",
    ".env.*",
    "*.pfx",
    "google-services.json",
    "GoogleService-Info.plist",
    "google-service-account.json",
    "auth.json",
    "*.pem",
    "*.key",
    "*.p12",
    "*.p8",
    "*.jks",
    "*.keystore",
    "id_rsa*",
    "id_ed25519*",
    ".npmrc",
    ".netrc",
    "credentials.json",
    "serviceAccount*.json",
];

/// `.env.example` and friends are committed on purpose and carry no secrets.
const ENV_TEMPLATE_SUFFIXES: &[&str] = &[".example", ".sample", ".template"];

/// `rel_path` is repo-relative and NFC-normalised; `is_new` means the path is not in HEAD yet (untracked, or staged as
/// new), `size` is only known for files on disk. Matching is ASCII case-insensitive because the volume is.
/// The never-add, secret and too-large rules block new files only: a path that is already tracked is the repo's own
/// business, so a secret-looking tracked file is `Sensitive` (selectable, flagged) and a tracked never-add path is `Ok`.
pub fn classify(rel_path: &str, is_new: bool, size: Option<u64>) -> GuardState {
    let mut components = rel_path.split('/').filter(|c| !c.is_empty()).peekable();
    let mut name = "";
    let mut never_add = false;
    while let Some(component) = components.next() {
        never_add |= NEVER_ADD.iter().any(|p| glob_match(p, component));
        if components.peek().is_none() {
            name = component;
        }
    }
    if never_add && is_new {
        return GuardState::NeverAdd;
    }
    if is_secret_name_of(name) {
        return if is_new { GuardState::Secret } else { GuardState::Sensitive };
    }
    if is_new && size.is_some_and(|s| s > MAX_UNTRACKED_BYTES) {
        return GuardState::TooLarge;
    }
    GuardState::Ok
}

/// Whether the file name looks like a secret, tracked or not (the diff view hides such contents until revealed).
pub fn is_secret_name(rel_path: &str) -> bool {
    is_secret_name_of(rel_path.rsplit('/').find(|c| !c.is_empty()).unwrap_or(""))
}

fn is_secret_name_of(name: &str) -> bool {
    SECRET.iter().any(|p| glob_match(p, name)) && !is_env_template(name) && !name.to_ascii_lowercase().ends_with(".pub")
}

fn is_env_template(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with(".env.") && ENV_TEMPLATE_SUFFIXES.iter().any(|s| lower.ends_with(s))
}

/// `*` matches any run of characters; everything else matches literally.
fn glob_match(pattern: &str, text: &str) -> bool {
    let p = pattern.to_ascii_lowercase().into_bytes();
    let t = text.to_ascii_lowercase().into_bytes();
    let (mut pi, mut ti) = (0, 0);
    let mut backtrack: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && p[pi] == b'*' {
            backtrack = Some((pi, ti));
            pi += 1;
        } else if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if let Some((star, matched)) = backtrack {
            pi = star + 1;
            ti = matched + 1;
            backtrack = Some((star, matched + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == b'*')
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn never_add_matches_any_component() {
        for path in [
            "dump_2026-09/users.json",
            "dump_x/",
            "SERVER_MOVE_backup/a",
            "SERVER_MOVE/",
            "_to_delete/old.js",
            "src/_check_things/a.ts",
            "_tmp_probe.js",
            "backup_2025/db.sql",
            ".history/src/a.ts",
            "crm-export/customers.json",
            "src/crm-export/x.json",
        ] {
            assert_eq!(classify(path, true, Some(10)), GuardState::NeverAdd, "{path}");
        }
    }

    #[test]
    fn similar_names_are_not_never_add() {
        for path in ["dumpster/a", "src/backup.ts", "to_delete/x", "history/x", "_tmp.js", "check_x/a"] {
            assert_eq!(classify(path, true, Some(1)), GuardState::Ok, "{path}");
        }
    }

    #[test]
    fn secrets_are_matched_on_the_file_name() {
        for path in [
            ".env",
            "apps/api/.env",
            ".env.production",
            ".env.local",
            "cert/server.pfx",
            "android/app/google-services.json",
            "ios/GoogleService-Info.plist",
            "google-service-account.json",
            "config/auth.json",
            "tls/key.pem",
            "tls/private.KEY",
            "android/app/release.keystore",
            "android/app/upload.jks",
            "AuthKey_ABC.p8",
            "signing/cert.p12",
            ".npmrc",
            "home/.netrc",
            ".ssh/id_rsa",
            "id_ed25519",
            "config/credentials.json",
            "serviceAccountKey.json",
        ] {
            assert_eq!(classify(path, true, None), GuardState::Secret, "{path}");
            assert_eq!(classify(path, false, None), GuardState::Sensitive, "{path} (tracked)");
            assert!(is_secret_name(path), "{path}");
        }
    }

    #[test]
    fn tracked_files_are_never_blocked() {
        assert_eq!(classify(".npmrc", false, None), GuardState::Sensitive);
        assert_eq!(classify("backup_1/.env", false, None), GuardState::Sensitive);
        for path in ["dump_x/a.sql", "backup_2025/db.sql", ".history/a.ts", "src/main.rs"] {
            assert_eq!(classify(path, false, Some(u64::MAX)), GuardState::Ok, "{path}");
        }
        assert!(!is_secret_name("src/main.rs") && !is_secret_name(".env.example") && !is_secret_name("dir/"));
    }

    #[test]
    fn env_templates_and_lookalikes_are_fine() {
        for path in [".env.example", ".env.sample", ".env.template", "environment.ts", "monkey.ts", "my-auth.json", "src/key.ts", "npmrc.md", "id_rsa_notes_dir/readme.md", "credentials.ts", "id_rsa.pub"] {
            assert_eq!(classify(path, false, None), GuardState::Ok, "{path}");
        }
    }

    #[test]
    fn too_large_only_applies_to_untracked_files() {
        assert_eq!(classify("big.bin", true, Some(MAX_UNTRACKED_BYTES + 1)), GuardState::TooLarge);
        assert_eq!(classify("big.bin", true, Some(MAX_UNTRACKED_BYTES)), GuardState::Ok);
        assert_eq!(classify("big.bin", false, Some(MAX_UNTRACKED_BYTES + 1)), GuardState::Ok);
        assert_eq!(classify("dir/", true, None), GuardState::Ok);
    }

    #[test]
    fn never_add_beats_secret_beats_too_large() {
        assert_eq!(classify("backup_1/.env", true, Some(u64::MAX)), GuardState::NeverAdd);
        assert_eq!(classify("a/secret.pem", true, Some(u64::MAX)), GuardState::Secret);
    }

    #[test]
    fn matching_is_case_insensitive_and_nfc_safe() {
        assert_eq!(classify("Dump_1/a", true, None), GuardState::NeverAdd);
        assert_eq!(classify(".ENV", true, None), GuardState::Secret);
        assert_eq!(classify("árvíztűrő/tükörfúrógép.txt", true, Some(3)), GuardState::Ok);
    }

    #[test]
    fn glob_backtracks() {
        assert!(glob_match("a*b*c", "aXbYbZc"));
        assert!(!glob_match("a*b*c", "aXbYbZ"));
        assert!(glob_match("*", ""));
        assert!(glob_match(".env.*", ".env."));
    }
}
