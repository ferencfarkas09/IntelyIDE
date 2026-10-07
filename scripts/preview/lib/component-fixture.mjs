// Throwaway fixture repo for the component preview (mktemp; node_modules is a symlink to the cached deps-b install).
// Used by e2e-component.mjs and shots-component.mjs. Never a real repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createFixture(depsB) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "intely-pvc-")));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "intely-pvc-state-"));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  fs.symlinkSync(path.join(depsB, "node_modules"), path.join(repo, "node_modules"));
  write("package.json", JSON.stringify({ name: "fixture-app", private: true, dependencies: { react: "18" } }));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { jsx: "react", baseUrl: "src", paths: { "@ui/*": ["components/*"] } } }));
  write("src/components/Greeting.css", ".greet{color:rgb(10,120,200);font-weight:700}\n");
  write("src/components/Greeting.jsx", `import React from "react";
  import "./Greeting.css";
  export default function Greeting({ name = "World", onClick }) {
    return (
      <div className="greet">
        <h1 id="h">Hello {name}</h1>
        <button id="b" onClick={() => onClick && onClick(name)}>Greet</button>
      </div>
    );
  }
  `);
  write("src/components/Boom.jsx", `import React from "react";
  export function Boom({ explode }) {
    if (explode) throw new Error("kaboom: bad props");
    return <p id="calm">calm</p>;
  }
  export const NotAComponent = 5;
  `);
  write("src/components/Remote.jsx", `import React, { useEffect, useState } from "react";
  export default function Remote() {
    const [msg, setMsg] = useState("pending");
    useEffect(() => { fetch("https://example.com/api?token=SECRET123").then(() => setMsg("reached")).catch((e) => setMsg(e.message)); }, []);
    return <p id="net">{msg}</p>;
  }
  `);
  write("src/components/Themed.tsx", `import * as React from "react";
  import { Greeting } from "@ui/Named";
  export default function Themed(props: { label: string }) {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return <section id="t"><span id="mode">{dark ? "dark" : "light"}</span> {props.label} <Greeting /></section>;
  }
  `);
  write("src/components/Named.tsx", `import * as React from "react";
  export const Greeting = () => <b id="named">named export</b>;
  `);
  write("src/pages/Login.js", `import React from "react";
  export default function Login({ title = "Sign in" }) {
    return (
      <form id="login" onSubmit={(e) => e.preventDefault()} style={{ maxWidth: 320 }}>
        <h2>{title}</h2>
        <label>Email <input id="email" type="email" /></label>
        <label>Password <input id="pw" type="password" /></label>
        <button type="submit">Sign in</button>
      </form>
    );
  }
  `);
  write("src/pages/OrderList.jsx", `import React from "react";
  import { useSelector, useDispatch } from "react-redux";
  import { Link } from "react-router-dom";
  import Button from "@mui/material/Button";
  import { useTheme } from "@mui/material/styles";
  export default function OrderList() {
    const orders = useSelector((s) => s.orders);
    const dispatch = useDispatch();
    const theme = useTheme();
    return (
      <div>
        <p id="mui-mode">{theme.palette.mode}</p>
        <table id="orders"><tbody>{orders.map((o) => <tr key={o.id}><td><Link to={"/o/" + o.id}>{o.id}</Link></td><td>{o.total}</td></tr>)}</tbody></table>
        <Button id="refresh" variant="contained" onClick={() => dispatch({ type: "orders/refresh" })}>Refresh</Button>
      </div>
    );
  }
  `);
  return { repo, stateDir, write };
}
