import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-require-embedding-model.ts"],
    /** ONNX + tokenizer load is heavy; avoid N parallel cold loads across test files. */
    fileParallelism: false,
    testTimeout: 120000
  }
});
