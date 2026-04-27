import { describe, expect, it, vi } from "vitest";
import { countAuditEvents } from "../../src/audit/audit-service.js";
import {
  handleMemoryCapabilities,
  handleMemoryContext,
  handleMemoryGet,
  handleMemoryHealth,
  handleMemoryList,
  handleMemoryRecall,
  handleMemoryRemember
} from "../../src/mcp/tools.js";
import { openLocalDatabase, SESSIONS_TABLE } from "../../src/storage/lancedb.js";
import { withTempOneMemoryHome } from "../helpers/test-env.js";

describe("MCP tool handlers", () => {
  it("runs the first local memory loop", async () => {
    await withTempOneMemoryHome(async () => {
      const capabilities = await handleMemoryCapabilities({ workspace: "/tmp/app" });
      expect(capabilities.ok).toBe(true);

      const health = await handleMemoryHealth({ workspace: "/tmp/app" });
      expect(health.ok).toBe(true);

      const remembered = await handleMemoryRemember({
        workspace: "/tmp/app",
        content: "1memory uses hybrid lexical and vector recall when ONNX embeddings are available.",
        memory_type: "fact",
        labels: ["alpha", "recall"]
      });
      expect(remembered.ok).toBe(true);
      if (!remembered.ok) return;
      expect(remembered.data.indexing_state).toBe("ready");

      const memoryId = remembered.data.memory_id;
      const loaded = await handleMemoryGet({ memory_ids: [memoryId] });
      expect(loaded.ok).toBe(true);

      const recalled = await handleMemoryRecall({
        workspace: "/tmp/app",
        query: "How does alpha recall work?"
      });
      expect(recalled.ok).toBe(true);
      if (!recalled.ok) return;
      expect(recalled.data.candidate_ids).toContain(memoryId);
      expect(recalled.data.retrieval_channels_used).toEqual(
        expect.arrayContaining(["lexical", "metadata", "vector"])
      );

      const listed = await handleMemoryList({ workspace: "/tmp/app", limit: 5 });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.data.records.some((r: { memory_id: string }) => r.memory_id === memoryId)).toBe(true);

      const audits = await countAuditEvents();
      expect(audits).toBeGreaterThanOrEqual(3);
    });
  });

  it("loads memories from LanceDB after module reload (restart simulation)", async () => {
    await withTempOneMemoryHome(async () => {
      const remembered = await handleMemoryRemember({
        workspace: "/tmp/persist-app",
        content: "Persistent local memory for 1memory.",
        memory_type: "fact",
        labels: ["persist"]
      });
      expect(remembered.ok).toBe(true);
      if (!remembered.ok) return;
      const memoryId = remembered.data.memory_id;

      vi.resetModules();

      const { handleMemoryGet: getAgain } = await import("../../src/mcp/tools.js");
      const loaded = await getAgain({ memory_ids: [memoryId] });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.data.records[0].content).toBe("Persistent local memory for 1memory.");
    });
  });

  it("returns compact memory context for the resolved workspace profile", async () => {
    await withTempOneMemoryHome(async () => {
      const workspace = "/tmp/context-profile";
      const remembered = await handleMemoryRemember({
        workspace,
        content: "Use deterministic ids for replay-safe billing operations.",
        memory_type: "instruction",
        labels: ["billing"]
      });
      expect(remembered.ok).toBe(true);

      const context = await handleMemoryContext({ workspace });
      expect(context.ok).toBe(true);
      if (!context.ok) return;

      expect(context.data.resolved_profile.profile_id).toBeTruthy();
      expect(context.data.scope.workspace).toBe(workspace);
      expect(context.data.context_block).toMatch(/Relevant 1memory context/i);
      expect(context.data.context_block).toMatch(/deterministic ids/i);
      expect(context.data.citations).toEqual([]);
      expect(context.data.warnings).toEqual([]);
    });
  });

  it("supports memory_context optional contract fields without creating a session side effect", async () => {
    await withTempOneMemoryHome(async () => {
      const workspace = "/tmp/context-no-session";
      const context = await handleMemoryContext({
        workspace,
        session_id: "sess_contract_probe",
        focus: "review",
        token_budget_mode: "small",
        token_budget: 700,
        repo: "github.com/acme/app",
        branch: "main"
      });
      expect(context.ok).toBe(true);
      if (!context.ok) return;
      expect(context.data.context_block).toBeTruthy();
      expect(context.data.citations).toEqual([]);
      expect(context.data.warnings).toEqual([]);

      const { db } = await openLocalDatabase();
      const sessions = await db.openTable(SESSIONS_TABLE);
      const rows = (await sessions.query().toArray()) as unknown[];
      expect(rows).toHaveLength(0);
      expect(await countAuditEvents()).toBe(1);
    });
  });

  it("emits shaping warnings only when memory lines exist and narrowing occurs", async () => {
    await withTempOneMemoryHome(async () => {
      const emptyContext = await handleMemoryContext({
        workspace: "/tmp/context-empty-shape",
        focus: "task",
        token_budget_mode: "small"
      });
      expect(emptyContext.ok).toBe(true);
      if (!emptyContext.ok) return;
      expect(emptyContext.data.warnings).toEqual([]);

      await handleMemoryRemember({
        workspace: "/tmp/context-empty-shape",
        content: "Task queue includes action item to implement retry logic.",
        memory_type: "task"
      });
      await handleMemoryRemember({
        workspace: "/tmp/context-empty-shape",
        content: "Review found regression risk in pagination behavior.",
        memory_type: "event"
      });

      const shapedContext = await handleMemoryContext({
        workspace: "/tmp/context-empty-shape",
        focus: "review",
        token_budget: 200
      });
      expect(shapedContext.ok).toBe(true);
      if (!shapedContext.ok) return;
      expect(shapedContext.data.warnings.length).toBeGreaterThan(0);
      expect(
        shapedContext.data.warnings.some((warning: string) => /shaping|narrowed|token budget/i.test(warning))
      ).toBe(true);
    });
  });

  it("validates required memory_remember fields at the handler boundary", async () => {
    await withTempOneMemoryHome(async () => {
      const missingContent = await handleMemoryRemember({
        workspace: "/tmp/remember-validation",
        memory_type: "fact"
      });
      expect(missingContent.ok).toBe(false);

      const missingType = await handleMemoryRemember({
        workspace: "/tmp/remember-validation",
        content: "Required fields should fail fast at the handler."
      });
      expect(missingType.ok).toBe(false);
    });
  });

  it("rejects empty memory IDs in memory_get", async () => {
    await withTempOneMemoryHome(async () => {
      const loaded = await handleMemoryGet({ memory_ids: [""] });
      expect(loaded.ok).toBe(false);
    });
  });

  it("uses branch in implicit session scoping to avoid collisions", async () => {
    await withTempOneMemoryHome(async () => {
      const workspace = "/tmp/implicit-session-branch";
      const repo = "github.com/acme/repo";

      const mainRemembered = await handleMemoryRemember({
        workspace,
        repo,
        branch: "main",
        content: "Main branch instruction",
        memory_type: "instruction"
      });
      expect(mainRemembered.ok).toBe(true);
      if (!mainRemembered.ok) return;

      const releaseRemembered = await handleMemoryRemember({
        workspace,
        repo,
        branch: "release/1.0",
        content: "Release branch instruction",
        memory_type: "instruction"
      });
      expect(releaseRemembered.ok).toBe(true);
      if (!releaseRemembered.ok) return;

      const loaded = await handleMemoryGet({
        memory_ids: [mainRemembered.data.memory_id, releaseRemembered.data.memory_id]
      });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.data.records[0].source_session).toBeTruthy();
      expect(loaded.data.records[1].source_session).toBeTruthy();
      expect(loaded.data.records[0].source_session).not.toBe(loaded.data.records[1].source_session);
    });
  });
});
