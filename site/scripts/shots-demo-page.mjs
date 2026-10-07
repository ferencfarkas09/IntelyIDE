// The fictional "Acme Shop" admin dashboard that the Preview shot embeds (served by capture-shots.mjs on a loopback port).
// Self-contained HTML, no external requests. Light and dark follow prefers-color-scheme.
const rows = [
  ["#10482", "Maya Lindqvist", "Paid", "$128.40", "2 min ago"],
  ["#10481", "Daniel Okafor", "Shipped", "$46.00", "14 min ago"],
  ["#10480", "Sofia Ricci", "Paid", "$212.75", "31 min ago"],
  ["#10479", "Jonas Berg", "Refunded", "$19.90", "1 h ago"],
  ["#10478", "Amara Nwosu", "Shipped", "$87.15", "2 h ago"],
  ["#10477", "Liam Carter", "Paid", "$64.30", "3 h ago"],
];
const kpis = [
  ["Revenue", "$48,290.00", "+12.4%", true],
  ["Orders", "1,284", "+8.1%", true],
  ["Average order", "$37.61", "+3.2%", true],
  ["Loyalty members", "3,902", "+211", true],
];
const pts = [22, 28, 25, 34, 31, 40, 38, 47, 44, 55, 52, 63];
const W = 640, H = 170;
const xy = pts.map((v, i) => [Math.round((i * W) / (pts.length - 1)), Math.round(H - (v / 70) * H)]);
const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");

export const DEMO_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme Shop Admin</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--ink:#14161f;--mute:#667085;--line:#e6e8ef;--acc:#7c5cf0;--acc2:#e7e1fd;--ok:#12805c;--okbg:#dff5ec;--warn:#9a6700;--warnbg:#fdf0cc;--bad:#b42318;--badbg:#fde4e1}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--card:#171a23;--ink:#eceef5;--mute:#98a2b3;--line:#262a36;--acc:#9d83ff;--acc2:#2a2347;--ok:#5fd6a6;--okbg:#12362b;--warn:#f2c14e;--warnbg:#3a2f12;--bad:#ff8a80;--badbg:#3c1a17}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;display:flex;min-height:100vh}
aside{width:200px;background:var(--card);border-right:1px solid var(--line);padding:18px 12px;flex:none}
.logo{display:flex;align-items:center;gap:9px;font-weight:700;font-size:16px;padding:2px 8px 18px}.logo i{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#7c5cf0,#e8669a)}
nav a{display:block;padding:8px 10px;border-radius:8px;color:var(--mute);margin-bottom:2px;font-weight:500}nav a.on{background:var(--acc2);color:var(--acc)}
main{flex:1;padding:22px 26px;min-width:0}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}h1{font-size:20px;margin:0}
.pill{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:5px 12px;color:var(--mute);font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.k small{color:var(--mute);display:block;margin-bottom:4px}.k b{font-size:22px;letter-spacing:-.02em}.k em{font-style:normal;color:var(--ok);font-size:12px;margin-left:6px}
.grid{display:grid;grid-template-columns:1.25fr 1fr;gap:12px}h2{font-size:13px;margin:0 0 10px;color:var(--mute);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse}td,th{padding:8px 4px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}th{color:var(--mute);font-weight:500}tr:last-child td{border:0}td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
.tag{padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}.Paid{background:var(--okbg);color:var(--ok)}.Shipped{background:var(--acc2);color:var(--acc)}.Refunded{background:var(--badbg);color:var(--bad)}
svg{width:100%;height:auto;display:block}.axis{display:flex;justify-content:space-between;color:var(--mute);font-size:11px;margin-top:6px}
</style></head><body>
<aside><div class="logo"><i></i>Acme Shop</div><nav><a class="on">Dashboard</a><a>Orders</a><a>Customers</a><a>Loyalty</a><a>Inventory</a><a>Reports</a><a>Settings</a></nav></aside>
<main><header><h1>Dashboard</h1><span class="pill">Last 30 days</span></header>
<div class="kpis">${kpis.map(([a, b, c]) => `<div class="card k"><small>${a}</small><b>${b}</b><em>${c}</em></div>`).join("")}</div>
<div class="grid"><div class="card"><h2>Revenue</h2><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c5cf0" stop-opacity=".35"/><stop offset="1" stop-color="#7c5cf0" stop-opacity="0"/></linearGradient></defs><path d="${line} L${W},${H} L0,${H} Z" fill="url(#g)"/><path d="${line}" fill="none" stroke="#7c5cf0" stroke-width="2.5" stroke-linejoin="round"/></svg><div class="axis"><span>Sep 5</span><span>Sep 15</span><span>Sep 25</span><span>Oct 4</span></div></div>
<div class="card"><h2>Recent orders</h2><table><tr><th>Order</th><th>Customer</th><th>Status</th><th class="r">Total</th></tr>${rows.map(([a, b, c, d]) => `<tr><td>${a}</td><td>${b}</td><td><span class="tag ${c}">${c}</span></td><td class="r">${d}</td></tr>`).join("")}</table></div></div>
</main></body></html>`;
