//! Policy probe for the "ask more, block less" design: runs a corpus of developer tool calls through `decide` in all five modes, with the
//! production context (strict jail except Bypass, a state dir, a scratch dir, cards possible), and writes one TSV line per call:
//! `category, plan, ask, edit, automatic, bypass, call` where each verdict is `A|Q|D|C:<rule>` (C = refusal with a card).
//! Run: `INTELY_CORPUS_OUT=out.tsv cargo test -p intely-agent-core --test zz_corpus_probe -- --ignored` (INTELY_CORPUS overrides the corpus).
mod common;
use common::*;
use intely_agent_core::policy::decide::PolicyContext;
use intely_agent_core::providers::PermissionMode;

#[test]
#[ignore]
fn corpus_probe() {
    let path = std::env::var("INTELY_CORPUS").unwrap_or_else(|_| {
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ask_corpus.txt").to_string()
    });
    let Ok(out_path) = std::env::var("INTELY_CORPUS_OUT") else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let home = root.join("home");
    let cwd = home.join("code/app");
    let other = home.join("code/other");
    let scratch = root.join("tmp");
    for d in [
        ".git/hooks",
        "src/components",
        "scripts",
        "test",
        "node_modules/.bin",
        "dist",
        "ios",
        "android",
        "public",
        "docs",
    ] {
        std::fs::create_dir_all(cwd.join(d)).unwrap();
    }
    for d in [
        ".ssh",
        ".aws",
        "Library/Application Support/intely",
        "Downloads",
        ".config",
    ] {
        std::fs::create_dir_all(home.join(d)).unwrap();
    }
    std::fs::create_dir_all(other.join("src")).unwrap();
    std::fs::create_dir_all(&scratch).unwrap();
    let w = |rel: &str, text: &str| std::fs::write(cwd.join(rel), text).unwrap();
    w(
        "package.json",
        r#"{"scripts":{"test":"vitest run","build":"vite build","dev":"vite","lint":"eslint .","start":"node server.js","typecheck":"tsc --noEmit","deploy":"node scripts/deploy.js","release":"npm run build && git push --follow-tags","postinstall":"node scripts/gen.mjs"}}"#,
    );
    w(
        "server.js",
        "const http = require('http');\nhttp.createServer(()=>{}).listen(3000);\n",
    );
    w("scripts/build.sh", "#!/bin/sh\nset -e\n# after this, run git push yourself\nnpm run build\ncp .env.example dist/.env\n");
    w(
        "scripts/deploy.js",
        "const { execSync } = require('child_process');\nexecSync('git push origin main');\n",
    );
    w(
        "scripts/seed.py",
        "import json\nprint(json.dumps({'a':1}))\n",
    );
    w(
        "scripts/fetch.py",
        "import urllib.request\nprint(urllib.request.urlopen('https://example.com').read()[:10])\n",
    );
    w(
        "scripts/gen.mjs",
        "import fs from 'fs';\nfs.writeFileSync('src/gen.ts', 'export {}');\n",
    );
    w(
        "Makefile",
        "build:\n\tcargo build\ntest:\n\tcargo test\nrelease:\n\tgit tag v1 && git push --tags\n",
    );
    w("Cargo.toml", "[package]\nname='x'\n");
    w("src/index.ts", "export {};\n");
    w("src/app.py", "print(1)\n");
    w("README.md", "# x\n");
    w(".env", "A=1\n");
    w(".env.example", "A=\n");
    w("tsconfig.json", "{}\n");
    w("docker-compose.yml", "services: {}\n");
    w("Dockerfile", "FROM node\n");
    w("test/a.test.ts", "test('x',()=>{});\n");
    std::fs::write(home.join(".ssh/id_ed25519"), "k").unwrap();
    std::fs::write(home.join(".zshrc"), "x").unwrap();
    std::fs::write(home.join("Downloads/data.csv"), "a,b").unwrap();
    std::fs::write(other.join("src/lib.ts"), "x").unwrap();
    let state = home.join("Library/Application Support/intely");
    let sub = |s: &str| {
        s.replace("{home}", &home.display().to_string())
            .replace("{cwd}", &cwd.display().to_string())
            .replace("{other}", &other.display().to_string())
            .replace("{tmp}", &scratch.display().to_string())
    };
    let mk = |mode| {
        let mut c = PolicyContext::new(mode, &cwd);
        c.home = Some(home.clone());
        c.state_dir = Some(state.clone());
        c.scratch_dirs = vec![scratch.clone()];
        c.stops_askable = true;
        c.strict_jail = mode != PermissionMode::Bypass;
        c
    };
    let modes = [
        ("plan", PermissionMode::ReadOnly),
        ("ask", PermissionMode::Ask),
        ("edit", PermissionMode::Edit),
        ("auto", PermissionMode::Automatic),
        ("bypass", PermissionMode::Bypass),
    ];
    let ctxs: Vec<_> = modes.iter().map(|(n, m)| (*n, mk(*m))).collect();
    let text = std::fs::read_to_string(&path).unwrap();
    let mut out = String::new();
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // `cat|cmd` prefix = category
        let (cat, cmd) = line.split_once('|').unwrap();
        let cmd = sub(cmd).replace("\\n", "\n");
        out.push_str(cat);
        for (_, c) in &ctxs {
            let d = if let Some(rest) = cmd.strip_prefix("@") {
                // @Tool json
                let (tool, json) = rest.split_once(' ').unwrap();
                decide_tool(c, tool, serde_json::from_str(json).unwrap())
            } else {
                bash(c, &cmd)
            };
            let tag = match d.decision {
                intely_agent_core::policy::decide::Decision::Allow => "A",
                intely_agent_core::policy::decide::Decision::Ask => "Q",
                intely_agent_core::policy::decide::Decision::Deny => {
                    if d.confirm.is_some() {
                        "C"
                    } else {
                        "D"
                    }
                }
            };
            out.push_str(&format!("\t{tag}:{}", d.rule.unwrap_or_default()));
        }
        out.push_str(&format!(
            "\t{}\n",
            line.split_once('|').unwrap().1.replace('\t', " ")
        ));
    }
    std::fs::write(out_path, out).unwrap();
}
