# Plug-and-Play Memory Activation Plan

## Goal

Make 1memory work reliably across Cursor, Claude Code, Claude Desktop, and generic MCP clients with minimal user input. The product should recall useful prior context at the start of work, store high-signal durable memories during or after work, and continue to function even when a client does not support lifecycle hooks.

## Architecture

1memory should use a layered activation model:

1. **Forgiving MCP core:** Core memory tools work without requiring an explicit `memory_session_start` call.
2. **Portable MCP activation:** Tool descriptions and MCP prompts guide agents to call memory tools at the right time.
3. **Client-specific glue:** `1memory mcp install <client>` generates the best available config, rule, or hook integration for each client.

`memory_session_start` remains useful for rich startup context, but it must be an optimization rather than a prerequisite. If a client never calls it, `memory_recall`, `memory_remember`, and `memory_session_end` should still resolve a profile and create enough session bookkeeping to preserve continuity.

## Current Status

- Phase 1 is implemented with implicit session fallback for `memory_recall` and `memory_remember`.
- `memory_session_start` now accepts optional `session_id`; backend generates `sess_<nanoid>` when omitted.
- `memory_session_end` remains non-blocking when start was skipped and can create a synthetic session record for continuity.
- Phase 2 is implemented with behavioral tool descriptions for high-signal memory tools.
- Phase 3 is implemented with MCP prompts: `start_coding_session`, `recall_context`, `session_handoff`.
- Phase 4 foundation is implemented with `1memory mcp install <client>`, `--dry-run`, and `--scope`.
- Phase 5/6 integration artifacts are implemented for Cursor rules and Claude Code hook scaffolding.
- Installer merge now fails fast with clear, path-specific errors when existing MCP JSON is invalid.

## Phase 1: Implicit Sessions

**Goal:** Make memory useful even when no explicit session start occurs.

**Scope:**

- Add an `ensureSession` flow that creates or resumes an implicit session from available metadata.
- Allow `memory_recall` and `memory_remember` to accept optional `session_id`, `client`, `workspace`, `repo`, and `branch`.
- Allow `memory_session_start` to accept optional `session_id`, and generate a backend ID when omitted.
- Attach implicit session metadata to recalls, writes, and audit events.
- Preserve existing explicit `memory_session_start` behavior.
- Keep `memory_session_end` non-error when no prior start exists by writing a synthetic fallback session with metadata markers.

**Acceptance Criteria:**

- `memory_recall` works with only `workspace` and no `session_id`.
- `memory_remember` records a source session when called without explicit session start.
- Explicit session start/end workflows continue to pass.

## Phase 2: Behavioral Tool Descriptions

**Goal:** Improve the default MCP-only experience by telling agents when to use memory.

**Scope:**

- Add concise behavioral descriptions to MCP tools.
- Describe `memory_recall` as the tool to call at the start of coding tasks or when prior work may matter.
- Describe `memory_remember` as the tool to call for durable decisions, corrections, preferences, conventions, and outcomes.
- Describe `memory_session_end` as the safe handoff path for summaries, not raw transcript ingestion.

**Acceptance Criteria:**

- MCP clients expose clearer tool guidance.
- Tool descriptions remain short enough to avoid unnecessary context bloat.
- Build and typecheck pass.

## Phase 3: MCP Prompts

**Goal:** Provide portable workflows for clients that support MCP prompts.

**Scope:**

- Add `start_coding_session`.
- Add `recall_context`.
- Add `session_handoff`.
- Add `memory_hygiene` when inspection/correction workflows are ready.

**Acceptance Criteria:**

- Prompt-supporting clients can trigger common memory workflows without the model improvising tool sequences.
- Clients without prompt support still work through tools and tool descriptions.

## Phase 4: Installer Framework

**Goal:** Make setup reproducible and safe across clients.

**Scope:**

- Expand the CLI to support `1memory mcp install <client>`.
- Support at least `cursor`, `claude-code`, `claude-desktop`, and `generic`.
- Add `--dry-run`, `--yes`, and `--scope workspace|user` options.
- Generate or print exact config changes.
- Avoid silent overwrites of user-owned config.
- Fail fast with clear error messages when existing JSON config files are malformed.

**Acceptance Criteria:**

- Installer dry-runs show exact files and snippets.
- Re-running the installer is idempotent.
- Existing config is preserved or merged safely.
- Invalid existing JSON causes a clear, actionable error with the exact config path.

## Phase 5: Cursor Integration

**Goal:** Give Cursor the best possible plug-and-play behavior using MCP config plus rules.

**Scope:**

- Generate Cursor MCP configuration for `1memory mcp`.
- Generate `.cursor/rules/1memory.mdc`.
- Mark the rule as always-on where supported.
- Instruct Cursor agents to recall memory at the start of coding tasks, remember durable decisions/corrections, and submit handoff summaries when appropriate.

**Acceptance Criteria:**

- A Cursor workspace can be configured with one command.
- The generated rule is concise and easy to inspect.
- Memory still works if the agent skips the rule and calls tools directly later.

## Phase 6: Claude Code Hooks

**Goal:** Provide true lifecycle-triggered memory for Claude Code.

**Scope:**

- Generate Claude Code MCP configuration.
- Generate a `SessionStart` hook that retrieves startup context.
- Generate a `UserPromptSubmit` hook only if needed for relevant prompt recall.
- Generate a `Stop` or `SessionEnd` hook that sends a concise handoff summary when available.
- Keep hook scripts thin; all durable behavior should live in the 1memory CLI or MCP server.

**Acceptance Criteria:**

- Starting a Claude Code session can retrieve memory without user prompting.
- Ending a session can preserve a high-signal summary.
- Hook failures degrade gracefully and do not block normal agent use.

## Phase 7: Documentation and PRD Updates

**Goal:** Align product docs with the activation architecture.

**Scope:**

- Update the local backend PRD to state that explicit `memory_session_start` is optional.
- Document implicit session behavior.
- Add a client activation matrix for MCP-only, Cursor, Claude Code, Claude Desktop, and generic clients.
- Clarify that raw transcript ingestion is not automatic in v0.1.
- Update the roadmap to reflect installer and activation milestones.

**Acceptance Criteria:**

- Docs clearly distinguish MCP tools from client lifecycle hooks.
- Users understand what “plug and play” means per client.
- The roadmap prioritizes broad compatibility before deep client-specific automation.

## Verification Plan

Run the standard checks:

```bash
npm run typecheck
npm run build
npm test
```

Add focused tests for:

- Implicit session creation.
- Explicit session start compatibility.
- Recall and remember without a prior session.
- Installer dry-run output.
- Idempotent config and rule generation.
- Clear installer failure message on malformed existing JSON.
- Safe `memory_session_end` defaults with no raw transcript ingestion.

## Recommended PR Sequence

1. **Implicit sessions and tests.**
2. **Tool descriptions and MCP prompts.**
3. **Installer core and Cursor support.**
4. **Claude Code hooks and documentation updates.**

This order delivers broad compatibility first, then progressively improves automatic behavior for clients with stronger lifecycle support.
