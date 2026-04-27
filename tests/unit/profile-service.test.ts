import { describe, expect, it } from "vitest";
import { listProfiles, resolveProfile } from "../../src/profiles/profile-service.js";
import { withTempJustMemoryHome } from "../helpers/test-env.js";

describe("profile service", () => {
  it("creates a default profile", async () => {
    await withTempJustMemoryHome(async () => {
      const profiles = await listProfiles();
      expect(profiles.length).toBeGreaterThan(0);
      expect(profiles[0].profile_id).toMatch(/^prof_/);
    });
  });

  it("creates a workspace profile when workspace metadata is supplied", async () => {
    await withTempJustMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: "/tmp/acme-api" });
      expect(profile.name).toBe("acme-api");
      expect(profile.workspace_paths).toContain("/tmp/acme-api");
    });
  });
});
