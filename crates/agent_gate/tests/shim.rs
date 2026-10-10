//! The allow-list git shim, driven the way an agent uses it: command strings through `sh -c` with the shim first
//! on PATH, inside a fixture repo that has a bare remote. Every row also proves nothing changed that should not
//! have: HEAD, all refs, the remote.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output};

use common::{real_git, Repo};
use intely_agent_gate::shim::{self, Shim, REFUSED_EXIT};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Expect {
    /// Reaches real git and succeeds.
    Allow,
    /// Refused by the shim (exit 126, message, refusal-log line).
    Refuse,
}
use Expect::{Allow, Refuse};

struct Fixture {
    repo: Repo,
    shim: Shim,
    remote: std::path::PathBuf,
    head: String,
    refs: String,
}

impl Fixture {
    fn new() -> Self {
        let repo = Repo::new();
        repo.write("a.txt", "hello world\n");
        repo.write("sub/dir/f.txt", "nested hello\n");
        repo.commit_all("init");
        repo.git(&["branch", "other"]);
        let remote = repo.root().join("remote.git");
        let out = Command::new(real_git()).args(["init", "-q", "--bare", "-b", "main"]).arg(&remote).output().unwrap();
        assert!(out.status.success());
        repo.git(&["remote", "add", "origin", remote.to_str().unwrap()]);
        repo.write("new.txt", "untracked\n");
        repo.write("other.txt", "untracked too\n");
        repo.write("star*", "a file whose name is a glob\n");
        repo.write("list.txt", "a.txt\n");
        std::fs::create_dir_all(repo.path.join("emptydir")).unwrap();
        std::os::unix::fs::symlink("a.txt", repo.path.join("link")).unwrap();
        let shim = shim::generate(&repo.root().join("private-shim"), &real_git()).unwrap();
        let head = repo.git(&["rev-parse", "HEAD"]);
        let refs = repo.git(&["for-each-ref"]);
        Self { repo, shim, remote, head, refs }
    }

    /// `cmd` as typed by an agent: PATH starts with the shim, `{repo}` expands to the fixture path.
    fn run(&self, cmd: &str) -> Output {
        self.run_in(&self.repo.path, cmd)
    }

    fn run_in(&self, cwd: &Path, cmd: &str) -> Output {
        let cmd = cmd.replace("{repo}", self.repo.path.to_str().unwrap()).replace("{real_git}", real_git().to_str().unwrap());
        Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .current_dir(cwd)
            .env("PATH", self.shim.path_value(std::env::var_os("PATH").as_deref()))
            .stdin(std::process::Stdio::null())
            .output()
            .expect("run sh")
    }

    fn remote_refs(&self) -> String {
        let out = Command::new(real_git()).arg("-C").arg(&self.remote).args(["for-each-ref"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// Back to the starting index so rows are independent.
    fn reset_index(&self) {
        self.repo.git(&["reset", "-q"]);
    }

    fn assert_untouched(&self, cmd: &str) {
        assert_eq!(self.repo.git(&["rev-parse", "HEAD"]), self.head, "HEAD moved by {cmd:?}");
        assert_eq!(self.repo.git(&["for-each-ref"]), self.refs, "refs changed by {cmd:?}");
        assert_eq!(self.remote_refs(), "", "remote changed by {cmd:?}");
        assert!(self.repo.exists("new.txt") && self.repo.exists("sub") && self.repo.exists("star*"), "files lost by {cmd:?}");
        assert_eq!(self.repo.read("a.txt"), "hello world\n", "tracked file changed by {cmd:?}");
    }
}

/// The table. Allowed rows must exit 0; refused rows must exit 126 with a message and one more log line.
const TABLE: &[(&str, Expect)] = &[
    // read-only verbs
    ("git status", Allow),
    ("git status --short --branch", Allow),
    ("git -C {repo} status -sb", Allow),
    ("git diff", Allow),
    ("git diff --stat HEAD", Allow),
    ("git diff --cached", Allow),
    ("git log --oneline", Allow),
    ("git log -n 1 --format=%H", Allow),
    ("git show HEAD", Allow),
    ("git show HEAD:a.txt", Allow),
    ("git blame a.txt", Allow),
    ("git branch", Allow),
    ("git branch --list", Allow),
    ("git branch -a", Allow),
    ("git branch -vv", Allow),
    ("git branch --show-current", Allow),
    ("git branch --list 'ma*'", Allow),
    ("git branch --contains HEAD", Allow),
    ("git rev-parse HEAD", Allow),
    ("git rev-parse --show-toplevel", Allow),
    ("git ls-files", Allow),
    ("git ls-tree -r HEAD", Allow),
    ("git grep -n hello", Allow),
    ("git cat-file -p HEAD", Allow),
    ("git config --get user.name", Allow),
    ("git config --local --list", Allow),
    ("git describe --always", Allow),
    ("git shortlog -sn HEAD", Allow),
    ("git rev-list --count HEAD", Allow),
    ("git remote -v", Allow),
    ("git remote", Allow),
    ("git remote get-url origin", Allow),
    ("git stash list", Allow),
    ("git --no-pager log -1", Allow),
    ("git -C {repo} -C sub rev-parse --show-prefix", Allow),
    // git add for explicit existing regular files only
    ("git add a.txt", Allow),
    ("git add -- sub/dir/f.txt", Allow),
    ("git -C {repo}/sub add dir/f.txt", Allow),
    ("git add new.txt other.txt", Allow),
    ("git add a.txt && git status --short", Allow),
    ("git status && git log -1 --oneline", Allow),
    ("git add -A", Refuse),
    ("git add --all", Refuse),
    ("git add .", Refuse),
    ("git add ..", Refuse),
    ("git add -u", Refuse),
    ("git add --update", Refuse),
    ("git add -p", Refuse),
    ("git add -f a.txt", Refuse),
    ("git add -N new.txt", Refuse),
    ("git add --pathspec-from-file=list.txt", Refuse),
    ("git add --pathspec-from-file list.txt", Refuse),
    ("git add '*.txt'", Refuse),
    ("git add 'star*'", Refuse),
    ("git add 'a.tx?'", Refuse),
    ("git add 'a.[tx]xt'", Refuse),
    ("git add ':/'", Refuse),
    ("git add ':(glob)**/*.txt'", Refuse),
    ("git add ':!a.txt'", Refuse),
    ("git add sub", Refuse),
    ("git add sub/", Refuse),
    ("git add emptydir", Refuse),
    ("git add link", Refuse),
    ("git add missing.txt", Refuse),
    ("git add", Refuse),
    ("git add --", Refuse),
    ("git add a.txt sub", Refuse),
    ("git add ''", Refuse),
    // writes the agent must never make
    ("git commit -m x", Refuse),
    ("git commit -am x", Refuse),
    ("git commit --amend --no-edit", Refuse),
    ("git push", Refuse),
    ("git push origin HEAD", Refuse),
    ("git push --force origin main", Refuse),
    ("git push --tags", Refuse),
    ("git -C {repo} push origin main", Refuse),
    ("git cherry-pick other", Refuse),
    ("git merge other", Refuse),
    ("git rebase main", Refuse),
    ("git tag v1", Refuse),
    ("git tag -a v1 -m x", Refuse),
    ("git notes add -m x", Refuse),
    ("git update-ref refs/heads/evil HEAD", Refuse),
    ("git symbolic-ref HEAD refs/heads/other", Refuse),
    ("git reset --hard", Refuse),
    ("git reset --hard HEAD~1", Refuse),
    ("git reset --soft HEAD", Refuse),
    ("git checkout -- a.txt", Refuse),
    ("git checkout other", Refuse),
    ("git checkout -b feature", Refuse),
    ("git switch other", Refuse),
    ("git restore a.txt", Refuse),
    ("git restore --staged a.txt", Refuse),
    ("git clean -fd", Refuse),
    ("git rm a.txt", Refuse),
    ("git mv a.txt b.txt", Refuse),
    ("git fetch", Refuse),
    ("git pull", Refuse),
    ("git clone . /tmp/intely-clone-x", Refuse),
    ("git init /tmp/intely-init-x", Refuse),
    ("git stash", Refuse),
    ("git stash pop", Refuse),
    ("git stash drop", Refuse),
    ("git stash push -m x", Refuse),
    ("git revert HEAD", Refuse),
    ("git apply x.patch", Refuse),
    ("git am x.mbox", Refuse),
    ("git gc", Refuse),
    ("git filter-branch --tree-filter true", Refuse),
    ("git submodule update --init", Refuse),
    ("git worktree add ../wt", Refuse),
    ("git bisect start", Refuse),
    ("git credential fill", Refuse),
    ("git archive HEAD", Refuse),
    ("git bundle create x.bundle HEAD", Refuse),
    ("git ci -m x", Refuse),
    ("git help", Refuse),
    ("git", Refuse),
    // branch, config and remote variants that write
    ("git branch newbranch", Refuse),
    ("git branch newbranch HEAD", Refuse),
    ("git branch -D other", Refuse),
    ("git branch -d other", Refuse),
    ("git branch -m other renamed", Refuse),
    ("git branch -c other copy", Refuse),
    ("git branch -f other HEAD", Refuse),
    ("git branch --set-upstream-to=origin/main", Refuse),
    ("git branch -u origin/main", Refuse),
    ("git config user.name evil", Refuse),
    ("git config --global user.name evil", Refuse),
    ("git config --unset user.name", Refuse),
    ("git config --add alias.x '!sh'", Refuse),
    ("git config --edit", Refuse),
    ("git config --replace-all user.name x", Refuse),
    ("git config", Refuse),
    ("git remote add evil http://example.invalid/x.git", Refuse),
    ("git remote set-url origin http://example.invalid/x.git", Refuse),
    ("git remote remove origin", Refuse),
    ("git remote show origin", Refuse),
    ("git remote -v add evil http://example.invalid/x.git", Refuse),
    ("git remote get-url --evil origin", Refuse),
    // global options that change config, directories or programs
    ("git -c core.sshCommand=x status", Refuse),
    ("git -c alias.st='!sh' status", Refuse),
    ("git --git-dir=/tmp/x status", Refuse),
    ("git --work-tree=/tmp status", Refuse),
    ("git --exec-path=/tmp status", Refuse),
    ("git --paginate log", Refuse),
    ("git -p log", Refuse),
    ("git --version log", Refuse),
    // options of read verbs that write files or run programs, also abbreviated
    ("git diff --output=out.txt", Refuse),
    ("git diff --output out.txt", Refuse),
    ("git diff --outp=out.txt", Refuse),
    ("git log --output=out.txt", Refuse),
    ("git show --output=out.txt HEAD", Refuse),
    ("git diff --ext-diff", Refuse),
    ("git diff --ext-d", Refuse),
    ("git grep -Ovim hello", Refuse),
    ("git grep -O hello", Refuse),
    ("git grep -inOless hello", Refuse),
    ("git grep --open-files-in-pager=sh hello", Refuse),
    ("git grep --open-files hello", Refuse),
    ("git stash list --output=out.txt", Refuse),
    // compound strings: the allowed half runs, the refused half is stopped
    ("git status; git push", Refuse),
    ("git log -1 && git commit --allow-empty -m x", Refuse),
    ("git -C {repo} commit --allow-empty -m x", Refuse),
    ("sh -c 'git push origin main'", Refuse),
    ("env git commit --allow-empty -m x", Refuse),
    ("cd sub && git commit --allow-empty -m x", Refuse),
];

#[test]
fn the_command_table_is_allowed_or_refused_as_documented() {
    let fx = Fixture::new();
    assert!(TABLE.len() >= 40, "the table must hold at least 40 command strings");
    for (cmd, expect) in TABLE {
        fx.reset_index();
        let log_before = fx.shim.refusals().len();
        let out = fx.run(cmd);
        let (stdout, stderr) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let code = out.status.code();
        match expect {
            Allow => {
                assert_eq!(code, Some(0), "{cmd:?} should pass the shim\nstdout: {stdout}\nstderr: {stderr}");
                assert_eq!(fx.shim.refusals().len(), log_before, "{cmd:?} must not be logged as a refusal");
            }
            Refuse => {
                assert_eq!(code, Some(REFUSED_EXIT), "{cmd:?} should be refused\nstdout: {stdout}\nstderr: {stderr}");
                assert!(stderr.contains("intely git shim: refused"), "{cmd:?}: {stderr}");
                assert!(stderr.contains("Agents may read the repository"), "{cmd:?} must explain what is allowed: {stderr}");
                assert_eq!(fx.shim.refusals().len(), log_before + 1, "{cmd:?} must add exactly one refusal-log line");
            }
        }
        fx.assert_untouched(cmd);
    }
    // the log records working directory and arguments
    let log = fx.shim.refusals();
    assert!(log.iter().any(|l| l.contains("push origin HEAD") && l.contains("repo")), "{log:?}");
    assert!(log.iter().all(|l| l.split('\t').count() == 3), "{log:?}");
}

#[test]
fn a_staged_file_really_is_staged_by_the_shim() {
    let fx = Fixture::new();
    fx.repo.write("a.txt", "changed\n");
    let out = fx.run("git add a.txt new.txt");
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    let staged = fx.repo.git(&["diff", "--cached", "--name-only"]);
    assert_eq!(staged.lines().collect::<Vec<_>>(), ["a.txt", "new.txt"]);
    assert_eq!(fx.repo.git(&["rev-parse", "HEAD"]), fx.head, "staging is not committing");
}

#[test]
fn a_glob_named_file_is_added_literally_only_when_named_without_glob_characters() {
    let fx = Fixture::new();
    // `star*` exists, but naming it needs the glob character, so the shim refuses and stages nothing
    assert_eq!(fx.run("git add 'star*'").status.code(), Some(REFUSED_EXIT));
    assert_eq!(fx.run("git add star*").status.code(), Some(REFUSED_EXIT), "the shell expands it to the same name");
    assert!(fx.repo.git(&["diff", "--cached", "--name-only"]).is_empty());
}

#[test]
fn exit_codes_and_output_of_real_git_pass_through() {
    let fx = Fixture::new();
    let out = fx.run("git rev-parse --verify nonexistent");
    assert_eq!(out.status.code(), Some(128));
    assert_eq!(fx.run("git log -1 --format=%s").stdout, b"init\n");
    assert_eq!(String::from_utf8_lossy(&fx.run("git --version").stdout).split(' ').next(), Some("git"));
    let missing = fx.run("git -C /definitely/not/here status");
    assert_eq!(missing.status.code(), Some(128), "a bad -C directory fails like git, it is not a refusal");
    assert!(String::from_utf8_lossy(&missing.stderr).contains("cannot change to"));
    assert!(fx.shim.refusals().is_empty());
}

#[test]
fn works_from_other_directories_and_with_dash_c() {
    let fx = Fixture::new();
    let elsewhere = fx.repo.root().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let out = fx.run_in(&elsewhere, "git -C {repo} log -1 --format=%s");
    assert_eq!(out.stdout, b"init\n");
    // staging is confined to the directory the agent started in: -C into another tree is refused (SEC-13)
    let out = fx.run_in(&elsewhere, "git -C {repo} add new.txt");
    assert_eq!(out.status.code(), Some(REFUSED_EXIT), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(fx.repo.git(&["diff", "--cached", "--name-only"]).is_empty());
    // a path that exists only relative to the current directory is judged after -C
    let out = fx.run_in(&elsewhere, "git -C {repo} add nothing-here.txt");
    assert_eq!(out.status.code(), Some(REFUSED_EXIT));
}

#[test]
fn staging_stays_inside_the_start_directory_and_never_takes_secret_files() {
    let fx = Fixture::new();
    fx.repo.write(".env", "TOKEN=x\n");
    fx.repo.write(".env.example", "TOKEN=\n");
    fx.repo.write("sub/server.pem", "k\n");
    fx.repo.write("sub/dir/f.txt", "changed\n");
    // inside the start directory, a subdirectory is fine
    let out = fx.run_in(&fx.repo.path.join("sub"), "git -C {repo}/sub add dir/f.txt");
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    for cmd in ["git add .env", "git add sub/server.pem", "git add -- .env"] {
        assert_eq!(fx.run(cmd).status.code(), Some(REFUSED_EXIT), "{cmd}");
    }
    assert_eq!(fx.run("git add .env.example").status.code(), Some(0), "templates are not secrets");
    assert_eq!(fx.run("git diff --no-index /dev/null /etc/hosts").status.code(), Some(REFUSED_EXIT), "reads outside the tree");
    assert_eq!(fx.repo.git(&["diff", "--cached", "--name-only"]).lines().collect::<Vec<_>>(), [".env.example", "sub/dir/f.txt"]);
}

#[test]
fn config_injection_through_the_environment_is_dropped() {
    let fx = Fixture::new();
    let marker = fx.repo.root().join("pwned");
    let inject = format!(
        "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0='touch {}' ",
        marker.display()
    );
    let via_shim = fx.run(&format!("{inject}git status"));
    assert_eq!(via_shim.status.code(), Some(0), "{}", String::from_utf8_lossy(&via_shim.stderr));
    assert!(!marker.exists(), "the shim unsets GIT_CONFIG_COUNT, so the injected fsmonitor command never ran");
    // control: the same environment against the real binary does run the injected command
    fx.run(&format!("{inject}{{real_git}} status"));
    assert!(marker.exists(), "control: without the shim the injection works (this is why the shim scrubs it)");
}

#[test]
fn an_absolute_path_call_bypasses_the_shim() {
    // Documented limitation (providers-plan 3.1): the shim is a speed bump for accidental `git` calls. A call
    // by absolute path never sees it; the PreToolUse hook (policy.rs, suite S2) is what must catch that.
    let fx = Fixture::new();
    let refused = fx.run("git commit --allow-empty -m via-shim");
    assert_eq!(refused.status.code(), Some(REFUSED_EXIT));
    assert_eq!(fx.repo.git(&["rev-parse", "HEAD"]), fx.head);
    let log_before = fx.shim.refusals().len();

    let bypass = fx.run("{real_git} commit --allow-empty -m via-absolute-path");
    assert_eq!(bypass.status.code(), Some(0), "{}", String::from_utf8_lossy(&bypass.stderr));
    assert_ne!(fx.repo.git(&["rev-parse", "HEAD"]), fx.head, "the absolute-path commit went through");
    assert_eq!(fx.shim.refusals().len(), log_before, "and the shim never saw it");
}

#[test]
fn generate_checks_its_inputs_and_writes_a_private_executable() {
    let dir = tempfile::tempdir().unwrap();
    let private = dir.path().join("shim");
    let shim = shim::generate(&private, &real_git()).unwrap();
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&shim.dir), 0o700);
    assert_eq!(mode(&shim.script), 0o755);
    assert_eq!(mode(&shim.refusal_log), 0o600);
    let script = std::fs::read_to_string(&shim.script).unwrap();
    assert!(script.starts_with("#!/bin/sh\n"));
    assert!(script.contains(&format!("REAL_GIT='{}'", real_git().display())), "the real git is resolved by absolute path");

    assert!(shim::generate(&dir.path().join("x"), Path::new("git")).is_err(), "relative real git");
    assert!(shim::generate(&dir.path().join("x"), &dir.path().join("missing")).is_err());
    // a real git that lives inside the shim directory would make the shim call itself
    assert!(shim::generate(&private, &shim.script).is_err());

    // regenerating replaces the script in place and keeps the log
    std::fs::write(&shim.refusal_log, "keep\n").unwrap();
    let again = shim::generate(&private, &real_git()).unwrap();
    assert_eq!(again.refusals(), ["keep"]);

    let path = shim.path_value(Some(std::ffi::OsStr::new("/usr/bin:/bin")));
    assert!(path.to_string_lossy().ends_with(":/usr/bin:/bin") && path.to_string_lossy().starts_with(shim.dir.to_str().unwrap()));
    assert_eq!(shim.path_value(None), shim.dir.as_os_str());
}

#[test]
fn a_path_with_a_quote_in_the_real_git_location_is_quoted_safely() {
    let dir = tempfile::tempdir().unwrap();
    let odd = dir.path().join("it's here");
    std::fs::create_dir_all(&odd).unwrap();
    let fake = odd.join("git");
    std::fs::write(&fake, "#!/bin/sh\necho fake-git \"$@\"\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let shim = shim::generate(&dir.path().join("shim"), &fake).unwrap();
    let out = Command::new(&shim.script).args(["log", "-1"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "fake-git --no-pager log -1");
}

#[test]
fn the_read_only_variant_refuses_git_add_too_and_still_reads() {
    let fx = Fixture::new();
    let ro = shim::generate_read_only(&fx.repo.root().join("private-shim-ro"), &real_git()).unwrap();
    let run = |cmd: &str| {
        Command::new("sh").arg("-c").arg(cmd).current_dir(&fx.repo.path).env("PATH", ro.path_value(std::env::var_os("PATH").as_deref())).output().unwrap()
    };
    let add = run("git add a.txt");
    assert_eq!(add.status.code(), Some(REFUSED_EXIT), "{}", String::from_utf8_lossy(&add.stderr));
    assert!(String::from_utf8_lossy(&add.stderr).contains("read-only"));
    assert_eq!(fx.repo.git(&["diff", "--cached", "--name-only"]), "", "nothing was staged");
    assert_eq!(run("git status --short").status.code(), Some(0));
    assert_eq!(run("git commit --allow-empty -m x").status.code(), Some(REFUSED_EXIT));
    assert_eq!(fx.repo.git(&["rev-parse", "HEAD"]), fx.head);
}

// A shim for a git on another machine: the script is rendered for the paths there and runs under whatever `sh` that machine has.
#[test]
fn a_remote_shim_is_the_same_script_with_the_remote_paths() {
    let dir = tempfile::tempdir().unwrap();
    let dir = std::fs::canonicalize(dir.path()).unwrap();
    // a stand-in for the server's git: prints what it was called with, so an allowed call is visible
    let real = dir.join("realgit");
    std::fs::write(&real, "#!/bin/sh\necho \"REAL:$*\"\n").unwrap();
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();
    let log = dir.join("refusals.log");
    let script = shim::render_remote(real.to_str().unwrap(), log.to_str().unwrap(), true).unwrap();
    assert!(script.contains(&format!("REAL_GIT='{}'", real.display())) && script.contains("ALLOW_ADD=1"), "{script}");
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let git = bin.join("git");
    std::fs::write(&git, script).unwrap();
    std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
    let run = |cmd: &str| Command::new("/bin/sh").arg("-c").arg(cmd).env("PATH", format!("{}:/usr/bin:/bin", bin.display())).current_dir(&dir).output().unwrap();
    let ok = run("git status --short");
    assert!(ok.status.success() && String::from_utf8_lossy(&ok.stdout).contains("REAL:--no-pager status --short"), "{ok:?}");
    for cmd in ["git commit -m x", "git push origin main", "git add -A", "git -c core.pager=x log", "git grep -O'sh -c x' pat"] {
        let out = run(cmd);
        assert_eq!(out.status.code(), Some(REFUSED_EXIT as i32), "{cmd}: {out:?}");
    }
    assert!(std::fs::read_to_string(&log).unwrap().contains("git commit -m x"), "the refusal is logged where the script was told to log it");
    // a read-only shim also refuses git add of a real file
    let ro = shim::render_remote(real.to_str().unwrap(), log.to_str().unwrap(), false).unwrap();
    assert!(ro.contains("ALLOW_ADD=0"));
    // paths must be absolute and on one line
    assert!(shim::render_remote("git", "/x", true).is_err());
    assert!(shim::render_remote("/usr/bin/git\n--version", "/x", true).is_err());
    assert!(shim::render_remote("/usr/bin/git", "/tmp/a\0b", true).is_err());
    // quoting survives an apostrophe in a path
    assert!(shim::render_remote("/home/o'neil/git", "/home/o'neil/refusals.log", true).unwrap().contains("REAL_GIT='/home/o'\\''neil/git'"));
}
