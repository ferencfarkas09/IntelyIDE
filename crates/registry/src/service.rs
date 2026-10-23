//! What the views ask: the status of the registration, registering after the person agreed, the start-up ping, what is stored
//! (`me`), the newsletter choice, and deleting everything. Nothing is requested before the person agreed; a person who said no, or
//! deleted their data, is not asked again by itself. The token is read from the Keychain once and kept in memory until it changes.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use intely_settings::{Object, Secret, SecretStore, SettingsStore};
use serde_json::{json, Value};

use crate::client::{validate_base, Client};
use crate::device;
use crate::types::{Problem, RegisterInput, State, Status, NOTICE, REGISTRY_URL};

const NS: &str = "registry";
const TOKEN_KEY: &str = "registry.token";
/// A ping at most once an hour: the registry counts a start once an hour anyway.
const PING_EVERY_S: u64 = 3600;

pub struct Registry {
    settings: Arc<SettingsStore>,
    secrets: Arc<dyn SecretStore>,
    version: String,
    url: String,
    /// `None` = the Keychain was not asked yet; `Some(None)` = it was and there is no token.
    token: Mutex<Option<Option<Secret>>>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// A random id for a computer whose system gives no machine id; kept in Settings so it stays the same.
fn random_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    (0..4)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(i);
            h.write_u128(nanos);
            format!("{:016x}", h.finish())
        })
        .collect()
}

pub(crate) fn valid_name(name: &str) -> bool {
    let t = name.trim();
    !t.is_empty() && t.chars().count() <= 100 && !t.chars().any(char::is_control)
}

pub(crate) fn valid_email(raw: &str) -> bool {
    let e = raw.trim();
    if e.is_empty() || e.len() > 254 {
        return false;
    }
    let Some((local, domain)) = e.split_once('@') else { return false };
    if local.is_empty() || local.len() > 64 || !local.chars().all(|c| c.is_ascii_alphanumeric() || ".!#$%&'*+/=?^_`{|}~-".contains(c)) {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let label_ok = |l: &str| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let tld = labels[labels.len() - 1];
    labels.iter().all(|l| label_ok(l)) && tld.len() >= 2 && tld.len() <= 24 && tld.chars().all(|c| c.is_ascii_alphabetic())
}

fn token_ok(t: &str) -> bool {
    (20..=128).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Registry {
    pub fn new(settings: Arc<SettingsStore>, secrets: Arc<dyn SecretStore>, app_version: &str) -> Self {
        Self::with_url(settings, secrets, app_version, REGISTRY_URL)
    }

    /// For tests: another address (a loopback server).
    pub fn with_url(settings: Arc<SettingsStore>, secrets: Arc<dyn SecretStore>, app_version: &str, url: &str) -> Self {
        let version: String = app_version.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-')).take(40).collect();
        Self { settings, secrets, version, url: url.trim_end_matches('/').to_owned(), token: Mutex::new(None) }
    }

    fn read(&self) -> Object {
        self.settings.get(NS).unwrap_or_default()
    }

    fn write(&self, patch: Object) -> Result<(), Problem> {
        self.settings.set(NS, patch).map(|_| ()).map_err(|e| Problem::new("settings", e.message))
    }

    fn token(&self) -> Option<Secret> {
        let mut slot = self.token.lock().unwrap_or_else(PoisonError::into_inner);
        slot.get_or_insert_with(|| self.secrets.get(TOKEN_KEY).ok().flatten()).clone()
    }

    fn remember(&self, token: Option<Secret>) {
        *self.token.lock().unwrap_or_else(PoisonError::into_inner) = Some(token);
    }

    fn client(&self) -> Result<Client, Problem> {
        validate_base(&self.url)?;
        Client::new(&self.url)
    }

    pub fn status(&self) -> Status {
        let s = self.read();
        let text = |k: &str| s.get(k).and_then(Value::as_str).map(str::to_owned);
        let state = match s.get("state").and_then(Value::as_str) {
            Some("registered") if self.token().is_some() => State::Registered,
            Some("declined") => State::Declined,
            _ => State::Unasked,
        };
        let consented = text("consentedNotice");
        let needs_consent = match state {
            State::Unasked => true,
            State::Registered => consented.as_deref().map_or(true, |c| c < NOTICE),
            State::Declined => false,
        };
        let registered = state == State::Registered;
        Status {
            state,
            name: text("name").filter(|_| registered),
            email: text("email").filter(|_| registered),
            newsletter: text("newsletter").filter(|_| registered),
            notice: NOTICE.to_owned(),
            consented_notice: consented.filter(|_| registered),
            needs_consent,
            url: self.url.clone(),
        }
    }

    async fn store_token(&self, token: &str) -> Result<(), Problem> {
        let secret = Secret::new(token);
        let (secrets, stored) = (self.secrets.clone(), secret.clone());
        match tokio::task::spawn_blocking(move || secrets.set(TOKEN_KEY, stored)).await {
            Ok(Ok(())) => {
                self.remember(Some(secret));
                Ok(())
            }
            _ => Err(Problem::new("keychain", "The key for this computer could not be saved to the Keychain")),
        }
    }

    async fn drop_token(&self) {
        let secrets = self.secrets.clone();
        let _ = tokio::task::spawn_blocking(move || secrets.remove(TOKEN_KEY)).await;
        self.remember(None);
    }

    /// The person agreed: send the name, the address, the newsletter choice and the details of this computer, keep the token.
    pub async fn register(&self, input: RegisterInput) -> Result<Status, Problem> {
        if !input.consent {
            return Err(Problem::new("noConsent", "Nothing is sent without your agreement"));
        }
        if !valid_name(&input.name) {
            return Err(Problem::new("invalidName", "Enter your name (up to 100 characters)"));
        }
        if !valid_email(&input.email) {
            return Err(Problem::new("invalidEmail", "Enter a valid email address"));
        }
        let client = self.client()?;
        let stored = self.read();
        let local_id = match stored.get("localId").and_then(Value::as_str) {
            Some(id) if id.len() >= 16 => id.to_owned(),
            _ => {
                let id = random_id();
                let mut p = Object::new();
                p.insert("localId".into(), json!(id));
                self.write(p)?;
                id
            }
        };
        let (locale, tz) = (input.locale.clone(), input.tz.clone());
        let device = tokio::task::spawn_blocking(move || device::collect(&locale, &tz, &local_id)).await.map_err(|_| Problem::new("device", "This computer could not be read"))?;
        let body = json!({
            "name": input.name.trim(),
            "email": input.email.trim(),
            "consent": { "storage": true, "newsletter": input.newsletter, "notice": NOTICE },
            "appVersion": self.version,
            "device": device.full_json(),
        });
        let answer = client.send("POST", "/v1/register", None, Some(&body)).await?;
        let token = answer.get("token").and_then(Value::as_str).filter(|t| token_ok(t)).ok_or_else(|| Problem::new("badResponse", "The registry's answer had no key"))?.to_owned();
        self.store_token(&token).await?;
        let mut p = Object::new();
        p.insert("state".into(), json!("registered"));
        p.insert("name".into(), json!(input.name.trim()));
        p.insert("email".into(), json!(input.email.trim().to_ascii_lowercase()));
        p.insert("newsletter".into(), json!(answer.get("newsletter").and_then(Value::as_str).unwrap_or("none")));
        p.insert("consentedNotice".into(), json!(NOTICE));
        p.insert("lastPing".into(), json!(now()));
        p.insert("locale".into(), json!(device::clean_locale(&input.locale)));
        p.insert("tz".into(), json!(device::clean_tz(&input.tz)));
        self.write(p)?;
        Ok(self.status())
    }

    /// "Not now": nothing is sent, and the screen does not come back by itself (Settings has the same choice later).
    pub fn decline(&self) -> Result<Status, Problem> {
        let mut p = Object::new();
        p.insert("state".into(), json!("declined"));
        self.write(p)?;
        Ok(self.status())
    }

    /// The app started: tell the registry which version runs and what the computer looks like now. Only for a registered person who
    /// agreed to the current notice, at most once an hour. A registry that does not know this computer any more (deleted on request,
    /// or by the retention time) is not asked to take it back: the registration ends here.
    pub async fn ping(&self) -> Result<(), Problem> {
        let status = self.status();
        if status.state != State::Registered || status.needs_consent {
            return Ok(());
        }
        let stored = self.read();
        let last = stored.get("lastPing").and_then(Value::as_u64).unwrap_or(0);
        if now().saturating_sub(last) < PING_EVERY_S {
            return Ok(());
        }
        let Some(token) = self.token() else { return Ok(()) };
        let client = self.client()?;
        let local_id = stored.get("localId").and_then(Value::as_str).unwrap_or_default().to_owned();
        // the language and the time zone were sent at registration; the webview is not asked again at every start
        let (locale, tz) = (stored.get("locale").and_then(Value::as_str).unwrap_or("und").to_owned(), stored.get("tz").and_then(Value::as_str).unwrap_or("UTC").to_owned());
        let device = tokio::task::spawn_blocking(move || device::collect(&locale, &tz, &local_id)).await.map_err(|_| Problem::new("device", "This computer could not be read"))?;
        let body = json!({ "appVersion": self.version, "device": device.update_json() });
        match client.send("POST", "/v1/ping", Some(&token), Some(&body)).await {
            Ok(_) => {
                let mut p = Object::new();
                p.insert("lastPing".into(), json!(now()));
                self.write(p)
            }
            Err(e) if e.code == "unknownInstall" => {
                self.drop_token().await;
                self.end_registration()?;
                Err(e)
            }
            Err(e) => Err(e),
        }
    }

    /// Everything the registry stores about this computer and its person, as the registry says it.
    pub async fn me(&self) -> Result<Value, Problem> {
        let token = self.token().ok_or_else(|| Problem::new("notRegistered", "This computer is not registered"))?;
        self.client()?.send("GET", "/v1/me", Some(&token), None).await
    }

    /// Ticks or unticks the newsletter later.
    pub async fn set_newsletter(&self, on: bool) -> Result<Status, Problem> {
        let token = self.token().ok_or_else(|| Problem::new("notRegistered", "This computer is not registered"))?;
        let answer = self.client()?.send("POST", "/v1/newsletter", Some(&token), Some(&json!({ "subscribe": on }))).await?;
        let mut p = Object::new();
        p.insert("newsletter".into(), json!(answer.get("newsletter").and_then(Value::as_str).unwrap_or("none")));
        self.write(p)?;
        Ok(self.status())
    }

    /// Deletes this computer at the registry (and the person with it when it was their last one), then forgets the key here. When
    /// the registry cannot be reached nothing changes, so the person can try again.
    pub async fn forget(&self) -> Result<Status, Problem> {
        if let Some(token) = self.token() {
            match self.client()?.send("POST", "/v1/forget", Some(&token), Some(&json!({}))).await {
                Ok(_) => {}
                Err(e) if e.code == "unknownInstall" => {}
                Err(e) => return Err(e),
            }
        }
        self.drop_token().await;
        self.end_registration()?;
        Ok(self.status())
    }

    /// The registration is over on this computer: the details kept here go, the answer "no" stays.
    fn end_registration(&self) -> Result<(), Problem> {
        let mut p = Object::new();
        p.insert("state".into(), json!("declined"));
        for k in ["name", "email", "newsletter", "consentedNotice", "lastPing", "locale", "tz"] {
            p.insert(k.into(), Value::Null);
        }
        self.write(p)
    }

    /// The notice changed and the person answers: "continue" registers again with the details kept here, "stop" deletes everything.
    pub async fn reconsent(&self, accept: bool, locale: &str, tz: &str) -> Result<Status, Problem> {
        if !accept {
            return self.forget().await;
        }
        let s = self.read();
        let text = |k: &str| s.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        let newsletter = matches!(text("newsletter").as_str(), "pending" | "subscribed");
        self.register(RegisterInput { name: text("name"), email: text("email"), newsletter, consent: true, locale: locale.to_owned(), tz: tz.to_owned() }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::testserver::{ok, serve, status, Canned};
    use intely_settings::MemorySecretStore;

    const TOKEN: &str = "tok_0123456789abcdefghijklmnopqrstuvwxyzAB";

    struct Rig {
        registry: Registry,
        secrets: Arc<MemorySecretStore>,
        settings: Arc<SettingsStore>,
        _dir: tempfile::TempDir,
    }

    fn rig(url: &str) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsStore::open(&dir.path().join("settings.json")).unwrap());
        let secrets = Arc::new(MemorySecretStore::new());
        Rig { registry: Registry::with_url(settings.clone(), secrets.clone(), "1.13.0", url), secrets, settings, _dir: dir }
    }

    fn input() -> RegisterInput {
        RegisterInput { name: " Kovács Anna ".into(), email: "Anna@Example.com".into(), newsletter: false, consent: true, locale: "hu-HU".into(), tz: "Europe/Budapest".into() }
    }

    fn registered() -> Canned {
        ok(&format!(r#"{{"ok":true,"token":"{TOKEN}","notice":"2026-10-23","newsletter":"none"}}"#))
    }

    fn body_of(request: &str) -> Value {
        serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    }

    #[test]
    fn names_and_addresses_are_checked() {
        for ok in ["Anna", "Kovács Anna", "名前", &"x".repeat(100)] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", "   ", "a\nb", &"x".repeat(101)] {
            assert!(!valid_name(bad), "{bad:?}");
        }
        for ok in ["a@example.com", "first.last+tag@example.com", " a@example.com "] {
            assert!(valid_email(ok), "{ok}");
        }
        // written in pieces, like the other test addresses of this repository
        let dash_label = ["a", "@", "-example.com"].concat();
        let long_local = format!("{}@example.com", "a".repeat(65));
        for bad in ["", "a", "a@b", "a@@example.com", "a b@example.com", "<x>@example.com", dash_label.as_str(), "a@example..com", "a@example.c", "Ünï@example.com", long_local.as_str()] {
            assert!(!valid_email(bad), "{bad}");
        }
    }

    #[test]
    fn a_fresh_install_has_not_been_asked() {
        let r = rig("http://127.0.0.1:1");
        let s = r.registry.status();
        assert_eq!((s.state, s.needs_consent, s.name, s.consented_notice), (State::Unasked, true, None, None));
        assert_eq!(s.notice, NOTICE);
    }

    #[tokio::test]
    async fn registering_sends_what_was_agreed_and_keeps_the_token_in_the_keychain() {
        let (url, seen) = serve(vec![registered()]).await;
        let r = rig(&url);
        let s = r.registry.register(input()).await.unwrap();
        assert_eq!((s.state, s.needs_consent), (State::Registered, false));
        assert_eq!((s.name.as_deref(), s.email.as_deref(), s.newsletter.as_deref()), (Some("Kovács Anna"), Some("anna@example.com"), Some("none")));
        assert_eq!(s.consented_notice.as_deref(), Some(NOTICE));
        assert_eq!(r.secrets.get(TOKEN_KEY).unwrap().unwrap().expose(), TOKEN);
        let stored = serde_json::to_string(&r.settings.get(NS).unwrap()).unwrap();
        assert!(!stored.contains(TOKEN), "the token is not in settings.json");
        let sent = seen.lock().unwrap()[0].clone();
        assert!(sent.starts_with("POST /v1/register"));
        assert!(!sent.to_ascii_lowercase().contains("authorization"));
        let b = body_of(&sent);
        assert_eq!(b["name"], "Kovács Anna");
        assert_eq!(b["email"], "Anna@Example.com");
        assert_eq!(b["consent"], json!({"storage": true, "newsletter": false, "notice": NOTICE}));
        assert_eq!(b["appVersion"], "1.13.0");
        assert_eq!(b["device"]["id"].as_str().map(str::len), Some(64));
        assert_eq!(b["device"]["locale"], "hu-HU");
        let keys: Vec<&str> = b["device"].as_object().unwrap().keys().map(String::as_str).collect();
        let mut keys = keys;
        keys.sort_unstable();
        assert_eq!(keys, ["arch", "cpuCores", "id", "locale", "os", "osVersion", "ramGb", "tz"], "nothing but the documented fields");
    }

    #[tokio::test]
    async fn nothing_is_sent_without_agreement_or_with_bad_input() {
        let (url, seen) = serve(vec![registered()]).await;
        let r = rig(&url);
        assert_eq!(r.registry.register(RegisterInput { consent: false, ..input() }).await.unwrap_err().code, "noConsent");
        assert_eq!(r.registry.register(RegisterInput { name: " ".into(), ..input() }).await.unwrap_err().code, "invalidName");
        assert_eq!(r.registry.register(RegisterInput { email: "nope".into(), ..input() }).await.unwrap_err().code, "invalidEmail");
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(r.registry.status().state, State::Unasked);
    }

    #[tokio::test]
    async fn a_registry_that_cannot_be_reached_changes_nothing() {
        let r = rig("http://127.0.0.1:1");
        assert_eq!(r.registry.register(input()).await.unwrap_err().code, "offline");
        assert_eq!(r.registry.status().state, State::Unasked);
        assert!(r.secrets.get(TOKEN_KEY).unwrap().is_none());
    }

    #[tokio::test]
    async fn an_answer_without_a_usable_key_is_not_a_registration() {
        for body in [r#"{"ok":true}"#, r#"{"ok":true,"token":"short"}"#, r#"{"ok":true,"token":"has spaces in it which is not ok at all"}"#] {
            let (url, _) = serve(vec![ok(body)]).await;
            let r = rig(&url);
            assert_eq!(r.registry.register(input()).await.unwrap_err().code, "badResponse");
            assert_eq!(r.registry.status().state, State::Unasked);
        }
    }

    #[tokio::test]
    async fn no_means_no_and_it_is_remembered() {
        let r = rig("http://127.0.0.1:1");
        let s = r.registry.decline().unwrap();
        assert_eq!((s.state, s.needs_consent), (State::Declined, false));
        r.registry.ping().await.unwrap();
    }

    #[tokio::test]
    async fn the_ping_goes_once_an_hour_and_carries_only_the_version_and_the_details() {
        let (url, seen) = serve(vec![registered(), ok(r#"{"ok":true,"notice":"2026-10-23"}"#)]).await;
        let r = rig(&url);
        r.registry.register(input()).await.unwrap();
        r.registry.ping().await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1, "registered a minute ago: no ping yet");
        let mut p = Object::new();
        p.insert("lastPing".into(), json!(now() - 2 * PING_EVERY_S));
        r.settings.set(NS, p).unwrap();
        r.registry.ping().await.unwrap();
        r.registry.ping().await.unwrap();
        let log = seen.lock().unwrap().clone();
        assert_eq!(log.len(), 2, "one ping, the second one is within the hour");
        assert!(log[1].starts_with("POST /v1/ping"));
        assert!(log[1].to_ascii_lowercase().contains(&format!("authorization: bearer {}", TOKEN.to_ascii_lowercase())));
        let b = body_of(&log[1]);
        assert_eq!(b["appVersion"], "1.13.0");
        assert!(b["device"].get("id").is_none());
        assert_eq!(b.as_object().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_registry_that_forgot_this_computer_ends_the_registration() {
        let (url, _) = serve(vec![registered(), status(401, r#"{"ok":false,"error":"unknown_install"}"#)]).await;
        let r = rig(&url);
        r.registry.register(input()).await.unwrap();
        let mut p = Object::new();
        p.insert("lastPing".into(), json!(1));
        r.settings.set(NS, p).unwrap();
        assert_eq!(r.registry.ping().await.unwrap_err().code, "unknownInstall");
        let s = r.registry.status();
        assert_eq!((s.state, s.name, s.email), (State::Declined, None, None));
        assert!(r.secrets.get(TOKEN_KEY).unwrap().is_none(), "no key left, so nothing is sent again");
    }

    #[tokio::test]
    async fn an_older_notice_stops_the_ping_until_the_person_answers() {
        let (url, seen) = serve(vec![registered(), ok(r#"{"ok":true}"#)]).await;
        let r = rig(&url);
        r.registry.register(input()).await.unwrap();
        let mut p = Object::new();
        p.insert("consentedNotice".into(), json!("2025-01-01"));
        p.insert("lastPing".into(), json!(1));
        r.settings.set(NS, p).unwrap();
        assert!(r.registry.status().needs_consent);
        r.registry.ping().await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1, "no ping while the consent is out of date");
        // "continue" registers again under the new notice
        let (url2, seen2) = serve(vec![registered()]).await;
        let r2 = Rig { registry: Registry::with_url(r.settings.clone(), r.secrets.clone(), "1.13.0", &url2), ..r };
        let s = r2.registry.reconsent(true, "hu-HU", "Europe/Budapest").await.unwrap();
        assert!(!s.needs_consent);
        assert_eq!(s.consented_notice.as_deref(), Some(NOTICE));
        let b = body_of(&seen2.lock().unwrap()[0]);
        assert_eq!((b["name"].as_str(), b["email"].as_str(), b["consent"]["newsletter"].as_bool()), (Some("Kovács Anna"), Some("anna@example.com"), Some(false)));
    }

    #[tokio::test]
    async fn stopping_after_a_new_notice_deletes_everything() {
        let (url, seen) = serve(vec![registered(), ok(r#"{"ok":true,"removed":"all"}"#)]).await;
        let r = rig(&url);
        r.registry.register(input()).await.unwrap();
        let s = r.registry.reconsent(false, "hu-HU", "Europe/Budapest").await.unwrap();
        assert_eq!((s.state, s.name), (State::Declined, None));
        assert!(seen.lock().unwrap()[1].starts_with("POST /v1/forget"));
    }

    #[tokio::test]
    async fn me_and_the_newsletter_use_the_token() {
        let (url, seen) = serve(vec![registered(), ok(r#"{"ok":true,"user":{"email":"anna@example.com"},"computers":1}"#), ok(r#"{"ok":true,"newsletter":"pending"}"#)]).await;
        let r = rig(&url);
        assert_eq!(r.registry.me().await.unwrap_err().code, "notRegistered");
        r.registry.register(input()).await.unwrap();
        assert_eq!(r.registry.me().await.unwrap()["user"]["email"], "anna@example.com");
        let s = r.registry.set_newsletter(true).await.unwrap();
        assert_eq!(s.newsletter.as_deref(), Some("pending"));
        let log = seen.lock().unwrap().clone();
        assert!(log[1].starts_with("GET /v1/me") && log[2].starts_with("POST /v1/newsletter"));
        assert_eq!(body_of(&log[2]), json!({"subscribe": true}));
    }

    #[tokio::test]
    async fn deleting_removes_the_key_and_the_details_and_keeps_the_no() {
        let (url, seen) = serve(vec![registered(), ok(r#"{"ok":true,"removed":"all"}"#)]).await;
        let r = rig(&url);
        r.registry.register(input()).await.unwrap();
        let s = r.registry.forget().await.unwrap();
        assert_eq!((s.state, s.needs_consent, s.name, s.email), (State::Declined, false, None, None));
        assert!(r.secrets.get(TOKEN_KEY).unwrap().is_none());
        let kept = r.settings.get(NS).unwrap();
        for k in ["name", "email", "newsletter", "consentedNotice"] {
            assert!(kept.get(k).is_none(), "{k} is gone");
        }
        assert!(seen.lock().unwrap()[1].starts_with("POST /v1/forget"));
    }

    #[tokio::test]
    async fn deleting_while_offline_changes_nothing_so_it_can_be_tried_again() {
        let (url, _) = serve(vec![registered()]).await;
        let r = rig(&url);
        r.registry.register(input()).await.unwrap();
        let offline = Registry::with_url(r.settings.clone(), r.secrets.clone(), "1.13.0", "http://127.0.0.1:1");
        assert_eq!(offline.forget().await.unwrap_err().code, "offline");
        assert_eq!(r.registry.status().state, State::Registered);
        assert!(r.secrets.get(TOKEN_KEY).unwrap().is_some());
    }
}
