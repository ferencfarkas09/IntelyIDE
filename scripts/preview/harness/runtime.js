// The mounting half of the harness: builds the wrapper chain (stubbed theme / Redux store / router), renders the chosen
// export inside an error boundary and applies what the IDE sends (props, store, wrappers, color scheme, layout).
// The IDE's message is data only: JSON props, with two markers: {"$fn":"name"} (a logging stub function) and
// {"$date":"ISO"}. Nothing the IDE sends is ever evaluated.
import { PROTOCOL, applyScheme, currentScheme, describeError, inIde, logEvent, post, showFatal } from "./early.js";
import { snapshot } from "./shot.js";

const MAX_STACK_LINES = 14;

export function reviveProps(value) {
  if (Array.isArray(value)) return value.map(reviveProps);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$fn" && typeof value.$fn === "string") {
      const name = value.$fn;
      return (...args) => {
        logEvent("fn", `${name}(${args.map((a) => (a && a.nativeEvent ? "event" : safe(a))).join(", ")})`);
        return undefined;
      };
    }
    if (keys.length === 1 && keys[0] === "$date" && typeof value.$date === "string") return new Date(value.$date);
    const out = {};
    for (const k of keys) if (k !== "__proto__" && k !== "constructor" && k !== "prototype") out[k] = reviveProps(value[k]);
    return out;
  }
  return value;
}

function safe(v) {
  try {
    const s = typeof v === "string" ? JSON.stringify(v) : typeof v === "function" ? "fn" : JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 60)}...` : s;
  } catch {
    return "[object]";
  }
}

const lines = (s, n) => String(s ?? "").split("\n").slice(0, n).join("\n");

export function boot({ React, ReactDOM, createRoot, Mod, exportName, file, libs }) {
  const h = React.createElement;
  const Component = exportName === "default" ? Mod.default : Mod[exportName];
  const exportsList = Object.keys(Mod).filter((k) => {
    const v = Mod[k];
    return typeof v === "function" || (v && typeof v === "object" && v.$$typeof);
  });
  const available = {
    redux: !!libs.ReactRedux?.Provider,
    mui: !!libs.MuiStyles?.ThemeProvider,
    styled: !!libs.SC?.ThemeProvider,
    router: !!libs.RR?.MemoryRouter,
  };
  const name = (Component && (Component.displayName || Component.name)) || exportName;

  const state = { props: {}, store: {}, wrappers: { theme: false, redux: false, router: false }, scheme: "dark", layout: "padded", route: "/", version: 0 };
  let setVersion = () => {};
  let storeObj = null;
  let storeJson = "";

  const stubStore = () => {
    const json = JSON.stringify(state.store);
    if (storeObj && json === storeJson) return storeObj;
    storeJson = json;
    const snapshotState = reviveProps(state.store);
    storeObj = {
      getState: () => snapshotState,
      dispatch: (action) => {
        logEvent("dispatch", action && typeof action === "object" ? String(action.type ?? "action") : typeof action === "function" ? "thunk (not run)" : "action");
        return action;
      },
      subscribe: () => () => {},
      replaceReducer: () => {},
    };
    return storeObj;
  };

  class Boundary extends React.Component {
    constructor(p) {
      super(p);
      this.state = { error: null, info: null };
    }
    static getDerivedStateFromError(error) {
      return { error };
    }
    componentDidUpdate(prev) {
      // New props, store or scheme give the component another chance; its state is kept while it renders fine.
      if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, info: null });
    }
    componentDidCatch(error, info) {
      const d = describeError(error);
      this.setState({ info });
      post({ intely: PROTOCOL.status, state: "renderError", name: d.name, message: d.message, stack: d.stack, componentStack: lines(info?.componentStack, MAX_STACK_LINES) });
    }
    render() {
      const { error, info } = this.state;
      if (!error) return this.props.children;
      const d = describeError(error);
      return h(
        "div",
        { role: "alert", "data-intely-error": "", style: { font: "13px/1.5 system-ui,sans-serif", padding: 16, border: "1px solid #d95b5b", borderRadius: 8, background: "rgba(217,91,91,.12)" } },
        h("strong", null, `${d.name}: this component threw while rendering`),
        h("div", { style: { margin: "6px 0", whiteSpace: "pre-wrap" } }, d.message),
        info?.componentStack ? h("pre", { style: { font: "12px ui-monospace,monospace", opacity: 0.8, overflow: "auto", margin: "6px 0" } }, `Component stack:${lines(info.componentStack, MAX_STACK_LINES)}`) : null,
        h("details", null, h("summary", null, "JavaScript stack"), h("pre", { style: { font: "12px ui-monospace,monospace", opacity: 0.8, overflow: "auto" } }, d.stack)),
      );
    }
  }

  function wrap(node) {
    let out = node;
    if (state.wrappers.theme) {
      const mode = state.scheme;
      if (libs.MuiStyles?.ThemeProvider && libs.MuiStyles.createTheme) out = h(libs.MuiStyles.ThemeProvider, { theme: libs.MuiStyles.createTheme({ palette: { mode } }) }, out);
      if (libs.SC?.ThemeProvider) out = h(libs.SC.ThemeProvider, { theme: { mode, palette: { mode } } }, out);
    }
    if (state.wrappers.router && libs.RR?.MemoryRouter) out = h(libs.RR.MemoryRouter, { initialEntries: [state.route] }, out);
    if (state.wrappers.redux && libs.ReactRedux?.Provider) out = h(libs.ReactRedux.Provider, { store: stubStore() }, out);
    return out;
  }

  function Root() {
    const [version, set] = React.useState(0);
    setVersion = set;
    void version;
    const missing = typeof Component !== "function" && !(Component && typeof Component === "object" && Component.$$typeof);
    if (missing) {
      return h(
        "div",
        { role: "alert", "data-intely-error": "", style: { font: "13px/1.5 system-ui,sans-serif", padding: 16, border: "1px solid #d95b5b", borderRadius: 8, background: "rgba(217,91,91,.12)" } },
        h("strong", null, `Export "${exportName}" of ${file} is not a React component.`),
        h("div", null, `Components found in this file: ${exportsList.join(", ") || "none"}.`),
      );
    }
    const props = reviveProps(state.props);
    const stage = h("div", { id: "intely-stage", style: { padding: state.layout === "padded" ? 16 : 0, minHeight: state.layout === "padded" ? undefined : "100vh", boxSizing: "border-box" } }, h(Component, props));
    return h(Boundary, { resetKey: JSON.stringify([state.props, state.store, state.wrappers, state.scheme, state.route]) }, wrap(stage));
  }

  const rootEl = document.getElementById("root");
  let mounted = false;
  function mount() {
    if (mounted) return;
    mounted = true;
    applyScheme(state.scheme);
    try {
      if (createRoot) createRoot(rootEl).render(h(Root));
      else ReactDOM.render(h(Root), rootEl);
    } catch (e) {
      showFatal(describeError(e));
    }
    post({ intely: PROTOCOL.status, state: "ok", name });
  }
  const rerender = () => {
    state.version += 1;
    setVersion(state.version);
  };

  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.intely === PROTOCOL.set) {
      if (m.props && typeof m.props === "object") state.props = m.props;
      if (m.store && typeof m.store === "object") state.store = m.store;
      if (m.wrappers && typeof m.wrappers === "object") state.wrappers = { theme: !!m.wrappers.theme, redux: !!m.wrappers.redux, router: !!m.wrappers.router };
      if (m.layout === "padded" || m.layout === "full") state.layout = m.layout;
      if (typeof m.route === "string" && m.route.startsWith("/") && m.route.length < 200) state.route = m.route;
      if (m.scheme === "light" || m.scheme === "dark") {
        state.scheme = m.scheme;
        applyScheme(m.scheme);
      }
      if (!mounted) mount();
      else rerender();
    } else if (m.intely === PROTOCOL.shotReq) {
      const id = typeof m.id === "string" ? m.id.slice(0, 64) : "";
      const scale = m.scale === 2 ? 2 : 1;
      const target = document.getElementById("intely-stage") ?? rootEl;
      snapshot(target, { scale, background: currentScheme() === "dark" ? "#1b1d22" : "#ffffff" })
        .then((r) => post({ intely: PROTOCOL.shot, id, ok: true, ...r }))
        .catch((err) => post({ intely: PROTOCOL.shot, id, ok: false, error: String(err?.message ?? err) }));
    } else if (m.intely === PROTOCOL.hello) {
      post({ intely: PROTOCOL.ready, name, file, exports: exportsList, available, build: window.__INTELY_BUILD__ ?? 0 });
    }
  });

  post({ intely: PROTOCOL.ready, name, file, exports: exportsList, available, build: window.__INTELY_BUILD__ ?? 0 });
  // Outside the IDE (opened in a browser): render right away. Inside: wait for the IDE's props, but never forever.
  if (!inIde) mount();
  else setTimeout(mount, 1500);
}
