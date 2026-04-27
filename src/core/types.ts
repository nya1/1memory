export const SCHEMA_VERSION = "2026-04-v1-local-alpha";

export type MemoryType = "fact" | "event" | "instruction" | "task";
export type MemoryStatus = "active" | "superseded" | "inactive" | "quarantined";
export type WriteState =
  | "accepted"
  | "rejected"
  | "approval_required"
  | "duplicate_ignored"
  | "supersession_suggested";
export type IndexingState = "not_indexed" | "pending" | "partial" | "ready" | "failed";

export interface IdentityPrincipal {
  principal_type: "local";
  principal_id: string;
  org_id: "local";
  roles: Array<"reader" | "editor">;
  identity_mode: "local_anonymous" | "local_user";
}

export interface Scope {
  org_id: "local";
  profile_id: string;
  workspace?: string;
  repo?: string;
  branch?: string;
  namespace?: string;
}

export interface ProfileRecord {
  profile_id: string;
  name: string;
  scope_path: string;
  workspace_paths: string[];
  repo_urls: string[];
  default_namespace: string;
  read_policy: "local";
  write_policy: "local";
  retention_policy: "default";
  created_at: string;
  updated_at: string;
  last_activity_at: string;
}

export interface MemoryRecord {
  memory_id: string;
  profile_id: string;
  namespace: string;
  memory_type: MemoryType;
  status: MemoryStatus;
  content: string;
  content_hash: string;
  topic_key?: string;
  labels: string[];
  importance?: number;
  confidence?: number;
  indexing_state: IndexingState;
  write_state: WriteState;
  source_actor?: string;
  source_client?: string;
  source_session?: string;
  source_repo?: string;
  source_branch?: string;
  file_paths: string[];
  redaction_state: "none" | "redacted" | "blocked_by_policy";
  created_at: string;
  updated_at: string;
}
