//! Every public scanner against hostile files of the largest size the tools read (1.5 MB), several shapes each, with a time bound.
//! The bounds are generous on purpose (a debug build on a slow CI runner); a quadratic scan misses them by orders of magnitude
//! (the review's `(/[` line took 17 seconds at 234 KB). The finer, clock-free assertions are the step counters inside the crate.

use std::time::{Duration, Instant};

use intely_webtools::{bundle_report, detect, env_report, find_rule, react_checks, route_map, token_report, unused_styles, ReactOptions, RuleQuery};

const MB: usize = 1_500_000;
const LIMIT: Duration = Duration::from_secs(if cfg!(debug_assertions) { 25 } else { 5 });

fn rep(unit: &str) -> String {
    unit.repeat(MB / unit.len() + 1)
}

fn css_shapes() -> Vec<(&'static str, String)> {
    vec![
        ("open-braces", rep("{")),
        ("nested-rules", rep("a{")),
        ("close-braces", rep("}")),
        ("unterminated-comment", format!("/*{}", rep("x"))),
        ("unterminated-string", format!("a{{b:\"{}", rep("x"))),
        ("one-long-selector", format!("{} {{ a:1px }}", rep(".a,"))),
        ("many-tiny-decls", rep("a:1px;")),
        ("many-custom-props", rep("--a:1;")),
        ("scss-vars", rep("$a:1;")),
        ("interpolation", rep("#{")),
        ("parens", rep("(")),
        ("ampersands", rep(".a{&-b{&-c{")),
        ("scss-line-comments", rep("// x\n")),
        ("urls", rep("a:url(//")),
    ]
}

fn code_shapes() -> Vec<(&'static str, String)> {
    vec![
        ("slash-bracket", rep("(/[")),
        ("template-open", rep("`${")),
        ("quotes", rep("'\"`")),
        ("class-helpers", rep("cn(")),
        ("styles-index", rep("styles[")),
        ("routes", rep("app.get('/x', h);")),
        ("route-chains", rep(".route('/x')")),
        ("decorators", rep("@Controller('a')@Get('b')")),
        ("jsx-lts", rep("<a ")),
        ("jsx-inputs", rep("<input />")),
        ("components", rep("function A({a}) {}\n")),
        ("env-like", rep("A=1\n")),
    ]
}

fn timed<T>(what: &str, f: impl FnOnce() -> T) -> T {
    let t = Instant::now();
    let out = f();
    assert!(t.elapsed() < LIMIT, "{what}: {:?}", t.elapsed());
    out
}

#[test]
fn style_scanners_finish_on_hostile_style_sheets() {
    for (name, text) in css_shapes() {
        for ext in ["css", "scss", "sass", "less"] {
            let d = tempfile::tempdir().unwrap();
            std::fs::write(d.path().join(format!("h.{ext}")), &text).unwrap();
            std::fs::write(d.path().join("app.tsx"), "export const A = () => <div className=\"a\" />;").unwrap();
            timed(&format!("tokens {name}.{ext}"), || token_report(d.path()).unwrap());
            timed(&format!("styles {name}.{ext}"), || unused_styles(d.path()).unwrap());
            timed(&format!("findrule {name}.{ext}"), || find_rule(d.path(), &RuleQuery { tag: "div".into(), id: String::new(), classes: vec!["a".into()] }).unwrap());
        }
    }
}

#[test]
fn code_scanners_finish_on_hostile_sources() {
    for (name, text) in code_shapes() {
        for ext in ["tsx", "js", "ts"] {
            let d = tempfile::tempdir().unwrap();
            std::fs::write(d.path().join(format!("h.{ext}")), format!("import React from 'react'; require('express');\n{text}")).unwrap();
            std::fs::write(d.path().join("a.css"), ".a{} .b{}").unwrap();
            std::fs::write(d.path().join(".env"), &text).unwrap();
            timed(&format!("react {name}.{ext}"), || react_checks(d.path(), ReactOptions::default()).unwrap());
            timed(&format!("routes {name}.{ext}"), || route_map(d.path()).unwrap());
            timed(&format!("styles {name}.{ext}"), || unused_styles(d.path()).unwrap());
            timed(&format!("tokens {name}.{ext}"), || token_report(d.path()).unwrap());
            timed(&format!("env {name}.{ext}"), || env_report(d.path(), &[]).unwrap());
            timed(&format!("detect {name}.{ext}"), || detect(d.path()).unwrap());
        }
    }
}

#[test]
fn bundle_and_detect_finish_on_a_wide_and_a_deep_tree() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join("dist")).unwrap();
    for i in 0..5000 {
        std::fs::write(d.path().join("dist").join(format!("f{i}.js")), "x").unwrap();
    }
    let deep = (0..40).map(|i| format!("d{i}")).collect::<Vec<_>>().join("/");
    std::fs::create_dir_all(d.path().join(&deep)).unwrap();
    std::fs::write(d.path().join(&deep).join("a.css"), "x").unwrap();
    std::fs::write(d.path().join("package.json"), rep("{\"a\":")).unwrap();
    let r = timed("bundle", || bundle_report(d.path()).unwrap());
    assert_eq!(r.dirs[0].files, 5000);
    timed("detect", || detect(d.path()).unwrap());
}
