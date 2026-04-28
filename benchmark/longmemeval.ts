/**
 * LongMemEval retrieval benchmark for 1memory.
 *
 * Usage:
 *   pnpm run benchmark:longmemeval -- --dataset /path/to/longmemeval_s_cleaned.json
 *   pnpm run benchmark:longmemeval -- --dataset /path/to/longmemeval_s_cleaned.json --json
 *   pnpm run benchmark:longmemeval -- --dataset /path/to/longmemeval_s_cleaned.json --write-registry
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

interface LongMemEvalTurn {
  role?: string;
  content?: string;
}

interface LongMemEvalItem {
  question_id: string;
  question_type?: string;
  question: string;
  haystack_session_ids?: string[];
  haystack_sessions?: Array<LongMemEvalTurn[]>;
  answer_session_ids?: string[];
}

interface ParsedArgs {
  dataset: string;
  json: boolean;
  limit: number;
  maxInstances: number;
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
  let maxInstances = Number.POSITIVE_INFINITY;
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
    if (a === "--max-instances" && argv[i + 1]) {
      maxInstances = Math.max(1, Number(argv[i + 1]));
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
    throw new Error("Missing required --dataset /path/to/longmemeval_s_cleaned.json");
  }

  return { dataset, json, limit, maxInstances, warmup, writeRegistry };
}

async function loadDataset(datasetPath: string): Promise<LongMemEvalItem[]> {
  const raw = await fs.readFile(datasetPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("LongMemEval dataset is empty or invalid; expected a non-empty array");
  }
  return parsed as LongMemEvalItem[];
}

function sessionText(session: LongMemEvalTurn[]): string {
  return session
    .map((turn) => {
      const role = String(turn.role ?? "").trim();
      const content = String(turn.content ?? "").trim();
      if (!content) return "";
      return role ? `${role}: ${content}` : content;
    })
    .filter(Boolean)
    .join("\n");
}

function splitByMaxChars(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  const paragraphs = trimmed.split(/\n{2,}/);
  let current = "";

  const flush = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = "";
  };

  const appendPiece = (piece: string) => {
    if (!piece) return;
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (candidate.length <= maxChars) {
      current = candidate;
      return;
    }
    if (current) flush();
    if (piece.length <= maxChars) {
      current = piece;
      return;
    }
    // Last resort: hard-split oversized paragraph by characters.
    for (let i = 0; i < piece.length; i += maxChars) {
      chunks.push(piece.slice(i, i + maxChars));
    }
  };

  for (const p of paragraphs) {
    appendPiece(p.trim());
  }
  if (current) flush();
  return chunks;
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

  const suite = parsed.suites.find((s) => s.id === "longmemeval-s");
  if (!suite) throw new Error("Could not find longmemeval-s suite in realistic-benchmarks.json");

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

  const items = (await loadDataset(args.dataset)).slice(
    0,
    Number.isFinite(args.maxInstances) ? args.maxInstances : Number.MAX_SAFE_INTEGER
  );

  let total = 0;
  let hits1 = 0;
  let hitsK = 0;
  let mrrSum = 0;
  let indexedTokensApprox = 0;
  let queryTokensApprox = 0;
  const latenciesMs: number[] = [];
  const perQuestionType = new Map<string, { total: number; hit1: number }>();

  for (const item of items) {
    const question = String(item.question ?? "").trim();
    const sessionIds = item.haystack_session_ids ?? [];
    const sessions = item.haystack_sessions ?? [];
    const answerSessionIds = new Set(item.answer_session_ids ?? []);

    if (!question || sessionIds.length === 0 || sessions.length === 0 || answerSessionIds.size === 0) {
      continue;
    }

    await withTempOneMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: `/bench/longmemeval/${item.question_id}` });
      const sessionToMemoryIds = new Map<string, string[]>();

      for (let i = 0; i < Math.min(sessionIds.length, sessions.length); i++) {
        const sid = String(sessionIds[i] ?? "");
        const stext = sessionText(sessions[i] ?? []);
        if (!sid || !stext) continue;
        const chunks = splitByMaxChars(stext, 4000);
        if (chunks.length === 0) continue;
        const memoryIds: string[] = [];
        for (const chunk of chunks) {
          indexedTokensApprox += estimateTokens(chunk);
          const rec = await rememberMemory(profile, {
            content: chunk,
            memory_type: "event",
            labels: []
          });
          if (rec.indexing_state !== "ready") {
            throw new Error(
              `question ${item.question_id}: expected indexing_state ready, got ${rec.indexing_state}`
            );
          }
          memoryIds.push(rec.memory_id);
        }
        sessionToMemoryIds.set(sid, memoryIds);
      }

      const goldIds = new Set(
        Array.from(answerSessionIds)
          .flatMap((sid) => sessionToMemoryIds.get(String(sid)) ?? [])
          .filter((id) => id.length > 0)
      );
      if (goldIds.size === 0) return;

      const runQuery = async () => {
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

      if (args.warmup) {
        await runQuery();
      }

      queryTokensApprox += estimateTokens(question);
      const r = await runQuery();
      total++;
      hits1 += r.at1;
      hitsK += r.atK;
      mrrSum += r.rr;
      latenciesMs.push(r.latencyMs);

      const bucketKey = String(item.question_type ?? "unknown");
      const bucket = perQuestionType.get(bucketKey) ?? { total: 0, hit1: 0 };
      bucket.total += 1;
      bucket.hit1 += r.at1;
      perQuestionType.set(bucketKey, bucket);
    });
  }

  const recallAt1 = total ? hits1 / total : 0;
  const recallAtK = total ? hitsK / total : 0;
  const mrr = total ? mrrSum / total : 0;
  const sortedLatencies = [...latenciesMs].sort((a, b) => a - b);
  const p50RecallLatencyMs = percentile(sortedLatencies, 50);
  const p95RecallLatencyMs = percentile(sortedLatencies, 95);
  const totalTokensApprox = indexedTokensApprox + queryTokensApprox;

  const summary = {
    suite: "longmemeval-s-retrieval-v1",
    dataset: path.resolve(args.dataset),
    questions: total,
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
    per_question_type: Array.from(perQuestionType.entries())
      .map(([question_type, data]) => ({
        question_type,
        questions: data.total,
        recall_at_1: data.total ? data.hit1 / data.total : 0
      }))
      .sort((a, b) => a.question_type.localeCompare(b.question_type))
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

  console.log("1memory LongMemEval retrieval benchmark (local embeddings)");
  console.log(`dataset=${summary.dataset}`);
  console.log(`questions=${summary.questions} limit=${args.limit}`);
  console.log(`accuracy     ${(100 * summary.accuracy).toFixed(1)}%`);
  console.log(`recall@1     ${(100 * summary.recall_at_1).toFixed(1)}%`);
  console.log(`recall@${args.limit} ${(100 * summary.recall_at_k).toFixed(1)}%`);
  console.log(`MRR          ${summary.mrr.toFixed(3)}`);
  console.log(`p50 latency  ${summary.p50_recall_latency_ms.toFixed(2)} ms`);
  console.log(`p95 latency  ${summary.p95_recall_latency_ms.toFixed(2)} ms`);
  console.log(
    `tokens≈      ${summary.total_tokens_approx} (indexed ${summary.indexed_tokens_approx}, query ${summary.query_tokens_approx})`
  );

  for (const row of summary.per_question_type) {
    console.log(`  - ${row.question_type}: @1 ${(100 * row.recall_at_1).toFixed(1)}% (${row.questions} q)`);
  }

  if (args.writeRegistry) {
    console.log(`registry updated: ${REALISTIC_BENCHMARKS_PATH}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
