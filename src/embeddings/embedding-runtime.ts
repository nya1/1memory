import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env, pipeline } from "@huggingface/transformers";
import { resolveOneMemoryPaths } from "../config/paths.js";
import { readConfig, writeConfig } from "../config/config-store.js";
import { EMBEDDING_MODEL_DIM, EMBEDDING_MODEL_DIR } from "./constants.js";
import { bundledModelOnnxPath, isBundledEmbeddingModelPresent, resolveBundledModelDir, resolveBundledModelsRoot } from "./bundled-paths.js";

type FeatureExtractor = (
  texts: string,
  options?: { pooling?: "mean"; normalize?: boolean }
) => Promise<{ data: Float32Array | Int32Array | number[]; dims?: number[] }>;

let envConfigured = false;
let extractorPromise: Promise<FeatureExtractor> | null = null;
let lastInitError: string | null = null;
/** Cached outcome of the last full init attempt (model present + load succeeded). */
let vectorRetrievalReady = false;

function skipEmbeddings(): boolean {
  return process.env.ONEMEMORY_SKIP_EMBEDDINGS === "1";
}

function configureTransformersEnv(): void {
  if (envConfigured) return;
  envConfigured = true;
  const paths = resolveOneMemoryPaths();
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = `${resolveBundledModelsRoot()}${path.sep}`;
  env.cacheDir = path.join(paths.rootDir, ".transformers-cache");
}

async function sha256File(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function persistModelChecksum(paths: ReturnType<typeof resolveOneMemoryPaths>, checksum: string): Promise<void> {
  const cfg = await readConfig(paths);
  await writeConfig(paths, {
    ...cfg,
    embedding_model_id: EMBEDDING_MODEL_DIR,
    embedding_dimension: EMBEDDING_MODEL_DIM,
    embedding_quantization: "onnx_int8_quantized",
    embedding_model_checksum_sha256: checksum
  });
}

async function createExtractor(): Promise<FeatureExtractor> {
  if (skipEmbeddings()) {
    throw new Error("ONEMEMORY_SKIP_EMBEDDINGS=1");
  }
  if (!isBundledEmbeddingModelPresent()) {
    throw new Error("Bundled embedding model is not installed (missing ONNX under models/).");
  }
  configureTransformersEnv();
  const modelDir = resolveBundledModelDir();
  const runPipeline = pipeline as unknown as (
    task: string,
    model: string,
    opts?: { dtype?: string }
  ) => Promise<FeatureExtractor>;
  const extractor = await runPipeline("feature-extraction", modelDir, { dtype: "q8" });
  try {
    const checksum = await sha256File(bundledModelOnnxPath());
    await persistModelChecksum(resolveOneMemoryPaths(), checksum);
  } catch {
    /* optional metadata; ignore config write failures */
  }
  return extractor;
}

/**
 * Loads the ONNX embedding pipeline once. Fails if the model bundle is missing or invalid.
 */
export async function getEmbeddingExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = createExtractor().catch((err) => {
      extractorPromise = null;
      throw err;
    });
  }
  return extractorPromise;
}

/**
 * Probes whether vector retrieval can run (bundle present, pipeline loads, output shape OK).
 * Safe to call repeatedly; successful pipeline is cached.
 */
export async function probeVectorRetrievalReady(): Promise<boolean> {
  lastInitError = null;
  if (skipEmbeddings()) {
    vectorRetrievalReady = false;
    return false;
  }
  if (vectorRetrievalReady) {
    return true;
  }
  if (!isBundledEmbeddingModelPresent()) {
    vectorRetrievalReady = false;
    lastInitError = "Bundled ONNX model not found under models/.";
    return false;
  }
  try {
    const ex = await getEmbeddingExtractor();
    const probe = await ex("ok", { pooling: "mean", normalize: true });
    const data = probe.data as Float32Array;
    if (!data || data.length < EMBEDDING_MODEL_DIM) {
      throw new Error(`Unexpected embedding length ${data?.length ?? 0}`);
    }
    vectorRetrievalReady = true;
    return true;
  } catch (e) {
    vectorRetrievalReady = false;
    lastInitError = e instanceof Error ? e.message : String(e);
    extractorPromise = null;
    return false;
  }
}

export function getVectorRetrievalReadySync(): boolean {
  return vectorRetrievalReady;
}

export function getLastEmbeddingInitError(): string | null {
  return lastInitError;
}

/**
 * Returns a normalized length-384 embedding, or `null` if embedding is skipped or fails.
 */
export async function embedText(text: string): Promise<number[] | null> {
  if (skipEmbeddings() || !text.trim()) {
    return null;
  }
  try {
    const ex = await getEmbeddingExtractor();
    const out = await ex(text, { pooling: "mean", normalize: true });
    const raw = out.data;
    const data = raw instanceof Float32Array ? raw : Float32Array.from(raw as ArrayLike<number>);
    const slice = data.length === EMBEDDING_MODEL_DIM ? data : data.subarray(0, EMBEDDING_MODEL_DIM);
    if (slice.length !== EMBEDDING_MODEL_DIM) {
      return null;
    }
    return Array.from(slice);
  } catch {
    return null;
  }
}

export function zeroEmbedding(): number[] {
  return Array(EMBEDDING_MODEL_DIM).fill(0);
}
