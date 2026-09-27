import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration files share real PostgreSQL/MinIO and spawn Workers.
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
  },
});
