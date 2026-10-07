//! What the views ask: the saved address and organization, the token in the Keychain, and the issue calls. Nothing is requested
//! until an organization and a token are set; the token is read from the Keychain once and kept in memory until it changes.

use std::sync::{Arc, Mutex, PoisonError};

use intely_settings::{Object, Secret, SecretStore, SettingsStore};
use serde_json::{json, Value};

use crate::client::{validate_base, Client};
use crate::parse;
use crate::types::{ApiProblem, Config, Connection, Issue, IssueDetail, IssuePage, IssueQuery, Project, Status};

const NS: &str = "sentry";
const TOKEN_KEY: &str = "sentry.token";
const PERIODS: &[&str] = &["24h", "7d", "14d", "30d", "90d"];
const SORTS: &[&str] = &["date", "freq", "new", "user"];
const STATUSES: &[&str] = &["unresolved", "resolved", "ignored"];

pub struct Sentry {
    settings: Arc<SettingsStore>,
    secrets: Arc<dyn SecretStore>,
    /// `None` = the Keychain was not asked yet; `Some(None)` = it was and there is no token.
    token: Mutex<Option<Option<Secret>>>,
}

/// A slug or an id: what may stand in a path segment.
fn plain(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s != "." && s != ".." && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

impl Sentry {
    pub fn new(settings: Arc<SettingsStore>, secrets: Arc<dyn SecretStore>) -> Self {
        Self { settings, secrets, token: Mutex::new(None) }
    }

    pub fn config(&self) -> Config {
        let stored: Object = self.settings.get(NS).unwrap_or_default();
        let base = stored.get("baseUrl").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        let org = stored.get("org").and_then(Value::as_str).map(str::trim).unwrap_or_default();
        Config { base_url: base.map_or_else(|| Config::default().base_url, str::to_owned), org: org.to_owned() }
    }

    fn token(&self) -> Option<Secret> {
        let mut slot = self.token.lock().unwrap_or_else(PoisonError::into_inner);
        slot.get_or_insert_with(|| self.secrets.get(TOKEN_KEY).ok().flatten()).clone()
    }

    fn remember(&self, token: Option<Secret>) {
        *self.token.lock().unwrap_or_else(PoisonError::into_inner) = Some(token);
    }

    pub fn status(&self) -> Status {
        let c = self.config();
        let has_token = self.token().is_some();
        Status { configured: has_token && plain(&c.org), has_token, base_url: c.base_url, org: c.org }
    }

    /// Saves the address and the organization; either may be left out to keep the saved one. A token belongs to the address it was
    /// entered for: saving another address forgets the token first, so a stored token is never sent to a server the person did not
    /// enter it for (and the address cannot be changed when the token cannot be removed).
    pub fn set_config(&self, base_url: Option<String>, org: Option<String>) -> Result<Status, ApiProblem> {
        let before = self.config().base_url;
        let mut after = before.clone();
        let mut patch = Object::new();
        if let Some(b) = base_url {
            let b = b.trim();
            if b.is_empty() {
                patch.insert("baseUrl".into(), Value::Null);
                after = Config::default().base_url;
            } else {
                validate_base(b)?;
                after = b.trim_end_matches('/').to_owned();
                patch.insert("baseUrl".into(), json!(after));
            }
        }
        if let Some(o) = org {
            let o = o.trim();
            if !o.is_empty() && !plain(o) {
                return Err(ApiProblem::new("badRequest", "The organization is the short name from your Sentry address, letters, digits and dashes only"));
            }
            patch.insert("org".into(), if o.is_empty() { Value::Null } else { json!(o) });
        }
        if !before.trim_end_matches('/').eq_ignore_ascii_case(&after) && self.token().is_some() {
            self.secrets
                .remove(TOKEN_KEY)
                .map_err(|_| ApiProblem::new("badRequest", "The saved token could not be removed from the Keychain, so the address was not changed"))?;
            self.remember(None);
        }
        if !patch.is_empty() {
            self.settings.set(NS, patch).map_err(|e| ApiProblem::new("badRequest", e.message))?;
        }
        Ok(self.status())
    }

    /// Stores the token, then tries it. A token Sentry does not accept is not kept.
    pub async fn save_token(&self, token: &str) -> Connection {
        let token = token.trim();
        if token.is_empty() {
            return Connection { ok: false, org_name: None, user: None, problem: Some(ApiProblem::new("badRequest", "The token is empty")) };
        }
        let secret = Secret::new(token);
        let (secrets, stored) = (self.secrets.clone(), secret.clone());
        let saved = tokio::task::spawn_blocking(move || secrets.set(TOKEN_KEY, stored)).await;
        if !matches!(saved, Ok(Ok(()))) {
            return Connection { ok: false, org_name: None, user: None, problem: Some(ApiProblem::new("badRequest", "The token could not be saved to the Keychain")) };
        }
        self.remember(Some(secret));
        let result = self.test().await;
        if result.problem.as_ref().is_some_and(|p| p.code == "unauthorized") {
            self.forget_token().await;
        }
        result
    }

    async fn forget_token(&self) {
        let secrets = self.secrets.clone();
        let _ = tokio::task::spawn_blocking(move || secrets.remove(TOKEN_KEY)).await;
        self.remember(None);
    }

    pub async fn clear_token(&self) -> Status {
        self.forget_token().await;
        self.status()
    }

    fn client(&self) -> Result<(Client, Config), ApiProblem> {
        let c = self.config();
        let token = self.token().ok_or_else(|| ApiProblem::new("notConfigured", "Add a Sentry token in Settings > Integrations first"))?;
        if !plain(&c.org) {
            return Err(ApiProblem::new("notConfigured", "Add the Sentry organization in Settings > Integrations first"));
        }
        Ok((Client::new(&c.base_url, token)?, c))
    }

    /// "Test connection": the organization's name, and who the token belongs to (a person's token can take issues).
    pub async fn test(&self) -> Connection {
        let (client, c) = match self.client() {
            Ok(x) => x,
            Err(problem) => return Connection { ok: false, org_name: None, user: None, problem: Some(problem) },
        };
        match client.get(&format!("/api/0/organizations/{}/", c.org), &[]).await {
            Err(problem) => Connection { ok: false, org_name: None, user: None, problem: Some(problem) },
            Ok(org) => {
                let user = client.get("/api/0/users/me/", &[]).await.ok().and_then(|r| parse::me(&r.body)).map(|m| m.1);
                let org_name = org.body.get("name").and_then(Value::as_str).map(str::to_owned).or(Some(c.org));
                Connection { ok: true, org_name, user, problem: None }
            }
        }
    }

    pub async fn projects(&self) -> Result<Vec<Project>, ApiProblem> {
        let (client, c) = self.client()?;
        let r = client.get(&format!("/api/0/organizations/{}/projects/", c.org), &[("per_page", "100")]).await?;
        Ok(parse::projects(&r.body))
    }

    pub async fn issues(&self, q: IssueQuery) -> Result<IssuePage, ApiProblem> {
        let (client, c) = self.client()?;
        let status = if STATUSES.contains(&q.status.as_str()) { q.status.as_str() } else if q.status == "all" { "" } else { "unresolved" };
        let user_query = q.query.trim();
        let mut search = String::new();
        if !status.is_empty() && !user_query.contains("is:") {
            search.push_str(&format!("is:{status}"));
        }
        if !user_query.is_empty() {
            if !search.is_empty() {
                search.push(' ');
            }
            search.push_str(user_query);
        }
        let period = if PERIODS.contains(&q.period.as_str()) { q.period.as_str() } else { "14d" };
        let sort = if SORTS.contains(&q.sort.as_str()) { q.sort.as_str() } else { "date" };
        let limit = q.limit.unwrap_or(25).clamp(1, 100).to_string();
        // `-1` is Sentry's "every project I can see"; left out it would mean only the projects the person is a member of
        let project = q.project.as_deref().filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())).unwrap_or("-1");
        let mut params: Vec<(&str, &str)> = vec![("query", search.as_str()), ("statsPeriod", period), ("sort", sort), ("limit", limit.as_str()), ("project", project)];
        if let Some(cursor) = q.cursor.as_deref().filter(|c| parse::cursor_ok(c)) {
            params.push(("cursor", cursor));
        }
        let r = client.get(&format!("/api/0/organizations/{}/issues/", c.org), &params).await?;
        Ok(IssuePage { issues: parse::issues(&r.body), next_cursor: parse::next_cursor(r.link.as_deref()) })
    }

    pub async fn issue(&self, id: &str) -> Result<IssueDetail, ApiProblem> {
        if !plain(id) {
            return Err(ApiProblem::new("badRequest", "That is not an issue id"));
        }
        let (client, c) = self.client()?;
        let r = client.get(&format!("/api/0/organizations/{}/issues/{id}/", c.org), &[]).await?;
        let issue = parse::issue(&r.body).ok_or_else(|| ApiProblem::new("badResponse", "Sentry's answer had no issue in it"))?;
        // the newest event is a bonus: an issue without one (or one that cannot be read) still shows
        let event = client.get(&format!("/api/0/organizations/{}/issues/{id}/events/latest/", c.org), &[]).await.ok().and_then(|e| parse::event(&e.body));
        Ok(IssueDetail { issue, event })
    }

    async fn update(&self, id: &str, body: Value) -> Result<Issue, ApiProblem> {
        if !plain(id) {
            return Err(ApiProblem::new("badRequest", "That is not an issue id"));
        }
        let (client, c) = self.client()?;
        let path = format!("/api/0/organizations/{}/issues/{id}/", c.org);
        let r = client.put(&path, &body).await?;
        match parse::issue(&r.body) {
            Some(i) => Ok(i),
            None => parse::issue(&client.get(&path, &[]).await?.body).ok_or_else(|| ApiProblem::new("badResponse", "Sentry's answer had no issue in it")),
        }
    }

    /// Assigns the issue to the person the token belongs to.
    pub async fn assign_me(&self, id: &str) -> Result<Issue, ApiProblem> {
        let (client, _) = self.client()?;
        let me = client.get("/api/0/users/me/", &[]).await.ok().and_then(|r| parse::me(&r.body));
        let Some((user_id, _)) = me else {
            return Err(ApiProblem::new("forbidden", "This token is not a person's, so it cannot take an issue. Use a personal token (with the member:read scope)"));
        };
        self.update(id, json!({ "assignedTo": format!("user:{user_id}") })).await
    }

    pub async fn set_status(&self, id: &str, status: &str) -> Result<Issue, ApiProblem> {
        if !STATUSES.contains(&status) {
            return Err(ApiProblem::new("badRequest", "A status is resolved, unresolved or ignored"));
        }
        self.update(id, json!({ "status": status })).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::testserver::{ok, serve, status, Canned};
    use intely_settings::MemorySecretStore;

    struct Rig {
        sentry: Sentry,
        secrets: Arc<MemorySecretStore>,
        _dir: tempfile::TempDir,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsStore::open(&dir.path().join("settings.json")).unwrap());
        let secrets = Arc::new(MemorySecretStore::new());
        Rig { sentry: Sentry::new(settings, secrets.clone()), secrets, _dir: dir }
    }

    async fn ready(base: &str, r: &Rig) {
        r.sentry.set_config(Some(base.to_owned()), Some("acme".to_owned())).unwrap();
        r.secrets.set(TOKEN_KEY, Secret::new("sntrys_SECRETVALUE1234567890")).unwrap();
        // the token is read from the store again on the next ask
        *r.sentry.token.lock().unwrap() = None;
    }

    const ISSUE: &str = r#"{"id":"11","shortId":"SHOP-B","title":"Boom","culprit":"a.js in f","level":"error","status":"unresolved","count":"5","userCount":2,"firstSeen":"a","lastSeen":"b","permalink":"https://sentry.io/x/","project":{"id":"5","slug":"shop","name":"Shop"}}"#;

    #[test]
    fn the_address_and_the_organization_are_checked_before_they_are_saved() {
        let r = rig();
        assert_eq!(r.sentry.status(), Status { base_url: "https://sentry.io".into(), org: String::new(), has_token: false, configured: false });
        assert_eq!(r.sentry.set_config(Some("http://sentry.example".into()), None).unwrap_err().code, "invalidBaseUrl");
        assert_eq!(r.sentry.set_config(None, Some("a/b".into())).unwrap_err().code, "badRequest");
        let s = r.sentry.set_config(Some(" https://sentry.example.invalid/ ".into()), Some(" acme ".into())).unwrap();
        assert_eq!((s.base_url.as_str(), s.org.as_str()), ("https://sentry.example.invalid", "acme"));
        // an empty address means "the default", an empty organization means none
        let s = r.sentry.set_config(Some(String::new()), Some(String::new())).unwrap();
        assert_eq!((s.base_url.as_str(), s.org.as_str()), ("https://sentry.io", ""));
    }

    #[test]
    fn a_token_is_forgotten_when_the_address_changes_and_kept_when_it_does_not() {
        let r = rig();
        // a token put into the store from outside: the service reads the store again on the next ask
        let token = || {
            r.secrets.set(TOKEN_KEY, Secret::new("sntrys_SECRETVALUE1234567890")).unwrap();
            *r.sentry.token.lock().unwrap() = None;
        };
        r.sentry.set_config(Some("https://sentry.example.invalid".into()), Some("acme".into())).unwrap();
        token();
        assert!(r.sentry.status().has_token);
        // the same address (a slash or another case is no other address) and another organization keep it
        let s = r.sentry.set_config(Some("https://Sentry.Example.invalid/".into()), Some("other".into())).unwrap();
        assert!(s.has_token && r.secrets.has(TOKEN_KEY).unwrap());
        // an address that is refused, or an organization that is, changes nothing and keeps the token
        assert_eq!(r.sentry.set_config(Some("http://sentry.example".into()), None).unwrap_err().code, "invalidBaseUrl");
        assert_eq!(r.sentry.set_config(Some("https://elsewhere.example.invalid".into()), Some("a/b".into())).unwrap_err().code, "badRequest");
        assert!(r.secrets.has(TOKEN_KEY).unwrap());
        assert_eq!(r.sentry.status().base_url, "https://Sentry.Example.invalid", "the refused calls saved nothing");
        // another address starts without the token: it would otherwise be sent to a server it was not entered for
        let s = r.sentry.set_config(Some("https://elsewhere.example.invalid".into()), None).unwrap();
        assert!(!s.has_token && !s.configured);
        assert!(!r.secrets.has(TOKEN_KEY).unwrap());
        // the default address is an address too
        token();
        assert!(r.sentry.status().has_token);
        let s = r.sentry.set_config(Some(String::new()), None).unwrap();
        assert!(!s.has_token && !r.secrets.has(TOKEN_KEY).unwrap());
        // a first address (no token yet) is saved as it was
        let s = r.sentry.set_config(Some("https://sentry.example.invalid".into()), None).unwrap();
        assert_eq!(s.base_url, "https://sentry.example.invalid");
    }

    #[tokio::test]
    async fn nothing_is_asked_without_a_token_and_an_organization() {
        let r = rig();
        assert_eq!(r.sentry.issues(IssueQuery::default()).await.unwrap_err().code, "notConfigured");
        r.secrets.set(TOKEN_KEY, Secret::new("t")).unwrap();
        assert_eq!(r.sentry.projects().await.unwrap_err().code, "notConfigured", "a token but no organization");
        assert_eq!(r.sentry.test().await.problem.unwrap().code, "notConfigured");
    }

    #[tokio::test]
    async fn a_token_is_tried_when_it_is_saved_and_kept_only_when_sentry_takes_it() {
        let r = rig();
        let (base, seen) = serve(vec![ok(r#"{"name":"Acme Inc"}"#), ok(r#"{"id":"42","name":"Ferenc"}"#)]).await;
        r.sentry.set_config(Some(base), Some("acme".into())).unwrap();
        let c = r.sentry.save_token("  sntrys_GOOD  ").await;
        assert_eq!((c.ok, c.org_name.as_deref(), c.user.as_deref()), (true, Some("Acme Inc"), Some("Ferenc")));
        assert!(r.secrets.has(TOKEN_KEY).unwrap());
        assert!(seen.lock().unwrap()[0].to_ascii_lowercase().contains("bearer sntrys_good"), "the token is trimmed");
        assert!(r.sentry.status().configured);

        let r2 = rig();
        let (base, _) = serve(vec![status(401, r#"{"detail":"Invalid token"}"#)]).await;
        r2.sentry.set_config(Some(base), Some("acme".into())).unwrap();
        let c = r2.sentry.save_token("sntrys_BAD").await;
        assert_eq!(c.problem.map(|p| p.code), Some("unauthorized".to_owned()));
        assert!(!r2.secrets.has(TOKEN_KEY).unwrap(), "a token Sentry refuses is not kept");
        assert!(!r2.sentry.status().has_token);
        assert_eq!(r2.sentry.save_token("   ").await.problem.unwrap().code, "badRequest");
    }

    #[tokio::test]
    async fn the_connection_test_works_for_a_token_that_is_not_a_person() {
        let r = rig();
        let (base, _) = serve(vec![ok(r#"{"name":"Acme"}"#), status(403, "{}")]).await;
        ready(&base, &r).await;
        let c = r.sentry.test().await;
        assert_eq!((c.ok, c.org_name.as_deref(), c.user), (true, Some("Acme"), None));
    }

    #[tokio::test]
    async fn the_issue_list_is_asked_with_the_filters_and_gives_the_next_page() {
        let r = rig();
        let link = r#"<u>; rel="next"; results="true"; cursor="0:25:0""#.to_owned();
        let (base, seen) = serve(vec![Canned { status: 200, headers: vec![("Link", link)], body: format!("[{ISSUE}]") }]).await;
        ready(&base, &r).await;
        let page = r.sentry.issues(IssueQuery { query: "level:error".into(), status: "resolved".into(), period: "7d".into(), sort: "freq".into(), project: Some("5".into()), cursor: Some("0:50:0".into()), limit: Some(500) }).await.unwrap();
        assert_eq!(page.issues.len(), 1);
        assert_eq!((page.issues[0].short_id.as_str(), page.issues[0].count), ("SHOP-B", 5));
        assert_eq!(page.next_cursor.as_deref(), Some("0:25:0"));
        let head = seen.lock().unwrap()[0].lines().next().unwrap().to_owned();
        for part in ["/api/0/organizations/acme/issues/?", "query=is%3Aresolved+level%3Aerror", "statsPeriod=7d", "sort=freq", "limit=100", "project=5", "cursor=0%3A50%3A0"] {
            assert!(head.contains(part), "{part} in {head}");
        }
    }

    #[tokio::test]
    async fn bad_filters_fall_back_to_the_defaults_and_a_status_in_the_query_wins() {
        let r = rig();
        let (base, seen) = serve(vec![ok("[]")]).await;
        ready(&base, &r).await;
        r.sentry.issues(IssueQuery { query: "is:ignored foo".into(), status: "weird".into(), period: "forever".into(), sort: "nonsense".into(), project: Some("5; DROP".into()), cursor: Some("../../x".into()), limit: None }).await.unwrap();
        let head = seen.lock().unwrap()[0].lines().next().unwrap().to_owned();
        for part in ["query=is%3Aignored+foo", "statsPeriod=14d", "sort=date", "limit=25"] {
            assert!(head.contains(part), "{part} in {head}");
        }
        assert!(head.contains("project=-1") && !head.contains("cursor="), "every project when none is picked, and a bad cursor is dropped: {head}");
        let (base, seen) = serve(vec![ok("[]")]).await;
        ready(&base, &r).await;
        r.sentry.issues(IssueQuery { status: "all".into(), ..IssueQuery::default() }).await.unwrap();
        let head = seen.lock().unwrap()[0].lines().next().unwrap().to_owned();
        assert!(head.contains("query=&"), "all statuses and no words: an empty query is still sent, or Sentry applies its own default: {head}");
    }

    #[tokio::test]
    async fn an_issue_comes_with_its_newest_event_and_without_it_when_that_cannot_be_read() {
        let r = rig();
        let (base, _) = serve(vec![ok(ISSUE), ok(r#"{"eventID":"e1","platform":"node","message":"boom","entries":[]}"#)]).await;
        ready(&base, &r).await;
        let d = r.sentry.issue("11").await.unwrap();
        assert_eq!((d.issue.short_id.as_str(), d.event.as_ref().map(|e| e.event_id.as_str())), ("SHOP-B", Some("e1")));
        let (base, _) = serve(vec![ok(ISSUE), status(404, "{}")]).await;
        ready(&base, &r).await;
        let d = r.sentry.issue("11").await.unwrap();
        assert!(d.event.is_none());
        assert_eq!(r.sentry.issue("../x").await.unwrap_err().code, "badRequest");
        let (base, _) = serve(vec![ok("{}")]).await;
        ready(&base, &r).await;
        assert_eq!(r.sentry.issue("11").await.unwrap_err().code, "badResponse");
    }

    #[tokio::test]
    async fn assigning_to_me_asks_who_the_token_is_first_and_a_status_is_one_of_three() {
        let r = rig();
        let (base, seen) = serve(vec![ok(r#"{"id":"42","name":"Ferenc"}"#), ok(ISSUE)]).await;
        ready(&base, &r).await;
        assert_eq!(r.sentry.assign_me("11").await.unwrap().short_id, "SHOP-B");
        let put = seen.lock().unwrap()[1].clone();
        assert!(put.starts_with("PUT /api/0/organizations/acme/issues/11/ "), "{put}");
        assert!(put.ends_with(r#"{"assignedTo":"user:42"}"#), "{put}");

        let (base, seen) = serve(vec![status(403, "{}")]).await;
        ready(&base, &r).await;
        assert_eq!(r.sentry.assign_me("11").await.unwrap_err().code, "forbidden");
        assert_eq!(seen.lock().unwrap().len(), 1, "no assignment is attempted for a token that is not a person's");

        let (base, seen) = serve(vec![ok(r#"{"id":"11","title":"Boom","status":"resolved"}"#)]).await;
        ready(&base, &r).await;
        assert_eq!(r.sentry.set_status("11", "resolved").await.unwrap().status, "resolved");
        assert!(seen.lock().unwrap()[0].ends_with(r#"{"status":"resolved"}"#));
        assert_eq!(r.sentry.set_status("11", "deleted").await.unwrap_err().code, "badRequest");
    }

    #[tokio::test]
    async fn clearing_the_token_removes_it_from_the_keychain_and_from_memory() {
        let r = rig();
        r.secrets.set(TOKEN_KEY, Secret::new("t")).unwrap();
        assert!(r.sentry.status().has_token);
        let s = r.sentry.clear_token().await;
        assert!(!s.has_token && !r.secrets.has(TOKEN_KEY).unwrap());
    }
}
