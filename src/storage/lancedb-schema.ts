import * as lancedb from "@lancedb/lancedb";

export type LanceDbConnection = Awaited<ReturnType<typeof lancedb.connect>>;

export const PROFILES_TABLE = "profiles";
export const MEMORIES_TABLE = "memories";
export const AUDIT_EVENTS_TABLE = "audit_events";
export const SESSIONS_TABLE = "sessions";
export const INGEST_JOBS_TABLE = "ingest_jobs";
export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";

export async function tableExists(db: LanceDbConnection, name: string): Promise<boolean> {
  const names = await db.tableNames();
  return names.includes(name);
}
