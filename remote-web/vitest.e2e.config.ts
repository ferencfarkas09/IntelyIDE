import { defineConfig } from "vitest/config";

// End to end: wrangler dev (loopback) + headless Chrome (390x844) + the fake Mac. One worker, long timeouts; run on its own
// (`pnpm e2e`), never together with a build or another suite.
export default defineConfig({
  test: { environment: "node", include: ["test/e2e/**/*.e2e.test.ts"], testTimeout: 120_000, hookTimeout: 300_000, maxWorkers: 1, fileParallelism: false },
});
