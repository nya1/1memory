# 1memory MCP-Facing Agent Contract

**Status:** Draft companion to `PRD-company-wide-agent-memory-v1.1.md`  
**Audience:** MCP client implementers, agent harness authors, product, engineering  
**Purpose:** Define the contract an AI agent sees when it uses 1memory through MCP.

---

## 1) Contract Goals

The MCP surface should make memory useful without making the agent reason about storage.

The agent should be able to:

- Authenticate or confirm the effective service/user principal.
- Discover which profile and scope it is operating in.
- Retrieve compact, relevant context before or during work.
- Save important memories explicitly.
- Hand off session history at compaction or session end.
- Inspect, correct, supersede, forget, and verify memory when needed.
- Understand whether a write is active, quarantined, duplicate, rejected, or still indexing.
- Debug bad recall using citations, evidence, request IDs, and health/capability tools.

The agent should not need to:

- Design SQL/vector queries.
- Choose indexes.
- Infer org/team/profile permissions.
- Guess whether a write was silently truncated.
- Guess whether data is immediately searchable.
- Manage storage consistency between UI, REST, MCP, and indexes.

---

## 2) Design Principles

### Constrained Tool Surface

Expose a small default tool set for common agent workflows. Advanced tools can exist, but should be hidden behind capability flags or admin configuration.

Default tools should cover:

- authentication/profile discovery
- session lifecycle
- recall
- explicit remember
- bulk ingest
- inspection
- correction
- deletion
- diagnostics

This avoids the "50 tools and no obvious starting point" problem while still leaving room for deeper operations.

### Progressive Disclosure

Recall should start compact and expand only when needed:

1. `memory_recall` returns synthesized answer, compact citations, and candidate IDs.
2. `memory_timeline` provides chronological context around selected results.
3. `memory_get` fetches full memory records or source excerpts by ID.

This keeps token use low and mirrors the proven search-index -> timeline -> full-details pattern used by existing memory MCPs.

### Explicit Integrity

No memory operation should silently lose, mutate, or hide information.

Required guarantees:

- Oversized writes are rejected or chunked; never silently truncated.
- Every mutation returns a stable `request_id`.
- Every write returns status and indexing state.
- Duplicate, supersession, and quarantine outcomes are explicit.
- MCP, REST, admin UI, and export read from one authoritative memory record model.
- Vector and full-text indexes are derived views, not sources of truth.

### Scoped by Default

Every tool call must run inside a resolved profile/scope. Resolution should be implicit whenever possible, using the effective local or hosted principal and workspace/repo/path metadata. If the scope is ambiguous, the tool should return candidates and ask for user selection only as a fallback.

The default resolution order is:

1. explicit `profile_id`, when intentionally supplied
2. client-persisted profile hint
3. effective principal's repo/project mapping
4. repo/project metadata from client
5. configured team default
6. deny with `scope_ambiguous`

### Evidence Over Assertion

Recall responses must include enough evidence for the agent to decide whether to trust the answer.

Responses should include:

- cited memory IDs
- source actor/client/session
- source repo/PR when available
- confidence or quality score
- reason retrieved
- supersession status
- request ID

---

## 3) Core Concepts

### Profile

A profile is the addressable memory container shared across sessions, agents, users, and tools.

Profiles are scoped as:

```text
org > team > project/repo > optional branch/environment
```

Agents should usually address profiles by name or resolved context, not raw storage identifiers.

### Scope

A scope is the effective read/write boundary for a request after policy evaluation.

Scope inputs may include:

- `org_id`
- `team_id`
- `profile_id`
- `repo_url`
- `project_path`
- `branch`
- `environment`
- `namespace`

### Memory Types

1memory v1 exposes four memory types:

- `fact`: stable truth, subject to supersession
- `event`: time-bound occurrence or decision
- `instruction`: convention, workflow, runbook, or preference
- `task`: short-lived active work, usually excluded from vector-heavy indexing

### Memory Status

Memory records should expose one of:

- `active`
- `superseded`
- `inactive`
- `quarantined`

Lifecycle status should not be used for write processing or indexing progress.

### Write State

Write operations should expose one of:

- `accepted`
- `rejected`
- `approval_required`
- `duplicate_ignored`
- `supersession_suggested`

### Indexing State

Records and write responses should expose one of:

- `not_indexed`
- `pending`
- `partial`
- `ready`
- `failed`

`ready` means all retrieval channels promised by the response are caught up. `partial` means the authoritative record is readable by ID, but one or more retrieval channels may not find it yet.

### Source Record

Bulk ingestion may preserve source messages or source excerpts for provenance and raw-message fallback. Source records are governed data, not informal logs.

Minimum fields:

- `source_id`
- `profile_id`
- `source_type` (`message|tool_call|tool_result|file_excerpt|review_event`)
- `source_actor`
- `source_client`
- `source_session`
- `content` or object reference
- `redaction_state`
- `retention_policy`
- `created_at`

If v1 does not store source records, `memory_recall` must not claim source-message fallback support and `memory_get(include_source=true)` should return structured `source_unavailable` metadata.

---

## 4) Local-First Identity and Profile Resolution

MCP clients vary widely in how they install, authenticate, and persist configuration. The contract should make identity/profile setup deterministic rather than relying on client-specific convention.

1memory should be local-first. A user should be able to install the npm package and use memory locally without creating an account or logging in. Hosted auth is required only for cloud sync, shared team profiles, CI/review bots, enterprise policy, or remote admin features.

### Local Runtime and Packaging

The local package, CLI, and MCP server should be implemented in TypeScript/Node and distributed as the `1memory` npm package.

Required entrypoints:

- `1memory`: CLI entrypoint
- `1memory mcp`: MCP server entrypoint, normally launched by MCP clients
- `1memory mcp install <client>`: guided client configuration
- `1memory doctor`: local setup validation
- `1memory export`: local data export for backup or future cloud import

The package should not require a local daemon for v1. The MCP client starts `1memory mcp` as a stdio process unless a specific client requires another transport.

Local runtime goals:

- install through npm
- no login for local-only use
- no Docker
- no external service
- no separate database server
- local data stored under a predictable 1memory data directory

### Supported Identity Modes

The server should explicitly advertise supported identity/auth modes through `memory_capabilities`.

Recommended v1 modes:

- `local_anonymous`: default local-only identity with no login
- `local_user`: named local identity stored on the machine, no cloud account required
- `api_key`: hosted user or team API key
- `service_account`: CI/review bot credential with scoped permissions
- `device_flow`: browser/device authorization for local IDE clients
- `sso_user_token`: enterprise user token issued after SSO

Each response should expose the effective principal. For local-only use, `org_id` may be `local` and `expires_at` may be omitted.

```json
{
  "principal_type": "local|user|service_account|agent",
  "principal_id": "local_default",
  "org_id": "local",
  "roles": ["reader", "editor"],
  "identity_mode": "local_anonymous"
}
```

### Profile Resolution Contract

Every memory operation must resolve to a profile before authorization and retrieval. The happy path should be implicit: the server uses the effective principal plus workspace/repo/path metadata to resolve the profile without asking the user.

Resolution order:

1. explicit `profile_id` or profile name, when intentionally supplied by the client
2. client-persisted profile hint
3. effective principal's repo/project mapping
4. repo remote, workspace path, and branch metadata
5. configured team/default local profile for the effective principal
6. deny with `scope_ambiguous`

If exactly one profile matches, the server should resolve it silently. If multiple profiles match, the server should return candidate profiles with enough information for the agent or MCP client to ask the user. User selection is an exception path, not the default setup path.

### Required Profile Tools

Profile inspection and selection are part of the default contract, not admin-only features. They exist for ambiguity and debugging; normal use should rely on implicit resolution.

Required tools:

- `memory_profiles_list`
- `memory_profile_current`
- `memory_profile_select`

These tools prevent each MCP client from inventing its own first-run profile UX.

---

## 5) Default MCP Tools

The default tool set should be small enough for an agent to understand from names alone.

### v1 Tool Tiers

Required default tools:

- `memory_capabilities`
- `memory_health`
- `memory_profiles_list`
- `memory_profile_current`
- `memory_profile_select`
- `memory_explain_setup`
- `memory_session_start`
- `memory_session_end`
- `memory_context`
- `memory_recall`
- `memory_remember`
- `memory_ingest`
- `memory_ingest_status`
- `memory_get`
- `memory_verify`
- `memory_feedback`

Advanced or permission-gated tools:

- `memory_list`
- `memory_timeline`
- `memory_supersede`
- `memory_forget`

This keeps first-run agent UX small while preserving a complete operational surface for ambiguity resolution, debugging, governance, and admin-approved correction.

### `memory_capabilities`

Returns server capabilities, enabled tools, limits, model/indexing features, profile resolution behavior, and active policies.

Use this at setup, session start, and after identity/authentication changes.

Minimum response fields:

- `server_version`
- `tools_enabled`
- `profiles_supported`
- `max_content_length`
- `oversize_policy`
- `indexing_modes`
- `retrieval_channels`
- `supports_supersession`
- `supports_quarantine`
- `supports_feedback`
- `supports_sandbox_namespace`
- `token_budget_modes`
- `identity_principal`
- `auth_modes`
- `requires_login`
- `default_profile_id`
- `profile_resolution_order`
- `schema_version`

### `memory_health`

Returns health for the MCP server, API, authoritative store, indexes, and async workers.

Minimum response fields:

- `status`
- `degraded_components`
- `last_index_update_at`
- `queue_depth`
- `profile_accessible`
- `authoritative_store_connected`
- `indexes_caught_up`
- `warnings`
- `request_id`

### `memory_profiles_list`

Lists profiles available to the effective principal.

Inputs:

- optional `repo`
- optional `team_id`
- optional `include_private`

Outputs:

- profile candidates with `profile_id`, name, scope path, owner team, read/write capability, and last activity
- default candidate if one can be inferred
- `request_id`

### `memory_profile_current`

Returns the currently resolved profile for this MCP client/session/workspace.

Inputs:

- optional `workspace`
- optional `repo`
- optional `session_id`

Outputs:

- current profile if resolved
- resolution source
- readable/writable capability
- ambiguity candidates if unresolved
- `request_id`

### `memory_profile_select`

Sets or confirms the profile to use for a workspace/session.

Inputs:

- `profile_id`
- optional `workspace`
- optional `repo`
- optional `persist_for`: `session`, `workspace`, or `client`

Outputs:

- selected profile
- effective scope
- read/write capability
- `request_id`

### `memory_explain_setup`

Explains the current MCP setup in plain language for the agent or user.

Inputs:

- optional `workspace`
- optional `repo`
- optional `session_id`

Outputs:

- effective identity principal
- resolved profile and resolution source
- read/write capability
- active namespace and retention policy
- whether sandbox writes are available
- whether indexes are ready
- short human-readable explanation of what memory will be used for this workspace
- actionable next step if setup is incomplete or ambiguous
- `request_id`

This tool is for trust and debugging. It should translate raw policy/profile state into a concise explanation such as: "1memory is running locally with no login. This repo resolves to the local Billing profile through workspace path. Reads and writes are allowed. Vector indexing is ready." For hosted/team mode, the explanation should identify the signed-in user and remote org.

### `memory_session_start`

Starts or resumes a session and returns the most useful compact context for the agent.

Inputs:

- `client`
- `session_id`
- `workspace`
- `repo`
- `branch`
- `profile_id` or profile hint
- optional `token_budget`
- optional `token_budget_mode`: `small`, `normal`, or `deep`

Outputs:

- resolved profile and scope
- compact context block
- relevant active instructions
- recent events/tasks
- warnings about stale, quarantined, or indexing memories
- `request_id`

This should be the easiest "make the agent smarter now" call.
It is recommended but not required for baseline usability: servers may create implicit sessions during `memory_recall` and `memory_remember` when the client does not call explicit session start.

### `memory_context`

Returns a compact context block without starting a new session.

Inputs:

- optional `profile_id`
- optional `session_id`
- optional `workspace`
- optional `repo`
- optional `branch`
- optional `focus`: `project`, `task`, `review`, `handoff`, or `debug`
- optional `token_budget`
- optional `token_budget_mode`: `small`, `normal`, or `deep`

Outputs:

- resolved profile and scope
- compact context block
- active instructions
- recent decisions/events/tasks matched to the focus
- citations used to build the context block
- warnings
- `request_id`

Use cases:

- agent reconnects
- user switches tasks
- subagent needs scoped handoff
- context window is about to be compacted

The response should be optimized for direct insertion into the agent context.

### `memory_session_end`

Closes or checkpoints a session and optionally triggers ingestion.

Inputs:

- `session_id`
- optional `summary`
- optional `messages` or artifact references
- optional `open_tasks`
- optional `outcome`: `completed`, `interrupted`, `failed`, or `handoff`
- optional `ingest_mode`: `none`, `sync_summary`, or `async_full`
- optional `preview`: return proposed memories before or alongside ingestion

Outputs:

- `session_id`
- `session_status`
- optional `ingest_job_id`
- compact handoff summary
- proposed memory preview when requested
- remembered item counts when available
- warnings
- `request_id`

This is the canonical end-of-session wrapper. Agent harnesses may still call `memory_ingest` directly for compaction, but interactive clients should prefer `memory_session_end`.

### `memory_recall`

Retrieves memory for a query and returns a synthesized answer grounded in evidence.

Inputs:

- `query`
- optional `profile_id`
- optional `scope`
- optional filters: `memory_type`, `namespace`, `repo`, `branch`, `labels`, `time_range`
- optional `mode`: `answer`, `evidence`, or `context_block`
- optional `limit`
- optional `token_budget`
- optional `token_budget_mode`: `small`, `normal`, or `deep`

Outputs:

- `answer`
- `context_block`
- `citations`
- `candidate_ids`
- `confidence`
- `why_retrieved`
- `retrieval_channels_used`
- `request_id`

The tool should support compact results by default. Full records should be fetched with `memory_get`.

### `memory_remember`

Explicitly stores an important memory.

Inputs:

- `content`
- `memory_type`
- optional `topic_key`
- optional `namespace`
- optional `labels`
- optional source metadata: `session_id`, `repo`, `branch`, `pr`, `file_paths`
- optional `importance`
- optional `expires_at`
- optional `dry_run`
- optional `sandbox`

Outputs:

- `memory_id`
- `status`
- `write_state`
- `indexing_state`
- `dedupe_result`
- `supersession_candidates`
- `quarantine_reason`
- `proposed_memory` when `dry_run=true`
- `warnings`
- `request_id`

This must be low-latency and safe for direct agent tool use.

When `dry_run=true`, the server should validate, classify, redact, dedupe, and show the proposed write without committing it. When `sandbox=true`, the write should go to a scratch namespace that is inspectable and easy to clear, but excluded from normal team recall unless explicitly requested.

### `memory_ingest`

Bulk ingests messages or session artifacts, usually at compaction or session end.

Inputs:

- `session_id`
- `messages` or artifact references
- source metadata
- optional `ingest_mode`: `sync_summary`, `async_full`, `dry_run`

Outputs:

- `ingest_job_id`
- `accepted`
- `rejected`
- `write_state`
- `warnings`
- `estimated_indexing_state`
- `request_id`

For non-trivial sessions, this should be asynchronous.

### `memory_ingest_status`

Returns the current state of an ingest job.

Outputs:

- `ingest_job_id`
- `status`
- `extracted_count`
- `active_count`
- `quarantined_count`
- `duplicate_count`
- `superseded_count`
- `rejected_count`
- `warnings`
- `request_id`

### `memory_list`

Lists memories for inspection and debugging.

Inputs:

- filters by profile, type, status, namespace, label, source, time range
- pagination cursor

Outputs:

- compact memory records
- pagination cursor
- applied filters
- `request_id`

### `memory_get`

Fetches full memory records or source excerpts by ID.

Inputs:

- `memory_ids`
- optional `include_source`
- optional `include_history`

Outputs:

- full records
- source excerpts
- supersession chains when requested
- policy redactions if any
- `request_id`

Agents should batch IDs instead of calling this repeatedly.

### `memory_verify`

Verifies a memory against its provenance and current lifecycle state.

Inputs:

- `memory_id`
- optional `include_source`
- optional `include_supersession_chain`
- optional `include_policy_trace`

Outputs:

- memory lifecycle status
- write/indexing state
- source availability and redaction state
- supersession chain
- audit/request IDs related to creation and last mutation
- verification result: `verified`, `source_unavailable`, `redacted`, `superseded`, or `policy_restricted`
- `request_id`

This is the explicit provenance/debugging tool. `memory_get(include_source=true, include_history=true)` may return the same underlying data, but `memory_verify` packages it for trust decisions.

### `memory_timeline`

Returns chronological context around a memory, query, source file, PR, repo, or session.

Inputs:

- one of `memory_id`, `query`, `session_id`, `source_pr`, `source_file`, or `repo`
- optional `time_range`
- optional `limit`
- optional `include_source`

Outputs:

- ordered timeline entries
- related memory IDs
- source excerpts when requested and allowed
- redaction/source-availability metadata
- `request_id`

Use cases:

- understand why a decision was made
- reconstruct prior failed attempts
- inspect repeated review feedback
- debug stale or contradictory recall

### `memory_supersede`

Replaces an active fact or instruction while preserving history.

Inputs:

- `old_memory_id`
- `new_content`
- optional `reason`
- optional `effective_at`

Outputs:

- `new_memory_id`
- `old_status`
- `new_status`
- `version_chain`
- `request_id`

For sensitive namespaces, this may return `quarantined` or `approval_required`.

### `memory_forget`

Marks a memory inactive or tombstones it according to policy.

Inputs:

- `memory_id`
- `reason`
- optional `mode`: `inactive`, `tombstone`, `policy_delete`

Outputs:

- `memory_id`
- `status`
- `deletion_mode`
- `retention_effect`
- `request_id`

Destructive delete should require policy permission and be auditable.

### `memory_feedback`

Lets agents or users reinforce, downrank, correct, or flag a memory.

Inputs:

- `memory_id`
- `feedback_type`: `useful`, `not_relevant`, `stale`, `incorrect`, `sensitive`, `duplicate`
- optional `comment`
- optional `replacement_content`

Outputs:

- `feedback_id`
- `action_taken`
- `review_required`
- `request_id`

This supports memory quality loops without requiring agents to directly mutate records.

---

## 6) Tool Schema Requirements

The prose in this document defines product behavior. Implementations must also publish concrete MCP tool schemas.

Every tool schema must define:

- required fields
- optional fields
- default values
- enum values
- maximum string and array sizes
- supported filter keys
- pagination behavior
- response shape
- error codes
- at least one success example
- at least one failure example for ambiguous scope or permission denial

Schema versioning:

- `memory_capabilities.schema_version` identifies the active contract version.
- Breaking changes require a new schema version.
- Additive fields are allowed if old clients can ignore them safely.
- Deprecated fields must remain documented until the next breaking schema version.

Example schema fragment:

```json
{
  "tool": "memory_recall",
  "schema_version": "2026-04-v1",
  "required": ["query"],
  "properties": {
    "query": { "type": "string", "minLength": 1, "maxLength": 4000 },
    "profile_id": { "type": "string" },
    "mode": { "enum": ["answer", "evidence", "context_block"] },
    "limit": { "type": "integer", "default": 8, "minimum": 1, "maximum": 50 },
    "token_budget_mode": { "enum": ["small", "normal", "deep"], "default": "normal" },
    "token_budget": { "type": "integer", "maximum": 8000 }
  }
}
```

---

## 7) MCP Resources

Resources provide read-only context that MCP clients can inspect without tool calls.

Recommended resources:

- `1memory://status`
- `1memory://setup/explanation`
- `1memory://current/context`
- `1memory://profiles/current`
- `1memory://profiles/{profile_id}/summary`
- `1memory://profiles/{profile_id}/latest`
- `1memory://sessions/{session_id}/summary`
- `1memory://governance/queue-counts`

Resources should be compact and safe to render in clients.

---

## 8) MCP Prompts

Prompts package common memory workflows for clients that support MCP prompts.

Recommended prompts:

- `start_coding_session`: run setup explanation, session start, and compact context retrieval
- `recall_context`: search memory and produce a compact context block
- `session_handoff`: summarize current work for another agent/session
- `memory_hygiene`: inspect likely stale, duplicate, or contradictory memories
- `review_memory`: recall prior PR feedback, false positives, and accepted exceptions
- `test_memory_setup`: run a sandbox smoke test and explain the result

Prompts should call tools through a documented workflow rather than asking the model to improvise memory strategy.
Current local implementation exposes `start_coding_session`, `recall_context`, and `session_handoff`.

---

## 9) Reference Request Flows

### 9.1 Setup and Capability Flow

1. MCP client connects to 1memory server.
2. Agent calls `memory_capabilities`.
3. Server returns identity/auth modes, effective principal, limits, enabled tools, and supported profiles.
4. Agent calls `memory_health`.
5. Agent calls `memory_profile_current`.
6. If no profile is resolved, agent calls `memory_profiles_list`.
7. If there is exactly one candidate, the server resolves it implicitly.
8. If there are multiple candidates, the user or client selects a profile through `memory_profile_select`.
9. Client stores resolved profile hint according to the selected persistence mode.

Success criteria:

- Agent can tell whether memory is available.
- Agent knows which tools and policies apply.
- Most users do not need to choose a profile manually.
- Errors are actionable, not generic connection failures.

### 9.2 Session Start Flow

1. Agent calls `memory_session_start` with workspace/repo/session metadata.
2. Scope Resolver resolves candidate profile.
3. Policy Service computes readable scopes.
4. Retrieval Orchestrator fetches high-value cross-session instructions, recent decisions, active tasks, and relevant profile summary.
5. Server returns compact context within the requested token budget.
6. Audit event records profiles accessed and request metadata.

Success criteria:

- Agent receives useful context without loading the full memory corpus.
- Response identifies stale, quarantined, or indexing caveats.
- Agent can proceed even if memory is degraded, with warnings.

### 9.3 Session End Flow

1. Agent calls `memory_session_end` with summary, outcome, and optional messages/artifacts.
2. Memory API validates the session and resolved profile.
3. If `ingest_mode=none`, server stores the session checkpoint only.
4. If `ingest_mode=sync_summary`, server writes the summary-derived memories inline when safe.
5. If `ingest_mode=async_full`, server returns an `ingest_job_id`.
6. Audit event records session close/checkpoint and any ingest job linkage.

Success criteria:

- Session handoff is explicit and inspectable.
- Interactive clients have one obvious end-of-session call.
- Compaction/session-end ingestion does not rely on the agent remembering several lower-level calls.

### 9.4 Explicit Remember Flow

1. Agent calls `memory_remember` for a specific insight, decision, instruction, exception, or user correction.
2. Gateway resolves the caller identity and forwards local or hosted identity claims.
3. Scope Resolver resolves write target.
4. Policy Service allows, denies, or requires approval.
5. Memory API validates size, schema, namespace, and source metadata.
6. Governance Engine checks duplicate, contradiction, stale, and sensitive-content rules.
7. Authoritative store writes an allowed record as `active` or `quarantined`, or returns `write_state=rejected`.
8. Index workers update vector/full-text indexes asynchronously when needed.
9. Response returns memory ID, lifecycle status, write state, indexing state, warnings, and request ID.
10. Audit event records the full decision path.

Success criteria:

- No silent truncation.
- Duplicate/supersession outcomes are explicit.
- Agent knows whether the memory is usable immediately.

### 9.5 Bulk Ingest and Compaction Flow

1. Agent or harness calls `memory_ingest` during compaction or session end.
2. Server validates payload and returns `ingest_job_id`.
3. Ingestion Worker chunks messages, preserves source provenance, and extracts candidate memories.
4. Verifier drops unsupported inferences and corrects temporal references where possible.
5. Classifier assigns memory type, topic key, labels, and indexing strategy.
6. Governance Engine handles duplicates, contradictions, and quarantine.
7. Store writes authoritative records and emits index jobs.
8. Agent or harness polls `memory_ingest_status`.

Success criteria:

- Re-ingesting the same session is idempotent.
- Long sessions are processed asynchronously.
- Extracted facts, events, instructions, and tasks are counted and inspectable.

### 9.6 Recall Flow

1. Agent calls `memory_recall` with query and optional filters.
2. Policy Service computes effective readable profile set.
3. Query analyzer generates topic-key candidates, full-text terms, synonyms, and optional HyDE-style answer embedding.
4. Retrieval runs channels in parallel:
   - exact topic-key lookup
   - full-text/BM25
   - vector search
   - HyDE vector search
   - source-message fallback where available
   - metadata filters
5. Retrieval Orchestrator fuses results, deduplicates, applies scope constraints, removes superseded active conflicts, and tie-breaks by recency.
6. Synthesis Service produces answer, compact context block, citations, confidence, and rationale.
7. Audit event records profiles accessed and decision trace.

Success criteria:

- Agent receives a usable answer and evidence.
- Retrieval never crosses unauthorized profiles.
- Superseded memories do not appear as current truth unless history was requested.

### 9.7 Progressive Detail Flow

1. Agent calls `memory_recall`.
2. Agent inspects compact candidate IDs.
3. If needed, agent calls `memory_timeline` around the best candidate.
4. If still needed, agent calls `memory_get` for full records/source excerpts.
5. Agent cites memory IDs or source excerpts in its user-facing reasoning where appropriate.

Success criteria:

- Common cases stay token-efficient.
- Complex investigations remain possible.
- Full evidence is available without bloating every recall.

### 9.8 Correction and Supersession Flow

1. User or agent identifies wrong/stale memory.
2. Agent calls `memory_feedback` with `incorrect` or `stale`.
3. If replacement is clear, agent calls `memory_supersede`.
4. Governance Engine checks contradiction and sensitive namespace policy.
5. New record becomes active or quarantined.
6. Old record is marked superseded with forward/back links.
7. Indexes remove or downrank superseded current-truth entries.

Success criteria:

- Wrong memory can be corrected in-band.
- History remains auditable.
- Recall prefers latest active truth.

### 9.9 Code Review Memory Flow

1. Review bot calls `memory_recall` with PR metadata, files changed, and review category.
2. Server returns prior false positives, accepted exceptions, reviewer corrections, and relevant incidents.
3. Bot suppresses known-noisy comments or includes narrower evidence.
4. After review, bot calls `memory_remember` for accepted exceptions, repeated patterns, or user-dismissed false positives.
5. Dismissed or disputed review memories may be quarantined pending human approval.

Success criteria:

- Review comments become less repetitive over time.
- False positives are remembered without disabling useful review categories globally.
- File/repo/PR provenance is retained.

---

## 10) Developer Experience Walkthrough

This section shows the intended developer experience from installation to multi-session use. Commands and config are illustrative; final packaging may differ by client.

### 10.1 Install the MCP Server

Developer action:

```bash
npm install -g 1memory
1memory mcp install cursor
```

`1memory mcp install <client>` should be optionally interactive. For local-first non-interactive usage, the current implementation supports workspace-scoped install planning/apply with `--dry-run`, and generates client artifacts for Cursor, Claude Code, Claude Desktop snippet output, and generic MCP.

Non-interactive example:

```bash
1memory mcp install cursor \
  --yes \
  --transport stdio \
  --scope workspace \
  --smoke-test \
  --no-login
```

Optional hosted/team setup:

```bash
1memory login
1memory sync enable
```

Equivalent manual MCP config:

```json
{
  "mcpServers": {
    "1memory": {
      "command": "npx",
      "args": ["-y", "1memory", "mcp"]
    }
  }
}
```

If the package is installed globally, clients may also call the binary directly:

```json
{
  "mcpServers": {
    "1memory": {
      "command": "1memory",
      "args": ["mcp"]
    }
  }
}
```

What happens in the background:

1. The CLI detects the current workspace, Git remote, supported MCP clients, and likely config files.
2. If interactive mode is enabled, it explains the planned config change and asks for confirmation.
3. If no hosted credential exists, the CLI initializes local-only storage and a `local_anonymous` principal.
4. If the user previously logged in, the CLI can reuse that hosted/team credential.
5. The installer writes or updates the MCP client config with an `npx 1memory mcp` command or a direct `1memory mcp` command when globally installed.
6. If `--smoke-test` is enabled, it starts the MCP server and runs setup validation.
7. On first client connection, the agent calls `memory_capabilities` and `memory_health`.
8. The server returns identity principal, enabled tools, limits, schema version, profile resolution order, and health state.
9. The first session call resolves a profile from the effective principal, workspace path, and repo metadata.

Success state:

- The IDE shows the 1memory MCP server as connected.
- The agent can call `memory_capabilities`.
- No login is required for local-only memory.
- No profile setup is required when the effective principal and workspace map to one profile.
- The user has not manually copied a long recap of prior sessions into the chat.

Interactive prompts should be concise and skippable. The intended shape is similar to guided developer commands such as `skills`: explain what will change, ask for confirmation, run a validation step, then show the exact command/config for reproducibility.

### 10.2 Implicit Profile Resolution

Developer action:

```bash
cd ~/work/acme/web-app
cursor .
```

Agent-facing equivalent:

```text
memory_profile_current(workspace="/home/me/acme/web-app")
```

What happens in the background:

1. The server resolves candidate profiles from the effective principal, workspace path, repo remote, branch, local profile registry, and team defaults if signed in.
2. The Policy Service computes which profiles the principal can read and write.
3. If exactly one profile matches, it is selected automatically.
4. The resolved profile is returned with `resolution_source` such as `repo_mapping`, `workspace_path`, or `team_default`.
5. If multiple profiles match, the server returns candidates with names, scope paths, owner teams, and read/write capability.
6. Only in that ambiguity case does the client ask the user and call `memory_profile_select`.

Success state:

- Future tool calls do not need to pass `profile_id` unless they intentionally override scope.
- Most sessions start with zero profile-related user actions.
- Ambiguous profile errors include concrete candidate choices.

### 10.3 Explain the Current Setup

Developer action:

```bash
1memory explain
```

Agent-facing equivalent:

```text
memory_explain_setup(
  workspace="/home/me/acme/web-app",
  repo="github.com/acme/web-app"
)
```

What happens in the background:

1. The server resolves the effective identity principal and profile.
2. The Policy Service computes read/write capability for the profile and namespace.
3. Health checks verify the authoritative store, worker queue, and indexes.
4. The response is translated into plain-language setup state.

Example response shape:

```json
{
  "ok": true,
  "data": {
    "explanation": "Memory is ready locally. No login is required. This workspace resolves to the local Billing profile through workspace path. Reads and writes are allowed. Indexes are ready. Sandbox writes are available.",
    "profile_id": "prof_billing",
    "resolution_source": "repo_mapping",
    "readable": true,
    "writable": true
  },
  "request_id": "req_setup_001"
}
```

Success state:

- The user can quickly understand what memory will be used for the current workspace.
- The agent can report setup problems without dumping raw policy objects.

### 10.4 Start a Coding Session

Developer action:

```text
User opens Cursor in the repo and asks:
"Investigate why the billing reconciliation job failed again."
```

Agent-facing call:

```text
memory_session_start(
  client="cursor",
  session_id="sess_123",
  workspace="/home/me/acme/web-app",
  repo="github.com/acme/web-app",
  branch="main",
  token_budget_mode="normal"
)
```

What happens in the background:

1. The Scope Resolver maps the workspace and effective principal to the matching profile.
2. The Policy Service computes readable scopes for this user/agent.
3. Retrieval fetches high-value cross-session memory: recent failed attempts, decisions, unresolved tasks, accepted exceptions, and user corrections.
4. Synthesis builds a compact context block under the requested token budget.
5. The Audit Service records that the profile was read for session start.

Example response shape:

```json
{
  "ok": true,
  "data": {
    "context_block": "Relevant memory:\n- Last investigation found duplicate payout rows after the provider retry window reopened.\n- A teammate ruled out timezone parsing on Apr 18.\n- Open task: verify whether the reconciliation replay job is idempotent for partial provider outages.",
    "citations": ["mem_101", "mem_118", "mem_203"]
  },
  "indexing_state": "ready",
  "request_id": "req_001"
}
```

Success state:

- The agent starts with relevant project memory without injecting the full memory corpus.
- The user does not need to re-explain what previous sessions tried or ruled out.

### 10.5 Recall During Work

Developer action:

```text
User asks:
"What did we already rule out last time?"
```

Agent-facing call:

```text
memory_recall(
  query="What was ruled out in the last billing reconciliation investigation?",
  mode="answer",
  filters={ "repo": "github.com/acme/web-app", "memory_type": ["fact", "event", "task"] },
  limit=8,
  token_budget_mode="small"
)
```

What happens in the background:

1. Query analysis extracts topic-key candidates, full-text terms, and optional HyDE-style answer text.
2. Retrieval runs allowed channels in parallel: topic-key lookup, BM25/full-text, vector search, HyDE vector search, metadata filters, and source-message fallback if enabled.
3. Results are fused, deduplicated, constrained by scope, and filtered for active current truth.
4. Synthesis returns a grounded answer with citations and why each memory was retrieved.
5. The read is audited with request ID and profile access trace.

Example response shape:

```json
{
  "ok": true,
  "data": {
    "answer": "The prior session ruled out timezone parsing and missing webhook delivery. The remaining hypothesis was replay idempotency during partial provider outages.",
    "candidate_ids": ["mem_203", "mem_219"],
    "why_retrieved": [
      "mem_203 matched topic_key billing.reconciliation.investigation",
      "mem_219 matched recent unresolved task metadata"
    ]
  },
  "request_id": "req_002"
}
```

Success state:

- The agent can act on prior decisions and cite the basis.
- If the answer looks suspicious, the agent can expand evidence with `memory_timeline`, `memory_get`, or `memory_verify`.

### 10.6 Preview an Explicit Memory

Developer action:

```text
User says:
"Before saving that, show me what memory you would write."
```

Agent-facing call:

```text
memory_remember(
  content="Billing reconciliation failures recur when provider retries overlap with the replay job; timezone parsing and webhook delivery were ruled out.",
  memory_type="fact",
  topic_key="billing.reconciliation.retry_overlap",
  labels=["billing", "investigation", "reconciliation"],
  dry_run=true,
  source_metadata={
    "session_id": "sess_123",
    "repo": "github.com/acme/web-app",
    "branch": "main"
  }
)
```

What happens in the background:

1. The server runs the same validation, redaction, classification, dedupe, and policy checks as a real write.
2. No authoritative memory record is created.
3. The response shows the proposed memory, redactions, duplicate/supersession candidates, and likely write/indexing outcome.

Success state:

- The user can build trust before allowing writes.
- The agent can test memory behavior without polluting team memory.

### 10.7 Save an Explicit Memory

Developer action:

```text
User says:
"We confirmed the failure only happens after provider retries overlap with our replay job."
```

Agent-facing call:

```text
memory_remember(
  content="Billing reconciliation failures recur when provider retries overlap with the replay job; timezone parsing and webhook delivery were ruled out.",
  memory_type="fact",
  topic_key="billing.reconciliation.retry_overlap",
  labels=["billing", "investigation", "reconciliation"],
  dry_run=false,
  source_metadata={
    "session_id": "sess_123",
    "repo": "github.com/acme/web-app",
    "branch": "main"
  }
)
```

What happens in the background:

1. The server validates schema, content length, memory type, namespace, and source metadata.
2. Secret/PII scanning and user-directed exclusion rules run before persistence.
3. Scope and write permissions are checked.
4. Governance checks for duplicates, contradictions, stale topic keys, and sensitive namespaces.
5. The authoritative record is written as `active` or `quarantined`, or the write returns `write_state=rejected`.
6. Index workers update full-text/vector indexes asynchronously.
7. The response exposes lifecycle status, write state, indexing state, warnings, and request ID.

Example response shape:

```json
{
  "ok": true,
  "data": {
    "memory_id": "mem_240",
    "status": "active",
    "write_state": "accepted",
    "indexing_state": "pending",
    "dedupe_result": "new"
  },
  "request_id": "req_003"
}
```

Success state:

- The memory is immediately inspectable with `memory_get`.
- The agent knows recall may not find it until `indexing_state=ready`.
- No truncation, duplicate merge, or quarantine is hidden.

### 10.8 End the Session and Ingest Handoff

Developer action:

```text
User finishes the task or closes the IDE session.
```

Agent-facing call:

```text
memory_session_end(
  session_id="sess_123",
  outcome="completed",
  summary="Investigated recurring billing reconciliation failure; confirmed retry/replay overlap and ruled out timezone parsing and webhook delivery.",
  messages=[...],
  ingest_mode="async_full",
  preview=true
)
```

What happens in the background:

1. The session checkpoint is stored with outcome and summary.
2. `memory_session_end` returns a proposed memory preview when requested.
3. The user or agent can inspect the preview before relying on async ingestion.
4. `memory_session_end` creates or links an ingest job.
5. The ingestion worker chunks messages, preserves source provenance, and extracts candidate facts, events, instructions, and tasks.
6. The verifier drops unsupported inferences and corrects temporal references.
7. The classifier assigns memory types, topic keys, labels, and indexing strategy.
8. Governance handles duplicates, contradictions, and quarantine.
9. Index workers update retrieval indexes.
10. `memory_ingest_status` exposes extracted, active, quarantined, duplicate, superseded, and rejected counts.

Example follow-up call:

```text
memory_ingest_status(ingest_job_id="ing_456")
```

Success state:

- The session can be resumed or handed off to another agent.
- Important learnings survive compaction and session closure.
- The user can inspect what was remembered rather than trusting a black box.

### 10.9 Start a Later Session

Developer action:

```text
Another teammate opens the same repo and asks:
"Continue the billing reconciliation investigation."
```

Agent-facing calls:

```text
memory_session_start(
  client="claude-code",
  session_id="sess_789",
  workspace="/home/teammate/acme/web-app",
  repo="github.com/acme/web-app",
  branch="main",
  token_budget=1500
)
```

What happens in the background:

1. Profile resolution maps the teammate's effective principal and workspace to the same shared project profile. In local-only mode this is machine-local; in hosted/team mode it can resolve to a shared remote profile.
2. Policy confirms the teammate can read the profile.
3. Retrieval finds the prior hypotheses, what was ruled out, the confirmed retry/replay overlap, and the open follow-up task.
4. Synthesis returns compact context for the new task.

Success state:

- The second agent knows what the first investigation already tried.
- It can continue from the confirmed hypothesis instead of re-running the same diagnosis.
- The team avoids repeating the same explanation.

### 10.10 Debug or Correct Bad Memory

Developer action:

```text
User says:
"That memory is slightly wrong. Webhook delivery was delayed, not ruled out."
```

Agent-facing calls:

```text
memory_recall(query="billing reconciliation investigation ruled out causes")
memory_verify(memory_id="mem_240", include_source=true, include_supersession_chain=true)
memory_feedback(memory_id="mem_240", feedback_type="incorrect", comment="Webhook delivery was delayed, not ruled out")
memory_supersede(
  old_memory_id="mem_240",
  new_content="Billing reconciliation failures recur when provider retries overlap with the replay job; timezone parsing was ruled out, and webhook delivery was delayed but not eliminated as a contributing factor.",
  reason="User correction during session sess_789"
)
```

What happens in the background:

1. `memory_verify` returns provenance, supersession state, source availability, and related audit IDs.
2. `memory_feedback` records the correction signal even if mutation requires approval.
3. `memory_supersede` writes the replacement memory and links old/new records.
4. The old memory becomes `superseded`; the new memory becomes `active` or `quarantined`.
5. Retrieval indexes remove or downrank the old current-truth entry.
6. Future recall prefers the latest active memory while preserving history.

Success state:

- Wrong memory is corrected in-band.
- The old decision remains auditable.
- Future agents stop following stale guidance.

### 10.11 Review Bot Usage Example

Developer action:

```text
A GitHub review bot starts reviewing PR #482.
```

Agent-facing calls:

```text
memory_recall(
  query="Prior review exceptions and false positives for reconciliation replay idempotency",
  filters={
    "repo": "github.com/acme/web-app",
    "source_pr": "482",
    "memory_type": ["fact", "instruction", "event"]
  },
  mode="evidence"
)
```

After review:

```text
memory_remember(
  content="Review false positive: do not flag reconciliation replay writes as unsafe when the PR uses the approved idempotency token guard from PR #482.",
  memory_type="instruction",
  topic_key="review.false_positive.reconciliation.idempotency_guard",
  labels=["code-review", "false-positive", "reconciliation"],
  source_metadata={
    "repo": "github.com/acme/web-app",
    "pr": "482",
    "source_client": "github-review-bot"
  }
)
```

What happens in the background:

1. The service account is authorized against the repo/profile.
2. Recall returns prior accepted exceptions and dismissed comments.
3. The bot narrows or suppresses noisy comments based on evidence.
4. New review learnings are written with PR provenance.
5. Sensitive or disputed review memories can be quarantined for human approval.

Success state:

- Review quality improves over time.
- False positives are remembered narrowly with repo/PR context.
- Governance can audit why the bot suppressed or emitted a class of comment.

### 10.12 Run Setup Doctor

Developer action:

```bash
1memory doctor
```

What happens in the background:

1. The CLI checks that the MCP server is registered for the current client.
2. It verifies the effective identity. In local-only mode there may be no credential or expiry; in hosted/team mode it checks token validity.
3. It runs `memory_capabilities`, `memory_health`, `memory_profile_current`, and `memory_explain_setup`.
4. It performs a sandbox `memory_remember(dry_run=true, sandbox=true)` validation.
5. It optionally writes and deletes a scratch memory in the sandbox namespace if the user passes `--write-test`.
6. It prints one of: `ready`, `degraded`, `ambiguous_profile`, `login_required_for_remote`, or `not_installed`.

Success state:

- Setup problems are diagnosed before the user starts a coding task.
- The output gives one actionable fix, not a dump of logs.

### 10.13 First-Run Smoke Test

Developer action:

```bash
1memory mcp install cursor --smoke-test
```

What happens in the background:

1. The installer writes client config.
2. In interactive mode, the installer shows the config diff before writing unless `--yes` is passed.
3. The MCP server starts and responds to `memory_capabilities`.
4. Profile resolution runs from the effective local or hosted principal plus workspace/repo metadata.
5. A sandbox dry-run write verifies schema, policy, redaction, and dedupe behavior.
6. A small recall verifies retrieval can execute against the resolved profile.

Expected user-facing output:

```text
1memory ready for github.com/acme/web-app
Mode: local-only
Profile: local / web-app
Read: allowed
Write: allowed
Indexes: ready
Sandbox: available
```

Success state:

- Install ends with proof that the current repo can use memory.
- The user does not have to discover broken auth/profile/indexing through a failed agent task.

### 10.14 Local Context vs Shared Memory

1memory should not replace local committed context files such as `AGENTS.md`.

Use local repo context for:

- stable repo rules
- build/test commands
- coding conventions
- architecture overview
- directory ownership
- instructions that should version with the codebase

Use 1memory for:

- cross-session investigation history
- user corrections and updated decisions
- what previous agents already tried or ruled out
- team-shared handoffs
- review false positives and accepted exceptions
- temporary or evolving facts that should not require a code commit

What happens in the background:

1. Agents continue reading local committed context through normal IDE/file access.
2. 1memory recall supplies only the compact, relevant evolving history.
3. If memory contradicts committed context, the response should expose citations and confidence so the agent can ask or verify instead of silently overriding repo rules.

Success state:

- Static project instructions stay reviewable in git.
- Dynamic team memory stays searchable and does not bloat `AGENTS.md`.

### 10.15 MCP Conformance and Client Fixtures

Developer action:

```bash
1memory conformance run
```

What happens in the background:

1. The test suite starts the MCP server in a known sandbox profile.
2. It verifies tool schemas, resources, prompts, and response envelopes.
3. It tests auth-required, auth-expired, ambiguous-profile, permission-denied, dry-run, sandbox, recall, ingest, and indexing-lag cases.
4. It confirms client compatibility for supported transports and clients.

Success state:

- New MCP clients can be certified against the same behavior.
- Regression tests catch setup and schema drift before users do.

---

## 11) Standard Response Envelope

Every MCP tool response should include a predictable envelope.

```json
{
  "ok": true,
  "request_id": "req_...",
  "schema_version": "2026-04-v1",
  "profile_id": "prof_...",
  "scope": {
    "org_id": "org_...",
    "team_id": "team_...",
    "repo": "github.com/acme/app"
  },
  "data": {},
  "warnings": [],
  "errors": [],
  "write_state": "accepted",
  "indexing_state": "ready"
}
```

For failures:

```json
{
  "ok": false,
  "request_id": "req_...",
  "schema_version": "2026-04-v1",
  "error": {
    "code": "scope_ambiguous",
    "message": "Multiple writable profiles match this workspace.",
    "action": "Pass profile_id or select one of the candidates.",
    "candidates": []
  },
  "warnings": []
}
```

---

## 12) Error Codes

MCP errors should be stable and actionable.

Recommended codes:

- `not_authenticated`
- `auth_expired`
- `auth_device_flow_required`
- `login_required_for_remote`
- `unsupported_auth_mode`
- `permission_denied`
- `profile_not_found`
- `profile_selection_required`
- `scope_ambiguous`
- `write_denied`
- `read_denied`
- `namespace_restricted`
- `content_too_large`
- `invalid_memory_type`
- `duplicate_detected`
- `supersession_required`
- `approval_required`
- `quarantined`
- `index_not_ready`
- `ingest_job_not_found`
- `source_unavailable`
- `schema_unsupported`
- `sandbox_unavailable`
- `dry_run_required`
- `smoke_test_failed`
- `doctor_check_failed`
- `backend_degraded`
- `rate_limited`

Errors should tell the agent what to do next.

---

## 13) Write Safety Rules

### Oversized Content

The server must choose one explicit policy:

- reject with `content_too_large`
- chunk and expose logical reassembly
- accept with `truncated=true` only if the caller explicitly opted into truncation

Default v1 recommendation: reject or chunk; do not silently truncate.

### Idempotency

`memory_ingest` and `memory_remember` should support idempotency keys.

Recommended key inputs:

- `session_id`
- source message ID
- source client
- content hash
- topic key

Replays should not create duplicate memories.

### Dry-Run and Sandbox Writes

Dry-run writes should execute validation, policy, redaction, classification, dedupe, and supersession checks without mutating authoritative memory records.

Sandbox writes should:

- use a clearly marked scratch namespace
- be excluded from normal recall by default
- be easy to list and clear
- never affect governance metrics for production memory quality
- still emit audit events so setup tests are traceable

The doctor and smoke-test flows should use dry-run or sandbox writes so setup validation does not pollute team memory.

### Deletes

The default `memory_forget` behavior should mark inactive, not hard-delete.

Policy delete or tombstone should require explicit permission and audit logging.

### Model-Assisted Mutation

Model-assisted duplicate, update, and delete decisions must be constrained.

The model may suggest:

- duplicate
- supersede
- split
- quarantine
- reject

The deterministic policy layer decides whether the mutation is allowed.

---

## 14) Privacy and Source Handling

Memory systems fail trust quickly if they capture secrets or private user content accidentally. Privacy behavior must be part of the MCP contract, not an implementation detail.

### Secret and PII Controls

Before persistence, write and ingest paths should apply:

- secret scanning for common API keys, tokens, credentials, and private keys
- configurable PII detection for customer/user data
- path-based exclusion rules for files that should never be stored
- namespace guardrails for security, compliance, incident, HR, legal, and customer data
- source-client redaction metadata so downstream tools know content was modified

Recommended redaction states:

- `none`
- `redacted`
- `partially_redacted`
- `blocked_by_policy`
- `source_unavailable`

### User-Directed Exclusion

MCP clients should support a standard exclusion marker for text the user never wants stored. The exact marker can be client-specific, but the server contract should accept metadata such as:

```json
{
  "privacy": {
    "store": false,
    "reason": "user_marked_private"
  }
}
```

When `store=false`, the server should not persist the content as a memory or source record. It may emit an audit event that a write was skipped, without storing the skipped content.

### Source Retention

Source records should have shorter and more configurable retention than distilled memories.

Defaults:

- distilled memories follow profile retention policy
- raw/source records follow source retention policy
- sensitive source records default to restricted read
- export includes redaction metadata and retention class

If source records are disabled, recall should not advertise source-message fallback.

---

## 15) Consistency and Read-After-Write Guarantees

The authoritative memory record is the source of truth. Full-text indexes, vector indexes, caches, summaries, and UI projections are derived views.

Required guarantees:

- `memory_get(memory_id)` can read an accepted authoritative record immediately.
- `memory_list` can inspect accepted records immediately unless policy restricts them.
- `memory_recall` may lag until `indexing_state=ready`.
- Exact `topic_key` lookup may become available before vector search.
- If indexing fails, the record remains inspectable and the failure is visible through `memory_get`, `memory_health`, and relevant write responses.
- UI, REST, MCP, export, and admin explorer must reflect the same lifecycle status and content from the authoritative store.

This prevents split-brain behavior where MCP search and the management UI disagree about the current memory.

---

## 16) Retrieval Quality Rules

Recall should treat current truth differently from historical evidence.

Default behavior:

- Return only active memories as current truth.
- Exclude tasks from heavy vector retrieval unless the query asks for active work.
- Downrank stale items.
- Include superseded memories only when `include_history=true`.
- Include raw-message fallback at low weight for extraction misses when source records are enabled.
- Use deterministic logic for dates, durations, and "what was true when" when possible.

Recall should expose `why_retrieved` so agents can debug bad matches.

### Token Budget Modes

Agents and users should not need to choose exact token counts for common workflows.

Recommended defaults:

- `small`: concise answer or context block, roughly 500-800 tokens
- `normal`: default coding-session context, roughly 1200-1800 tokens
- `deep`: broader investigation context, roughly 3000-5000 tokens

Explicit `token_budget` may override the mode when a client has a known context budget. If both are provided, the server should respect the lower effective ceiling unless the schema says otherwise.

---

## 17) Observability and Debugging

Agent-facing diagnostics are part of the contract, not an admin-only feature.

Every meaningful response should include:

- `request_id`
- `profile_id`
- `retrieval_channels_used` when relevant
- `write_state` when relevant
- `indexing_state`
- policy redaction warnings
- source/citation IDs

`memory_health` should reveal:

- whether MCP is connected to the same authoritative store as REST/UI
- whether indexes are caught up
- whether workers are behind
- whether the current principal can read/write the resolved profile

This directly addresses common user pain where MCP and UI show different memories or writes appear to succeed but are not retrievable.

---

## 18) Minimal v1 Acceptance Criteria

The MCP contract is ready for v1 when:

- An agent can connect locally without login, discover capabilities, implicitly resolve a profile, and request profile selection only when ambiguous.
- Local package, CLI, and MCP server are distributed through the TypeScript/Node `1memory` npm package.
- MCP client configuration supports guided interactive setup and equivalent non-interactive flags.
- Hosted/team mode can authenticate without changing the local-first contract.
- `memory_explain_setup` gives a plain-language explanation of identity mode, profile, read/write capability, and health for the current workspace.
- `1memory doctor` or equivalent setup validation checks identity/auth, MCP registration, profile resolution, health, and sandbox write behavior.
- `memory_session_start` returns a useful context block for a repo-scoped session.
- `memory_session_end` provides a single canonical session close/handoff path.
- `memory_session_end(preview=true)` returns proposed memories or a clear explanation of why no memories are proposed.
- `memory_remember` stores explicit memories with no silent truncation and supports `dry_run` plus sandbox writes.
- `memory_ingest` handles compaction/session-end payloads idempotently.
- `memory_recall` returns answer, citations, confidence, candidate IDs, and supports budget modes.
- `memory_get`, `memory_verify`, and `memory_timeline` support progressive evidence expansion.
- Tool schemas define required fields, defaults, enums, limits, examples, and stable errors.
- MCP prompts/resources include setup explanation, current context, session start, session handoff, setup test, and review-memory workflows.
- `memory_supersede`, `memory_forget`, and `memory_feedback` support correction workflows.
- All mutations are auditable by request ID.
- UI, REST, export, and MCP reflect the same authoritative memory records.
- Degraded indexing or async ingestion is visible to the agent.
- Privacy/redaction behavior is visible in write, recall, get, verify, and export responses.
- A conformance suite verifies tool schemas, response envelopes, auth/profile errors, dry-run/sandbox behavior, recall, ingest, and indexing-lag behavior.

---

## 19) Open Product Questions

1. Should `memory_session_start` automatically create a session record, or be read-only until the first write?
2. Should task memories be visible in default recall, or only through explicit task/context tools?
3. What is the default oversize policy for v1: reject, chunk, or opt-in truncation?
4. Should code review memory live in the same profile as coding memory, or in a linked namespace with stricter write rules?
5. Which hosted auth modes are required for alpha versus business readiness, given local-only usage must work without login?
6. Should source-message fallback be enabled in v1, or deferred until source retention and redaction controls are mature?

