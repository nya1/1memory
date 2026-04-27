import { describe, expect, it } from "vitest";
import { getMemories, rememberMemory } from "../../src/memory/memory-service.js";
import { resolveProfile } from "../../src/profiles/profile-service.js";
import { withTempOneMemoryHome } from "../helpers/test-env.js";

describe("memory service", () => {
  it("stores and reads a memory by id", async () => {
    await withTempOneMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: "/tmp/app" });
      const memory = await rememberMemory(profile, {
        content: "Use LanceDB as the local 1memory store.",
        memory_type: "instruction",
        labels: ["backend"]
      });
      expect(memory.indexing_state).toBe("ready");

      const [loaded] = await getMemories([memory.memory_id]);

      expect(loaded.content).toBe("Use LanceDB as the local 1memory store.");
      expect(loaded.profile_id).toBe(profile.profile_id);
    });
  });

  it("does not create duplicate active memories for identical content", async () => {
    await withTempOneMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: "/tmp/app" });
      const first = await rememberMemory(profile, {
        content: "Remember exact duplicates only once.",
        memory_type: "fact"
      });
      const second = await rememberMemory(profile, {
        content: "Remember exact duplicates only once.",
        memory_type: "fact"
      });

      expect(second.memory_id).toBe(first.memory_id);
      expect(second.write_state).toBe("duplicate_ignored");
    });
  });
});
