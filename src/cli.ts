#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { runExploreTui } from "./cli/explore.js";
import { applyInstallPlan, buildInstallPlan, InstallClient, InstallScope } from "./install/install-service.js";
import { runMcpServer } from "./mcp/server.js";

function parseClient(value: string | undefined): InstallClient {
  if (value === "cursor" || value === "claude-code" || value === "claude-desktop" || value === "generic") {
    return value;
  }
  throw new Error("Unsupported client. Use one of: cursor, claude-code, claude-desktop, generic.");
}

function parseScope(args: string[]): InstallScope {
  const scopeArg = args.find((arg) => arg.startsWith("--scope="));
  if (!scopeArg) return "workspace";
  const value = scopeArg.split("=", 2)[1];
  if (value === "workspace" || value === "user") return value;
  throw new Error("Unsupported scope. Use --scope=workspace or --scope=user.");
}

function parseFlagValue(args: string[], prefix: string): string | undefined {
  const hit = args.find((arg) => arg.startsWith(prefix));
  if (!hit) return undefined;
  const parts = hit.split("=", 2);
  return parts.length > 1 ? parts[1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const subcommand = process.argv[3];
  const target = process.argv[4];
  const flags = process.argv.slice(5);

  if (command === "explore") {
    const rest = process.argv.slice(3);
    const profileId = parseFlagValue(rest, "--profile=");
    const workspaceArg = parseFlagValue(rest, "--workspace=");
    const workspaceDir = workspaceArg ? path.resolve(workspaceArg) : process.cwd();
    await runExploreTui({ workspaceDir, profileId });
    return;
  }

  if (command === "mcp") {
    if (subcommand === "install") {
      const client = parseClient(target);
      const dryRun = flags.includes("--dry-run");
      const scope = parseScope(flags);
      const plan = buildInstallPlan({
        client,
        scope,
        workspaceDir: process.cwd()
      });
      const result = await applyInstallPlan(plan, dryRun);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (subcommand) {
      throw new Error("Usage: 1memory mcp | 1memory mcp install <client> [--dry-run] [--scope=workspace|user]");
    }

    await runMcpServer();
    return;
  }

  console.error(
    "Usage: 1memory explore [--profile=<id>] [--workspace=<dir>] | 1memory mcp | 1memory mcp install <client> [--dry-run] [--scope=workspace|user]"
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
