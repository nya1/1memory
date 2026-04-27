# 1memory Local-First Release Roadmap

**Status:** Draft tracker  
**Date:** 2026-04-26  
**Scope:** Local-first 1memory v1, starting with the LanceDB-backed MCP server  
**Related docs:** `docs/PRD-local-backend-lancedb-v0.1.md`, `docs/MCP-facing-agent-contract.md`, `docs/implementation-plan-local-backend-alpha-slice-1.md`

---

## Release Goal

Release a plug-and-play local 1memory MCP server that a developer can use without external services.

The first release is successful when a user can add the MCP config, start an agent in a repo, save local memories, recall them later with citations, receive startup context, end a session with a handoff, and inspect or correct memory when needed.

Non-negotiable release qualities:

- Works locally with no login.
- Starts through `npx -y 1memory mcp`.
- Uses local LanceDB persistence.
- Requires no Docker, Python, Ollama, hosted database, hosted embedding API, or GPU.
- Degrades gracefully to lexical recall when vector embeddings are unavailable.
- Keeps agent-facing responses predictable through the MCP contract envelope.

---

## Phase Overview

| Phase | Name | Purpose | Release Gate |
| --- | --- | --- | --- |
| 0 | Product and Contract Baseline | Lock the local-first scope and MCP contract. | Docs explain what v1 is, what is deferred, and how agents connect. |
| 1 | Alpha Slice 1: Local Memory Loop | Build the first useful MCP/LanceDB loop. | Agent can remember, get, and recall a local memory. |
| 2 | Durable Local Backend | Harden the LanceDB-backed services with migrations, locks, audit events, and inspection. | Profiles and memories survive process restart and are inspectable. |
| 3 | Local Retrieval Quality | Add cheap local embeddings and hybrid ranking. | Recall uses lexical, metadata, and vector channels with citations. |
| 4 | Session Lifecycle | Add startup context and end-of-session handoff. | Agent gets initial context and can save handoff summaries. |
| 5 | Ingest and Memory Extraction | Add session summary ingest and idempotent jobs. | Session summaries create durable candidate memories safely. |
| 6 | Lifecycle and Trust Tools | Add verify, timeline, supersede, forget, and feedback. | Users can debug and correct bad memory. |
| 7 | Local Setup UX | Add install, doctor, export, and smoke tests. | A user can self-diagnose setup and back up local data. |
| 8 | MCP Conformance and Hardening | Validate the MCP contract and failure modes. | Tool schemas, envelopes, and errors pass conformance tests. |
| 9 | Local v1 Release | Package, document, and publish the local-first release. | `npx -y 1memory mcp` works from a clean machine. |
| 10 | Post-Local Team/Hosted Track | Start hosted/team capabilities without breaking local mode. | Hosted auth and sync are additive, not required for local users. |

---

## Phase 0: Product and Contract Baseline

**Goal:** Make sure implementation starts from stable product decisions.

**Inputs:**

- `docs/PRD-local-backend-lancedb-v0.1.md`
- `docs/MCP-facing-agent-contract.md`
- `docs/PRD-company-wide-agent-memory-v1.1.md`

**Work:**

- [x] Define local-only v0.1 backend scope.
- [x] Choose LanceDB as local database.
- [x] Choose Node/TypeScript package and MCP stdio runtime.
- [x] Define plug-and-play MCP config using `npx -y 1memory mcp`.
- [x] Choose low-resource local embedding default: bundled quantized ONNX `paraphrase-MiniLM-L3-v2`.
- [x] Define minimum local target: 1 CPU core, 2 GB RAM, 250 MB disk.
- [ ] Freeze Alpha Slice 1 implementation scope before coding starts.

**Exit criteria:**

- A developer can read the docs and understand the local-first release shape.
- Deferred hosted/team features are clearly out of scope for local v1.

---

## Phase 1: Alpha Slice 1: Local Memory Loop

**Goal:** Build the first end-to-end useful product path.

**Detailed plan:** `docs/implementation-plan-local-backend-alpha-slice-1.md`

**Status (2026-04-26):** Complete in the local package. `npm run build`, `npm test`, and `npm run typecheck` pass; the CLI starts an MCP stdio server; the implemented tool handlers cover the first local memory loop.

**Work:**

- [x] Create TypeScript npm package scaffold.
- [x] Add `1memory` CLI with `mcp` command.
- [x] Start MCP stdio server.
- [x] Add standard response envelope and request IDs.
- [x] Add local data directory handling.
- [x] Add LanceDB connection.
- [x] Add local profile resolution.
- [x] Implement first tools:
  - [x] `memory_capabilities`
  - [x] `memory_health`
  - [x] `memory_explain_setup`
  - [x] `memory_profiles_list`
  - [x] `memory_profile_current`
  - [x] `memory_profile_select`
  - [x] `memory_remember`
  - [x] `memory_get`
  - [x] basic `memory_recall`
- [x] Add unit and integration tests for the first local memory loop.

**Exit criteria:**

- `npm run build` passes.
- `npm test` passes.
- `1memory mcp` starts locally.
- An MCP client can save a memory, fetch it by ID, and recall it later.
- No external services are required.

---

## Phase 2: Durable Local Backend

**Goal:** Make local storage reliable enough to build on.

**Status (2026-04-26):** Mostly complete. Profile and memory persistence, idempotent table initialization, schema version in response envelopes, restart-style persistence tests, a global DB write lock, an `audit_events` LanceDB table (auditing selected tools), `memory_list`, and a **startup migration runner** (`schema_migrations` registry + ordered migrations + `config.json` store metadata) landed in-repo. Remaining: additional forward migrations as tables evolve, broader audit coverage, and richer inspection or policy modes beyond the current slice.

**Work:**

- [x] Store profiles in LanceDB instead of process-local memory.
- [x] Store memories in LanceDB instead of process-local memory.
- [x] Add schema version tracking.
- [x] Add idempotent startup migrations (registry table + runner; extend with new numbered migrations as the schema grows).
- [x] Add local write lock for mutating operations.
- [x] Add audit event table for reads, writes, and profile resolution.
- [x] Add `memory_list` for inspection and debugging.
- [x] Add persistence tests across process restart.

**Exit criteria:**

- Profiles and memories survive MCP process restart.
- `memory_get(memory_id)` can read accepted records immediately.
- Failed storage initialization returns actionable `backend_degraded` errors.
- Audit events exist for meaningful reads and writes.

---

## Phase 3: Local Retrieval Quality

**Goal:** Improve recall quality while keeping setup lightweight.

**Work:**

- [ ] Bundle quantized ONNX `paraphrase-MiniLM-L3-v2`.
- [ ] Load embeddings through `@huggingface/transformers` with remote model loading disabled.
- [ ] Store model metadata and checksum in local config.
- [ ] Generate embeddings for new memories.
- [ ] Add LanceDB vector search.
- [ ] Blend vector, lexical, metadata, topic key, recency, and importance ranking.
- [ ] Return `retrieval_channels_used` and `why_retrieved`.
- [ ] Keep lexical recall as fallback when embeddings fail.

**Exit criteria:**

- Default install does not download models during MCP startup.
- Recall uses vector search when the local model is available.
- `memory_health` accurately reports vector readiness.
- The system still works on low-resource machines without vector search.

---

## Phase 4: Session Lifecycle

**Goal:** Make 1memory useful at agent startup and shutdown.

**Work:**

- [x] Add `sessions` table.
- [x] Implement `memory_session_start`.
- [ ] Implement `memory_context`.
- [x] Implement `memory_session_end`.
- [x] Return startup context block with citations.
- [x] Store session status, summary, outcome, open tasks, workspace, repo, and branch.
- [ ] Add session resources:
  - [ ] `1memory://current/context`
  - [ ] `1memory://sessions/{session_id}/summary`
- [x] Add implicit session fallback for `memory_recall` and `memory_remember` when explicit session start is missing.
- [x] Allow `memory_session_start` to omit `session_id` and generate it server-side.
- [x] Keep `memory_session_end` non-blocking when session start was skipped by creating a synthetic fallback session record.

**Exit criteria:**

- Agent can call `memory_session_start` and receive useful initial context.
- Agent can call `memory_session_end` and save an inspectable handoff.
- Session records can be resumed or inspected later.

---

## Phase 5: Ingest and Memory Extraction

**Goal:** Convert session summaries and handoffs into durable memories safely.

**Work:**

- [ ] Add `ingest_jobs` table.
- [ ] Implement `memory_ingest`.
- [ ] Implement `memory_ingest_status`.
- [ ] Support `ingest_mode=sync_summary`.
- [ ] Support resumable `async_full` job records.
- [ ] Add idempotency by `session_id`, source ID, input hash, content hash, and topic key.
- [ ] Add conservative candidate memory extraction from summaries.
- [ ] Add preview mode for proposed memories.

**Exit criteria:**

- Re-ingesting the same session does not create duplicates.
- `memory_session_end(preview=true)` returns proposed memories or explains why none were found.
- Ingest failures are visible and recoverable.

---

## Phase 6: Lifecycle and Trust Tools

**Goal:** Let users and agents inspect, correct, and trust memory.

**Work:**

- [ ] Implement `memory_verify`.
- [ ] Implement `memory_timeline`.
- [ ] Implement `memory_supersede`.
- [ ] Implement `memory_forget`.
- [ ] Implement `memory_feedback`.
- [ ] Add supersession chains.
- [ ] Add inactive memory behavior.
- [ ] Add quarantine behavior for sensitive or risky writes.
- [ ] Add basic secret redaction and blocked-write warnings.

**Exit criteria:**

- Bad or stale memories can be corrected in-band.
- Superseded memories are excluded from default recall.
- `memory_verify` explains lifecycle, source availability, redaction state, and audit IDs.
- Secret-like content is blocked or redacted with visible warnings.

---

## Phase 7: Local Setup UX

**Goal:** Make the project easy to install, diagnose, and back up.

**Work:**

- [x] Implement `1memory mcp install <client>`.
- [ ] Support non-interactive install flags:
  - [ ] `--yes`
  - [ ] `--transport stdio`
  - [x] `--scope workspace`
  - [ ] `--smoke-test`
  - [ ] `--no-login`
- [x] Support `--dry-run` for install planning.
- [x] Generate Cursor MCP config and always-on rule artifact.
- [x] Generate Claude Code MCP config plus executable hook scaffolding.
- [x] Generate Claude Desktop and generic MCP config snippets.
- [x] Fail fast with clear error messages when existing MCP JSON config is invalid.
- [ ] Implement `1memory doctor`.
- [ ] Doctor checks:
  - [ ] local data directory permissions
  - [ ] LanceDB accessibility
  - [ ] profile resolution
  - [ ] MCP registration
  - [ ] sandbox write/recall
  - [ ] embedding readiness
- [ ] Implement `1memory export`.
- [ ] Add JSON and NDJSON export formats.

**Exit criteria:**

- First-run setup can complete in under 5 minutes.
- Users can diagnose common local issues without reading logs.
- Users can export all local data for backup or future hosted import.

---

## Phase 8: MCP Conformance and Hardening

**Goal:** Make the MCP surface stable enough for release.

**Work:**

- [ ] Define concrete schemas for every implemented MCP tool.
- [ ] Add success and failure examples for each tool.
- [ ] Add conformance tests for:
  - [ ] tool schemas
  - [ ] response envelopes
  - [ ] profile ambiguity
  - [ ] dry-run behavior
  - [ ] sandbox behavior
  - [ ] recall empty state
  - [ ] indexing unavailable state
  - [ ] storage degraded state
- [ ] Add performance smoke tests for low-resource target.
- [ ] Add cross-platform smoke notes for Linux, macOS, and Windows.

**Exit criteria:**

- All implemented tools match `docs/MCP-facing-agent-contract.md`.
- Failure modes are stable and actionable.
- Degraded indexing or storage state is visible to the agent.

---

## Phase 9: Local v1 Release

**Goal:** Publish the local-first developer release.

**Work:**

- [ ] Finalize package metadata.
- [ ] Finalize bundled model artifact packaging.
- [ ] Add README quickstart.
- [ ] Add MCP client setup examples.
- [ ] Add local privacy note.
- [ ] Add release notes.
- [ ] Run clean-machine install test.
- [ ] Publish npm package.

**Exit criteria:**

- `npx -y 1memory mcp` starts from a clean machine.
- Cursor or another MCP client can connect using documented config.
- User can remember, recall, start a session, end a session, inspect, correct, run doctor, and export.
- Release docs clearly state local-first limitations.

---

## Phase 10: Post-Local Team/Hosted Track

**Goal:** Begin company-wide memory features only after local v1 is credible.

**Work:**

- [ ] Design cloud sync protocol.
- [ ] Add hosted auth without breaking local anonymous mode.
- [ ] Add org/team/profile control plane.
- [ ] Add remote REST API.
- [ ] Add admin explorer.
- [ ] Add hosted audit, retention, and governance queues.
- [ ] Add CI/review bot service account path.

**Exit criteria:**

- Hosted/team mode is additive.
- Local-only users do not need accounts.
- MCP contract stays compatible with local v1.

---

## Current Priority

Current implementation has completed Phase 1 and substantial parts of Phases 2, 4, and 7.

Near-term priority: finish remaining Phase 7 setup UX items (`--yes`, `--transport`, `--smoke-test`, `--no-login`, `doctor`, and export polishing), then complete Phase 8 MCP conformance hardening.

The next concrete implementation milestone is:

```text
MCP client connects -> memory_capabilities works -> memory_remember stores a LanceDB record -> memory_get reads it -> memory_recall finds it.
```

