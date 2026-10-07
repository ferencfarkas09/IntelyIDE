import { call } from "./rpc";

/** A loopback address the Rust side accepted, normalised: this exact string is what the frame loads. */
export interface PreviewTarget {
  url: string;
  host: string;
  port: number;
  origin: string;
}

export interface ProbeResult {
  /** A TCP connect to the loopback address succeeded: something listens there. */
  reachable: boolean;
  port: number;
  ms: number;
}

/** The click-to-source reverse proxy in front of one dev-server port: the frame loads `url` (its origin) plus the page path. */
export interface ProxyInfo {
  url: string;
  port: number;
  upstreamPort: number;
}

/**
 * The Rust gate of the preview (`src-tauri/src/modules/preview.rs`). The UI validates first (`validatePreviewUrl`); these
 * commands repeat the check, so a bug or a tampered webview cannot widen what is probed or opened.
 * Rejections carry the code of the refusal: `empty`, `tooLong`, `badChars`, `scheme`, `credentials`, `notLoopback`, `badPort`,
 * `selfOrigin`. The preview never starts or stops a server; `probe` only connects to `127.0.0.1` / `::1`.
 */
export interface PreviewIpc {
  checkUrl(url: string): Promise<PreviewTarget>;
  probe(url: string): Promise<ProbeResult>;
  /** Opens the (re-validated) loopback address in the system browser. Refused in the E2E jail. */
  openExternal(url: string): Promise<void>;
  /**
   * Starts (or reuses) the loopback proxy that injects the click-to-source script into the dev server's HTML
   * (`docs/preview-inspect.md`). Same URL gate as `checkUrl`; in the E2E jail only a port a Run-panel server listens on.
   * Nothing is started on the dev server's side. Rejects when the proxy cannot start: the caller loads the address directly.
   */
  proxyStart(url: string): Promise<ProxyInfo>;
  /** Stops the proxy of one upstream port (no-op when there is none). */
  proxyStop(upstreamPort: number): Promise<void>;
}

export function createTauriPreview(): PreviewIpc {
  return {
    checkUrl: (url) => call("preview_check_url", { url }),
    probe: (url) => call("preview_probe", { url }),
    openExternal: (url) => call("preview_open_external", { url }),
    proxyStart: (url) => call("preview_proxy_start", { url }),
    proxyStop: (upstreamPort) => call("preview_proxy_stop", { upstreamPort }),
  };
}
