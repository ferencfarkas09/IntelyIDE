use std::cell::RefCell;
use std::collections::HashMap;

use super::*;
use crate::roster::{Role, RosterMember};
use crate::state::member_entry;

#[derive(Default)]
struct Fake {
    /// key -> (version, author, bytes)
    blobs: HashMap<String, (u64, String, Vec<u8>)>,
    /// The next `list` shows nothing (a stale read), to provoke a 409.
    blind_once: bool,
    puts: u32,
}

struct Handle<'a>(&'a RefCell<Fake>, String);

impl Remote for Handle<'_> {
    async fn list(&mut self) -> Result<Vec<Head>> {
        let mut f = self.0.borrow_mut();
        if std::mem::take(&mut f.blind_once) {
            return Ok(vec![]);
        }
        Ok(f.blobs.iter().map(|(k, (v, a, _))| Head { key: k.clone(), version: *v, author: a.clone(), ts: 0 }).collect())
    }
    async fn get(&mut self, key: &str) -> Result<Option<Blob>> {
        Ok(self.0.borrow().blobs.get(key).map(|(v, a, d)| Blob { version: *v, author: a.clone(), data: d.clone() }))
    }
    async fn put(&mut self, key: &str, base: u64, data: &[u8]) -> Result<PutOutcome> {
        let mut f = self.0.borrow_mut();
        let have = f.blobs.get(key).map_or(0, |b| b.0);
        if have != base {
            return Ok(PutOutcome::Conflict);
        }
        f.puts += 1;
        f.blobs.insert(key.to_string(), (have + 1, self.1.clone(), data.to_vec()));
        Ok(PutOutcome::Ok(have + 1))
    }
}

const PROJECT: &str = "00112233445566778899aabbccddeeff";

struct Member {
    id: Identity,
    dir: tempfile::TempDir,
    st: MemState,
    claude_md: bool,
}

impl Member {
    fn new(id: Identity) -> Self {
        Self { id, dir: tempfile::tempdir().unwrap(), st: MemState::default(), claude_md: true }
    }
    fn roots(&self) -> Roots {
        Roots { project: PROJECT.into(), repo: self.dir.path().join("repo"), memory_dir: self.dir.path().join("mem"), claude_md: self.claude_md }
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.roots().local(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.roots().local(rel)).ok()
    }
}

struct World {
    roster: RosterBody,
    keys: Keyring,
    relay: RefCell<Fake>,
}

impl World {
    fn new(ids: &[(&Identity, &str)]) -> Self {
        let members: Vec<RosterMember> = ids.iter().map(|(i, n)| member_entry(i, n, Role::Member)).collect();
        Self { roster: RosterBody { team_id: "team-1".into(), version: 1, epoch: 1, ts: 0, members }, keys: Keyring::genesis(), relay: Default::default() }
    }
    async fn sync(&self, m: &mut Member, now: u64) -> Report {
        let cx = Ctx { team_id: "team-1", keys: &self.keys, me: &m.id, roster: &self.roster };
        let roots = [m.roots()];
        let mut h = Handle(&self.relay, m.id.member_id.clone());
        super::sync(&mut h, &cx, &roots, &mut m.st, now).await.unwrap()
    }
}

fn two() -> (World, Member, Member) {
    let (a, b) = (Identity::fresh(), Identity::fresh());
    let w = World::new(&[(&a, "Ana"), (&b, "Bob")]);
    (w, Member::new(a), Member::new(b))
}

#[tokio::test]
async fn push_then_pull() {
    let (w, mut a, mut b) = two();
    a.write("memory/x.md", "one");
    a.write("CLAUDE.md", "rules");
    assert_eq!(w.sync(&mut a, 1).await.pushed, 2);
    let rep = w.sync(&mut b, 2).await;
    assert_eq!(rep.applied.len(), 1);
    assert_eq!(rep.pending_new.len(), 1, "CLAUDE.md waits for a person");
    assert_eq!(b.read("memory/x.md").as_deref(), Some("one"));
    assert_eq!(b.read("CLAUDE.md"), None);
    // nothing changed: nothing moves, and the relay only holds ciphertext under hashed keys
    assert_eq!(w.sync(&mut b, 3).await.pushed, 0);
    assert_eq!(w.relay.borrow().puts, 2);
    assert!(w.relay.borrow().blobs.values().all(|(_, _, d)| !String::from_utf8_lossy(d).contains("rules")));
    assert!(w.relay.borrow().blobs.keys().all(|k| !k.contains("md")));
    a.write("memory/x.md", "two");
    w.sync(&mut a, 4).await;
    w.sync(&mut b, 5).await;
    assert_eq!(b.read("memory/x.md").as_deref(), Some("two"));
    assert!(b.st.files.values().any(|f| f.author == a.id.member_id && f.version == 2));
}

#[tokio::test]
async fn both_changed_keeps_remote_and_a_conflict_copy() {
    let (w, mut a, mut b) = two();
    a.write("memory/x.md", "base");
    w.sync(&mut a, 1).await;
    w.sync(&mut b, 2).await;
    a.write("memory/x.md", "from ana");
    b.write("memory/x.md", "from bob");
    w.sync(&mut a, 3).await;
    let rep = w.sync(&mut b, 4).await;
    assert_eq!(rep.applied[0].kind, "conflict");
    assert_eq!(b.read("memory/x.md").as_deref(), Some("from ana"));
    let c = b.st.conflicts[0].clone();
    assert!(c.file.starts_with("x.conflict-Bob-4") && c.file.ends_with(".md"));
    assert_eq!(std::fs::read_to_string(b.roots().memory_dir.join(&c.file)).unwrap(), "from bob");
    // the conflict copy never syncs
    w.sync(&mut b, 5).await;
    assert_eq!(w.relay.borrow().blobs.len(), 1);
    // use mine: the copy becomes the file and goes out
    resolve(&b.roots(), &mut b.st, "memory/x.md", true).unwrap();
    assert!(b.st.conflicts.is_empty() && !b.roots().memory_dir.join(&c.file).exists());
    w.sync(&mut b, 6).await;
    w.sync(&mut a, 7).await;
    assert_eq!(a.read("memory/x.md").as_deref(), Some("from bob"));
}

#[tokio::test]
async fn keep_theirs_drops_the_copy() {
    let (w, mut a, mut b) = two();
    a.write("memory/x.md", "base");
    w.sync(&mut a, 1).await;
    w.sync(&mut b, 2).await;
    a.write("memory/x.md", "A");
    b.write("memory/x.md", "B");
    w.sync(&mut a, 3).await;
    w.sync(&mut b, 4).await;
    resolve(&b.roots(), &mut b.st, "memory/x.md", false).unwrap();
    assert_eq!(b.read("memory/x.md").as_deref(), Some("A"));
    assert_eq!(std::fs::read_dir(b.roots().memory_dir).unwrap().count(), 1);
    assert!(resolve(&b.roots(), &mut b.st, "memory/x.md", false).is_err());
}

#[tokio::test]
async fn a_stale_list_gives_409_and_the_same_conflict_rules() {
    let (w, mut a, mut b) = two();
    a.write("memory/x.md", "base");
    w.sync(&mut a, 1).await;
    w.sync(&mut b, 2).await;
    a.write("memory/x.md", "A");
    w.sync(&mut a, 3).await;
    b.write("memory/x.md", "B");
    w.relay.borrow_mut().blind_once = true;
    let rep = w.sync(&mut b, 4).await;
    assert_eq!(rep.pushed, 0);
    assert_eq!(b.read("memory/x.md").as_deref(), Some("A"));
    assert_eq!(b.st.conflicts.len(), 1);
}

#[tokio::test]
async fn tombstones_delete_unchanged_files_only() {
    let (w, mut a, mut b) = two();
    a.write("memory/x.md", "t");
    a.write("memory/y.md", "t");
    w.sync(&mut a, 1).await;
    w.sync(&mut b, 2).await;
    std::fs::remove_file(a.roots().local("memory/x.md")).unwrap();
    std::fs::remove_file(a.roots().local("memory/y.md")).unwrap();
    assert_eq!(w.sync(&mut a, 3).await.pushed, 2);
    b.write("memory/y.md", "edited");
    let rep = w.sync(&mut b, 4).await;
    assert_eq!(b.read("memory/x.md"), None);
    assert!(rep.applied.iter().any(|e| e.kind == "delete" && e.path == "memory/x.md"));
    // changed since its base: the remote deletion becomes a conflict, the text survives in the copy
    assert!(rep.applied.iter().any(|e| e.kind == "conflict" && e.path == "memory/y.md"));
    assert_eq!(b.read("memory/y.md"), None);
    let c = b.st.conflicts[0].clone();
    assert_eq!(std::fs::read_to_string(b.roots().memory_dir.join(&c.file)).unwrap(), "edited");
    resolve(&b.roots(), &mut b.st, "memory/y.md", true).unwrap();
    assert_eq!(w.sync(&mut b, 5).await.pushed, 1);
    w.sync(&mut a, 6).await;
    assert_eq!(a.read("memory/y.md").as_deref(), Some("edited"));
}

#[test]
fn paths_are_checked() {
    for ok in ["CLAUDE.md", "memory/MEMORY.md", "memory/feedback_a-b.md"] {
        assert!(valid_path(ok), "{ok}");
    }
    for bad in ["../CLAUDE.md", "/etc/passwd", "memory/../x.md", "memory/a/b.md", "memory/x.txt", "memory/.hidden.md", "memory/a b.md", "memory/x.conflict-a-1.md", "claude.md", "memory/", "memory/\\x.md", ""] {
        assert!(!valid_path(bad), "{bad}");
    }
}

#[tokio::test]
async fn incoming_traversal_paths_are_rejected() {
    let (w, a, mut b) = two();
    let evil = "memory/../../escape.md";
    let key = blob_key(PROJECT, evil);
    let data = seal_blob("team-1", &w.keys, &a.id, &key, 1, &pack(PROJECT, evil, Some(b"pwn"))).unwrap();
    w.relay.borrow_mut().blobs.insert(key, (1, a.id.member_id.clone(), data));
    let rep = w.sync(&mut b, 1).await;
    assert_eq!((rep.rejected, rep.applied.len()), (1, 0));
    assert!(!b.dir.path().join("escape.md").exists());
}

#[tokio::test]
async fn symlinks_and_big_files_are_skipped() {
    let (w, mut a, _) = two();
    a.write("memory/real.md", "ok");
    let outside = a.dir.path().join("secret.md");
    std::fs::write(&outside, "secret").unwrap();
    std::os::unix::fs::symlink(&outside, a.roots().memory_dir.join("link.md")).unwrap();
    a.write("memory/big.md", &"x".repeat(MAX_FILE + 1));
    a.write("memory/note.txt", "no");
    let rep = w.sync(&mut a, 1).await;
    assert_eq!(rep.pushed, 1);
    assert_eq!(rep.skipped, 2);
}

#[tokio::test]
async fn the_file_cap_holds() {
    let (w, mut a, _) = two();
    a.write("CLAUDE.md", "c");
    for i in 0..MAX_FILES + 5 {
        a.write(&format!("memory/f{i}.md"), "x");
    }
    let rep = w.sync(&mut a, 1).await;
    assert_eq!(rep.pushed as usize, MAX_FILES);
}

#[tokio::test]
async fn authorship_is_verified() {
    let (a, b, outsider) = (Identity::fresh(), Identity::fresh(), Identity::fresh());
    let w = World::new(&[(&a, "Ana"), (&b, "Bob")]);
    let mut b = Member::new(b);
    let key = blob_key(PROJECT, "memory/x.md");
    let pt = pack(PROJECT, "memory/x.md", Some(b"hello"));
    // signed by somebody who is not on the roster
    let data = seal_blob("team-1", &w.keys, &outsider, &key, 1, &pt).unwrap();
    w.relay.borrow_mut().blobs.insert(key.clone(), (1, outsider.member_id.clone(), data));
    assert_eq!(w.sync(&mut b, 1).await.rejected, 0, "not on the roster yet: retried, no verdict");
    // the ciphertext was tampered with
    let mut data = seal_blob("team-1", &w.keys, &a, &key, 2, &pt).unwrap();
    let last = data.len() - 1;
    data[last] ^= 1;
    w.relay.borrow_mut().blobs.insert(key.clone(), (2, a.member_id.clone(), data));
    assert_eq!(w.sync(&mut b, 2).await.rejected, 1);
    // a valid blob of Ana's, but another member put it (the relay's author differs)
    let data = seal_blob("team-1", &w.keys, &a, &key, 3, &pt).unwrap();
    w.relay.borrow_mut().blobs.insert(key.clone(), (3, b.id.member_id.clone(), data.clone()));
    assert_eq!(w.sync(&mut b, 3).await.rejected, 1);
    // an old blob replayed under a newer version number
    w.relay.borrow_mut().blobs.insert(key.clone(), (4, a.member_id.clone(), data));
    assert_eq!(w.sync(&mut b, 4).await.rejected, 1);
    // the real thing
    let data = seal_blob("team-1", &w.keys, &a, &key, 5, &pt).unwrap();
    w.relay.borrow_mut().blobs.insert(key, (5, a.member_id.clone(), data));
    let rep = w.sync(&mut b, 5).await;
    assert_eq!((rep.rejected, rep.applied.len()), (0, 1));
    assert_eq!(b.read("memory/x.md").as_deref(), Some("hello"));
}

#[test]
fn project_dirs_are_encoded_like_claude_code() {
    assert_eq!(encode_project_dir(Path::new("/Users/alice/Documents/Projects/App.v2")), "-Users-alice-Documents-Projects-App-v2");
}

#[tokio::test]
async fn a_member_or_key_that_is_not_known_yet_is_retried_not_skipped() {
    let (a, b, late) = (Identity::fresh(), Identity::fresh(), Identity::fresh());
    let mut w = World::new(&[(&a, "Ana"), (&b, "Bob")]);
    let mut b = Member::new(b);
    let key = blob_key(PROJECT, "memory/x.md");
    let data = seal_blob("team-1", &w.keys, &late, &key, 1, &pack(PROJECT, "memory/x.md", Some(b"hi"))).unwrap();
    w.relay.borrow_mut().blobs.insert(key, (1, late.member_id.clone(), data));
    let rep = w.sync(&mut b, 1).await;
    assert_eq!((rep.rejected, rep.applied.len(), b.st.skipped.len()), (0, 0, 0));
    // the roster learns the member: the same version is applied now
    w.roster.members.push(member_entry(&late, "Late", Role::Member));
    w.roster.version = 2;
    assert_eq!(w.sync(&mut b, 2).await.applied.len(), 1);
    assert_eq!(b.read("memory/x.md").as_deref(), Some("hi"));
}

#[tokio::test]
async fn a_roster_change_clears_old_skip_verdicts() {
    let (mut w, a, mut b) = two();
    let key = blob_key(PROJECT, "memory/x.md");
    let mut data = seal_blob("team-1", &w.keys, &a.id, &key, 1, &pack(PROJECT, "memory/x.md", Some(b"v"))).unwrap();
    let last = data.len() - 1;
    data[last] ^= 1;
    w.relay.borrow_mut().blobs.insert(key.clone(), (1, a.id.member_id.clone(), data));
    assert_eq!(w.sync(&mut b, 1).await.rejected, 1);
    assert_eq!(b.st.skipped.len(), 1);
    w.roster.version = 2;
    // looked at again (and rejected again) instead of being skipped forever
    assert_eq!(w.sync(&mut b, 2).await.rejected, 1);
}

#[tokio::test]
async fn claude_md_is_a_separate_opt_in_and_never_written_on_its_own() {
    let (w, mut a, mut b) = two();
    a.write("CLAUDE.md", "rules v1");
    a.write("memory/x.md", "m");
    // off on both: nothing about CLAUDE.md moves
    a.claude_md = false;
    b.claude_md = false;
    assert_eq!(w.sync(&mut a, 1).await.pushed, 1);
    let rep = w.sync(&mut b, 2).await;
    assert!(rep.pending_new.is_empty() && b.read("CLAUDE.md").is_none());
    // Ana opts in and shares it; Bob opts in: it is held, not written
    a.claude_md = true;
    assert_eq!(w.sync(&mut a, 3).await.pushed, 1);
    b.claude_md = true;
    let rep = w.sync(&mut b, 4).await;
    assert_eq!((rep.pending_new.len(), rep.applied.len()), (1, 0));
    assert_eq!(b.read("CLAUDE.md"), None);
    // a later round neither rewrites nor re-reports it
    let rep = w.sync(&mut b, 5).await;
    assert!(rep.pending_new.is_empty());
    let (cur, inc) = pending_texts(&b.roots(), &b.st, "CLAUDE.md").unwrap();
    assert_eq!((cur.as_str(), inc.as_str()), ("", "rules v1"));
    // apply writes it and it does not bounce back
    let cx = Ctx { team_id: "team-1", keys: &w.keys, me: &b.id, roster: &w.roster };
    apply_pending(&cx, &b.roots(), &mut b.st, "CLAUDE.md", 6).unwrap();
    assert_eq!(b.read("CLAUDE.md").as_deref(), Some("rules v1"));
    assert_eq!(w.sync(&mut b, 7).await.pushed, 0);
    // a newer version, ignored: Bob keeps his file and does not push it over Ana's
    a.write("CLAUDE.md", "rules v2");
    w.sync(&mut a, 8).await;
    assert_eq!(w.sync(&mut b, 9).await.pending_new.len(), 1);
    ignore_pending(&b.roots(), &mut b.st, "CLAUDE.md").unwrap();
    assert_eq!(b.read("CLAUDE.md").as_deref(), Some("rules v1"));
    assert_eq!(w.sync(&mut b, 10).await.pushed, 0);
    assert!(b.st.pending.is_empty());
}

#[tokio::test]
async fn use_mine_refuses_when_the_file_changed_after_the_conflict() {
    let (w, mut a, mut b) = two();
    a.write("memory/x.md", "base");
    w.sync(&mut a, 1).await;
    w.sync(&mut b, 2).await;
    a.write("memory/x.md", "A");
    b.write("memory/x.md", "B");
    w.sync(&mut a, 3).await;
    w.sync(&mut b, 4).await;
    // somebody (or an agent) wrote the file again before the person decided
    b.write("memory/x.md", "newer work");
    assert!(resolve(&b.roots(), &mut b.st, "memory/x.md", true).is_err());
    assert_eq!(b.read("memory/x.md").as_deref(), Some("newer work"));
    assert_eq!(b.st.conflicts.len(), 1, "the copy and the entry are kept");
    assert!(b.roots().memory_dir.join(&b.st.conflicts[0].file).exists());
}

#[tokio::test]
async fn two_spellings_that_differ_only_by_case_do_not_both_sync() {
    let (w, mut a, mut b) = two();
    a.write("memory/Notes.md", "one");
    w.sync(&mut a, 1).await;
    w.sync(&mut b, 2).await;
    assert_eq!(b.read("memory/Notes.md").as_deref(), Some("one"));
    // same blob key, another spelling arriving as a newer version
    let key = blob_key(PROJECT, "memory/notes.md");
    assert_eq!(key, blob_key(PROJECT, "memory/Notes.md"));
    let data = seal_blob("team-1", &w.keys, &a.id, &key, 2, &pack(PROJECT, "memory/notes.md", Some(b"two"))).unwrap();
    w.relay.borrow_mut().blobs.insert(key, (2, a.id.member_id.clone(), data));
    let rep = w.sync(&mut b, 3).await;
    assert_eq!((rep.rejected, rep.applied.len()), (1, 0));
    assert_eq!(b.read("memory/Notes.md").as_deref(), Some("one"));
    // a local pair on a case-sensitive disk: only one is pushed
    let mut c = Member::new(Identity::fresh());
    c.write("memory/Same.md", "1");
    if std::fs::symlink_metadata(c.roots().memory_dir.join("same.md")).is_err() {
        c.write("memory/same.md", "2");
    }
    let n = std::fs::read_dir(c.roots().memory_dir).unwrap().count();
    let w2 = World::new(&[(&c.id, "Cy")]);
    assert_eq!(w2.sync(&mut c, 1).await.pushed, 1, "{n} file(s) on disk");
}
