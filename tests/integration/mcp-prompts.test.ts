import { describe, expect, it } from "vitest";
import { MEMORY_PROMPT_DEFINITIONS, MEMORY_TOOL_DEFINITIONS } from "../../src/mcp/server.js";
import { withTempJustMemoryHome } from "../helpers/test-env.js";

describe("MCP prompt registration", () => {
  it("exports startup and handoff prompt definitions", async () => {
    const promptNames = MEMORY_PROMPT_DEFINITIONS.map((p) => p.name);
    expect(promptNames).toEqual(
      expect.arrayContaining(["start_coding_session", "recall_context", "session_handoff"])
    );

    const startPromptDef = MEMORY_PROMPT_DEFINITIONS.find((p) => p.name === "start_coding_session");
    expect(startPromptDef).toBeTruthy();
    const startPrompt = await startPromptDef!.build({
      workspace: "/tmp/app",
      query: "Investigate billing retries."
    });
    expect(startPrompt.messages.length).toBeGreaterThan(0);
    expect(startPrompt.messages[0]?.role).toBe("user");
    expect(startPrompt.messages[0]?.content.text).toContain("memory_capabilities");
    expect(startPrompt.messages[0]?.content.text).toContain("memory_session_start");
    expect(startPrompt.messages[0]?.content.text).toContain('"workspace":"/tmp/app"');
  });

  it("exports memory_context and aligned tool input constraints", async () => {
    await withTempJustMemoryHome(async () => {
      const toolByName = new Map(MEMORY_TOOL_DEFINITIONS.map((t) => [t.name, t]));
      expect(toolByName.has("memory_context")).toBe(true);
      expect(toolByName.get("memory_context")?.description).toMatch(/compact/i);
      const memoryContext = toolByName.get("memory_context");
      const contextLegacyResult = memoryContext?.schema.safeParse({ workspace: "/tmp/app" });
      expect(contextLegacyResult?.success).toBe(true);
      const contextExtendedResult = memoryContext?.schema.safeParse({
        workspace: "/tmp/app",
        session_id: "sess_123",
        focus: "task",
        token_budget_mode: "small",
        token_budget: 600
      });
      expect(contextExtendedResult?.success).toBe(true);
      const contextInvalidFocusResult = memoryContext?.schema.safeParse({
        workspace: "/tmp/app",
        focus: "invalid"
      });
      expect(contextInvalidFocusResult?.success).toBe(false);
      const contextInvalidBudgetResult = memoryContext?.schema.safeParse({
        workspace: "/tmp/app",
        token_budget: 0
      });
      expect(contextInvalidBudgetResult?.success).toBe(false);

      const memoryGet = toolByName.get("memory_get");
      const getResult = memoryGet?.schema.safeParse({ memory_ids: [] });
      expect(getResult?.success).toBe(false);
      const getEmptyIdResult = memoryGet?.schema.safeParse({ memory_ids: [""] });
      expect(getEmptyIdResult?.success).toBe(false);

      const memoryList = toolByName.get("memory_list");
      const listResult = memoryList?.schema.safeParse({ limit: 101 });
      expect(listResult?.success).toBe(false);

      const recall = toolByName.get("memory_recall");
      const recallResult = recall?.schema.safeParse({ query: "", limit: 0 });
      expect(recallResult?.success).toBe(false);

      const capabilities = toolByName.get("memory_capabilities");
      const capabilitiesResult = await capabilities?.handler({ workspace: "/tmp/app" });
      const toolsEnabled =
        capabilitiesResult && "ok" in capabilitiesResult && capabilitiesResult.ok ? capabilitiesResult.data.tools_enabled : [];
      expect(toolsEnabled).toContain("memory_context");

      const remember = toolByName.get("memory_remember");
      const rememberExtendedResult = remember?.schema.safeParse({
        content: "Keep migration docs in sync with release cut.",
        memory_type: "instruction",
        topic_key: "release.migration-docs",
        source: { actor: "agent", file_paths: ["docs/release.md"] }
      });
      expect(rememberExtendedResult?.success).toBe(true);

      const sessionStart = toolByName.get("memory_session_start");
      const sessionStartParsed = sessionStart?.schema.safeParse({});
      expect(sessionStartParsed?.success).toBe(true);
      if (sessionStartParsed?.success) {
        expect(sessionStartParsed.data.client).toBe("unknown_client");
      }

      const sessionEnd = toolByName.get("memory_session_end");
      const sessionEndParsed = sessionEnd?.schema.safeParse({ session_id: "sess_abc123" });
      expect(sessionEndParsed?.success).toBe(true);
      if (sessionEndParsed?.success) {
        expect(sessionEndParsed.data.ingest_mode).toBe("none");
      }
    });
  });

  it("keeps prompt schemas aligned with tool constraints and required fields", async () => {
    const promptByName = new Map(MEMORY_PROMPT_DEFINITIONS.map((p) => [p.name, p]));

    const recallPrompt = promptByName.get("recall_context");
    const recallLimitLow = recallPrompt?.schema.safeParse({ query: "billing", limit: 0 });
    const recallLimitHigh = recallPrompt?.schema.safeParse({ query: "billing", limit: 51 });
    expect(recallLimitLow?.success).toBe(false);
    expect(recallLimitHigh?.success).toBe(false);

    const handoffPrompt = promptByName.get("session_handoff");
    const missingSessionId = handoffPrompt?.schema.safeParse({ summary: "No session id." });
    expect(missingSessionId?.success).toBe(false);

    const handoffPromptBuilt = await handoffPrompt!.build({
      session_id: "sess_123",
      summary: "Finished implementation and tests."
    });
    expect(handoffPromptBuilt.messages[0]?.content.text).toContain("memory_session_end");
    expect(handoffPromptBuilt.messages[0]?.content.text).toContain('"session_id":"sess_123"');
  });
});
