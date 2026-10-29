//! A size report of an EXISTING build output (`dist/`, `build/`, `.next/static`, `out/`, ...): the biggest files, totals by kind,
//! and a gzip estimate. It never runs a build and never writes anything. The estimate is a typical ratio per file type (the
//! standard library has no compressor), not a measurement, and the report says so.

use std::path::Path;

use serde::Serialize;

use crate::walk::walk_in;
use crate::WebError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub path: String,
    pub size: u64,
    pub gzip_estimate: u64,
    /// `js`, `css`, `html`, `image`, `font`, `media`, `data` or `other`.
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindSize {
    pub kind: &'static str,
    pub size: u64,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleDir {
    pub dir: String,
    pub total_size: u64,
    pub total_gzip_estimate: u64,
    pub files: u32,
    /// Source maps are listed apart: they are not shipped to users.
    pub map_size: u64,
    pub top: Vec<Asset>,
    pub by_kind: Vec<KindSize>,
    /// Unix seconds of the newest file: the build may be older than the source.
    pub newest: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleReport {
    pub dirs: Vec<BundleDir>,
    pub truncated: bool,
}

const OUTPUTS: &[&str] = &["dist", "build", ".next/static", "out", ".output/public", "web-build", "www", "storybook-static"];
const SUBAPPS: &[&str] = &["client", "web", "frontend", "app", "site", "ui"];

fn kind_of(ext: &str) -> (&'static str, f64) {
    match ext {
        "js" | "mjs" | "cjs" => ("js", 0.32),
        "css" => ("css", 0.25),
        "html" | "htm" => ("html", 0.30),
        "json" | "webmanifest" | "xml" | "txt" => ("data", 0.25),
        "svg" => ("image", 0.35),
        "png" | "jpg" | "jpeg" | "webp" | "avif" | "gif" | "ico" => ("image", 1.0),
        "woff" | "woff2" => ("font", 1.0),
        "ttf" | "otf" | "eot" => ("font", 0.5),
        "mp4" | "webm" | "mp3" | "ogg" | "wav" | "mov" => ("media", 1.0),
        "gz" | "br" | "zip" => ("other", 1.0),
        _ => ("other", 0.5),
    }
}

fn is_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_dir())
}

fn subfolders(root: &Path, parent: &str) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(root.join(parent)) else { return Vec::new() };
    let mut v: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.') && n != "node_modules")
        .take(60)
        .map(|n| format!("{parent}/{n}"))
        .collect();
    v.sort();
    v
}

pub fn bundle_report(root: &Path) -> Result<BundleReport, WebError> {
    let mut bases = vec![String::new()];
    for group in ["apps", "packages"] {
        bases.extend(subfolders(root, group));
    }
    bases.extend(SUBAPPS.iter().filter(|n| is_dir(&root.join(n))).map(|n| n.to_string()));
    let mut report = BundleReport::default();
    for base in &bases {
        for out in OUTPUTS {
            let rel = if base.is_empty() { out.to_string() } else { format!("{base}/{out}") };
            if !is_dir(&root.join(&rel)) {
                continue;
            }
            let w = walk_in(root, &rel, &[], false);
            report.truncated |= !w.notes.is_empty();
            let web = w.files.iter().any(|e| matches!(e.ext.as_str(), "js" | "css" | "html" | "mjs"));
            if !web {
                continue;
            }
            let mut assets = Vec::new();
            let (mut total, mut gz, mut maps, mut newest) = (0u64, 0u64, 0u64, 0u64);
            let mut kinds: Vec<KindSize> = Vec::new();
            for e in &w.files {
                if e.ext == "map" {
                    maps += e.size;
                    continue;
                }
                let (kind, ratio) = kind_of(&e.ext);
                let est = (e.size as f64 * ratio) as u64;
                total += e.size;
                gz += est;
                newest = newest.max(e.mtime);
                match kinds.iter_mut().find(|k| k.kind == kind) {
                    Some(k) => {
                        k.size += e.size;
                        k.count += 1;
                    }
                    None => kinds.push(KindSize { kind, size: e.size, count: 1 }),
                }
                assets.push(Asset { path: e.rel.clone(), size: e.size, gzip_estimate: est, kind });
            }
            let files = assets.len() as u32;
            assets.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
            assets.truncate(10);
            kinds.sort_by_key(|k| std::cmp::Reverse(k.size));
            report.dirs.push(BundleDir { dir: rel, total_size: total, total_gzip_estimate: gz, files, map_size: maps, top: assets, by_kind: kinds, newest });
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_top_assets_of_an_existing_output_and_skips_maps() {
        let d = tempfile::tempdir().unwrap();
        for (rel, n) in [("dist/assets/app.js", 5000usize), ("dist/assets/app.js.map", 9000), ("dist/index.html", 300), ("dist/logo.png", 2000), ("build/readme.txt", 5)] {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, vec![b'a'; n]).unwrap();
        }
        let r = bundle_report(d.path()).unwrap();
        assert_eq!(r.dirs.len(), 1, "build/ holds no web files");
        let dist = &r.dirs[0];
        assert_eq!((dist.dir.as_str(), dist.files, dist.total_size, dist.map_size), ("dist", 3, 7300, 9000));
        assert_eq!(dist.top[0].path, "dist/assets/app.js");
        assert_eq!(dist.top[0].gzip_estimate, 1600);
        assert_eq!(dist.top[2].path, "dist/index.html");
        assert_eq!(dist.by_kind[0].kind, "js");
    }

    #[test]
    fn no_output_is_an_empty_report_and_links_are_not_followed() {
        let d = tempfile::tempdir().unwrap();
        assert!(bundle_report(d.path()).unwrap().dirs.is_empty());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("a.js"), "x").unwrap();
            std::os::unix::fs::symlink(outside.path(), d.path().join("dist")).unwrap();
            assert!(bundle_report(d.path()).unwrap().dirs.is_empty());
        }
    }
}
