import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  handleMemoryCapabilities,
  handleMemoryContext,
  handleMemoryExplainSetup,
  handleMemoryGet,
  handleMemoryHealth,
  handleMemoryIngestStatus,
  handleMemoryList,
  handleMemoryRecall,
  handleMemoryRemember,
  handleMemorySessionEnd,
  handleMemorySessionStart,
  handleProfileCurrent,
  handleProfilesList,
  handleProfileSelect,
  memoryContextInputSchema,
  memoryRememberInputSchema,
  memorySessionEndInputSchema,
  memorySessionStartInputSchema,
  profileContextSchema
} from "./tools.js";
const memoryGetSchema = z.object({
  memory_ids: z.array(z.string().min(1)).min(1),
  profile_id: z.string().optional(),
  workspace: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional()
});
const memoryListSchema = z.object({
  profile_id: z.string().optional(),
  workspace: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  memory_type: z.enum(["fact", "event", "instruction", "task"]).optional(),
  status: z.enum(["active", "superseded", "inactive", "quarantined"]).optional(),
  namespace: z.string().optional(),
  label: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional()
});
const memoryRecallSchema = z.object({
  query: z.string().min(1),
  session_id: z.string().optional(),
  client: z.string().optional(),
  profile_id: z.string().optional(),
  workspace: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional()
});
const memoryIngestStatusSchema = z.object({
  ingest_job_id: z.string().min(1),
  profile_id: z.string().optional(),
  workspace: z.string().optional(),
  repo: z.string().optional()
});

type ToolDefinition = {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
};

type PromptDefinition = {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  build: (input: Record<string, unknown>) => {
    description: string;
    messages: Array<{ role: "user" | "assistant"; content: { type: "text"; text: string } }>;
  };
};

export const MEMORY_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "memory_capabilities",
    description:
      "Inspect enabled memory tools, limits, retrieval channels, and profile resolution behavior for the current workspace.",
    schema: profileContextSchema,
    handler: handleMemoryCapabilities
  },
  {
    name: "memory_health",
    description:
      "Check local backend readiness and warnings before memory operations, including profile accessibility and indexing state.",
    schema: profileContextSchema,
    handler: handleMemoryHealth
  },
  {
    name: "memory_explain_setup",
    description:
      "Explain the active profile, storage mode, and read/write posture in plain language for trust and debugging.",
    schema: profileContextSchema,
    handler: handleMemoryExplainSetup
  },
  {
    name: "memory_profiles_list",
    description: "List available profiles that this local backend can read and write.",
    schema: z.object({}),
    handler: async () => handleProfilesList()
  },
  {
    name: "memory_profile_current",
    description: "Resolve and return the effective profile for the current workspace/repo without changing selection.",
    schema: profileContextSchema,
    handler: handleProfileCurrent
  },
  {
    name: "memory_profile_select",
    description: "Explicitly select which profile to use for subsequent memory reads/writes in this workspace context.",
    schema: z.object({ profile_id: z.string().min(1), workspace: z.string().optional(), repo: z.string().optional() }),
    handler: handleProfileSelect
  },
  {
    name: "memory_remember",
    description:
      "Save durable project memory when the user confirms a decision, correction, convention, or important outcome worth reusing in future sessions.",
    schema: memoryRememberInputSchema,
    handler: handleMemoryRemember
  },
  {
    name: "memory_get",
    description: "Fetch full memory records by ID for verification, debugging, or citing exact stored content.",
    schema: memoryGetSchema,
    handler: handleMemoryGet
  },
  {
    name: "memory_list",
    description: "Browse stored memories with filters and pagination when you need inspection beyond a search query.",
    schema: memoryListSchema,
    handler: handleMemoryList
  },
  {
    name: "memory_context",
    description: "Return compact context for the resolved profile/workspace without requiring an explicit session start.",
    schema: memoryContextInputSchema,
    handler: handleMemoryContext
  },
  {
    name: "memory_session_start",
    description: "Start or resume a session and return compact startup context for the resolved profile and workspace.",
    schema: memorySessionStartInputSchema,
    handler: handleMemorySessionStart
  },
  {
    name: "memory_session_end",
    description:
      "Close or checkpoint a session and optionally persist a concise summary for handoff; use summary ingestion instead of raw transcript dumps.",
    schema: memorySessionEndInputSchema,
    handler: handleMemorySessionEnd
  },
  {
    name: "memory_ingest_status",
    description: "Check async ingest job progress, counts, and warnings after session summary or full ingestion requests.",
    schema: memoryIngestStatusSchema,
    handler: handleMemoryIngestStatus
  },
  {
    name: "memory_recall",
    description:
      "Retrieve prior project context at task start or when the user references earlier work, decisions, failed attempts, or accepted constraints.",
    schema: memoryRecallSchema,
    handler: handleMemoryRecall
  }
];

export const MEMORY_PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: "start_coding_session",
    description: "Run setup checks, start or resume a memory session, and fetch compact context before active coding.",
    schema: z.object({
      session_id: z.string().optional(),
      client: z.string().optional(),
      workspace: z.string().optional(),
      repo: z.string().optional(),
      branch: z.string().optional(),
      query: z.string().optional()
    }),
    build: (input) => ({
      description: "Startup memory workflow for coding sessions.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Follow this JustMemory startup workflow in order:",
              "1) Call memory_capabilities with the provided workspace/repo context.",
              "2) Call memory_health with the same context.",
              "3) Call memory_session_start with session metadata (session_id/client/workspace/repo/branch).",
              "4) If query is provided, call memory_recall using that query and the same context.",
              "5) Return a concise startup context summary with citations and any warnings.",
              "",
              `Input context: ${JSON.stringify(input)}`
            ].join("\n")
          }
        }
      ]
    })
  },
  {
    name: "recall_context",
    description: "Retrieve compact prior context for the current task using memory_recall and return cited notes.",
    schema: z.object({
      query: z.string(),
      session_id: z.string().optional(),
      client: z.string().optional(),
      workspace: z.string().optional(),
      repo: z.string().optional(),
      branch: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(50).optional()
    }),
    build: (input) => ({
      description: "Recall-focused workflow with citations.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Recall relevant prior context before proceeding:",
              "1) Call memory_recall with this query and context.",
              "2) If no candidates are found, report that clearly and continue without assumptions.",
              "3) If candidates are found, summarize key instructions/decisions/tasks with citations.",
              "",
              `Input context: ${JSON.stringify(input)}`
            ].join("\n")
          }
        }
      ]
    })
  },
  {
    name: "session_handoff",
    description: "Checkpoint or close a session with a concise summary and optional sync summary ingestion.",
    schema: z.object({
      session_id: z.string().min(1),
      workspace: z.string().optional(),
      repo: z.string().optional(),
      branch: z.string().optional(),
      profile_id: z.string().optional(),
      summary: z.string().optional(),
      outcome: z.enum(["completed", "interrupted", "failed", "handoff"]).optional(),
      ingest_mode: z.enum(["none", "sync_summary", "async_full"]).optional()
    }),
    build: (input) => ({
      description: "Session handoff workflow for durable continuity.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Create a durable handoff for the current session:",
              "1) Draft a concise summary of outcomes, open tasks, and next steps.",
              "2) Call memory_session_end with session_id and summary.",
              "3) Prefer ingest_mode=sync_summary when summary quality is good; otherwise use none.",
              "4) Return handoff_summary, ingest status, and any warnings.",
              "",
              `Input context: ${JSON.stringify(input)}`
            ].join("\n")
          }
        }
      ]
    })
  }
];

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "justmemory",
    version: "0.0.0"
  });
  for (const tool of MEMORY_TOOL_DEFINITIONS) {
    server.tool(tool.name, tool.description, tool.schema.shape, async (input: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: JSON.stringify(await tool.handler(input), null, 2) }]
    }));
  }

  for (const prompt of MEMORY_PROMPT_DEFINITIONS) {
    server.prompt(prompt.name, prompt.description, prompt.schema.shape, async (input: Record<string, unknown>) =>
      prompt.build(input)
    );
  }

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
