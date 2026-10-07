import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Second build: the service worker as one classic script at exactly dist/sw.js (no hash in the name, browsers fetch it by that URL
// for updates). Runs after the main build, so `emptyOutDir` must stay false. `public/sw.js` no longer exists, so nothing clashes.
export default defineConfig({
  publicDir: false,
  clearScreen: false,
  build: {
    target: "safari15",
    outDir: "dist",
    emptyOutDir: false,
    minify: true,
    lib: { entry: fileURLToPath(new URL("src/sw/index.ts", import.meta.url)), name: "intelySw", formats: ["iife"], fileName: () => "sw.js" },
  },
});
