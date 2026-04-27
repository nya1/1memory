import { describe, expect, it } from "vitest";
import { readConfig } from "../../src/config/config-store.js";
import { resolveOneMemoryPaths } from "../../src/config/paths.js";
import { SCHEMA_VERSION } from "../../src/core/types.js";
import { SCHEMA_MIGRATIONS_TABLE } from "../../src/storage/lancedb-schema.js";
import { openLocalDatabase } from "../../src/storage/lancedb.js";
import { withTempOneMemoryHome } from "../helpers/test-env.js";

describe("LanceDB migrations", () => {
  it("applies 001 once and records schema_migrations", async () => {
    await withTempOneMemoryHome(async () => {
      const { db } = await openLocalDatabase();
      const reg = await db.openTable(SCHEMA_MIGRATIONS_TABLE);
      const afterFirst = (await reg.query().toArray()) as Array<{ migration_id?: string }>;
      expect(afterFirst.some((r) => r.migration_id === "001_initial_core_tables")).toBe(true);
      expect(afterFirst.some((r) => r.migration_id === "002_add_memory_content_embedding")).toBe(true);
      expect(afterFirst.some((r) => r.migration_id === "003_add_sessions_table")).toBe(true);
      expect(afterFirst.some((r) => r.migration_id === "004_add_ingest_jobs_table")).toBe(true);
      expect(afterFirst.some((r) => r.migration_id === "005_add_ingest_job_mode_and_summary")).toBe(true);
      expect(afterFirst.some((r) => r.migration_id === "006_add_ingest_job_last_error")).toBe(true);

      await openLocalDatabase();
      const afterSecond = (await reg.query().toArray()) as Array<{ migration_id?: string }>;
      const n = afterSecond.filter((r) => r.migration_id === "001_initial_core_tables").length;
      expect(n).toBe(1);

      const paths = resolveOneMemoryPaths();
      const cfg = await readConfig(paths);
      expect(cfg.last_applied_migration_id).toBe("006_add_ingest_job_last_error");
      expect(cfg.store_schema_version).toBe(SCHEMA_VERSION);
    });
  });
});
