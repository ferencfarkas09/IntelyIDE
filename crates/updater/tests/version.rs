//! U1: strict semver, channels, architectures, the pure version decision (spec 10.2 `version`).
mod common;

use intely_updater::limits::VERSION_MAX_LEN;
use intely_updater::version::{self, decide, os_at_least, parse_os_version, parse_strict, Arch, Channel, Decision};
use semver::Version;

fn v(s: &str) -> Version {
    parse_strict(s).unwrap()
}

#[test]
fn strict_parse_accepts_plain_semver() {
    for ok in ["0.1.0", "1.2.3", "0.1.1-rc.1", "0.2.0-alpha.3", "10.20.30", "1.0.0-0"] {
        assert!(parse_strict(ok).is_ok(), "{ok}");
    }
}

#[test]
fn strict_parse_rejects_the_rest() {
    let long = format!("1.0.0-{}", "a".repeat(VERSION_MAX_LEN));
    let boundary_ok = format!("1.0.0-{}", "a".repeat(VERSION_MAX_LEN - 6));
    assert_eq!(boundary_ok.len(), VERSION_MAX_LEN);
    assert!(parse_strict(&boundary_ok).is_ok());
    let boundary_bad = format!("1.0.0-{}", "a".repeat(VERSION_MAX_LEN - 5));
    assert_eq!(boundary_bad.len(), VERSION_MAX_LEN + 1);
    for bad in [
        "", "v1.0.0", "V1.0.0", "1.0", "1", "1.0.0+b", "1.0.0-rc.1+b", "01.0.0", "1.00.0", "1.0.00", " 1.0.0", "1.0.0 ", "1.0.0\n",
        "1.0.0-", "1.0.0-01", "1.0.0.0", "-1.0.0", "1.0.0-\u{e9}", "a.b.c", long.as_str(), boundary_bad.as_str(),
    ] {
        assert!(parse_strict(bad).is_err(), "{bad:?} must be rejected");
    }
}

#[test]
fn precedence_table() {
    let order = ["0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-rc.1", "0.1.0", "0.1.1-rc.1", "0.1.1", "0.2.0", "1.0.0"];
    for w in order.windows(2) {
        assert_eq!(v(w[0]).cmp_precedence(&v(w[1])), std::cmp::Ordering::Less, "{} < {}", w[0], w[1]);
    }
}

#[test]
fn downgrade_and_equal_version_are_never_offered() {
    let cur = v("0.1.0");
    assert_eq!(decide(&cur, &v("0.1.1"), None), Decision::Newer);
    assert_eq!(decide(&cur, &v("0.1.0"), None), Decision::UpToDate);
    assert_eq!(decide(&cur, &v("0.0.9"), None), Decision::UpToDate);
    assert_eq!(decide(&cur, &v("0.1.0-rc.1"), None), Decision::UpToDate);
    assert_eq!(decide(&v("0.2.0-alpha.3"), &v("0.1.9"), None), Decision::UpToDate);
    assert_eq!(decide(&v("0.1.0-alpha.1"), &v("0.1.0"), None), Decision::Newer);
}

#[test]
fn a_feed_older_than_the_highest_seen_version_is_up_to_date() {
    let cur = v("0.1.0");
    assert_eq!(decide(&cur, &v("0.1.1"), Some(&v("0.1.2"))), Decision::FeedWentBackwards);
    assert_eq!(decide(&cur, &v("0.1.2"), Some(&v("0.1.2"))), Decision::Newer);
    assert_eq!(decide(&cur, &v("0.1.3"), Some(&v("0.1.2"))), Decision::Newer);
    // not newer than current: plain up to date, the highest-seen rule is not reached
    assert_eq!(decide(&v("0.1.5"), &v("0.1.1"), Some(&v("0.1.2"))), Decision::UpToDate);
}

#[test]
fn stable_forbids_a_pre_release_part() {
    assert!(Channel::Stable.accepts(&v("0.1.0")));
    assert!(!Channel::Stable.accepts(&v("0.1.0-rc.1")));
    assert!(Channel::Alpha.accepts(&v("0.1.0")));
    assert!(Channel::Alpha.accepts(&v("0.1.0-alpha.1")));
}

#[test]
fn channel_assignment_of_a_release() {
    assert_eq!(Channel::channels_for_release(&v("0.1.1")), &[Channel::Stable, Channel::Alpha]);
    assert_eq!(Channel::channels_for_release(&v("0.1.1-rc.1")), &[Channel::Alpha]);
    assert_eq!(Channel::channels_for_release(&v("0.2.0-alpha.3")), &[Channel::Alpha]);
}

#[test]
fn channel_names_round_trip() {
    for c in [Channel::Stable, Channel::Alpha] {
        assert_eq!(Channel::parse(c.as_str()), Some(c));
    }
    for bad in ["", "Stable", "beta", "stable ", "alpha/../x"] {
        assert_eq!(Channel::parse(bad), None, "{bad:?}");
    }
}

#[test]
fn arch_mapping_and_platform_keys() {
    assert_eq!(Arch::X64.token(), "x64");
    assert_eq!(Arch::Aarch64.token(), "aarch64");
    assert_eq!(Arch::X64.platform_key(), "darwin-x86_64");
    assert_eq!(Arch::Aarch64.platform_key(), "darwin-aarch64");
    for a in Arch::ALL {
        assert_eq!(Arch::from_platform_key(a.platform_key()), Some(a));
    }
    assert_eq!(Arch::from_platform_key("darwin-arm64"), None);
    assert_eq!(Arch::from_platform_key("windows-x86_64"), None);
    let cur = Arch::current();
    if cfg!(target_arch = "aarch64") {
        assert_eq!(cur, Arch::Aarch64);
    } else {
        assert_eq!(cur, Arch::X64);
    }
}

#[test]
fn os_version_parsing_and_comparison() {
    assert_eq!(parse_os_version("13.5"), Some(vec![13, 5]));
    assert_eq!(parse_os_version("26"), Some(vec![26]));
    assert_eq!(parse_os_version("15.0.1"), Some(vec![15, 0, 1]));
    for bad in ["", "13.", ".5", "13.5.1.2", "a.b", "13.05", "-1", "13 .5", "99999.1"] {
        assert_eq!(parse_os_version(bad), None, "{bad:?}");
    }
    assert!(os_at_least("13.5", "13.5"));
    assert!(os_at_least("14.0", "13.5"));
    assert!(os_at_least("26.0", "13.5"));
    assert!(os_at_least("13.5.1", "13.5"));
    assert!(!os_at_least("13.4", "13.5"));
    assert!(!os_at_least("12.7.6", "13.5"));
    assert!(!os_at_least("garbage", "13.5"));
    let _ = version::Arch::ALL;
}
