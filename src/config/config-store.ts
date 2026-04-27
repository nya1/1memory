import fs from "node:fs/promises";
import { OneMemoryPaths } from "./paths.js";

export interface LocalConfig {
  default_profile_id?: string;
  selected_profiles: Record<string, string>;
  /** Last LanceDB migration id successfully applied (e.g. `001_initial_core_tables`). */
  last_applied_migration_id?: string;
  /** Matches `SCHEMA_VERSION` in envelopes after the store has migrated successfully. */
  store_schema_version?: string;
  /** Set after a successful local ONNX embedding load (optional metadata). */
  embedding_model_id?: string;
  embedding_dimension?: number;
  embedding_quantization?: string;
  embedding_model_checksum_sha256?: string;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

export async function ensureLocalDirs(paths: OneMemoryPaths): Promise<void> {
  await fs.mkdir(paths.rootDir, { recursive: true });
  await fs.mkdir(paths.lancedbDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.exportsDir, { recursive: true });
}

export async function readConfig(paths: OneMemoryPaths): Promise<LocalConfig> {
  await ensureLocalDirs(paths);

  try {
    const raw = await fs.readFile(paths.configPath, "utf8");
    return JSON.parse(raw) as LocalConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    const created = now();
    const config: LocalConfig = {
      selected_profiles: {},
      created_at: created,
      updated_at: created
    };
    await writeConfig(paths, config);
    return config;
  }
}

export async function writeConfig(paths: OneMemoryPaths, config: LocalConfig): Promise<void> {
  await ensureLocalDirs(paths);
  const next = { ...config, updated_at: now() };
  await fs.writeFile(paths.configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function workspaceKey(workspace?: string, repo?: string): string {
  return repo ?? workspace ?? "default";
}
