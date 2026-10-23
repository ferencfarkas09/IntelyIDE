// The admin page: static files (no data in them). They call /admin/api/* with the token the owner types in, which is kept for the tab only.
// Everything that comes from the database is put on the page with textContent, never as HTML.

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>IntelyIDE registry</title>
<link rel="stylesheet" href="/admin/app.css">
</head>
<body>
<header>
  <h1>IntelyIDE registry</h1>
  <div class="bar">
    <button id="refresh" type="button" hidden>Refresh</button>
    <button id="export" type="button" hidden>Export CSV</button>
    <button id="logout" type="button" hidden>Lock</button>
  </div>
</header>
<main>
  <form id="login" autocomplete="off">
    <label for="token">Admin token</label>
    <input id="token" type="password" autocomplete="off" required>
    <button type="submit">Open</button>
    <p id="login-error" class="error" role="alert" hidden></p>
  </form>
  <section id="dash" hidden>
    <div id="tiles" class="tiles"></div>
    <div id="groups" class="groups"></div>
    <h2>People</h2>
    <form id="search"><input id="q" type="search" placeholder="Search name or email" maxlength="100"><button type="submit">Search</button></form>
    <div class="scroll"><table id="users"><thead><tr><th>Name</th><th>Email</th><th>Computers</th><th>Systems</th><th>Countries</th><th>Newsletter</th><th>Last seen</th></tr></thead><tbody></tbody></table></div>
    <div id="detail" hidden></div>
  </section>
</main>
<script src="/admin/app.js"></script>
</body>
</html>
`;

export const ADMIN_CSS = `:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--accent:#2563eb;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--accent:#60a5fa;--bad:#f87171}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0}h2{font-size:15px;margin:28px 0 10px}h3{font-size:13px;margin:0 0 8px;color:var(--muted);font-weight:600}
main{max-width:1100px;margin:0 auto;padding:20px}
button,input{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
button{cursor:pointer}button:hover{border-color:var(--accent)}button.danger{color:var(--bad)}
input{min-width:240px}
#login{display:grid;gap:10px;max-width:360px;margin:60px auto}
.error{color:var(--bad);margin:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.tile,.group{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.tile b{display:block;font-size:24px}.tile span{color:var(--muted)}
.groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-top:12px}
.group table{width:100%}.group td:last-child{text-align:right;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600;white-space:nowrap}tbody tr[data-id]{cursor:pointer}tbody tr[data-id]:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}
.scroll{overflow-x:auto}#search{display:flex;gap:8px;margin-bottom:10px}
#detail{margin-top:16px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}
#detail .row{display:flex;flex-wrap:wrap;gap:8px 24px;margin-bottom:10px}#detail .row div span{color:var(--muted);display:block;font-size:12px}
`;

export const ADMIN_JS = `(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  let token = "";
  try { token = sessionStorage.getItem("registry-token") || ""; } catch { /* storage may be blocked */ }

  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) n[k] = v;
    for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k ?? "")));
    return n;
  };
  const when = (s) => (s ? new Date(s * 1000).toISOString().replace("T", " ").slice(0, 16) : "never");
  const api = async (path, init) => {
    const r = await fetch(path, { ...init, headers: { authorization: "Bearer " + token } });
    if (r.status === 401) { lock("The token was not accepted."); throw new Error("token"); }
    return r;
  };
  function lock(message) {
    token = "";
    try { sessionStorage.removeItem("registry-token"); } catch { /* ignore */ }
    $("#dash").hidden = true;
    for (const id of ["refresh", "export", "logout"]) $("#" + id).hidden = true;
    $("#login").hidden = false;
    const e = $("#login-error");
    e.hidden = !message; e.textContent = message || "";
  }
  const TITLES = { os: "System", arch: "Architecture", version: "App version", country: "Country", city: "Place", ram: "Memory", newsletter: "Newsletter", computersPerUser: "Computers per person" };
  async function load() {
    const s = await (await api("/admin/api/summary")).json();
    $("#login").hidden = true; $("#dash").hidden = false;
    for (const id of ["refresh", "export", "logout"]) $("#" + id).hidden = false;
    const tiles = $("#tiles"); tiles.replaceChildren();
    for (const [label, v] of [["People", s.users], ["Computers", s.installs], ["Active, 7 days", s.active_7d], ["Active, 30 days", s.active_30d], ["New, 7 days", s.new_7d]]) {
      tiles.append(el("div", { className: "tile" }, el("b", {}, v), el("span", {}, label)));
    }
    const groups = $("#groups"); groups.replaceChildren();
    for (const [key, title] of Object.entries(TITLES)) {
      const rows = s.groups[key] || [];
      const body = el("tbody", {});
      for (const r of rows) body.append(el("tr", {}, el("td", {}, r.k ?? "unknown"), el("td", {}, r.n)));
      groups.append(el("div", { className: "group" }, el("h3", {}, title), el("table", {}, body)));
    }
    await users();
  }
  async function users() {
    const q = encodeURIComponent($("#q").value.trim());
    const d = await (await api("/admin/api/users?limit=100&q=" + q)).json();
    const body = $("#users tbody"); body.replaceChildren();
    for (const u of d.users) {
      const tr = el("tr", { }, el("td", {}, u.name), el("td", {}, u.email), el("td", {}, u.installs), el("td", {}, u.systems || ""), el("td", {}, u.countries || ""), el("td", {}, u.newsletter_status), el("td", {}, when(u.last_seen)));
      tr.dataset.id = u.id;
      body.append(tr);
    }
  }
  async function detail(id) {
    const d = await (await api("/admin/api/users/" + id)).json();
    const box = $("#detail"); box.hidden = false; box.replaceChildren();
    const u = d.user;
    box.append(el("div", { className: "row" },
      ...[["Name", u.name], ["Email", u.email], ["Registered", when(u.created_at)], ["Agreed to notice", u.consent_notice + ", " + when(u.consent_at)], ["Newsletter", u.newsletter_status]].map(([k, v]) => el("div", {}, el("span", {}, k), v))));
    const head = el("tr", {}, ...["System", "Version", "Arch", "CPU cores", "Memory", "Locale", "Time zone", "App", "Place", "First seen", "Last seen", "Launches"].map((h) => el("th", {}, h)));
    const body = el("tbody", {});
    for (const i of d.installs) body.append(el("tr", {}, el("td", {}, i.os), el("td", {}, i.os_version), el("td", {}, i.arch), el("td", {}, i.cpu_cores), el("td", {}, i.ram_gb + " GB"), el("td", {}, i.locale), el("td", {}, i.tz), el("td", {}, i.app_version), el("td", {}, [i.city, i.region, i.country].filter(Boolean).join(", ")), el("td", {}, when(i.first_seen)), el("td", {}, when(i.last_seen)), el("td", {}, i.launches)));
    box.append(el("div", { className: "scroll" }, el("table", {}, el("thead", {}, head), body)));
    const del = el("button", { type: "button", className: "danger" }, "Delete this person and their computers");
    del.addEventListener("click", async () => {
      if (!confirm("Delete " + u.email + " with all their computers, and their newsletter contact?")) return;
      const r = await api("/admin/api/users/" + id, { method: "DELETE" });
      if (!r.ok) { alert("Not deleted (" + r.status + "). The newsletter provider did not answer; try again."); return; }
      box.hidden = true; await load();
    });
    box.append(el("p", {}, del));
  }
  $("#login").addEventListener("submit", async (e) => {
    e.preventDefault();
    token = $("#token").value; $("#token").value = "";
    try { sessionStorage.setItem("registry-token", token); } catch { /* ignore */ }
    try { await load(); } catch { /* lock() already explained */ }
  });
  $("#search").addEventListener("submit", (e) => { e.preventDefault(); void users(); });
  $("#users tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) void detail(tr.dataset.id); });
  $("#refresh").addEventListener("click", () => void load());
  $("#logout").addEventListener("click", () => lock(""));
  $("#export").addEventListener("click", async () => {
    const r = await api("/admin/api/export.csv");
    const url = URL.createObjectURL(await r.blob());
    const a = el("a", { href: url, download: "intelyide-registry.csv" });
    document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });
  if (token) load().catch(() => {});
})();
`;
