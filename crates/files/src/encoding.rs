//! Single-byte legacy encodings for Hungarian (and other Central European) files, without a new dependency:
//! ISO-8859-2 and Windows-1250 as 128-entry tables, plus the guess used when a file is not valid UTF-8.
//! Every byte maps to a code point and back, so a file opened and saved in the same encoding is byte-identical
//! (bytes that Windows-1250 leaves undefined map to the C1 control of the same value).

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::types::Encoding;

/// ISO-8859-2, bytes 0xA0..=0xFF. Below 0xA0 the byte is its own code point.
const LATIN2_HIGH: [u16; 96] = [
    0x00A0, 0x0104, 0x02D8, 0x0141, 0x00A4, 0x013D, 0x015A, 0x00A7,
    0x00A8, 0x0160, 0x015E, 0x0164, 0x0179, 0x00AD, 0x017D, 0x017B,
    0x00B0, 0x0105, 0x02DB, 0x0142, 0x00B4, 0x013E, 0x015B, 0x02C7,
    0x00B8, 0x0161, 0x015F, 0x0165, 0x017A, 0x02DD, 0x017E, 0x017C,
    0x0154, 0x00C1, 0x00C2, 0x0102, 0x00C4, 0x0139, 0x0106, 0x00C7,
    0x010C, 0x00C9, 0x0118, 0x00CB, 0x011A, 0x00CD, 0x00CE, 0x010E,
    0x0110, 0x0143, 0x0147, 0x00D3, 0x00D4, 0x0150, 0x00D6, 0x00D7,
    0x0158, 0x016E, 0x00DA, 0x0170, 0x00DC, 0x00DD, 0x0162, 0x00DF,
    0x0155, 0x00E1, 0x00E2, 0x0103, 0x00E4, 0x013A, 0x0107, 0x00E7,
    0x010D, 0x00E9, 0x0119, 0x00EB, 0x011B, 0x00ED, 0x00EE, 0x010F,
    0x0111, 0x0144, 0x0148, 0x00F3, 0x00F4, 0x0151, 0x00F6, 0x00F7,
    0x0159, 0x016F, 0x00FA, 0x0171, 0x00FC, 0x00FD, 0x0163, 0x02D9,
];

/// Windows-1250, bytes 0x80..=0xFF.
const CP1250_HIGH: [u16; 128] = [
    0x20AC, 0x0081, 0x201A, 0x0083, 0x201E, 0x2026, 0x2020, 0x2021,
    0x0088, 0x2030, 0x0160, 0x2039, 0x015A, 0x0164, 0x017D, 0x0179,
    0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x0098, 0x2122, 0x0161, 0x203A, 0x015B, 0x0165, 0x017E, 0x017A,
    0x00A0, 0x02C7, 0x02D8, 0x0141, 0x00A4, 0x0104, 0x00A6, 0x00A7,
    0x00A8, 0x00A9, 0x015E, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x017B,
    0x00B0, 0x00B1, 0x02DB, 0x0142, 0x00B4, 0x00B5, 0x00B6, 0x00B7,
    0x00B8, 0x0105, 0x015F, 0x00BB, 0x013D, 0x02DD, 0x013E, 0x017C,
    0x0154, 0x00C1, 0x00C2, 0x0102, 0x00C4, 0x0139, 0x0106, 0x00C7,
    0x010C, 0x00C9, 0x0118, 0x00CB, 0x011A, 0x00CD, 0x00CE, 0x010E,
    0x0110, 0x0143, 0x0147, 0x00D3, 0x00D4, 0x0150, 0x00D6, 0x00D7,
    0x0158, 0x016E, 0x00DA, 0x0170, 0x00DC, 0x00DD, 0x0162, 0x00DF,
    0x0155, 0x00E1, 0x00E2, 0x0103, 0x00E4, 0x013A, 0x0107, 0x00E7,
    0x010D, 0x00E9, 0x0119, 0x00EB, 0x011B, 0x00ED, 0x00EE, 0x010F,
    0x0111, 0x0144, 0x0148, 0x00F3, 0x00F4, 0x0151, 0x00F6, 0x00F7,
    0x0159, 0x016F, 0x00FA, 0x0171, 0x00FC, 0x00FD, 0x0163, 0x02D9,
];

/// First byte of the table and the table itself, or `None` for Latin-1 (identity) and the Unicode encodings.
fn table_of(enc: Encoding) -> Option<(u8, &'static [u16])> {
    match enc {
        Encoding::Latin2 => Some((0xA0, &LATIN2_HIGH)),
        Encoding::Windows1250 => Some((0x80, &CP1250_HIGH)),
        _ => None,
    }
}

pub(crate) fn decode_single_byte(bytes: &[u8], enc: Encoding) -> String {
    let table = table_of(enc);
    bytes
        .iter()
        .map(|&b| match table {
            Some((start, t)) if b >= start => char::from_u32(u32::from(t[usize::from(b - start)])).unwrap_or(char::REPLACEMENT_CHARACTER),
            _ => char::from(b),
        })
        .collect()
}

fn reverse(enc: Encoding) -> Option<&'static HashMap<char, u8>> {
    static LATIN2: OnceLock<HashMap<char, u8>> = OnceLock::new();
    static CP1250: OnceLock<HashMap<char, u8>> = OnceLock::new();
    let (cell, (start, table)) = match enc {
        Encoding::Latin2 => (&LATIN2, table_of(enc)?),
        Encoding::Windows1250 => (&CP1250, table_of(enc)?),
        _ => return None,
    };
    Some(cell.get_or_init(|| table.iter().enumerate().filter_map(|(i, &c)| Some((char::from_u32(u32::from(c))?, start + u8::try_from(i).ok()?))).collect()))
}

/// The first character the encoding cannot hold, as the error.
pub(crate) fn encode_single_byte(text: &str, enc: Encoding) -> Result<Vec<u8>, char> {
    let Some(map) = reverse(enc) else {
        return text.chars().map(|c| u8::try_from(u32::from(c)).map_err(|_| c)).collect();
    };
    let start = u32::from(table_of(enc).map_or(0xFF, |(s, _)| s));
    text.chars().map(|c| if u32::from(c) < start { u8::try_from(u32::from(c)).map_err(|_| c) } else { map.get(&c).copied().ok_or(c) }).collect()
}

/// The legacy encoding to try for bytes that are not valid UTF-8 and have no BOM.
/// A byte between 0x80 and 0x9F is a control in ISO-8859-x but a quote, dash or letter in Windows-1250, so it means
/// Windows-1250. Otherwise the Hungarian double-acute letters (o and u with two accents: 0xF5, 0xFB, 0xD5, 0xDB) only
/// exist in ISO-8859-2 (in Latin-1 they are the rare tilde-o and circumflex-u). The remaining Hungarian accents
/// (a e i o u with one accent, o and u with a diaeresis) have the same bytes in all three, so plain Latin-1 reads them.
pub(crate) fn guess_legacy(bytes: &[u8]) -> Encoding {
    if bytes.iter().any(|b| (0x80..0xA0).contains(b)) {
        Encoding::Windows1250
    } else if bytes.iter().any(|b| matches!(b, 0xF5 | 0xFB | 0xD5 | 0xDB)) {
        Encoding::Latin2
    } else {
        Encoding::Latin1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_round_trip_every_byte() {
        for enc in [Encoding::Latin1, Encoding::Latin2, Encoding::Windows1250] {
            let all: Vec<u8> = (0..=255).collect();
            let text = decode_single_byte(&all, enc);
            assert_eq!(text.chars().count(), 256);
            assert_eq!(encode_single_byte(&text, enc).unwrap(), all, "{enc:?}");
        }
    }

    #[test]
    fn hungarian_text_decodes_in_both_legacy_encodings() {
        let text = "\u{e1}rv\u{ed}zt\u{171}r\u{151} t\u{fc}k\u{f6}rf\u{fa}r\u{f3}g\u{e9}p \u{150}\u{170}";
        for enc in [Encoding::Latin2, Encoding::Windows1250] {
            let bytes = encode_single_byte(text, enc).unwrap();
            assert!(bytes.iter().any(|b| *b >= 0x80));
            assert_eq!(decode_single_byte(&bytes, enc), text);
        }
        assert_eq!(encode_single_byte("\u{e1}rv\u{ed}zt\u{171}r\u{151}", Encoding::Latin2).unwrap(), b"\xe1rv\xedzt\xfbr\xf5");
    }

    #[test]
    fn unrepresentable_characters_are_reported() {
        assert_eq!(encode_single_byte("\u{4e2d}", Encoding::Latin2), Err('\u{4e2d}'));
        assert_eq!(encode_single_byte("\u{150}", Encoding::Latin1), Err('\u{150}'));
        assert_eq!(encode_single_byte("\u{20ac}", Encoding::Latin2), Err('\u{20ac}'));
        assert_eq!(encode_single_byte("\u{20ac}", Encoding::Windows1250), Ok(vec![0x80]));
    }

    #[test]
    fn the_guess_follows_the_accented_byte_patterns() {
        assert_eq!(guess_legacy(b"caf\xe9"), Encoding::Latin1);
        assert_eq!(guess_legacy(b"t\xfck\xf6r \xe1rv\xedzt\xfbr\xf5"), Encoding::Latin2);
        assert_eq!(guess_legacy(b"\x93idezet\x94 \xf5"), Encoding::Windows1250);
        assert_eq!(guess_legacy(b"plain ascii"), Encoding::Latin1);
    }
}
