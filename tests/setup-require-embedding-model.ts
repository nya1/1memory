import { beforeAll } from "vitest";
import { isBundledEmbeddingModelPresent } from "../src/embeddings/bundled-paths.js";

beforeAll(() => {
  if (!isBundledEmbeddingModelPresent()) {
    throw new Error(
      "Bundled ONNX embedding model is missing (expected under models/paraphrase-MiniLM-L3-v2/). " +
        "Run `pnpm run setup:embeddings` (or `pnpm install`, which runs it via postinstall) before running tests."
    );
  }
});
