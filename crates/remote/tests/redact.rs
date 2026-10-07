//! Redaction canaries: nothing secret-shaped may reach the wire, in any field of any event kind.

use intely_agent_core::events::*;
use intely_agent_core::policy::intent::ToolIntent;
use intely_remote::redact::*;
use serde_json::json;

const CANARIES: &[&str] = &[
    "sk-ant-api03-CANARYCANARYCANARYCANARY",
    "ghp_CANARYCANARYCANARYCANARYCANARY0123",
    "github_pat_11CANARYCANARYCANARYCANARY",
    "xoxb-123456789012-CANARYCANARY",
    "AKIACANARYCANARY12",
    "AIzaCANARYCANARYCANARYCANARYCANARYCANARY",
    "hunter2-CANARY-password",
    "CANARY-SECRET-VALUE",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.CANARYSIGNATURECANARYSIGNATURE",
];

fn ev(kind: EventKind) -> AgentEvent {
    AgentEvent { agent_id: "a1".into(), seq: 1, ts: 1, turn_id: None, provider: "claude".into(), kind, raw: Some(json!({"payload": "RAW-CANARY"})) }
}

fn wire(e: &AgentEvent) -> String {
    serde_json::to_string(&Redactor::new().wire_event(e)).unwrap()
}

fn clean(s: &str) {
    for c in CANARIES.iter().chain(["RAW-CANARY"].iter()) {
        assert!(!s.contains(c), "leaked {c}: {s}");
    }
}

#[test]
fn free_text_secrets_are_masked() {
    let text = format!(
        "token {} and {} also {}\nANTHROPIC_API_KEY={}\nexport DB_PASSWORD='{}'\nAuthorization: Bearer {}\n{{\"password\": \"{}\", \"note\": \"fine\"}}\npostgres://admin:{}@db.example.com:5432/app\nBearer {}\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk{}\n-----END OPENSSH PRIVATE KEY-----\nhttps://x.example/?api_key={}&page=2",
        CANARIES[0], CANARIES[1], CANARIES[2], CANARIES[7], CANARIES[6], CANARIES[8], CANARIES[6], CANARIES[6], CANARIES[3], CANARIES[7], CANARIES[7]
    );
    let out = scrub_text(&text);
    clean(&out);
    assert!(out.contains("\"note\": \"fine\"") && out.contains("page=2"), "ordinary content survives: {out}");
    assert!(out.contains("db.example.com:5432/app"), "the host stays readable");
    assert!(out.contains("[redacted private key]"));
}

#[test]
fn ordinary_text_is_not_mangled() {
    for t in ["The sky-high skeleton", "git status -sb", "src/main.rs:42: error[E0308]", "key frame", "ask-me-anything", "sk-short", "mongodb://localhost:27017/test", "https://example.com/a?page=2&sort=asc", "tokenizer settings", "a=b c=d"] {
        assert_eq!(scrub_text(t), t, "{t}");
    }
}

#[test]
fn every_event_kind_is_clean_and_drops_raw() {
    let secret_intent = {
        let mut i = ToolIntent::exec(&format!("curl -H 'Authorization: Bearer {}' https://user:{}@host.example/x", CANARIES[8], CANARIES[6]));
        i.argv = Some(vec!["curl".into(), format!("--token={}", CANARIES[0])]);
        i.paths = vec![format!("/tmp/{}", CANARIES[0])];
        i.url = Some(format!("https://u:{}@h.example/?token={}", CANARIES[6], CANARIES[7]));
        i
    };
    let kinds = vec![
        EventKind::UserMessage { message_id: "m".into(), text: format!("my key is {}", CANARIES[0]), attachments: vec![] },
        EventKind::TextDelta { message_id: "m".into(), text: format!("use {}", CANARIES[1]), parent_tool_id: None },
        EventKind::TextDone { message_id: "m".into(), text: format!("PASSWORD={}", CANARIES[7]), parent_tool_id: None },
        EventKind::ToolStart { tool_id: "t".into(), name: "Bash".into(), tool_kind: ToolKind::Exec, input: json!({"command": format!("echo {}", CANARIES[0]), "env": {"API_TOKEN": CANARIES[7], "PATH": "/bin"}, "headers": [{"authorization": CANARIES[8]}]}), parent_tool_id: None },
        EventKind::ToolUpdate { tool_id: "t".into(), status: ToolStatus::Running, output: Some(format!("DATABASE_PASSWORD={}", CANARIES[6])) },
        EventKind::ToolResult { tool_id: "t".into(), status: ToolStatus::Ok, output: Some(format!("{}\n{}", CANARIES[2], CANARIES[3])), diff: Some(ToolDiff { path: "a.rs".into(), old: None, new: CANARIES[0].into() }), duration_ms: Some(5) },
        EventKind::PermissionRequest { req_id: "r".into(), tool_id: "t".into(), intent: secret_intent, options: vec![PermissionOption::AllowOnce], session_allow: None, plan: None, plan_truncated: None, modes: Vec::new() },
        EventKind::QuestionRequest { req_id: "q".into(), tool_id: None, prompt: format!("is {} yours?", CANARIES[0]), options: vec![QuestionOption { label: CANARIES[1].into(), description: Some(CANARIES[2].into()) }] },
        EventKind::Plan { items: vec![PlanItem { content: format!("rotate {}", CANARIES[0]), status: None }] },
        EventKind::Error { class: ErrorClass::Provider, message: format!("401 for key {}", CANARIES[0]), retryable: false },
        EventKind::SessionInfo { title: Some(format!("work on {}", CANARIES[0])), native_id: Some("native-CANARY-id".into()), models: vec![], caps: None, effective: None, delegates: vec![], slash_commands: vec![], mcp_servers: vec![] },
        EventKind::TurnEnd { stop_reason: StopReason::EndTurn },
    ];
    for k in kinds {
        let e = ev(k);
        let out = wire(&e);
        clean(&out);
        assert!(!out.contains("native-CANARY-id"));
        assert!(out.contains("\"raw\":null"), "raw is dropped: {out}");
    }
}

#[test]
fn thinking_text_never_leaves_and_tool_diffs_are_not_in_events() {
    let mut r = Redactor::new();
    assert!(r.wire_event(&ev(EventKind::ThinkingDelta { message_id: "m".into(), text: "private reasoning".into(), parent_tool_id: None })).is_none());
    let e = ev(EventKind::ToolResult { tool_id: "t".into(), status: ToolStatus::Ok, output: None, diff: Some(ToolDiff { path: "a.rs".into(), old: None, new: "code".into() }), duration_ms: None });
    let w = serde_json::to_string(&r.wire_event(&e)).unwrap();
    assert!(!w.contains("code"), "{w}");
}

#[test]
fn a_note_to_a_working_agent_never_leaves_the_mac() {
    use intely_agent_core::events::NoteState;
    let mut r = Redactor::new();
    for state in [NoteState::Queued, NoteState::Delivered, NoteState::Dropped] {
        let e = ev(EventKind::Note { note_id: "n1".into(), state, parent_tool_id: None, text: Some("use the staging key".into()), tool_id: None, reason: None });
        assert!(r.wire_event(&e).is_none(), "{state:?}");
    }
}

#[test]
fn a_tool_that_touched_a_secret_file_has_its_output_hidden() {
    let mut r = Redactor::new();
    let start = ev(EventKind::ToolStart { tool_id: "t1".into(), name: "Read".into(), tool_kind: ToolKind::Read, input: json!({"file_path": "/work/app/.env"}), parent_tool_id: None });
    r.wire_event(&start).unwrap();
    let res = ev(EventKind::ToolResult { tool_id: "t1".into(), status: ToolStatus::Ok, output: Some("PORT=3000\nSOMETHING_ELSE=visible-looking".into()), diff: None, duration_ms: None });
    let out = serde_json::to_string(&r.wire_event(&res)).unwrap();
    assert!(!out.contains("SOMETHING_ELSE") && out.contains("hidden"), "{out}");
    // an ordinary file is shown
    let start = ev(EventKind::ToolStart { tool_id: "t2".into(), name: "Read".into(), tool_kind: ToolKind::Read, input: json!({"file_path": "/work/app/src/a.rs"}), parent_tool_id: None });
    r.wire_event(&start).unwrap();
    let res = ev(EventKind::ToolResult { tool_id: "t2".into(), status: ToolStatus::Ok, output: Some("fn main() {}".into()), diff: None, duration_ms: None });
    assert!(serde_json::to_string(&r.wire_event(&res)).unwrap().contains("fn main"));
    // diffs: secret paths hidden
    assert!(r.wire_diff(&ToolDiff { path: "/work/app/.env.local".into(), old: None, new: "X=1".into() }).is_none());
    assert!(r.wire_diff(&ToolDiff { path: "/work/app/id_rsa".into(), old: None, new: "X=1".into() }).is_none());
}

#[test]
fn tool_output_is_capped_head_and_tail_and_prose_is_capped() {
    let mut r = Redactor::new();
    let big: String = (0..20_000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
    let e = ev(EventKind::ToolResult { tool_id: "t".into(), status: ToolStatus::Ok, output: Some(big.clone()), diff: None, duration_ms: None });
    let out = r.wire_event(&e).unwrap();
    let EventKind::ToolResult { output: Some(o), .. } = out.kind else { panic!() };
    assert!(o.len() < 4500 && o.contains("omitted") && o.starts_with("abcd") && o.ends_with(&big[big.len() - 8..]));
    let t = ev(EventKind::TextDone { message_id: "m".into(), text: big, parent_tool_id: None });
    let EventKind::TextDone { text, .. } = r.wire_event(&t).unwrap().kind else { panic!() };
    assert!(text.len() < 9000);
}

#[test]
fn invisible_and_bidi_characters_are_made_visible_in_cards() {
    let sneaky = "git status \u{202E}; rm -rf ~\u{202C}\u{200B}\u{0007}";
    let shown = display(sneaky, 500);
    assert!(!shown.contains('\u{202E}') && !shown.contains('\u{200B}') && !shown.contains('\u{0007}'));
    assert!(shown.contains("<U+202E>") && shown.contains("<U+200B>"));
    let i = intely_remote::redact::wire_intent(&ToolIntent::exec(sneaky));
    assert!(!i.raw_command.unwrap().contains('\u{202E}'));
}

#[test]
fn scrubbing_is_bounded_and_does_not_panic_on_hostile_input() {
    for s in ["", "=", "====", ":::::", "://", "://@", "-----BEGIN ", "-----BEGIN PRIVATE KEY-----", "Bearer ", "eyJ", "\"password\":", "PASSWORD=", "PASSWORD=\"", "a=\u{1F600}\u{1F600}", "\u{0}\u{0}", &"A".repeat(200_000), &"=".repeat(50_000), &"sk-".repeat(20_000)] {
        let _ = scrub_text(s);
        let _ = display(s, 100);
    }
}
