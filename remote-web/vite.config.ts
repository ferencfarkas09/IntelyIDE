import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

// The design tokens and kit parts are imported straight from ../ui/src (one source of truth). solid-js and lucide-solid are
// deduped to this package's copy so the shared kit and the PWA run on one reactive runtime.
export default defineConfig({
  plugins: [solid()],
  base: "/",
  clearScreen: false,
  resolve: { dedupe: ["solid-js", "lucide-solid"], alias: { "@ui": fileURLToPath(new URL("../ui/src", import.meta.url)) } },
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
  build: {
    target: "safari15",
    outDir: "dist",
    emptyOutDir: true,
    // No inline scripts or styles anywhere (CSP script-src/style-src 'self'): small assets stay files.
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: { input: { index: here + "index.html" } },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: ["test/e2e/**", "node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 2,
  },
});
