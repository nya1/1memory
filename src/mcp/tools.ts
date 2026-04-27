import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { recordAuditEvent } from "../audit/audit-service.js";
import { failure, newRequestId, success } from "../core/envelope.js";
import { ProfileRecord } from "../core/types.js";
import {
  decodeListCursor,
  getMemories,
  listMemoriesPage,
  rememberMemory
} from "../memory/memory-service.js";
import { resolveProfile, listProfiles, selectProfile } from "../profiles/profile-service.js";
import { recallMemory } from "../recall/recall-service.js";
import { capabilities, explainSetup, health } from "../health/health-service.js";
import {
  createAsyncFullIngestJob,
  getIngestJob,
  resumeIngestJobIfNeeded,
  runSyncSummaryIngest
} from "../ingest/ingest-service.js";
import { buildSessionContextBlock, endSession, getSessionById, startSession } from "../sessions/session-service.js";

export const profileContextSchema = z.object({
  profile_id: z.string().optional(),
  workspace: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional()
});

export const memoryContextInputSchema = profileContextSchema.extend({
  session_id: z.string().optional(),
  focus: z.enum(["project", "task", "review", "handoff", "debug"]).optional(),
  token_budget: z.coerce.number().int().min(1).max(8000).optional(),
  token_budget_mode: z.enum(["small", "normal", "deep"]).optional()
});

export const memoryRememberInputSchema = z.object({
  content: z.string().min(1).max(4000),
  memory_type: z.enum(["fact", "event", "instruction", "task"]),
  session_id: z.string().optional(),
  client: z.string().optional(),
  profile_id: z.string().optional(),
  workspace: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  namespace: z.string().optional(),
  topic_key: z.string().optional(),
  labels: z.array(z.string()).optional(),
  source: z
    .object({
      actor: z.string().optional(),
      client: z.string().optional(),
      session: z.string().optional(),
      repo: z.string().optional(),
      branch: z.string().optional(),
      file_paths: z.array(z.string()).optional()
    })
    .optional()
});

export const memorySessionStartInputSchema = z.object({
  client: z.string().default("unknown_client"),
  session_id: z.string().min(1).optional(),
  profile_id: z.string().optional(),
  workspace: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional()
});

export const memorySessionEndInputSchema = z.object({
  session_id: z.string().min(1),
  client: z.string().optional(),
  profile_id: z.string().optional(),
  workspace: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  summary: z.string().optional(),
  outcome: z.enum(["completed", "interrupted", "failed", "handoff"]).optional(),
  ingest_mode: z.enum(["none", "sync_summary", "async_full"]).default("none"),
  preview: z.boolean().optional()
});

const sessionContextSchema = z.object({
  session_id: z.string().optional(),
  client: z.string().optional(),
  workspace: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional()
});

const FOCUS_KEYWORDS: Record<NonNullable<z.infer<typeof memoryContextInputSchema>["focus"]>, string[]> = {
  project: ["project", "architecture", "system", "overview", "dependency"],
  task: ["task", "todo", "next", "action", "implement"],
  review: ["review", "feedback", "regression", "risk", "test"],
  handoff: ["handoff", "summary", "follow-up", "next step", "open"],
  debug: ["debug", "bug", "error", "failure", "fix"]
};

function resolveTokenBudget(input: z.infer<typeof memoryContextInputSchema>): number {
  const modeDefault: Record<"small" | "normal" | "deep", number> = {
    small: 700,
    normal: 1400,
    deep: 2600
  };
  if (input.token_budget !== undefined) {
    return input.token_budget;
  }
  return modeDefault[input.token_budget_mode ?? "normal"];
}

function shapeContextBlock(
  contextBlock: string,
  input: z.infer<typeof memoryContextInputSchema>
): { context_block: string; warnings: string[] } {
  const warnings: string[] = [];
  const shapingRequested = Boolean(input.focus || input.token_budget !== undefined || input.token_budget_mode);
  if (!contextBlock.startsWith("Relevant 1memory context:")) {
    return { context_block: contextBlock, warnings };
  }
  const lines = contextBlock.split("\n");
  const header = lines[0] ?? "Relevant 1memory context:";
  const memoryLines = lines.slice(1).filter((line) => line.trim().length > 0);
  if (memoryLines.length === 0) {
    return { context_block: contextBlock, warnings };
  }
  if (shapingRequested) {
    warnings.push("Applied deterministic focus/token-budget context shaping.");
  }
  const budget = resolveTokenBudget(input);
  const maxChars = Math.max(120, Math.floor(budget * 4));
  const maxItemsByBudget = Math.max(1, Math.min(6, Math.floor(maxChars / 140)));
  const keywords = input.focus ? FOCUS_KEYWORDS[input.focus] : [];

  const scored = memoryLines.map((line, index) => {
    const lower = line.toLowerCase();
    const focusHits = keywords.reduce((count, kw) => (lower.includes(kw) ? count + 1 : count), 0);
    return { line, index, focusHits };
  });

  const prioritized = [...scored].sort((a, b) => {
    if (b.focusHits !== a.focusHits) return b.focusHits - a.focusHits;
    return a.index - b.index;
  });

  const selectedSet = new Set(prioritized.slice(0, maxItemsByBudget).map((entry) => entry.index));
  let selected = scored.filter((entry) => selectedSet.has(entry.index)).map((entry) => entry.line);

  let candidate = [header, ...selected].join("\n");
  while (candidate.length > maxChars && selected.length > 1) {
    selected = selected.slice(0, -1);
    candidate = [header, ...selected].join("\n");
  }
  if (candidate.length > maxChars) {
    candidate = candidate.slice(0, maxChars).trimEnd();
    warnings.push(`Context block truncated to fit token budget (${budget}).`);
  }

  if (selected.length < memoryLines.length) {
    warnings.push(
      `Context narrowed to ${selected.length}/${memoryLines.length} memories using focus/token budget shaping.`
    );
  }
  return { context_block: candidate, warnings };
}

function buildImplicitSessionId(profileId: string, input: z.infer<typeof sessionContextSchema>): string {
  const day = new Date().toISOString().slice(0, 10);
  const scopeKey = [input.workspace ?? "", input.repo ?? "", input.branch ?? ""].join("|");
  const seed = [profileId, scopeKey, day].join("|");
  const suffix = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return `sess_implicit_${suffix}`;
}

async function ensureSession(
  profile: ProfileRecord,
  input: z.infer<typeof sessionContextSchema>,
  options: { bestEffort: boolean }
): Promise<{ session_id: string; client: string }> {
  const derivedClient = input.client ?? "unknown_client";
  const session_id = input.session_id ?? buildImplicitSessionId(profile.profile_id, input);
  let effectiveClient = derivedClient;
  try {
    const existing = await getSessionById(session_id);
    if (!existing) {
      await startSession(profile, {
        session_id,
        client: derivedClient,
        workspace: input.workspace,
        repo: input.repo,
        branch: input.branch
      });
    } else {
      effectiveClient = existing.client;
    }
  } catch (error) {
    if (!options.bestEffort) {
      throw error;
    }
  }
  return { session_id, client: effectiveClient };
}

export async function handleMemoryCapabilities(input: unknown = {}) {
  try {
    const parsed = profileContextSchema.parse(input);
    const profile = await resolveProfile(parsed);
    return success(await capabilities(profile), { profile_id: profile.profile_id });
  } catch (error) {
    return failure(error);
  }
}

export async function handleMemoryHealth(input: unknown = {}) {
  try {
    const parsed = profileContextSchema.parse(input);
    const profile = await resolveProfile(parsed);
    return success(await health(profile), { profile_id: profile.profile_id });
  } catch (error) {
    return failure(error);
  }
}

export async function handleMemoryExplainSetup(input: unknown = {}) {
  try {
    const parsed = profileContextSchema.parse(input);
    const profile = await resolveProfile(parsed);
    return success(explainSetup(profile), { profile_id: profile.profile_id });
  } catch (error) {
    return failure(error);
  }
}

export async function handleProfilesList() {
  try {
    return success({ profiles: await listProfiles() });
  } catch (error) {
    return failure(error);
  }
}

export async function handleProfileCurrent(input: unknown = {}) {
  try {
    const parsed = profileContextSchema.parse(input);
    const profile = await resolveProfile(parsed);
    return success(
      { profile, resolution_source: "local_profile_resolution", readable: true, writable: true },
      { profile_id: profile.profile_id }
    );
  } catch (error) {
    return failure(error);
  }
}

export async function handleProfileSelect(input: unknown) {
  const request_id = newRequestId();
  try {
    const parsed = z
      .object({
        profile_id: z.string(),
        workspace: z.string().optional(),
        repo: z.string().optional()
      })
      .parse(input);
    const profile = await selectProfile(parsed);
    await recordAuditEvent({
      request_id,
      action: "memory_profile_select",
      profile_id: profile.profile_id,
      details: { selected_profile_id: profile.profile_id }
    });
    return success(
      {
        profile,
        effective_scope: { org_id: "local", profile_id: profile.profile_id },
        readable: true,
        writable: true
      },
      { profile_id: profile.profile_id, request_id }
    );
  } catch (error) {
    return failure(error, request_id);
  }
}

export async function handleMemoryRemember(input: unknown) {
  const request_id = newRequestId();
  try {
    const parsed = memoryRememberInputSchema.parse(input);
    const profile = await resolveProfile(parsed);
    const session = await ensureSession(profile, sessionContextSchema.parse(parsed), {
      bestEffort: true
    });
    const sourceRaw = (parsed as { source?: unknown }).source;
    const sourceInput =
      sourceRaw !== null && typeof sourceRaw === "object" && !Array.isArray(sourceRaw)
        ? (sourceRaw as Record<string, unknown>)
        : {};
    // Intentional server-synthesized source fields: keep session/client/repo/branch
    // canonical for continuity and audit consistency, regardless of caller payload.
    const memory = await rememberMemory(profile, {
      ...parsed,
      source: {
        ...sourceInput,
        client: session.client,
        session: session.session_id,
        repo: String(parsed.repo ?? ""),
        branch: String(parsed.branch ?? ""),
        file_paths: Array.isArray(sourceInput.file_paths)
          ? (sourceInput.file_paths as unknown[]).map((v) => String(v))
          : []
      }
    });
    await recordAuditEvent({
      request_id,
      action: "memory_remember",
      profile_id: profile.profile_id,
      memory_id: memory.memory_id,
      details: { write_state: memory.write_state, indexing_state: memory.indexing_state }
    });
    return success(
      {
        memory_id: memory.memory_id,
        status: memory.status,
        write_state: memory.write_state,
        indexing_state: memory.indexing_state,
        dedupe_result: memory.write_state === "duplicate_ignored" ? "exact_duplicate" : "new_memory",
        supersession_candidates: [],
        quarantine_reason: null,
        warnings: memory.write_state === "duplicate_ignored" ? ["Exact duplicate already exists; write was ignored."] : []
      },
      {
        profile_id: profile.profile_id,
        write_state: memory.write_state,
        indexing_state: memory.indexing_state,
        request_id
      }
    );
  } catch (error) {
    return failure(error, request_id);
  }
}

export async function handleMemoryGet(input: unknown) {
  const request_id = newRequestId();
  try {
    const parsed = z
      .object({
        memory_ids: z.array(z.string().min(1)).min(1),
        profile_id: z.string().optional(),
        workspace: z.string().optional(),
        repo: z.string().optional(),
        branch: z.string().optional()
      })
      .parse(input);
    const profile = await resolveProfile(parsed);
    // Intentional behavior: memory_get is a direct ID lookup by design and remains
    // cross-profile for known IDs; profile resolution here is for auditing/context.
    const records = await getMemories(parsed.memory_ids);
    await recordAuditEvent({
      request_id,
      action: "memory_get",
      profile_id: profile.profile_id,
      details: { memory_ids: parsed.memory_ids, count: records.length }
    });
    return success({ records }, { profile_id: profile.profile_id, request_id });
  } catch (error) {
    return failure(error, request_id);
  }
}

const memoryListInputSchema = profileContextSchema.extend({
  memory_type: z.enum(["fact", "event", "instruction", "task"]).optional(),
  status: z.enum(["active", "superseded", "inactive", "quarantined"]).optional(),
  namespace: z.string().optional(),
  label: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional()
});

export async function handleMemoryList(input: unknown = {}) {
  const request_id = newRequestId();
  try {
    const parsed = memoryListInputSchema.parse(input);
    const profile = await resolveProfile(parsed);
    const offset = decodeListCursor(parsed.cursor);
    const page = await listMemoriesPage(profile.profile_id, {
      memory_type: parsed.memory_type,
      status: parsed.status,
      namespace: parsed.namespace,
      label: parsed.label,
      limit: parsed.limit,
      offset
    });
    await recordAuditEvent({
      request_id,
      action: "memory_list",
      profile_id: profile.profile_id,
      details: { returned: page.records.length, has_more: Boolean(page.next_cursor) }
    });
    return success(
      {
        records: page.records,
        next_cursor: page.next_cursor,
        applied_filters: page.applied_filters
      },
      { profile_id: profile.profile_id, request_id }
    );
  } catch (error) {
    return failure(error, request_id);
  }
}

export async function handleMemoryRecall(input: unknown) {
  const request_id = newRequestId();
  try {
    const parsed = z
      .object({
        query: z.string().min(1),
        session_id: z.string().optional(),
        client: z.string().optional(),
        profile_id: z.string().optional(),
        workspace: z.string().optional(),
        repo: z.string().optional(),
        branch: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(8)
      })
      .parse(input);
    const profile = await resolveProfile(parsed);
    await ensureSession(profile, sessionContextSchema.parse(parsed), { bestEffort: true });
    const result = await recallMemory(profile, parsed.query, parsed.limit);
    await recordAuditEvent({
      request_id,
      action: "memory_recall",
      profile_id: profile.profile_id,
      details: { query_len: parsed.query.length, candidates: result.candidate_ids.length }
    });
    return success(result, { profile_id: profile.profile_id, request_id });
  } catch (error) {
    return failure(error, request_id);
  }
}

export async function handleMemorySessionStart(input: unknown) {
  const request_id = newRequestId();
  try {
    const parsed = memorySessionStartInputSchema.parse(input);
    const sessionInput = {
      ...parsed,
      session_id: parsed.session_id ?? `sess_${nanoid(12)}`
    };
    const profile = await resolveProfile(parsed);
    const session = await startSession(profile, sessionInput);
    const contextBlock = await buildSessionContextBlock(profile, {
      workspace: sessionInput.workspace,
      repo: sessionInput.repo,
      branch: sessionInput.branch
    });
    await recordAuditEvent({
      request_id,
      action: "memory_session_start",
      profile_id: profile.profile_id,
      details: { session_id: session.session_id, client: session.client }
    });
    return success(
      {
        session_id: session.session_id,
        session_status: session.status,
        resolved_profile: profile,
        scope: {
          org_id: "local",
          profile_id: profile.profile_id,
          workspace: sessionInput.workspace,
          repo: sessionInput.repo,
          branch: sessionInput.branch
        },
        context_block: contextBlock,
        relevant_active_instructions: [],
        recent_items: []
      },
      { profile_id: profile.profile_id, request_id }
    );
  } catch (error) {
    return failure(error, request_id);
  }
}

export async function handleMemoryContext(input: unknown = {}) {
  const request_id = newRequestId();
  try {
    const parsed = memoryContextInputSchema.parse(input);
    const profile = await resolveProfile(parsed);
    let scope = {
      workspace: parsed.workspace,
      repo: parsed.repo,
      branch: parsed.branch
    };
    if (parsed.session_id) {
      const session = await getSessionById(parsed.session_id);
      if (session && session.profile_id === profile.profile_id) {
        scope = {
          workspace: scope.workspace ?? session.workspace,
          repo: scope.repo ?? session.repo,
          branch: scope.branch ?? session.branch
        };
      }
    }
    const contextBlock = await buildSessionContextBlock(profile, {
      workspace: scope.workspace,
      repo: scope.repo,
      branch: scope.branch
    });
    const shaped = shapeContextBlock(contextBlock, parsed);
    await recordAuditEvent({
      request_id,
      action: "memory_context",
      profile_id: profile.profile_id,
      details: {
        workspace: parsed.workspace ?? null,
        repo: parsed.repo ?? null,
        branch: parsed.branch ?? null,
        focus: parsed.focus ?? null,
        token_budget_mode: parsed.token_budget_mode ?? null,
        token_budget: parsed.token_budget ?? null
      }
    });
    return success(
      {
        resolved_profile: profile,
        scope: {
          org_id: "local",
          profile_id: profile.profile_id,
          workspace: scope.workspace,
          repo: scope.repo,
          branch: scope.branch
        },
        context_block: shaped.context_block,
        citations: [],
        relevant_active_instructions: [],
        recent_items: [],
        warnings: shaped.warnings
      },
      { profile_id: profile.profile_id, request_id }
    );
  } catch (error) {
    return failure(error, request_id);
  }
}


export async function handleMemorySessionEnd(input: unknown) {
  const request_id = newRequestId();
  try {
    const parsed = memorySessionEndInputSchema.parse(input);
    const profile = await resolveProfile(parsed);
    const session = await endSession(profile, parsed);
    let ingestJobId: string | null = null;
    let proposedMemories: string[] | undefined;
    if (parsed.ingest_mode === "sync_summary") {
      const ingest = await runSyncSummaryIngest(profile, {
        session_id: session.session_id,
        summary: parsed.summary
      });
      ingestJobId = ingest.job.ingest_job_id;
      proposedMemories = parsed.preview ? ingest.proposed_memories : undefined;
    } else if (parsed.ingest_mode === "async_full") {
      const ingest = await createAsyncFullIngestJob(profile, {
        session_id: session.session_id,
        summary: parsed.summary
      });
      ingestJobId = ingest.ingest_job_id;
      proposedMemories = parsed.preview ? [parsed.summary ?? ""].filter((v) => v.trim().length > 0) : undefined;
    }
    await recordAuditEvent({
      request_id,
      action: "memory_session_end",
      profile_id: profile.profile_id,
      details: {
        session_id: session.session_id,
        outcome: session.status,
        ingest_mode: parsed.ingest_mode,
        ingest_job_id: ingestJobId
      }
    });
    return success(
      {
        session_id: session.session_id,
        session_status: session.status,
        ingest_job_id: ingestJobId,
        handoff_summary: session.handoff_summary ?? session.summary ?? "",
        proposed_memories: proposedMemories
      },
      { profile_id: profile.profile_id, request_id }
    );
  } catch (error) {
    return failure(error, request_id);
  }
}

export async function handleMemoryIngestStatus(input: unknown) {
  const request_id = newRequestId();
  try {
    const parsed = z
      .object({
        ingest_job_id: z.string().min(1),
        profile_id: z.string().optional(),
        workspace: z.string().optional(),
        repo: z.string().optional()
      })
      .parse(input);
    const profile = await resolveProfile(parsed);
    const existing = await getIngestJob(parsed.ingest_job_id);
    const job =
      existing && (existing.status === "queued" || existing.status === "running")
        ? await resumeIngestJobIfNeeded(parsed.ingest_job_id)
        : existing;
    if (!job) {
      return success(
        {
          ingest_job_id: parsed.ingest_job_id,
          status: "not_found",
          last_error: null,
          accepted: 0,
          rejected: 0,
          extracted_count: 0,
          active_count: 0,
          quarantined_count: 0,
          duplicate_count: 0,
          superseded_count: 0,
          warnings: ["Ingest job was not found."]
        },
        { profile_id: profile.profile_id, request_id }
      );
    }
    await recordAuditEvent({
      request_id,
      action: "memory_ingest_status",
      profile_id: profile.profile_id,
      details: { ingest_job_id: job.ingest_job_id, status: job.status }
    });
    return success(
      {
        ingest_job_id: job.ingest_job_id,
        status: job.status,
        last_error: job.last_error ?? null,
        accepted: job.accepted,
        rejected: job.rejected,
        extracted_count: job.extracted_count,
        active_count: job.active_count,
        quarantined_count: job.quarantined_count,
        duplicate_count: job.duplicate_count,
        superseded_count: job.superseded_count,
        warnings: job.warnings
      },
      { profile_id: profile.profile_id, request_id }
    );
  } catch (error) {
    return failure(error, request_id);
  }
}
