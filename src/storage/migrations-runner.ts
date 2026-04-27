import { readConfig, writeConfig } from "../config/config-store.js";
import { resolveJustMemoryPaths } from "../config/paths.js";
import { JustMemoryError } from "../core/errors.js";
import { SCHEMA_VERSION } from "../core/types.js";
import { EMBEDDING_MODEL_DIM } from "../embeddings/constants.js";
import {
  AUDIT_EVENTS_TABLE,
  INGEST_JOBS_TABLE,
  LanceDbConnection,
  MEMORIES_TABLE,
  PROFILES_TABLE,
  SCHEMA_MIGRATIONS_TABLE,
  SESSIONS_TABLE,
  tableExists
} from "./lancedb-schema.js";

export interface Migration {
  readonly id: string;
  readonly description: string;
  run(db: LanceDbConnection): Promise<void>;
}

let migrationFailure: JustMemoryError | null = null;

export function getMigrationFailure(): JustMemoryError | null {
  return migrationFailure;
}

export function assertStoreWritesAllowed(): void {
  if (migrationFailure) {
    throw migrationFailure;
  }
}

function placeholderRegistryRow() {
  return {
    migration_id: "__jm_init_migration__",
    applied_at: new Date().toISOString()
  };
}

async function ensureMigrationsRegistryTable(db: LanceDbConnection): Promise<void> {
  if (await tableExists(db, SCHEMA_MIGRATIONS_TABLE)) return;
  await db.createTable(SCHEMA_MIGRATIONS_TABLE, [placeholderRegistryRow()]);
  const t = await db.openTable(SCHEMA_MIGRATIONS_TABLE);
  await t.delete("migration_id = '__jm_init_migration__'");
}

async function isMigrationApplied(db: LanceDbConnection, id: string): Promise<boolean> {
  const table = await db.openTable(SCHEMA_MIGRATIONS_TABLE);
  const rows = (await table.query().toArray()) as Array<{ migration_id?: unknown }>;
  return rows.some((r) => String(r.migration_id ?? "") === id);
}

async function recordMigrationApplied(db: LanceDbConnection, id: string): Promise<void> {
  const table = await db.openTable(SCHEMA_MIGRATIONS_TABLE);
  await table.add([
    {
      migration_id: id,
      applied_at: new Date().toISOString()
    }
  ]);
}

function placeholderProfileRow() {
  const ts = new Date().toISOString();
  return {
    profile_id: "__jm_init_profile__",
    name: "__init__",
    scope_path: "__init__",
    workspace_paths_json: "[]",
    repo_urls_json: "[]",
    default_namespace: "default",
    read_policy: "local",
    write_policy: "local",
    retention_policy: "default",
    created_at: ts,
    updated_at: ts,
    last_activity_at: ts
  };
}

function placeholderMemoryRow() {
  const ts = new Date().toISOString();
  return {
    memory_id: "__jm_init_memory__",
    profile_id: "__jm_init_memory_profile__",
    namespace: "default",
    memory_type: "fact",
    status: "inactive",
    content: "",
    content_hash: "",
    topic_key: "",
    labels_json: "[]",
    importance: 0,
    confidence: 0,
    indexing_state: "not_indexed",
    write_state: "accepted",
    source_actor: "",
    source_client: "",
    source_session: "",
    source_repo: "",
    source_branch: "",
    file_paths_json: "[]",
    redaction_state: "none",
    created_at: ts,
    updated_at: ts
  };
}

function placeholderAuditRow() {
  const ts = new Date().toISOString();
  return {
    event_id: "__jm_init_audit__",
    request_id: "__jm_init_audit_req__",
    action: "__init__",
    profile_id: "",
    memory_id: "",
    details_json: "{}",
    created_at: ts
  };
}

function placeholderSessionRow() {
  const ts = new Date().toISOString();
  return {
    session_id: "__jm_init_session__",
    profile_id: "__jm_init_profile__",
    client: "init",
    workspace: "",
    repo: "",
    branch: "",
    status: "completed",
    started_at: ts,
    ended_at: ts,
    summary: "",
    handoff_summary: "",
    metadata_json: "{}"
  };
}

function placeholderIngestJobRow() {
  const ts = new Date().toISOString();
  return {
    ingest_job_id: "__jm_init_ingest__",
    profile_id: "__jm_init_profile__",
    session_id: "__jm_init_session__",
    ingest_mode: "sync_summary",
    summary: "",
    last_error: "",
    status: "completed",
    accepted: 0,
    rejected: 0,
    extracted_count: 0,
    active_count: 0,
    quarantined_count: 0,
    duplicate_count: 0,
    superseded_count: 0,
    warnings_json: "[]",
    created_at: ts,
    updated_at: ts
  };
}

const migration002: Migration = {
  id: "002_add_memory_content_embedding",
  description: "Add 384-d content_embedding column for local ONNX vector recall.",
  async run(db) {
    const table = await db.openTable(MEMORIES_TABLE);
    const schema = await table.schema();
    if (schema.fields.some((f) => f.name === "content_embedding")) {
      return;
    }
    const zeros = Array(EMBEDDING_MODEL_DIM).fill(0).join(", ");
    await table.addColumns([
      {
        name: "content_embedding",
        valueSql: `arrow_cast([${zeros}], 'FixedSizeList(384, Float32)')`
      }
    ]);
  }
};

const migration001: Migration = {
  id: "001_initial_core_tables",
  description: "Create core LanceDB tables if missing (profiles, memories, audit_events).",
  async run(db) {
    if (!(await tableExists(db, PROFILES_TABLE))) {
      await db.createTable(PROFILES_TABLE, [placeholderProfileRow()]);
      const t = await db.openTable(PROFILES_TABLE);
      await t.delete("profile_id = '__jm_init_profile__'");
    }
    if (!(await tableExists(db, MEMORIES_TABLE))) {
      await db.createTable(MEMORIES_TABLE, [placeholderMemoryRow()]);
      const t = await db.openTable(MEMORIES_TABLE);
      await t.delete("memory_id = '__jm_init_memory__'");
    }
    if (!(await tableExists(db, AUDIT_EVENTS_TABLE))) {
      await db.createTable(AUDIT_EVENTS_TABLE, [placeholderAuditRow()]);
      const t = await db.openTable(AUDIT_EVENTS_TABLE);
      await t.delete("event_id = '__jm_init_audit__'");
    }
  }
};

const migration003: Migration = {
  id: "003_add_sessions_table",
  description: "Create sessions table for session start/end lifecycle records.",
  async run(db) {
    if (!(await tableExists(db, SESSIONS_TABLE))) {
      await db.createTable(SESSIONS_TABLE, [placeholderSessionRow()]);
      const t = await db.openTable(SESSIONS_TABLE);
      await t.delete("session_id = '__jm_init_session__'");
    }
  }
};

const migration004: Migration = {
  id: "004_add_ingest_jobs_table",
  description: "Create ingest_jobs table for sync/async ingestion status tracking.",
  async run(db) {
    if (!(await tableExists(db, INGEST_JOBS_TABLE))) {
      await db.createTable(INGEST_JOBS_TABLE, [placeholderIngestJobRow()]);
      const t = await db.openTable(INGEST_JOBS_TABLE);
      await t.delete("ingest_job_id = '__jm_init_ingest__'");
    }
  }
};

const migration005: Migration = {
  id: "005_add_ingest_job_mode_and_summary",
  description: "Add ingest_mode and summary columns to ingest_jobs.",
  async run(db) {
    const table = await db.openTable(INGEST_JOBS_TABLE);
    const schema = await table.schema();
    const hasMode = schema.fields.some((f) => f.name === "ingest_mode");
    const hasSummary = schema.fields.some((f) => f.name === "summary");
    const cols: Array<{ name: string; valueSql: string }> = [];
    if (!hasMode) {
      cols.push({ name: "ingest_mode", valueSql: "'sync_summary'" });
    }
    if (!hasSummary) {
      cols.push({ name: "summary", valueSql: "''" });
    }
    if (cols.length > 0) {
      await table.addColumns(cols);
    }
  }
};

const migration006: Migration = {
  id: "006_add_ingest_job_last_error",
  description: "Add last_error column to ingest_jobs for failure diagnostics.",
  async run(db) {
    const table = await db.openTable(INGEST_JOBS_TABLE);
    const schema = await table.schema();
    const hasLastError = schema.fields.some((f) => f.name === "last_error");
    if (!hasLastError) {
      await table.addColumns([{ name: "last_error", valueSql: "''" }]);
    }
  }
};

const MIGRATIONS: Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006];

async function persistStoreMeta(lastMigrationId: string): Promise<void> {
  const paths = resolveJustMemoryPaths();
  const config = await readConfig(paths);
  await writeConfig(paths, {
    ...config,
    last_applied_migration_id: lastMigrationId,
    store_schema_version: SCHEMA_VERSION
  });
}

export async function runPendingMigrations(db: LanceDbConnection): Promise<void> {
  migrationFailure = null;
  await ensureMigrationsRegistryTable(db);

  let lastNewlyApplied = "";
  for (const m of MIGRATIONS) {
    if (await isMigrationApplied(db, m.id)) {
      continue;
    }
    try {
      await m.run(db);
      await recordMigrationApplied(db, m.id);
      lastNewlyApplied = m.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      migrationFailure = new JustMemoryError(
        "backend_degraded",
        `Local store migration failed: ${message}`,
        "Inspect ~/.justmemory logs and data directory, fix errors, and restart JustMemory. Export data before destructive fixes when possible.",
        { migration_id: m.id }
      );
      throw migrationFailure;
    }
  }

  if (lastNewlyApplied) {
    await persistStoreMeta(lastNewlyApplied);
  }
}
