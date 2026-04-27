import { nanoid } from "nanoid";
import { AUDIT_EVENTS_TABLE, openLocalDatabase } from "../storage/lancedb.js";
import { withDbWriteLock } from "../storage/db-write-mutex.js";

export type AuditAction =
  | "memory_remember"
  | "memory_get"
  | "memory_list"
  | "memory_recall"
  | "memory_context"
  | "memory_profile_select"
  | "memory_session_start"
  | "memory_session_end"
  | "memory_ingest_status";

export interface AuditEventInput {
  request_id: string;
  action: AuditAction;
  profile_id: string;
  memory_id?: string;
  details?: Record<string, unknown>;
}

function now(): string {
  return new Date().toISOString();
}

export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  await withDbWriteLock(async () => {
    const { db } = await openLocalDatabase();
    const table = await db.openTable(AUDIT_EVENTS_TABLE);
    await table.add([
      {
        event_id: `evt_${nanoid(12)}`,
        request_id: input.request_id,
        action: input.action,
        profile_id: input.profile_id,
        memory_id: input.memory_id ?? "",
        details_json: JSON.stringify(input.details ?? {}),
        created_at: now()
      }
    ]);
  });
}

export async function countAuditEvents(): Promise<number> {
  const { db } = await openLocalDatabase();
  const table = await db.openTable(AUDIT_EVENTS_TABLE);
  const rows = await table.query().toArray();
  return rows.length;
}
