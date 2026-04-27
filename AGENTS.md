# Agent Guidance

JustMemory is a local-first memory layer for coding agents. It runs as an MCP stdio server and stores memory locally, with lexical recall always available and local vector recall when the bundled embedding model is present.

## Source Of Truth

- Start with `README.md` for the product shape, quick start, MCP surface, and development commands.
- Use `docs/PRD-local-backend-lancedb-v0.1.md` and `docs/release-roadmap-local-first-v1.md` for the current 0.1 scope.
- Use `docs/MCP-facing-agent-contract.md` when changing MCP tool behavior, response envelopes, recall semantics, or agent-facing contracts.

## Project Shape

- Runtime source lives in `src/`; tests live in `tests/`.
- `src/mcp/` defines the MCP server and tool surface.
- `src/memory/`, `src/recall/`, `src/sessions/`, and `src/profiles/` hold the main memory workflow.
- `src/storage/` owns LanceDB persistence, schema, migrations, and write coordination.
- `src/install/` owns generated MCP client configuration.
- `dist/`, `models/`, and `node_modules/` are generated or vendored outputs; do not hand-edit them unless the task is explicitly about release artifacts.

## Commands

Always run `nvm use` before any Node-related command.

```bash
nvm use
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Use targeted Vitest runs while iterating, then run the broader relevant check before reporting completion. Test setup may download or verify the local embedding model through `scripts/download-embedding-model.mjs`.

## Working Norms

- Prefer small, explicit changes that preserve the local-first, no-login, no-daemon design.
- Keep MCP responses predictable: preserve request IDs, warnings, explicit statuses, and cited recall results.
- Treat memory records as the source of truth; recall results and context blocks are derived views.
- Do not introduce hosted services, external embedding APIs, Docker requirements, or background daemons unless the user explicitly changes the product direction.
- For installer changes, verify generated config shape for the affected client and prefer workspace-scoped behavior unless the docs say otherwise.
