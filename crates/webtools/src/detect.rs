//! What a repository holds, so that each tool shows up only where it is relevant: stylesheets, React, a Node backend, `.env`
//! files, a build output. Reads `package.json` files (bounded) and lists extensions; runs nothing.

use std::path::Path;

use serde::Serialize;

use crate::walk::walk;
use crate::{safefs, WebError};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detect {
    pub css: bool,
    pub scss: bool,
    pub react: bool,
    pub react_native: bool,
    /// `express`, `fastify`, `koa`, `hono`, `nestjs`, `nextjs` found in a `package.json`.
    pub backends: Vec<&'static str>,
    pub env: bool,
    pub bundle: bool,
    /// Folders (relative, "" for the root) that hold a `package.json`, with the lock file kind: `npm`, `pnpm`, `yarn`, `bun` or `none`.
    pub packages: Vec<PackageDir>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageDir {
    pub dir: String,
    pub manager: &'static str,
}

pub fn detect(root: &Path) -> Result<Detect, WebError> {
    let w = walk(root);
    let mut d = Detect::default();
    let has = |rel: &str| w.files.iter().any(|e| e.rel == rel);
    let mut jsx_files = 0;
    for e in &w.files {
        match e.ext.as_str() {
            "css" | "less" => d.css = true,
            "scss" | "sass" => {
                d.css = true;
                d.scss = true;
            }
            "jsx" | "tsx" => jsx_files += 1,
            _ => {}
        }
        let name = e.rel.rsplit('/').next().unwrap_or("");
        if name == ".env" || (name.starts_with(".env.") && name.len() > 5) {
            d.env = true;
        }
    }
    for e in w.files.iter().filter(|e| e.rel == "package.json" || (e.rel.ends_with("/package.json") && e.rel.matches('/').count() <= 3)) {
        let dir = e.rel.strip_suffix("package.json").unwrap_or("").trim_end_matches('/').to_string();
        let sibling = |n: &str| has(&if dir.is_empty() { n.to_string() } else { format!("{dir}/{n}") });
        let manager = if sibling("pnpm-lock.yaml") {
            "pnpm"
        } else if sibling("yarn.lock") {
            "yarn"
        } else if sibling("bun.lockb") || sibling("bun.lock") {
            "bun"
        } else if sibling("package-lock.json") || sibling("npm-shrinkwrap.json") {
            "npm"
        } else {
            "none"
        };
        d.packages.push(PackageDir { dir, manager });
        let Ok(text) = safefs::read(root, &e.rel, 1024 * 1024) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let dep = |n: &str| ["dependencies", "devDependencies", "peerDependencies"].iter().any(|k| v.get(k).and_then(|x| x.get(n)).is_some());
        d.react |= dep("react") || dep("react-dom") || dep("next");
        d.react_native |= dep("react-native") || dep("expo");
        for (pkg, name) in [("express", "express"), ("fastify", "fastify"), ("koa", "koa"), ("@koa/router", "koa"), ("hono", "hono"), ("@nestjs/core", "nestjs"), ("next", "nextjs")] {
            if dep(pkg) && !d.backends.contains(&name) {
                d.backends.push(name);
            }
        }
    }
    d.react |= jsx_files > 0;
    d.bundle = crate::bundle_report(root).map(|r| !r.dirs.is_empty()).unwrap_or(false);
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_what_is_there_and_nothing_else() {
        let d = tempfile::tempdir().unwrap();
        let w = |rel: &str, t: &str| {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, t).unwrap();
        };
        assert!(!detect(d.path()).unwrap().css);
        w("package.json", r#"{"dependencies":{"react":"18","express":"4"}}"#);
        w("pnpm-lock.yaml", "");
        w("src/a.scss", "");
        w(".env.local", "");
        w("dist/index.html", "x");
        w("server/package.json", "not json");
        let got = detect(d.path()).unwrap();
        assert!(got.css && got.scss && got.react && got.env && got.bundle && !got.react_native);
        assert_eq!(got.backends, vec!["express"]);
        assert_eq!(got.packages.iter().map(|p| (p.dir.as_str(), p.manager)).collect::<Vec<_>>(), vec![("", "pnpm"), ("server", "none")]);
    }
}
