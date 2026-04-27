import * as lancedb from "@lancedb/lancedb";
import { ensureLocalDirs } from "../config/config-store.js";
import { resolveJustMemoryPaths } from "../config/paths.js";
import { runPendingMigrations } from "./migrations-runner.js";

export {
  AUDIT_EVENTS_TABLE,
  INGEST_JOBS_TABLE,
  MEMORIES_TABLE,
  PROFILES_TABLE,
  SESSIONS_TABLE,
  tableExists
} from "./lancedb-schema.js";

export interface LocalDatabase {
  db: Awaited<ReturnType<typeof lancedb.connect>>;
}

const dbCache = new Map<string, Promise<LocalDatabase>>();

export async function openLocalDatabase(): Promise<LocalDatabase> {
  const paths = resolveJustMemoryPaths();
  let p = dbCache.get(paths.lancedbDir);
  if (!p) {
    p = (async () => {
      await ensureLocalDirs(paths);
      const db = await lancedb.connect(paths.lancedbDir);
      await runPendingMigrations(db);
      return { db };
    })();
    dbCache.set(paths.lancedbDir, p);
  }
  return p;
}
