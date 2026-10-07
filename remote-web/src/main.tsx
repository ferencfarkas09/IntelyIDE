import { render } from "solid-js/web";
import "@ui/theme/fonts.css";
import "@ui/theme/tokens.css";
import "@ui/theme/global.css";
import "@ui/ui-kit/controls.css";
import "@ui/ui-kit/display.css";
import "./styles/mobile.css";
import App from "./App";
import { registerServiceWorker } from "./sw-register";

// Follow the system light/dark setting (dark is the token default); ?theme=light|dark is a screenshot aid.
const media = matchMedia("(prefers-color-scheme: light)");
const forced = new URLSearchParams(location.search).get("theme");
const apply = () => document.documentElement.setAttribute("data-theme", forced === "light" || forced === "dark" ? forced : media.matches ? "light" : "dark");
apply();
media.addEventListener("change", apply);

render(() => <App />, document.getElementById("root")!);
registerServiceWorker();
