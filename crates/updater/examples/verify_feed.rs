//! Offline verifier used by the release scripts ((design notes: updater-spec) 4.2, 10.6, U11/U17).
//!
//!   verify_feed feed <feed.json> <feed.json.sig> [--channel stable|alpha]
//!   verify_feed file <file> <file.sig> --name <expected file name> [--version <semver>]
//!
//! Keys: the embedded `TRUSTED_KEYS`. In debug builds only, `--key feed|standby|artifact=<tauri .pub file>`
//! (repeatable) replaces the set with throwaway keys, and `--allow-legacy` accepts `Ed` signatures.
//!
//! Prints one JSON line and exits 0 when everything verified, otherwise prints the error code and
//! exits 1 (2 for a usage error). A feed is also parsed and its `seq`, channel, URLs and the
//! trusted-comment `version:` binding are checked.

use std::process::ExitCode;

use intely_updater::endpoints::Endpoints;
use intely_updater::feed::Feed;
use intely_updater::keys::{decode_public, KeySet, Revocations, Role, TrustedKey};
use intely_updater::verify::{self, VerifyPolicy};
use intely_updater::version::{self, Channel};
use intely_updater::ErrorCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(Failure::Usage(m)) => {
            eprintln!("verify_feed: {m}");
            ExitCode::from(2)
        }
        Err(Failure::Code(c)) => {
            println!("{}", serde_json::json!({ "ok": false, "code": c.as_str() }));
            ExitCode::FAILURE
        }
    }
}

enum Failure {
    Usage(String),
    Code(ErrorCode),
}

impl From<ErrorCode> for Failure {
    fn from(c: ErrorCode) -> Self {
        Failure::Code(c)
    }
}

fn usage(m: &str) -> Failure {
    Failure::Usage(m.to_string())
}

fn opt(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn key_set(args: &[String]) -> Result<(KeySet, VerifyPolicy), Failure> {
    let overrides: Vec<&String> = args.iter().enumerate().filter(|(i, a)| *a == "--key" && *i + 1 < args.len()).map(|(i, _)| &args[i + 1]).collect();
    if overrides.is_empty() && !args.iter().any(|a| a == "--allow-legacy") {
        let keys = KeySet::production();
        keys.check_configured()?;
        return Ok((keys, VerifyPolicy::PRODUCTION));
    }
    if !cfg!(debug_assertions) {
        return Err(usage("--key and --allow-legacy exist only in debug builds"));
    }
    let mut keys = Vec::new();
    for o in overrides {
        let (role, path) = o.split_once('=').ok_or_else(|| usage("--key role=file"))?;
        let role = match role {
            "feed" => Role::Feed,
            "standby" => Role::FeedStandby,
            "artifact" => Role::Artifact,
            _ => return Err(usage("role must be feed, standby or artifact")),
        };
        let text = std::fs::read_to_string(path).map_err(|e| Failure::Usage(format!("{path}: {e}")))?;
        let (_, id) = decode_public(text.trim())?;
        keys.push(TrustedKey { id: id.into(), public_b64: text.trim().to_string().into(), role });
    }
    let mut policy = VerifyPolicy::PRODUCTION;
    if args.iter().any(|a| a == "--allow-legacy") {
        policy = VerifyPolicy::TEST_LENIENT;
    }
    Ok((KeySet::new(keys), policy))
}

fn run(args: &[String]) -> Result<String, Failure> {
    let (mode, a, b) = match (args.first(), args.get(1), args.get(2)) {
        (Some(m), Some(a), Some(b)) => (m.as_str(), a, b),
        _ => return Err(usage("usage: verify_feed feed|file <file> <sig> [options]")),
    };
    let data = std::fs::read(a).map_err(|e| Failure::Usage(format!("{a}: {e}")))?;
    let sig = std::fs::read_to_string(b).map_err(|e| Failure::Usage(format!("{b}: {e}")))?;
    let (keys, policy) = key_set(args)?;
    let revoked = Revocations::new();
    match mode {
        "feed" => {
            let channel = match opt(args, "--channel") {
                Some(c) => Channel::parse(&c).ok_or_else(|| usage("channel must be stable or alpha"))?,
                None => Channel::Stable,
            };
            let v = verify::verify_feed(&keys, &revoked, policy, &data, &sig, channel)?;
            let feed = Feed::parse(&data, channel, &Endpoints::production())?;
            v.check_version(&feed.version, policy)?;
            Ok(serde_json::json!({ "ok": true, "keyId": v.key_id, "role": format!("{:?}", v.role),
                "channel": channel.as_str(), "version": feed.version.to_string(), "seq": feed.seq })
            .to_string())
        }
        "file" => {
            let name = opt(args, "--name").ok_or_else(|| usage("--name is required"))?;
            let v = verify::verify_artifact(&keys, &revoked, policy, &data, &sig, &name)?;
            if let Some(ver) = opt(args, "--version") {
                let ver = version::parse_strict(&ver)?;
                v.check_version(&ver, policy)?;
            }
            Ok(serde_json::json!({ "ok": true, "keyId": v.key_id, "role": format!("{:?}", v.role),
                "file": v.comment.file, "sha256": verify::sha256_hex(&data) })
            .to_string())
        }
        _ => Err(usage("mode must be feed or file")),
    }
}
