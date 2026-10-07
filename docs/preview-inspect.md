# Click-to-source for the embedded preview

Alt/Cmd+click (or the Inspect toggle) on an element of the live preview opens the file and line that rendered it, in an editor tab. Code: `ui/src/modules/preview-inspect/**`, `crates/preview-proxy/**`, `scripts/preview/**`. Safety rules: `docs/safety.md` (section "Preview proxy and Run panel").

## Decision: loopback proxy, not a child webview

| | (a) Rust loopback reverse proxy that injects the script | (b) Tauri child webview with an initialization script |
|---|---|---|
| Delivery | `<script src="/__intely/inspect.js">` injected after `<head>` into `text/html`; the proxy serves the script itself | `initialization_script` on a second native webview |
| Channel | `postMessage` to the parent iframe, validated by the IDE | Tauri IPC from a webview that would need a capability: the page gets a door into `invoke` |
| Layout | Stays a normal iframe in the tab/dock (device toolbar, scaling, side by side with code) | Native overlay window: cannot be scaled, clipped, tabbed or stacked under dialogs; marked `unstable` in Tauri 2 |
| Security | No capability for the frame origin; `script-src` of the IDE untouched; the proxy adds Host/Origin checks and a port allow-list | A webview with IPC next to untrusted page code, plus `unstable` APIs |
| Robustness cost | HMR passthrough, gzip, redirects (all tested, see below) | Focus, z-order, screenshots, resize bugs on macOS |

Chosen: (a). Verified in a real browser (`scripts/preview/e2e-inspect.mjs`): SSE `/__webpack_hmr` streams event by event, a WebSocket upgrade tunnels both ways, `X-Frame-Options: DENY` from the dev server is stripped so the frame renders, and plain clicks still reach the app.

## Ladder (confidence shown in the toast / picker)

| Rung | Source | Result | Label |
|---|---|---|---|
| 1 | `fiber._debugSource` (React <= 18 with the jsx-source option, see "Getting exact sources") | exact file:line:col of the clicked JSX element | exact source |
| 1b | element is rendered by library code (`node_modules`): walk `_debugOwner`, take the first call site in user code | the line where the user's code wrote `<Button>` | exact source (library code is marked if nothing better exists) |
| 3 | React 19 `fiber._debugStack`: first non-React frame; `webpack-internal:` paths directly, bundle URLs through the bundle's source map (fetched through the proxy, decoded in the page) | exact file:line | exact source |
| 3b | `data-loc="file:line:col"` attribute on the element or an ancestor | exact | exact source |
| 4 | component name from the owner chain (`displayName`, `name`, memo/forwardRef unwrapped) | `git grep`/`rg` for `function Name`, `const Name`, `let Name`, `var Name`, `class Name` in the preview's repo (POSIX ERE, runs on both backends, through the existing `ipc.search`), ranked (file named after the component, `export`, `src/`, tests last); one hit opens, several open a picker | matched by component name |

A `REACT_EDITOR`/`launch-editor` socket route is not implemented.

## Message contract (page to IDE)

The page script posts exactly one message, `{ intely: "inspect/1", file, line, col, componentName }`, to `window.parent`. Nothing else leaves the page: no DOM, props, state, storage, cookies, headers or network data. Name-only hints have `file: ""`, `line: 0`, `col: 0`. The IDE sends `{ intely: "inspect.mode/1", on }` to the frame, addressed to the frame's own origin.

The IDE side (`protocol.ts`, `paths.ts`, `PickerAndWatcher.tsx`) treats every message as an untrusted hint:

1. accepted only from a window that is currently an `iframe[data-intely-preview]` (`event.source === frame.contentWindow`) and only when `event.origin` equals the frame's own loopback origin;
2. strict parse: plain object, exactly the five keys, no accessors or symbols, integers in range, no control or bidi characters, bounded lengths, component names limited to identifier-like characters;
3. throttled (150 ms);
4. the path is NFC-normalised, `..` is refused (never "fixed up"), and it must resolve under a registered repo root by whole path segments (`/r/app-evil` is not inside `/r/app`; the longest root wins for nested repos); relative paths resolve only against the preview tab's repo; a path that fails is never opened and never trusted again (the name lookup runs instead, scoped to registered repos, and the user confirms in the picker);
5. opening is `execute("editor.openFile", ...)`, i.e. read-only navigation; symlinks are resolved by the files layer. `crates/preview-proxy/src/jail.rs` has the same check with `canonicalize` for a future Rust-side resolver (tested: symlink out of the repo, sibling directory with a shared prefix).

## How it is wired

`src-tauri/src/modules/preview.rs` has `preview_proxy_start(url)` / `preview_proxy_stop(upstreamPort)` (`ipc.preview.proxyStart/proxyStop`); the view loads `viaProxy(address, proxy.url)` and falls back to the plain address when no proxy can start; the iframe carries `data-intely-preview` and `data-repo-id`; the toolbar has an Inspect button (`preview.inspect.toggle`, which sets `data-intely-inspecting` on `document.documentElement` while on). One proxy per upstream port, reused, at most 8, stopped on quit. `allowed_ports` is just that one port (the address the user typed passed the loopback gate); in the E2E jail the port must belong to a live Run-panel server (`testJail` otherwise). Upstream is `127.0.0.1`, or `::1` when only that answers. Tested end to end by `scripts/e2e/run.sh --only y,y2`.

Without the proxy the frame still works; Alt/Cmd+click then does nothing because no script is injected. This module needs no CSP change.

## Proxy (`crates/preview-proxy`)

`127.0.0.1` only, random port, one proxy per dev server, one request per connection (`Connection: close` both ways). Refused: non-loopback upstream, a port not in `allowed_ports`, a `Host` that is not this proxy's loopback address (DNS rebinding; the dev server is never contacted), a non-loopback or `null` `Origin`, oversized or malformed heads (64 KiB), redirects that leave the upstream (relayed only when they point at the upstream's own origin, rewritten to the proxy's). Rewritten: `Host`, `Origin`, `Referer` toward the upstream; `Accept-Encoding: identity` (HTML is never compressed, so no decompression code is needed; an already compressed HTML is passed through untouched, without injection). Stripped: `X-Frame-Options` and the `frame-ancestors` directive. Streaming: non-HTML bodies are copied as they arrive (SSE, large assets, EventSource), chunked HTML is decoded, injected and sent with `Content-Length`. Never logged: headers, bodies, cookies. Known limits: HTTP/1.1 over plain `http://` only (an https dev server is not proxied), a page CSP that forbids same-origin scripts blocks the inspector (dev servers rarely send one), service workers can serve a cached HTML without the tag (reload, or unregister).

## Getting exact sources (bring your own Babel or Vite config)
The exact-source rungs need the dev build to carry JSX source information. With Babel, enable the development mode of the React preset so every element gets `__source` (file, line, column), for example `presets: [[require.resolve('@babel/preset-react'), { development: true }]]` in the dev-only Babel or babel-loader options; with Vite or esbuild use the `jsxDEV` development transform (the default in dev). Keep it out of the production config. Restart the dev server afterwards (bundler caches key on the config). Without it the ladder falls back to the component name (rung 4). IntelyIDE never edits your build configuration.

## Tests

| What | Command |
|---|---|
| Proxy (27 tests: pure rules, real sockets against a scripted dev server: injection, chunked, gzip passthrough, SSE streaming, WebSocket tunnel, redirects, Host/Origin/port refusals, 400 on junk) | `CARGO_TARGET_DIR=... nice -n 10 cargo test -p intely-preview-proxy -j 2` |
| UI (protocol/security, paths, name lookup, open flow, page-script mapping, watcher with a real iframe) | `cd ui && nice -n 10 npx vitest run src/modules/preview-inspect --maxWorkers=2` |
| Real browser, four fixtures (Babel classic, esbuild jsxDEV, no plugin = name only, React 19 `_debugStack` + source map) through the real proxy, headless Chrome | `node scripts/preview/e2e-inspect.mjs [--only <variant>] [--shots <dir>]` (first run installs fixture deps into `.scratch/preview-e2e`) |
