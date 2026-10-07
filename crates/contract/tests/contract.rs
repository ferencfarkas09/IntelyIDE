//! Fixture-only tests: throwaway repos under a temp dir, never a real repository.

use std::fs;
use std::path::Path;
use std::process::Command;

use intely_contract::analyze::{analyze, Cache, ClientInput};
use intely_contract::scan::{normalize, scan_text};
use intely_contract::spec::{self, detail};
use intely_contract::{git, yaml};

fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn git_init(root: &Path) {
    for args in [vec!["init", "-q"], vec!["add", "-A"], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"]] {
        let st = Command::new("git").arg("-C").arg(root).args(&args).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_SYSTEM", "/dev/null").status().unwrap();
        assert!(st.success());
    }
}

const BANKS: &str = r#"
/api/banks:
  x-swagger-router-controller: bank.controller
  get:
    operationId: getBanks
    tags:
      - Banks
    summary: List banks
    description: >-
      Long text
      that folds.
    parameters:
      - name: restaurantId
        in: query
        required: true
        type: string
    responses:
      200:
        description: ok
        schema:
          type: 'array'
          items:
            $ref: '#/definitions/Bank'
  post:
    operationId: createBank
    tags: [Banks]
    parameters:
      - name: body
        in: body
        required: true
        schema: { $ref: '#/definitions/Bank' }
    responses:
      201:
        description: created
        schema:
          $ref: '#/definitions/Bank'
/api/banks/{bankId}:
  get:
    operationId: getBank
    tags: [Banks]
    parameters:
      - { name: bankId, in: path, required: true, type: string }
    responses:
      200:
        description: ok
        schema:
          $ref: '#/definitions/Bank'
  delete:
    operationId: deleteBank
    deprecated: true
    tags: [Banks]
    parameters:
      - { name: bankId, in: path, required: true, type: string }
    responses:
      204:
        description: gone
definitions:
  Bank:
    type: object
    required: [name]
    properties:
      _id: { type: string }
      name: { type: string, example: "OTP" }
      iban:
        type: string
        description: "IBAN: the number"
      owner:
        $ref: '#/definitions/Person'
  Person:
    type: object
    properties:
      name: { type: string }
      bank: { $ref: '#/definitions/Bank' }
"#;

const ORDERS: &str = r#"
/api/order/{orderId}:
  get:
    operationId: getOrder
    tags: [Order]
    parameters:
      - { name: orderId, in: path, required: true, type: string }
    responses:
      200:
        description: ok
        schema: { $ref: '#/definitions/Order' }
/api/order/courier/labels:
  post:
    operationId: courierLabels
    tags: [Order]
    responses:
      200: { description: ok }
/api/unused/thing:
  get:
    operationId: unusedThing
    tags: [Misc]
    responses:
      200: { description: ok }
definitions:
  Order:
    allOf:
      - $ref: '#/definitions/Base'
      - type: object
        properties:
          total: { type: number }
          state: { type: string }
  Base:
    type: object
    properties:
      id: { type: string }
"#;

fn backend(root: &Path) {
    write(root, "src/api/banks.swagger.yaml", BANKS);
    write(root, "src/api/orders.swagger.yaml", ORDERS);
    write(root, "scripts/build-swagger.mjs", "// build");
}

#[test]
fn yaml_subset() {
    let p = yaml::parse_with_lines(BANKS).unwrap();
    let v = &p.value;
    assert_eq!(v["/api/banks"]["get"]["operationId"], "getBanks");
    assert_eq!(v["/api/banks"]["get"]["description"], "Long text that folds.");
    assert_eq!(v["/api/banks"]["get"]["parameters"][0]["required"], true);
    assert_eq!(v["/api/banks"]["get"]["responses"]["200"]["schema"]["type"], "array");
    assert_eq!(v["/api/banks"]["post"]["tags"][0], "Banks");
    assert_eq!(v["/api/banks"]["post"]["parameters"][0]["schema"]["$ref"], "#/definitions/Bank");
    assert_eq!(v["definitions"]["Bank"]["properties"]["iban"]["description"], "IBAN: the number");
    assert_eq!(v["definitions"]["Bank"]["required"][0], "name");
    assert!(p.lines.iter().any(|(k, l)| k == "/api/banks/{bankId}" && *l == BANKS.lines().position(|x| x.starts_with("/api/banks/{bankId}")).unwrap() + 1));
    assert_eq!(yaml::parse("a: [1, 'x', {b: c}]\nd: |\n  l1\n  l2\n# c\ne: null\n").unwrap()["a"][2]["b"], "c");
    assert_eq!(yaml::parse("k: 'it''s' # tail\n").unwrap()["k"], "it's");
    assert_eq!(yaml::parse("u: '#/definitions/X'\n").unwrap()["u"], "#/definitions/X");
}

#[test]
fn spec_from_fragments() {
    let d = tempfile::tempdir().unwrap();
    backend(d.path());
    let files = git::list_files(d.path());
    let s = spec::load(d.path(), &files).unwrap();
    assert_eq!(s.kind, "swagger2");
    assert_eq!(s.endpoints.len(), 7);
    let get_banks = s.endpoints.iter().find(|e| e.id == "GET /api/banks").unwrap();
    assert!(get_banks.params[0].required);
    assert!(get_banks.response.as_ref().unwrap().array);
    // serde_json key order depends on whether another workspace crate enables preserve_order
    let mut props = get_banks.response.as_ref().unwrap().props.clone();
    props.sort();
    assert_eq!(props, vec!["_id", "iban", "name", "owner"]);
    assert_eq!(get_banks.source.file, "src/api/banks.swagger.yaml");
    let post = s.endpoints.iter().find(|e| e.id == "POST /api/banks").unwrap();
    assert!(post.has_body && post.body_required);
    let order = s.endpoints.iter().find(|e| e.id == "GET /api/order/{orderId}").unwrap();
    let mut order_props = order.response.as_ref().unwrap().props.clone();
    order_props.sort();
    assert_eq!(order_props, vec!["id", "state", "total"]);
    // schema tree with a cycle
    let d = detail(&s, "GET /api/banks/{bankId}").unwrap();
    let node = d.responses[0].schema.as_ref().unwrap();
    assert_eq!(node.ref_name.as_deref(), Some("Bank"));
    let owner = node.props.iter().find(|p| p.name == "owner").unwrap();
    assert!(owner.node.props.iter().any(|p| p.name == "bank" && p.node.circular));
    assert!(node.props.iter().find(|p| p.name == "name").unwrap().node.required);
}

#[test]
fn openapi3_and_swagger_json() {
    let doc = serde_json::json!({
        "openapi": "3.0.1", "info": {"title": "t", "version": "1"}, "servers": [{"url": "https://x.test/api"}],
        "paths": {"/pets/{id}": {"parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}},],
            "get": {"operationId": "getPet", "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}}}},
            "put": {"operationId": "putPet", "requestBody": {"required": true, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}}, "responses": {"200": {"description": "ok"}}}}},
        "components": {"schemas": {"Pet": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}, "tag": {"type": "string"}}}}}
    });
    let s = spec::from_value(&doc, |_| spec::Source { file: "o.json".into(), line: 1 }).unwrap();
    assert_eq!(s.kind, "openapi3");
    assert_eq!(s.host, "https://x.test/api");
    let get = &s.endpoints[0];
    assert_eq!(get.params.len(), 1);
    assert_eq!(get.response.as_ref().unwrap().props, vec!["name", "tag"]);
    assert!(s.endpoints[1].body_required);
    // swagger 2 json document discovered by name, with basePath
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "public/swagger.dev.json", r#"{
  "swagger": "2.0", "basePath": "/v1", "host": "h.test", "info": {"title": "x", "version": "2"},
  "paths": {
    "/a": {"get": {"operationId": "a", "responses": {"200": {"description": "ok"}}}}
  }
}"#);
    let files = git::list_files(d.path());
    let s = spec::load(d.path(), &files).unwrap();
    assert_eq!(s.endpoints[0].path, "/v1/a");
    assert_eq!(s.endpoints[0].source.line, 4);
    assert_eq!(s.host, "https://h.test");
}

#[test]
fn scanner_patterns() {
    let js = r#"
const a = await window.swaggerClient.apis.Banks.getBanks(restaurantId ? { restaurantId } : {});
window.swaggerClient.apis.Banks.createBank({ body: data }).then((response) => {
  return response.obj.nmae;
});
const r = await apiFetch(`/order/${orderId}`);
console.log(r.total, r.stat);
await apiFetch('/order/courier/labels', { method: 'POST', body: x });
const resp = await fetch(`https://happy.example.test/api/banks/${id}?limit=5&${extra}`, { method: "DELETE" });
axios.get("/api/banks", { params: { restaurantId } });
history.push('/orders/list');
map.get('/zz/yy');
const url = 'https://example.com/docs';
"#;
    let calls = scan_text("src/x.js", js);
    let kinds: Vec<(&str, Option<&str>, Option<&str>)> = calls.iter().map(|c| (c.kind.as_str(), c.method.as_deref(), c.path.as_deref())).collect();
    assert_eq!(calls.len(), 6, "{kinds:?}");
    assert_eq!(calls[0].operation.as_deref(), Some("getBanks"));
    assert!(calls[0].keys.is_none());
    assert_eq!(calls[1].keys.as_ref().unwrap(), &vec!["body".to_string()]);
    assert_eq!(calls[1].reads, vec!["nmae"]);
    assert_eq!(kinds[2], ("http", Some("GET"), Some("/order/{}")));
    assert_eq!(calls[2].reads, vec!["total", "stat"]);
    assert_eq!(kinds[3], ("http", Some("POST"), Some("/order/courier/labels")));
    assert_eq!(kinds[4], ("http", Some("DELETE"), Some("/api/banks/{}")));
    assert_eq!(calls[4].query_keys, None);
    assert_eq!(kinds[5], ("http", Some("GET"), Some("/api/banks")));
    assert_eq!(calls[5].query_keys.as_ref().unwrap(), &vec!["restaurantId".to_string()]);
    assert_eq!(normalize("${base}/x").map(|p| p.0), None);
    assert_eq!(normalize("{}/api/x/{}?a=1&b={}").unwrap(), ("/api/x/{}".to_string(), vec!["a".to_string(), "b".to_string()], false));
    let concat = scan_text("src/y.js", "apiFetch('/restaurant/' + id + '/foods');");
    assert_eq!(concat[0].path.as_deref(), Some("/restaurant/{}/foods"));
    let table = scan_text("src/endpoints.js", "export const EP = {\n  summary: (id) => `/order/${id}/summary`,\n  list: '/banks',\n};");
    assert_eq!(table.iter().filter(|c| c.kind == "reference").count(), 2);
}

#[test]
fn end_to_end_report_and_cache() {
    let be = tempfile::tempdir().unwrap();
    backend(be.path());
    git_init(be.path());
    let admin = tempfile::tempdir().unwrap();
    write(
        admin.path(),
        "src/networking/bankNetworking.js",
        r#"const bankNetworking = {
  all: async () => {
    return window.swaggerClient.apis.Banks.getBanks({}).then((response) => {
      return response.obj;
    });
  },
  one: (bankId) => window.swaggerClient.apis.Banks.getBank({ bankId }),
  old: () => window.swaggerClient.apis.Banks.getBankz({}),
  wrongTag: () => window.swaggerClient.apis.Order.getBank({}),
  gone: () => window.swaggerClient.apis.Nope.completelyDifferentThing({}),
  mk: () => window.swaggerClient.apis.Banks.createBank({}),
  del: (bankId) => window.swaggerClient.apis.Banks.deleteBank({ bankId }),
};
"#,
    );
    write(admin.path(), "src/networking/bankNetworking.test.js", "window.swaggerClient.apis.Banks.neverScanned({});");
    git_init(admin.path());
    let mobile = tempfile::tempdir().unwrap();
    write(
        mobile.path(),
        "app/helpers/orderApi.js",
        r#"export const load = async (orderId) => {
  const order = await apiFetch(`/order/${orderId}`);
  return order.total + order.ghostField;
};
export const makeLabels = () => apiFetch('/order/courier/labels');
export const gone = () => apiFetch('/banks/archive/all');
export const renamedLike = () => apiFetch('/bankz', { method: 'GET' });
export const del = (id) => apiFetch(`/banks/${id}`, { method: 'PUT' });
"#,
    );
    git_init(mobile.path());
    let files = git::list_files(be.path());
    let s = spec::load(be.path(), &files).unwrap();
    let cache = Cache::default();
    let inputs = vec![ClientInput { id: "admin".into(), root: admin.path().into() }, ClientInput { id: "mobile".into(), root: mobile.path().into() }];
    let fp = git::fingerprint(be.path());
    let rep = analyze(&s, "backend", &fp, &inputs, &cache);
    assert_eq!(rep.clients.len(), 2);
    let a = &rep.clients[0];
    assert_eq!(a.counts.calls, 7, "{:?}", a.findings.iter().map(|f| (&f.kind, &f.target)).collect::<Vec<_>>());
    let kinds = |c: &intely_contract::analyze::ClientReport, k: &str| c.findings.iter().filter(|f| f.kind == k).map(|f| f.target.clone()).collect::<Vec<_>>();
    assert_eq!(kinds(a, "renamed"), vec!["Banks.getBankz"]);
    assert_eq!(a.findings.iter().find(|f| f.kind == "renamed").unwrap().suggestion.as_ref().unwrap().operation_id.as_deref(), Some("getBank"));
    assert_eq!(kinds(a, "tagMismatch"), vec!["Order.getBank"]);
    assert_eq!(kinds(a, "missing"), vec!["Nope.completelyDifferentThing"]);
    assert_eq!(kinds(a, "requiredParam"), vec!["Banks.getBanks", "Banks.createBank"]);
    assert_eq!(kinds(a, "deprecated").len(), 1);
    assert_eq!(kinds(a, "responseField").len(), 0);
    assert_eq!(a.files["src/networking/bankNetworking.js"].0, 7);
    assert!(!a.files.contains_key("src/networking/bankNetworking.test.js"));
    let m = &rep.clients[1];
    assert_eq!(m.counts.calls, 5, "{:?}", m.findings.iter().map(|f| (&f.kind, &f.target)).collect::<Vec<_>>());
    assert_eq!(kinds(m, "responseField").len(), 1);
    assert_eq!(m.findings.iter().find(|f| f.kind == "responseField").unwrap().names, vec!["ghostField"]);
    assert_eq!(kinds(m, "method"), vec!["GET /order/courier/labels", "PUT /banks/{}"]);
    assert!(m.findings.iter().find(|f| f.kind == "method").unwrap().heuristic);
    assert_eq!(m.findings.iter().rev().find(|f| f.kind == "method").unwrap().allowed, vec!["GET", "DELETE"]);
    assert_eq!(kinds(m, "missing"), vec!["GET /banks/archive/all"]);
    assert_eq!(kinds(m, "renamed"), vec!["GET /bankz"]);
    assert!(m.findings.iter().find(|f| f.kind == "renamed").unwrap().suggestion.as_ref().unwrap().path == "/api/banks");
    // swagger endpoints nobody uses
    let unused: Vec<&str> = rep.unused.iter().map(|u| u.id.as_str()).collect();
    assert_eq!(unused, vec!["GET /api/unused/thing"]);
    assert_eq!(rep.unused[0].source.file, "src/api/orders.swagger.yaml");
    assert!(!a.cached && !m.cached);
    // second run: same commits and trees -> served from the cache
    let again = analyze(&s, "backend", &fp, &inputs, &cache);
    assert!(again.clients.iter().all(|c| c.cached));
    // a dirty working tree changes the fingerprint and rescans only that repo
    write(mobile.path(), "app/helpers/more.js", "apiFetch('/banks');");
    let third = analyze(&s, "backend", &fp, &inputs, &cache);
    assert!(third.clients[0].cached && !third.clients[1].cached);
    assert_eq!(third.clients[1].counts.calls, 6);
}
