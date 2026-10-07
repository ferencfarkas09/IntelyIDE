import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  base: "./",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", outDir: "dist", emptyOutDir: true },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"], testTimeout: 30_000, hookTimeout: 30_000 },
});
