import { isBundledEmbeddingModelPresent } from "../embeddings/bundled-paths.js";
import {
  getLastEmbeddingInitError,
  getVectorRetrievalReadySync,
  probeVectorRetrievalReady
} from "../embeddings/embedding-runtime.js";
import { resolveJustMemoryPaths } from "../config/paths.js";
import { IdentityPrincipal, ProfileRecord } from "../core/types.js";
import { getMigrationFailure } from "../storage/migrations-runner.js";

export const LOCAL_PRINCIPAL: IdentityPrincipal = {
  principal_type: "local",
  principal_id: "local_default",
  org_id: "local",
  roles: ["reader", "editor"],
  identity_mode: "local_anonymous"
};

export async function capabilities(defaultProfile?: ProfileRecord) {
  const migrationError = getMigrationFailure();
  const vectorReady = getVectorRetrievalReadySync() || (await probeVectorRetrievalReady());
  return {
    server_version: "0.0.0",
    tools_enabled: [
      "memory_capabilities",
      "memory_health",
      "memory_explain_setup",
      "memory_profiles_list",
      "memory_profile_current",
      "memory_profile_select",
      "memory_context",
      "memory_session_start",
      "memory_session_end",
      "memory_ingest_status",
      "memory_remember",
      "memory_get",
      "memory_list",
      "memory_recall"
    ],
    profiles_supported: true,
    max_content_length: 4000,
    oversize_policy: "reject",
    indexing_modes: ["not_indexed", "pending", "partial", "ready", "failed"],
    retrieval_channels: vectorReady ? ["lexical", "metadata", "vector"] : ["lexical", "metadata"],
    supports_supersession: false,
    supports_quarantine: false,
    supports_feedback: false,
    supports_sandbox_namespace: false,
    token_budget_modes: ["small", "normal", "deep"],
    identity_principal: LOCAL_PRINCIPAL,
    auth_modes: ["local_anonymous"],
    requires_login: false,
    default_profile_id: defaultProfile?.profile_id,
    profile_resolution_order: ["profile_id", "client_hint", "workspace", "repo", "default_local_profile"],
    schema_version: "2026-04-v1-local-alpha",
    store_migrations_ok: !migrationError,
    vector_retrieval_ready: vectorReady
  };
}

export async function health(profile?: ProfileRecord) {
  const paths = resolveJustMemoryPaths();
  const migrationError = getMigrationFailure();
  const vectorReady = getVectorRetrievalReadySync() || (await probeVectorRetrievalReady());
  const modelPresent = isBundledEmbeddingModelPresent();
  const embedErr = getLastEmbeddingInitError();

  const warnings = [
    "Audit events are stored locally in LanceDB for selected tools (writes, reads, list, recall, profile select)."
  ];
  if (!vectorReady) {
    if (!modelPresent) {
      warnings.push(
        "Vector retrieval is inactive: bundled ONNX model files are missing. Run `pnpm run setup:embeddings`, then restart JustMemory. Lexical and metadata recall remain available."
      );
    } else {
      warnings.push(
        `Vector retrieval is inactive: ${embedErr ?? "embedding runtime did not initialize."} Lexical and metadata recall remain available.`
      );
    }
  }
  if (migrationError) {
    warnings.push(`Store migrations failed: ${migrationError.message}`);
  }
  return {
    status: migrationError ? "degraded" : "ok",
    degraded_components: migrationError ? ["migrations"] : [],
    local_data_dir: paths.rootDir,
    last_index_update_at: null,
    queue_depth: 0,
    profile_accessible: Boolean(profile),
    authoritative_store_connected: !migrationError,
    indexes_caught_up: true,
    vector_retrieval_ready: vectorReady,
    warnings
  };
}

export function explainSetup(profile?: ProfileRecord) {
  const migrationError = getMigrationFailure();
  return {
    identity_principal: LOCAL_PRINCIPAL,
    resolved_profile: profile,
    resolution_source: profile ? "local_profile_resolution" : "unresolved",
    read_write_capability: migrationError ? "unavailable" : profile ? "read_write" : "unavailable",
    active_namespace: profile?.default_namespace ?? "default",
    retention_policy: profile?.retention_policy ?? "default",
    sandbox_writes_available: false,
    indexes_ready: true,
    explanation: profile
      ? `JustMemory is running locally with no login. This workspace resolves to profile ${profile.name}. Reads and writes are allowed.`
      : "JustMemory is running locally with no login, but no profile has been resolved yet.",
    next_step: profile ? "Save or recall local memories." : "Pass workspace metadata or select a profile."
  };
}
