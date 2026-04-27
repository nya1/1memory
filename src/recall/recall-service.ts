import { MemoryRecord, ProfileRecord } from "../core/types.js";
import { embedText, getVectorRetrievalReadySync, probeVectorRetrievalReady } from "../embeddings/embedding-runtime.js";
import { listMemories, rowToMemory, sqlStringLiteral } from "../memory/memory-service.js";
import { MEMORIES_TABLE, openLocalDatabase } from "../storage/lancedb.js";

export interface RecallResult {
  answer: string;
  context_block: string;
  citations: Array<{
    memory_id: string;
    memory_type: string;
    content: string;
  }>;
  candidate_ids: string[];
  confidence: number;
  why_retrieved: string[];
  retrieval_channels_used: string[];
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/g)
      .filter((part) => part.length >= 2)
  );
}

function scoreMemory(queryTokens: Set<string>, memory: MemoryRecord): number {
  const haystack = tokenize(`${memory.content} ${memory.topic_key ?? ""} ${memory.labels.join(" ")}`);
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) {
      score += 1;
    }
  }
  if (memory.memory_type === "instruction") {
    score += 0.25;
  }
  return score;
}

function recencyBoost(memory: MemoryRecord): number {
  const t = Date.parse(memory.updated_at);
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / (86400 * 1000);
  return Math.max(0, 0.08 * (1 - Math.min(days, 365) / 365));
}

function topicKeyBoost(queryTokens: Set<string>, memory: MemoryRecord): number {
  if (!memory.topic_key) return 0;
  for (const t of tokenize(memory.topic_key)) {
    if (queryTokens.has(t)) return 0.12;
  }
  return 0;
}

interface Scored {
  memory: MemoryRecord;
  lexical: number;
  vectorDist: number | null;
  channels: Set<string>;
}

function mergeScores(candidates: Map<string, Scored>, limit: number, queryTokens: Set<string>): Scored[] {
  let maxLex = 0;
  for (const c of candidates.values()) {
    maxLex = Math.max(maxLex, c.lexical);
  }
  if (maxLex <= 0) maxLex = 1;

  const ranked = [...candidates.values()].map((c) => {
    const lexN = Math.min(1, c.lexical / maxLex);
    const vecN = c.vectorDist != null ? 1 / (1 + c.vectorDist) : 0;
    const topic = topicKeyBoost(queryTokens, c.memory);
    const combined =
      0.48 * lexN + 0.38 * vecN + topic + recencyBoost(c.memory) + (c.memory.memory_type === "instruction" ? 0.03 : 0);
    return { c, combined };
  });

  ranked.sort((a, b) => b.combined - a.combined || b.c.memory.updated_at.localeCompare(a.c.memory.updated_at));
  return ranked.slice(0, limit).map((r) => r.c);
}

export async function recallMemory(profile: ProfileRecord, query: string, limit = 8): Promise<RecallResult> {
  const queryTokens = tokenize(query);

  const vectorReady = getVectorRetrievalReadySync() || (await probeVectorRetrievalReady());
  const queryEmbedding = vectorReady && query.trim() ? await embedText(query) : null;
  const usedVector = Boolean(queryEmbedding);

  const lexicalRanked = (await listMemories(profile.profile_id))
    .filter((memory) => memory.status === "active")
    .map((memory) => ({ memory, score: scoreMemory(queryTokens, memory) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.updated_at.localeCompare(a.memory.updated_at))
    .slice(0, Math.max(limit * 4, 24));

  const candidates = new Map<string, Scored>();

  for (const { memory, score } of lexicalRanked) {
    candidates.set(memory.memory_id, {
      memory,
      lexical: score,
      vectorDist: null,
      channels: new Set(score > 0 ? ["lexical", "metadata"] : ["metadata"])
    });
  }

  if (usedVector && queryEmbedding) {
    const { db } = await openLocalDatabase();
    const table = await db.openTable(MEMORIES_TABLE);
    const hits = (await table
      .vectorSearch(queryEmbedding)
      .column("content_embedding")
      .where(
        `profile_id = ${sqlStringLiteral(profile.profile_id)} AND status = 'active' AND indexing_state = 'ready'`
      )
      .limit(Math.max(limit * 4, 20))
      .toArray()) as Record<string, unknown>[];

    for (const row of hits) {
      const dist = typeof row._distance === "number" ? row._distance : Number(row._distance);
      const memory = rowToMemory(row);
      const prev = candidates.get(memory.memory_id);
      const vecDist = Number.isFinite(dist) ? dist : null;
      if (prev) {
        prev.vectorDist = vecDist;
        prev.channels.add("vector");
      } else {
        candidates.set(memory.memory_id, {
          memory,
          lexical: 0,
          vectorDist: vecDist,
          channels: new Set(["vector"])
        });
      }
    }
  }

  const merged =
    candidates.size > 0
      ? mergeScores(candidates, limit, queryTokens)
      : lexicalRanked.slice(0, limit).map(({ memory, score }) => ({
          memory,
          lexical: score,
          vectorDist: null as number | null,
          channels: new Set<string>(["lexical", "metadata"])
        }));

  const citations = merged.map(({ memory }) => ({
    memory_id: memory.memory_id,
    memory_type: memory.memory_type,
    content: memory.content
  }));

  const channelOrder = ["lexical", "metadata", "vector"] as const;
  const retrievalSet = new Set<string>();
  for (const s of merged) {
    for (const c of s.channels) {
      retrievalSet.add(c);
    }
  }
  if (retrievalSet.size === 0) {
    retrievalSet.add("lexical");
    retrievalSet.add("metadata");
  }
  const retrieval_channels_used = channelOrder.filter((c) => retrievalSet.has(c));

  const why_retrieved = merged.map(({ memory, channels, lexical, vectorDist }) => {
    const parts: string[] = [];
    if (channels.has("lexical") && lexical > 0) {
      parts.push("lexical term overlap");
    }
    if (channels.has("vector") && vectorDist != null) {
      parts.push(`vector similarity (distance ${vectorDist.toFixed(4)})`);
    }
    if (parts.length === 0) {
      parts.push("metadata / profile scope");
    }
    return `${memory.memory_id}: ${parts.join(", ")}.`;
  });

  return {
    answer:
      citations.length === 0
        ? "No matching local memories were found."
        : citations.map((citation) => `- ${citation.content} (${citation.memory_id})`).join("\n"),
    context_block:
      citations.length === 0
        ? ""
        : ["Relevant JustMemory context:", ...citations.map((citation) => `- [${citation.memory_id}] ${citation.content}`)].join("\n"),
    citations,
    candidate_ids: citations.map((citation) => citation.memory_id),
    confidence: citations.length === 0 ? 0 : Math.min(0.95, 0.4 + citations.length * 0.1),
    why_retrieved,
    retrieval_channels_used
  };
}
