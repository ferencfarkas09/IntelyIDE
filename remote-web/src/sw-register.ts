// Registers the service worker (built from src/sw to dist/sw.js): verified shell cache + offline start + content-free push, and
// starts the page's side (sw/page.ts): a build check now and every 6 hours. Skipped on `vite dev`.
import { refreshPinState, watchWorker } from "./sw/page";

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  addEventListener("load", () => {
    void refreshPinState();
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(() => void watchWorker())
      .catch(() => {
        /* no service worker (private mode, http): the app still works online */
      });
  });
}
