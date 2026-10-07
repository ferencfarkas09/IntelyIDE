export interface AboutInfo {
  app: string;
  tauri: string | null;
  webview: string;
  /** `desktop` in the Tauri window, `browser` for the mock UI in a plain browser. */
  host: "desktop" | "browser";
}

/** The app and Tauri versions come from the Tauri app plugin; in a browser there is no app to ask. */
export async function loadAbout(): Promise<AboutInfo> {
  const webview = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return { app: "dev", tauri: null, webview, host: "browser" };
  try {
    const { getVersion, getTauriVersion } = await import("@tauri-apps/api/app");
    const [app, tauri] = await Promise.all([getVersion(), getTauriVersion()]);
    return { app, tauri, webview, host: "desktop" };
  } catch {
    return { app: "unknown", tauri: null, webview, host: "desktop" };
  }
}

/** `Mozilla/5.0 (Macintosh; ...) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15` -> `WebKit 605.1.15`. */
export function webviewLabel(userAgent: string): string {
  const match = /AppleWebKit\/([\d.]+)/.exec(userAgent);
  return match ? `WebKit ${match[1]}` : userAgent ? "Unknown webview" : "—";
}
