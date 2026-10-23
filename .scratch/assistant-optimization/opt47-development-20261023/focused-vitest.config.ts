import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/unit/assistant-processing-preparation.test.ts",
      "tests/unit/assistant-candidates.test.ts",
      "tests/unit/assistant-plan.test.ts",
      "tests/unit/data-selection.test.ts",
      "tests/unit/assistant-tool-repair-runtime.test.ts",
      "tests/unit/assistant-execution-receipts.test.ts",
      "tests/integration/assistant-processing-preflight.test.ts",
      "tests/integration/project-assistant.test.ts",
      "tests/integration/assistant-intent.test.ts",
      "tests/integration/assistant-recovery.test.ts",
      "tests/integration/processing-runs.test.ts",
      "tests/integration/data-selection.test.ts",
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    setupFiles: ["tests/setup.ts"],
  },
});
