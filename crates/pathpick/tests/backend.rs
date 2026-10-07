mod common;

use std::fs;
use std::sync::Arc;

use intely_core::jail::Jail;
use intely_core::EngineError;
use intely_pathpick::backend::sanitize_title;
use intely_pathpick::*;

fn req() -> NativeRequest {
    NativeRequest { kind: NativeKind::Folder, title: "t".into(), start: None, extensions: vec![], can_create: true }
}

#[test]
fn the_script_is_consumed_in_order_and_exhaustion_cancels() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("pick.jsonl");
    fs::write(&script, "{\"paths\":[\"/fx/a\"]}\n\n{\"cancel\":true}\n{\"paths\":[\"/fx/b\",\"/fx/c\"]}\n").unwrap();
    let b = FakeBackend::new(Arc::new(Jail::e2e(dir.path())), Some(script.clone()));
    assert!(b.available());
    assert_eq!(b.pick(&req()).unwrap(), NativeAnswer::Paths(vec!["/fx/a".into()]));
    assert_eq!(b.pick(&req()).unwrap(), NativeAnswer::Cancelled);
    assert_eq!(b.pick(&req()).unwrap(), NativeAnswer::Paths(vec!["/fx/b".into(), "/fx/c".into()]));
    assert_eq!(b.pick(&req()).unwrap(), NativeAnswer::Cancelled);
    // The file is re-read: a harness may append a line later.
    fs::write(&script, format!("{}{{\"paths\":[\"/fx/d\"]}}\n", fs::read_to_string(&script).unwrap())).unwrap();
    assert_eq!(b.pick(&req()).unwrap(), NativeAnswer::Paths(vec!["/fx/d".into()]));
}

#[test]
fn an_unset_script_cancels() {
    let dir = tempfile::tempdir().unwrap();
    let b = FakeBackend::new(Arc::new(Jail::e2e(dir.path())), None);
    assert_eq!(b.pick(&req()).unwrap(), NativeAnswer::Cancelled);
}

#[test]
fn the_script_is_ignored_outside_the_e2e_jail() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("pick.jsonl");
    fs::write(&script, "{\"paths\":[\"/etc\"]}\n").unwrap();
    for jail in [Jail::off(), Jail::read_only()] {
        let b = FakeBackend::new(Arc::new(jail), Some(script.clone()));
        assert!(!b.available());
        assert_eq!(b.pick(&req()).unwrap_err().code, "nativeFailed");
    }
}

struct Failing;
impl PickBackend for Failing {
    fn available(&self) -> bool {
        true
    }
    fn pick(&self, _: &NativeRequest) -> Result<NativeAnswer, EngineError> {
        Err(EngineError::new("nativeFailed", "boom"))
    }
}
struct Fixed(NativeAnswer);
impl PickBackend for Fixed {
    fn available(&self) -> bool {
        true
    }
    fn pick(&self, _: &NativeRequest) -> Result<NativeAnswer, EngineError> {
        Ok(self.0.clone())
    }
}
struct Unavailable;
impl PickBackend for Unavailable {
    fn available(&self) -> bool {
        false
    }
    fn pick(&self, _: &NativeRequest) -> Result<NativeAnswer, EngineError> {
        panic!("never called")
    }
}

#[test]
fn the_chain_falls_back_on_native_failed_only() {
    let chain = BackendChain(vec![Box::new(Unavailable), Box::new(Failing), Box::new(Fixed(NativeAnswer::Cancelled))]);
    assert!(chain.available());
    assert_eq!(chain.pick(&req()).unwrap(), NativeAnswer::Cancelled);
    let only_failing = BackendChain(vec![Box::new(Failing)]);
    assert_eq!(only_failing.pick(&req()).unwrap_err().code, "nativeFailed");
    let empty = BackendChain(vec![]);
    assert!(!empty.available());
    assert_eq!(empty.pick(&req()).unwrap_err().code, "nativeFailed");
}

#[test]
fn titles_are_clipped_and_stripped() {
    assert_eq!(sanitize_title("Choose\u{0}\n a folder"), "Choose a folder");
    assert_eq!(sanitize_title(&"x".repeat(200)).len(), 80);
}
