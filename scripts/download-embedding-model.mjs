#!/usr/bin/env node
/**
 * Downloads Xenova ONNX + tokenizer files for local `paraphrase-MiniLM-L3-v2` embeddings,
 * and ensures the Apache License 2.0 text is present (`LICENSE`) for redistribution.
 *
 * Invoked by:
 * - `pnpm run setup:embeddings` (manual)
 * - `postinstall` after `pnpm install` (git clone / dev; skips quickly when files already exist)
 * - `predev:mcp` / `pretest` before local MCP dev and tests
 * - `prepublishOnly` before `npm publish` / `pnpm publish` / `npm pack` so the `models/` tree ships in the npm tarball
 *
 * Model files live under `models/` and are gitignored; published packages still include them via the `files` field.
 */
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_DIR = path.join(ROOT, "models", "paraphrase-MiniLM-L3-v2");
const ONNX_DIR = path.join(MODEL_DIR, "onnx");
const BASE =
  "https://huggingface.co/Xenova/paraphrase-MiniLM-L3-v2/resolve/main";
const APACHE_LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0.txt";

const MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "vocab.txt",
  "onnx/model_quantized.onnx"
];

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "justmemory-setup/1.0" } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301 || res.statusCode === 307 || res.statusCode === 308) {
          const loc = res.headers.location;
          if (!loc) {
            reject(new Error("Redirect without location"));
            return;
          }
          const next = new URL(loc, url).href;
          fetchBinary(next).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function ensureApacheLicenseFile() {
  const dest = path.join(MODEL_DIR, "LICENSE");
  try {
    const st = await fs.stat(dest);
    if (st.size > 8000) {
      console.log("skip (exists): LICENSE");
      return;
    }
  } catch {
    /* fetch */
  }
  process.stdout.write("fetch LICENSE (Apache-2.0) … ");
  const buf = await fetchBinary(APACHE_LICENSE_URL);
  await fs.writeFile(dest, buf);
  console.log(`${buf.length} bytes`);
}

async function main() {
  await fs.mkdir(ONNX_DIR, { recursive: true });
  await ensureApacheLicenseFile();

  for (const rel of MODEL_FILES) {
    const dest = path.join(MODEL_DIR, rel);
    try {
      await fs.access(dest);
      const st = await fs.stat(dest);
      if (st.size > 0) {
        console.log(`skip (exists): ${rel}`);
        continue;
      }
    } catch {
      /* download */
    }
    const url = `${BASE}/${rel}`;
    process.stdout.write(`fetch ${rel} … `);
    const buf = await fetchBinary(url);
    await fs.writeFile(dest, buf);
    console.log(`${buf.length} bytes`);
  }
  console.log("Done. Model directory:", MODEL_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
