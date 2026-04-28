/**
 * LoCoMo retrieval benchmark for 1memory.
 *
 * Usage:
 *   pnpm run benchmark:locomo -- --dataset /path/to/locomo10.json
 *   pnpm run benchmark:locomo -- --dataset /path/to/locomo10.json --json
 *   pnpm run benchmark:locomo -- --dataset /path/to/locomo10.json --write-registry
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
const REALISTIC_BENCHMARKS_PATH = path.join(__dirname, "realistic-benchmarks.json");

type MemoryType = "fact" | "event" | "instruction" | "task";

interface LoCoMoQAPair {
  question: string;
  evidence?: string[];
}

interface LoCoMoConversation {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: LoCoMoQAPair[];
}

interface ParsedArgs {
  dataset: string;
  json: boolean;
  limit: number;
  maxConversations: number;
  maxQuestionsPerConversation: number;
  warmup: boolean;
  writeRegistry: boolean;
}

function estimateTokens(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

function rankOfGold(candidateIds: string[], goldIds: Set<string>): number | null {
  for (let i = 0; i < candidateIds.length; i++) {
    if (goldIds.has(candidateIds[i]!)) return i + 1;
  }
  return null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let dataset = "";
  let json = false;
  let limit = 8;
  let maxConversations = Number.POSITIVE_INFINITY;
  let maxQuestionsPerConversation = Number.POSITIVE_INFINITY;
  let warmup = true;
  let writeRegistry = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset" && argv[i + 1]) {
      dataset = argv[i + 1]!;
      i++;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--limit" && argv[i + 1]) {
      limit = Math.max(1, Math.min(50, Number(argv[i + 1])));
      i++;
      continue;
    }
    if (a === "--max-conversations" && argv[i + 1]) {
      maxConversations = Math.max(1, Number(argv[i + 1]));
      i++;
      continue;
    }
    if (a === "--max-questions" && argv[i + 1]) {
      maxQuestionsPerConversation = Math.max(1, Number(argv[i + 1]));
      i++;
      continue;
    }
    if (a === "--no-warmup") {
      warmup = false;
      continue;
    }
    if (a === "--write-registry") {
      writeRegistry = true;
      continue;
    }
  }

  if (!dataset) {
    throw new Error("Missing required --dataset /path/to/locomo10.json");
  }

  return {
    dataset,
    json,
    limit,
    maxConversations,
    maxQuestionsPerConversation,
    warmup,
    writeRegistry
  };
}

async function loadDataset(datasetPath: string): Promise<LoCoMoConversation[]> {
  const raw = await fs.readFile(datasetPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("LoCoMo dataset is empty or invalid; expected a non-empty array");
  }
  return parsed as LoCoMoConversation[];
}

function extractTurns(conv: LoCoMoConversation): Array<{ diaId: string; text: string }> {
  const out: Array<{ diaId: string; text: string }> = [];
  const conversation = conv.conversation ?? {};

  const sessionKeys = Object.keys(conversation)
    .filter((k) => /^session_\d+$/.test(k))
    .toSorted((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));

  for (const sk of sessionKeys) {
    const turns = (conversation[sk] ?? []) as Array<Record<string, unknown>>;
    for (const t of turns) {
      const diaId = String(t.dia_id ?? "");
      const text = String(t.text ?? "").trim();
      if (!diaId || !text) continue;
      out.push({ diaId, text });
    }
  }

  return out;
}

async function maybeWriteRegistry(summary: {
  accuracy: number;
  recall_at_1: number;
  mrr: number;
  p50_recall_latency_ms: number;
  total_tokens_approx: number;
}): Promise<void> {
  const raw = await fs.readFile(REALISTIC_BENCHMARKS_PATH, "utf8");
  const parsed = JSON.parse(raw) as {
    updated_at: string;
    suites: Array<{
      id: string;
      status: string;
      results: {
        accuracy: number | null;
        recall_at_1: number | null;
        mrr: number | null;
        latency_p50_ms: number | null;
        tokens_processed: number | null;
      };
    }>;
  };

  const suite = parsed.suites.find((s) => s.id === "locomo");
  if (!suite) throw new Error("Could not find locomo suite in realistic-benchmarks.json");

  suite.status = "measured";
  suite.results.accuracy = summary.accuracy;
  suite.results.recall_at_1 = summary.recall_at_1;
  suite.results.mrr = summary.mrr;
  suite.results.latency_p50_ms = summary.p50_recall_latency_ms;
  suite.results.tokens_processed = summary.total_tokens_approx;
  parsed.updated_at = new Date().toISOString().slice(0, 10);

  await fs.writeFile(REALISTIC_BENCHMARKS_PATH, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const vectorReady = await probeVectorRetrievalReady();
  if (!vectorReady) {
    throw new Error(
      "Vector retrieval is not ready (missing ONNX model?). Run `pnpm run setup:embeddings` then retry."
    );
  }

  const rows = await loadDataset(args.dataset);
  const selectedRows = rows.slice(0, Number.isFinite(args.maxConversations) ? args.maxConversations : rows.length);

  const perConversation: Array<{
    sample_id: string;
    memories: number;
    questions: number;
    recall_at_1: number;
    recall_at_k: number;
    mrr: number;
    p50_latency_ms: number;
  }> = [];

  let questions = 0;
  let hits1 = 0;
  let hitsK = 0;
  let mrrSum = 0;
  let indexedTokensApprox = 0;
  let queryTokensApprox = 0;
  const allLatenciesMs: number[] = [];

  for (const conv of selectedRows) {
    const turns = extractTurns(conv);
    if (turns.length === 0) continue;

    const qa = (conv.qa ?? [])
      .filter((q) => q.question?.trim() && Array.isArray(q.evidence) && q.evidence.length > 0)
      .slice(
        0,
        Number.isFinite(args.maxQuestionsPerConversation)
          ? args.maxQuestionsPerConversation
          : conv.qa?.length ?? 0
      );
    if (qa.length === 0) continue;

    let convQuestions = 0;
    let convHits1 = 0;
    let convHitsK = 0;
    let convMrrSum = 0;
    const convLatenciesMs: number[] = [];

    await withTempOneMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: `/bench/locomo/${conv.sample_id}` });
      const diaToMemoryId = new Map<string, string>();

      for (const t of turns) {
        indexedTokensApprox += estimateTokens(t.text);
        const rec = await rememberMemory(profile, {
          content: t.text,
          memory_type: "fact" satisfies MemoryType,
          labels: []
        });
        if (rec.indexing_state !== "ready") {
          throw new Error(
            `conversation ${conv.sample_id}: expected indexing_state ready, got ${rec.indexing_state}`
          );
        }
        diaToMemoryId.set(t.diaId, rec.memory_id);
      }

      const runQuery = async (question: string, evidenceDiaIds: string[]) => {
        const goldIds = new Set(
          evidenceDiaIds
            .map((d) => diaToMemoryId.get(d))
            .filter((id): id is string => typeof id === "string" && id.length > 0)
        );
        if (goldIds.size === 0) return null;

        const t0 = process.hrtime.bigint();
        const result = await recallMemory(profile, question, args.limit);
        const t1 = process.hrtime.bigint();
        const latencyMs = Number(t1 - t0) / 1e6;
        const rank = rankOfGold(result.candidate_ids, goldIds);
        const rr = rank ? 1 / rank : 0;
        const at1 = rank === 1 ? 1 : 0;
        const atK = rank != null && rank <= args.limit ? 1 : 0;
        return { at1, atK, rr, latencyMs };
      };

      if (args.warmup && qa[0]) {
        await runQuery(qa[0].question, qa[0].evidence ?? []);
      }

      for (const item of qa) {
        queryTokensApprox += estimateTokens(item.question);
        const result = await runQuery(item.question, item.evidence ?? []);
        if (!result) continue;
        convQuestions++;
        convHits1 += result.at1;
        convHitsK += result.atK;
        convMrrSum += result.rr;
        convLatenciesMs.push(result.latencyMs);
        allLatenciesMs.push(result.latencyMs);
      }
    });

    if (convQuestions > 0) {
      questions += convQuestions;
      hits1 += convHits1;
      hitsK += convHitsK;
      mrrSum += convMrrSum;
      perConversation.push({
        sample_id: conv.sample_id,
        memories: turns.length,
        questions: convQuestions,
        recall_at_1: convHits1 / convQuestions,
        recall_at_k: convHitsK / convQuestions,
        mrr: convMrrSum / convQuestions,
        p50_latency_ms: percentile(convLatenciesMs.toSorted((a, b) => a - b), 50)
      });
    }
  }

  const recallAt1 = questions ? hits1 / questions : 0;
  const recallAtK = questions ? hitsK / questions : 0;
  const mrr = questions ? mrrSum / questions : 0;
  const p50RecallLatencyMs = percentile(allLatenciesMs.toSorted((a, b) => a - b), 50);
  const p95RecallLatencyMs = percentile(allLatenciesMs.toSorted((a, b) => a - b), 95);
  const totalTokensApprox = indexedTokensApprox + queryTokensApprox;

  const summary = {
    suite: "locomo-retrieval-v1",
    dataset: path.resolve(args.dataset),
    conversations: perConversation.length,
    questions,
    recall_at_1: recallAt1,
    recall_at_k: recallAtK,
    recall_at_k_limit: args.limit,
    mrr,
    accuracy: recallAt1,
    p50_recall_latency_ms: p50RecallLatencyMs,
    p95_recall_latency_ms: p95RecallLatencyMs,
    indexed_tokens_approx: indexedTokensApprox,
    query_tokens_approx: queryTokensApprox,
    total_tokens_approx: totalTokensApprox,
    per_conversation: perConversation
  };

  if (args.writeRegistry) {
    await maybeWriteRegistry({
      accuracy: summary.accuracy,
      recall_at_1: summary.recall_at_1,
      mrr: summary.mrr,
      p50_recall_latency_ms: summary.p50_recall_latency_ms,
      total_tokens_approx: summary.total_tokens_approx
    });
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("1memory LoCoMo retrieval benchmark (local embeddings)");
  console.log(`dataset=${summary.dataset}`);
  console.log(`conversations=${summary.conversations} questions=${summary.questions} limit=${args.limit}`);
  console.log(`accuracy     ${(100 * summary.accuracy).toFixed(1)}%`);
  console.log(`recall@1     ${(100 * summary.recall_at_1).toFixed(1)}%`);
  console.log(`recall@${args.limit} ${(100 * summary.recall_at_k).toFixed(1)}%`);
  console.log(`MRR          ${summary.mrr.toFixed(3)}`);
  console.log(`p50 latency  ${summary.p50_recall_latency_ms.toFixed(2)} ms`);
  console.log(`p95 latency  ${summary.p95_recall_latency_ms.toFixed(2)} ms`);
  console.log(
    `tokens≈      ${summary.total_tokens_approx} (indexed ${summary.indexed_tokens_approx}, query ${summary.query_tokens_approx})`
  );

  for (const row of summary.per_conversation) {
    console.log(
      `  - ${row.sample_id}: @1 ${(100 * row.recall_at_1).toFixed(0)}% @${args.limit} ${(100 * row.recall_at_k).toFixed(0)}% mrr ${row.mrr.toFixed(2)} p50 ${row.p50_latency_ms.toFixed(2)}ms (${row.memories} mem, ${row.questions} q)`
    );
  }

  if (args.writeRegistry) {
    console.log(`registry updated: ${REALISTIC_BENCHMARKS_PATH}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
