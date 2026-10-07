mod common;

use common::*;
use intely_agent_core::api::PermissionDecision;
use intely_agent_core::events::{EventKind, EventLog, PermissionOutcome};
use intely_agent_core::hub::{Eligibility, Origin, PromptMode};
use intely_agent_core::policy::intent::ToolIntent;
use intely_remote::gateway::{HostEvent, Out};
use intely_remote::noise::StaticKey;
use intely_remote::phone::PhonePairing;
use intely_remote::transport::Admin;
use intely_remote::util::Clock;
use intely_remote::wire::*;

fn audit_events(env: &Env) -> Vec<String> {
    env.store.audit_tail(500).into_iter().map(|e| e.event).collect()
}

fn answer(op: &str, req: &str, decision: PermissionDecision, hash: Option<String>, proof: Option<StepUpProof>) -> ClientMsg {
    ClientMsg::Answer { op_id: op.into(), req_id: req.into(), agent_id: AGENT.into(), decision: Some(decision), question: None, intent_hash: hash, step_up: proof }
}

// ---------------------------------------------------------------- pairing

#[test]
fn pairing_happy_path_new_device_is_view_only_with_sas_and_relay_registration() {
    let mut env = Env::new();
    let mut phone = env.pair("Sam's iPhone", Capability::View);
    let devs = env.store.devices();
    assert_eq!(devs.len(), 1);
    assert_eq!(devs[0].capability, Capability::View, "view-only is the default posture the Mac user keeps");
    assert_eq!(devs[0].name, "Sam's iPhone");
    assert!(devs[0].passkey.is_some());
    // the relay was told about the pairing token hash and then the device, in that order
    assert!(matches!(env.admin.iter().find(|a| matches!(a, Admin::DevAdd { .. })), Some(Admin::DevAdd { id, .. }) if *id == phone.device_id));
    let got = env.connect(&mut phone);
    assert!(matches!(&got[0], ServerMsg::Hello { capability: Capability::View, .. }));
    assert!(matches!(&got[1], ServerMsg::Snapshot { .. }));
    assert!(audit_events(&env).contains(&"pairing.accepted".to_string()));
}

#[test]
fn pairing_with_the_wrong_code_fails_and_burns_the_offer_after_three_tries() {
    let mut env = Env::new();
    let (view, outs) = env.core.pair_start();
    env.route(outs, "x");
    let good = intely_remote::pairing::parse_manual_code(&view.manual_code).unwrap();
    for i in 0..3 {
        let bad = [7u8 + i; 16];
        let (mut pp, first) = PhonePairing::start(StaticKey::generate(), &env.mac_pub(), &bad, "attacker").unwrap();
        let link = format!("pair-bad{i}");
        let outs = env.core.on_frame(&link, &first);
        // the Mac answers msg2 (it cannot know the PSK is wrong yet); the phone cannot even read it; its hello never comes
        for f in env.route(outs, &link) {
            let _ = pp.on_frame(&f); // fails to decrypt: wrong PSK
        }
        assert!(pp.sas.is_none() || pp.accepted.is_none());
        // a garbage "hello" proves nothing
        let outs = env.core.on_frame(&link, &[5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
        env.route(outs, &link);
    }
    assert!(env.host.iter().any(|h| matches!(h, HostEvent::PairingEnded { outcome } if outcome == "tooManyFailures")));
    // even the right code no longer works: the offer is gone
    let (_pp, first) = PhonePairing::start(StaticKey::generate(), &env.mac_pub(), &good, "late").unwrap();
    let outs = env.core.on_frame("pair-late", &first);
    assert!(env.route(outs, "pair-late").is_empty(), "no handshake answer without an open offer");
    assert!(env.store.devices().is_empty());
}

#[test]
fn pairing_code_is_single_use_and_replay_of_the_first_frame_does_nothing() {
    let mut env = Env::new();
    let (view, outs) = env.core.pair_start();
    env.route(outs, "x");
    let otp = intely_remote::pairing::parse_manual_code(&view.manual_code).unwrap();
    let (mut pp, first) = PhonePairing::start(StaticKey::generate(), &env.mac_pub(), &otp, "phone").unwrap();
    let outs = env.core.on_frame("pair-a", &first);
    for f in env.route(outs, "pair-a") {
        for r in pp.on_frame(&f).unwrap() {
            let outs = env.core.on_frame("pair-a", &r);
            env.route(outs, "pair-a");
        }
    }
    let outs = env.core.pair_confirm(true, Some("A".into()), Capability::View);
    env.route(outs, "pair-a");
    assert_eq!(env.store.devices().len(), 1);
    // an eavesdropper replays the recorded first frame, and a second phone uses the same QR
    let outs = env.core.on_frame("pair-b", &first);
    assert!(env.route(outs, "pair-b").is_empty());
    let (_p2, first2) = PhonePairing::start(StaticKey::generate(), &env.mac_pub(), &otp, "photographer").unwrap();
    let outs = env.core.on_frame("pair-c", &first2);
    assert!(env.route(outs, "pair-c").is_empty());
    assert_eq!(env.store.devices().len(), 1);
}

#[test]
fn pairing_sas_mismatch_registers_nothing() {
    let mut env = Env::new();
    let (view, outs) = env.core.pair_start();
    env.route(outs, "x");
    let otp = intely_remote::pairing::parse_manual_code(&view.manual_code).unwrap();
    let (mut pp, first) = PhonePairing::start(StaticKey::generate(), &env.mac_pub(), &otp, "phone").unwrap();
    let outs = env.core.on_frame("pair-a", &first);
    for f in env.route(outs, "pair-a") {
        for r in pp.on_frame(&f).unwrap() {
            let outs = env.core.on_frame("pair-a", &r);
            env.route(outs, "pair-a");
        }
    }
    let outs = env.core.pair_confirm(false, None, Capability::Reply);
    for f in env.route(outs, "pair-a") {
        pp.on_frame(&f).unwrap();
    }
    assert!(pp.rejected.is_some() && pp.accepted.is_none());
    assert!(env.store.devices().is_empty());
    assert!(env.admin.iter().all(|a| !matches!(a, Admin::DevAdd { .. })));
}

#[test]
fn pairing_offer_expires_after_60_seconds() {
    let mut env = Env::new();
    let (view, outs) = env.core.pair_start();
    env.route(outs, "x");
    env.clock.advance(61_000);
    let outs = env.core.tick();
    env.route(outs, "x");
    assert!(env.host.iter().any(|h| matches!(h, HostEvent::PairingEnded { outcome } if outcome == "expired")));
    let otp = intely_remote::pairing::parse_manual_code(&view.manual_code).unwrap();
    let (_pp, first) = PhonePairing::start(StaticKey::generate(), &env.mac_pub(), &otp, "slow").unwrap();
    let outs = env.core.on_frame("pair-a", &first);
    assert!(env.route(outs, "pair-a").is_empty());
}

#[test]
fn reconnect_requires_a_registered_static_key() {
    let mut env = Env::new();
    let mut stranger = Phone { key: StaticKey::generate(), device_id: "stranger".into(), passkey: p256::ecdsa::SigningKey::from_bytes(&p256::FieldBytes::from([9u8; 32])).unwrap(), credential_id: "c".into(), counter: 0, session: None, inbox: vec![], op: 0 };
    let got = env.connect(&mut stranger);
    assert!(got.is_empty(), "an unknown key learns nothing, not even a handshake reply");
    assert!(stranger.session.as_ref().is_some_and(|s| !s.is_open()));
}

// ---------------------------------------------------------------- resume and live

#[test]
fn seq_resume_replays_exactly_the_missing_events_then_goes_live_without_duplicates() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::View);
    for i in 0..10 {
        env.hub.text(&format!("line {i}"));
    }
    env.connect(&mut phone);
    let msgs = env.sync(&mut phone, &[(AGENT, 4)]);
    let seqs: Vec<u64> = msgs.iter().filter_map(|m| if let ServerMsg::Event { seq, .. } = m { Some(*seq) } else { None }).collect();
    assert_eq!(seqs, (5..=10).collect::<Vec<_>>(), "exactly seq 5..10, in order");

    let e11 = env.hub.text("live one");
    let live = env.live(&mut phone, &e11);
    assert_eq!(live.iter().filter(|m| matches!(m, ServerMsg::Event { seq: 11, .. })).count(), 1);
    // the same event fed again (bus redelivery) and an old one are dropped
    assert!(env.live(&mut phone, &e11).iter().all(|m| !matches!(m, ServerMsg::Event { .. })));
    let old = env.hub.log.read(AGENT).unwrap()[2].clone();
    assert!(env.live(&mut phone, &old).iter().all(|m| !matches!(m, ServerMsg::Event { .. })));
}

#[test]
fn a_live_event_after_a_gap_is_filled_from_the_log() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::View);
    env.hub.text("one");
    env.connect(&mut phone);
    env.sync(&mut phone, &[(AGENT, 1)]);
    // events 2 and 3 are appended but the phone's feed only sees 4 (a missed bus message)
    env.hub.text("two");
    env.hub.text("three");
    let e4 = env.hub.text("four");
    let live = env.live(&mut phone, &e4);
    let seqs: Vec<u64> = live.iter().filter_map(|m| if let ServerMsg::Event { seq, .. } = m { Some(*seq) } else { None }).collect();
    assert_eq!(seqs, vec![2, 3, 4]);
}

#[test]
fn a_lagged_bus_receiver_resyncs_from_the_log() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::View);
    env.connect(&mut phone);
    env.sync(&mut phone, &[]);
    for i in 0..5 {
        env.hub.text(&format!("t{i}"));
    }
    let outs = env.core.on_lagged();
    let msgs = env.deliver(&mut phone, outs);
    let seqs: Vec<u64> = msgs.iter().flat_map(|m| match m { ServerMsg::Event { seq, .. } => vec![*seq], ServerMsg::RunSnapshot { events, .. } => events.iter().map(|e| e.seq).collect(), _ => vec![] }).collect();
    assert_eq!(seqs.last(), Some(&5));
}

#[test]
fn a_log_that_no_longer_reaches_back_sends_a_run_snapshot() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::View);
    // agent-2's log starts at seq 10 (earlier lines were pruned)
    env.hub.runs.lock().unwrap().push(summary("agent-2"));
    for seq in 10..13 {
        let mut e = env.hub.publish_for("agent-2", EventKind::TextDelta { message_id: "m".into(), text: format!("x{seq}"), parent_tool_id: None });
        e.seq = seq;
    }
    // publish_for assigned 1..3; rewrite as a rotated log by using a fresh agent id with explicit seqs
    env.hub.runs.lock().unwrap().push(summary("agent-3"));
    for seq in 10..13u64 {
        let e = intely_agent_core::events::AgentEvent { agent_id: "agent-3".into(), seq, ts: 1, turn_id: None, provider: "claude".into(), kind: EventKind::TextDelta { message_id: "m".into(), text: "y".into(), parent_tool_id: None }, raw: None };
        env.hub.bus.publish(&e).unwrap();
    }
    env.connect(&mut phone);
    let msgs = env.sync(&mut phone, &[("agent-3", 3)]);
    let snap = msgs.iter().find_map(|m| if let ServerMsg::RunSnapshot { run, events, .. } = m { (run.agent_id == "agent-3").then_some(events.clone()) } else { None }).expect("fresh run snapshot");
    assert_eq!(snap.first().map(|e| e.seq), Some(10));
}

#[test]
fn wire_events_never_carry_raw_provider_payloads() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::View);
    env.hub.text("hello");
    env.connect(&mut phone);
    let msgs = env.sync(&mut phone, &[("agent-1", 0)]);
    let text = serde_json::to_string(&msgs).unwrap();
    assert!(!text.contains("RAW-CANARY") && !text.contains("provider_payload"));
    assert!(text.contains("hello"));
}

// ---------------------------------------------------------------- capabilities and answers

#[test]
fn a_view_only_device_cannot_answer_prompt_or_stop() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::View);
    env.connect(&mut phone);
    let p = env.hub.ask_permission("r1", ToolIntent::exec("git status"));
    let m = env.send(&mut phone, answer("a1", "r1", PermissionDecision::AllowOnce, Some(p.intent_hash.clone()), None));
    assert_eq!(Env::ack_of(&m, "a1"), Some((false, Some("forbidden".into()))));
    let m = env.send(&mut phone, ClientMsg::Prompt { op_id: "a2".into(), agent_id: AGENT.into(), text: "hi".into(), mode: PromptMode::Queue, step_up: None });
    assert_eq!(Env::ack_of(&m, "a2"), Some((false, Some("forbidden".into()))));
    let m = env.send(&mut phone, ClientMsg::Stop { op_id: "a3".into(), agent_id: AGENT.into() });
    assert_eq!(Env::ack_of(&m, "a3"), Some((false, Some("forbidden".into()))));
    assert!(env.hub.prompts.lock().unwrap().is_empty() && env.hub.interrupts.lock().unwrap().is_empty() && env.hub.permission_answers.lock().unwrap().is_empty());
    assert!(env.hub.table.get("r1").is_some(), "the request is still open");
}

#[test]
fn a_low_risk_request_is_approved_once_with_one_tap_and_carries_the_remote_origin() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    env.sync(&mut phone, &[]);
    let p = env.hub.ask_permission("r1", ToolIntent::exec("git status"));
    assert_eq!(p.eligibility, Eligibility::Low);
    let m = env.send(&mut phone, answer("a1", "r1", PermissionDecision::AllowOnce, Some(p.intent_hash.clone()), None));
    assert_eq!(Env::ack_of(&m, "a1"), Some((true, None)));
    let answers = env.hub.permission_answers.lock().unwrap().clone();
    assert_eq!(answers[0].2, Origin::Remote { device_id: phone.device_id.clone() });
    assert!(audit_events(&env).contains(&"answer.allow".to_string()));
    // the resolved event reaches the phone with the origin
    let resolved = env.hub.log.read(AGENT).unwrap().into_iter().rev().find(|e| matches!(e.kind, EventKind::PermissionResolved { .. })).unwrap();
    let msgs = env.live(&mut phone, &resolved);
    assert!(msgs.iter().any(|m| matches!(m, ServerMsg::ReqResolved { origin: Origin::Remote { .. }, outcome: PermissionOutcome::Allow, .. })));
}

#[test]
fn a_riskier_request_needs_a_passkey_assertion_bound_to_it() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let p = env.hub.ask_permission("r1", ToolIntent::exec("npm install left-pad"));
    assert_eq!(p.eligibility, Eligibility::StepUp);
    let h = Some(p.intent_hash.clone());
    // no proof, and a proof without asking for a challenge, both fail
    let m = env.send(&mut phone, answer("a1", "r1", PermissionDecision::AllowOnce, h.clone(), None));
    assert_eq!(Env::ack_of(&m, "a1"), Some((false, Some("stepUpRequired".into()))));
    let proof = env.step_up(&mut phone, "r1");
    let m = env.send(&mut phone, answer("a2", "r1", PermissionDecision::AllowOnce, h.clone(), Some(proof.clone())));
    assert_eq!(Env::ack_of(&m, "a2"), Some((true, None)), "{m:?}");
    assert!(audit_events(&env).contains(&"stepup.ok".to_string()));

    // the same proof cannot be used for another request: its challenge is gone
    let p2 = env.hub.ask_permission("r2", ToolIntent::exec("curl https://example.com"));
    let m = env.send(&mut phone, answer("a3", "r2", PermissionDecision::AllowOnce, Some(p2.intent_hash.clone()), Some(proof)));
    assert_eq!(Env::ack_of(&m, "a3"), Some((false, Some("stepUpRequired".into()))));
}

#[test]
fn step_up_rejects_a_wrong_challenge_origin_rp_and_a_forged_signature() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let p = env.hub.ask_permission("r1", ToolIntent::exec("npm install x"));
    let h = Some(p.intent_hash.clone());
    for (i, (rp, origin, tamper)) in [("evil.example", "https://relay.localhost", false), ("relay.localhost", "https://evil.example", false), ("relay.localhost", "https://relay.localhost", true)].into_iter().enumerate() {
        let op = phone.next_op();
        let msgs = env.send(&mut phone, ClientMsg::StepUpBegin { op_id: op, req_id: "r1".into() });
        let ch = msgs.iter().find_map(|m| if let ServerMsg::StepUpChallenge { challenge, .. } = m { Some(challenge.clone()) } else { None }).unwrap();
        let mut proof = env.assertion(&mut phone, &ch, rp, origin);
        if tamper {
            let mut sig = intely_remote::util::b64u_decode(&proof.signature).unwrap();
            let n = sig.len() - 1;
            sig[n] ^= 1;
            proof.signature = intely_remote::util::b64u(&sig);
        }
        let m = env.send(&mut phone, answer(&format!("x{i}"), "r1", PermissionDecision::AllowOnce, h.clone(), Some(proof)));
        assert_eq!(Env::ack_of(&m, &format!("x{i}")), Some((false, Some("stepUpRequired".into()))), "case {i}");
    }
    assert!(env.hub.permission_answers.lock().unwrap().is_empty());
}

#[test]
fn allow_always_is_never_remote_and_allow_for_run_needs_step_up() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let p = env.hub.ask_permission("r1", ToolIntent::exec("git status"));
    let h = Some(p.intent_hash.clone());
    let m = env.send(&mut phone, answer("a1", "r1", PermissionDecision::AllowAlways, h.clone(), None));
    assert_eq!(Env::ack_of(&m, "a1"), Some((false, Some("notRemote".into()))));
    let m = env.send(&mut phone, answer("a2", "r1", PermissionDecision::AllowRun, h.clone(), None));
    assert_eq!(Env::ack_of(&m, "a2"), Some((false, Some("stepUpRequired".into()))));
    // deny is always a plain tap
    let m = env.send(&mut phone, answer("a3", "r1", PermissionDecision::Deny, h, None));
    assert_eq!(Env::ack_of(&m, "a3"), Some((true, None)));
}

#[test]
fn first_answer_wins_between_the_desktop_and_a_phone() {
    // desktop first
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let p = env.hub.ask_permission("r1", ToolIntent::exec("git status"));
    env.hub.desktop_allow("r1").unwrap();
    let m = env.send(&mut phone, answer("a1", "r1", PermissionDecision::AllowOnce, Some(p.intent_hash.clone()), None));
    assert_eq!(Env::ack_of(&m, "a1"), Some((false, Some("alreadyResolved".into()))));
    assert!(audit_events(&env).contains(&"answer.lost".to_string()));
    assert_eq!(env.hub.permission_answers.lock().unwrap().len(), 1, "executed once");

    // phone first, the desktop then loses
    let p = env.hub.ask_permission("r2", ToolIntent::exec("git diff"));
    let m = env.send(&mut phone, answer("a2", "r2", PermissionDecision::AllowOnce, Some(p.intent_hash), None));
    assert_eq!(Env::ack_of(&m, "a2"), Some((true, None)));
    let lost = env.hub.desktop_allow("r2").unwrap_err();
    assert!(matches!(lost, intely_agent_core::hub::HubError::AlreadyResolved { by: Origin::Remote { .. } }));
}

#[test]
fn forged_answers_are_rejected_and_audited() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let real = env.hub.ask_permission("r1", ToolIntent::exec("git status"));

    // unknown request id
    let m = env.send(&mut phone, answer("f1", "nope", PermissionDecision::AllowOnce, Some("x".into()), None));
    assert_eq!(Env::ack_of(&m, "f1"), Some((false, Some("unknownRequest".into()))));
    // another run's id
    let m = env.send(&mut phone, ClientMsg::Answer { op_id: "f2".into(), req_id: "r1".into(), agent_id: "other-run".into(), decision: Some(PermissionDecision::AllowOnce), question: None, intent_hash: Some(real.intent_hash.clone()), step_up: None });
    assert_eq!(Env::ack_of(&m, "f2"), Some((false, Some("wrongRun".into()))));
    // wrong or missing intent hash
    let m = env.send(&mut phone, answer("f3", "r1", PermissionDecision::AllowOnce, Some("00".into()), None));
    assert_eq!(Env::ack_of(&m, "f3"), Some((false, Some("intentMismatch".into()))));
    let m = env.send(&mut phone, answer("f4", "r1", PermissionDecision::AllowOnce, None, None));
    assert_eq!(Env::ack_of(&m, "f4"), Some((false, Some("intentMismatch".into()))));
    // a hard-stopped / desktop-only request that somehow exists
    let hard = env.hub.ask_permission("r-hard", ToolIntent::exec("git commit -m x"));
    assert_eq!(hard.eligibility, Eligibility::DesktopOnly);
    let m = env.send(&mut phone, answer("f5", "r-hard", PermissionDecision::AllowOnce, Some(hard.intent_hash.clone()), None));
    assert_eq!(Env::ack_of(&m, "f5"), Some((false, Some("desktopOnly".into()))));
    // expired
    env.clock.advance(5 * 60_000 + 1);
    let m = env.send(&mut phone, answer("f6", "r1", PermissionDecision::AllowOnce, Some(real.intent_hash.clone()), None));
    let (ok, code) = Env::ack_of(&m, "f6").unwrap();
    assert!(!ok, "{code:?}");
    assert!(env.hub.permission_answers.lock().unwrap().is_empty(), "no forged answer reached the hub");
    let events = audit_events(&env);
    assert!(events.iter().filter(|e| *e == "answer.forged").count() >= 4, "{events:?}");
}

#[test]
fn a_desktop_only_request_is_marked_so_on_the_card_and_never_offered() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    let state = env.dir.path().join("state").join("devices.json");
    env.hub.ask_permission("r-state", ToolIntent::write(&[state.to_str().unwrap()]));
    env.hub.ask_permission("r-push", ToolIntent::exec("git push origin main"));
    env.hub.ask_permission("r-ok", ToolIntent::exec("ls"));
    let got = env.connect(&mut phone);
    let ServerMsg::Snapshot { needs_you, .. } = &got[1] else { panic!() };
    let by = |id: &str| needs_you.iter().find(|c| c.req_id == id).unwrap();
    assert_eq!(by("r-state").eligibility, Eligibility::DesktopOnly);
    assert_eq!(by("r-push").eligibility, Eligibility::DesktopOnly);
    assert_eq!(by("r-ok").eligibility, Eligibility::Low);
}

#[test]
fn questions_are_answered_by_a_reply_device_and_the_loser_is_told() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let pq = env.hub.ask_question("q1", "Ship it?");
    let q = |op: &str| ClientMsg::Answer { op_id: op.into(), req_id: "q1".into(), agent_id: AGENT.into(), decision: None, question: Some(intely_agent_core::api::QuestionAnswer { option_ids: vec!["Yes".into()], text: None }), intent_hash: Some(pq.intent_hash.clone()), step_up: None };
    let m = env.send(&mut phone, q("q-a"));
    assert_eq!(Env::ack_of(&m, "q-a"), Some((true, None)));
    let m = env.send(&mut phone, q("q-b"));
    assert_eq!(Env::ack_of(&m, "q-b"), Some((false, Some("alreadyResolved".into()))));
}

#[test]
fn prompts_stop_and_stop_all_reach_the_hub_with_the_remote_origin() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let m = env.send(&mut phone, ClientMsg::Prompt { op_id: "p1".into(), agent_id: AGENT.into(), text: "continue".into(), mode: PromptMode::Interrupt, step_up: None });
    assert_eq!(Env::ack_of(&m, "p1"), Some((true, None)));
    let m = env.send(&mut phone, ClientMsg::Stop { op_id: "s1".into(), agent_id: AGENT.into() });
    assert_eq!(Env::ack_of(&m, "s1"), Some((true, None)));
    let m = env.send(&mut phone, ClientMsg::StopAll { op_id: "s2".into() });
    assert_eq!(Env::ack_of(&m, "s2"), Some((true, None)));
    let me = Origin::Remote { device_id: phone.device_id.clone() };
    assert_eq!(env.hub.prompts.lock().unwrap()[0], (AGENT.into(), "continue".into(), PromptMode::Interrupt, me.clone()));
    assert_eq!(env.hub.interrupts.lock().unwrap().len(), 2);
    // empty and oversized prompts are refused
    let m = env.send(&mut phone, ClientMsg::Prompt { op_id: "p2".into(), agent_id: AGENT.into(), text: "  ".into(), mode: PromptMode::Queue, step_up: None });
    assert_eq!(Env::ack_of(&m, "p2").unwrap().0, false);
    let big = "x".repeat(9000);
    let m = env.send(&mut phone, ClientMsg::Prompt { op_id: "p3".into(), agent_id: AGENT.into(), text: big, mode: PromptMode::Queue, step_up: None });
    assert_eq!(Env::ack_of(&m, "p3").unwrap().0, false);
}

#[test]
fn starting_a_run_needs_step_up_and_a_remote_startable_template() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let m = env.send(&mut phone, ClientMsg::Start { op_id: "st1".into(), template_id: "tpl-ok".into(), params: serde_json::json!({}), step_up: None });
    assert_eq!(Env::ack_of(&m, "st1"), Some((false, Some("stepUpRequired".into()))));
    let proof = env.step_up(&mut phone, "start:tpl-ok");
    let m = env.send(&mut phone, ClientMsg::Start { op_id: "st2".into(), template_id: "tpl-ok".into(), params: serde_json::json!({}), step_up: Some(proof) });
    assert_eq!(Env::ack_of(&m, "st2"), Some((true, None)), "{m:?}");
    let proof = env.step_up(&mut phone, "start:tpl-other");
    let m = env.send(&mut phone, ClientMsg::Start { op_id: "st3".into(), template_id: "tpl-other".into(), params: serde_json::json!({}), step_up: Some(proof) });
    assert_eq!(Env::ack_of(&m, "st3"), Some((false, Some("unavailable".into()))));
}

// ---------------------------------------------------------------- limits

#[test]
fn prompts_are_rate_limited_and_repeated_hits_demote_the_device() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let mut codes = Vec::new();
    for i in 0..30 {
        let op = format!("r{i}");
        let m = env.send(&mut phone, ClientMsg::Prompt { op_id: op.clone(), agent_id: AGENT.into(), text: "hi".into(), mode: PromptMode::Queue, step_up: None });
        codes.push(Env::ack_of(&m, &op).and_then(|(ok, c)| if ok { None } else { c }));
    }
    assert_eq!(codes.iter().filter(|c| c.is_none()).count(), 10);
    assert!(codes.iter().filter(|c| c.as_deref() == Some("rateLimited")).count() >= 5, "{codes:?}");
    assert!(codes.last().unwrap().as_deref() == Some("forbidden"), "after the demotion everything is forbidden: {codes:?}");
    assert_eq!(env.hub.prompts.lock().unwrap().len(), 10, "10 per minute got through");
    assert_eq!(env.store.device(&phone.device_id).unwrap().capability, Capability::View, "anomaly demotes the device");
    assert!(env.host.iter().any(|h| matches!(h, HostEvent::Anomaly { .. })));
    assert!(audit_events(&env).contains(&"device.demoted".to_string()));
}

#[test]
fn many_approvals_in_a_row_switch_on_step_up_for_15_minutes() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    for i in 0..5 {
        let p = env.hub.ask_permission(&format!("r{i}"), ToolIntent::exec("git status"));
        let m = env.send(&mut phone, answer(&format!("a{i}"), &format!("r{i}"), PermissionDecision::AllowOnce, Some(p.intent_hash), None));
        assert_eq!(Env::ack_of(&m, &format!("a{i}")), Some((true, None)));
    }
    let p = env.hub.ask_permission("r5", ToolIntent::exec("git status"));
    let m = env.send(&mut phone, answer("a5", "r5", PermissionDecision::AllowOnce, Some(p.intent_hash.clone()), None));
    assert_eq!(Env::ack_of(&m, "a5"), Some((false, Some("stepUpRequired".into()))), "fifth consecutive tap inside a minute triggers it");
    // after 15 minutes the one-tap path is back
    env.clock.advance(15 * 60_000 + 1);
    let p = env.hub.ask_permission("r6", ToolIntent::exec("git status"));
    let m = env.send(&mut phone, answer("a6", "r6", PermissionDecision::AllowOnce, Some(p.intent_hash), None));
    assert_eq!(Env::ack_of(&m, "a6"), Some((true, None)));
}

#[test]
fn a_reply_device_is_view_only_until_it_reauthenticates_after_the_window() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    env.clock.advance(13 * 3_600_000);
    let m = env.send(&mut phone, ClientMsg::Prompt { op_id: "p1".into(), agent_id: AGENT.into(), text: "hi".into(), mode: PromptMode::Queue, step_up: None });
    assert_eq!(Env::ack_of(&m, "p1"), Some((false, Some("forbidden".into()))));
    let m = env.send(&mut phone, ClientMsg::Reauth { op_id: "re0".into(), step_up: None });
    let ch = m.iter().find_map(|x| if let ServerMsg::StepUpChallenge { challenge, .. } = x { Some(challenge.clone()) } else { None }).expect("challenge");
    let proof = env.assertion(&mut phone, &ch, "relay.localhost", "https://relay.localhost");
    let m = env.send(&mut phone, ClientMsg::Reauth { op_id: "re".into(), step_up: Some(proof) });
    assert_eq!(Env::ack_of(&m, "re"), Some((true, None)), "{m:?}");
    assert!(m.iter().any(|x| matches!(x, ServerMsg::CapabilityChanged { capability: Capability::Reply, reauth_required: false })));
    let m = env.send(&mut phone, ClientMsg::Prompt { op_id: "p2".into(), agent_id: AGENT.into(), text: "hi".into(), mode: PromptMode::Queue, step_up: None });
    assert_eq!(Env::ack_of(&m, "p2"), Some((true, None)));
}

#[test]
fn a_repeated_op_id_has_no_second_effect() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let msg = ClientMsg::Prompt { op_id: "same".into(), agent_id: AGENT.into(), text: "once".into(), mode: PromptMode::Queue, step_up: None };
    let a = env.send(&mut phone, msg.clone());
    let b = env.send(&mut phone, msg);
    assert_eq!(Env::ack_of(&a, "same"), Some((true, None)));
    assert_eq!(Env::ack_of(&b, "same"), Some((true, None)), "the same ack again");
    assert_eq!(env.hub.prompts.lock().unwrap().len(), 1);
}

// ---------------------------------------------------------------- revocation, kill, panic, tamper

#[test]
fn revocation_mid_session_drops_the_socket_and_a_late_answer_is_rejected_and_audited() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    env.sync(&mut phone, &[]);
    let p = env.hub.ask_permission("r1", ToolIntent::exec("git status"));
    assert!(env.store.revoke(&phone.device_id, "test").unwrap());
    // the local sweep (what the slot triggers) tells the phone and the relay
    let outs = env.core.on_registry_changed();
    assert!(outs.iter().any(|o| matches!(o, Out::Admin(Admin::DevRevoke { id }) if *id == phone.device_id)));
    assert!(outs.iter().any(|o| matches!(o, Out::Close(l) if *l == phone.device_id)));
    let got = env.deliver(&mut phone, outs);
    assert!(got.iter().any(|m| matches!(m, ServerMsg::Revoked)));
    // the phone, not yet knowing, sends an answer on its old session: nothing happens
    let frame = phone.session.as_mut().unwrap().send(&answer("late", "r1", PermissionDecision::AllowOnce, Some(p.intent_hash), None)).unwrap();
    let outs = env.core.on_frame(&phone.device_id, &frame);
    assert!(env.route(outs, &phone.device_id).is_empty(), "no reply, no data");
    assert!(env.hub.permission_answers.lock().unwrap().is_empty());
    assert!(audit_events(&env).contains(&"rejected.revoked".to_string()));
    // and it cannot reconnect: its key is not in the registry any more
    let again = env.connect(&mut phone);
    assert!(again.is_empty());
}

#[test]
fn revocation_without_any_notification_is_still_enforced_on_the_next_frame() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    env.store.revoke(&phone.device_id, "test").unwrap(); // the relay and the sweep never hear about it
    let m = env.send(&mut phone, ClientMsg::Prompt { op_id: "p1".into(), agent_id: AGENT.into(), text: "hi".into(), mode: PromptMode::Queue, step_up: None });
    assert!(m.iter().any(|x| matches!(x, ServerMsg::Revoked)));
    assert!(env.hub.prompts.lock().unwrap().is_empty());
}

#[test]
fn the_kill_switch_closes_every_session_refuses_frames_and_disables_claude_remote_control() {
    let mut env = Env::new();
    let mut a = env.pair("a", Capability::Reply);
    let mut b = env.pair("b", Capability::View);
    env.connect(&mut a);
    env.connect(&mut b);
    let outs = env.core.kill();
    let got_a = env.deliver(&mut a, outs);
    assert!(got_a.iter().any(|m| matches!(m, ServerMsg::Bye { .. })));
    assert!(!env.core.is_enabled());
    assert_eq!(env.hub.rc_disabled.load(std::sync::atomic::Ordering::SeqCst), 1);
    let frame = a.session.as_mut().unwrap().send(&ClientMsg::Ping).unwrap();
    assert!(env.core.on_frame(&a.device_id, &frame).is_empty());
    let (_s, first) = intely_remote::phone::PhoneSession::connect(&b.key, &env.mac_pub()).unwrap();
    assert!(env.core.on_frame(&b.device_id, &first).is_empty(), "no new sessions after the kill switch");
    assert!(audit_events(&env).contains(&"remote.killed".to_string()));
}

#[test]
fn panic_revokes_everything_rotates_the_identity_wipes_the_room_and_stops() {
    let mut env = Env::new();
    let mut a = env.pair("a", Capability::Reply);
    env.connect(&mut a);
    let before = env.store.identity();
    let outs = env.core.panic();
    assert!(outs.iter().any(|o| matches!(o, Out::Admin(Admin::RoomWipe))));
    let got = env.deliver(&mut a, outs);
    assert!(got.iter().any(|m| matches!(m, ServerMsg::Revoked)));
    assert!(env.store.devices().is_empty());
    let after = env.store.identity();
    assert_ne!(before.static_key.public, after.static_key.public);
    assert_ne!(before.room_id, after.room_id);
    assert_ne!(before.mac_token, after.mac_token);
    assert!(!env.core.is_enabled());
    assert!(env.hub.rc_disabled.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    // the old key pair cannot talk to the new Mac key at all
    assert!(intely_remote::phone::PhoneSession::connect(&a.key, &before.static_key.public).is_ok());
    let (_s, first) = intely_remote::phone::PhoneSession::connect(&a.key, &before.static_key.public).unwrap();
    assert!(env.core.on_frame(&a.device_id, &first).is_empty());
}

#[test]
fn an_externally_edited_device_registry_stops_remote() {
    let mut env = Env::new();
    let mut a = env.pair("a", Capability::View);
    env.connect(&mut a);
    let path = env.dir.path().join("state").join("devices.json");
    let mut text = std::fs::read_to_string(&path).unwrap();
    text = text.replace("\"view\"", "\"reply\"");
    std::fs::write(&path, text).unwrap();
    env.clock.advance(31_000);
    let outs = env.core.tick();
    env.route(outs, "x");
    assert!(env.host.iter().any(|h| matches!(h, HostEvent::Tampered(_))));
    assert!(!env.core.is_enabled());
    assert!(audit_events(&env).contains(&"tamper.registry".to_string()));
}

// ---------------------------------------------------------------- fail closed

#[test]
fn garbage_frames_change_nothing_and_a_flood_closes_the_link() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    // garbage on an established session: no state change, the session keeps working in between
    for i in 0..4 {
        let junk = vec![5u8, 1, 2, 3, i, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
        assert!(env.core.on_frame(&phone.device_id, &junk).is_empty());
    }
    let m = env.send(&mut phone, ClientMsg::Ping);
    assert!(m.iter().any(|x| matches!(x, ServerMsg::Pong)), "a good frame after four bad ones still works (the Noise counter did not advance)");
    // unknown tag, empty and tiny frames
    for f in [vec![], vec![9u8, 1, 2], vec![5u8], vec![1u8, 0], vec![3u8, 1, 2, 3]] {
        assert!(env.core.on_frame("someone", &f).is_empty());
    }
    // five bad frames in a row drop the session
    for i in 0..5 {
        let junk = vec![5u8, 9, 9, 9, i, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
        let _ = env.core.on_frame(&phone.device_id, &junk);
    }
    let m = env.send(&mut phone, ClientMsg::Ping);
    assert!(m.is_empty(), "the session was dropped");
    assert!(env.store.audit_len() > 0);
}

#[test]
fn malformed_json_inside_a_valid_channel_is_an_error_not_an_action() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    for raw in [&b"not json"[..], br#"{"v":1,"t":"answer"}"#, br#"{"v":2,"t":"ping"}"#, br#"{"t":"ping"}"#, br#"{"v":1,"t":"nuke","op_id":"x"}"#, br#"{"v":1,"t":"stop","opId":"x","agentId":"a","extra":1}"#, b"[]", b"\xff\xfe"] {
        let frame = phone.session.as_mut().unwrap().send_raw(raw).unwrap();
        let outs = env.core.on_frame(&phone.device_id, &frame);
        let got = env.deliver(&mut phone, outs);
        assert!(got.iter().all(|m| matches!(m, ServerMsg::Ack { ok: false, .. } | ServerMsg::Bye { .. })), "{raw:?} -> {got:?}");
    }
    assert!(env.hub.interrupts.lock().unwrap().is_empty() && env.hub.prompts.lock().unwrap().is_empty());
}

#[test]
fn an_oversized_client_message_is_refused() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let big = format!(r#"{{"v":1,"t":"prompt","opId":"o","agentId":"a","text":"{}","mode":"queue"}}"#, "x".repeat(20_000));
    let frame = phone.session.as_mut().unwrap().send_raw(big.as_bytes()).unwrap();
    let outs = env.core.on_frame(&phone.device_id, &frame);
    let got = env.deliver(&mut phone, outs);
    assert!(got.iter().any(|m| matches!(m, ServerMsg::Ack { ok: false, .. })));
    assert!(env.hub.prompts.lock().unwrap().is_empty());
}

#[test]
fn a_needs_you_request_triggers_a_content_free_notification() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::View);
    env.connect(&mut phone);
    env.sync(&mut phone, &[]);
    env.hub.ask_permission("r1", ToolIntent::exec("rm -rf /secret/project"));
    let e = env.hub.log.read(AGENT).unwrap().pop().unwrap();
    let outs = env.core.on_event(&e);
    let notify = outs.iter().find_map(|o| if let Out::Admin(Admin::Notify { kind, collapse_key }) = o { Some((kind.clone(), collapse_key.clone())) } else { None }).expect("notify");
    assert_eq!(notify.0, intely_remote::transport::NotifyKind::NeedsYou);
    assert!(!format!("{notify:?}").contains("secret"));
}

#[test]
fn diffs_are_served_on_demand_capped_and_secret_paths_are_hidden() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::View);
    env.connect(&mut phone);
    use intely_agent_core::events::{ToolDiff, ToolStatus};
    env.hub.publish(EventKind::ToolResult { tool_id: "t-ok".into(), status: ToolStatus::Ok, output: None, diff: Some(ToolDiff { path: "src/a.rs".into(), old: Some("a".into()), new: "b\n".repeat(50_000) }), duration_ms: None });
    env.hub.publish(EventKind::ToolResult { tool_id: "t-env".into(), status: ToolStatus::Ok, output: None, diff: Some(ToolDiff { path: ".env".into(), old: None, new: "SECRET=1".into() }), duration_ms: None });
    let m = env.send(&mut phone, ClientMsg::DiffGet { op_id: "d1".into(), agent_id: AGENT.into(), tool_id: "t-ok".into() });
    let ServerMsg::Diff { truncated, new, .. } = m.iter().find(|x| matches!(x, ServerMsg::Diff { .. })).expect("diff") else { panic!() };
    assert!(*truncated && new.len() < 50_000);
    let m = env.send(&mut phone, ClientMsg::DiffGet { op_id: "d2".into(), agent_id: AGENT.into(), tool_id: "t-env".into() });
    assert_eq!(Env::ack_of(&m, "d2").unwrap().0, false);
    assert!(!serde_json::to_string(&m).unwrap().contains("SECRET=1"));
}

#[test]
fn a_device_can_sign_itself_out() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    let m = env.send(&mut phone, ClientMsg::SignOut { op_id: "bye".into() });
    assert_eq!(Env::ack_of(&m, "bye"), Some((true, None)));
    assert!(env.store.devices().is_empty());
    let _ = env.clock.now_ms();
}

#[test]
fn a_registered_device_with_a_lost_session_is_told_to_redo_the_handshake_but_strangers_and_revoked_devices_are_not() {
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    // the Mac "restarts": a fresh core over the same state has no sessions
    let hub: std::sync::Arc<dyn intely_agent_core::hub::AgentHub> = env.hub.clone();
    env.core = intely_remote::gateway::GatewayCore::new(common::cfg(), hub, env.store.clone());
    let frame = phone.session.as_mut().unwrap().send(&ClientMsg::Ping).unwrap();
    let outs = env.core.on_frame(&phone.device_id, &frame);
    let sent = env.route(outs, &phone.device_id);
    assert_eq!(sent, vec![vec![intely_remote::noise::tag::RESET, 0]], "one plaintext reset marker");
    let outs = env.core.on_frame(&phone.device_id, &frame);
    assert!(env.route(outs, &phone.device_id).is_empty(), "not again within 5 s");
    let outs = env.core.on_frame("stranger", &frame);
    assert!(env.route(outs, "stranger").is_empty());
    // and a fresh IK handshake works again
    let got = env.connect(&mut phone);
    assert!(matches!(got.first(), Some(ServerMsg::Hello { .. })));
}

// ---------------------------------------------------------------- the run's mode decides what a phone may say to it (modes spec 5.7)

fn set_run_mode(env: &Env, recorded: intely_agent_core::providers::PermissionMode, live: Option<intely_agent_core::providers::PermissionMode>) {
    let mut runs = env.hub.runs.lock().unwrap();
    runs[0].permission = recorded;
    runs[0].requested.permission = recorded;
    runs[0].effective = live.map(|permission| intely_agent_core::api::AgentEffective { effort: None, permission, sandbox: None });
}

fn prompt(op: &str, text: &str, step_up: Option<StepUpProof>) -> ClientMsg {
    ClientMsg::Prompt { op_id: op.into(), agent_id: AGENT.into(), text: text.into(), mode: PromptMode::Queue, step_up }
}

#[test]
fn a_follow_up_to_a_plan_ask_or_edit_run_is_sent_as_before() {
    use intely_agent_core::providers::PermissionMode::{Ask, Edit, ReadOnly};
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    for (i, mode) in [ReadOnly, Ask, Edit].into_iter().enumerate() {
        set_run_mode(&env, mode, Some(mode));
        let op = format!("p{i}");
        let m = env.send(&mut phone, prompt(&op, "continue", None));
        assert_eq!(Env::ack_of(&m, &op), Some((true, None)), "{mode:?}");
    }
    assert_eq!(env.hub.prompts.lock().unwrap().len(), 3);
}

#[test]
fn a_follow_up_to_an_automatic_run_needs_a_passkey_bound_to_the_run_and_the_exact_text() {
    use intely_agent_core::providers::PermissionMode::{Ask, Automatic};
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    set_run_mode(&env, Automatic, Some(Automatic));
    // a bare "do X" is not enough: no approval card would ever stand between it and the files
    let m = env.send(&mut phone, prompt("a1", "run the tests", None));
    assert_eq!(Env::ack_of(&m, "a1"), Some((false, Some("stepUpRequired".into()))), "{m:?}");
    assert!(env.hub.prompts.lock().unwrap().is_empty());

    let key = intely_remote::policy::prompt_step_up_key(AGENT, "run the tests");
    let proof = env.step_up(&mut phone, &key);
    // an assertion for another text is another prompt: it is refused and does nothing
    let m = env.send(&mut phone, prompt("a2", "run the tests, then delete everything", Some(proof.clone())));
    assert_eq!(Env::ack_of(&m, "a2"), Some((false, Some("stepUpRequired".into()))), "{m:?}");
    assert!(env.hub.prompts.lock().unwrap().is_empty());
    // the right text goes through, once: the challenge is single use
    let m = env.send(&mut phone, prompt("a3", "run the tests", Some(proof.clone())));
    assert_eq!(Env::ack_of(&m, "a3"), Some((true, None)), "{m:?}");
    assert_eq!(env.hub.prompts.lock().unwrap().len(), 1);
    let m = env.send(&mut phone, prompt("a4", "run the tests", Some(proof)));
    assert_eq!(Env::ack_of(&m, "a4"), Some((false, Some("stepUpRequired".into()))), "a replayed assertion is refused");
    assert_eq!(env.hub.prompts.lock().unwrap().len(), 1);
    let events = audit_events(&env);
    assert!(events.iter().any(|e| e == "stepup.ok") && events.iter().any(|e| e == "stepup.failed"), "{events:?}");

    // a challenge for a follow-up exists only for a run that is in Automatic mode
    set_run_mode(&env, Ask, Some(Ask));
    let op = phone.next_op();
    let m = env.send(&mut phone, ClientMsg::StepUpBegin { op_id: op.clone(), req_id: key });
    assert_eq!(Env::ack_of(&m, &op), Some((false, Some("unknownRequest".into()))), "{m:?}");
}

#[test]
fn a_bypass_run_is_steered_on_the_mac_but_a_phone_can_still_stop_it_and_the_mode_is_the_looser_of_live_and_recorded() {
    use intely_agent_core::providers::PermissionMode::{Automatic, Bypass, Edit};
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    env.connect(&mut phone);
    for (recorded, live, what) in [(Bypass, Some(Bypass), "live bypass"), (Edit, Some(Bypass), "switched to bypass since it was recorded"), (Bypass, None, "a stopped run recorded as bypass"), (Bypass, Some(Automatic), "resumed as automatic")] {
        set_run_mode(&env, recorded, live);
        let op = format!("b-{what}");
        let m = env.send(&mut phone, prompt(&op, "do it", None));
        assert_eq!(Env::ack_of(&m, &op), Some((false, Some("forbidden".into()))), "{what}: {m:?}");
        assert!(m.iter().any(|x| matches!(x, ServerMsg::Ack { op_id, message, .. } if *op_id == op && message.as_deref().is_some_and(|t| t.contains("Mac")))), "{what}: the phone is told to steer it on the Mac");
    }
    assert!(env.hub.prompts.lock().unwrap().is_empty());
    // stopping is always safe
    set_run_mode(&env, Bypass, Some(Bypass));
    let m = env.send(&mut phone, ClientMsg::Stop { op_id: "s1".into(), agent_id: AGENT.into() });
    assert_eq!(Env::ack_of(&m, "s1"), Some((true, None)));
    let m = env.send(&mut phone, ClientMsg::StopAll { op_id: "s2".into() });
    assert_eq!(Env::ack_of(&m, "s2"), Some((true, None)));
    // a view-only device stays denied in every case
    let mut viewer = env.pair("v", Capability::View);
    env.connect(&mut viewer);
    set_run_mode(&env, Edit, Some(Edit));
    let m = env.send(&mut viewer, prompt("v1", "hi", None));
    assert_eq!(Env::ack_of(&m, "v1"), Some((false, Some("forbidden".into()))));
}

#[test]
fn the_phone_sees_the_plan_excerpt_and_the_run_mode_and_a_plan_approval_carries_no_mode() {
    use intely_agent_core::providers::PermissionMode::{Automatic, Bypass};
    let mut env = Env::new();
    let mut phone = env.pair("p", Capability::Reply);
    // an ExitPlanMode card whose plan the host cut to the 2 KiB excerpt
    let mut p = env.hub.ask_permission("plan1", ToolIntent::other("ExitPlanMode"));
    p.plan_excerpt = Some("1. add the field\n2. migrate".into());
    p.plan_truncated = Some(true);
    env.hub.table.register(p.clone());
    set_run_mode(&env, Automatic, Some(Bypass));
    let got = env.connect(&mut phone);
    let ServerMsg::Snapshot { runs, needs_you, .. } = &got[1] else { panic!() };
    let card = needs_you.iter().find(|c| c.req_id == "plan1").unwrap();
    assert_eq!((card.plan_excerpt.as_deref(), card.plan_truncated), (Some("1. add the field\n2. migrate"), Some(true)));
    assert_eq!(card.eligibility, Eligibility::Low, "approving a plan from the phone is one tap");
    assert_eq!(runs[0].mode, Some(Bypass), "the looser of the recorded and the live mode");
    // the approval is a plain answer: the phone cannot name a working mode, the host continues in Ask
    let m = env.send(&mut phone, answer("ap", "plan1", PermissionDecision::AllowOnce, Some(p.intent_hash), None));
    assert_eq!(Env::ack_of(&m, "ap"), Some((true, None)), "{m:?}");
}
