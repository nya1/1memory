import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDING_MODEL_DIR, EMBEDDING_ONNX_REL } from "./constants.js";

/** Package `models/` root (works for `src/` via tsx and `dist/` when compiled). */
export function resolveBundledModelsRoot(): string {
  return path.resolve(fileURLToPath(new URL("../../models", import.meta.url)));
}

export function resolveBundledModelDir(): string {
  return path.join(resolveBundledModelsRoot(), EMBEDDING_MODEL_DIR);
}

export function bundledModelOnnxPath(): string {
  return path.join(resolveBundledModelDir(), EMBEDDING_ONNX_REL);
}

export function isBundledEmbeddingModelPresent(): boolean {
  try {
    return fs.existsSync(bundledModelOnnxPath());
  } catch {
    return false;
  }
}
