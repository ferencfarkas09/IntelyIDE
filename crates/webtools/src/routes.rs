//! A static map of the HTTP routes a Node backend declares: Express, Fastify, Koa (`@koa/router`), Hono, NestJS decorators and
//! Next.js (`app/**/route.ts`, `pages/api/**`). The files are read, never run. Paths are shown as written in the file: a prefix
//! given where a router is mounted (`app.use('/api', router)`) or a global prefix is not added, and a route built from a variable
//! is not found.

use std::path::Path;

use serde::Serialize;

use crate::jsmask::mask;
use crate::walk::{walk, Entry};
use crate::{clean, line_of, line_starts, Reader, WebError, SRC_CAP};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub framework: &'static str,
    /// `GET`, `POST`, ..., `ALL`, or `ANY` (a Next.js pages API file that handles every method itself).
    pub method: String,
    pub path: String,
    pub file: String,
    pub line: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteMap {
    pub routes: Vec<Route>,
    pub frameworks: Vec<&'static str>,
    pub files_scanned: u32,
    pub truncated: bool,
    pub skipped: Vec<String>,
}

const METHODS: &[&str] = &["get", "post", "put", "patch", "delete", "head", "options", "all"];
const NEST: &[&str] = &["Get", "Post", "Put", "Patch", "Delete", "Head", "Options", "All"];
const CLIENT_NAMES: &[&str] = &[
    "axios", "http", "client", "request", "supertest", "got", "fetch", "ky", "headers", "params", "query", "searchparams", "map", "cache", "store", "cookies", "formdata", "storage", "session", "env", "config",
    "cy", "page", "browser", "res", "req", "agent", "superagent",
];
const MAX_ROUTES: usize = 600;

fn imports(s: &str, name: &str) -> bool {
    ["\"", "'"].iter().any(|q| s.contains(&format!("{q}{name}{q}")) || s.contains(&format!("{q}{name}/")))
}

fn framework_of(s: &str) -> Option<&'static str> {
    if imports(s, "express") {
        Some("express")
    } else if imports(s, "fastify") {
        Some("fastify")
    } else if imports(s, "@koa/router") || imports(s, "koa-router") || imports(s, "koa") {
        Some("koa")
    } else if imports(s, "hono") {
        Some("hono")
    } else {
        None
    }
}

fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().flat_map(|p| p.split('/')).filter(|p| !p.is_empty()).collect();
    format!("/{}", joined.join("/"))
}

fn printable(p: &str) -> bool {
    !p.is_empty() && p.len() <= 200 && p.bytes().all(|b| (0x21..0x7f).contains(&b))
}

/// The string literal that starts at `i` (after spaces) in the masked text: its content from the original, or None for a
/// template literal with `${`, anything that is not a string, or an unterminated one.
fn string_at<'a>(m: &[u8], s: &'a str, i: usize) -> Option<(&'a str, usize)> {
    let mut i = i;
    while m.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    let q = *m.get(i)?;
    if q != b'"' && q != b'\'' && q != b'`' {
        return None;
    }
    let end = i + 1 + m[i + 1..].iter().take(400).position(|b| *b == q)?;
    let text = &s[i + 1..end];
    (!(q == b'`' && text.contains("${"))).then_some((text, end + 1))
}

fn scan_text(file: &str, s: &str, out: &mut Vec<Route>) {
    let m = mask(s.as_bytes());
    let starts = line_starts(s.as_bytes());
    let fw = framework_of(s);
    let nest = s.contains("@Controller");
    if fw.is_none() && !nest {
        return;
    }
    if let Some(fw) = fw {
        let mut i = 0;
        while i < m.len() && out.len() < MAX_ROUTES {
            if m[i] != b'.' {
                i += 1;
                continue;
            }
            let rest = &m[i + 1..];
            if let Some(name) = METHODS.iter().find(|n| rest.starts_with(n.as_bytes()) && rest.get(n.len()) == Some(&b'(')) {
                // the receiver: the identifier before the dot
                let mut k = i;
                while k > 0 && (m[k - 1].is_ascii_alphanumeric() || matches!(m[k - 1], b'_' | b'$')) {
                    k -= 1;
                }
                let recv = String::from_utf8_lossy(&m[k..i]).to_ascii_lowercase();
                let chained = k == i;
                if !chained && !CLIENT_NAMES.iter().any(|c| recv.contains(c)) {
                    if let Some((path, _)) = string_at(&m, s, i + 1 + name.len() + 1) {
                        if (path.starts_with('/') || path == "*") && printable(path) {
                            out.push(Route { framework: fw, method: name.to_ascii_uppercase(), path: path.to_string(), file: file.to_string(), line: line_of(&starts, i) });
                        }
                    }
                }
            } else if rest.starts_with(b"route(") && fw == "fastify" {
                let window = &m[i..(i + 500).min(m.len())];
                let find_key = |key: &str| -> Option<&str> {
                    let at = window.windows(key.len()).position(|w| w == key.as_bytes())?;
                    let colon = window[at + key.len()..].iter().position(|b| *b == b':')?;
                    string_at(&m, s, i + at + key.len() + colon + 1).map(|x| x.0)
                };
                if let (Some(method), Some(url)) = (find_key("method"), find_key("url").or_else(|| find_key("path"))) {
                    if url.starts_with('/') && printable(url) && method.bytes().all(|b| b.is_ascii_alphabetic()) {
                        out.push(Route { framework: "fastify", method: method.to_ascii_uppercase(), path: url.to_string(), file: file.to_string(), line: line_of(&starts, i) });
                    }
                }
            }
            i += 1;
        }
    }
    if nest {
        let mut prefix = String::new();
        let mut i = 0;
        while i + 1 < m.len() && out.len() < MAX_ROUTES {
            if m[i] != b'@' {
                i += 1;
                continue;
            }
            let rest = &m[i + 1..];
            if rest.starts_with(b"Controller(") {
                let a = i + 1 + "Controller(".len();
                prefix = match string_at(&m, s, a) {
                    Some((p, _)) => p.to_string(),
                    None => {
                        // `@Controller({ path: 'x' })`
                        let w = &m[a..(a + 200).min(m.len())];
                        w.windows(4).position(|x| x == b"path").and_then(|p| string_at(&m, s, a + p + 4 + w[p + 4..].iter().position(|b| *b == b':').unwrap_or(0) + 1)).map(|x| x.0.to_string()).unwrap_or_default()
                    }
                };
            } else if let Some(name) = NEST.iter().find(|n| rest.starts_with(n.as_bytes()) && rest.get(n.len()) == Some(&b'(')) {
                let a = i + 1 + name.len() + 1;
                let sub = string_at(&m, s, a).map(|x| x.0).unwrap_or("");
                if printable(&prefix) || prefix.is_empty() {
                    out.push(Route { framework: "nestjs", method: name.to_ascii_uppercase(), path: join(&[&prefix, sub]), file: file.to_string(), line: line_of(&starts, i) });
                }
            }
            i += 1;
        }
    }
}

/// `app/api/users/[id]/route.ts` -> `/api/users/[id]`: route groups `(x)` and parallel slots `@x` are not part of the URL.
fn next_path(segments: &[&str]) -> String {
    let kept: Vec<&str> = segments.iter().copied().filter(|s| !(s.starts_with('(') && s.ends_with(')')) && !s.starts_with('@')).collect();
    join(&kept)
}

fn next_app_methods(s: &str) -> Vec<&'static str> {
    ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
        .into_iter()
        .filter(|m| {
            s.contains(&format!("function {m}(")) || s.contains(&format!("function {m} (")) || s.contains(&format!("const {m} ")) || s.contains(&format!("const {m}=")) || {
                // `export { GET, POST }`
                s.match_indices("export {").take(8).any(|(at, _)| {
                    let tail = &s[at..(at + 200).min(s.len())];
                    let list = tail.split('}').next().unwrap_or("");
                    list.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).any(|w| w == *m)
                })
            }
        })
        .collect()
}

fn next_pages_methods(s: &str) -> Vec<&'static str> {
    ["GET", "POST", "PUT", "PATCH", "DELETE"].into_iter().filter(|m| s.contains(&format!("\"{m}\"")) || s.contains(&format!("'{m}'"))).collect()
}

fn next_roots(files: &[Entry], reader: &mut Reader) -> Vec<String> {
    let mut roots = Vec::new();
    for e in files.iter().filter(|e| e.rel == "package.json" || (e.rel.ends_with("/package.json") && e.rel.matches('/').count() <= 3)) {
        let Some(text) = reader.read(e, 1024 * 1024) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let has_next = ["dependencies", "devDependencies"].iter().any(|k| v.get(k).and_then(|d| d.get("next")).is_some());
        if has_next {
            roots.push(e.rel.strip_suffix("package.json").unwrap_or("").trim_end_matches('/').to_string());
        }
    }
    roots
}

pub fn route_map(root: &Path) -> Result<RouteMap, WebError> {
    let w = walk(root);
    let mut reader = Reader::new(root);
    let next = next_roots(&w.files, &mut reader);
    let mut routes: Vec<Route> = Vec::new();
    let mut map = RouteMap::default();
    for e in &w.files {
        if !matches!(e.ext.as_str(), "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts") {
            continue;
        }
        let lower = e.rel.to_ascii_lowercase();
        if [".test.", ".spec.", "/__tests__/", "/e2e/", ".d.ts"].iter().any(|p| lower.contains(p)) {
            continue;
        }
        // Next.js files first: their path is the route
        let mut next_hit: Option<(String, bool)> = None; // (path, is app router)
        for r in &next {
            let Some(rest) = (if r.is_empty() { Some(e.rel.as_str()) } else { e.rel.strip_prefix(&format!("{r}/")) }) else { continue };
            let rest = rest.strip_prefix("src/").unwrap_or(rest);
            let segs: Vec<&str> = rest.split('/').collect();
            let stem = segs.last().and_then(|f| f.rsplit_once('.')).map_or("", |x| x.0);
            if segs.first() == Some(&"app") && stem == "route" {
                next_hit = Some((next_path(&segs[1..segs.len() - 1]), true));
            } else if segs.len() >= 3 && segs[0] == "pages" && segs[1] == "api" {
                let mut dirs: Vec<&str> = segs[1..segs.len() - 1].to_vec();
                if stem != "index" {
                    dirs.push(stem);
                }
                next_hit = Some((next_path(&dirs), false));
            }
            if next_hit.is_some() {
                break;
            }
        }
        let Some(text) = reader.read(e, SRC_CAP) else { continue };
        map.files_scanned += 1;
        if let Some((path, app)) = next_hit {
            let methods = if app { next_app_methods(&text) } else { next_pages_methods(&text) };
            if methods.is_empty() {
                routes.push(Route { framework: "nextjs", method: "ANY".into(), path, file: e.rel.clone(), line: 1 });
            } else {
                for m in methods {
                    routes.push(Route { framework: "nextjs", method: m.to_string(), path: path.clone(), file: e.rel.clone(), line: 1 });
                }
            }
        } else {
            scan_text(&e.rel, &text, &mut routes);
        }
        if routes.len() >= MAX_ROUTES {
            map.truncated = true;
            break;
        }
    }
    for r in &mut routes {
        r.path = clean(&r.path, 200);
    }
    routes.sort_by(|a, b| a.path.cmp(&b.path).then_with(|| a.method.cmp(&b.method)).then_with(|| a.file.cmp(&b.file)));
    routes.dedup_by(|a, b| a.path == b.path && a.method == b.method && a.file == b.file && a.line == b.line);
    for r in &routes {
        if !map.frameworks.contains(&r.framework) {
            map.frameworks.push(r.framework);
        }
    }
    map.routes = routes;
    map.truncated |= reader.truncated;
    map.skipped = reader.skipped;
    map.skipped.extend(w.notes);
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        d
    }

    fn list(m: &RouteMap) -> Vec<String> {
        m.routes.iter().map(|r| format!("{} {} {} {}:{}", r.framework, r.method, r.path, r.file, r.line)).collect()
    }

    #[test]
    fn express_fastify_koa_and_hono() {
        let d = repo(&[
            ("server/app.js", "const express = require('express');\nconst app = express();\napp.get('/users', h);\nrouter.post(\"/users/:id\", h);\naxios.get('/not-a-route');\ncache.get('/key');\napp.get(path, h);\napp.use('/api', r);\n"),
            ("f/server.ts", "import Fastify from 'fastify';\nfastify.get('/ping', h);\nfastify.route({ method: 'PUT', url: '/items/:id', handler });\n"),
            ("k/r.ts", "import Router from '@koa/router';\nrouter.delete('/x', h);\n"),
            ("h/i.ts", "import { Hono } from 'hono';\napp.all('*', h);\n"),
            ("noframework.js", "map.get('/x'); app.get('/y');"),
        ]);
        let m = route_map(d.path()).unwrap();
        assert_eq!(
            list(&m),
            vec![
                "hono ALL * h/i.ts:2",
                "fastify PUT /items/:id f/server.ts:3",
                "fastify GET /ping f/server.ts:2",
                "express GET /users server/app.js:3",
                "express POST /users/:id server/app.js:4",
                "koa DELETE /x k/r.ts:2",
            ]
        );
    }

    #[test]
    fn nestjs_controllers() {
        let d = repo(&[("src/users.controller.ts", "import { Controller, Get } from '@nestjs/common';\n@Controller('users')\nexport class U {\n  @Get()\n  all() {}\n  @Get(':id')\n  one() {}\n  @Post('/new')\n  make() {}\n}\n@Controller({ path: 'cats' })\nclass C { @Delete(':id') rm() {} }\n")]);
        let m = route_map(d.path()).unwrap();
        assert_eq!(
            list(&m),
            vec!["nestjs DELETE /cats/:id src/users.controller.ts:12", "nestjs GET /users src/users.controller.ts:4", "nestjs GET /users/:id src/users.controller.ts:6", "nestjs POST /users/new src/users.controller.ts:8"]
        );
    }

    #[test]
    fn nextjs_app_and_pages_routes() {
        let d = repo(&[
            ("package.json", r#"{"dependencies":{"next":"15.0.0"}}"#),
            ("app/api/users/[id]/route.ts", "export async function GET() {}\nexport const POST = async () => {};"),
            ("src/app/(shop)/cart/route.js", "export { GET, DELETE };"),
            ("pages/api/hello.js", "export default function handler(req, res) { if (req.method === 'POST') {} }"),
            ("pages/api/users/index.ts", "export default function h() {}"),
            ("pages/index.tsx", "export default function Home() {}"),
        ]);
        let m = route_map(d.path()).unwrap();
        assert_eq!(
            list(&m),
            vec![
                "nextjs POST /api/hello pages/api/hello.js:1",
                "nextjs ANY /api/users pages/api/users/index.ts:1",
                "nextjs GET /api/users/[id] app/api/users/[id]/route.ts:1",
                "nextjs POST /api/users/[id] app/api/users/[id]/route.ts:1",
                "nextjs DELETE /cart src/app/(shop)/cart/route.js:1",
                "nextjs GET /cart src/app/(shop)/cart/route.js:1",
            ]
        );
    }

    #[test]
    fn hostile_files() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.js"), format!("require('express');{}", "app.get('/x',h);".repeat(50_000))).unwrap();
        std::fs::write(d.path().join("b.js"), format!("require('express');{}", ".get(`".repeat(100_000))).unwrap();
        std::fs::write(d.path().join("c.ts"), [b'@', 0xff, b'C', b'o']).unwrap();
        let m = route_map(d.path()).unwrap();
        assert!(m.routes.len() <= MAX_ROUTES);
    }
}
