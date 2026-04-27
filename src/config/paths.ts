import os from "node:os";
import path from "node:path";

export interface OneMemoryPaths {
  rootDir: string;
  configPath: string;
  lancedbDir: string;
  logsDir: string;
  exportsDir: string;
}

export function resolveOneMemoryPaths(): OneMemoryPaths {
  const rootDir = process.env.ONEMEMORY_HOME ?? path.join(os.homedir(), ".1memory");

  return {
    rootDir,
    configPath: path.join(rootDir, "config.json"),
    lancedbDir: path.join(rootDir, "lancedb"),
    logsDir: path.join(rootDir, "logs"),
    exportsDir: path.join(rootDir, "exports")
  };
}
