import { z } from "zod";
import { ProfileRecord } from "../core/types.js";
import { listMemories } from "../memory/memory-service.js";
import { openLocalDatabase, SESSIONS_TABLE } from "../storage/lancedb.js";
import { assertStoreWritesAllowed } from "../storage/migrations-runner.js";
import { withDbWriteLock } from "../storage/db-write-mutex.js";

export type SessionStatus = "active" | "completed" | "interrupted" | "failed" | "handoff";

export interface SessionRecord {
  session_id: string;
  profile_id: string;
  client: string;
  workspace?: string;
  repo?: string;
  branch?: string;
  status: SessionStatus;
  started_at: string;
  ended_at?: string;
  summary?: string;
  handoff_summary?: string;
  metadata: Record<string, unknown>;
}

export interface SessionScopeHint {
  workspace?: string;
  repo?: string;
  branch?: string;
}

const startSessionInputSchema = z.object({
  session_id: z.string().min(1),
  client: z.string().min(1).default("unknown_client"),
  workspace: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional()
});

const endSessionInputSchema = z.object({
  session_id: z.string().min(1),
  client: z.string().optional(),
  summary: z.string().optional(),
  outcome: z.enum(["completed", "interrupted", "failed", "handoff"]).default("completed")
});

function now(): string {
  return new Date().toISOString();
}

function toDbRow(record: SessionRecord): Record<string, unknown> {
  return {
    session_id: record.session_id,
    profile_id: record.profile_id,
    client: record.client,
    workspace: record.workspace ?? "",
    repo: record.repo ?? "",
    branch: record.branch ?? "",
    status: record.status,
    started_at: record.started_at,
    ended_at: record.ended_at ?? "",
    summary: record.summary ?? "",
    handoff_summary: record.handoff_summary ?? "",
    metadata_json: JSON.stringify(record.metadata)
  };
}

function fromDbRow(row: Record<string, unknown>): SessionRecord {
  const workspace = String(row.workspace ?? "");
  const repo = String(row.repo ?? "");
  const branch = String(row.branch ?? "");
  const endedAt = String(row.ended_at ?? "");
  const summary = String(row.summary ?? "");
  const handoff = String(row.handoff_summary ?? "");
  const metadataJson = String(row.metadata_json ?? "{}");
  return {
    session_id: String(row.session_id),
    profile_id: String(row.profile_id),
    client: String(row.client ?? "unknown_client"),
    workspace: workspace || undefined,
    repo: repo || undefined,
    branch: branch || undefined,
    status: row.status as SessionStatus,
    started_at: String(row.started_at),
    ended_at: endedAt || undefined,
    summary: summary || undefined,
    handoff_summary: handoff || undefined,
    metadata: JSON.parse(metadataJson) as Record<string, unknown>
  };
}

export async function startSession(profile: ProfileRecord, rawInput: unknown): Promise<SessionRecord> {
  assertStoreWritesAllowed();
  return withDbWriteLock(async () => {
    const input = startSessionInputSchema.parse(rawInput);
    const { db } = await openLocalDatabase();
    const table = await db.openTable(SESSIONS_TABLE);
    const existing = (await table
      .query()
      .where(`session_id = '${input.session_id.replace(/'/g, "''")}'`)
      .limit(1)
      .toArray()) as Record<string, unknown>[];

    const startedAt = now();
    if (existing.length > 0) {
      const existingStartedAt = String(existing[0]?.started_at ?? startedAt);
      await table.update({
        where: `session_id = '${input.session_id.replace(/'/g, "''")}'`,
        valuesSql: {
          status: "'active'",
          client: `'${input.client.replace(/'/g, "''")}'`,
          workspace: `'${(input.workspace ?? "").replace(/'/g, "''")}'`,
          repo: `'${(input.repo ?? "").replace(/'/g, "''")}'`,
          branch: `'${(input.branch ?? "").replace(/'/g, "''")}'`,
          ended_at: "''"
        }
      });
      const [row] = (await table
        .query()
        .where(`session_id = '${input.session_id.replace(/'/g, "''")}'`)
        .limit(1)
        .toArray()) as Record<string, unknown>[];
      if (!row) {
        // Defensive fallback: if the post-update re-query races or returns empty,
        // return a synthetic active session instead of throwing on undefined row.
        return {
          session_id: input.session_id,
          profile_id: profile.profile_id,
          client: input.client,
          workspace: input.workspace,
          repo: input.repo,
          branch: input.branch,
          status: "active",
          started_at: existingStartedAt,
          metadata: {
            synthetic_session: true,
            synthetic_reason: "session_start_update_without_row"
          }
        };
      }
      return fromDbRow(row);
    }

    const session: SessionRecord = {
      session_id: input.session_id,
      profile_id: profile.profile_id,
      client: input.client,
      workspace: input.workspace,
      repo: input.repo,
      branch: input.branch,
      status: "active",
      started_at: startedAt,
      metadata: {}
    };
    await table.add([toDbRow(session)]);
    return session;
  });
}

export async function getSessionById(sessionId: string): Promise<SessionRecord | null> {
  const { db } = await openLocalDatabase();
  const table = await db.openTable(SESSIONS_TABLE);
  const rows = (await table
    .query()
    .where(`session_id = '${sessionId.replace(/'/g, "''")}'`)
    .limit(1)
    .toArray()) as Record<string, unknown>[];
  if (rows.length === 0) {
    return null;
  }
  return fromDbRow(rows[0]!);
}

export async function endSession(profile: ProfileRecord, rawInput: unknown): Promise<SessionRecord> {
  assertStoreWritesAllowed();
  return withDbWriteLock(async () => {
    const input = endSessionInputSchema.parse(rawInput);
    const { db } = await openLocalDatabase();
    const table = await db.openTable(SESSIONS_TABLE);
    const endedAt = now();
    const handoff = input.summary ?? `Session ${input.session_id} ended as ${input.outcome}.`;

    await table.update({
      where: `session_id = '${input.session_id.replace(/'/g, "''")}'`,
      valuesSql: {
        status: `'${input.outcome}'`,
        ended_at: `'${endedAt}'`,
        summary: `'${(input.summary ?? "").replace(/'/g, "''")}'`,
        handoff_summary: `'${handoff.replace(/'/g, "''")}'`
      }
    });

    const [row] = (await table
      .query()
      .where(`session_id = '${input.session_id.replace(/'/g, "''")}'`)
      .limit(1)
      .toArray()) as Record<string, unknown>[];

    if (!row) {
      const fallback: SessionRecord = {
        session_id: input.session_id,
        profile_id: profile.profile_id,
        client: input.client ?? "unknown_client",
        status: input.outcome,
        started_at: endedAt,
        ended_at: endedAt,
        summary: input.summary,
        handoff_summary: handoff,
        metadata: {
          synthetic_session: true,
          synthetic_reason: "session_end_without_prior_start"
        }
      };
      await table.add([toDbRow(fallback)]);
      return fallback;
    }
    return fromDbRow(row);
  });
}

function matchesScope(memory: Awaited<ReturnType<typeof listMemories>>[number], scope: SessionScopeHint): boolean {
  if (scope.repo && memory.source_repo !== scope.repo) {
    return false;
  }
  if (scope.branch && memory.source_branch !== scope.branch) {
    return false;
  }
  return true;
}

async function listSessionIdsForWorkspace(profileId: string, workspace: string): Promise<Set<string>> {
  const { db } = await openLocalDatabase();
  const table = await db.openTable(SESSIONS_TABLE);
  const rows = (await table
    .query()
    .where(
      `profile_id = '${profileId.replace(/'/g, "''")}' AND workspace = '${workspace.replace(/'/g, "''")}' AND session_id != ''`
    )
    .toArray()) as Array<Record<string, unknown>>;
  return new Set(rows.map((row) => String(row.session_id ?? "")).filter((sessionId) => sessionId.length > 0));
}

export async function buildSessionContextBlock(profile: ProfileRecord, scope: SessionScopeHint = {}): Promise<string> {
  const allMemories = (await listMemories(profile.profile_id))
    .filter((memory) => memory.status === "active")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  // TODO(perf): this currently filters in-memory over full profile memory rows;
  // push workspace/repo/branch predicates down to storage query when available.
  let filtered = allMemories.filter((memory) => matchesScope(memory, scope));

  if (scope.workspace) {
    const workspaceSessionIds = await listSessionIdsForWorkspace(profile.profile_id, scope.workspace);
    if (workspaceSessionIds.size > 0) {
      // Best-effort scoping: keep memories without source_session as global context.
      filtered = filtered.filter((memory) => !memory.source_session || workspaceSessionIds.has(memory.source_session));
    }
  }

  const memories = filtered.slice(0, 6);
  if (memories.length === 0) {
    return "No matching local memories were found.";
  }
  return ["Relevant JustMemory context:", ...memories.map((m) => `- [${m.memory_id}] ${m.content}`)].join("\n");
}
