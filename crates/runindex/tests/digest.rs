mod common;

use std::fs;
use std::path::Path;

use common::*;
use intely_agent_core::events::types::*;
use intely_runindex::brief::{DiffSource, FileChange};
use intely_runindex::digest::{build, digest_path, load_or_build, RunDigest, MAX_BYTES};
use serde_json::json;

struct Fake(Result<Vec<FileChange>, String>);

impl DiffSource for Fake {
    fn changes(&self, _: &Path, _: &str) -> Result<Vec<FileChange>, String> {
        self.0.clone()
    }
}

fn change(path: &str, kind: &str) -> FileChange {
    FileChange { path: path.into(), change: kind.into(), additions: 3, deletions: 1 }
}

fn git(files: &[(&str, &str)]) -> Fake {
    Fake(Ok(files.iter().map(|(p, k)| change(p, k)).collect()))
}

fn meta_with_snapshot(repo: &str) -> serde_json::Value {
    json!({ "role": "developer", "model": "claude-haiku-4-5-20251001", "startedAt": 1,
        "repos": [{ "id": repo, "path": format!("/work/{repo}") }],
        "snapshots": [{ "repoId": repo, "path": format!("/work/{repo}"), "refName": "refs/intely/snapshots/r", "skipped": 0 }] })
}

fn bash(l: &mut Log, id: &str, cmd: &str, status: ToolStatus, output: Option<&str>) {
    l.tool(id, "Bash", ToolKind::Exec, json!({ "command": cmd, "description": "x" }), status, output);
}

fn edit_with(l: &mut Log, id: &str, path: &str, new_text: &str) {
    l.push(EventKind::ToolStart { tool_id: id.into(), name: "Edit".into(), tool_kind: ToolKind::Edit, input: json!({ "file_path": path, "old_string": "a", "new_string": new_text }), parent_tool_id: None });
    l.push(EventKind::ToolResult { tool_id: id.into(), status: ToolStatus::Ok, output: None, diff: Some(ToolDiff { path: path.into(), old: Some("a".into()), new: new_text.into() }), duration_ms: Some(3) });
}

fn create(l: &mut Log, id: &str, path: &str) {
    l.push(EventKind::ToolStart { tool_id: id.into(), name: "Write".into(), tool_kind: ToolKind::Edit, input: json!({ "file_path": path, "content": "x" }), parent_tool_id: None });
    l.push(EventKind::ToolResult { tool_id: id.into(), status: ToolStatus::Ok, output: None, diff: Some(ToolDiff { path: path.into(), old: None, new: "x".into() }), duration_ms: Some(3) });
}

fn risk<'a>(d: &'a RunDigest, code: &str) -> Option<&'a intely_runindex::digest::Risk> {
    d.risks.iter().find(|r| r.code == code)
}

fn check_repos(d: &RunDigest, code: &str) -> Option<Vec<String>> {
    d.checks.iter().find(|c| c.code == code).map(|c| c.repo_ids.clone())
}

fn group(d: &RunDigest, purpose: &str) -> (u32, u32, u32) {
    d.groups.iter().find(|g| g.purpose == purpose).map_or((0, 0, 0), |g| (g.created, g.modified, g.deleted))
}

#[test]
fn a_react_app_run_groups_screens_styles_and_tests() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Log::new("react");
    l.prompt("Add a cart badge to the header");
    l.push(EventKind::Plan { items: vec![PlanItem { content: "Add the badge component".into(), status: Some("completed".into()) }, PlanItem { content: "Style it".into(), status: Some("pending".into()) }] });
    edit_with(&mut l, "e1", "/work/web/src/components/Header.tsx", "<Badge/>");
    bash(&mut l, "b1", "npm test -- --run\necho done", ToolStatus::Ok, Some("ok"));
    bash(&mut l, "b2", "npm test -- --run\necho done", ToolStatus::Ok, Some("ok"));
    l.reply("## Done\nThe header now shows a cart badge with the item count.\nMore details.").end(StopReason::EndTurn);
    l.write(dir.path(), Some(meta_with_snapshot("web")));
    let g = git(&[("src/components/Header.tsx", "modified"), ("src/components/CartBadge.tsx", "created"), ("src/App.css", "modified"), ("src/components/CartBadge.test.tsx", "created")]);
    let d = build(dir.path(), "react", &g, 5).unwrap();
    assert_eq!(d.status, "done");
    assert_eq!((d.file_count, d.created, d.modified, d.deleted), (4, 2, 2, 0));
    assert_eq!(group(&d, "ui"), (1, 1, 0));
    assert_eq!(group(&d, "styles"), (0, 1, 0));
    assert_eq!(group(&d, "tests"), (1, 0, 0));
    assert_eq!(d.groups.iter().map(|g| g.purpose.as_str()).collect::<Vec<_>>(), vec!["ui", "styles", "tests"], "in the fixed purpose order");
    assert_eq!(d.repos[0].source, "git");
    assert_eq!(check_repos(&d, "devServer"), Some(vec!["web".to_owned()]));
    assert!(check_repos(&d, "runTests").is_some());
    assert!(check_repos(&d, "iosBuild").is_none() && check_repos(&d, "reinstall").is_none());
    assert!(d.risks.is_empty(), "{:?}", d.risks);
    assert_eq!(d.command_count, 1, "a repeated command is listed once");
    assert_eq!(d.commands[0].text, "npm test -- --run", "first line only");
    let kinds: Vec<_> = d.decisions.iter().map(|x| (x.kind.as_str(), x.text.as_str(), x.done)).collect();
    assert_eq!(kinds, vec![("todo", "Add the badge component", true), ("todo", "Style it", false), ("final", "Done", false)]);
}

#[test]
fn a_react_native_run_touching_permissions_needs_native_rebuilds() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Log::new("rn");
    l.prompt("Show the user's location on a map");
    edit_with(&mut l, "e1", "/work/mobile/ios/Mobile/Info.plist", "<key>NSLocationWhenInUseUsageDescription</key><string>Map</string>");
    edit_with(&mut l, "e2", "/work/mobile/android/app/src/main/AndroidManifest.xml", "<uses-permission android:name=\"android.permission.ACCESS_FINE_LOCATION\"/>");
    edit_with(&mut l, "e3", "/work/mobile/app.json", "{}");
    bash(&mut l, "b1", "cd ios && pod install", ToolStatus::Ok, Some("ok"));
    l.reply("Added the map screen.").end(StopReason::EndTurn);
    l.write(dir.path(), Some(meta_with_snapshot("mobile")));
    let g = git(&[("ios/Mobile/Info.plist", "modified"), ("android/app/src/main/AndroidManifest.xml", "modified"), ("app.json", "modified"), ("src/screens/MapScreen.tsx", "created"), ("ios/Podfile.lock", "modified")]);
    let d = build(dir.path(), "rn", &g, 1).unwrap();
    let perms = risk(&d, "permissionsTouched").expect("permissions risk");
    assert_eq!(perms.evidence, vec!["ios/Mobile/Info.plist", "android/app/src/main/AndroidManifest.xml"]);
    assert_eq!(risk(&d, "configTouched").unwrap().evidence, vec!["app.json"], "manifests are counted as permissions, not twice");
    assert_eq!(risk(&d, "lockfileChanged").unwrap().evidence, vec!["ios/Podfile.lock"]);
    assert_eq!(check_repos(&d, "iosBuild"), Some(vec!["mobile".to_owned()]));
    assert_eq!(check_repos(&d, "androidBuild"), Some(vec!["mobile".to_owned()]));
    assert_eq!(check_repos(&d, "devServer"), Some(vec!["mobile".to_owned()]));
    assert!(d.repos[0].ios && d.repos[0].android);
}

#[test]
fn a_manifest_edit_without_a_permission_is_only_config() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Log::new("plist");
    l.prompt("Rename the app");
    edit_with(&mut l, "e1", "/work/mobile/ios/Mobile/Info.plist", "<key>CFBundleDisplayName</key><string>Shop</string>");
    l.end(StopReason::EndTurn);
    l.write(dir.path(), Some(meta_with_snapshot("mobile")));
    let d = build(dir.path(), "plist", &git(&[("ios/Mobile/Info.plist", "modified")]), 1).unwrap();
    assert!(risk(&d, "permissionsTouched").is_none());
    assert_eq!(risk(&d, "configTouched").unwrap().evidence, vec!["ios/Mobile/Info.plist"]);
}

#[test]
fn an_install_and_a_curl_are_named_packages_and_hosts_only() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Log::new("deps");
    l.prompt("Fetch users from the API");
    bash(&mut l, "b1", "npm install axios@1.7.2 && pnpm add -D @types/lodash@4", ToolStatus::Ok, Some("added 1 package"));
    bash(&mut l, "b2", &format!("curl -H 'Authorization: Bearer {TOKEN}' https://{}@api.example.com:8443/v1/users?token=abc", ["deploy", "hunter2"].join(":")), ToolStatus::Ok, Some("[]"));
    l.tool("w1", "WebFetch", ToolKind::Fetch, json!({ "url": "https://docs.example.org/axios" }), ToolStatus::Ok, Some("docs"));
    l.tool("w2", "WebSearch", ToolKind::Fetch, json!({ "query": "axios interceptors" }), ToolStatus::Ok, Some("results"));
    l.end(StopReason::EndTurn);
    l.write(dir.path(), Some(meta_with_snapshot("web")));
    let d = build(dir.path(), "deps", &git(&[("package.json", "modified"), ("package-lock.json", "modified"), ("src/api/users.ts", "created")]), 1).unwrap();
    let deps = risk(&d, "newDependencies").unwrap();
    assert_eq!((deps.count, deps.evidence.clone()), (2, vec!["axios".to_owned(), "@types/lodash".to_owned()]));
    let net = risk(&d, "networkCalls").unwrap();
    assert_eq!(net.count, 3);
    assert_eq!(net.evidence, vec!["api.example.com", "docs.example.org"]);
    assert!(risk(&d, "lockfileChanged").is_some());
    assert_eq!(check_repos(&d, "reinstall"), Some(vec!["web".to_owned()]));
    assert_eq!(group(&d, "dependencies"), (0, 2, 0));
    let json = serde_json::to_string(&d).unwrap();
    for leaked in ["ghp_", "hunter2", "token=abc"] {
        assert!(!json.contains(leaked), "{leaked} leaked: {json}");
    }
    assert!(d.risks.iter().flat_map(|r| &r.evidence).all(|e| !e.contains('@') || e.starts_with("@types")), "names only, never versions");
}

#[test]
fn deleted_files_git_history_and_failed_commands_are_risks() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Log::new("del");
    l.prompt("Remove the old checkout");
    bash(&mut l, "b1", "rm -rf src/legacy", ToolStatus::Ok, Some(""));
    bash(&mut l, "b2", "npm run build", ToolStatus::Error, Some("ERR! build failed\nExit code 2"));
    bash(&mut l, "b3", "git add -A && git -C . commit -m 'cleanup' && git push origin main", ToolStatus::Denied, None);
    bash(&mut l, "b4", "chmod +x scripts/release.sh", ToolStatus::Ok, None);
    l.end(StopReason::EndTurn);
    l.write(dir.path(), Some(meta_with_snapshot("web")));
    let d = build(dir.path(), "del", &git(&[("src/legacy/Checkout.tsx", "deleted"), ("src/legacy/checkout.css", "deleted"), ("src/routes.tsx", "modified")]), 1).unwrap();
    assert_eq!((d.deleted, d.modified), (2, 1));
    assert_eq!(risk(&d, "filesDeleted").unwrap().evidence, vec!["src/legacy/Checkout.tsx", "src/legacy/checkout.css"]);
    assert_eq!(risk(&d, "gitHistory").unwrap().evidence, vec!["git commit", "git push"]);
    assert_eq!(risk(&d, "permissionsTouched").unwrap().evidence, vec!["chmod"]);
    assert_eq!(risk(&d, "failures").unwrap().count, 1);
    assert!(check_repos(&d, "reviewDeleted").is_some() && check_repos(&d, "reviewFailures").is_some());
    let build_cmd = d.commands.iter().find(|c| c.text == "npm run build").unwrap();
    assert!(build_cmd.failed);
    assert_eq!(build_cmd.exit_code, Some(2));
    assert!(!d.commands[0].failed);
}

#[test]
fn without_a_snapshot_the_files_come_from_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Log::new("nosnap");
    l.prompt("Add a settings screen");
    create(&mut l, "w1", "/work/app/src/screens/Settings.tsx");
    edit_with(&mut l, "e1", "/work/app/src/navigation.ts", "x");
    l.tool("d1", "Delete", ToolKind::Delete, json!({ "path": "/work/app/src/Old.tsx" }), ToolStatus::Ok, None);
    l.tool("d2", "Delete", ToolKind::Delete, json!({ "path": "/work/app/src/Kept.tsx" }), ToolStatus::Denied, None);
    l.end(StopReason::EndTurn);
    l.write(dir.path(), Some(json!({ "role": "developer", "startedAt": 1, "repos": [{ "id": "app", "path": "/work/app" }], "snapshots": [] })));
    let d = build(dir.path(), "nosnap", &Fake(Err("unused".into())), 1).unwrap();
    assert_eq!(d.repos[0].source, "log");
    assert_eq!((d.file_count, d.created, d.modified, d.deleted), (3, 1, 1, 1), "a denied delete changed nothing");
    let ui = d.groups.iter().find(|g| g.purpose == "ui").unwrap();
    assert!(ui.examples.contains(&"src/screens/Settings.tsx".to_owned()), "paths are made relative to the repo: {:?}", ui.examples);
    assert!(serde_json::to_string(&d).unwrap().find("/work/").is_none());
}

#[test]
fn the_plan_and_the_final_message_are_decisions() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Log::new("plan");
    l.prompt("Plan the dark mode");
    l.push(EventKind::PermissionRequest { req_id: "p1".into(), tool_id: "x".into(), intent: intely_agent_core::policy::intent::ToolIntent::exec("ExitPlanMode"), options: vec![], session_allow: None, plan: Some(format!("# Dark mode\n\n1. Add a theme context\n- **Switch** colors in App.css\n- use key {TOKEN}\n- never shown")), plan_truncated: None, modes: vec![], peer: None });
    l.push(EventKind::PermissionResolved { req_id: "p1".into(), outcome: PermissionOutcome::Allow, by: DecidedBy::User });
    l.tool("t1", "TodoWrite", ToolKind::Other, json!({ "todos": [{ "content": "Theme context", "status": "completed" }] }), ToolStatus::Ok, None);
    l.reply("Dark mode is in.").end(StopReason::EndTurn);
    l.write(dir.path(), Some(meta_with_snapshot("web")));
    let d = build(dir.path(), "plan", &git(&[]), 1).unwrap();
    let texts: Vec<_> = d.decisions.iter().map(|x| (x.kind.as_str(), x.text.as_str())).collect();
    assert_eq!(texts, vec![("plan", "Dark mode"), ("plan", "Add a theme context"), ("plan", "Switch colors in App.css"), ("todo", "Theme context"), ("final", "Dark mode is in.")]);
    assert!(!serde_json::to_string(&d).unwrap().contains("ghp_"));
}

#[test]
fn hostile_logs_are_masked_capped_and_malformed_lines_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Log::new("hostile");
    l.prompt("x");
    bash(&mut l, "s1", &format!("GITHUB_TOKEN={TOKEN} npm publish --token {TOKEN}"), ToolStatus::Ok, None);
    let huge = "E".repeat(5_000_000);
    bash(&mut l, "s2", &format!("cat {}", "y".repeat(100_000)), ToolStatus::Error, Some(&huge));
    for i in 0..40 {
        bash(&mut l, &format!("c{i}"), &format!("echo step {i}"), ToolStatus::Ok, None);
    }
    l.reply(&"z".repeat(50_000)).end(StopReason::EndTurn);
    // a torn line, garbage and an unknown event shape in the middle of the log
    let mut text = l.jsonl();
    let mid = text.find('\n').unwrap() + 1;
    text.insert_str(mid, "{\"kind\":\"tool.start\",\"broken\nnot json at all\n{\"agentId\":\"x\",\"kind\":\"from.the.future\"}\n");
    fs::write(dir.path().join("hostile.jsonl"), text).unwrap();
    fs::write(dir.path().join("hostile.meta.json"), serde_json::to_vec(&meta_with_snapshot("web")).unwrap()).unwrap();
    let many: Vec<FileChange> = (0..5_000).map(|i| change(&format!("src/components/very/long/path/to/a/component/number/{i}/{}.tsx", "n".repeat(120)), "modified")).collect();
    let d = build(dir.path(), "hostile", &Fake(Ok(many)), 1).unwrap();
    let json = serde_json::to_string(&d).unwrap();
    assert!(json.len() <= MAX_BYTES, "{} bytes", json.len());
    assert!(!json.contains("ghp_"), "secrets are masked");
    assert!(d.commands[0].text.contains("npm publish"));
    assert_eq!(d.commands.len(), 10);
    assert_eq!(d.command_count, 42);
    assert!(d.commands.iter().all(|c| c.text.chars().count() <= 201));
    assert!(d.decisions.iter().all(|x| x.text.chars().count() <= 201));
    assert_eq!(d.file_count, 5_000, "the count stays true when the list is capped");
    assert!(d.groups.iter().all(|g| g.examples.len() <= 3));
}

#[test]
fn a_finished_digest_is_cached_with_a_fingerprint_and_rebuilt_when_the_log_changes() {
    let dir = tempfile::tempdir().unwrap();
    let runs = dir.path();
    let mut l = Log::new("r1");
    l.prompt("Fix the fee");
    edit_with(&mut l, "e1", "/work/web/src/fee.js", "x");
    l.end(StopReason::EndTurn);
    l.write(runs, Some(meta_with_snapshot("web")));
    let g = git(&[("src/fee.js", "modified")]);
    let first = load_or_build(runs, "r1", &g, 100, false).unwrap();
    let path = digest_path(runs, "r1");
    assert!(path.exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(!runs.join("r1.digest.json.tmp").exists());
    let cached = load_or_build(runs, "r1", &git(&[]), 200, false).unwrap();
    assert_eq!(cached.generated_ms, 100, "served from the cache");
    assert_eq!(cached, first);
    let forced = load_or_build(runs, "r1", &git(&[]), 300, true).unwrap();
    assert_eq!((forced.generated_ms, forced.file_count), (300, 0), "refresh ignores the cache");

    // The run continues: the log grows, the fingerprint no longer matches.
    l.prompt("Also the tax").end(StopReason::EndTurn);
    l.write(runs, None);
    let rebuilt = load_or_build(runs, "r1", &g, 400, false).unwrap();
    assert_eq!(rebuilt.generated_ms, 400);
}

#[test]
fn a_running_run_is_built_but_not_stored_and_a_missing_log_removes_the_cache() {
    let dir = tempfile::tempdir().unwrap();
    let runs = dir.path();
    let mut l = Log::new("live");
    l.prompt("Working");
    l.write(runs, Some(meta_with_snapshot("web")));
    let d = load_or_build(runs, "live", &git(&[]), 1, false).unwrap();
    assert_eq!(d.status, "running");
    assert!(!digest_path(runs, "live").exists());

    fs::write(digest_path(runs, "gone"), b"{}").unwrap();
    assert!(load_or_build(runs, "gone", &git(&[]), 1, false).is_none());
    assert!(!digest_path(runs, "gone").exists());
    assert!(load_or_build(runs, "../live", &git(&[]), 1, false).is_none());
}

#[test]
fn a_corrupt_cache_is_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    finished("r2", "Fix").write(dir.path(), Some(meta_with_snapshot("web")));
    fs::write(digest_path(dir.path(), "r2"), b"{not json").unwrap();
    let d = load_or_build(dir.path(), "r2", &git(&[("src/a.js", "modified")]), 7, false).unwrap();
    assert_eq!((d.generated_ms, d.file_count), (7, 1));
    let stored: RunDigest = serde_json::from_slice(&fs::read(digest_path(dir.path(), "r2")).unwrap()).unwrap();
    assert_eq!(stored, d);
}

#[test]
fn a_run_without_meta_still_lists_the_files_of_its_log() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Log::new("bare");
    l.prompt("Restyle the button");
    edit_with(&mut l, "e1", "/home/someone/project/src/Button.css", "x");
    l.end(StopReason::EndTurn);
    l.write(dir.path(), None);
    let d = build(dir.path(), "bare", &git(&[]), 1).unwrap();
    assert_eq!(d.file_count, 1);
    assert_eq!(d.groups[0].examples, vec!["src/Button.css"], "never the home directory");
    assert_eq!(d.checks.iter().find(|c| c.code == "devServer").map(|c| c.repo_ids.len()), Some(0));
}
