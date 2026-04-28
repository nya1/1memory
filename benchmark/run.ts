/**
 * 1memory synthetic retrieval benchmark.
 *
 * Inspired by open agent-memory eval patterns (e.g. mem0 evaluation tables, LoCoMo-style
 * QA-over-corpus checks, long-context recall suites) but runs fully local: no LLM judges.
 *
 * Metrics: recall@1, recall@k, MRR, mean/p50 recall latency (process.hrtime.bigint),
 * and approximate token volume (word-piece proxy) for indexed memories and queries.
 *
 * Usage (from repo root, after `pnpm install` and embedding setup):
 *   pnpm run benchmark:retrieval
 *   pnpm run benchmark:retrieval -- --json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { probeVectorRetrievalReady } from "../src/embeddings/embedding-runtime.js";
import { rememberMemory } from "../src/memory/memory-service.js";
import { resolveProfile } from "../src/profiles/profile-service.js";
import { recallMemory } from "../src/recall/recall-service.js";
import { withTempOneMemoryHome } from "./support/temp-home.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type MemoryType = "fact" | "event" | "instruction" | "task";

interface ScenarioMemory {
  content: string;
  memory_type: MemoryType;
}

interface ScenarioCase {
  id: string;
  gold_index: number;
  memories: ScenarioMemory[];
  queries: string[];
}

interface ScenarioFile {
  version: number;
  cases: ScenarioCase[];
}

function estimateTokens(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

function parseArgs(argv: string[]): { json: boolean; limit: number; warmup: boolean } {
  let json = false;
  let limit = 8;
  let warmup = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    if (a === "--no-warmup") warmup = false;
    if (a === "--limit" && argv[i + 1]) {
      limit = Math.max(1, Math.min(50, Number(argv[i + 1])));
      i++;
    }
  }
  return { json, limit, warmup };
}

function rankOfGold(candidateIds: string[], goldId: string): number | null {
  const idx = candidateIds.indexOf(goldId);
  if (idx < 0) return null;
  return idx + 1;
}

async function loadScenarios(): Promise<ScenarioFile> {
  const raw = await fs.readFile(path.join(__dirname, "scenarios.json"), "utf8");
  const parsed = JSON.parse(raw) as ScenarioFile;
  if (!parsed.cases?.length) throw new Error("scenarios.json: missing cases");
  for (const c of parsed.cases) {
    if (c.gold_index < 0 || c.gold_index >= c.memories.length) {
      throw new Error(`case ${c.id}: gold_index out of range`);
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const { json, limit, warmup } = parseArgs(process.argv.slice(2));
  const vectorReady = await probeVectorRetrievalReady();
  if (!vectorReady) {
    const msg =
      "Vector retrieval is not ready (missing ONNX model?). Run `pnpm run setup:embeddings` then retry.";
    if (json) {
      console.log(JSON.stringify({ error: msg }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.error(msg);
    process.exitCode = 1;
    return;
  }

  const suite = await loadScenarios();
  const perCase: Array<{
    id: string;
    memories: number;
    queries: number;
    recall_at_1: number;
    recall_at_k: number;
    mrr: number;
    mean_latency_ms: number;
    p50_latency_ms: number;
    indexed_tokens_approx: number;
    query_tokens_approx: number;
  }> = [];

  let totalQueries = 0;
  let hits1 = 0;
  let hitsK = 0;
  let mrrSum = 0;
  let latencySumNs = 0n;
  const allLatenciesMs: number[] = [];
  let indexedTokensApprox = 0;
  let queryTokensApprox = 0;

  for (const c of suite.cases) {
    const workspace = `/bench/${c.id}`;
    let caseHits1 = 0;
    let caseHitsK = 0;
    let caseMrr = 0;
    let caseLatencyNs = 0n;
    const caseLatenciesMs: number[] = [];
    let qn = 0;
    let caseIndexedTokensApprox = 0;
    let caseQueryTokensApprox = 0;

    await withTempOneMemoryHome(async () => {
      const profile = await resolveProfile({ workspace });
      const ids: string[] = [];
      for (const m of c.memories) {
        caseIndexedTokensApprox += estimateTokens(m.content);
        const rec = await rememberMemory(profile, {
          content: m.content,
          memory_type: m.memory_type,
          labels: []
        });
        if (rec.indexing_state !== "ready") {
          throw new Error(`case ${c.id}: expected indexing_state ready, got ${rec.indexing_state}`);
        }
        ids.push(rec.memory_id);
      }
      const goldId = ids[c.gold_index]!;

      const runQuery = async (query: string) => {
        const t0 = process.hrtime.bigint();
        const result = await recallMemory(profile, query, limit);
        const t1 = process.hrtime.bigint();
        const rank = rankOfGold(result.candidate_ids, goldId);
        const rr = rank ? 1 / rank : 0;
        const at1 = rank === 1 ? 1 : 0;
        const atK = rank != null && rank <= limit ? 1 : 0;
        return { at1, atK, rr, ns: t1 - t0 };
      };

      if (warmup && c.queries[0]) {
        await runQuery(c.queries[0]);
      }

      for (const q of c.queries) {
        const { at1, atK, rr, ns } = await runQuery(q);
        const latencyMs = Number(ns) / 1e6;
        caseHits1 += at1;
        caseHitsK += atK;
        caseMrr += rr;
        caseLatencyNs += ns;
        caseLatenciesMs.push(latencyMs);
        allLatenciesMs.push(latencyMs);
        caseQueryTokensApprox += estimateTokens(q);
        totalQueries++;
        hits1 += at1;
        hitsK += atK;
        mrrSum += rr;
        latencySumNs += ns;
        qn++;
      }
    });

    perCase.push({
      id: c.id,
      memories: c.memories.length,
      queries: qn,
      recall_at_1: qn ? caseHits1 / qn : 0,
      recall_at_k: qn ? caseHitsK / qn : 0,
      mrr: qn ? caseMrr / qn : 0,
      mean_latency_ms: qn ? Number(caseLatencyNs / BigInt(qn)) / 1e6 : 0,
      p50_latency_ms: percentile(caseLatenciesMs.toSorted((a, b) => a - b), 50),
      indexed_tokens_approx: caseIndexedTokensApprox,
      query_tokens_approx: caseQueryTokensApprox
    });
    indexedTokensApprox += caseIndexedTokensApprox;
    queryTokensApprox += caseQueryTokensApprox;
  }

  const recall_at_1 = totalQueries ? hits1 / totalQueries : 0;
  const recall_at_k = totalQueries ? hitsK / totalQueries : 0;
  const mrr = totalQueries ? mrrSum / totalQueries : 0;
  const mean_latency_ms = totalQueries ? Number(latencySumNs / BigInt(totalQueries)) / 1e6 : 0;
  const p50_latency_ms = percentile(allLatenciesMs.toSorted((a, b) => a - b), 50);
  const p95_latency_ms = percentile(allLatenciesMs.toSorted((a, b) => a - b), 95);

  const summary = {
    suite: "1memory-retrieval-synthetic-v1",
    cases: suite.cases.length,
    queries: totalQueries,
    recall_at_1,
    recall_at_k,
    recall_at_k_limit: limit,
    mrr,
    mean_recall_latency_ms: mean_latency_ms,
    p50_recall_latency_ms: p50_latency_ms,
    p95_recall_latency_ms: p95_latency_ms,
    indexed_tokens_approx: indexedTokensApprox,
    query_tokens_approx: queryTokensApprox,
    total_tokens_approx: indexedTokensApprox + queryTokensApprox,
    vector_retrieval: vectorReady,
    per_case: perCase
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("1memory retrieval benchmark (synthetic corpus, local embeddings)");
  console.log(`cases=${summary.cases} queries=${summary.queries} limit=${limit}`);
  console.log(`recall@1     ${(100 * recall_at_1).toFixed(1)}%`);
  console.log(`recall@${limit} ${(100 * recall_at_k).toFixed(1)}%`);
  console.log(`MRR          ${mrr.toFixed(3)}`);
  console.log(`mean latency ${mean_latency_ms.toFixed(2)} ms`);
  console.log(`p50 latency  ${p50_latency_ms.toFixed(2)} ms`);
  console.log(`p95 latency  ${p95_latency_ms.toFixed(2)} ms`);
  console.log(`tokens≈      ${summary.total_tokens_approx} (indexed ${summary.indexed_tokens_approx}, query ${summary.query_tokens_approx})`);
  for (const row of perCase) {
    console.log(
      `  - ${row.id}: @1 ${(100 * row.recall_at_1).toFixed(0)}% @${limit} ${(100 * row.recall_at_k).toFixed(0)}% mrr ${row.mrr.toFixed(2)} p50 ${row.p50_latency_ms.toFixed(2)}ms (${row.memories} mem, ${row.queries} q, tokens≈${row.indexed_tokens_approx + row.query_tokens_approx})`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
