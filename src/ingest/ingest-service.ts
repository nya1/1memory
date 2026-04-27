import { nanoid } from "nanoid";
import { ProfileRecord } from "../core/types.js";
import { rememberMemory } from "../memory/memory-service.js";
import { resolveProfile } from "../profiles/profile-service.js";
import { INGEST_JOBS_TABLE, openLocalDatabase } from "../storage/lancedb.js";
import { withDbWriteLock } from "../storage/db-write-mutex.js";
import { assertStoreWritesAllowed } from "../storage/migrations-runner.js";

export type IngestStatus = "queued" | "running" | "completed" | "failed";

export interface IngestJobRecord {
  ingest_job_id: string;
  profile_id: string;
  session_id: string;
  ingest_mode: "sync_summary" | "async_full";
  summary?: string;
  last_error?: string;
  status: IngestStatus;
  accepted: number;
  rejected: number;
  extracted_count: number;
  active_count: number;
  quarantined_count: number;
  duplicate_count: number;
  superseded_count: number;
  warnings: string[];
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function toRow(job: IngestJobRecord): Record<string, unknown> {
  return {
    ingest_job_id: job.ingest_job_id,
    profile_id: job.profile_id,
    session_id: job.session_id,
    ingest_mode: job.ingest_mode,
    summary: job.summary ?? "",
    last_error: job.last_error ?? "",
    status: job.status,
    accepted: job.accepted,
    rejected: job.rejected,
    extracted_count: job.extracted_count,
    active_count: job.active_count,
    quarantined_count: job.quarantined_count,
    duplicate_count: job.duplicate_count,
    superseded_count: job.superseded_count,
    warnings_json: JSON.stringify(job.warnings),
    created_at: job.created_at,
    updated_at: job.updated_at
  };
}

function fromRow(row: Record<string, unknown>): IngestJobRecord {
  return {
    ingest_job_id: String(row.ingest_job_id),
    profile_id: String(row.profile_id),
    session_id: String(row.session_id),
    ingest_mode: (String(row.ingest_mode ?? "sync_summary") as "sync_summary" | "async_full"),
    summary: String(row.summary ?? "") || undefined,
    last_error: String(row.last_error ?? "") || undefined,
    status: row.status as IngestStatus,
    accepted: Number(row.accepted ?? 0),
    rejected: Number(row.rejected ?? 0),
    extracted_count: Number(row.extracted_count ?? 0),
    active_count: Number(row.active_count ?? 0),
    quarantined_count: Number(row.quarantined_count ?? 0),
    duplicate_count: Number(row.duplicate_count ?? 0),
    superseded_count: Number(row.superseded_count ?? 0),
    warnings: JSON.parse(String(row.warnings_json ?? "[]")) as string[],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

export async function runSyncSummaryIngest(
  profile: ProfileRecord,
  input: { session_id: string; summary?: string }
): Promise<{ job: IngestJobRecord; proposed_memories: string[] }> {
  assertStoreWritesAllowed();
  const timestamp = now();
  const ingestJobId = `ing_${nanoid(12)}`;
  const summary = (input.summary ?? "").trim();
  const proposed_memories = summary ? [summary] : [];

  let accepted = 0;
  let duplicate = 0;

  if (summary) {
    const remembered = await rememberMemory(profile, {
      content: summary,
      memory_type: "event",
      namespace: "session_handoff",
      labels: ["session-summary"],
      source: { session: input.session_id, client: "session_end" }
    });
    if (remembered.write_state === "duplicate_ignored") {
      duplicate = 1;
    } else {
      accepted = 1;
    }
  }

  const job: IngestJobRecord = {
    ingest_job_id: ingestJobId,
    profile_id: profile.profile_id,
    session_id: input.session_id,
    ingest_mode: "sync_summary",
    summary: summary || undefined,
    last_error: undefined,
    status: "completed",
    accepted,
    rejected: summary ? 0 : 1,
    extracted_count: summary ? 1 : 0,
    active_count: accepted,
    quarantined_count: 0,
    duplicate_count: duplicate,
    superseded_count: 0,
    warnings: summary ? [] : ["No summary content provided for sync_summary ingestion."],
    created_at: timestamp,
    updated_at: timestamp
  };

  await withDbWriteLock(async () => {
    const { db } = await openLocalDatabase();
    const table = await db.openTable(INGEST_JOBS_TABLE);
    await table.add([toRow(job)]);
  });
  return { job, proposed_memories };
}

export async function createAsyncFullIngestJob(
  profile: ProfileRecord,
  input: { session_id: string; summary?: string }
): Promise<IngestJobRecord> {
  assertStoreWritesAllowed();
  const summary = (input.summary ?? "").trim();
  const timestamp = now();
  const job: IngestJobRecord = {
    ingest_job_id: `ing_${nanoid(12)}`,
    profile_id: profile.profile_id,
    session_id: input.session_id,
    ingest_mode: "async_full",
    summary: summary || undefined,
    last_error: undefined,
    status: "queued",
    accepted: 0,
    rejected: 0,
    extracted_count: summary ? 1 : 0,
    active_count: 0,
    quarantined_count: 0,
    duplicate_count: 0,
    superseded_count: 0,
    warnings: summary ? [] : ["No summary content provided for async_full ingestion."],
    created_at: timestamp,
    updated_at: timestamp
  };

  await withDbWriteLock(async () => {
    const { db } = await openLocalDatabase();
    const table = await db.openTable(INGEST_JOBS_TABLE);
    await table.add([toRow(job)]);
  });

  return job;
}

export async function getIngestJob(ingestJobId: string): Promise<IngestJobRecord | null> {
  const { db } = await openLocalDatabase();
  const table = await db.openTable(INGEST_JOBS_TABLE);
  const rows = (await table
    .query()
    .where(`ingest_job_id = '${ingestJobId.replace(/'/g, "''")}'`)
    .limit(1)
    .toArray()) as Record<string, unknown>[];
  if (rows.length === 0) {
    return null;
  }
  return fromRow(rows[0]!);
}

export async function resumeIngestJobIfNeeded(ingestJobId: string): Promise<IngestJobRecord | null> {
  assertStoreWritesAllowed();
  const current = await getIngestJob(ingestJobId);
  if (!current) return null;
  if (current.status !== "queued" && current.status !== "running") {
    return current;
  }

  const safeSummary = (current.summary ?? "").trim();
  await withDbWriteLock(async () => {
    const { db } = await openLocalDatabase();
    const table = await db.openTable(INGEST_JOBS_TABLE);
    await table.update({
      where: `ingest_job_id = '${ingestJobId.replace(/'/g, "''")}'`,
      valuesSql: {
        status: "'running'",
        updated_at: `'${now()}'`
      }
    });
  });

  let accepted = 0;
  let duplicate = 0;
  let rejected = 0;
  let warnings: string[] = [];
  let status: IngestStatus = "completed";
  let lastError: string | undefined;

  if (safeSummary) {
    try {
      const profile = await resolveProfile({ profile_id: current.profile_id });
      const remembered = await rememberMemory(profile, {
        content: safeSummary,
        memory_type: "event",
        namespace: "session_handoff",
        labels: ["session-summary", "async-ingest"],
        source: { session: current.session_id, client: "memory_ingest_status" }
      });
      if (remembered.write_state === "duplicate_ignored") {
        duplicate = 1;
      } else {
        accepted = 1;
      }
    } catch (error) {
      status = "failed";
      rejected = 1;
      lastError =
        error instanceof Error
          ? `Unable to resolve profile '${current.profile_id}' while resuming async ingest: ${error.message}`
          : `Unable to resolve profile '${current.profile_id}' while resuming async ingest.`;
      warnings = [lastError];
    }
  } else {
    rejected = 1;
    status = "failed";
    lastError = "No summary content available for async_full ingestion.";
    warnings = [lastError];
  }

  await withDbWriteLock(async () => {
    const { db } = await openLocalDatabase();
    const table = await db.openTable(INGEST_JOBS_TABLE);
    await table.update({
      where: `ingest_job_id = '${ingestJobId.replace(/'/g, "''")}'`,
      valuesSql: {
        status: `'${status}'`,
        accepted: `${accepted}`,
        rejected: `${rejected}`,
        active_count: `${accepted}`,
        duplicate_count: `${duplicate}`,
        warnings_json: `'${JSON.stringify(warnings).replace(/'/g, "''")}'`,
        last_error: `'${(lastError ?? "").replace(/'/g, "''")}'`,
        updated_at: `'${now()}'`
      }
    });
  });

  return getIngestJob(ingestJobId);
}
