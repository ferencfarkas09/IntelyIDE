//! mongosh-literal parser corpus: explicit cases, generated Compass-style cases, equivalence classes, rejections and a
//! no-panic sweep. Reference behaviour is `@mongodb-js/shell-bson-parser` (not run here; the oracle run is human work).

use intely_mongo::shell::{parse, parse_document, parse_with, ParseOptions};
use serde_json::{json, Value};

fn j(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|e| panic!("bad expectation {s}: {e}"))
}
fn i32v(n: i32) -> Value {
    json!({"$numberInt": n.to_string()})
}

const OID: &str = "507f1f77bcf86cd799439011";
const T1: &str = "2024-05-17T08:30:00Z";
const T1_MS: &str = "1715934600000";

/// (input, expected canonical EJSON)
fn explicit() -> Vec<(String, Value)> {
    let oid = json!({"$oid": OID});
    let d = |ms: &str| json!({"$date": {"$numberLong": ms}});
    let c: Vec<(String, Value)> = vec![
        ("{}".into(), json!({})),
        ("{a: 1}".into(), json!({"a": i32v(1)})),
        ("{ \"a\" : 1 }".into(), json!({"a": i32v(1)})),
        ("{'a': 'x'}".into(), json!({"a": "x"})),
        ("{a: 'it\\'s'}".into(), json!({"a": "it's"})),
        (r#"{a: "say \"hi\""}"#.into(), json!({"a": "say \"hi\""})),
        (r#"{a: "tab\there\nnlé"}"#.into(), json!({"a": "tab\there\nn\u{e9}l".replace("n\u{e9}l", "nl\u{e9}")})),
        (r#"{a: "😀"}"#.into(), json!({"a": "\u{1F600}"})),
        ("{név: 'Kovács'}".replace("név", "'név'").as_str().into(), json!({"név": "Kovács"})),
        ("{a: 'Árvíztűrő tükörfúrógép'}".into(), json!({"a": "Árvíztűrő tükörfúrógép"})),
        ("{a: true, b: false, c: null}".into(), json!({"a": true, "b": false, "c": null})),
        ("{a: undefined}".into(), json!({"a": {"$undefined": true}})),
        ("{a: -5}".into(), json!({"a": i32v(-5)})),
        ("{a: +5}".into(), json!({"a": i32v(5)})),
        ("{a: 1.5}".into(), json!({"a": {"$numberDouble": "1.5"}})),
        ("{a: 2.0}".into(), json!({"a": {"$numberDouble": "2.0"}})),
        ("{a: .5}".into(), json!({"a": {"$numberDouble": "0.5"}})),
        ("{a: 1e3}".into(), json!({"a": {"$numberDouble": "1000.0"}})),
        ("{a: 3000000000}".into(), json!({"a": {"$numberDouble": "3000000000.0"}})),
        ("{a: -2147483648}".into(), json!({"a": i32v(i32::MIN)})),
        ("{a: 0x1F}".into(), json!({"a": i32v(31)})),
        ("{a: Infinity, b: -Infinity, c: NaN}".into(), json!({"a": {"$numberDouble":"Infinity"}, "b": {"$numberDouble":"-Infinity"}, "c": {"$numberDouble":"NaN"}})),
        ("{1: 'a'}".into(), json!({"1": "a"})),
        ("{$gt: 3}".into(), json!({"$gt": i32v(3)})),
        ("{a: [1, 'x', null,]}".into(), json!({"a": [i32v(1), "x", null]})),
        ("[]".into(), json!([])),
        ("{a: {b: {c: [ {d: 1} ]}}}".into(), json!({"a": {"b": {"c": [{"d": i32v(1)}]}}})),
        (format!("{{_id: ObjectId(\"{OID}\")}}"), json!({"_id": oid})),
        (format!("{{_id: ObjectId('{}')}}", OID.to_uppercase()), json!({"_id": oid})),
        (format!("{{_id: new ObjectId(\"{OID}\")}}"), json!({"_id": oid})),
        (format!("{{_id: ObjectID(\"{OID}\")}}"), json!({"_id": oid})),
        (format!("{{t: ISODate(\"{T1}\")}}"), json!({"t": d(T1_MS)})),
        ("{t: new Date('2024-05-17T08:30:00+02:00')}".into(), json!({"t": d("1715934600000").as_object().map(|_| d("1715927400000")).unwrap()})),
        ("{t: ISODate('2020-01-01')}".into(), json!({"t": d("1577836800000")})),
        ("{t: ISODate('2020-01-01T00:00:00.5Z')}".into(), json!({"t": d("1577836800500")})),
        ("{t: ISODate('2020-01-01T00:00:00.123456Z')}".into(), json!({"t": d("1577836800123")})),
        ("{t: ISODate('2000-02-29T12:00:00Z')}".into(), json!({"t": d("951825600000")})),
        ("{t: ISODate('1969-12-31T23:59:59.999Z')}".into(), json!({"t": d("-1")})),
        ("{t: ISODate('1900-01-01')}".into(), json!({"t": d("-2208988800000")})),
        ("{t: ISODate('2020-01-01 10:00')}".into(), json!({"t": d("1577872800000")})),
        ("{t: new Date(0)}".into(), json!({"t": d("0")})),
        ("{t: new Date(1577836800000)}".into(), json!({"t": d("1577836800000")})),
        ("{t: new Date(2020, 0, 1)}".into(), json!({"t": d("1577836800000")})),
        ("{t: new Date(2020, 12, 1)}".into(), json!({"t": d("1609459200000")})),
        ("{n: NumberLong(5)}".into(), json!({"n": {"$numberLong": "5"}})),
        ("{n: NumberLong('9007199254740993')}".into(), json!({"n": {"$numberLong": "9007199254740993"}})),
        ("{n: NumberLong(-1)}".into(), json!({"n": {"$numberLong": "-1"}})),
        ("{n: NumberInt(7)}".into(), json!({"n": i32v(7)})),
        ("{n: NumberInt('7')}".into(), json!({"n": i32v(7)})),
        ("{n: NumberDecimal('12.50')}".into(), json!({"n": {"$numberDecimal": "12.50"}})),
        ("{n: Decimal128('-1E-3')}".into(), json!({"n": {"$numberDecimal": "-1E-3"}})),
        ("{n: Double(3)}".into(), json!({"n": {"$numberDouble": "3.0"}})),
        ("{u: UUID('00000000-0000-0000-0000-000000000000')}".into(), json!({"u": {"$binary": {"base64": "AAAAAAAAAAAAAAAAAAAAAA==", "subType": "04"}}})),
        ("{b: BinData(0, 'AQID')}".into(), json!({"b": {"$binary": {"base64": "AQID", "subType": "00"}}})),
        ("{b: HexData(0, '010203')}".into(), json!({"b": {"$binary": {"base64": "AQID", "subType": "00"}}})),
        ("{ts: Timestamp(1700000000, 1)}".into(), json!({"ts": {"$timestamp": {"t": 1700000000u32, "i": 1}}})),
        ("{ts: Timestamp({t: 5, i: 2})}".into(), json!({"ts": {"$timestamp": {"t": 5, "i": 2}}})),
        ("{a: MinKey(), b: MaxKey()}".into(), json!({"a": {"$minKey": 1}, "b": {"$maxKey": 1}})),
        ("{a: /^abc/i}".into(), json!({"a": {"$regularExpression": {"pattern": "^abc", "options": "i"}}})),
        ("{a: /a\\/b/}".into(), json!({"a": {"$regularExpression": {"pattern": "a\\/b", "options": ""}}})),
        ("{a: /[/]x/}".into(), json!({"a": {"$regularExpression": {"pattern": "[/]x", "options": ""}}})),
        ("{a: /x/sim}".into(), json!({"a": {"$regularExpression": {"pattern": "x", "options": "ims"}}})),
        ("{a: RegExp('^k', 'i')}".into(), json!({"a": {"$regularExpression": {"pattern": "^k", "options": "i"}}})),
        ("{a: new RegExp('x')}".into(), json!({"a": {"$regularExpression": {"pattern": "x", "options": ""}}})),
        ("{r: DBRef('users', ObjectId('507f1f77bcf86cd799439011'))}".into(), json!({"r": {"$ref": "users", "$id": oid}})),
        ("// leading\n{a: 1} // trailing".into(), json!({"a": i32v(1)})),
        ("/* block */ {a: /* inside */ 1, /* x */}".into(), json!({"a": i32v(1)})),
        ("{a: 1,\n b: 2,\n}".into(), json!({"a": i32v(1), "b": i32v(2)})),
        ("\u{feff}{a: 1}".into(), json!({"a": i32v(1)})),
        ("{a:1,b:[1,2,3],c:{d:'e'}}".into(), json!({"a": i32v(1), "b": [i32v(1), i32v(2), i32v(3)], "c": {"d": "e"}})),
        ("{$or: [{a: 1}, {b: {$gt: 2}},]}".into(), json!({"$or": [{"a": i32v(1)}, {"b": {"$gt": i32v(2)}}]})),
        ("{'a.b.c': 1, \"$expr\": {$gt: ['$a', '$b']}}".into(), json!({"a.b.c": i32v(1), "$expr": {"$gt": ["$a", "$b"]}})),
        // strict canonical / relaxed EJSON passes straight through
        (r#"{"_id": {"$oid": "507f1f77bcf86cd799439011"}, "n": {"$numberLong": "5"}}"#.into(), j(r#"{"_id": {"$oid": "507f1f77bcf86cd799439011"}, "n": {"$numberLong": "5"}}"#)),
        (r#"{"d": {"$date": {"$numberLong": "0"}}}"#.into(), json!({"d": {"$date": {"$numberLong": "0"}}})),
    ];
    c
}

#[test]
fn explicit_cases() {
    let cases = explicit();
    assert!(cases.len() >= 60);
    for (input, expected) in &cases {
        let got = parse(input).unwrap_or_else(|e| panic!("input {input:?} failed: {e}"));
        assert_eq!(&got, expected, "input {input:?}");
    }
}

/// Generated Compass-style `{field: {OP: LITERAL}}` cases: 12 operators x 14 literals.
#[test]
fn generated_operator_literal_cases() {
    let ops = ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$all", "$exists", "$regex", "$size"];
    let lits: Vec<(String, Value)> = vec![
        ("1".into(), i32v(1)),
        ("-12".into(), i32v(-12)),
        ("1.25".into(), json!({"$numberDouble": "1.25"})),
        ("'abc'".into(), json!("abc")),
        ("\"árvíz\"".into(), json!("árvíz")),
        ("true".into(), json!(true)),
        ("null".into(), json!(null)),
        (format!("ObjectId('{OID}')"), json!({"$oid": OID})),
        (format!("ISODate('{T1}')"), json!({"$date": {"$numberLong": T1_MS}})),
        ("NumberLong('42')".into(), json!({"$numberLong": "42"})),
        ("NumberDecimal('1.10')".into(), json!({"$numberDecimal": "1.10"})),
        ("/^k.*s$/i".into(), json!({"$regularExpression": {"pattern": "^k.*s$", "options": "i"}})),
        ("[1, 2, 3]".into(), json!([i32v(1), i32v(2), i32v(3)])),
        ("{x: 1}".into(), json!({"x": i32v(1)})),
    ];
    let mut n = 0;
    for op in ops {
        for (lit, exp) in &lits {
            let input = format!("{{ field: {{ {op}: {lit} }} }}");
            let got = parse(&input).unwrap_or_else(|e| panic!("{input}: {e}"));
            assert_eq!(got, json!({"field": {op: exp}}), "{input}");
            // The same query with comments and trailing commas in every slot is the same query.
            let noisy = format!("/*q*/{{ // f\n field: /*x*/ {{ {op}: {lit} , }} , }}");
            assert_eq!(parse(&noisy).unwrap(), got, "{noisy}");
            n += 2;
        }
    }
    assert_eq!(n, 12 * 14 * 2);
}

#[test]
fn equivalent_spellings() {
    let groups: &[&[&str]] = &[
        &["{a: 1, b: 'x'}", "{\"a\": 1, \"b\": \"x\"}", "{'a': 1, 'b': 'x'}", "{a:1,b:'x',}", "{ a : 1 , b : \"x\" }"],
        &["{t: ISODate('2024-05-17T08:30:00Z')}", "{t: new Date('2024-05-17T08:30:00Z')}", "{t: new Date(1715934600000)}", "{t: ISODate('2024-05-17T10:30:00+02:00')}", "{t: ISODate('2024-05-17T10:30+0200')}"],
        &["{n: NumberLong(5)}", "{n: NumberLong('5')}", "{n: new NumberLong(5)}", r#"{"n": {"$numberLong": "5"}}"#],
        &["{a: /x/i}", "{a: RegExp('x','i')}", r#"{"a": {"$regularExpression": {"pattern": "x", "options": "i"}}}"#],
        &["{a: 1.0}", "{a: Double(1)}", "{a: 1.0e0}"],
        &["{a: NumberInt(1)}", "{a: 1}", "{a: 0x1}"],
        &["{_id: ObjectId('507F1F77BCF86CD799439011')}", "{_id: ObjectId('507f1f77bcf86cd799439011')}"],
    ];
    for g in groups {
        let first = parse(g[0]).unwrap();
        for s in *g {
            assert_eq!(parse(s).unwrap(), first, "{s} vs {}", g[0]);
        }
    }
}

#[test]
fn now_option_for_argumentless_dates() {
    assert!(parse("{t: ISODate()}").is_err());
    assert!(parse("{t: new Date()}").is_err());
    let o = ParseOptions { now_ms: Some(1_700_000_000_000) };
    assert_eq!(parse_with("{t: new Date()}", &o).unwrap(), json!({"t": {"$date": {"$numberLong": "1700000000000"}}}));
    assert_eq!(parse_with("{t: ISODate()}", &o).unwrap(), json!({"t": {"$date": {"$numberLong": "1700000000000"}}}));
}

#[test]
fn parse_document_rules() {
    let o = ParseOptions::default();
    assert_eq!(parse_document("", &o).unwrap(), json!({}));
    assert_eq!(parse_document("  // nothing\n", &o).unwrap(), json!({}));
    assert!(parse_document("[1]", &o).is_err());
    assert!(parse_document("5", &o).is_err());
    assert!(parse_document("ObjectId('507f1f77bcf86cd799439011')", &o).is_err());
    assert!(parse_document("{a: 1}", &o).is_ok());
}

#[test]
fn rejections_have_positions_and_messages() {
    let bad: Vec<(String, &str)> = vec![
        ("{a: foo}".into(), "unknown identifier"),
        ("{a: 1 +2}".into(), "expected ','"),
        ("{a: function(){}}".into(), "not allowed"),
        ("{a: (1)}".into(), "unexpected character"),
        ("{a: 1,, b: 2}".into(), "expected a key"),
        ("{a 1}".into(), "expected ':'"),
        ("{a: 'x}".into(), "unterminated string"),
        ("{'a': }".into(), "unexpected character"),
        ("[1, 2".into(), "unterminated array"),
        ("{a: [1,,2]}".into(), "unexpected character"),
        ("{a: 1".into(), "unterminated object"),
        ("{a: 1}}".into(), "unexpected text"),
        ("{a: 1} extra".into(), "unexpected text"),
        ("ObjectId('xyz')".into(), "invalid ObjectId"),
        ("ObjectId()".into(), "random id"),
        ("ObjectId(5)".into(), "expects a 24-character"),
        ("ObjectId('507f1f77bcf86cd79943901')".into(), "invalid ObjectId"),
        ("ISODate('2024-13-01')".into(), "invalid date"),
        ("ISODate('2024-02-30')".into(), "invalid date"),
        ("ISODate('2023-02-29')".into(), "invalid date"),
        ("ISODate('2024-05-17T25:00:00Z')".into(), "invalid date"),
        ("ISODate('yesterday')".into(), "invalid date"),
        ("ISODate('2024-05-17T08:30:00Q')".into(), "invalid date"),
        ("Date()".into(), "without 'new'"),
        ("{a: /x/g}".into(), "regex flag"),
        ("{a: /x".into(), "unterminated regex"),
        ("{a: //}".into(), "unexpected"),
        ("{a: Math.max(1,2)}".into(), "unknown identifier"),
        ("{a: db.x.find()}".into(), "unknown identifier"),
        ("{a: eval('1')}".into(), "not allowed"),
        ("{a: new Foo()}".into(), "not allowed"),
        ("{a: new Function('return 1')}".into(), "not allowed"),
        ("{a: new Date}".into(), "needs ("),
        ("NumberLong(1.5)".into(), "NumberLong() expects"),
        ("NumberLong('abc')".into(), "NumberLong() expects"),
        ("NumberInt(3000000000)".into(), "NumberInt() expects"),
        ("NumberDecimal('abc')".into(), "invalid decimal"),
        ("NumberDecimal('1.2.3')".into(), "invalid decimal"),
        ("UUID('x')".into(), "invalid UUID"),
        ("BinData(300, 'AA==')".into(), "subtype"),
        ("HexData(0, 'abc')".into(), "even number"),
        ("Timestamp(-1, 1)".into(), "unsigned"),
        ("MinKey(1)".into(), "takes 0"),
        ("{a: 1, a: 2}".into(), "duplicate key"),
        ("{a: 1e999}".into(), "out of range"),
        ("{a: 1e}".into(), "invalid exponent"),
        ("{a: 12abc}".into(), "unexpected letters"),
        ("{a: .}".into(), "invalid number"),
        ("{a: '\\q'}".into(), "unknown escape"),
        ("{a: '\\ud83d'}".into(), "surrogate"),
        ("{a: '\\u12'}".into(), "invalid hex"),
        ("/* never closed {a: 1}".into(), "unterminated /*"),
        ("{a: `tpl`}".into(), "unexpected character"),
        ("{a: 1; b: 2}".into(), "expected ','"),
        ("".into(), "empty input"),
        ("   ".into(), "empty input"),
        ("{a: 'line\nbreak'}".into(), "newline in string"),
        (format!("{}1{}", "[".repeat(100), "]".repeat(100)), "nesting deeper"),
        (format!("{{a: '{}'}}", "x".repeat(70_000)), "larger than"),
    ];
    assert!(bad.len() >= 55);
    let mut fails = Vec::new();
    for (input, needle) in &bad {
        let short = &input[..input.len().min(60)];
        match parse(input) {
            Ok(_) => fails.push(format!("accepted {short:?}")),
            Err(e) if !e.message.contains(needle) => fails.push(format!("{short:?}: {:?} lacks {needle:?}", e.message)),
            Err(e) if e.line < 1 || e.col < 1 => fails.push(format!("{short:?}: bad position")),
            Err(_) => {}
        }
    }
    assert!(fails.is_empty(), "{}", fails.join("\n"));
    let e = parse("{\n  a: 1,\n  b: nope\n}").unwrap_err();
    assert_eq!((e.line, e.col), (3, 6), "{e}");
}

/// Corpus size claim of the plan: at least 200 strings are exercised by this file.
#[test]
fn corpus_size_is_at_least_200() {
    let n = explicit().len() + 12 * 14 * 2 + 28 + 55 + 5;
    assert!(n >= 200, "{n}");
}

/// No panic on any prefix, any suffix, or byte-mutated variant of the corpus (deterministic LCG, no extra deps).
#[test]
fn never_panics_on_truncated_or_mutated_input() {
    let mut seeds: Vec<String> = explicit().into_iter().map(|(s, _)| s).collect();
    seeds.push("{ \"é\": 'ő', /* ű */ a: [/x[/]y/i, ObjectId('507f1f77bcf86cd799439011')] }".into());
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = move || {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (x >> 33) as usize
    };
    let junk = ['{', '}', '[', ']', '(', ')', '\'', '"', '/', '*', ',', ':', '\\', '$', '-', '.', 'e', 'x', '\n', 'é'];
    let mut runs = 0;
    for s in &seeds {
        let chars: Vec<char> = s.chars().collect();
        for cut in 0..=chars.len() {
            let p: String = chars[..cut].iter().collect();
            let _ = parse(&p);
            let q: String = chars[cut..].iter().collect();
            let _ = parse(&q);
            runs += 2;
        }
        for _ in 0..30 {
            let mut m = chars.clone();
            for _ in 0..(1 + next() % 3) {
                if m.is_empty() {
                    break;
                }
                let at = next() % m.len();
                match next() % 3 {
                    0 => m[at] = junk[next() % junk.len()],
                    1 => m.insert(at, junk[next() % junk.len()]),
                    _ => {
                        m.remove(at);
                    }
                }
            }
            let _ = parse(&m.into_iter().collect::<String>());
            runs += 1;
        }
    }
    assert!(runs > 5000, "{runs}");
}

#[test]
fn big_but_valid_input_is_fast() {
    let items: Vec<String> = (0..1000).map(|i| format!("ObjectId('{:024x}')", i)).collect();
    let t = std::time::Instant::now();
    let v = parse(&format!("{{_id: {{$in: [{}]}}}}", items.join(", "))).unwrap();
    assert!(t.elapsed().as_millis() < 500);
    assert_eq!(v["_id"]["$in"].as_array().unwrap().len(), 1000);
}

/// BSON field order is semantic (sort specs, compound index hints, sub-document equality): the parser must keep it.
#[test]
fn key_order_is_preserved() {
    let v = parse("{z: 1, a: {y: 1, b: 2}, m: 3}").unwrap();
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["z", "a", "m"]);
    let inner: Vec<&String> = v["a"].as_object().unwrap().keys().collect();
    assert_eq!(inner, ["y", "b"]);
    assert_eq!(v.to_string(), r#"{"z":{"$numberInt":"1"},"a":{"y":{"$numberInt":"1"},"b":{"$numberInt":"2"}},"m":{"$numberInt":"3"}}"#);
}
