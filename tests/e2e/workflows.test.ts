import { describe, expect, it } from "vitest";
import { countAuditEvents } from "../../src/audit/audit-service.js";
import {
  handleMemoryCapabilities,
  handleMemoryContext,
  handleMemoryExplainSetup,
  handleMemoryGet,
  handleMemoryHealth,
  handleMemoryList,
  handleMemoryRecall,
  handleMemoryRemember,
  handleMemoryIngestStatus,
  handleMemorySessionEnd,
  handleMemorySessionStart,
  handleProfileCurrent,
  handleProfileSelect,
  handleProfilesList
} from "../../src/mcp/tools.js";
import { openLocalDatabase, SESSIONS_TABLE } from "../../src/storage/lancedb.js";
import { withTempJustMemoryHome } from "../helpers/test-env.js";

const ws = (name: string) => `/tmp/justmemory-e2e-${name}`;

describe("e2e workflows (MCP handlers)", () => {
  it("workflow: cold start — list profiles, capabilities, health, explain, current profile", async () => {
    await withTempJustMemoryHome(async () => {
      const list = await handleProfilesList();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data.profiles.length).toBeGreaterThanOrEqual(1);

      const cap = await handleMemoryCapabilities({ workspace: ws("cold") });
      expect(cap.ok).toBe(true);
      if (!cap.ok) return;
      expect(cap.data.tools_enabled).toContain("memory_recall");
      expect(cap.data.retrieval_channels).toEqual(expect.arrayContaining(["lexical", "metadata", "vector"]));
      expect(cap.data.vector_retrieval_ready).toBe(true);

      const healthRes = await handleMemoryHealth({ workspace: ws("cold") });
      expect(healthRes.ok).toBe(true);
      if (!healthRes.ok) return;
      expect(healthRes.data.profile_accessible).toBe(true);
      expect(healthRes.data.authoritative_store_connected).toBe(true);

      const explain = await handleMemoryExplainSetup({ workspace: ws("cold") });
      expect(explain.ok).toBe(true);
      if (!explain.ok) return;
      expect(explain.data.resolved_profile).toBeTruthy();
      expect(explain.data.read_write_capability).toBe("read_write");

      const current = await handleProfileCurrent({ workspace: ws("cold") });
      expect(current.ok).toBe(true);
      if (!current.ok) return;
      expect(current.data.profile.profile_id).toBeTruthy();

      const context = await handleMemoryContext({ workspace: ws("cold") });
      expect(context.ok).toBe(true);
      if (!context.ok) return;
      expect(context.data.resolved_profile.profile_id).toBeTruthy();
      expect(context.data.context_block).toMatch(/No matching local memories were found|Relevant JustMemory context/);
    });
  });

  it("workflow: write → get → recall → list with filters", async () => {
    await withTempJustMemoryHome(async () => {
      const w = ws("crud");
      const remembered = await handleMemoryRemember({
        workspace: w,
        content: "E2E verification uses Vitest and the MCP tool surface.",
        memory_type: "instruction",
        namespace: "e2e",
        topic_key: "testing",
        labels: ["e2e", "vitest"]
      });
      expect(remembered.ok).toBe(true);
      if (!remembered.ok) return;
      const memoryId = remembered.data.memory_id;
      expect(remembered.data.write_state).toBe("accepted");
      expect(remembered.data.indexing_state).toBe("ready");

      const loaded = await handleMemoryGet({
        workspace: w,
        memory_ids: [memoryId]
      });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.data.records).toHaveLength(1);
      expect(loaded.data.records[0].content).toContain("Vitest");

      const recalled = await handleMemoryRecall({
        workspace: w,
        query: "How do we verify E2E with Vitest?",
        limit: 5
      });
      expect(recalled.ok).toBe(true);
      if (!recalled.ok) return;
      expect(recalled.data.candidate_ids).toContain(memoryId);
      expect(recalled.data.citations.some((c: { memory_id: string }) => c.memory_id === memoryId)).toBe(true);
      expect(recalled.data.retrieval_channels_used.length).toBeGreaterThanOrEqual(1);
      expect(recalled.data.retrieval_channels_used).toContain("vector");

      const listedNs = await handleMemoryList({
        workspace: w,
        namespace: "e2e",
        limit: 10
      });
      expect(listedNs.ok).toBe(true);
      if (!listedNs.ok) return;
      expect(listedNs.data.records.some((r: { memory_id: string }) => r.memory_id === memoryId)).toBe(true);

      const listedLabel = await handleMemoryList({
        workspace: w,
        label: "e2e",
        limit: 10
      });
      expect(listedLabel.ok).toBe(true);
      if (!listedLabel.ok) return;
      expect(listedLabel.data.records.some((r: { memory_id: string }) => r.memory_id === memoryId)).toBe(true);

      const audits = await countAuditEvents();
      expect(audits).toBeGreaterThanOrEqual(3);
    });
  });

  it("workflow: remember without explicit session stores implicit source session metadata", async () => {
    await withTempJustMemoryHome(async () => {
      const w = ws("implicit-session-remember");
      const remembered = await handleMemoryRemember({
        workspace: w,
        client: "cursor",
        branch: "main",
        repo: "github.com/example/repo",
        content: "Implicit session metadata should be captured for remember.",
        memory_type: "fact"
      });
      expect(remembered.ok).toBe(true);
      if (!remembered.ok) return;

      const loaded = await handleMemoryGet({
        workspace: w,
        memory_ids: [remembered.data.memory_id]
      });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      expect(loaded.data.records[0].source_client).toBe("cursor");
      expect(loaded.data.records[0].source_branch).toBe("main");
      expect(loaded.data.records[0].source_repo).toBe("github.com/example/repo");
      expect(loaded.data.records[0].source_session).toBeTruthy();

      const rememberedBare = await handleMemoryRemember({
        workspace: w,
        repo: "github.com/example/repo",
        branch: "main",
        content: "Second remember call reuses prior implicit session metadata.",
        memory_type: "fact"
      });
      expect(rememberedBare.ok).toBe(true);
      if (!rememberedBare.ok) return;

      const loadedBare = await handleMemoryGet({
        workspace: w,
        memory_ids: [rememberedBare.data.memory_id]
      });
      expect(loadedBare.ok).toBe(true);
      if (!loadedBare.ok) return;

      expect(loadedBare.data.records[0].source_client).toBe("cursor");
      // Implicit sessions should inherit the persisted client from the first call.
      expect(loadedBare.data.records[0].source_session).toBe(loaded.data.records[0].source_session);
    });
  });

  it("workflow: memory_context best-effort scopes by repo/branch when source metadata is available", async () => {
    await withTempJustMemoryHome(async () => {
      const workspace = ws("context-scope");
      await handleMemoryRemember({
        workspace,
        repo: "github.com/acme/repo-a",
        branch: "main",
        content: "Repo A deploy requires signed tags.",
        memory_type: "instruction"
      });
      await handleMemoryRemember({
        workspace,
        repo: "github.com/acme/repo-b",
        branch: "main",
        content: "Repo B deploy requires release branches.",
        memory_type: "instruction"
      });

      const scoped = await handleMemoryContext({
        workspace,
        repo: "github.com/acme/repo-a",
        branch: "main"
      });
      expect(scoped.ok).toBe(true);
      if (!scoped.ok) return;
      expect(scoped.data.context_block).toMatch(/Repo A deploy requires signed tags/i);
      expect(scoped.data.context_block).not.toMatch(/Repo B deploy requires release branches/i);
    });
  });

  it("workflow: memory_context uses session_id scope and deterministic focus/budget shaping", async () => {
    await withTempJustMemoryHome(async () => {
      const workspace = ws("context-session-shape");
      const sessionId = "sess_e2e_context_scope_001";

      const started = await handleMemorySessionStart({
        workspace,
        session_id: sessionId,
        client: "cursor",
        repo: "github.com/acme/repo-shape",
        branch: "main"
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await handleMemoryRemember({
        workspace,
        repo: "github.com/acme/repo-shape",
        branch: "main",
        session_id: sessionId,
        content: "Debug fix: null pointer in billing retry worker.",
        memory_type: "instruction"
      });
      await handleMemoryRemember({
        workspace,
        repo: "github.com/acme/repo-shape",
        branch: "main",
        session_id: sessionId,
        content: "Project architecture uses queue-based replay processing with idempotency keys.",
        memory_type: "fact"
      });
      await handleMemoryRemember({
        workspace,
        repo: "github.com/acme/other-repo",
        branch: "main",
        content: "Other repo memory that should be excluded by session scope.",
        memory_type: "fact"
      });

      const shapedA = await handleMemoryContext({
        workspace,
        session_id: sessionId,
        focus: "debug",
        token_budget_mode: "small"
      });
      expect(shapedA.ok).toBe(true);
      if (!shapedA.ok) return;
      const shapedB = await handleMemoryContext({
        workspace,
        session_id: sessionId,
        focus: "debug",
        token_budget_mode: "small"
      });
      expect(shapedB.ok).toBe(true);
      if (!shapedB.ok) return;

      expect(shapedA.data.scope.repo).toBe("github.com/acme/repo-shape");
      expect(shapedA.data.context_block).toContain("Debug fix");
      expect(shapedA.data.context_block).not.toContain("Other repo memory");
      expect(shapedA.data.context_block).toBe(shapedB.data.context_block);
      expect(Array.isArray(shapedA.data.warnings)).toBe(true);
      expect(shapedA.data.warnings.length).toBeGreaterThan(0);
    });
  });

  it("workflow: duplicate remember returns duplicate_ignored", async () => {
    await withTempJustMemoryHome(async () => {
      const w = ws("dedupe");
      const body = {
        workspace: w,
        content: "Idempotent memory content for dedupe e2e.",
        memory_type: "fact"
      };
      const first = await handleMemoryRemember(body);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.data.write_state).toBe("accepted");
      expect(first.data.warnings).toEqual([]);
      const id = first.data.memory_id;

      const second = await handleMemoryRemember(body);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.data.memory_id).toBe(id);
      expect(second.data.write_state).toBe("duplicate_ignored");
      expect(second.data.dedupe_result).toBe("exact_duplicate");
      expect(second.data.warnings.some((w: string) => /duplicate/i.test(w))).toBe(true);
    });
  });

  it("workflow: two workspaces keep memories isolated per profile", async () => {
    await withTempJustMemoryHome(async () => {
      const alpha = ws("alpha");
      const beta = ws("beta");

      const a = await handleMemoryRemember({
        workspace: alpha,
        content: "Secret alpha workspace token is alpha-7f3c.",
        memory_type: "fact",
        labels: ["alpha-only"]
      });
      expect(a.ok).toBe(true);
      if (!a.ok) return;

      const b = await handleMemoryRemember({
        workspace: beta,
        content: "Secret beta workspace token is beta-9d1a.",
        memory_type: "fact",
        labels: ["beta-only"]
      });
      expect(b.ok).toBe(true);
      if (!b.ok) return;

      const recallAlpha = await handleMemoryRecall({
        workspace: alpha,
        query: "What is the alpha workspace token?"
      });
      expect(recallAlpha.ok).toBe(true);
      if (!recallAlpha.ok) return;
      expect(recallAlpha.data.candidate_ids).toContain(a.data.memory_id);
      expect(recallAlpha.data.candidate_ids).not.toContain(b.data.memory_id);

      const recallBeta = await handleMemoryRecall({
        workspace: beta,
        query: "What is the beta workspace token?"
      });
      expect(recallBeta.ok).toBe(true);
      if (!recallBeta.ok) return;
      expect(recallBeta.data.candidate_ids).toContain(b.data.memory_id);
      expect(recallBeta.data.candidate_ids).not.toContain(a.data.memory_id);
    });
  });

  it("workflow: profile select then remember under that scope", async () => {
    await withTempJustMemoryHome(async () => {
      const w1 = ws("sel-a");
      const w2 = ws("sel-b");

      await handleMemoryRemember({
        workspace: w1,
        content: "Profile A marker content.",
        memory_type: "fact"
      });
      const p2Remember = await handleMemoryRemember({
        workspace: w2,
        content: "Profile B marker content.",
        memory_type: "fact"
      });
      expect(p2Remember.ok).toBe(true);
      if (!p2Remember.ok) return;

      const profiles = await handleProfilesList();
      expect(profiles.ok).toBe(true);
      if (!profiles.ok) return;
      const target = profiles.data.profiles.find((p: { scope_path: string }) => p.scope_path === w2);
      expect(target).toBeTruthy();

      const selected = await handleProfileSelect({
        profile_id: target!.profile_id,
        workspace: w1
      });
      expect(selected.ok).toBe(true);
      if (!selected.ok) return;

      const recallOnW1AfterSelect = await handleMemoryRecall({
        workspace: w1,
        query: "Profile B marker"
      });
      expect(recallOnW1AfterSelect.ok).toBe(true);
      if (!recallOnW1AfterSelect.ok) return;
      expect(recallOnW1AfterSelect.data.candidate_ids).toContain(p2Remember.data.memory_id);
    });
  });

  it("workflow: memory_list pagination across pages", async () => {
    await withTempJustMemoryHome(async () => {
      const w = ws("page");
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await handleMemoryRemember({
          workspace: w,
          content: `Pagination e2e row ${i} with shared keywords.`,
          memory_type: "fact",
          labels: ["page-e2e"]
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        ids.push(r.data.memory_id);
      }

      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let step = 0; step < 10; step++) {
        const page = await handleMemoryList({
          workspace: w,
          label: "page-e2e",
          limit: 2,
          ...(cursor ? { cursor } : {})
        });
        expect(page.ok).toBe(true);
        if (!page.ok) return;
        expect(page.data.records.length).toBeGreaterThan(0);
        for (const r of page.data.records as Array<{ memory_id: string }>) {
          seen.add(r.memory_id);
        }
        cursor = page.data.next_cursor ?? undefined;
        if (!cursor) break;
      }
      for (const id of ids) {
        expect(seen.has(id)).toBe(true);
      }
      expect(seen.size).toBe(ids.length);
    });
  });

  it("workflow: recall with no memories returns empty candidates (vector has nothing to rank)", async () => {
    await withTempJustMemoryHome(async () => {
      const w = ws("empty-recall");
      await handleMemoryCapabilities({ workspace: w });

      const recalled = await handleMemoryRecall({
        workspace: w,
        query: "zzzznonexistenttoken999"
      });
      expect(recalled.ok).toBe(true);
      if (!recalled.ok) return;
      expect(recalled.data.candidate_ids).toEqual([]);
      expect(recalled.data.answer).toMatch(/no matching/i);
      expect(Array.isArray(recalled.data.why_retrieved)).toBe(true);
    });
  });

  it("workflow: session start then end updates status and handoff summary", async () => {
    await withTempJustMemoryHome(async () => {
      const w = ws("session");
      const sessionId = "sess_e2e_001";

      const started = await handleMemorySessionStart({
        workspace: w,
        client: "cursor",
        session_id: sessionId,
        branch: "main"
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.data.session_id).toBe(sessionId);
      expect(started.data.session_status).toBe("active");
      expect(started.data.context_block).toMatch(/Relevant JustMemory context|No matching local memories were found/i);

      const ended = await handleMemorySessionEnd({
        workspace: w,
        session_id: sessionId,
        summary: "Investigated sessions workflow and captured handoff context.",
        outcome: "completed"
      });
      expect(ended.ok).toBe(true);
      if (!ended.ok) return;
      expect(ended.data.session_id).toBe(sessionId);
      expect(ended.data.session_status).toBe("completed");
      expect(ended.data.handoff_summary).toContain("Investigated sessions workflow");
      expect(ended.data.ingest_job_id).toBeNull();
    });
  });

  it("workflow: session end without prior start creates a synthetic fallback row with metadata markers", async () => {
    await withTempJustMemoryHome(async () => {
      const workspace = ws("session-end-fallback");
      const sessionId = "sess_e2e_fallback_001";
      const ended = await handleMemorySessionEnd({
        workspace,
        session_id: sessionId,
        summary: "Fallback completion summary.",
        outcome: "completed"
      });
      expect(ended.ok).toBe(true);
      if (!ended.ok) return;
      expect(ended.data.session_id).toBe(sessionId);
      expect(ended.data.session_status).toBe("completed");
      expect(ended.data.handoff_summary).toContain("Fallback completion summary.");

      const { db } = await openLocalDatabase();
      const sessions = await db.openTable(SESSIONS_TABLE);
      const rows = (await sessions
        .query()
        .where(`session_id = '${sessionId}'`)
        .toArray()) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      const metadata = JSON.parse(String(rows[0]?.metadata_json ?? "{}")) as Record<string, unknown>;
      expect(metadata.synthetic_session).toBe(true);
      expect(metadata.synthetic_reason).toBe("session_end_without_prior_start");
    });
  });

  it("workflow: session start generates session_id when omitted", async () => {
    await withTempJustMemoryHome(async () => {
      const w = ws("session-generated-id");
      const started = await handleMemorySessionStart({
        workspace: w,
        client: "cursor",
        branch: "main"
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.data.session_id).toMatch(/^sess_[a-zA-Z0-9_-]{8,}$/);
      expect(started.data.session_status).toBe("active");
    });
  });

  it("workflow: session start with existing session_id reuses row and updates client metadata", async () => {
    await withTempJustMemoryHome(async () => {
      const workspace = ws("session-start-resume");
      const sessionId = "sess_e2e_resume_001";

      const startedA = await handleMemorySessionStart({
        workspace,
        session_id: sessionId,
        client: "cursor"
      });
      expect(startedA.ok).toBe(true);
      if (!startedA.ok) return;

      const startedB = await handleMemorySessionStart({
        workspace,
        session_id: sessionId,
        client: "vscode"
      });
      expect(startedB.ok).toBe(true);
      if (!startedB.ok) return;
      expect(startedB.data.session_id).toBe(sessionId);
      expect(startedB.data.session_status).toBe("active");

      const { db } = await openLocalDatabase();
      const sessions = await db.openTable(SESSIONS_TABLE);
      const rows = (await sessions
        .query()
        .where(`session_id = '${sessionId}'`)
        .toArray()) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.client ?? "")).toBe("vscode");
    });
  });

  it("workflow: session end with sync_summary creates ingest job and recallable memory", async () => {
    await withTempJustMemoryHome(async () => {
      const w = ws("session-sync");
      const sessionId = "sess_e2e_sync_001";

      const started = await handleMemorySessionStart({
        workspace: w,
        client: "cursor",
        session_id: sessionId
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const summary = "Billing retries should use idempotency keys during replay windows.";
      const ended = await handleMemorySessionEnd({
        workspace: w,
        session_id: sessionId,
        summary,
        outcome: "completed",
        ingest_mode: "sync_summary",
        preview: true
      });
      expect(ended.ok).toBe(true);
      if (!ended.ok) return;
      expect(ended.data.ingest_job_id).toBeTruthy();
      expect(Array.isArray(ended.data.proposed_memories)).toBe(true);

      const ingestStatus = await handleMemoryIngestStatus({
        workspace: w,
        ingest_job_id: ended.data.ingest_job_id
      });
      expect(ingestStatus.ok).toBe(true);
      if (!ingestStatus.ok) return;
      expect(ingestStatus.data.status).toBe("completed");
      expect(ingestStatus.data.accepted).toBeGreaterThanOrEqual(1);

      const recalled = await handleMemoryRecall({
        workspace: w,
        query: "How should billing retries handle replay windows?"
      });
      expect(recalled.ok).toBe(true);
      if (!recalled.ok) return;
      expect(recalled.data.answer).toMatch(/idempotency keys/i);
    });
  });

  it("workflow: session end sync_summary with empty summary reports warnings and no proposed memories", async () => {
    await withTempJustMemoryHome(async () => {
      const w = ws("session-sync-empty");
      const sessionId = "sess_e2e_sync_empty_001";

      const started = await handleMemorySessionStart({
        workspace: w,
        client: "cursor",
        session_id: sessionId
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const ended = await handleMemorySessionEnd({
        workspace: w,
        session_id: sessionId,
        summary: "   ",
        outcome: "completed",
        ingest_mode: "sync_summary",
        preview: true
      });
      expect(ended.ok).toBe(true);
      if (!ended.ok) return;
      expect(ended.data.ingest_job_id).toBeTruthy();
      expect(ended.data.proposed_memories).toEqual([]);

      const ingestStatus = await handleMemoryIngestStatus({
        workspace: w,
        ingest_job_id: ended.data.ingest_job_id
      });
      expect(ingestStatus.ok).toBe(true);
      if (!ingestStatus.ok) return;
      expect(ingestStatus.data.status).toBe("completed");
      expect(ingestStatus.data.accepted).toBe(0);
      expect(ingestStatus.data.rejected).toBeGreaterThanOrEqual(1);
      expect(ingestStatus.data.warnings.some((wmsg: string) => /no summary content/i.test(wmsg))).toBe(true);
    });
  });

  it("workflow: session end with async_full queues job and status call resumes/completes it", async () => {
    await withTempJustMemoryHome(async () => {
      const w = ws("session-async");
      const sessionId = "sess_e2e_async_001";

      const started = await handleMemorySessionStart({
        workspace: w,
        client: "cursor",
        session_id: sessionId
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const summary = "Async ingest should persist a handoff summary for later continuation.";
      const ended = await handleMemorySessionEnd({
        workspace: w,
        session_id: sessionId,
        summary,
        outcome: "handoff",
        ingest_mode: "async_full"
      });
      expect(ended.ok).toBe(true);
      if (!ended.ok) return;
      expect(ended.data.ingest_job_id).toBeTruthy();

      const status = await handleMemoryIngestStatus({
        workspace: w,
        ingest_job_id: ended.data.ingest_job_id
      });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.data.status).toBe("completed");
      expect(status.data.accepted + status.data.duplicate_count).toBeGreaterThanOrEqual(1);

      const recalled = await handleMemoryRecall({
        workspace: w,
        query: "What should async ingest persist for continuation?"
      });
      expect(recalled.ok).toBe(true);
      if (!recalled.ok) return;
      expect(recalled.data.answer).toMatch(/handoff summary/i);
    });
  });

  it("workflow: async ingest with empty summary surfaces failed status and last_error", async () => {
    await withTempJustMemoryHome(async () => {
      const w = ws("session-async-fail");
      const sessionId = "sess_e2e_async_fail_001";

      const started = await handleMemorySessionStart({
        workspace: w,
        client: "cursor",
        session_id: sessionId
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const ended = await handleMemorySessionEnd({
        workspace: w,
        session_id: sessionId,
        summary: "   ",
        outcome: "handoff",
        ingest_mode: "async_full"
      });
      expect(ended.ok).toBe(true);
      if (!ended.ok) return;
      expect(ended.data.ingest_job_id).toBeTruthy();

      const status = await handleMemoryIngestStatus({
        workspace: w,
        ingest_job_id: ended.data.ingest_job_id
      });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.data.status).toBe("failed");
      expect(status.data.last_error).toMatch(/no summary content/i);
      expect(status.data.rejected).toBeGreaterThanOrEqual(1);
    });
  });
});
