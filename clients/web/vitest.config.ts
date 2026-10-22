import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The data-layer tests share one database and start each file from empty, so
    // files run one after another. The suite is small; correctness beats speed.
    fileParallelism: false,
    // A database service may be slow to answer the first time.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
