# Local Backend Alpha Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working local 1memory loop: an MCP client can connect with `npx 1memory mcp`, create or resolve a local profile, save a memory, read it by ID, and recall it from local LanceDB storage.

**Implementation status (2026-04-26):** Complete in the local TypeScript package. The implementation includes the package scaffold, CLI, MCP stdio server, standard envelopes, local config paths, LanceDB-backed profiles and memories, lexical/metadata recall, unit tests, integration tests, and restart-style persistence coverage. Verified with `npm run build`, `npm test`, and `npm run typecheck`.

**Architecture:** Start with a single TypeScript package and a focused local backend. The MCP server is a stdio process that routes tool calls into small services for config, profile resolution, memory storage, and basic recall. LanceDB is the local persistence layer; embeddings, sessions, ingest jobs, supersession, forget, feedback, timeline, and source retention are intentionally deferred until this slice is stable.

**Tech Stack:** Node.js 20+, TypeScript, MCP TypeScript SDK, LanceDB JavaScript SDK, Zod, Vitest, tsx.

---

## Scope

This plan implements the narrowest useful product slice from `docs/PRD-local-backend-lancedb-v0.1.md` and `docs/MCP-facing-agent-contract.md`.

Included tools:

- `memory_capabilities`
- `memory_health`
- `memory_explain_setup`
- `memory_profiles_list`
- `memory_profile_current`
- `memory_profile_select`
- `memory_remember`
- `memory_get`
- `memory_list` (Phase 2 inspection; minimal filters + cursor pagination)
- basic `memory_recall`

Deferred until Alpha Slice 2:

- `memory_session_start`
- `memory_session_end`
- `memory_context`
- `memory_ingest`
- `memory_ingest_status`
- embeddings and vector search
- `memory_verify`
- `memory_timeline`
- `memory_supersede`
- `memory_forget`
- `memory_feedback`
- export and doctor commands

The milestone is intentionally simple:

```text
Cursor or another MCP client starts 1memory -> calls capabilities/health -> saves a local memory -> fetches it by ID -> recalls it later from LanceDB.
```

---

## File Structure

Create these files:

- `package.json`: package metadata, bin entry, scripts, runtime dependencies, dev dependencies.
- `tsconfig.json`: TypeScript compiler config for ESM Node output.
- `vitest.config.ts`: test runner config.
- `src/cli.ts`: command entrypoint for `1memory`; dispatches to `mcp`.
- `src/mcp/server.ts`: constructs MCP server, registers tools, connects stdio transport.
- `src/mcp/tools.ts`: tool definitions and handlers.
- `src/core/envelope.ts`: standard response envelope helpers and request IDs.
- `src/core/errors.ts`: stable error codes and error response helpers.
- `src/core/types.ts`: shared domain types.
- `src/config/paths.ts`: resolves `~/.1memory` or test override directory.
- `src/config/config-store.ts`: reads/writes `config.json`.
- `src/storage/lancedb.ts`: opens LanceDB and runs startup migrations.
- `src/storage/lancedb-schema.ts`: shared table names and `tableExists` helper.
- `src/storage/migrations-runner.ts`: `schema_migrations` registry, ordered idempotent migrations, store metadata in `config.json`.
- `src/storage/db-write-mutex.ts`: serializes LanceDB writes and related config mutations.
- `src/audit/audit-service.ts`: append-only audit events for selected MCP operations.
- `src/profiles/profile-service.ts`: local profile resolution and selection.
- `src/memory/memory-service.ts`: remember/get/list primitives backed by LanceDB.
- `src/recall/recall-service.ts`: basic lexical and metadata recall.
- `src/health/health-service.ts`: local backend health and setup explanation.
- `tests/helpers/test-env.ts`: isolated temp data directory helper.
- `tests/unit/envelope.test.ts`: envelope unit tests.
- `tests/unit/profile-service.test.ts`: profile resolution tests.
- `tests/unit/memory-service.test.ts`: remember/get tests.
- `tests/unit/recall-service.test.ts`: lexical recall tests.
- `tests/integration/mcp-tools.test.ts`: tool handler integration tests without launching a real MCP client.

Modify these files after implementation:

- `docs/PRD-local-backend-lancedb-v0.1.md`: add a short implementation status note only after Slice 1 works.
- `docs/MCP-facing-agent-contract.md`: add any schema clarifications discovered during implementation, but do not change tool names.

---

## Task 1: Package Scaffold

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

Use this starting package definition:

```json
{
  "name": "1memory",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "1memory": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev:mcp": "tsx src/cli.ts mcp",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "engines": {
    "node": ">=20"
  },
  "files": [
    "dist",
    "models"
  ],
  "dependencies": {
    "@lancedb/lancedb": "latest",
    "@modelcontextprotocol/sdk": "latest",
    "nanoid": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000
  }
});
```

- [ ] **Step 4: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and dependencies install without errors.

- [ ] **Step 5: Verify initial scripts**

Run:

```bash
npm run typecheck
npm test
```

Expected: typecheck may fail until source files exist; test should report no tests found or pass depending on Vitest behavior. Continue to Task 2 before treating this as a blocker.

---

## Task 2: Domain Types and Response Envelope

**Files:**

- Create: `src/core/types.ts`
- Create: `src/core/errors.ts`
- Create: `src/core/envelope.ts`
- Create: `tests/unit/envelope.test.ts`

- [ ] **Step 1: Define core domain types**

Create `src/core/types.ts`:

```ts
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
```

- [ ] **Step 2: Define stable errors**

Create `src/core/errors.ts`:

```ts
export type ErrorCode =
  | "profile_not_found"
  | "profile_selection_required"
  | "scope_ambiguous"
  | "content_too_large"
  | "invalid_memory_type"
  | "memory_not_found"
  | "schema_unsupported"
  | "backend_degraded";

export class OneMemoryError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly action: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "OneMemoryError";
  }
}
```

- [ ] **Step 3: Define envelope helpers**

Create `src/core/envelope.ts`:

```ts
import { nanoid } from "nanoid";
import { OneMemoryError } from "./errors.js";
import { SCHEMA_VERSION, Scope } from "./types.js";

export interface SuccessEnvelope<T> {
  ok: true;
  request_id: string;
  schema_version: string;
  profile_id?: string;
  scope?: Scope;
  data: T;
  warnings: string[];
  errors: [];
  write_state?: string;
  indexing_state?: string;
}

export interface FailureEnvelope {
  ok: false;
  request_id: string;
  schema_version: string;
  error: {
    code: string;
    message: string;
    action: string;
    details?: Record<string, unknown>;
  };
  warnings: string[];
}

export function newRequestId(): string {
  return `req_${nanoid(16)}`;
}

export function success<T>(
  data: T,
  options: {
    request_id?: string;
    profile_id?: string;
    scope?: Scope;
    warnings?: string[];
    write_state?: string;
    indexing_state?: string;
  } = {}
): SuccessEnvelope<T> {
  return {
    ok: true,
    request_id: options.request_id ?? newRequestId(),
    schema_version: SCHEMA_VERSION,
    profile_id: options.profile_id,
    scope: options.scope,
    data,
    warnings: options.warnings ?? [],
    errors: [],
    write_state: options.write_state,
    indexing_state: options.indexing_state
  };
}

export function failure(error: unknown, requestId = newRequestId()): FailureEnvelope {
  if (error instanceof OneMemoryError) {
    return {
      ok: false,
      request_id: requestId,
      schema_version: SCHEMA_VERSION,
      error: {
        code: error.code,
        message: error.message,
        action: error.action,
        details: error.details
      },
      warnings: []
    };
  }

  return {
    ok: false,
    request_id: requestId,
    schema_version: SCHEMA_VERSION,
    error: {
      code: "backend_degraded",
      message: error instanceof Error ? error.message : "Unexpected local backend error.",
      action: "Inspect local 1memory logs and retry the request."
    },
    warnings: []
  };
}
```

- [ ] **Step 4: Test envelopes**

Create `tests/unit/envelope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { failure, success } from "../../src/core/envelope.js";
import { OneMemoryError } from "../../src/core/errors.js";

describe("response envelopes", () => {
  it("creates successful envelopes with schema and request id", () => {
    const envelope = success({ hello: "world" });

    expect(envelope.ok).toBe(true);
    expect(envelope.schema_version).toBe("2026-04-v1-local-alpha");
    expect(envelope.request_id).toMatch(/^req_/);
    expect(envelope.data).toEqual({ hello: "world" });
    expect(envelope.errors).toEqual([]);
  });

  it("maps known errors into stable failure envelopes", () => {
    const envelope = failure(
      new OneMemoryError("profile_not_found", "Profile does not exist.", "Choose another profile.")
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("profile_not_found");
    expect(envelope.error.action).toBe("Choose another profile.");
  });
});
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- tests/unit/envelope.test.ts
```

Expected: envelope tests pass.

---

## Task 3: Local Paths and Config Store

**Files:**

- Create: `src/config/paths.ts`
- Create: `src/config/config-store.ts`
- Create: `tests/helpers/test-env.ts`

- [ ] **Step 1: Add data directory path resolution**

Create `src/config/paths.ts`:

```ts
import os from "node:os";
import path from "node:path";

export interface OneMemoryPaths {
  rootDir: string;
  configPath: string;
  lancedbDir: string;
  logsDir: string;
  exportsDir: string;
}

export function resolveOneMemoryPaths(): OneMemoryPaths {
  const rootDir = process.env.ONEMEMORY_HOME ?? path.join(os.homedir(), ".1memory");

  return {
    rootDir,
    configPath: path.join(rootDir, "config.json"),
    lancedbDir: path.join(rootDir, "lancedb"),
    logsDir: path.join(rootDir, "logs"),
    exportsDir: path.join(rootDir, "exports")
  };
}
```

- [ ] **Step 2: Add config store**

Create `src/config/config-store.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { OneMemoryPaths } from "./paths.js";

export interface LocalConfig {
  default_profile_id?: string;
  selected_profiles: Record<string, string>;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

export async function ensureLocalDirs(paths: OneMemoryPaths): Promise<void> {
  await fs.mkdir(paths.rootDir, { recursive: true });
  await fs.mkdir(paths.lancedbDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.exportsDir, { recursive: true });
}

export async function readConfig(paths: OneMemoryPaths): Promise<LocalConfig> {
  await ensureLocalDirs(paths);

  try {
    const raw = await fs.readFile(paths.configPath, "utf8");
    return JSON.parse(raw) as LocalConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    const created = now();
    const config: LocalConfig = {
      selected_profiles: {},
      created_at: created,
      updated_at: created
    };
    await writeConfig(paths, config);
    return config;
  }
}

export async function writeConfig(paths: OneMemoryPaths, config: LocalConfig): Promise<void> {
  await ensureLocalDirs(paths);
  const next = { ...config, updated_at: now() };
  await fs.writeFile(paths.configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function workspaceKey(workspace?: string, repo?: string): string {
  return repo ?? workspace ?? "default";
}
```

- [ ] **Step 3: Add test environment helper**

Create `tests/helpers/test-env.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withTempOneMemoryHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env.ONEMEMORY_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "1memory-test-"));
  process.env.ONEMEMORY_HOME = home;

  try {
    return await fn(home);
  } finally {
    if (previous === undefined) {
      delete process.env.ONEMEMORY_HOME;
    } else {
      process.env.ONEMEMORY_HOME = previous;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: typecheck passes for the config and core files.

---

## Task 4: LanceDB Storage Initialization

**Files:**

- Create: `src/storage/lancedb.ts`

- [ ] **Step 1: Create LanceDB adapter**

Create `src/storage/lancedb.ts`:

```ts
import * as lancedb from "@lancedb/lancedb";
import { resolveOneMemoryPaths } from "../config/paths.js";

export interface LocalDatabase {
  db: Awaited<ReturnType<typeof lancedb.connect>>;
}

export async function openLocalDatabase(): Promise<LocalDatabase> {
  const paths = resolveOneMemoryPaths();
  const db = await lancedb.connect(paths.lancedbDir);
  return { db };
}

export async function tableExists(db: LocalDatabase["db"], name: string): Promise<boolean> {
  const names = await db.tableNames();
  return names.includes(name);
}
```

- [ ] **Step 2: Verify LanceDB can open locally**

Create a short temporary check in a Node REPL or a one-off local script during implementation:

```ts
const { openLocalDatabase } = await import("./dist/storage/lancedb.js");
const local = await openLocalDatabase();
console.log(Boolean(local.db));
```

Run after build:

```bash
npm run build
node -e "import('./dist/storage/lancedb.js').then(async m => console.log(Boolean((await m.openLocalDatabase()).db)))"
```

Expected: output is `true`.

---

## Task 5: Profile Service

**Files:**

- Create: `src/profiles/profile-service.ts`
- Create: `tests/unit/profile-service.test.ts`

- [ ] **Step 1: Implement profile service**

Create `src/profiles/profile-service.ts`:

```ts
import { nanoid } from "nanoid";
import { readConfig, workspaceKey, writeConfig } from "../config/config-store.js";
import { resolveOneMemoryPaths } from "../config/paths.js";
import { OneMemoryError } from "../core/errors.js";
import { ProfileRecord } from "../core/types.js";

const profiles = new Map<string, ProfileRecord>();

function now(): string {
  return new Date().toISOString();
}

function createProfile(name: string, workspace?: string, repo?: string): ProfileRecord {
  const timestamp = now();
  return {
    profile_id: `prof_${nanoid(12)}`,
    name,
    scope_path: workspace ?? repo ?? "local/default",
    workspace_paths: workspace ? [workspace] : [],
    repo_urls: repo ? [repo] : [],
    default_namespace: "default",
    read_policy: "local",
    write_policy: "local",
    retention_policy: "default",
    created_at: timestamp,
    updated_at: timestamp,
    last_activity_at: timestamp
  };
}

export async function listProfiles(): Promise<ProfileRecord[]> {
  if (profiles.size === 0) {
    const profile = createProfile("local_default");
    profiles.set(profile.profile_id, profile);

    const paths = resolveOneMemoryPaths();
    const config = await readConfig(paths);
    config.default_profile_id = profile.profile_id;
    await writeConfig(paths, config);
  }

  return [...profiles.values()];
}

export async function resolveProfile(input: {
  profile_id?: string;
  workspace?: string;
  repo?: string;
}): Promise<ProfileRecord> {
  await listProfiles();

  if (input.profile_id) {
    const profile = profiles.get(input.profile_id);
    if (!profile) {
      throw new OneMemoryError("profile_not_found", "Profile does not exist.", "Choose an existing profile.");
    }
    return profile;
  }

  const paths = resolveOneMemoryPaths();
  const config = await readConfig(paths);
  const key = workspaceKey(input.workspace, input.repo);
  const selected = config.selected_profiles[key];

  if (selected && profiles.has(selected)) {
    return profiles.get(selected)!;
  }

  const existing = [...profiles.values()].find((profile) => {
    return (
      (input.workspace && profile.workspace_paths.includes(input.workspace)) ||
      (input.repo && profile.repo_urls.includes(input.repo))
    );
  });

  if (existing) {
    return existing;
  }

  if (input.workspace || input.repo) {
    const name = input.repo?.split("/").pop()?.replace(/\.git$/, "") || input.workspace?.split("/").pop() || "workspace";
    const profile = createProfile(name, input.workspace, input.repo);
    profiles.set(profile.profile_id, profile);
    config.selected_profiles[key] = profile.profile_id;
    config.default_profile_id ??= profile.profile_id;
    await writeConfig(paths, config);
    return profile;
  }

  const defaultProfile = config.default_profile_id ? profiles.get(config.default_profile_id) : undefined;
  if (defaultProfile) {
    return defaultProfile;
  }

  return [...profiles.values()][0];
}

export async function selectProfile(input: {
  profile_id: string;
  workspace?: string;
  repo?: string;
}): Promise<ProfileRecord> {
  const profile = await resolveProfile({ profile_id: input.profile_id });
  const paths = resolveOneMemoryPaths();
  const config = await readConfig(paths);
  config.selected_profiles[workspaceKey(input.workspace, input.repo)] = profile.profile_id;
  config.default_profile_id = profile.profile_id;
  await writeConfig(paths, config);
  return profile;
}
```

This in-memory profile service is acceptable only for the first testable slice. After LanceDB memory writes work, replace the map with a `profiles` table so profiles survive process restarts.

- [ ] **Step 2: Test profile resolution**

Create `tests/unit/profile-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { listProfiles, resolveProfile } from "../../src/profiles/profile-service.js";
import { withTempOneMemoryHome } from "../helpers/test-env.js";

describe("profile service", () => {
  it("creates a default profile", async () => {
    await withTempOneMemoryHome(async () => {
      const profiles = await listProfiles();
      expect(profiles.length).toBeGreaterThan(0);
      expect(profiles[0].profile_id).toMatch(/^prof_/);
    });
  });

  it("creates a workspace profile when workspace metadata is supplied", async () => {
    await withTempOneMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: "/tmp/acme-api" });
      expect(profile.name).toBe("acme-api");
      expect(profile.workspace_paths).toContain("/tmp/acme-api");
    });
  });
});
```

- [ ] **Step 3: Run profile tests**

Run:

```bash
npm test -- tests/unit/profile-service.test.ts
```

Expected: profile tests pass.

---

## Task 6: Memory Service

**Files:**

- Create: `src/memory/memory-service.ts`
- Create: `tests/unit/memory-service.test.ts`

- [ ] **Step 1: Implement memory service with process-local storage first**

Create `src/memory/memory-service.ts`:

```ts
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { OneMemoryError } from "../core/errors.js";
import { MemoryRecord, MemoryType, ProfileRecord } from "../core/types.js";

const memories = new Map<string, MemoryRecord>();

export const rememberInputSchema = z.object({
  content: z.string().min(1).max(4000),
  memory_type: z.enum(["fact", "event", "instruction", "task"]),
  profile_id: z.string().optional(),
  namespace: z.string().default("default"),
  topic_key: z.string().optional(),
  labels: z.array(z.string()).default([]),
  source: z
    .object({
      actor: z.string().optional(),
      client: z.string().optional(),
      session: z.string().optional(),
      repo: z.string().optional(),
      branch: z.string().optional(),
      file_paths: z.array(z.string()).default([])
    })
    .default({})
});

export type RememberInput = z.infer<typeof rememberInputSchema>;

function now(): string {
  return new Date().toISOString();
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function rememberMemory(profile: ProfileRecord, rawInput: unknown): Promise<MemoryRecord> {
  const input = rememberInputSchema.parse(rawInput);
  const content_hash = hashContent(input.content);

  const duplicate = [...memories.values()].find(
    (memory) =>
      memory.profile_id === profile.profile_id &&
      memory.content_hash === content_hash &&
      memory.status === "active"
  );

  if (duplicate) {
    return { ...duplicate, write_state: "duplicate_ignored" };
  }

  const timestamp = now();
  const memory: MemoryRecord = {
    memory_id: `mem_${nanoid(12)}`,
    profile_id: profile.profile_id,
    namespace: input.namespace,
    memory_type: input.memory_type as MemoryType,
    status: "active",
    content: input.content,
    content_hash,
    topic_key: input.topic_key,
    labels: input.labels,
    indexing_state: "not_indexed",
    write_state: "accepted",
    source_actor: input.source.actor,
    source_client: input.source.client,
    source_session: input.source.session,
    source_repo: input.source.repo,
    source_branch: input.source.branch,
    file_paths: input.source.file_paths,
    redaction_state: "none",
    created_at: timestamp,
    updated_at: timestamp
  };

  memories.set(memory.memory_id, memory);
  return memory;
}

export async function getMemories(memoryIds: string[]): Promise<MemoryRecord[]> {
  const records = memoryIds.map((id) => memories.get(id)).filter((record): record is MemoryRecord => Boolean(record));

  if (records.length !== memoryIds.length) {
    throw new OneMemoryError("memory_not_found", "One or more memories were not found.", "Pass existing memory IDs.");
  }

  return records;
}

export async function listMemories(profileId: string): Promise<MemoryRecord[]> {
  return [...memories.values()].filter((memory) => memory.profile_id === profileId);
}
```

This process-local implementation makes the tool behavior easy to test before binding the service to LanceDB. Replace the map with LanceDB persistence in Task 9.

- [ ] **Step 2: Test remember/get**

Create `tests/unit/memory-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getMemories, rememberMemory } from "../../src/memory/memory-service.js";
import { resolveProfile } from "../../src/profiles/profile-service.js";
import { withTempOneMemoryHome } from "../helpers/test-env.js";

describe("memory service", () => {
  it("stores and reads a memory by id", async () => {
    await withTempOneMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: "/tmp/app" });
      const memory = await rememberMemory(profile, {
        content: "Use LanceDB as the local 1memory store.",
        memory_type: "instruction",
        labels: ["backend"]
      });

      const [loaded] = await getMemories([memory.memory_id]);

      expect(loaded.content).toBe("Use LanceDB as the local 1memory store.");
      expect(loaded.profile_id).toBe(profile.profile_id);
    });
  });

  it("does not create duplicate active memories for identical content", async () => {
    await withTempOneMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: "/tmp/app" });
      const first = await rememberMemory(profile, {
        content: "Remember exact duplicates only once.",
        memory_type: "fact"
      });
      const second = await rememberMemory(profile, {
        content: "Remember exact duplicates only once.",
        memory_type: "fact"
      });

      expect(second.memory_id).toBe(first.memory_id);
      expect(second.write_state).toBe("duplicate_ignored");
    });
  });
});
```

- [ ] **Step 3: Run memory tests**

Run:

```bash
npm test -- tests/unit/memory-service.test.ts
```

Expected: memory service tests pass.

---

## Task 7: Basic Recall Service

**Files:**

- Create: `src/recall/recall-service.ts`
- Create: `tests/unit/recall-service.test.ts`

- [ ] **Step 1: Implement lexical recall**

Create `src/recall/recall-service.ts`:

```ts
import { MemoryRecord, ProfileRecord } from "../core/types.js";
import { listMemories } from "../memory/memory-service.js";

export interface RecallResult {
  answer: string;
  context_block: string;
  citations: Array<{
    memory_id: string;
    memory_type: string;
    content: string;
  }>;
  candidate_ids: string[];
  confidence: number;
  why_retrieved: string[];
  retrieval_channels_used: string[];
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/g)
      .filter((part) => part.length >= 2)
  );
}

function scoreMemory(queryTokens: Set<string>, memory: MemoryRecord): number {
  const haystack = tokenize(`${memory.content} ${memory.topic_key ?? ""} ${memory.labels.join(" ")}`);
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) {
      score += 1;
    }
  }
  if (memory.memory_type === "instruction") {
    score += 0.25;
  }
  return score;
}

export async function recallMemory(profile: ProfileRecord, query: string, limit = 8): Promise<RecallResult> {
  const queryTokens = tokenize(query);
  const candidates = (await listMemories(profile.profile_id))
    .filter((memory) => memory.status === "active")
    .map((memory) => ({ memory, score: scoreMemory(queryTokens, memory) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.updated_at.localeCompare(a.memory.updated_at))
    .slice(0, limit);

  const citations = candidates.map(({ memory }) => ({
    memory_id: memory.memory_id,
    memory_type: memory.memory_type,
    content: memory.content
  }));

  return {
    answer:
      citations.length === 0
        ? "No matching local memories were found."
        : citations.map((citation) => `- ${citation.content} (${citation.memory_id})`).join("\n"),
    context_block:
      citations.length === 0
        ? ""
        : ["Relevant 1memory context:", ...citations.map((citation) => `- [${citation.memory_id}] ${citation.content}`)].join("\n"),
    citations,
    candidate_ids: citations.map((citation) => citation.memory_id),
    confidence: citations.length === 0 ? 0 : Math.min(0.95, 0.4 + citations.length * 0.1),
    why_retrieved: citations.map((citation) => `${citation.memory_id} matched query terms through lexical recall.`),
    retrieval_channels_used: ["lexical", "metadata"]
  };
}
```

- [ ] **Step 2: Test recall**

Create `tests/unit/recall-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rememberMemory } from "../../src/memory/memory-service.js";
import { resolveProfile } from "../../src/profiles/profile-service.js";
import { recallMemory } from "../../src/recall/recall-service.js";
import { withTempOneMemoryHome } from "../helpers/test-env.js";

describe("recall service", () => {
  it("recalls active memories with citations", async () => {
    await withTempOneMemoryHome(async () => {
      const profile = await resolveProfile({ workspace: "/tmp/app" });
      const memory = await rememberMemory(profile, {
        content: "Use MCP stdio for local 1memory clients.",
        memory_type: "instruction",
        labels: ["mcp", "stdio"]
      });

      const result = await recallMemory(profile, "How should local MCP clients connect?");

      expect(result.candidate_ids).toContain(memory.memory_id);
      expect(result.context_block).toContain(memory.memory_id);
      expect(result.retrieval_channels_used).toEqual(["lexical", "metadata"]);
    });
  });
});
```

- [ ] **Step 3: Run recall tests**

Run:

```bash
npm test -- tests/unit/recall-service.test.ts
```

Expected: recall service tests pass.

---

## Task 8: MCP Tool Handlers

**Files:**

- Create: `src/health/health-service.ts`
- Create: `src/mcp/tools.ts`
- Create: `tests/integration/mcp-tools.test.ts`

- [ ] **Step 1: Implement health service**

Create `src/health/health-service.ts`:

```ts
import { resolveOneMemoryPaths } from "../config/paths.js";
import { IdentityPrincipal, ProfileRecord } from "../core/types.js";

export const LOCAL_PRINCIPAL: IdentityPrincipal = {
  principal_type: "local",
  principal_id: "local_default",
  org_id: "local",
  roles: ["reader", "editor"],
  identity_mode: "local_anonymous"
};

export function capabilities(defaultProfile?: ProfileRecord) {
  return {
    server_version: "0.0.0",
    tools_enabled: [
      "memory_capabilities",
      "memory_health",
      "memory_explain_setup",
      "memory_profiles_list",
      "memory_profile_current",
      "memory_profile_select",
      "memory_remember",
      "memory_get",
      "memory_recall"
    ],
    profiles_supported: true,
    max_content_length: 4000,
    oversize_policy: "reject",
    indexing_modes: ["not_indexed"],
    retrieval_channels: ["lexical", "metadata"],
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
    schema_version: "2026-04-v1-local-alpha"
  };
}

export function health(profile?: ProfileRecord) {
  const paths = resolveOneMemoryPaths();
  return {
    status: "ok",
    degraded_components: [],
    local_data_dir: paths.rootDir,
    last_index_update_at: null,
    queue_depth: 0,
    profile_accessible: Boolean(profile),
    authoritative_store_connected: true,
    indexes_caught_up: true,
    warnings: ["Alpha Slice 1 uses lexical recall only; vector indexing is not enabled yet."]
  };
}

export function explainSetup(profile?: ProfileRecord) {
  return {
    identity_principal: LOCAL_PRINCIPAL,
    resolved_profile: profile,
    resolution_source: profile ? "local_profile_resolution" : "unresolved",
    read_write_capability: profile ? "read_write" : "unavailable",
    active_namespace: profile?.default_namespace ?? "default",
    retention_policy: profile?.retention_policy ?? "default",
    sandbox_writes_available: false,
    indexes_ready: true,
    explanation: profile
      ? `1memory is running locally with no login. This workspace resolves to profile ${profile.name}. Reads and writes are allowed.`
      : "1memory is running locally with no login, but no profile has been resolved yet.",
    next_step: profile ? "Save or recall local memories." : "Pass workspace metadata or select a profile."
  };
}
```

- [ ] **Step 2: Implement tool handlers**

Create `src/mcp/tools.ts`:

```ts
import { z } from "zod";
import { failure, success } from "../core/envelope.js";
import { getMemories, rememberMemory } from "../memory/memory-service.js";
import { resolveProfile, listProfiles, selectProfile } from "../profiles/profile-service.js";
import { recallMemory } from "../recall/recall-service.js";
import { capabilities, explainSetup, health } from "../health/health-service.js";

const profileContextSchema = z.object({
  profile_id: z.string().optional(),
  workspace: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional()
});

export async function handleMemoryCapabilities(input: unknown = {}) {
  try {
    const parsed = profileContextSchema.partial().parse(input);
    const profile = await resolveProfile(parsed);
    return success(capabilities(profile), { profile_id: profile.profile_id });
  } catch (error) {
    return failure(error);
  }
}

export async function handleMemoryHealth(input: unknown = {}) {
  try {
    const parsed = profileContextSchema.partial().parse(input);
    const profile = await resolveProfile(parsed);
    return success(health(profile), { profile_id: profile.profile_id });
  } catch (error) {
    return failure(error);
  }
}

export async function handleMemoryExplainSetup(input: unknown = {}) {
  try {
    const parsed = profileContextSchema.partial().parse(input);
    const profile = await resolveProfile(parsed);
    return success(explainSetup(profile), { profile_id: profile.profile_id });
  } catch (error) {
    return failure(error);
  }
}

export async function handleProfilesList() {
  try {
    return success({ profiles: await listProfiles() });
  } catch (error) {
    return failure(error);
  }
}

export async function handleProfileCurrent(input: unknown = {}) {
  try {
    const parsed = profileContextSchema.partial().parse(input);
    const profile = await resolveProfile(parsed);
    return success({ profile, resolution_source: "local_profile_resolution", readable: true, writable: true }, { profile_id: profile.profile_id });
  } catch (error) {
    return failure(error);
  }
}

export async function handleProfileSelect(input: unknown) {
  try {
    const parsed = z
      .object({
        profile_id: z.string(),
        workspace: z.string().optional(),
        repo: z.string().optional()
      })
      .parse(input);
    const profile = await selectProfile(parsed);
    return success({ profile, effective_scope: { org_id: "local", profile_id: profile.profile_id }, readable: true, writable: true }, { profile_id: profile.profile_id });
  } catch (error) {
    return failure(error);
  }
}

export async function handleMemoryRemember(input: unknown) {
  try {
    const parsed = z
      .object({
        profile_id: z.string().optional(),
        workspace: z.string().optional(),
        repo: z.string().optional()
      })
      .passthrough()
      .parse(input);
    const profile = await resolveProfile(parsed);
    const memory = await rememberMemory(profile, parsed);
    return success(
      {
        memory_id: memory.memory_id,
        status: memory.status,
        write_state: memory.write_state,
        indexing_state: memory.indexing_state,
        dedupe_result: memory.write_state === "duplicate_ignored" ? "exact_duplicate" : "new_memory",
        supersession_candidates: [],
        quarantine_reason: null
      },
      {
        profile_id: profile.profile_id,
        write_state: memory.write_state,
        indexing_state: memory.indexing_state
      }
    );
  } catch (error) {
    return failure(error);
  }
}

export async function handleMemoryGet(input: unknown) {
  try {
    const parsed = z.object({ memory_ids: z.array(z.string()).min(1) }).parse(input);
    const records = await getMemories(parsed.memory_ids);
    return success({ records });
  } catch (error) {
    return failure(error);
  }
}

export async function handleMemoryRecall(input: unknown) {
  try {
    const parsed = z
      .object({
        query: z.string().min(1),
        profile_id: z.string().optional(),
        workspace: z.string().optional(),
        repo: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(8)
      })
      .parse(input);
    const profile = await resolveProfile(parsed);
    const result = await recallMemory(profile, parsed.query, parsed.limit);
    return success(result, { profile_id: profile.profile_id });
  } catch (error) {
    return failure(error);
  }
}
```

- [ ] **Step 3: Test tool handlers**

Create `tests/integration/mcp-tools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  handleMemoryCapabilities,
  handleMemoryGet,
  handleMemoryHealth,
  handleMemoryRecall,
  handleMemoryRemember
} from "../../src/mcp/tools.js";
import { withTempOneMemoryHome } from "../helpers/test-env.js";

describe("MCP tool handlers", () => {
  it("runs the first local memory loop", async () => {
    await withTempOneMemoryHome(async () => {
      const capabilities = await handleMemoryCapabilities({ workspace: "/tmp/app" });
      expect(capabilities.ok).toBe(true);

      const health = await handleMemoryHealth({ workspace: "/tmp/app" });
      expect(health.ok).toBe(true);

      const remembered = await handleMemoryRemember({
        workspace: "/tmp/app",
        content: "1memory Alpha Slice 1 uses lexical recall before embeddings.",
        memory_type: "fact",
        labels: ["alpha", "recall"]
      });
      expect(remembered.ok).toBe(true);
      if (!remembered.ok) return;

      const memoryId = remembered.data.memory_id;
      const loaded = await handleMemoryGet({ memory_ids: [memoryId] });
      expect(loaded.ok).toBe(true);

      const recalled = await handleMemoryRecall({
        workspace: "/tmp/app",
        query: "How does alpha recall work?"
      });
      expect(recalled.ok).toBe(true);
      if (!recalled.ok) return;
      expect(recalled.data.candidate_ids).toContain(memoryId);
    });
  });
});
```

- [ ] **Step 4: Run integration tests**

Run:

```bash
npm test -- tests/integration/mcp-tools.test.ts
```

Expected: integration test passes.

---

## Task 9: MCP Stdio Server and CLI

**Files:**

- Create: `src/mcp/server.ts`
- Create: `src/cli.ts`

- [ ] **Step 1: Implement MCP server registration**

Create `src/mcp/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  handleMemoryCapabilities,
  handleMemoryExplainSetup,
  handleMemoryGet,
  handleMemoryHealth,
  handleMemoryRecall,
  handleMemoryRemember,
  handleProfileCurrent,
  handleProfilesList,
  handleProfileSelect
} from "./tools.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "1memory",
    version: "0.0.0"
  });

  server.tool("memory_capabilities", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await handleMemoryCapabilities(), null, 2) }] }));
  server.tool("memory_health", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await handleMemoryHealth(), null, 2) }] }));
  server.tool("memory_explain_setup", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await handleMemoryExplainSetup(), null, 2) }] }));
  server.tool("memory_profiles_list", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await handleProfilesList(), null, 2) }] }));
  server.tool("memory_profile_current", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await handleProfileCurrent(), null, 2) }] }));
  server.tool(
    "memory_profile_select",
    { profile_id: z.string(), workspace: z.string().optional(), repo: z.string().optional() },
    async (input) => ({ content: [{ type: "text", text: JSON.stringify(await handleProfileSelect(input), null, 2) }] })
  );
  server.tool(
    "memory_remember",
    {
      content: z.string(),
      memory_type: z.enum(["fact", "event", "instruction", "task"]),
      profile_id: z.string().optional(),
      workspace: z.string().optional(),
      repo: z.string().optional(),
      namespace: z.string().optional(),
      labels: z.array(z.string()).optional()
    },
    async (input) => ({ content: [{ type: "text", text: JSON.stringify(await handleMemoryRemember(input), null, 2) }] })
  );
  server.tool(
    "memory_get",
    { memory_ids: z.array(z.string()) },
    async (input) => ({ content: [{ type: "text", text: JSON.stringify(await handleMemoryGet(input), null, 2) }] })
  );
  server.tool(
    "memory_recall",
    {
      query: z.string(),
      profile_id: z.string().optional(),
      workspace: z.string().optional(),
      repo: z.string().optional(),
      limit: z.number().optional()
    },
    async (input) => ({ content: [{ type: "text", text: JSON.stringify(await handleMemoryRecall(input), null, 2) }] })
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

During implementation, verify the current MCP TypeScript SDK API. If `server.tool` expects a different handler signature in the installed version, adapt only this file and keep `src/mcp/tools.ts` stable.

- [ ] **Step 2: Implement CLI**

Create `src/cli.ts`:

```ts
#!/usr/bin/env node
import { runMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "mcp") {
    await runMcpServer();
    return;
  }

  console.error("Usage: 1memory mcp");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

- [ ] **Step 3: Build**

Run:

```bash
npm run build
```

Expected: TypeScript compiles. If the MCP SDK registration signature differs, fix `src/mcp/server.ts` and run build again.

- [ ] **Step 4: Start local server**

Run:

```bash
npm run dev:mcp
```

Expected: process starts and waits for MCP stdio messages. Stop it with Ctrl-C.

---

## Task 10: Persist Profiles and Memories in LanceDB

**Files:**

- Modify: `src/profiles/profile-service.ts`
- Modify: `src/memory/memory-service.ts`
- Modify: `src/storage/lancedb.ts`
- Modify: `tests/unit/profile-service.test.ts`
- Modify: `tests/unit/memory-service.test.ts`
- Modify: `tests/unit/recall-service.test.ts`
- Modify: `tests/integration/mcp-tools.test.ts`

- [ ] **Step 1: Replace process-local maps with LanceDB tables**

Implement table-backed persistence for:

- `profiles`
- `memories`

Use these logical record shapes from `src/core/types.ts`. Store arrays as JSON-compatible values if LanceDB supports them directly in the current SDK; otherwise serialize `workspace_paths`, `repo_urls`, `labels`, and `file_paths` as JSON strings in Alpha Slice 1.

- [ ] **Step 2: Preserve service function signatures**

Keep these functions unchanged for callers:

```ts
listProfiles(): Promise<ProfileRecord[]>
resolveProfile(input): Promise<ProfileRecord>
selectProfile(input): Promise<ProfileRecord>
rememberMemory(profile, input): Promise<MemoryRecord>
getMemories(memoryIds): Promise<MemoryRecord[]>
listMemories(profileId): Promise<MemoryRecord[]>
```

Only the internals should change.

- [ ] **Step 3: Add restart persistence test**

Extend `tests/integration/mcp-tools.test.ts` with a test that:

1. Writes a memory.
2. Clears module-local caches if any exist.
3. Reads the memory by ID again from the same temp `ONEMEMORY_HOME`.

Expected: the memory survives within the local LanceDB data directory.

- [ ] **Step 4: Run full tests**

Run:

```bash
npm test
npm run typecheck
```

Expected: all tests and typecheck pass.

---

## Task 11: Manual MCP Config Smoke Test

**Files:**

- Modify only if needed: `docs/MCP-facing-agent-contract.md`

- [ ] **Step 1: Build package**

Run:

```bash
npm run build
```

Expected: `dist/cli.js` exists.

- [ ] **Step 2: Test local command**

Run:

```bash
node dist/cli.js mcp
```

Expected: MCP server starts and waits for stdio. Stop with Ctrl-C.

- [ ] **Step 3: Test package-style command locally**

Run:

```bash
npm link
1memory mcp
```

Expected: MCP server starts and waits for stdio. Stop with Ctrl-C.

- [ ] **Step 4: Confirm documented MCP config**

Use this manual config shape in an MCP client:

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

For local development before the package is published, use the linked binary or direct Node path:

```json
{
  "mcpServers": {
    "1memory-local": {
      "command": "node",
      "args": ["/absolute/path/to/agent-investigation-memory/dist/cli.js", "mcp"]
    }
  }
}
```

Expected: client shows the 1memory MCP server as connected and can call `memory_capabilities`.

---

## Definition of Done

Alpha Slice 1 is complete when:

- [x] `npm run build` succeeds.
- [x] `npm test` succeeds.
- [x] `npm run typecheck` succeeds.
- [x] `1memory mcp` starts a stdio MCP server.
- [x] `memory_capabilities` returns local-only capabilities and `requires_login=false`.
- [x] `memory_health` returns local storage health.
- [x] `memory_explain_setup` explains the local no-login setup.
- [x] `memory_profiles_list`, `memory_profile_current`, and `memory_profile_select` work for local profiles.
- [x] `memory_remember` stores an active local memory.
- [x] `memory_get` reads that memory by ID.
- [x] `memory_recall` finds that memory using lexical/metadata recall.
- [x] Memories and profiles survive process restart through local LanceDB storage.

---

## Review Checklist

- [x] The implementation does not introduce hosted auth, remote sync, billing, or admin UI code.
- [x] The implementation does not require Docker, Python, Ollama, or external services.
- [x] The implementation does not add embeddings yet.
- [x] Every tool response uses the standard response envelope.
- [x] All stable error codes are actionable.
- [x] The MCP config path remains compatible with the documented `npx -y 1memory mcp` shape.
