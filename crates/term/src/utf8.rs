//! A pty delivers bytes in arbitrary chunks, so a multi-byte character can be split across two reads.

/// Turns a byte stream into strings without cutting characters: an incomplete tail waits for the next chunk,
/// invalid bytes become U+FFFD.
#[derive(Default)]
pub struct Utf8Carry(Vec<u8>);

impl Utf8Carry {
    pub fn decode(&mut self, bytes: &[u8]) -> String {
        self.0.extend_from_slice(bytes);
        let mut out = String::with_capacity(self.0.len());
        let mut rest = self.0.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    rest = &[];
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).expect("validated prefix"));
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &after[n..];
                        }
                        None => {
                            rest = after;
                            break;
                        }
                    }
                }
            }
        }
        let keep = rest.to_vec();
        self.0 = keep;
        out
    }

    /// The end of the stream: whatever incomplete bytes are left.
    pub fn finish(&mut self) -> String {
        String::from_utf8_lossy(&std::mem::take(&mut self.0)).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_split_character_is_joined_across_chunks() {
        let bytes = "árvíz".as_bytes();
        let mut c = Utf8Carry::default();
        assert_eq!(c.decode(&bytes[..1]), "");
        assert_eq!(c.decode(&bytes[1..5]), "árv");
        assert_eq!(c.decode(&bytes[5..]), "íz");
        assert_eq!(c.finish(), "");
    }

    #[test]
    fn invalid_bytes_are_replaced_and_a_dangling_tail_is_flushed_lossily() {
        let mut c = Utf8Carry::default();
        assert_eq!(c.decode(b"a\xffb\xc3"), "a\u{FFFD}b");
        assert_eq!(c.finish(), "\u{FFFD}");
    }
}
