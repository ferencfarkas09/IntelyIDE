//! A same-length copy of a JavaScript/TypeScript/JSX source in which comments, the inside of strings, the static parts of
//! template literals and regular expression literals are blanked out (spaces; newlines stay), so that braces, parentheses and
//! tags can be matched on the copy without being fooled by what is inside a string. Offsets are the same as in the original.
//! One pass, linear. It is a heuristic: JSX text with an apostrophe or `//` can blank the rest of its line, which costs at most
//! that line.

pub(crate) fn mask(src: &[u8]) -> Vec<u8> {
    mask_counting(src).0
}

/// [`mask`], and the number of byte steps it took (every inner loop counts), so that a test can assert linear work without a clock.
pub(crate) fn mask_counting(src: &[u8]) -> (Vec<u8>, usize) {
    let mut out = src.to_vec();
    let n = src.len();
    let mut ops = 0usize;
    let mut i = 0;
    let mut depth = 0usize;
    let mut tmpl: Vec<usize> = Vec::new(); // brace depth of each open `${`
    let mut prev = 0u8; // last significant code byte
    // A `/` after one of `(,=:[!&|?{;` is tried as the start of a regular expression literal, which has to close on the same line.
    // One failed try means no later `/` of this line can close one either, so the rest of the line is not tried again: without
    // this, a line of `(/[(/[(/[...` rescans its own tail from every slash (quadratic).
    let mut no_regex_before = 0usize;
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for b in out[from..to.min(n)].iter_mut() {
            if *b != b'\n' {
                *b = b' ';
            }
        }
    };
    // continues a template literal from `i` (just after the opening backtick or after the closing `}` of a `${`)
    fn template(src: &[u8], out: &mut [u8], mut i: usize, depth: &mut usize, tmpl: &mut Vec<usize>, ops: &mut usize) -> usize {
        let n = src.len();
        while i < n {
            *ops += 1;
            match src[i] {
                b'\\' => {
                    if out[i] != b'\n' {
                        out[i] = b' ';
                    }
                    if i + 1 < n && out[i + 1] != b'\n' {
                        out[i + 1] = b' ';
                    }
                    i += 2;
                    continue;
                }
                b'`' => return i + 1,
                b'$' if src.get(i + 1) == Some(&b'{') => {
                    *depth += 1;
                    tmpl.push(*depth);
                    out[i] = b' ';
                    return i + 2;
                }
                b'\n' => {}
                _ => out[i] = b' ',
            }
            i += 1;
        }
        n
    }
    while i < n {
        ops += 1;
        let c = src[i];
        match c {
            b'/' if src.get(i + 1) == Some(&b'/') => {
                let end = src[i..].iter().position(|b| *b == b'\n').map_or(n, |p| i + p);
                ops += end - i;
                blank(&mut out, i, end);
                i = end;
                continue;
            }
            b'/' if src.get(i + 1) == Some(&b'*') => {
                let end = src[i + 2..].windows(2).position(|w| w == b"*/").map_or(n, |p| i + 2 + p + 2);
                ops += end - i;
                blank(&mut out, i, end);
                i = end;
                continue;
            }
            b'"' | b'\'' => {
                let mut j = i + 1;
                while j < n && src[j] != c && src[j] != b'\n' {
                    ops += 1;
                    j += if src[j] == b'\\' { 2 } else { 1 };
                }
                let j = j.min(n);
                blank(&mut out, i + 1, j);
                i = if j < n && src[j] == c { j + 1 } else { j };
                prev = c;
                continue;
            }
            b'`' => {
                out[i] = b'`';
                i = template(src, &mut out, i + 1, &mut depth, &mut tmpl, &mut ops);
                prev = b'`';
                continue;
            }
            b'/' if i >= no_regex_before && (prev == 0 || b"(,=:[!&|?{;".contains(&prev)) => {
                // a regular expression literal, when it closes on this line
                let mut j = i + 1;
                let mut class = false;
                let mut closed = false;
                while j < n && src[j] != b'\n' {
                    ops += 1;
                    match src[j] {
                        b'\\' => j += 1,
                        b'[' => class = true,
                        b']' => class = false,
                        b'/' if !class => {
                            closed = true;
                            break;
                        }
                        _ => {}
                    }
                    j += 1;
                }
                if closed {
                    blank(&mut out, i + 1, j);
                    i = j + 1;
                    prev = b'/';
                    continue;
                }
                no_regex_before = j.min(n);
            }
            b'{' => depth += 1,
            b'}' => {
                if tmpl.last() == Some(&depth) {
                    tmpl.pop();
                    depth -= 1;
                    i = template(src, &mut out, i + 1, &mut depth, &mut tmpl, &mut ops);
                    continue;
                }
                depth = depth.saturating_sub(1);
            }
            _ => {}
        }
        if !c.is_ascii_whitespace() {
            prev = c;
        }
        i += 1;
    }
    (out, ops)
}

/// The index of the closer that matches the opener at `open` (`{`, `(` or `[`), on a masked buffer; None when it never closes or
/// when `budget` (bytes the whole file may still scan this way) runs out. The budget keeps nested or unclosed input linear.
pub(crate) fn matching(m: &[u8], open: usize, budget: &mut usize) -> Option<usize> {
    let (o, c) = match m.get(open)? {
        b'{' => (b'{', b'}'),
        b'(' => (b'(', b')'),
        b'[' => (b'[', b']'),
        _ => return None,
    };
    let mut depth = 0usize;
    for (k, b) in m[open..].iter().enumerate() {
        if *budget == 0 {
            return None;
        }
        *budget -= 1;
        if *b == o {
            depth += 1;
        } else if *b == c {
            depth -= 1;
            if depth == 0 {
                return Some(open + k);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(s: &str) -> String {
        String::from_utf8(mask(s.as_bytes())).unwrap()
    }

    #[test]
    fn strings_comments_regexes_and_templates_are_blanked_with_the_same_length() {
        let src = "a(\"x{\", 'y}') // z{\n/* {{ */ b = /[}{]/.test(s); c = `t{${f(1)}}u`;";
        let out = m(src);
        assert_eq!(out.len(), src.len());
        assert_eq!(out.matches('{').count(), 1);
        assert_eq!(out.matches('}').count(), 1);
        assert!(out.contains("f(1)"));
        assert_eq!(out.lines().count(), src.lines().count());
    }

    #[test]
    fn unterminated_things_end_at_the_end_of_the_line_or_the_file() {
        assert_eq!(m("a = 'unterminated\nb = 1").lines().nth(1).unwrap(), "b = 1");
        assert_eq!(m("/* never closed {").trim(), "");
        assert_eq!(m("`never closed ${ {").len(), 18);
    }

    #[test]
    fn matching_finds_the_closer_and_gives_up_when_there_is_none() {
        let s = m("f(a, (b), '(' ) { x }");
        let open = s.find('(').unwrap();
        let mut budget = 1000;
        assert_eq!(matching(s.as_bytes(), open, &mut budget), Some(s.find(" {").unwrap() - 1));
        assert_eq!(matching(b"((", 0, &mut budget), None);
        let mut small = 3;
        assert_eq!(matching(b"(((((())))))", 0, &mut small), None);
    }

    /// Inputs that make a careless masker quadratic; every one is 1.5 MB (the largest file the tools read) or more.
    fn hostile_shapes() -> Vec<(&'static str, Vec<u8>)> {
        let mb = 1_572_864;
        let rep = |unit: &str| unit.repeat(mb / unit.len() + 1).into_bytes();
        vec![
            ("slash-bracket", rep("(/[")),
            ("slash-paren", rep("(/(")),
            ("regex-never-closing", rep("x = /[abc")),
            ("many-slashes", rep("a=/")),
            ("open-parens", rep("(")),
            ("quotes-backslashes", rep("'\\")),
            ("template-open", rep("`${")),
            ("template-nested", rep("`${`${")),
            ("block-comment-open", rep("/* ")),
            ("line-comments", rep("// x\n")),
            ("long-string-no-end", rep("\"abc")),
            ("braces", rep("{")),
            ("close-braces", rep("}")),
            ("jsx-lts", rep("<a ")),
        ]
    }

    #[test]
    fn the_work_is_linear_in_the_input_for_every_hostile_shape() {
        for (name, src) in hostile_shapes() {
            let (out, ops) = mask_counting(&src);
            assert_eq!(out.len(), src.len(), "{name}");
            assert!(ops <= 6 * src.len() + 64, "{name}: {ops} steps for {} bytes", src.len());
        }
    }

    #[test]
    fn a_line_of_failed_regex_starts_is_masked_in_time() {
        // the review's input: n = 80,000 repetitions took 17 seconds before the fix
        let src = "(/[".repeat(500_000).into_bytes();
        let t = std::time::Instant::now();
        let _ = mask(&src);
        let limit = if cfg!(debug_assertions) { 10 } else { 2 };
        assert!(t.elapsed().as_secs() < limit, "{:?}", t.elapsed());
    }

    #[test]
    fn a_regex_after_a_failed_try_on_an_earlier_line_is_still_found() {
        let src = "a = (/[x\nb = /[}{]/.test(s);";
        let out = String::from_utf8(mask(src.as_bytes())).unwrap();
        assert!(!out.lines().nth(1).unwrap().contains('{'));
    }

    #[test]
    fn hostile_input_is_linear() {
        let big = "(".repeat(2_000_000);
        let _ = mask(big.as_bytes());
        let quotes = "'\\".repeat(1_000_000);
        let _ = mask(quotes.as_bytes());
        let slashes = "x = /".repeat(300_000);
        let _ = mask(slashes.as_bytes());
        let tmpls = "`${".repeat(300_000);
        let _ = mask(tmpls.as_bytes());
    }
}
