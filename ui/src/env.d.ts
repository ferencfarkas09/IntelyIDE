interface Window {
  __INTELY_MODE__?: string;
  __INTELY_RAF__?: boolean;
  __TAURI_INTERNALS__?: unknown;
}

interface ImportMetaEnv {
  readonly DEV: boolean;
  /** Set to keep the mock IPC in a production bundle (browser-only demos). */
  readonly VITE_MOCK_IPC?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
