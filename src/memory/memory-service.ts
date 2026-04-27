import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { OneMemoryError } from "../core/errors.js";
import { MemoryRecord, MemoryType, ProfileRecord } from "../core/types.js";
import { embedText, zeroEmbedding } from "../embeddings/embedding-runtime.js";
import { MEMORIES_TABLE, openLocalDatabase } from "../storage/lancedb.js";
import { assertStoreWritesAllowed } from "../storage/migrations-runner.js";
import { withDbWriteLock } from "../storage/db-write-mutex.js";

export const MEMORY_STORE_COLUMNS_WITHOUT_EMBEDDING = [
  "memory_id",
  "profile_id",
  "namespace",
  "memory_type",
  "status",
  "content",
  "content_hash",
  "topic_key",
  "labels_json",
  "importance",
  "confidence",
  "indexing_state",
  "write_state",
  "source_actor",
  "source_client",
  "source_session",
  "source_repo",
  "source_branch",
  "file_paths_json",
  "redaction_state",
  "created_at",
  "updated_at"
] as const;

export const rememberInputSchema = z.object({
  content: z.string().min(1).max(4000),
  memory_type: z.enum(["fact", "event", "instruction", "task"]),
  profile_id: z.string().optional(),
  namespace: z.string().default("default"),
  topic_key: z.string().optional(),
  labels: z.array(z.string()).default([]),
  source: z
    .object({
      actor: z.string().optional(),
      client: z.string().optional(),
      session: z.string().optional(),
      repo: z.string().optional(),
      branch: z.string().optional(),
      file_paths: z.array(z.string()).default([])
    })
    .default({})
});

export type RememberInput = z.infer<typeof rememberInputSchema>;

function now(): string {
  return new Date().toISOString();
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Escape a string for LanceDB SQL string literals. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function memoryToRow(m: MemoryRecord, contentEmbedding: number[]): Record<string, unknown> {
  return {
    memory_id: m.memory_id,
    profile_id: m.profile_id,
    namespace: m.namespace,
    memory_type: m.memory_type,
    status: m.status,
    content: m.content,
    content_hash: m.content_hash,
    topic_key: m.topic_key ?? "",
    labels_json: JSON.stringify(m.labels),
    importance: m.importance ?? 0,
    confidence: m.confidence ?? 0,
    indexing_state: m.indexing_state,
    write_state: m.write_state,
    source_actor: m.source_actor ?? "",
    source_client: m.source_client ?? "",
    source_session: m.source_session ?? "",
    source_repo: m.source_repo ?? "",
    source_branch: m.source_branch ?? "",
    file_paths_json: JSON.stringify(m.file_paths),
    redaction_state: m.redaction_state,
    created_at: m.created_at,
    updated_at: m.updated_at,
    content_embedding: contentEmbedding
  };
}

export function rowToMemory(row: Record<string, unknown>): MemoryRecord {
  const topic = String(row.topic_key ?? "");
  const imp = row.importance as number | undefined;
  const conf = row.confidence as number | undefined;
  return {
    memory_id: String(row.memory_id),
    profile_id: String(row.profile_id),
    namespace: String(row.namespace),
    memory_type: row.memory_type as MemoryType,
    status: row.status as MemoryRecord["status"],
    content: String(row.content),
    content_hash: String(row.content_hash),
    topic_key: topic === "" ? undefined : topic,
    labels: JSON.parse(String(row.labels_json ?? "[]")) as string[],
    importance: imp === null || imp === undefined || Number(imp) === 0 ? undefined : Number(imp),
    confidence: conf === null || conf === undefined || Number(conf) === 0 ? undefined : Number(conf),
    indexing_state: row.indexing_state as MemoryRecord["indexing_state"],
    write_state: row.write_state as MemoryRecord["write_state"],
    source_actor: String(row.source_actor ?? "") || undefined,
    source_client: String(row.source_client ?? "") || undefined,
    source_session: String(row.source_session ?? "") || undefined,
    source_repo: String(row.source_repo ?? "") || undefined,
    source_branch: String(row.source_branch ?? "") || undefined,
    file_paths: JSON.parse(String(row.file_paths_json ?? "[]")) as string[],
    redaction_state: row.redaction_state as MemoryRecord["redaction_state"],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

async function queryMemoriesWhere(whereSql: string): Promise<MemoryRecord[]> {
  const { db } = await openLocalDatabase();
  const table = await db.openTable(MEMORIES_TABLE);
  const rows = (await table
    .query()
    .where(whereSql)
    .select([...MEMORY_STORE_COLUMNS_WITHOUT_EMBEDDING])
    .toArray()) as Record<string, unknown>[];
  return rows.map(rowToMemory);
}

export async function rememberMemory(profile: ProfileRecord, rawInput: unknown): Promise<MemoryRecord> {
  assertStoreWritesAllowed();
  return withDbWriteLock(async () => {
    const input = rememberInputSchema.parse(rawInput);
    const content_hash = hashContent(input.content);

    const { db } = await openLocalDatabase();
    const table = await db.openTable(MEMORIES_TABLE);
    const dup = (await table
      .query()
      .where(
        `profile_id = ${sqlStringLiteral(profile.profile_id)} AND content_hash = ${sqlStringLiteral(
          content_hash
        )} AND status = 'active'`
      )
      .select([...MEMORY_STORE_COLUMNS_WITHOUT_EMBEDDING])
      .limit(1)
      .toArray()) as Record<string, unknown>[];

    if (dup.length > 0) {
      const existing = rowToMemory(dup[0]!);
      return { ...existing, write_state: "duplicate_ignored" };
    }

    const timestamp = now();
    const vector = await embedText(input.content);
    const indexing_state = vector ? "ready" : "not_indexed";
    const content_embedding = vector ?? zeroEmbedding();

    const memory: MemoryRecord = {
      memory_id: `mem_${nanoid(12)}`,
      profile_id: profile.profile_id,
      namespace: input.namespace,
      memory_type: input.memory_type as MemoryType,
      status: "active",
      content: input.content,
      content_hash,
      topic_key: input.topic_key,
      labels: input.labels,
      indexing_state,
      write_state: "accepted",
      source_actor: input.source.actor,
      source_client: input.source.client,
      source_session: input.source.session,
      source_repo: input.source.repo,
      source_branch: input.source.branch,
      file_paths: input.source.file_paths,
      redaction_state: "none",
      created_at: timestamp,
      updated_at: timestamp
    };

    await table.add([memoryToRow(memory, content_embedding)]);
    return memory;
  });
}

export async function getMemories(memoryIds: string[]): Promise<MemoryRecord[]> {
  if (memoryIds.length === 0) {
    return [];
  }
  const { db } = await openLocalDatabase();
  const table = await db.openTable(MEMORIES_TABLE);
  const inList = memoryIds.map((id) => sqlStringLiteral(id)).join(", ");
  const rows = (await table
    .query()
    .where(`memory_id IN (${inList})`)
    .select([...MEMORY_STORE_COLUMNS_WITHOUT_EMBEDDING])
    .toArray()) as Record<string, unknown>[];
  const map = new Map(rows.map((row) => rowToMemory(row)).map((m) => [m.memory_id, m]));
  const ordered = memoryIds.map((id) => map.get(id));
  if (ordered.some((record) => !record)) {
    throw new OneMemoryError("memory_not_found", "One or more memories were not found.", "Pass existing memory IDs.");
  }
  return ordered as MemoryRecord[];
}

export async function listMemories(profileId: string): Promise<MemoryRecord[]> {
  return queryMemoriesWhere(`profile_id = ${sqlStringLiteral(profileId)}`);
}

const PREVIEW_LEN = 200;

export interface MemoryCompactView {
  memory_id: string;
  profile_id: string;
  namespace: string;
  memory_type: MemoryType;
  status: MemoryRecord["status"];
  content_preview: string;
  labels: string[];
  created_at: string;
  updated_at: string;
}

export function toMemoryCompactView(record: MemoryRecord): MemoryCompactView {
  const preview =
    record.content.length <= PREVIEW_LEN ? record.content : `${record.content.slice(0, PREVIEW_LEN)}…`;
  return {
    memory_id: record.memory_id,
    profile_id: record.profile_id,
    namespace: record.namespace,
    memory_type: record.memory_type,
    status: record.status,
    content_preview: preview,
    labels: record.labels,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

export interface MemoryListFilters {
  memory_type?: MemoryType;
  status?: MemoryRecord["status"];
  namespace?: string;
  label?: string;
  limit: number;
  offset: number;
}

export interface MemoryListPage {
  records: MemoryCompactView[];
  next_cursor: string | null;
  applied_filters: MemoryListFilters & { profile_id: string };
}

export function encodeListCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

export function decodeListCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { o?: unknown };
    const o = typeof parsed.o === "number" && Number.isFinite(parsed.o) && parsed.o >= 0 ? parsed.o : 0;
    return o;
  } catch {
    return 0;
  }
}

export async function listMemoriesPage(profileId: string, filters: MemoryListFilters): Promise<MemoryListPage> {
  // TODO(perf): this path currently loads all profile memories then filters/sorts
  // in-memory; move filtering/pagination into LanceDB queries for large datasets.
  let rows = await listMemories(profileId);
  if (filters.memory_type) {
    rows = rows.filter((m) => m.memory_type === filters.memory_type);
  }
  if (filters.status) {
    rows = rows.filter((m) => m.status === filters.status);
  }
  if (filters.namespace) {
    rows = rows.filter((m) => m.namespace === filters.namespace);
  }
  const labelFilter = filters.label;
  if (labelFilter !== undefined && labelFilter !== "") {
    rows = rows.filter((m) => m.labels.includes(labelFilter));
  }
  rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const slice = rows.slice(filters.offset, filters.offset + filters.limit);
  const nextOffset = filters.offset + slice.length;
  const hasMore = nextOffset < rows.length;
  return {
    records: slice.map(toMemoryCompactView),
    next_cursor: hasMore ? encodeListCursor(nextOffset) : null,
    applied_filters: { ...filters, profile_id: profileId }
  };
}
