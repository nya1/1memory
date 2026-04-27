import { describe, expect, it } from "vitest";
import { rememberMemory } from "../../src/memory/memory-service.js";
import { resolveProfile } from "../../src/profiles/profile-service.js";
import { recallMemory } from "../../src/recall/recall-service.js";
import { withTempJustMemoryHome } from "../helpers/test-env.js";

describe("recall service", () => {
  it("recalls active memories with citations (lexical + real vector channel)", async () => {
    await withTempJustMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: "/tmp/app" });
      const memory = await rememberMemory(profile, {
        content: "Use MCP stdio for local JustMemory clients.",
        memory_type: "instruction",
        labels: ["mcp", "stdio"]
      });
      expect(memory.indexing_state).toBe("ready");

      const result = await recallMemory(profile, "How should local MCP clients connect?");

      expect(result.candidate_ids).toContain(memory.memory_id);
      expect(result.context_block).toContain(memory.memory_id);
      expect(result.retrieval_channels_used).toEqual(expect.arrayContaining(["lexical", "metadata", "vector"]));
      expect(result.why_retrieved.length).toBeGreaterThan(0);
    });
  });
});
