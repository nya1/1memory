import os from "node:os";
import path from "node:path";

export interface JustMemoryPaths {
  rootDir: string;
  configPath: string;
  lancedbDir: string;
  logsDir: string;
  exportsDir: string;
}

export function resolveJustMemoryPaths(): JustMemoryPaths {
  const rootDir = process.env.JUSTMEMORY_HOME ?? path.join(os.homedir(), ".justmemory");

  return {
    rootDir,
    configPath: path.join(rootDir, "config.json"),
    lancedbDir: path.join(rootDir, "lancedb"),
    logsDir: path.join(rootDir, "logs"),
    exportsDir: path.join(rootDir, "exports")
  };
}
