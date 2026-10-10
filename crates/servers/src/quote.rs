//! POSIX shell quoting. EVERY value placed into a remote script goes through here.
//!
//! The remote login shell must be POSIX-like (sh, bash, zsh, dash, ksh) or fish; single quotes behave the same in all.

/// Single-quotes `s` for a POSIX shell. `'` becomes `'\''`. The result is always one shell word.
///
/// A NUL byte cannot be passed in a command line at all; callers validate their inputs before they get here.
pub fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Quotes a path of the server. A leading `~` or `~/` stays expandable: it becomes `"$HOME"` followed by the quoted rest,
/// because a quoted tilde would not expand. Other paths are quoted as they are.
pub fn sh_quote_path_for_remote(p: &str) -> String {
    if p == "~" {
        return "\"$HOME\"".into();
    }
    match p.strip_prefix("~/") {
        Some("") => "\"$HOME\"".into(),
        Some(rest) => format!("\"$HOME\"/{}", sh_quote(rest)),
        None => sh_quote(p),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const HOSTILE: &[&str] = &[
        "",
        "plain",
        "it's",
        "'",
        "''",
        "'; rm -rf / #",
        "a\nb",
        "a\n",
        "\n\n",
        "$(id)",
        "`id`",
        "${HOME}",
        "$HOME",
        "a;b",
        "a && b",
        "a || b",
        "a | b",
        "a > /tmp/x",
        "*",
        "?",
        "[a-z]*",
        "~",
        "~/x",
        "a\\b",
        "\\",
        "\\'",
        "\"",
        "\"quoted\"",
        "tab\there",
        "  spaces  ",
        "-n",
        "-e foo\\n",
        "%s%s%s",
        "ünïcödé ű ő",
        "日本語",
        "emoji \u{1F600}",
        "\u{1b}[31m",
        "!history",
        "#comment",
        "a=b",
        "{a,b}",
        "--",
    ];

    fn shell_echo(arg: &str) -> Vec<u8> {
        let out = Command::new("sh")
            .arg("-c")
            .arg(format!("printf %s {arg}"))
            .env("HOME", "/nonexistent-home")
            .output()
            .unwrap();
        assert!(out.status.success(), "{arg}");
        out.stdout
    }

    #[test]
    fn quoted_values_round_trip_through_sh() {
        for s in HOSTILE {
            assert_eq!(shell_echo(&sh_quote(s)), s.as_bytes(), "{s:?}");
        }
    }

    #[test]
    fn quoted_value_is_one_word_for_a_command() {
        for s in HOSTILE {
            let out = Command::new("sh")
                .arg("-c")
                .arg(format!("set -- {}; printf %s \"$#\"", sh_quote(s)))
                .output()
                .unwrap();
            assert_eq!(out.stdout, b"1", "{s:?}");
        }
    }

    #[test]
    fn quoting_survives_a_second_level() {
        // The sidecar command is `sh -c <quoted script>` and the script holds quoted values.
        for s in HOSTILE {
            let inner = format!("printf %s {}", sh_quote(s));
            let outer = format!("sh -c {}", sh_quote(&inner));
            let out = Command::new("sh").arg("-c").arg(outer).output().unwrap();
            assert_eq!(out.stdout, s.as_bytes(), "{s:?}");
        }
    }

    #[test]
    fn expected_shape() {
        assert_eq!(sh_quote("a"), "'a'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn tilde_paths_expand_home_but_nothing_else() {
        assert_eq!(sh_quote_path_for_remote("~"), "\"$HOME\"");
        assert_eq!(sh_quote_path_for_remote("~/"), "\"$HOME\"");
        assert_eq!(sh_quote_path_for_remote("~/work"), "\"$HOME\"/'work'");
        assert_eq!(sh_quote_path_for_remote("/srv/it's"), "'/srv/it'\\''s'");
        // A tilde that is not a leading `~/` is data.
        assert_eq!(sh_quote_path_for_remote("~user/x"), "'~user/x'");
        assert_eq!(sh_quote_path_for_remote("a/~/x"), "'a/~/x'");
    }

    #[test]
    fn path_quoting_round_trips_with_home() {
        for rest in HOSTILE {
            let p = format!("~/{rest}");
            let out = Command::new("sh")
                .arg("-c")
                .arg(format!("printf %s {}", sh_quote_path_for_remote(&p)))
                .env("HOME", "/h o'me")
                .output()
                .unwrap();
            let want = if rest.is_empty() { "/h o'me".to_string() } else { format!("/h o'me/{rest}") };
            assert_eq!(String::from_utf8_lossy(&out.stdout), want, "{rest:?}");
        }
    }

    #[test]
    fn home_with_hostile_text_is_not_reinterpreted() {
        let out = Command::new("sh")
            .arg("-c")
            .arg(format!("printf %s {}", sh_quote_path_for_remote("~/x")))
            .env("HOME", "/a$(touch /tmp/never)b")
            .output()
            .unwrap();
        assert_eq!(out.stdout, b"/a$(touch /tmp/never)b/x");
    }
}
