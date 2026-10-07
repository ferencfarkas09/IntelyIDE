/* @refresh reload */
import "./boot";
import { render } from "solid-js/web";
import { App } from "./app/App";
import { trackStartup } from "./perf";
import { localeReady } from "./i18n";

const root = document.getElementById("root")!;
const mode = window.__INTELY_MODE__;

if (new URLSearchParams(location.search).get("view") === "kit") {
  // Design-system gallery (owned by ui-kit).
  void import("./ui-kit/gallery/mount").then((m) => m.mountGallery(root));
} else if (mode === "empty" || mode === "rich") {
  void import("./spike/mount").then((m) => m.mountSpike(mode, root));
} else {
  // The language catalog is a tiny lazy chunk (English is bundled and resolves at once): wait for it so the first paint is not English.
  void localeReady.then(() => {
    performance.mark("app:render");
    render(() => <App />, root);
    performance.mark("app:rendered");
    if (window.__TAURI_INTERNALS__) trackStartup();
  });
}
