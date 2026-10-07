//! `.app.tar.gz` fixtures and the hostile variants ((design notes: updater-spec) 10.1). The raw writer
//! below builds headers byte by byte, so it can express archives that `tar::Builder` refuses
//! (`..`, absolute paths, NUL, device nodes, lying sizes).
use std::io::Write;
use std::path::Path;

use flate2::write::GzEncoder;
use flate2::Compression;

pub struct RawTar {
    buf: Vec<u8>,
}

pub const DIR: u8 = b'5';
pub const FILE: u8 = b'0';
pub const SYMLINK: u8 = b'2';
pub const HARDLINK: u8 = b'1';
pub const CHAR: u8 = b'3';
pub const BLOCK: u8 = b'4';
pub const FIFO: u8 = b'6';

fn header(name: &[u8], typ: u8, mode: u32, size: u64, link: &[u8]) -> [u8; 512] {
    let mut h = tar::Header::new_gnu();
    {
        let old = h.as_old_mut();
        assert!(name.len() <= 100 && link.len() <= 100, "use long_name / pax for long values");
        old.name[..name.len()].copy_from_slice(name);
        old.linkname[..link.len()].copy_from_slice(link);
    }
    h.set_mode(mode);
    h.set_size(size);
    h.set_uid(0);
    h.set_gid(0);
    h.set_mtime(0);
    h.set_entry_type(tar::EntryType::new(typ));
    h.set_cksum();
    *h.as_bytes()
}

impl RawTar {
    pub fn new() -> RawTar {
        RawTar { buf: Vec::new() }
    }

    fn pad(&mut self) {
        let rem = self.buf.len() % 512;
        if rem != 0 {
            self.buf.resize(self.buf.len() + 512 - rem, 0);
        }
    }

    /// Raw entry. `size_claim` is written into the header; `data` is what follows (may be shorter or
    /// longer than the claim to build lying archives).
    pub fn entry(&mut self, name: &[u8], typ: u8, mode: u32, size_claim: u64, link: &[u8], data: &[u8]) -> &mut Self {
        if name.len() > 100 {
            self.long_name(name);
        }
        let short = if name.len() > 100 { &name[..100] } else { name };
        self.buf.extend_from_slice(&header(short, typ, mode, size_claim, link));
        self.buf.extend_from_slice(data);
        self.pad();
        self
    }

    pub fn long_name(&mut self, name: &[u8]) -> &mut Self {
        let mut data = name.to_vec();
        data.push(0);
        self.buf.extend_from_slice(&header(b"././@LongLink", b'L', 0, data.len() as u64, b""));
        self.buf.extend_from_slice(&data);
        self.pad();
        self
    }

    pub fn long_link(&mut self, link: &[u8]) -> &mut Self {
        let mut data = link.to_vec();
        data.push(0);
        self.buf.extend_from_slice(&header(b"././@LongLink", b'K', 0, data.len() as u64, b""));
        self.buf.extend_from_slice(&data);
        self.pad();
        self
    }

    /// A pax extended header (`x`, or `g` when `global`) with the given records.
    pub fn pax(&mut self, records: &[(&str, &[u8])], global: bool) -> &mut Self {
        let mut data = Vec::new();
        for (k, v) in records {
            let body_len = 1 + k.len() + 1 + v.len() + 1; // " k=v\n"
            let mut total = body_len + 1;
            loop {
                let digits = total.to_string().len();
                if digits + body_len == total {
                    break;
                }
                total = digits + body_len;
            }
            data.extend_from_slice(format!("{total} {k}=").as_bytes());
            data.extend_from_slice(v);
            data.push(b'\n');
        }
        let typ = if global { b'g' } else { b'x' };
        self.buf.extend_from_slice(&header(b"PaxHeader", typ, 0, data.len() as u64, b""));
        self.buf.extend_from_slice(&data);
        self.pad();
        self
    }

    pub fn dir(&mut self, name: &str, mode: u32) -> &mut Self {
        self.entry(name.as_bytes(), DIR, mode, 0, b"", b"")
    }

    pub fn file(&mut self, name: &str, mode: u32, data: &[u8]) -> &mut Self {
        self.entry(name.as_bytes(), FILE, mode, data.len() as u64, b"", data)
    }

    pub fn symlink(&mut self, name: &str, target: &str) -> &mut Self {
        self.entry(name.as_bytes(), SYMLINK, 0o755, 0, target.as_bytes(), b"")
    }

    pub fn raw_block(&mut self, block: [u8; 512]) -> &mut Self {
        self.buf.extend_from_slice(&block);
        self
    }

    pub fn finish(&self) -> Vec<u8> {
        let mut v = self.buf.clone();
        v.resize(v.len() + 1024, 0);
        v
    }

    /// The archive without the end-of-archive blocks, gzip compressed.
    pub fn gz_unterminated(&self) -> Vec<u8> {
        gz(&self.buf)
    }

    pub fn gz(&self) -> Vec<u8> {
        gz(&self.finish())
    }
}

pub fn gz(bytes: &[u8]) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::fast());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

/// A path of exactly `n` bytes starting with `top` (components of at most 100 bytes).
pub fn path_of_len(top: &str, n: usize) -> String {
    let mut p = top.to_string();
    while p.len() < n {
        let room = n - p.len() - 1;
        assert!(room >= 1, "cannot reach the exact length");
        let mut comp = room.min(100);
        if room - comp == 1 {
            comp -= 1; // never leave a single byte that cannot hold "/x"
        }
        p.push('/');
        p.push_str(&"a".repeat(comp));
    }
    p
}

/// Tars a directory tree with `top` as the single top-level directory, symlinks kept as symlinks.
pub fn tar_dir_gz(dir: &Path, top: &str) -> Vec<u8> {
    let mut b = tar::Builder::new(Vec::new());
    b.follow_symlinks(false);
    b.append_dir_all(top, dir).unwrap();
    gz(&b.into_inner().unwrap())
}

/// A small valid bundle-shaped archive without code signing: Info.plist-less, for the stage tests.
pub fn simple_app_tar(top: &str) -> Vec<u8> {
    let mut t = RawTar::new();
    t.dir(&format!("{top}/"), 0o755)
        .dir(&format!("{top}/Contents/"), 0o755)
        .file(&format!("{top}/Contents/Info.plist"), 0o644, b"<plist/>")
        .dir(&format!("{top}/Contents/MacOS/"), 0o755)
        .file(&format!("{top}/Contents/MacOS/Exe"), 0o755, b"#!/bin/sh\nexit 0\n")
        .dir(&format!("{top}/Contents/Frameworks/F.framework/Versions/A/"), 0o755)
        .file(&format!("{top}/Contents/Frameworks/F.framework/Versions/A/F"), 0o755, b"framework")
        .symlink(&format!("{top}/Contents/Frameworks/F.framework/Versions/Current"), "A")
        .symlink(&format!("{top}/Contents/Frameworks/F.framework/F"), "Versions/Current/F");
    t.gz()
}
