# JustMemory

A local memory layer for coding agents.

JustMemory runs as an MCP server on your machine. Agents can write down what matters, recall it later, and carry useful context across sessions without a hosted service. Semantic recall uses vector search with a local ONNX embedding model (`paraphrase-MiniLM-L3-v2`) published on npm with the package, so it is always available offline.

**Synthetic recall benchmark (local):** ~83% recall@1, ~100% recall@8, MRR ~0.90 on a representative run — `pnpm run benchmark:retrieval` to reproduce; sample output under **Development**.

It is built for local-first agent work:

- No login
- No Docker
- No external database
- No hosted embedding API
- No background daemon

```json
{
  "mcpServers": {
    "justmemory": {
      "command": "npx",
      "args": ["-y", "justmemory", "mcp"]
    }
  }
}
```

## The Idea

Agents are good inside one context window. They are weaker across time.

They forget what was confirmed. They forget what was ruled out. They forget the handoff from the last session. They may ask you to repeat facts the previous agent already learned.

JustMemory gives agents a small local memory system:

- write memories explicitly
- recall memories with citations
- start sessions with compact context
- end sessions with a handoff
- inspect stored memories when something looks wrong

The goal is not to replace files, docs, or git history. The goal is to preserve the working memory that normally disappears when the chat ends.

## Memory Types

JustMemory stores four kinds of memory:

- **Facts:** stable information that should be available later.
  Example: "The retry bug only reproduces when provider retries overlap with the replay job."

- **Events:** things that happened at a point in time.
  Example: "On Monday, the investigation ruled out timezone parsing."

- **Instructions:** guidance the agent should follow in future sessions.
  Example: "When touching the installer, run the MCP integration tests before reporting completion."

- **Tasks:** open work and handoff items.
  Example: "Verify whether async ingest resumes after MCP restart."

This keeps memory structured enough for agents to use, but simple enough to inspect.

## Why Local

Memory is only useful if you can trust where it lives.

JustMemory stores data locally by default:

```text
~/.justmemory/
```

Under the hood it uses LanceDB as an embedded local store. The MCP server is started by your editor or agent client as a stdio process. There is no service to run, no account to create, and no remote database to provision.

Retrieval works locally too. Lexical, metadata, and vector search run on your machine. Vector search uses the same local ONNX embedding model (`paraphrase-MiniLM-L3-v2`) shipped on npm with JustMemory, so semantic recall does not require a separate download or an embedding API.

## Quick Start

Requires Node.js 20 or newer.

Add JustMemory to an MCP client:

```json
{
  "mcpServers": {
    "justmemory": {
      "command": "npx",
      "args": ["-y", "justmemory", "mcp"]
    }
  }
}
```

For a terminal UI to browse and search local memories:

```bash
npx -y justmemory explore
```

## Client Install

JustMemory can generate workspace-scoped MCP config for supported clients:

```bash
npx -y justmemory mcp install cursor
npx -y justmemory mcp install claude-code
npx -y justmemory mcp install claude-desktop
```

Preview the generated files:

```bash
npx -y justmemory mcp install cursor --dry-run
```

Choose scope:

```bash
npx -y justmemory mcp install cursor --scope=workspace
```

Current 0.1 installer support focuses on workspace config. User-scope install planning is recognized, but workspace artifacts are used today.

## MCP Surface

The 0.1 server exposes the core local memory loop:

```text
memory_capabilities
memory_health
memory_explain_setup
memory_profiles_list
memory_profile_current
memory_profile_select
memory_session_start
memory_context
memory_recall
memory_remember
memory_get
memory_list
memory_session_end
memory_ingest_status
```

A typical session:

1. The agent starts a session and asks JustMemory for compact context.
2. During work, the agent recalls facts, events, instructions, or tasks.
3. When something worth keeping is learned, the agent writes a memory.
4. At the end, the agent records a handoff.
5. A later session can pick up from the stored memory instead of starting cold.

## What 0.1 Includes

JustMemory 0.1 is focused on making local memory useful.

Included:

- MCP stdio server
- Local profile resolution
- Local LanceDB persistence
- Explicit memory writes
- Memory get, list, and recall
- Session start and session end records
- Compact context blocks
- Lexical, metadata, and vector retrieval with the npm-shipped local embedding model
- Request IDs, warnings, and predictable response envelopes
- Startup migrations and schema tracking
- Local write mutex for safer concurrent access
- Audit events for selected reads and writes
- Cursor, Claude Code, Claude Desktop, and generic MCP config generation

Not in the 0.1 core:

- Hosted sync
- Team accounts
- Remote admin UI
- `doctor`
- export commands
- advanced correction tools such as supersede, forget, timeline, verify, and feedback

## Architecture

```text
MCP client
  -> justmemory mcp
  -> profile resolver
  -> memory, session, and recall services
  -> local LanceDB
```

The memory record is the source of truth. Recall results, context blocks, and future exports are derived from stored records rather than becoming separate hidden state.

## Development


```bash
pnpm install
```

Build:

```bash
pnpm run build
```

Typecheck:

```bash
pnpm run typecheck
```

Run tests:

```bash
pnpm test
```

Run from source:

```bash
pnpm run dev:mcp
```

## Benchmark

Retrieval benchmark (synthetic corpus in `benchmark/scenarios.json`; requires the local embedding model, same as tests). Metrics vary by machine and load.

```bash
pnpm run benchmark:retrieval
```

Example output:

```text
JustMemory retrieval benchmark (synthetic corpus, local embeddings)
cases=6 queries=18 limit=8
recall@1     83.3%
recall@8 100.0%
MRR          0.903
mean latency 24.84 ms
  - handoff-retry-overlap: @1 100% @8 100% mrr 1.00 (9 mem, 3 q)
  - mcp-stdio-instruction: @1 67% @8 100% mrr 0.83 (7 mem, 3 q)
  - ingest-resume-semantics: @1 67% @8 100% mrr 0.75 (8 mem, 3 q)
  - prefs-among-noise: @1 100% @8 100% mrr 1.00 (8 mem, 3 q)
  - timezone-ruled-out: @1 100% @8 100% mrr 1.00 (6 mem, 3 q)
  - dense-shared-vocabulary: @1 67% @8 100% mrr 0.83 (8 mem, 3 q)
```

Use `pnpm run benchmark:retrieval -- --json` for machine-readable results.

## CI and releases

CI runs on pushes and pull requests to `main`. Release steps, npm OIDC trusted publishing, and tagging are documented in [`RELEASE.md`](RELEASE.md).

## License

Apache-2.0. See `LICENSE`.
