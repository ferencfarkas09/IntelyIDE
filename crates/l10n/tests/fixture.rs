use std::path::{Path, PathBuf};
use std::process::Command;

use intely_l10n::analyze::{analyze, CellState};
use intely_l10n::catalog::{scan, set_key};
use intely_l10n::draft::{parse, DraftItem};
use intely_l10n::edit::{apply, Edit};
use intely_l10n::release::{apply as release_apply, plan, ApplyRequest};

fn git(root: &Path, args: &[&str]) {
    let st = Command::new("git")
        .args(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"])
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .unwrap();
    assert!(st.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&st.stderr));
}

fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/// An admin-shaped repo: modules/<ns>/<lang>.json, three locales, committed.
fn admin_fixture() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    git(&root, &["init", "-q", "-b", "sandbox"]);
    for (lang, hello) in [("en", "Hello"), ("hu", "Szia"), ("de", "Hallo")] {
        write(&root, &format!("src/localization/modules/crm/{lang}.json"), &format!("{{\n  \"hello\": \"{hello}\",\n  \"bye\": \"Bye\"\n}}\n"));
        write(&root, &format!("src/localization/modules/sales/{lang}.json"), "{\n  \"total\": \"Total\"\n}\n");
    }
    write(&root, "package.json", "{\n  \"name\": \"admin\",\n  \"version\": \"3.88.7\"\n}\n");
    write(&root, "src/Page.jsx", "export const A = () => <b>{t('hello')}</b>;\n");
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "init"]);
    (dir, root)
}

#[test]
fn nothing_changed_nothing_reported() {
    let (_d, root) = admin_fixture();
    let r = analyze(&root);
    assert_eq!(r.layout, "admin");
    assert_eq!(r.langs, ["en", "de", "hu"]);
    assert_eq!(r.catalogs, 6);
    assert!(r.groups.is_empty() && r.undefined.is_empty() && r.badges.is_empty());
}

#[test]
fn added_key_in_one_locale_is_missing_in_the_others() {
    let (_d, root) = admin_fixture();
    write(&root, "src/localization/modules/crm/en.json", "{\n  \"hello\": \"Hello\",\n  \"bye\": \"Bye\",\n  \"welcome\": \"Welcome {{name}}\"\n}\n");
    write(&root, "src/localization/modules/crm/hu.json", "{\n  \"hello\": \"Szia\",\n  \"bye\": \"Bye\",\n  \"welcome\": \"Üdv\"\n}\n");
    let r = analyze(&root);
    assert_eq!(r.groups.len(), 1);
    let g = &r.groups[0];
    assert_eq!(g.group, "crm");
    let row = &g.rows[0];
    assert_eq!((row.key.as_str(), row.reason), ("welcome", "added"));
    assert_eq!(row.cells["en"].state, CellState::Ok);
    assert_eq!(row.cells["de"].state, CellState::Missing);
    assert_eq!(row.cells["de"].todo[0].path, ["welcome"]);
    // hu lacks {{name}}.
    assert_eq!(row.cells["hu"].state, CellState::Placeholder);
    assert!(row.cells["hu"].note.as_ref().unwrap().contains("{{name}}"));
    let de = r.totals.iter().find(|t| t.lang == "de").unwrap();
    assert_eq!((de.missing, de.problems), (1, 0));
    // The en and hu catalogs both carry the badge, with the same counts.
    assert!(r.badges.iter().any(|b| b.path == "src/localization/modules/crm/en.json" && b.missing == 1 && b.problems == 1));
}

#[test]
fn key_used_in_code_is_checked_and_undefined_keys_are_listed() {
    let (_d, root) = admin_fixture();
    write(&root, "src/localization/modules/sales/en.json", "{\n  \"total\": \"Total\",\n  \"net\": \"Net\"\n}\n");
    git(&root, &["add", "src/localization/modules/sales/en.json"]);
    git(&root, &["commit", "-q", "-m", "net en only"]);
    write(&root, "src/Page.jsx", "export const A = () => <b>{t('hello')}{t(\"net\")}{t('ghost_key')}{t(`dyn_${x}`)}</b>;\n");
    let r = analyze(&root);
    // "hello" was already in the file before the change, but this line is an added line, so it is checked too (and complete).
    let sales = r.groups.iter().find(|g| g.group == "sales").unwrap();
    let net = sales.rows.iter().find(|x| x.key == "net").unwrap();
    assert_eq!(net.reason, "used");
    assert_eq!(net.cells["hu"].state, CellState::Missing);
    assert_eq!(r.undefined.len(), 1);
    assert_eq!(r.undefined[0].key, "ghost_key");
    assert!(r.badges.iter().any(|b| b.path == "src/Page.jsx" && b.missing >= 2));
}

#[test]
fn plural_forms_follow_the_language() {
    let (_d, root) = admin_fixture();
    write(&root, "src/localization/modules/crm/en.json", "{\n  \"hello\": \"Hello\",\n  \"bye\": \"Bye\",\n  \"items_one\": \"{{count}} item\",\n  \"items_other\": \"{{count}} items\"\n}\n");
    write(&root, "src/localization/modules/crm/de.json", "{\n  \"hello\": \"Hallo\",\n  \"bye\": \"Bye\",\n  \"items_one\": \"{{count}} Eintrag\"\n}\n");
    let r = analyze(&root);
    let row = &r.groups[0].rows[0];
    assert_eq!(row.key, "items");
    assert!(row.plural);
    assert_eq!(row.cells["de"].state, CellState::Plural);
    assert_eq!(row.cells["de"].todo[0].path, ["items_other"]);
    assert_eq!(row.cells["hu"].state, CellState::Missing);
    assert_eq!(row.cells["hu"].todo.len(), 2);
}

#[test]
fn detects_mobile_and_pos_layouts() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    write(root, "locales/en.json", "{\"a\": \"A\"}");
    write(root, "locales/svn.json", "{\"a\": \"A\"}");
    write(root, "locales/ai/en.json", "{\"b\": \"B\"}");
    assert_eq!(analyze(root).layout, "mobile");
    let pos = tempfile::tempdir().unwrap();
    write(pos.path(), "src/localization/en/common.json", "{\"a\": \"A\"}");
    write(pos.path(), "src/localization/zh/common.json", "{\"a\": \"A\"}");
    let r = analyze(pos.path());
    assert_eq!((r.layout, r.catalogs, r.langs.len()), ("pos", 2, 2));
}

#[test]
fn set_key_splices_one_line_and_keeps_everything_else() {
    let text = "{\n  \"a\": \"1\",\n  \"b\": \"2\"\n}\n";
    let out = set_key(text, &["c".into()], "3 \"q\"").unwrap();
    assert_eq!(out, "{\n  \"a\": \"1\",\n  \"b\": \"2\",\n  \"c\": \"3 \\\"q\\\"\"\n}\n");
    assert_eq!(set_key(text, &["a".into()], "x").unwrap(), "{\n  \"a\": \"x\",\n  \"b\": \"2\"\n}\n");
    // Nested, with a missing parent, and an empty object.
    let nested = "{\n    \"x\": {\n        \"y\": \"1\"\n    }\n}";
    assert_eq!(set_key(nested, &["x".into(), "z".into()], "2").unwrap(), "{\n    \"x\": {\n        \"y\": \"1\",\n        \"z\": \"2\"\n    }\n}");
    let made = set_key(nested, &["n".into(), "m".into()], "v").unwrap();
    assert!(serde_json::from_str::<serde_json::Value>(&made).is_ok());
    assert_eq!(scan(&made).unwrap().flat()["n.m"], "v");
    assert_eq!(set_key("{}", &["a".into()], "b").unwrap(), "{\n  \"a\": \"b\"\n}");
    assert!(set_key("{\"a\": \"1\"}", &["a".into(), "b".into()], "x").is_err());
    // Unicode and escapes survive.
    let u = set_key("{\n  \"k\": \"árvíz\"\n}", &["j".into()], "tükör — 🔌").unwrap();
    assert!(u.contains("\"k\": \"árvíz\"") && u.contains("tükör — 🔌"));
    assert_eq!(scan("{\"a\": \"\\u00e1\\n\"}").unwrap().flat()["a"], "á\n");
}

#[test]
fn apply_writes_only_the_accepted_keys() {
    let (_d, root) = admin_fixture();
    let before = std::fs::read_to_string(root.join("src/localization/modules/crm/de.json")).unwrap();
    let edits = vec![Edit { rel: "src/localization/modules/crm/de.json".into(), path: vec!["welcome".into()], value: "Willkommen {{name}}".into() }];
    let a = apply(&root, &edits).unwrap();
    assert_eq!(a.written, 1);
    let after = std::fs::read_to_string(root.join("src/localization/modules/crm/de.json")).unwrap();
    assert!(after.starts_with(before.trim_end().trim_end_matches('}').trim_end()));
    assert_eq!(scan(&after).unwrap().flat()["welcome"], "Willkommen {{name}}");
    // A path outside the catalogs is refused.
    let bad = vec![Edit { rel: "package.json".into(), path: vec!["version".into()], value: "9".into() }];
    assert_eq!(apply(&root, &bad).unwrap_err().code, "badRequest");
    let bad = vec![Edit { rel: "../../etc/passwd".into(), path: vec!["a".into()], value: "9".into() }];
    assert!(apply(&root, &bad).is_err());
    // No temp file is left behind.
    assert!(!root.join("src/localization/modules/crm/de.json.intely-tmp").exists());
}

#[test]
fn draft_answers_are_checked_for_placeholders() {
    let items = vec![
        DraftItem { id: "1".into(), lang: "de".into(), reference: "Hi {{name}}".into(), ref_lang: "en".into() },
        DraftItem { id: "2".into(), lang: "de".into(), reference: "Plain".into(), ref_lang: "en".into() },
    ];
    let out = parse("```json\n[{\"id\":\"1\",\"text\":\"Hallo\"},{\"id\":\"2\",\"text\":\"Schlicht\"},{\"id\":\"9\",\"text\":\"x\"}]\n```", &items).unwrap();
    assert_eq!(out.len(), 2);
    assert!(!out[0].valid && out[0].note.as_ref().unwrap().contains("{{name}}"));
    assert!(out[1].valid);
    assert!(parse("no json", &items).is_err());
}

#[test]
fn release_plan_and_apply_on_a_fixture() {
    let (_d, root) = admin_fixture();
    write(&root, "src/components/modules/whatsNew/changelog.json", "{\n  \"$comment\": \"c\",\n  \"releases\": [\n    {\n      \"version\": \"3.88.0\",\n      \"date\": \"2026-09-27\",\n      \"highlight\": {\n        \"en\": \"Old\",\n        \"hu\": \"Régi\"\n      },\n      \"groups\": []\n    }\n  ]\n}\n");
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "chore: changelog"]);
    git(&root, &["tag", "v3.88.7"]);
    write(&root, "a.txt", "1");
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "feat(crm): let users edit quick statuses"]);
    write(&root, "b.txt", "1");
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "fix: stop the double click on save"]);
    let p = plan(&root, None).unwrap();
    assert_eq!((p.current.as_str(), p.proposed.as_str(), p.bump, p.base_kind), ("3.88.7", "3.89.0", "minor", "tag"));
    assert_eq!(p.commits.len(), 2);
    assert_eq!(p.langs, ["en", "hu"]);
    assert_eq!(p.tag_hint.as_deref(), Some("git tag v3.89.0"));
    assert_eq!(p.entry.groups[0].kind, "feature");
    assert_eq!(p.entry.groups[0].items[0].title["en"], "Let users edit quick statuses");
    assert!(p.diff.contains("-  \"version\": \"3.88.7\"") && p.diff.contains("+  \"version\": \"3.89.0\""));
    let patch = plan(&root, Some("patch")).unwrap();
    assert_eq!(patch.proposed, "3.88.8");

    let before_head = Command::new("git").arg("-C").arg(&root).args(["rev-parse", "HEAD"]).output().unwrap().stdout;
    let wrote = release_apply(&root, &ApplyRequest { version: p.proposed.clone(), entry: Some(p.entry.clone()), changelog_path: p.changelog_path.clone() }).unwrap();
    assert_eq!(wrote, ["package.json", "src/components/modules/whatsNew/changelog.json"]);
    let log: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("src/components/modules/whatsNew/changelog.json")).unwrap()).unwrap();
    assert_eq!(log["releases"][0]["version"], "3.89.0");
    assert_eq!(log["releases"][1]["version"], "3.88.0");
    assert_eq!(log["releases"][0]["groups"][0]["items"][0]["title"]["en"], "Let users edit quick statuses");
    assert!(std::fs::read_to_string(root.join("package.json")).unwrap().contains("\"version\": \"3.89.0\""));
    // Nothing was committed or tagged, and a second apply of the same version is refused.
    let after_head = Command::new("git").arg("-C").arg(&root).args(["rev-parse", "HEAD"]).output().unwrap().stdout;
    assert_eq!(before_head, after_head);
    let again = release_apply(&root, &ApplyRequest { version: p.proposed.clone(), entry: Some(p.entry.clone()), changelog_path: p.changelog_path.clone() });
    assert_eq!(again.unwrap_err().code, "exists");
}
