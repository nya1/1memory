import { describe, expect, it } from "vitest";
import { decodeListCursor, encodeListCursor, listMemoriesPage, rememberMemory } from "../../src/memory/memory-service.js";
import { resolveProfile } from "../../src/profiles/profile-service.js";
import { withTempOneMemoryHome } from "../helpers/test-env.js";

describe("memory list", () => {
  it("filters by label", async () => {
    await withTempOneMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: "/tmp/list-app" });
      await rememberMemory(profile, { content: "Alpha note", memory_type: "fact", labels: ["a"] });
      await rememberMemory(profile, { content: "Beta note", memory_type: "instruction", labels: ["b"] });
      await rememberMemory(profile, { content: "Gamma note", memory_type: "fact", labels: ["b"] });

      const page = await listMemoriesPage(profile.profile_id, {
        label: "b",
        limit: 10,
        offset: 0
      });
      expect(page.records).toHaveLength(2);
    });
  });

  it("paginates with cursors", async () => {
    await withTempOneMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: "/tmp/page-app" });
      for (let i = 0; i < 3; i++) {
        await rememberMemory(profile, { content: `fact body ${i}`, memory_type: "fact" });
      }

      const page1 = await listMemoriesPage(profile.profile_id, {
        memory_type: "fact",
        limit: 1,
        offset: 0
      });
      expect(page1.records).toHaveLength(1);
      expect(page1.next_cursor).toBeTruthy();

      const page2 = await listMemoriesPage(profile.profile_id, {
        memory_type: "fact",
        limit: 1,
        offset: decodeListCursor(page1.next_cursor ?? "")
      });
      expect(page2.records).toHaveLength(1);
    });
  });

  it("round-trips cursors", () => {
    const c = encodeListCursor(12);
    expect(decodeListCursor(c)).toBe(12);
  });
});
