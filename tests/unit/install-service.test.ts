import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyInstallPlan, buildInstallPlan } from "../../src/install/install-service.js";

async function withTempWorkspace<T>(fn: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "1memory-install-"));
  try {
    return await fn(workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

describe("install service", () => {
  it("builds cursor install plan with MCP config and rules", async () => {
    await withTempWorkspace(async (workspace) => {
      const plan = buildInstallPlan({
        client: "cursor",
        scope: "workspace",
        workspaceDir: workspace
      });
      expect(plan.artifacts).toHaveLength(2);
      expect(plan.artifacts.map((a) => a.path)).toEqual(
        expect.arrayContaining([
          path.join(workspace, ".cursor", "mcp.json"),
          path.join(workspace, ".cursor", "rules", "1memory.mdc")
        ])
      );
    });
  });

  it("dry-run does not write files", async () => {
    await withTempWorkspace(async (workspace) => {
      const plan = buildInstallPlan({
        client: "generic",
        scope: "workspace",
        workspaceDir: workspace
      });
      const result = await applyInstallPlan(plan, true);
      expect(result.dry_run).toBe(true);
      expect(result.wrote_files).toEqual([]);
      const stat = await fs.stat(path.join(workspace, "1memory.mcp.json")).catch(() => null);
      expect(stat).toBeNull();
    });
  });

  it("writes planned files when dry-run is false", async () => {
    await withTempWorkspace(async (workspace) => {
      const plan = buildInstallPlan({
        client: "claude-code",
        scope: "workspace",
        workspaceDir: workspace
      });
      const result = await applyInstallPlan(plan, false);
      expect(result.wrote_files.length).toBeGreaterThanOrEqual(1);
      expect(result.wrote_files).toContain(path.join(workspace, ".claude", "mcp.json"));
      const written = await fs.readFile(path.join(workspace, ".claude", "mcp.json"), "utf8");
      expect(written).toContain("\"1memory\"");
      expect(written).toContain("\"mcp\"");
    });
  });

  it("merges existing cursor mcp config instead of overwriting other servers", async () => {
    await withTempWorkspace(async (workspace) => {
      const cursorDir = path.join(workspace, ".cursor");
      await fs.mkdir(cursorDir, { recursive: true });
      await fs.writeFile(
        path.join(cursorDir, "mcp.json"),
        JSON.stringify(
          {
            mcpServers: {
              existing: {
                command: "node",
                args: ["existing.js"]
              }
            }
          },
          null,
          2
        ),
        "utf8"
      );

      const plan = buildInstallPlan({
        client: "cursor",
        scope: "workspace",
        workspaceDir: workspace
      });
      await applyInstallPlan(plan, false);
      const merged = JSON.parse(await fs.readFile(path.join(cursorDir, "mcp.json"), "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(merged.mcpServers?.existing).toBeTruthy();
      expect(merged.mcpServers?.["1memory"]).toBeTruthy();
    });
  });

  it("includes claude-code hook scaffolding artifacts", async () => {
    await withTempWorkspace(async (workspace) => {
      const plan = buildInstallPlan({
        client: "claude-code",
        scope: "workspace",
        workspaceDir: workspace
      });
      expect(plan.artifacts.map((a) => a.path)).toEqual(
        expect.arrayContaining([
          path.join(workspace, ".claude", "mcp.json"),
          path.join(workspace, ".claude", "hooks", "session-start.sh"),
          path.join(workspace, ".claude", "hooks", "session-end.sh"),
          path.join(workspace, ".claude", "hooks.json")
        ])
      );
    });
  });

  it("writes claude hook scripts with session start/end memory workflow hints", async () => {
    await withTempWorkspace(async (workspace) => {
      const plan = buildInstallPlan({
        client: "claude-code",
        scope: "workspace",
        workspaceDir: workspace
      });
      await applyInstallPlan(plan, false);

      const startScript = await fs.readFile(path.join(workspace, ".claude", "hooks", "session-start.sh"), "utf8");
      const endScript = await fs.readFile(path.join(workspace, ".claude", "hooks", "session-end.sh"), "utf8");
      expect(startScript).toContain("memory_session_start");
      expect(startScript).toContain("memory_recall");
      expect(endScript).toContain("memory_session_end");
      expect(endScript).toContain("session_handoff");
    });
  });

  it("writes executable claude hook scripts", async () => {
    await withTempWorkspace(async (workspace) => {
      const plan = buildInstallPlan({
        client: "claude-code",
        scope: "workspace",
        workspaceDir: workspace
      });
      await applyInstallPlan(plan, false);

      const startStat = await fs.stat(path.join(workspace, ".claude", "hooks", "session-start.sh"));
      const endStat = await fs.stat(path.join(workspace, ".claude", "hooks", "session-end.sh"));
      expect(startStat.mode & 0o111).toBeGreaterThan(0);
      expect(endStat.mode & 0o111).toBeGreaterThan(0);
    });
  });

  it("writes matcher-based claude hooks config format", async () => {
    await withTempWorkspace(async (workspace) => {
      const plan = buildInstallPlan({
        client: "claude-code",
        scope: "workspace",
        workspaceDir: workspace
      });
      await applyInstallPlan(plan, false);

      const hooksJson = JSON.parse(await fs.readFile(path.join(workspace, ".claude", "hooks.json"), "utf8")) as {
        hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>>;
      };
      const start = hooksJson.hooks?.SessionStart?.[0];
      const end = hooksJson.hooks?.SessionEnd?.[0];
      expect(start?.matcher).toBe("*");
      expect(start?.hooks?.[0]?.type).toBe("command");
      expect(start?.hooks?.[0]?.command).toContain("session-start.sh");
      expect(end?.matcher).toBe("*");
      expect(end?.hooks?.[0]?.type).toBe("command");
      expect(end?.hooks?.[0]?.command).toContain("session-end.sh");
    });
  });

  it("fails fast with clear error when existing MCP json is invalid", async () => {
    await withTempWorkspace(async (workspace) => {
      const cursorDir = path.join(workspace, ".cursor");
      await fs.mkdir(cursorDir, { recursive: true });
      await fs.writeFile(path.join(cursorDir, "mcp.json"), "{ invalid json", "utf8");

      const plan = buildInstallPlan({
        client: "cursor",
        scope: "workspace",
        workspaceDir: workspace
      });

      await expect(applyInstallPlan(plan, false)).rejects.toThrow(/invalid JSON/i);
      await expect(applyInstallPlan(plan, false)).rejects.toThrow(/\.cursor\/mcp\.json/);
    });
  });
});
