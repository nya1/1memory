import fs from "node:fs/promises";
import path from "node:path";

export type InstallClient = "cursor" | "claude-code" | "claude-desktop" | "generic";
export type InstallScope = "workspace" | "user";

export interface InstallOptions {
  client: InstallClient;
  scope: InstallScope;
  workspaceDir: string;
  dryRun: boolean;
}

export interface InstallArtifact {
  path: string;
  content: string;
  description: string;
  mergeJson?: boolean;
  executable?: boolean;
}

export interface InstallPlan {
  client: InstallClient;
  scope: InstallScope;
  artifacts: InstallArtifact[];
  notes: string[];
}

export interface InstallResult {
  client: InstallClient;
  scope: InstallScope;
  dry_run: boolean;
  wrote_files: string[];
  planned_files: string[];
  notes: string[];
}

function mcpConfigContent(): string {
  return JSON.stringify(
    {
      mcpServers: {
        justmemory: {
          command: "npx",
          args: ["-y", "justmemory", "mcp"]
        }
      }
    },
    null,
    2
  );
}

function cursorRuleContent(): string {
  return [
    "---",
    "description: JustMemory startup and persistence guidance",
    "alwaysApply: true",
    "---",
    "",
    "- At the start of a coding task, call `memory_recall` with the active workspace and user request.",
    "- When the user makes a durable decision or correction, call `memory_remember`.",
    "- At handoff or end-of-task, use `memory_session_end` with a concise summary."
  ].join("\n");
}

function claudeHookConfigContent(): string {
  return JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: ".claude/hooks/session-start.sh"
              }
            ]
          }
        ],
        SessionEnd: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: ".claude/hooks/session-end.sh"
              }
            ]
          }
        ]
      }
    },
    null,
    2
  );
}

function claudeSessionStartHookContent(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "WORKSPACE=\"${CLAUDE_PROJECT_DIR:-$PWD}\"",
    "SESSION_ID=\"${CLAUDE_SESSION_ID:-sess_$(date +%s)}\"",
    "CLIENT=\"claude-code\"",
    "",
    "cat <<EOF",
    "JustMemory startup workflow:",
    "1) Call memory_session_start with:",
    "   - session_id: ${SESSION_ID}",
    "   - client: ${CLIENT}",
    "   - workspace: ${WORKSPACE}",
    "2) Then call memory_recall with:",
    "   - query: \\\"Summarize relevant prior context for this workspace.\\\"",
    "   - session_id: ${SESSION_ID}",
    "   - client: ${CLIENT}",
    "   - workspace: ${WORKSPACE}",
    "EOF"
  ].join("\n");
}

function claudeSessionEndHookContent(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "WORKSPACE=\"${CLAUDE_PROJECT_DIR:-$PWD}\"",
    "SESSION_ID=\"${CLAUDE_SESSION_ID:-sess_$(date +%s)}\"",
    "",
    "cat <<EOF",
    "JustMemory handoff workflow:",
    "1) Draft a concise handoff summary of outcomes and open tasks.",
    "2) Call memory_session_end with:",
    "   - session_id: ${SESSION_ID}",
    "   - workspace: ${WORKSPACE}",
    "   - outcome: handoff",
    "   - ingest_mode: sync_summary",
    "   - summary: <your concise handoff summary>",
    "3) You may also run prompt session_handoff for guided tool sequencing.",
    "EOF"
  ].join("\n");
}

async function writeMergedJson(pathname: string, content: string): Promise<void> {
  const incoming = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
  let merged = incoming;

  const existingRaw = await fs.readFile(pathname, "utf8").catch(() => null);
  if (existingRaw) {
    let existingParsed: { mcpServers?: Record<string, unknown> };
    try {
      existingParsed = JSON.parse(existingRaw) as { mcpServers?: Record<string, unknown> };
    } catch {
      throw new Error(`Existing config at ${pathname} contains invalid JSON. Fix or remove it and retry install.`);
    }
    merged = {
      ...existingParsed,
      ...incoming,
      mcpServers: {
        ...(existingParsed.mcpServers ?? {}),
        ...(incoming.mcpServers ?? {})
      }
    };
  }

  await fs.writeFile(pathname, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

export function buildInstallPlan(options: Omit<InstallOptions, "dryRun">): InstallPlan {
  const { client, scope, workspaceDir } = options;
  const notes: string[] = [];
  const artifacts: InstallArtifact[] = [];

  if (scope === "user") {
    notes.push("User-scope installation is not implemented yet; using workspace-scoped artifacts.");
  }

  if (client === "cursor") {
    artifacts.push({
      path: path.join(workspaceDir, ".cursor", "mcp.json"),
      content: mcpConfigContent(),
      description: "Cursor MCP server configuration",
      mergeJson: true
    });
    artifacts.push({
      path: path.join(workspaceDir, ".cursor", "rules", "justmemory.mdc"),
      content: cursorRuleContent(),
      description: "Cursor always-on JustMemory usage rule"
    });
    return { client, scope, artifacts, notes };
  }

  if (client === "claude-code") {
    artifacts.push({
      path: path.join(workspaceDir, ".claude", "mcp.json"),
      content: mcpConfigContent(),
      description: "Claude Code MCP server configuration",
      mergeJson: true
    });
    artifacts.push({
      path: path.join(workspaceDir, ".claude", "hooks.json"),
      content: claudeHookConfigContent(),
      description: "Claude Code hook registration"
    });
    artifacts.push({
      path: path.join(workspaceDir, ".claude", "hooks", "session-start.sh"),
      content: claudeSessionStartHookContent(),
      description: "Claude Code session start hook scaffold",
      executable: true
    });
    artifacts.push({
      path: path.join(workspaceDir, ".claude", "hooks", "session-end.sh"),
      content: claudeSessionEndHookContent(),
      description: "Claude Code session end hook scaffold",
      executable: true
    });
    notes.push("Claude Code hooks emit startup/handoff guidance that instructs tool usage for session continuity.");
    return { client, scope, artifacts, notes };
  }

  if (client === "claude-desktop") {
    artifacts.push({
      path: path.join(workspaceDir, "justmemory.claude-desktop.mcp.json"),
      content: mcpConfigContent(),
      description: "Claude Desktop MCP config snippet (copy into desktop config)"
    });
    notes.push("Generated a copy-paste snippet because desktop config lives outside the workspace.");
    return { client, scope, artifacts, notes };
  }

  artifacts.push({
    path: path.join(workspaceDir, "justmemory.mcp.json"),
    content: mcpConfigContent(),
    description: "Generic MCP config snippet for JustMemory",
    mergeJson: true
  });
  return { client, scope, artifacts, notes };
}

export async function applyInstallPlan(plan: InstallPlan, dryRun: boolean): Promise<InstallResult> {
  const wroteFiles: string[] = [];

  if (!dryRun) {
    for (const artifact of plan.artifacts) {
      await fs.mkdir(path.dirname(artifact.path), { recursive: true });
      if (artifact.mergeJson) {
        await writeMergedJson(artifact.path, artifact.content);
      } else {
        await fs.writeFile(artifact.path, artifact.content, "utf8");
      }
      if (artifact.executable) {
        await fs.chmod(artifact.path, 0o755);
      }
      wroteFiles.push(artifact.path);
    }
  }

  return {
    client: plan.client,
    scope: plan.scope,
    dry_run: dryRun,
    wrote_files: wroteFiles,
    planned_files: plan.artifacts.map((artifact) => artifact.path),
    notes: plan.notes
  };
}
