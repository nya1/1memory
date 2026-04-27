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
