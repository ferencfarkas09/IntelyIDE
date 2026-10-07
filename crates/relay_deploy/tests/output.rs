//! Parsers, classifier and target acceptance against the hand-written fixtures (spec 11.1 `output`, 11.3). The fixtures are replaced
//! by captured outputs after the manual step M1; the parsers ignore unknown fields and fail closed on missing required ones.

use std::fs;
use std::path::Path;

use intely_core::jail::Mode;
use intely_relay_deploy::output::*;

fn fx(name: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap_or_else(|_| panic!("fixture {name}"))
}

fn lines(name: &str) -> Vec<String> {
    fx(name).lines().map(str::to_owned).collect()
}

#[test]
fn whoami_oauth_token_two_accounts_and_logged_out() {
    let w = parse_whoami(&fx("whoami-oauth.json")).unwrap();
    assert!(w.logged_in && w.auth_type == Some(AuthType::Oauth));
    assert_eq!(w.email_hint.as_deref(), Some("a***@e***.test"));
    assert_eq!(w.accounts.len(), 1);
    assert_eq!(w.resolve_account(None, None).unwrap().id, "0123456789abcdef0123456789abcdef");
    assert!(!format!("{w:?}").contains("ada@"), "the address is never kept");

    let t = parse_whoami(&fx("whoami-token.json")).unwrap();
    assert_eq!(t.auth_type, Some(AuthType::Token));
    assert_eq!(t.email_hint, None);
    assert_eq!(t.accounts.len(), 2);
    assert_eq!(t.resolve_account(None, None).unwrap_err().code(), "needsAccount");
    assert_eq!(t.resolve_account(Some("11112222333344445555666677778888"), None).unwrap().name, "Personal");
    assert_eq!(t.resolve_account(Some("deadbeefdeadbeef"), None).unwrap_err().code(), "needsAccount", "not one of the signed-in accounts");
    // token mode: a manual id is accepted when it is shaped like one
    assert_eq!(t.resolve_account(None, Some("aaaabbbbccccddddeeeeffff00001111")).unwrap().name, "Work");
    assert_eq!(t.resolve_account(None, Some("not an id!")).unwrap_err().code(), "needsAccount");

    let out = parse_whoami(&fx("whoami-loggedout.txt")).unwrap();
    assert!(!out.logged_in && out.accounts.is_empty());
    // fail closed on garbage
    assert!(parse_whoami("<html>proxy error</html>").is_err());
    assert!(parse_whoami("[1,2,3]").is_err());
    // unknown fields are ignored; accounts with a bad id are dropped
    let odd = parse_whoami(r#"{"loggedIn":true,"authType":"OAuth Token","accounts":[{"id":"x y","name":"bad"},{"id":"0123456789abcdef0123456789abcdef","name":"ok\u0007"}],"future":{}}"#).unwrap();
    assert_eq!(odd.accounts.len(), 1);
    assert_eq!(odd.accounts[0].name, "ok");
}

#[test]
fn account_tail_is_four_characters() {
    assert_eq!(account_tail("0123456789abcdef0123456789abcdef"), "cdef");
    assert_eq!(account_tail("ab"), "ab");
}

#[test]
fn deploy_ndjson_ok_failed_and_custom_domain() {
    let ok = parse_deploy_ndjson(&fx("deploy-ok.ndjson")).unwrap();
    assert_eq!(ok.worker_name, "intely-relay-0123456789ab");
    assert_eq!(ok.version_id.as_deref(), Some("11111111-2222-3333-4444-555555555555"));
    assert_eq!(ok.targets, vec!["https://intely-relay-0123456789ab.my-sub.workers.dev".to_owned()]);
    let custom = parse_deploy_ndjson(&fx("deploy-custom-domain.ndjson")).unwrap();
    assert_eq!(custom.targets, vec!["https://relay.example.com".to_owned()]);
    let e = parse_deploy_ndjson(&fx("deploy-failed.ndjson")).unwrap_err();
    assert_eq!(e.code(), "deployFailed");
    assert!(e.to_string().contains("10000"));
    assert!(parse_deploy_ndjson("").is_err());
    assert!(parse_deploy_ndjson("not json\n{\"type\":\"deploy\"}\n").is_err(), "a deploy line without a worker name is not a result");
    // the LAST deploy line wins, and a later failure line cancels an earlier success
    let two = format!("{}{}", fx("deploy-ok.ndjson"), fx("deploy-custom-domain.ndjson"));
    assert_eq!(parse_deploy_ndjson(&two).unwrap().worker_name, "relay");
    let then_failed = format!("{}{}", fx("deploy-ok.ndjson"), fx("deploy-failed.ndjson"));
    assert!(parse_deploy_ndjson(&then_failed).is_err());
}

#[test]
fn accept_target_table() {
    let name = "intely-relay-0123456789ab";
    let good = format!("https://{name}.my-sub.workers.dev");
    let t = accept_target(&good, name, None, Mode::Off).unwrap();
    assert_eq!(t.ws_base, format!("wss://{name}.my-sub.workers.dev"));
    assert_eq!(t.http_base, good);
    assert_eq!(t.host, format!("{name}.my-sub.workers.dev"));
    assert!(accept_target(&format!("{good}/"), name, None, Mode::Off).is_ok());
    assert!(accept_target(&good.to_uppercase(), name, None, Mode::Off).is_ok(), "host case is normalised");
    let bad = [
        "https://evil.example".to_owned(),
        format!("http://{name}.my-sub.workers.dev"),
        format!("https://{name}.my-sub.workers.dev:8443"),
        format!("https://user:pw@{name}.my-sub.workers.dev"),
        format!("https://{name}.my-sub.workers.dev/path"),
        format!("https://{name}.my-sub.workers.dev/?q=1"),
        format!("https://{name}.my-sub.workers.dev/#x"),
        format!("https://other-name.my-sub.workers.dev"),
        format!("https://{name}.workers.dev"),
        format!("https://{name}.a.b.workers.dev"),
        format!("https://{name}.my-sub.workers.dev.evil.example"),
        format!("https://evil.{name}.my-sub.workers.dev"),
        format!("https://{name}.-bad.workers.dev"),
        "https://127.0.0.1".to_owned(),
        "https://[::1]".to_owned(),
        "javascript:alert(1)".to_owned(),
        "not a url".to_owned(),
        String::new(),
    ];
    for b in &bad {
        assert!(accept_target(b, name, None, Mode::Off).is_err(), "{b:?} must be refused");
    }
    // loopback http only in the E2E jail, and only 127.0.0.1 with a port
    assert!(accept_target("http://127.0.0.1:8787", name, None, Mode::Off).is_err());
    assert!(accept_target("http://127.0.0.1:8787", name, None, Mode::ReadOnly).is_err());
    let e2e = accept_target("http://127.0.0.1:8787", name, None, Mode::E2e).unwrap();
    assert_eq!((e2e.http_base.as_str(), e2e.ws_base.as_str()), ("http://127.0.0.1:8787", "ws://127.0.0.1:8787"));
    for b in ["http://127.0.0.1", "http://localhost:8787", "http://[::1]:8787", "http://10.0.0.5:8787", "http://127.0.0.1:8787/x", "http://127.1:8787"] {
        assert!(accept_target(b, name, None, Mode::E2e).is_err(), "{b} must be refused even in E2E");
    }
    // custom domain: exactly the validated one
    assert!(accept_target("https://relay.example.com", name, Some("relay.example.com"), Mode::Off).is_ok());
    assert!(accept_target("https://relay.example.com", name, Some("other.example.com"), Mode::Off).is_err());
    assert!(accept_target("https://relay.example.com", name, None, Mode::Off).is_err());
}

#[test]
fn login_url_only_from_the_cloudflare_dashboard() {
    let u = lines("login-url.txt").iter().find_map(|l| parse_login_url(l)).expect("url");
    assert!(u.starts_with("https://dash.cloudflare.com/oauth2/auth?"));
    assert!(u.contains("state=Zm9vYmFyMTIzNDU2"), "the raw line keeps the values the UI needs");
    for bad in [
        "Opening https://evil.example/oauth2/auth?state=1",
        "Opening https://dash.cloudflare.com.evil.example/x",
        "Opening https://user@dash.cloudflare.com/x",
        "Opening http://dash.cloudflare.com/x",
        "Opening https://dash.cloudflare.com:8443/x",
        "no url here",
    ] {
        assert_eq!(parse_login_url(bad), None, "{bad}");
    }
}

#[test]
fn classifier_table() {
    let k = |name: &str, exit: i32| classify(&lines(name), exit);
    assert_eq!(k("deploy-no-subdomain.txt", 1), ErrorKind::NoSubdomain);
    assert_eq!(k("whoami-loggedout.txt", 1), ErrorKind::NotLoggedIn);
    let l = |s: &str| classify(&[s.to_owned()], 1);
    assert_eq!(l("In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN"), ErrorKind::NotLoggedIn);
    assert_eq!(l("Authentication error [code: 10000]"), ErrorKind::AuthInvalid);
    assert_eq!(l("Your token has expired"), ErrorKind::Other.max_if("token has expired"));
    assert_eq!(l("You do not have permission to perform this action"), ErrorKind::Permission);
    assert_eq!(l("Error: listen EADDRINUSE: address already in use 127.0.0.1:8976"), ErrorKind::LoginPortBusy);
    assert_eq!(l("getaddrinfo ENOTFOUND api.cloudflare.com"), ErrorKind::Network);
    assert_eq!(l("connect ENETUNREACH"), ErrorKind::Offline);
    assert_eq!(l("Too many requests, rate limit exceeded"), ErrorKind::RateLimited);
    assert_eq!(l("You have exceeded your quota"), ErrorKind::Quota);
    assert_eq!(l("Please verify your email address first"), ErrorKind::AccountUnverified);
    assert_eq!(l("something nobody expected"), ErrorKind::Other);
    assert_eq!(classify(&["Authentication error".to_owned()], 0), ErrorKind::Other, "a zero exit is never an error");
    // every kind maps to a spec code
    for kind in [ErrorKind::LoginPortBusy, ErrorKind::NoSubdomain, ErrorKind::AccountUnverified, ErrorKind::RateLimited, ErrorKind::Quota, ErrorKind::Offline, ErrorKind::Network, ErrorKind::NotLoggedIn, ErrorKind::Permission, ErrorKind::AuthInvalid, ErrorKind::NameTaken, ErrorKind::Other] {
        assert!(!kind.code().is_empty());
    }
}

trait MaxIf {
    fn max_if(self, needle: &str) -> ErrorKind;
}
impl MaxIf for ErrorKind {
    /// "token has expired" is one of the AuthInvalid needles.
    fn max_if(self, _needle: &str) -> ErrorKind {
        ErrorKind::AuthInvalid
    }
}

#[test]
fn name_check_classification() {
    let stamp = "0123456789abcdef";
    assert_eq!(classify_name_check(&lines("deployments-list-missing.txt"), 1, stamp), NameCheck::Free);
    assert_eq!(classify_name_check(&lines("deployments-list-mine.txt"), 0, stamp), NameCheck::Mine);
    assert_eq!(classify_name_check(&lines("deployments-list-mine.txt"), 0, "ffffffffffffffff"), NameCheck::Foreign, "someone else's stamp");
    assert_eq!(classify_name_check(&lines("deployments-list-mine.txt"), 0, ""), NameCheck::Foreign, "no stamp, never mine");
    assert_eq!(classify_name_check(&lines("deployments-list-foreign.txt"), 0, stamp), NameCheck::Foreign);
    assert_eq!(classify_name_check(&[], 0, stamp), NameCheck::Unknown);
    assert_eq!(classify_name_check(&["boom".to_owned()], 1, stamp), NameCheck::Unknown);
    assert!(NameCheck::Foreign.needs_overwrite_phrase() && NameCheck::Unknown.needs_overwrite_phrase());
    assert!(!NameCheck::Free.needs_overwrite_phrase() && !NameCheck::Mine.needs_overwrite_phrase());
}
