//! A reader for the old-style ("OpenStep") property list Xcode writes as `project.pbxproj`. It builds a tree with line numbers so
//! a finding can point at the line. Limits on depth and size keep a hostile file from costing more than a moment.

const MAX_DEPTH: usize = 48;
const MAX_NODES: usize = 800_000;

#[derive(Debug, Clone)]
pub(crate) struct Node {
    pub line: u32,
    pub v: V,
}

#[derive(Debug, Clone)]
pub(crate) enum V {
    Str(String),
    Arr(Vec<Node>),
    Dict(Vec<(String, Node)>),
}

impl Node {
    pub fn get(&self, key: &str) -> Option<&Node> {
        match &self.v {
            V::Dict(d) => d.iter().find(|(k, _)| k == key).map(|(_, n)| n),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match &self.v {
            V::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn gets(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Node::str)
    }
    pub fn items(&self) -> &[Node] {
        match &self.v {
            V::Arr(a) => a,
            _ => &[],
        }
    }
    pub fn entries(&self) -> &[(String, Node)] {
        match &self.v {
            V::Dict(d) => d,
            _ => &[],
        }
    }
}

struct P<'a> {
    b: &'a [u8],
    s: &'a str,
    i: usize,
    line: u32,
    nodes: usize,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Bad {
    Syntax,
    TooDeep,
    TooBig,
}

impl<'a> P<'a> {
    fn skip(&mut self) {
        while self.i < self.b.len() {
            match self.b[self.i] {
                b'\n' => {
                    self.line += 1;
                    self.i += 1;
                }
                b' ' | b'\t' | b'\r' => self.i += 1,
                b'/' if self.b.get(self.i + 1) == Some(&b'*') => {
                    self.i += 2;
                    while self.i < self.b.len() && !(self.b[self.i] == b'*' && self.b.get(self.i + 1) == Some(&b'/')) {
                        if self.b[self.i] == b'\n' {
                            self.line += 1;
                        }
                        self.i += 1;
                    }
                    self.i = (self.i + 2).min(self.b.len());
                }
                b'/' if self.b.get(self.i + 1) == Some(&b'/') => {
                    while self.i < self.b.len() && self.b[self.i] != b'\n' {
                        self.i += 1;
                    }
                }
                _ => break,
            }
        }
    }

    fn string(&mut self) -> Result<String, Bad> {
        if self.b.get(self.i) == Some(&b'"') {
            self.i += 1;
            let mut out = Vec::new();
            while self.i < self.b.len() && self.b[self.i] != b'"' {
                if self.b[self.i] == b'\\' && self.i + 1 < self.b.len() {
                    self.i += 1;
                    out.push(match self.b[self.i] {
                        b'n' => b'\n',
                        b't' => b'\t',
                        c => c,
                    });
                } else {
                    out.push(self.b[self.i]);
                }
                if self.b[self.i] == b'\n' {
                    self.line += 1;
                }
                self.i += 1;
            }
            if self.i >= self.b.len() {
                return Err(Bad::Syntax);
            }
            self.i += 1;
            return Ok(String::from_utf8_lossy(&out).into_owned());
        }
        let start = self.i;
        while self.i < self.b.len() && !matches!(self.b[self.i], b' ' | b'\t' | b'\r' | b'\n' | b';' | b',' | b'=' | b'(' | b')' | b'{' | b'}' | b'"') {
            self.i += 1;
        }
        if self.i == start {
            return Err(Bad::Syntax);
        }
        Ok(self.s.get(start..self.i).ok_or(Bad::Syntax)?.to_string())
    }

    fn value(&mut self, depth: usize) -> Result<Node, Bad> {
        if depth > MAX_DEPTH {
            return Err(Bad::TooDeep);
        }
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            return Err(Bad::TooBig);
        }
        self.skip();
        let line = self.line;
        match self.b.get(self.i) {
            Some(b'{') => {
                self.i += 1;
                let mut d = Vec::new();
                loop {
                    self.skip();
                    match self.b.get(self.i) {
                        Some(b'}') => {
                            self.i += 1;
                            break;
                        }
                        None => return Err(Bad::Syntax),
                        _ => {}
                    }
                    let key = self.string()?;
                    self.skip();
                    if self.b.get(self.i) != Some(&b'=') {
                        return Err(Bad::Syntax);
                    }
                    self.i += 1;
                    let v = self.value(depth + 1)?;
                    self.skip();
                    if self.b.get(self.i) == Some(&b';') {
                        self.i += 1;
                    }
                    d.push((key, v));
                }
                Ok(Node { line, v: V::Dict(d) })
            }
            Some(b'(') => {
                self.i += 1;
                let mut a = Vec::new();
                loop {
                    self.skip();
                    match self.b.get(self.i) {
                        Some(b')') => {
                            self.i += 1;
                            break;
                        }
                        None => return Err(Bad::Syntax),
                        _ => {}
                    }
                    a.push(self.value(depth + 1)?);
                    self.skip();
                    if self.b.get(self.i) == Some(&b',') {
                        self.i += 1;
                    }
                }
                Ok(Node { line, v: V::Arr(a) })
            }
            Some(_) => Ok(Node { line, v: V::Str(self.string()?) }),
            None => Err(Bad::Syntax),
        }
    }
}

pub(crate) fn parse(text: &str) -> Result<Node, Bad> {
    let mut p = P { b: text.as_bytes(), s: text, i: 0, line: 1, nodes: 0 };
    let n = p.value(0)?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_dictionary_with_lines_and_comments() {
        let t = "// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tobjects = {\n\t\tAB /* x */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tlist = (\n\t\t\t\tA /* a */,\n\t\t\t\t\"b c\",\n\t\t\t);\n\t\t};\n\t};\n}\n";
        let n = parse(t).unwrap();
        let ab = n.get("objects").unwrap().get("AB").unwrap();
        assert_eq!(ab.gets("isa"), Some("XCBuildConfiguration"));
        assert_eq!(ab.get("isa").unwrap().line, 6);
        assert_eq!(ab.get("list").unwrap().items().len(), 2);
        assert_eq!(ab.get("list").unwrap().items()[1].str(), Some("b c"));
    }

    #[test]
    fn hostile_input_is_refused_not_followed() {
        assert_eq!(parse(&"(".repeat(100_000)).unwrap_err(), Bad::TooDeep);
        assert!(parse("{ a = ").is_err());
        assert!(parse("{ \"unterminated = 1; }").is_err());
        assert!(parse(&format!("{{ {} }}", "a = b;".repeat(10))).is_ok());
        assert_eq!(parse(&format!("({})", "a,".repeat(900_000))).unwrap_err(), Bad::TooBig);
    }
}
